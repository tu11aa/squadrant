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
import { loadConfig } from "@cockpit/shared";
import { RuntimeRegistry, createCmuxDriver } from "@cockpit/workspaces";
import type { RuntimeDriver } from "@cockpit/workspaces";
import { readCursor, writeCursor, readFromCursor } from "@cockpit/core";
import { CaptainDelivery, deliverable } from "@cockpit/core";
import { sendRequest } from "@cockpit/core";
import { createInteractiveProbe, STALE_THRESHOLD_MS } from "@cockpit/core";
import { classifyPaneTail } from "@cockpit/agents";
import { createCrewPaneReader, surfaceVerdict, crewPaneTitle } from "@cockpit/core";
import { cockpitdCall } from "./crew-control.js";
import type { TaskRecord, ControlEvent } from "@cockpit/shared";

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
// A working interactive task with no heartbeat for this long is a probe
// candidate: PostToolUse never fires while a permission prompt is up, so a
// genuinely-blocked crew goes quiet well before the multi-minute stall budget.
export const PROBE_QUIET_MS = 20_000;
// STALE_THRESHOLD_MS re-exported from @cockpit/core for relay consumers.
export { STALE_THRESHOLD_MS } from "@cockpit/core";
// #207: how often the relay heartbeats its liveness to the daemon. The daemon's
// RELAY_STALE_MS/RELAY_GONE_MS windows are sized as multiples of this.
export const RELAY_REGISTER_HEARTBEAT_MS = 10_000;

// deliverable() is defined in captain-delivery.ts (Task 3) — imported above.
// Both the relay (flag OFF) and the daemon (flag ON) use the SAME module,
// so flag-OFF parity is guaranteed.

// createInteractiveProbe is imported from @cockpit/core above.

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

  // #332: CaptainDelivery (imported from captain-delivery.ts) handles defer-
  // while-typing (#258) and stability-probe (#302) identically for both the
  // relay (flag OFF) and the daemon (flag ON).
  const captainDelivery = new CaptainDelivery({
    maxDefers: opts.maxDeferDeliveries ?? DEFAULT_MAX_DEFERS,
    stableProbePolls: opts.stableProbePolls ?? DEFAULT_STABLE_PROBE_POLLS,
  });

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
          const result = await captainDelivery.deliver(entry, (text, sendOpts) =>
            (opts.runtime as RuntimeDriver & {
              sendToSurface: (s: unknown, m: string, o?: { probe?: boolean }) => Promise<void>;
            }).sendToSurface(captainSurface, text, sendOpts),
          );
          if ("deferred" in result) {
            log(`deferred: captain typing (seq=${entry.seq})`);
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
  const readPaneTail = createCrewPaneReader((project, cfg) =>
    new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, cfg),
  );
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
