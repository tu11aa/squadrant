// src/commands/notify-relay.ts
//
// Mailbox-injector refactor: notify-relay is now a file-tailing process that
// reads from a project's mailbox (.config/cockpit/inbox/<project>.log) using a
// durable per-subscriber cursor. Each delivered event is forwarded to the
// captain's primary surface via the runtime driver's sendToSurface. The
// cursor only advances after a successful send, so failed deliveries are
// naturally retried on the next poll.

import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { RuntimeRegistry, createCmuxDriver } from "../runtimes/index.js";
import { DeferDelivery } from "../runtimes/cmux.js";
import type { RuntimeDriver } from "../runtimes/types.js";
import {
  readCursor,
  writeCursor,
  readFromCursor,
  type MailboxEntry,
} from "../control/mailbox.js";
import { sendRequest } from "../control/protocol.js";
import { classifyPaneTail } from "../control/interactive/pane-classifier.js";
import { createCrewPaneReader, surfaceVerdict, crewPaneTitle } from "../control/crew-pane-reader.js";
import { cockpitdCall } from "./crew-control.js";
import type { TaskRecord, ControlEvent } from "../control/types.js";

export const DEFAULT_STATE_ROOT = join(homedir(), ".config", "cockpit", "state");

// #258 idle-defer: default max consecutive defers before force-delivering so a
// message can never be stuck forever (~5min/300s at the default 1s poll cadence).
// Override via config key relay.maxDeferDeliveries.
export const DEFAULT_MAX_DEFERS = 300;

// #302 stability-probe: consecutive polls of byte-identical non-empty draft
// content after which it is safe to PROBE (captain is not actively typing).
// ~3s at the 1s poll cadence — kills the ~5min stall for unrecognized ghosts
// while never racing a live typist (changing content resets the counter).
// Override via config key relay.stableProbePolls.
export const DEFAULT_STABLE_PROBE_POLLS = 3;

// How often the in-cmux probe scrapes interactive crew panes for a block. The
// daemon can't do this (launchd can't connect to cmux), so it lives here.
export const PROBE_INTERVAL_MS = 10_000;
// Entries older than this at relay-boot time are silently acked without being
// forwarded — they are stale events from a prior captain session or dead crews.
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;
// A working interactive task with no heartbeat for this long is a probe
// candidate: PostToolUse never fires while a permission prompt is up, so a
// genuinely-blocked crew goes quiet well before the multi-minute stall budget.
export const PROBE_QUIET_MS = 20_000;
// #207: how often the relay heartbeats its liveness to the daemon. The daemon's
// RELAY_STALE_MS/RELAY_GONE_MS windows are sized as multiples of this.
export const RELAY_REGISTER_HEARTBEAT_MS = 10_000;

// Unified-formatter (#214/#210): the daemon's formatMessage is the single
// source of truth for the captain-facing message and stores it on the mailbox
// entry. The relay is a dumb pipe — it delivers entry.message verbatim and
// skips entries the daemon chose not to surface (null/empty). The old
// formatEntry switch re-derived the message from the raw event kind and had
// drifted (no case for task.approval.requested / task.idle), silently dropping
// those events. It is retired; deliverable() is the whole policy now.
export function deliverable(entry: MailboxEntry): string | null {
  const msg = entry.message;
  if (msg == null) return null;
  const trimmed = msg.trim();
  return trimmed.length > 0 ? msg : null;
}

// ── Phase 2b: in-cmux interactive-block probe ───────────────────────────────
// A claude/opencode crew parked at a permission prompt (or ending a turn with a
// question) sits at daemon state=working with NO heartbeat — the hook bridge
// only fires PostToolUse, which never happens while a prompt is up. The daemon
// can't scrape the pane to notice (launchd can't connect to cmux). The relay
// runs INSIDE the captain's cmux workspace, so it can read panes AND reach the
// daemon socket — it is the right place to detect this and surface CREW BLOCKED.

interface InteractiveProbeDeps {
  project: string;
  /** Daemon task list (the `kind:"list"` request `cockpit crew tasks` uses). */
  listTasks: () => Promise<TaskRecord[]>;
  /** Best-effort crew-pane tail reader (in-cmux); returns null on any failure. */
  readPaneTail: (rec: TaskRecord) => Promise<string | null>;
  /** Emit a control event to the daemon (the `kind:"event"` path). */
  sendEvent: (event: ControlEvent) => Promise<void>;
  now: () => number;
  log: (m: string) => void;
  /** No-heartbeat threshold before a working task is probed. */
  quietMs?: number;
}

/**
 * Pure-ish probe core (I/O injected for tests). One `tick`:
 *  1. list the project's daemon tasks,
 *  2. keep only interactive + working + named + quiet (> quietMs since
 *     lastHeartbeat) candidates,
 *  3. read each candidate's pane tail and skip it if the tail is unchanged
 *     since the last tick (per-task change-detection → fires once per prompt),
 *  4. classify the tail; a permission/question verdict → one task.blocked, a
 *     fatal error-banner verdict → one task.failed (#196 — a turn that died on a
 *     transient API error leaves the process alive and silently stuck).
 *
 * Best-effort throughout: every read/daemon call is caught and logged; the tick
 * never throws, so a transient cmux/daemon failure can't crash the relay. The
 * daemon's applyEvent + #176 idempotency make a re-sent block harmless.
 */
export function createInteractiveProbe(deps: InteractiveProbeDeps): {
  tick: () => Promise<void>;
} {
  const quietMs = deps.quietMs ?? PROBE_QUIET_MS;
  // taskId → last pane tail seen, so an unchanged prompt fires exactly once.
  const lastTail = new Map<string, string>();

  async function tick(): Promise<void> {
    let tasks: TaskRecord[];
    try {
      tasks = await deps.listTasks();
    } catch (e) {
      deps.log(`probe listTasks failed: ${(e as Error).message}`);
      return;
    }
    const now = deps.now();
    for (const rec of tasks) {
      if (rec.mode !== "interactive") continue;
      if (rec.state !== "working") continue;
      if (!rec.name) continue;
      if (now - rec.lastHeartbeat <= quietMs) continue; // still lively

      let tail: string | null;
      try {
        tail = await deps.readPaneTail(rec);
      } catch (e) {
        deps.log(`probe read failed for ${rec.id}: ${(e as Error).message}`);
        continue;
      }
      if (!tail) continue;
      if (lastTail.get(rec.id) === tail) continue; // unchanged → already handled
      lastTail.set(rec.id, tail);

      const verdict = classifyPaneTail(tail);
      if (!verdict) continue;
      // #196: a fatal error banner on a quiet working pane means the turn died
      // (transient API error / crash) and the crew is silently stuck — fire the
      // terminal task.failed so the captain gets CREW FAILED, not just an
      // eventual non-alarming idle. Recoverable via `crew send` (task.reopened).
      const event: ControlEvent =
        verdict.kind === "error"
          ? {
              type: "task.failed",
              id: rec.id,
              error: `crew session error (pane-detected): ${verdict.text}`,
            }
          : {
              type: "task.blocked",
              id: rec.id,
              reason:
                verdict.kind === "approval"
                  ? "crew awaiting permission (pane-detected)"
                  : "crew asked a question (pane-detected)",
              question: verdict.text,
            };
      try {
        await deps.sendEvent(event);
        const label = verdict.kind === "error" ? "CREW FAILED" : "CREW BLOCKED";
        deps.log(`probe -> ${label} ${rec.name} (${verdict.kind})`);
      } catch (e) {
        deps.log(`probe sendEvent failed for ${rec.id}: ${(e as Error).message}`);
      }
    }
  }

  return { tick };
}

interface RunOpts {
  project: string;
  subscriber: string;
  stateRoot: string;
  runtime: RuntimeDriver;
  captainName: string;
  pollMs?: number;
  /** Probe cadence override (default PROBE_INTERVAL_MS); 0 disables the probe. */
  probeMs?: number;
  /** Override Date.now() — useful in tests to simulate a future session start time. */
  now?: () => number;
  log?: (m: string) => void;
  /** Max consecutive defers before force-deliver. Default: DEFAULT_MAX_DEFERS. */
  maxDeferDeliveries?: number;
  /** Consecutive stable-content polls before probing early (#302). Default: DEFAULT_STABLE_PROBE_POLLS. */
  stableProbePolls?: number;
}

export async function runNotifyRelay(opts: RunOpts): Promise<() => void> {
  const log =
    opts.log ?? ((m: string) => process.stdout.write(`[notify-relay ${opts.project}] ${m}\n`));

  // Resolve captain workspace + primary surface once at boot.
  const ws = await opts.runtime.status(opts.captainName);
  if (!ws) throw new Error(`captain workspace '${opts.captainName}' not running`);
  const surfaces =
    (await (opts.runtime as RuntimeDriver & {
      listSurfaces?: (id: string) => Promise<Array<{ title?: string }>>;
    }).listSurfaces?.(ws.id)) ?? [];
  const captainSurface =
    (surfaces.find((s) => s.title === opts.captainName) ?? surfaces[0]) as {
      workspaceId?: string;
      surfaceId?: string;
      title?: string;
    } | undefined;
  if (!captainSurface) throw new Error("no surfaces in captain workspace");

  const sessionStartMs = (opts.now ?? (() => Date.now()))();
  const maxDefers = opts.maxDeferDeliveries ?? DEFAULT_MAX_DEFERS;
  const stableProbePolls = opts.stableProbePolls ?? DEFAULT_STABLE_PROBE_POLLS;

  // #258 idle-defer: consecutive defer counts per mailbox seq.
  // Keyed by entry.seq; deleted on successful delivery.
  const deferCounts = new Map<number, number>();
  // #302 stability tracking: last observed draft content + how many consecutive
  // polls it stayed byte-identical. Stable non-empty content → safe to probe.
  const lastContent = new Map<number, string | null>();
  const stableCounts = new Map<number, number>();

  const cursor = await readCursor({
    stateRoot: opts.stateRoot,
    project: opts.project,
    subscriber: opts.subscriber,
  });
  let lastAcked = cursor?.lastAckedSeq ?? 0;
  let stopped = false;
  let draining = false;

  // #207: register with the daemon so it knows this project SHOULD have a live
  // relay, and heartbeat every ~10s so the sweep can health-check (and, if this
  // relay dies entirely, surface it as down). Best-effort via a RAW socket call
  // (not cockpitdCall) so a registration attempt never KICKSTARTS the daemon —
  // a relay registering should not resurrect a down daemon, and the drain loop
  // is what actually matters. Errors are swallowed.
  const relayPid = process.pid;
  const sockPath = join(homedir(), ".config", "cockpit", "cockpit.sock");
  const announceRelay = (req: unknown) => void sendRequest(sockPath, req).catch(() => {});
  announceRelay({ kind: "relay-register", project: opts.project, pid: relayPid, startedAt: sessionStartMs });
  const heartbeatInterval = setInterval(() => {
    if (stopped) return;
    announceRelay({ kind: "relay-heartbeat", project: opts.project, pid: relayPid });
  }, RELAY_REGISTER_HEARTBEAT_MS);
  heartbeatInterval.unref?.();

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for await (const entry of readFromCursor({
        stateRoot: opts.stateRoot,
        project: opts.project,
        fromSeq: lastAcked + 1,
      })) {
        if (stopped) return;
        // Silently ack entries that pre-date this relay session by more than
        // STALE_THRESHOLD_MS — they are leftovers from dead crews or a prior
        // captain session and would only confuse the current captain.
        const entryMs = new Date(entry.ts).getTime();
        if (entryMs < sessionStartMs - STALE_THRESHOLD_MS) {
          await writeCursor({
            stateRoot: opts.stateRoot,
            project: opts.project,
            subscriber: opts.subscriber,
            lastAckedSeq: entry.seq,
          });
          lastAcked = entry.seq;
          continue;
        }
        const msg = deliverable(entry);
        if (msg) {
          try {
            const deferCount = deferCounts.get(entry.seq) ?? 0;
            // #302: probe early once content has been stable for stableProbePolls
            // polls (captain not typing) — kills the ~5min stall; the 300-defer
            // backstop still guarantees delivery never hangs forever.
            const stable = (stableCounts.get(entry.seq) ?? 0) >= stableProbePolls;
            const probe = stable || deferCount >= maxDefers;
            await (opts.runtime as RuntimeDriver & {
              sendToSurface: (s: unknown, m: string, o?: { probe?: boolean }) => Promise<void>;
            }).sendToSurface(captainSurface, msg, probe ? { probe: true } : undefined);
            deferCounts.delete(entry.seq);
            stableCounts.delete(entry.seq);
            lastContent.delete(entry.seq);
          } catch (e) {
            if (e instanceof DeferDelivery) {
              deferCounts.set(entry.seq, (deferCounts.get(entry.seq) ?? 0) + 1);
              // Track content stability: byte-identical non-empty draft across
              // consecutive polls means the captain isn't actively typing (#302).
              const content = e.draft;
              if (content && content === lastContent.get(entry.seq)) {
                stableCounts.set(entry.seq, (stableCounts.get(entry.seq) ?? 0) + 1);
              } else {
                stableCounts.set(entry.seq, 0);
              }
              lastContent.set(entry.seq, content);
              log(`deferred: captain typing (seq=${entry.seq})`);
              // Don't advance cursor; the next poll will retry from the same seq.
              return;
            }
            log(`sendToSurface failed seq=${entry.seq}: ${(e as Error).message}`);
            // Don't advance cursor; the next poll will retry from the same seq.
            return;
          }
          log(`deliver seq=${entry.seq} -> ${opts.subscriber}: ${msg}`);
        }
        await writeCursor({
          stateRoot: opts.stateRoot,
          project: opts.project,
          subscriber: opts.subscriber,
          lastAckedSeq: entry.seq,
        });
        lastAcked = entry.seq;
      }
    } finally {
      draining = false;
    }
  }

  // #239 Phase B: pull pending crew-surface-liveness probes from the daemon,
  // execute each in-cmux (this process is inside the captain's cmux tree, so
  // cmux calls succeed), and post results back. Best-effort throughout — any
  // failure is caught and logged so the relay never crashes on a transient
  // daemon or cmux error. surfaceVerdict(null, ...) = "unknown" so a cmux
  // failure degrades safely without false-reaping live crews.
  async function executeProxiedProbes(): Promise<void> {
    let pending: Array<{ taskId: string; name: string }>;
    try {
      pending = (await cockpitdCall({
        kind: "relay-proxy-poll",
        project: opts.project,
      })) as Array<{ taskId: string; name: string }>;
    } catch {
      return; // daemon unreachable — skip this tick
    }
    if (!Array.isArray(pending) || pending.length === 0) return;

    // List captain workspace surfaces once for all probes this tick.
    let surfaceTitles: string[] | null;
    try {
      const runtime = opts.runtime as RuntimeDriver & {
        listSurfaces?: (id: string) => Promise<Array<{ title?: string }>>;
      };
      const surfaces = await runtime.listSurfaces?.(ws!.id);
      surfaceTitles = surfaces ? surfaces.map((s) => s.title ?? "") : null;
    } catch {
      surfaceTitles = null; // surfaceVerdict(null, ...) → "unknown" — never false-reaps
    }

    const results = pending.map((p) => ({
      taskId: p.taskId,
      liveness: surfaceVerdict(surfaceTitles, crewPaneTitle(opts.project, p.name)),
    }));

    try {
      await cockpitdCall({ kind: "relay-proxy-result", results });
    } catch {
      // best-effort: dropped results are re-requested on the next successful poll
    }
  }

  const interval = setInterval(() => {
    if (!stopped) {
      drain().catch((e) => log(`drain error: ${(e as Error).message}`));
      executeProxiedProbes().catch((e) => log(`proxy-probe error: ${(e as Error).message}`));
    }
  }, opts.pollMs ?? 1000);

  // Separate probe interval (additive — does not disturb mailbox tailing).
  // Detects crews blocked at a permission prompt / trailing question by reading
  // their pane, which only works from inside cmux (here), not from the daemon.
  const probeMs = opts.probeMs ?? PROBE_INTERVAL_MS;
  const readPaneTail = createCrewPaneReader();
  const probe = createInteractiveProbe({
    project: opts.project,
    listTasks: async () =>
      (await cockpitdCall({ kind: "list", project: opts.project })) as TaskRecord[],
    readPaneTail,
    sendEvent: async (event) => {
      await cockpitdCall({ kind: "event", project: opts.project, event });
    },
    now: () => Date.now(),
    log,
  });
  const probeInterval =
    probeMs > 0
      ? setInterval(() => {
          if (!stopped) probe.tick().catch((e) => log(`probe error: ${(e as Error).message}`));
        }, probeMs)
      : undefined;

  await drain(); // initial drain

  return () => {
    stopped = true;
    clearInterval(interval);
    clearInterval(heartbeatInterval);
    if (probeInterval) clearInterval(probeInterval);
  };
}

export const notifyRelayCommand = new Command("notify-relay")
  .description(
    "Subscribe to a project's mailbox and deliver events to the captain pane. " +
      "Long-running tailer; reads from .config/cockpit/inbox/<project>.log " +
      "using a per-subscriber cursor.",
  )
  .argument("<project>", "Project to relay mailbox events for")
  .option("--as <subscriber>", "subscriber name", "captain")
  .option("--state-root <path>", "override state root", DEFAULT_STATE_ROOT)
  .action(async (project: string, opts: { as: string; stateRoot: string }) => {
    try {
      const config = loadConfig();
      const projCfg = config.projects[project];
      if (!projCfg) {
        console.error(chalk.red(`notify-relay: unknown project '${project}'`));
        process.exit(1);
      }
      const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
      const runtime = registry.forProject(project, config);
      process.stdout.write(
        `[notify-relay ${project}] subscriber=${opts.as} stateRoot=${opts.stateRoot}\n`,
      );
      await runNotifyRelay({
        project,
        subscriber: opts.as,
        stateRoot: opts.stateRoot,
        runtime,
        captainName: projCfg.captainName,
        pollMs: 1000,
        maxDeferDeliveries: config.relay?.maxDeferDeliveries ?? DEFAULT_MAX_DEFERS,
        stableProbePolls: config.relay?.stableProbePolls ?? DEFAULT_STABLE_PROBE_POLLS,
      });
      process.on("SIGTERM", () => process.exit(0));
    } catch (err) {
      console.error(chalk.red(`notify-relay: ${(err as Error).message}`));
      process.exit(1);
    }
  });
