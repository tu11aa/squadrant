// src/control/cockpitd.ts
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as realSpawn } from "node:child_process";
import {
  writeFileSync, mkdirSync, readFileSync, readdirSync, statSync,
  openSync, readSync, closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createStore } from "./store.js";
import { createDaemon } from "./daemon.js";
import { startServer, encodeFrame, type AttachFrame, type AttachInbound } from "./protocol.js";
import { runHeadless } from "./headless-launcher.js";
import { CodexInteractiveDriver, shouldReattachCodex } from "./codex/driver.js";
import { OpencodeSseBridge } from "./opencode/sse-bridge.js";
import { CmuxEventsBridge } from "./cmux/events-bridge.js";
import { makeGate } from "./codex/gate.js";
import { appendToMailbox, rotateIfNeeded, mailboxStats, readCursor, writeCursor, readFromCursor } from "./mailbox.js";
import { createRelayHealer } from "./relay-healer.js";
import { createDirectSurfaceLivenessProbe, createDirectCrewPaneReader } from "./crew-pane-reader.js";
import { createInteractiveProbe, STALE_THRESHOLD_MS } from "../commands/notify-relay.js";
import { CaptainDelivery } from "./delivery/captain-delivery.js";
import { projectHealth, type ComponentHealth } from "./liveness.js";
import { assembleDaemonSnapshot, type DaemonSnapshotInputs, type ResultArtifacts } from "./snapshot.js";
import { loadConfig } from "../config.js";
import { readdir } from "node:fs/promises";
import type { Gate, TaskRecord, ControlEvent } from "./types.js";
import { TERMINAL_STATES } from "./types.js";
import type { Socket } from "node:net";
import type { PaneRef } from "../runtimes/types.js";
import { DaemonCmux } from "./cmux/daemon-cmux.js";
import { createCmuxDriver } from "../runtimes/index.js";

// This module's own compiled file — its mtime is the dist build-time used for
// the Tier 0 build-freshness check (process start vs build time). package.json
// (repo root) gives the running version. Both resolved once at load.
const SELF_PATH = fileURLToPath(import.meta.url);
function readPkgVersion(): string {
  try {
    const pkgPath = join(dirname(SELF_PATH), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")).version as string) ?? "unknown";
  } catch { return "unknown"; }
}
const PKG_VERSION = readPkgVersion();
const SNAPSHOT_LOG_WINDOW_MS = 60 * 60 * 1000; // count daemon-log errors in the last hour
const CURSOR_SUBSCRIBER = "captain"; // the relay drains the mailbox as "captain" (#207)

export interface CockpitdOpts {
  stateRoot?: string;
  sockPath?: string;
  sweepMs?: number; // 0 disables the interval (tests)
  isPidAlive?: (pid: number) => boolean; // injectable for the headless reconcile path (tests)
  // injectable for the #139 interactive surface-liveness reaper (tests); defaults
  // to the real cmux probe. Returns "alive" | "gone" | "unknown".
  isSurfaceAlive?: (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown">;
  spawn?: typeof realSpawn;
  /**
   * Push-notification hook (#109). Defaults to appending a structured event
   * to the mailbox file at <stateRoot>/inbox/<project>.log; an injector
   * process inside the captain workspace tails the file and delivers entries
   * to the captain pane. Tests inject a fake to assert call shape.
   */
  notify?: (args: {
    project: string;
    message: string;
    record: TaskRecord;
    event: ControlEvent;
  }) => Promise<void> | void;
  /** Background rotation timer interval (ms). 0 disables. Default 60_000. */
  rotationIntervalMs?: number;
  /** Mailbox rotation thresholds (size/age/retention). */
  mailboxConfig?: {
    maxBytes?: number;
    maxAgeMs?: number;
    keepCount?: number;
  };
  /** Inject a fake driver for tests. Defaults to a real CodexInteractiveDriver. */
  codexDriver?: import("./codex/driver.js").CodexInteractiveDriver | {
    dispatch: (rec: any) => Promise<void>;
    reattach: (rec: any) => Promise<void>;
    say: (taskId: string, text: string) => Promise<void>;
    steer: (taskId: string, text: string) => Promise<void>;
    interrupt: (taskId: string) => Promise<void>;
    answer: (taskId: string, payload: unknown) => Promise<void>;
    close: (taskId: string) => Promise<void>;
  };
  /** #207 best-effort relay healer. Defaults to a real cmux spawnInjector
   *  re-spawn (mostly inert under launchd). Tests inject a fake/spy. */
  healRelay?: (project: string) => Promise<void> | void;
  /** Inject a fake headless launcher for tests to avoid real process spawns. */
  launchHeadless?: (rec: TaskRecord) => Promise<void>;
  /** Override which projects appear in the Tier 2 per-project snapshot. Defaults
   *  to Object.keys(loadConfig().projects). Tests inject this to avoid real config. */
  registeredProjects?: string[];
  /** Inject a fake opencode SSE bridge for tests. Defaults to a real one. */
  opencodeBridge?: {
    start: (o: { taskId: string; port: number }) => void;
    stop: (taskId: string) => void;
    /** CP3: POST the captain's approve/deny decision to the crew's server. */
    answer: (taskId: string, decision: "approve" | "deny") => Promise<boolean>;
  };
  /** B1: inject a fake cmux events bridge for tests. Defaults to a real one
   *  (gated on defaults.cmuxEventsBridge). */
  cmuxEventsBridge?: { start: () => void; stop: () => void };
  /** #332: inject a fake DaemonCmux for testing daemon-direct delivery. When
   *  absent and daemonDirectCmux is ON, a real cmux driver is created. */
  daemonCmux?: DaemonCmux;
  /** #332: factory for constructing DaemonCmux in production when daemonCmux
   *  is not injected. Defaults to () => new DaemonCmux(createCmuxDriver()).
   *  Tests inject this to avoid real cmux. */
  makeDaemonCmux?: () => DaemonCmux;
  /** #332: override for daemonDirectCmux flag (bypasses config file load).
   *  When true and daemonCmux is provided/injected, runs the daemon-direct
   *  delivery loop instead of relying on the notify-relay. */
  daemonDirectCmux?: boolean;
  /** #332: injected captain-surface mapping (project → PaneRef) for the
   *  daemon-direct delivery loop. Used as fallback when real discovery (Task 5)
   *  returns no surface (e.g. cmux not reachable or captain not yet running). */
  captainSurfaces?: Record<string, PaneRef>;
}

// ── Tier 0/2 snapshot gathering (I/O at the edge; the pure assembly lives in
//    snapshot.ts). Each helper tolerates missing files and never throws. ───────

/** mtime (epoch ms) of the running daemon's compiled code, for build-freshness. */
function distBuiltAt(): number {
  try { return statSync(SELF_PATH).mtimeMs; } catch { return 0; }
}

/** Daemon-log error count (last window) + total size. Reads only the tail so a
 *  large log never makes the snapshot tick expensive. */
function gatherLogStats(path: string, now: number, windowMs: number): DaemonSnapshotInputs["log"] {
  let sizeBytes = 0;
  try { sizeBytes = statSync(path).size; }
  catch { return { errorCount: 0, sizeBytes: 0, windowMs }; }
  if (sizeBytes === 0) return { errorCount: 0, sizeBytes, windowMs };
  const CAP = 256 * 1024;
  const start = Math.max(0, sizeBytes - CAP);
  const len = sizeBytes - start;
  let text = "";
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      text = buf.toString("utf-8");
    } finally { closeSync(fd); }
  } catch { return { errorCount: 0, sizeBytes, windowMs }; }
  const cutoff = now - windowMs;
  let errorCount = 0;
  for (const line of text.split("\n")) {
    if (!/error|failed/i.test(line)) continue;
    // Lines carry an ISO timestamp ("[cockpitd] 2026-... msg"); skip ones older
    // than the window. Lines without a parseable timestamp are counted (conservative).
    const m = line.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    if (m) { const ts = Date.parse(m[0]); if (!Number.isNaN(ts) && ts < cutoff) continue; }
    errorCount++;
  }
  return { errorCount, sizeBytes, windowMs };
}

/** Per-project store state counts + corrupt/quarantined file count. */
function gatherStoreStats(
  store: { list: (p: string) => TaskRecord[] },
  stateRoot: string,
  project: string,
): { byState: Record<string, number>; corruptCount: number } {
  const byState: Record<string, number> = {};
  for (const r of store.list(project)) byState[r.state] = (byState[r.state] ?? 0) + 1;
  let corruptCount = 0;
  const dir = join(stateRoot, project);
  try {
    for (const n of readdirSync(dir)) {
      if (n.includes(".corrupt.")) { corruptCount++; continue; }
      if (!n.endsWith(".json")) continue;
      try { JSON.parse(readFileSync(join(dir, n), "utf-8")); }
      catch { corruptCount++; }
    }
  } catch { /* no project dir yet */ }
  return { byState, corruptCount };
}

/** Global _results/ artifact count + total bytes (unbounded-growth watch). */
function gatherResults(resultsDir: string): ResultArtifacts {
  let fileCount = 0;
  let totalBytes = 0;
  try {
    for (const n of readdirSync(resultsDir)) {
      try {
        const s = statSync(join(resultsDir, n));
        if (s.isFile()) { fileCount++; totalBytes += s.size; }
      } catch { /* vanished mid-scan */ }
    }
  } catch { /* no results dir */ }
  return { fileCount, totalBytes };
}

const CAPTAIN_GONE_STREAK_K = 3;
export type ListSurfacesFn = (wsId: string) => Promise<PaneRef[]>;

/**
 * Pure: search a list of surfaces for one whose title matches the captain name.
 * Part of #332 daemon-direct captain-surface discovery (Task 5).
 */
export function discoverCaptainSurface(surfaces: PaneRef[], captainTitle: string): PaneRef | null {
  return surfaces.find((s) => s.title === captainTitle) ?? null;
}

export function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; } // EPERM = alive but not ours; ESRCH = dead
}

export function startCockpitd(opts: CockpitdOpts = {}) {
  const stateRoot = opts.stateRoot ?? join(homedir(), ".config", "cockpit", "state");
  const sockPath = opts.sockPath ?? join(homedir(), ".config", "cockpit", "cockpit.sock");
  const store = createStore(stateRoot);
  // #44 dashboard: process start-time (for uptime + build-freshness) and the
  // timestamp of the most recent sweep (Tier 0 "sweep last Ns ago").
  const bootedAt = Date.now();
  let lastSweepAt: number | null = null;
  // #225: hard crew task-timeout ceiling, read once at boot. Falls back to the
  // daemon's DEFAULT_TASK_TIMEOUT_MS (8h) when unset in config.
  const taskTimeoutMs = loadConfig().defaults.taskTimeoutMs;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const spawn = opts.spawn ?? realSpawn;
  const resultsDir = join(stateRoot, "_results");
  mkdirSync(resultsDir, { recursive: true });
  const writeResult = (id: string, payload: string) => {
    const p = join(resultsDir, `${id}.txt`);
    writeFileSync(p, payload);
    return p;
  };
  // Minimal lifecycle logging (red-team #2: the log was a timestampless wall
  // of crash stacks with no "started" marker).
  const log = (m: string) => process.stderr.write(`[cockpitd] ${new Date().toISOString()} ${m}\n`);

  // ── Attach fan-out (spec §4.5/§4.6) ──────────────────────────────────────
  // Per-task set of live attach connections. Populated in onAttach, cleaned up
  // in onAttachClose. Not exposed outside this closure.
  const attachConns = new Map<string, Set<Socket>>();

  // #239 Phase B: relay-as-cmux-proxy for crew-surface liveness.
  // The relay (running inside the captain's cmux tree) polls relay-proxy-poll
  // each tick, executes each probe in-lineage, and posts results via relay-proxy-result.
  // The daemon never calls cmux directly; it only reads this result cache.
  type ProbeRequest = { taskId: string; name: string };
  const pendingProbes = new Map<string, ProbeRequest[]>(); // per-project queue
  const probeResults = new Map<string, "alive" | "gone" | "unknown">(); // per-taskId cache
  // taskIds handed to the relay (poll sent) but not yet answered (result received).
  // Prevents the sweep from re-enqueuing a probe that's already in-flight, which
  // would cause the second relay-proxy-poll to return non-empty despite the queue
  // being cleared on the first poll.
  const inFlightProbes = new Set<string>();
  const inFlightHeadlessIds = new Set<string>(); // #259: tasks being launched (no pid yet)
  const activeHeadlessKills = new Set<() => void>();

  // Replaces createSurfaceLivenessProbe(): enqueues a probe for the relay to
  // execute, then returns the most-recent cached result ("unknown" when nothing
  // has been received yet — "unknown" never reaps, so the first tick is safe).
  const proxiedSurfaceAlive = async (rec: TaskRecord): Promise<"alive" | "gone" | "unknown"> => {
    if (rec.mode !== "interactive" || !rec.name) return "unknown";
    // If the relay already has this probe, don't enqueue again until it answers.
    if (inFlightProbes.has(rec.id)) return probeResults.get(rec.id) ?? "unknown";
    const list = pendingProbes.get(rec.project) ?? [];
    // Dedup: only enqueue once per taskId until the relay drains the queue.
    if (!list.some((p) => p.taskId === rec.id)) {
      list.push({ taskId: rec.id, name: rec.name });
      pendingProbes.set(rec.project, list);
    }
    return probeResults.get(rec.id) ?? "unknown";
  };

  function broadcast(taskId: string, f: AttachFrame): void {
    const conns = attachConns.get(taskId);
    if (!conns) return;
    const wire = encodeFrame(f);
    for (const conn of conns) {
      try { conn.write(wire); } catch { /* client gone; onAttachClose will clean up */ }
    }
  }

  // ── Gate promotion (spec §4.9) ────────────────────────────────────────────
  // When a server-request event fires and no client is attached, start a 5s
  // timer. If still unattached at fire time, promote to a Gate in the store
  // and broadcast gate-promoted so any later-attaching client can offer takeover.
  const pendingGateTimers = new Map<string, { taskId: string; timer: NodeJS.Timeout }>();

  function schedulePromotion(
    taskId: string,
    requestId: number,
    kind: "input" | "approval",
    question: string,
  ): void {
    // If a client is already attached for this task, no promotion needed.
    const conns = attachConns.get(taskId);
    if (conns && conns.size > 0) return;
    const key = `${taskId}#${requestId}`;
    // Clear any prior timer for the same (taskId, requestId).
    const prior = pendingGateTimers.get(key);
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      pendingGateTimers.delete(key);
      // Re-check at fire time — a client may have attached in the 5s window.
      if (attachConns.get(taskId)?.size) return;
      const rec = store.listAll().find((r) => r.id === taskId);
      if (!rec) return;
      const gate: Gate = makeGate({ taskId, kind, question, now: Date.now(), mkId: () => randomUUID() });
      const gates = [...(rec.gates ?? []), gate];
      store.put({ ...rec, gates });
      broadcast(taskId, { type: "gate-promoted", taskId, gateId: gate.gateId });
      log(`gate promoted gateId=${gate.gateId} taskId=${taskId} kind=${kind}`);
    }, 5_000);
    timer.unref?.();
    pendingGateTimers.set(key, { taskId, timer });
  }

  function cancelPromotionsFor(taskId: string): void {
    for (const [key, slot] of pendingGateTimers.entries()) {
      if (slot.taskId === taskId) {
        clearTimeout(slot.timer);
        pendingGateTimers.delete(key);
      }
    }
  }

  // ── CodexInteractiveDriver singleton ─────────────────────────────────────
  // The driver holds the single AppServerClient child. Each task maps to a
  // thread inside that child. Events emitted here (a) update the state-machine
  // via daemon.handle and (b) broadcast streaming AttachFrames to cmux clients.
  const codexDriver = opts.codexDriver ?? new CodexInteractiveDriver({
    emit: (ev) => {
      // Resolve the project so we can call daemon.handle with {kind:"event"}.
      // store.listAll() is O(tasks) but tasks are few; acceptable for events.
      const found = store.listAll().find((r) => r.id === ev.id);
      if (!found) return;
      void d.handle({ kind: "event", project: found.project, event: ev });

      // Map ControlEvent → AttachFrame and broadcast to any attached cmux clients.
      if (ev.type === "task.delta")
        broadcast(ev.id, { type: "delta", taskId: ev.id, text: ev.chunk });
      else if (ev.type === "task.turn.started")
        broadcast(ev.id, { type: "turn-started", taskId: ev.id });
      else if (ev.type === "task.turn.completed")
        broadcast(ev.id, { type: "turn-completed", taskId: ev.id });
      else if (ev.type === "task.input.requested") {
        broadcast(ev.id, { type: "input-requested", taskId: ev.id, requestId: ev.requestId, question: ev.question });
        schedulePromotion(ev.id, ev.requestId, "input", ev.question);
      } else if (ev.type === "task.approval.requested") {
        broadcast(ev.id, { type: "approval-requested", taskId: ev.id, requestId: ev.requestId, question: ev.question, kind: ev.kind });
        schedulePromotion(ev.id, ev.requestId, "approval", ev.question);
      }
      else if (ev.type === "task.reattached")
        broadcast(ev.id, { type: "reattached", taskId: ev.id });
    },
  });

  // ── Opencode SSE bridge ───────────────────────────────────────────────────
  // Interactive opencode crews launch as `opencode --port <N>`; this bridge
  // subscribes to each crew's /event stream and maps `session.idle` →
  // task.turn.completed so the daemon learns turn-end without the crew shelling
  // out to cockpit. emit resolves the project from the store (events carry only
  // the task id), mirroring the codexDriver emit above.
  const opencodeBridge = opts.opencodeBridge ?? new OpencodeSseBridge({
    emit: (ev) => {
      const found = store.listAll().find((r) => r.id === ev.id);
      if (!found) return;
      void d.handle({ kind: "event", project: found.project, event: ev });
      // CP3: a gated permission must become a resolvable gate so the captain can
      // approve/deny via `crew reply --gate`. Opencode crews never attach a
      // renderer (no `crew attach`), so schedulePromotion always fires after the
      // grace window — mirroring the codex emit hook below.
      if (ev.type === "task.approval.requested") {
        schedulePromotion(ev.id, ev.requestId, "approval", ev.question);
      }
    },
    log,
  });

  // B1: cmux native-events bridge. ADDITIVE — runs alongside the relay-proxy /
  // pane-reader scrape path, which stays as the fallback. A single global
  // `cmux events` subscription maps each crew's `agent.hook.Stop` (turn-end /
  // idle) to task.turn.completed, correlating the frame's cwd to a non-terminal
  // interactive record (each crew runs in a unique worktree path). The reducer
  // absorbs duplicate/late turn.completed, so feeding it from both paths is safe.
  const cmuxEventsBridge =
    opts.cmuxEventsBridge ??
    new CmuxEventsBridge({
      emit: (ev) => {
        const found = store.listAll().find((r) => r.id === ev.id);
        if (!found) return;
        void d.handle({ kind: "event", project: found.project, event: ev });
      },
      resolve: (hook) => {
        if (!hook.cwd) return undefined;
        return store
          .listAll()
          .find(
            (r) =>
              r.mode === "interactive" &&
              !TERMINAL_STATES.has(r.state) &&
              r.cwd === hook.cwd,
          );
      },
      cursorFile: join(stateRoot, "cmux-events.seq"),
      log,
    });

  const ingest = (project: string) => (e: import("./types.js").ControlEvent) =>
    void d.handle({ kind: "event", project, event: e });

  // Default push-notification wiring (mailbox-injector spec): the daemon
  // appends a JSON entry to <stateRoot>/inbox/<project>.log. An injector
  // process running inside the captain workspace tails the file from its
  // cursor and delivers each entry to the captain pane. The daemon never
  // shells out to cmux; the captain owns delivery. Tests inject a fake
  // `notify` to assert call shape without exercising the mailbox path.
  const defaultNotify = async (args: {
    project: string;
    message: string;
    record: TaskRecord;
    event: ControlEvent;
  }): Promise<void> => {
    try {
      await appendToMailbox({
        stateRoot,
        project: args.project,
        taskRecord: args.record,
        event: args.event,
        // Persist the daemon-rendered message (#214/#210): the relay delivers it
        // verbatim instead of re-deriving from the raw event (which drifted).
        message: args.message,
      });
    } catch (e) {
      log(`mailbox append failed project=${args.project}: ${(e as Error).message}`);
    }
  };
  const notify = opts.notify ?? defaultNotify;

  // #332: daemon-direct flag resolved here so both the surface-liveness probe
  // (below) and the delivery loop (further down) agree on the same value.
  const daemonDirectCmux = opts.daemonDirectCmux ?? loadConfig().defaults?.daemonDirectCmux ?? false;

  // #332: construct DaemonCmux in production when the flag is ON but no
  // injectable was provided. The factory is overridable for tests.
  const daemonCmux = opts.daemonCmux
    ?? (daemonDirectCmux ? (opts.makeDaemonCmux ?? (() => new DaemonCmux(createCmuxDriver())))() : undefined);

  // #332: daemon-direct mode replaces the proxy-based surface liveness probe
  // with a direct cmux probe (DaemonCmux.listSurfaces + surfaceVerdict).
  const surfaceProbe = opts.isSurfaceAlive
    ?? (daemonDirectCmux && daemonCmux
      ? createDirectSurfaceLivenessProbe(
          daemonCmux,
          (project) => {
            const cfg = loadConfig();
            return cfg.projects?.[project]?.captainName ?? `${project}-captain`;
          },
        )
      : proxiedSurfaceAlive);

  const d = createDaemon({
    store, now: () => Date.now(), isPidAlive, notify, taskTimeoutMs,
    // #139 backstop: terminalize interactive crews whose cmux pane is provably
    // gone (sweep/reconcile reaper). Three-valued; "unknown" never reaps.
    isSurfaceAlive: surfaceProbe,
    // #207 best-effort relay heal on the sweep (secondary — surface is primary).
    healRelay: opts.healRelay ?? createRelayHealer(log),
    launchHeadless: opts.launchHeadless ?? (async (rec) => {
      const handle = runHeadless({
        provider: rec.provider, task: rec.task, id: rec.id, sessionId: rec.sessionId,
        cwd: rec.cwd, spawn, emit: ingest(rec.project), writeResult,
      });
      inFlightHeadlessIds.add(rec.id); // #259: mark in-flight before pid is set
      activeHeadlessKills.add(handle.kill);
      try { await handle.result; } finally {
        inFlightHeadlessIds.delete(rec.id);
        activeHeadlessKills.delete(handle.kill);
      }
    }),
    isHeadlessInFlight: (id) => inFlightHeadlessIds.has(id),
    launchInteractive: async (rec) => {
      if (rec.provider === "codex") {
        await codexDriver.dispatch(rec as any);
        return;
      }
      if (rec.provider === "claude") {
        // Claude interactive crews run in a cmux tab — the daemon does NOT
        // own a Claude process. The tab does the actual launch. The daemon's
        // only role for Claude is the state ledger: emit task.started so the
        // record transitions submitted → working, then wait for task.progress
        // / task.done events from the injected hook bridge + explicit
        // `cockpit crew signal` (see claude-interactive spec, §4.4).
        ingest(rec.project)({ type: "task.started", id: rec.id });
        return;
      }
      if (rec.provider === "opencode") {
        // Opencode interactive crews run in a cmux tab — same approach as
        // claude. The daemon owns the state ledger, not the process. Emit
        // task.started so the record transitions submitted → working. Terminal
        // state still comes from explicit `cockpit crew signal` in the template;
        // the SSE bridge (when serverPort is set) adds reliable turn-end
        // (idle) detection on top so the daemon isn't stuck at "working".
        ingest(rec.project)({ type: "task.started", id: rec.id });
        if (rec.serverPort) opencodeBridge.start({ taskId: rec.id, port: rec.serverPort });
        return;
      }
      throw new Error(
        `interactive mode is not yet implemented for provider '${rec.provider}'; only 'codex', 'claude', and 'opencode' are supported`,
      );
    },
    resolveInteractiveGate: async (taskId, payload) => {
      // Route the captain's decision to the owning provider's driver. Opencode
      // crews resolve via the SSE bridge (POST to the crew's server); codex via
      // its app-server respondToServerRequest. Provider comes from the record.
      const rec = store.listAll().find((r) => r.id === taskId);
      try {
        if (rec?.provider === "opencode") {
          // Only an explicit "approve" approves; any other reply (incl. an
          // ambiguous one) denies — never auto-approve a permission gate.
          const decision = (payload as { decision?: string })?.decision === "approve" ? "approve" : "deny";
          await opencodeBridge.answer(taskId, decision);
        } else {
          await codexDriver.answer(taskId, payload);
        }
      } catch (e) { log(`gate-resolve answer failed: ${(e as Error).message}`); }
    },
  });

  // #77 service-health surface. Assembles per-component liveness for the health
  // socket verb: relay map from the daemon, captain liveness from relay heartbeat
  // (#239 Phase A — cmux probe removed; launchd lineage denies it), crews from
  // the store — all fed into the pure projectHealth().
  function buildHealth(only?: string): ComponentHealth[] {
    const config = loadConfig();
    const relays = d.getRelayHealth();
    const now = Date.now();
    // Projects known from config ∪ relay registrations ∪ active tasks, so a
    // registered-but-unconfigured relay (or a crew) still surfaces.
    const known = new Set<string>([
      ...Object.keys(config.projects),
      ...relays.map((r) => r.project),
      ...store.listAll().map((t) => t.project),
    ]);
    const names = only ? [only] : [...known];
    const out: ComponentHealth[] = [];
    for (const project of names) {
      const proj = config.projects[project];
      const captainName = proj?.captainName ?? `${project}-captain`;
      out.push(
        ...projectHealth({
          project,
          now,
          captainName,
          relay: relays.find((r) => r.project === project) ?? null,
          commandPresent: null, // command is on-demand; not tracked in this cut
          crews: store.list(project),
        }),
      );
    }
    return out;
  }

  // #44 dashboard: the same project set buildHealth() covers (config ∪ relays ∪ tasks).
  function knownProjects(): string[] {
    const config = loadConfig();
    return [...new Set<string>([
      ...Object.keys(config.projects),
      ...d.getRelayHealth().map((r) => r.project),
      ...store.listAll().map((t) => t.project),
    ])];
  }

  // #44 dashboard: gather all Tier 0/1/2 inputs (I/O) for the read-only snapshot
  // verb, then hand them to the pure assembler. The daemon log lives next to the
  // state root (~/.config/cockpit/cockpitd.log); deriving it from stateRoot keeps
  // tests isolated to their temp dir.
  async function gatherSnapshotInputs(now: number): Promise<DaemonSnapshotInputs> {
    const logPath = join(dirname(stateRoot), "cockpitd.log");
    // Scope Tier 2 per-project data to registered projects only. Orphan state
    // directories from removed/test projects are excluded here.
    const tier2Projects = opts.registeredProjects ?? Object.keys(loadConfig().projects);
    const projects = await Promise.all(
      tier2Projects.map(async (project) => {
        const cursor = await readCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER });
        const storeStats = gatherStoreStats(store, stateRoot, project);
        return {
          project,
          mailbox: await mailboxStats(stateRoot, project),
          lastAckedSeq: cursor?.lastAckedSeq ?? 0,
          storeByState: storeStats.byState,
          corruptCount: storeStats.corruptCount,
        };
      }),
    );
    return {
      pid: process.pid,
      processStartedAt: bootedAt,
      version: PKG_VERSION,
      distBuiltAt: distBuiltAt(),
      lastSweepAt,
      sweepCadenceMs: opts.sweepMs ?? 30_000,
      log: gatherLogStats(logPath, now, SNAPSHOT_LOG_WINDOW_MS),
      health: buildHealth(),
      projects,
      results: gatherResults(resultsDir),
    };
  }

  // Crash recovery on boot. reconcile() is async (#139: it consults the
  // interactive surface-liveness probe to reap dead crews instead of stalling
  // them), so run it — and the reattach loops that depend on its terminalizing a
  // dead crew before we re-subscribe it — inside an async IIFE. startCockpitd
  // stays synchronous (returns the handle immediately); boot recovery settles
  // shortly after. Errors are swallowed: a flaky probe must not crash boot.
  void (async () => {
    try {
      await d.reconcile();
    } catch (e) {
      log(`reconcile on boot failed: ${(e as Error).message}`);
    }

    // Restart-reattach (spec §5; closes interactive slice of #86):
    // For each LIVE interactive-codex task that has a resumeRef, fire reattach()
    // against the driver. Fire-and-forget; failures are logged only.
    //
    // Guard against the reattach storm: resuming a thread re-spawns its per-thread
    // MCP servers (gitnexus/pay), so blindly reattaching every non-terminal codex
    // task means each daemon restart re-spawns one MCP set per HISTORICAL crew —
    // which exhausted RAM (22 zombie tasks → 22 gitnexus servers on one boot).
    // Skip terminal tasks (done/failed/cancelled — incl. crews closed via the new
    // codex-close archive AND #139's surface-reaped crews) AND stale tasks whose
    // crew pane is long gone (no heartbeat within the staleness window).
    const bootNow = Date.now();
    const REATTACH_STALE_MS = 10 * 60_000;
    for (const rec of store.listAll()) {
      if (!shouldReattachCodex(rec, bootNow, REATTACH_STALE_MS)) continue;
      codexDriver.reattach(rec).catch((e: unknown) => {
        log(`reattach failed for ${rec.id}: ${(e as Error).message}`);
      });
    }

    // Re-subscribe the opencode SSE bridge after a daemon bounce: the crew's
    // cmux pane (and its `opencode --port <N>` server) survives a daemon restart,
    // so a non-terminal opencode crew with a known serverPort can be re-attached.
    for (const rec of store.listAll()) {
      if (rec.provider !== "opencode" || rec.mode !== "interactive") continue;
      if (TERMINAL_STATES.has(rec.state)) continue;
      if (!rec.serverPort) continue;
      opencodeBridge.start({ taskId: rec.id, port: rec.serverPort });
    }

    // B1: start the single cmux native-events subscription (additive; the scrape
    // fallback is unaffected). Opt out via defaults.cmuxEventsBridge:false. The
    // REAL (non-injected) bridge is skipped under vitest so daemon tests never
    // spawn a real `cmux events` child; an injected fake always starts so the
    // wiring stays testable.
    const enableCmuxEvents = loadConfig().defaults.cmuxEventsBridge !== false;
    const cmuxEventsSafe = !!opts.cmuxEventsBridge || !process.env.VITEST;
    if (enableCmuxEvents && cmuxEventsSafe) {
      try { cmuxEventsBridge.start(); } catch (e) { log(`cmux events bridge start failed: ${(e as Error).message}`); }
    }
  })();

  const server = startServer(sockPath, {
    handler: async (msg: any) => {
      if (msg.kind === "seed") { store.put(msg.record as TaskRecord); return { ok: true }; }
      // Crew-close teardown for codex: the cmux pane only hosts the `crew attach`
      // renderer — the thread lives on the shared app-server, so closing the pane
      // doesn't reap it. `cockpit crew close` calls this to archive the thread and
      // its per-thread MCP servers (else they leak ~53MB/crew). Fires for terminal
      // and non-terminal crews alike.
      if (msg.kind === "codex-close") {
        await codexDriver.close(msg.taskId).catch((e: unknown) => log(`codex close err: ${e}`));
        return { ok: true };
      }
      // #207 relay registration: the notify-relay announces itself on boot and
      // heartbeats every ~10s so the daemon can health-check it on the sweep.
      if (msg.kind === "relay-register") {
        d.registerRelay({ project: msg.project, pid: msg.pid, startedAt: msg.startedAt ?? Date.now() });
        return { ok: true };
      }
      if (msg.kind === "relay-heartbeat") {
        d.relayHeartbeat({ project: msg.project, pid: msg.pid });
        return { ok: true };
      }
      // #239 Phase B: relay proxy — crew-surface liveness probes.
      // The relay polls for pending probes, executes them in-lineage (cmux-accessible),
      // and posts results back. Handled inline like relay-register/heartbeat so they
      // never reach d.handle()'s unknown-kind guard.
      if (msg.kind === "relay-proxy-poll") {
        const project = msg.project as string;
        const probes = pendingProbes.get(project) ?? [];
        pendingProbes.set(project, []); // clear after handing off to the relay
        for (const p of probes) inFlightProbes.add(p.taskId); // mark in-flight
        return probes;
      }
      if (msg.kind === "relay-proxy-result") {
        const results = msg.results as Array<{ taskId: string; liveness: "alive" | "gone" | "unknown" }>;
        for (const r of results) {
          probeResults.set(r.taskId, r.liveness);
          inFlightProbes.delete(r.taskId); // result received — no longer in-flight
        }
        return { ok: true };
      }
      // #77 service-health surface: per-component liveness for the queried
      // project (or all). Captain liveness derived from relay heartbeat (#239).
      if (msg.kind === "health") {
        return buildHealth(msg.project as string | undefined);
      }
      // #44 dashboard: read-only full system snapshot (Tier 0/1/2). Additive —
      // the `health` verb above is untouched. Pure assembly; all I/O is gathered
      // here and fed in. Never mutates state.
      if (msg.kind === "snapshot") {
        const now = Date.now();
        return assembleDaemonSnapshot(await gatherSnapshotInputs(now), now);
      }
      // #239 Phase B: on any event that terminates a task, evict its entries from
      // inFlightProbes and probeResults so the Sets never leak. Tasks reaped by
      // sweep/reconcile (not via the socket) are naturally safe — proxiedSurfaceAlive
      // is only called for reapable (non-terminal) states.
      if (msg.kind === "event") {
        const rec = await d.handle(msg) as TaskRecord;
        if (TERMINAL_STATES.has(rec.state)) {
          inFlightProbes.delete(rec.id);
          probeResults.delete(rec.id);
        }
        return rec;
      }
      return d.handle(msg);
    },
    onAttach: (conn, frame) => {
      let set = attachConns.get(frame.taskId);
      if (!set) { set = new Set(); attachConns.set(frame.taskId, set); }
      set.add(conn);
      // A client arriving within the 5s window defuses any pending gate timer.
      cancelPromotionsFor(frame.taskId);
      // Immediately ack the attach so the client knows it's live.
      try { conn.write(encodeFrame({ type: "reattached", taskId: frame.taskId })); } catch { /* ignore */ }
    },
    onAttachInbound: (_conn, frame) => {
      // A second 'attach' on an already-claimed conn is ignored by protocol.ts,
      // so every frame here is a genuine inbound op.
      const f = frame as AttachInbound;
      if (f.op === "say")
        void codexDriver.say(f.taskId, f.text).catch((e: unknown) => log(`say err: ${e}`));
      else if (f.op === "steer")
        void codexDriver.steer(f.taskId, f.text).catch((e: unknown) => log(`steer err: ${e}`));
      else if (f.op === "interrupt")
        void codexDriver.interrupt(f.taskId).catch((e: unknown) => log(`interrupt err: ${e}`));
      else if (f.op === "answer")
        void codexDriver.answer(f.taskId, f.payload).catch((e: unknown) => log(`answer err: ${e}`));
    },
    onAttachClose: (conn) => {
      // Remove the conn from every task's set (the conn only exists in one set,
      // but a linear scan over a small map is fine).
      for (const set of attachConns.values()) set.delete(conn);
    },
  });
  log(`started pid=${process.pid} sock=${sockPath} stateRoot=${stateRoot}`);

  // #332: daemon-direct delivery loop — replaces relay EGRESS when flag ON.
  // Each tick reads from the project's mailbox cursor and delivers via
  // DaemonCmux + CaptainDelivery. Returns `tickDelivery` so tests can trigger
  // it manually; in production the caller sets up an interval (or the CLU
  // entrypoint below adds one).
  let deliveryTick: (() => Promise<void>) | undefined;
  let probeTick: (() => Promise<void>) | undefined;
  const captainMissingStreak = new Map<string, number>();
  const stoppedProjects = new Set<string>();

  if (daemonDirectCmux && daemonCmux) {
    const cmux = daemonCmux;
    const cfg = loadConfig();
    const deliveries = new Map<string, CaptainDelivery>();
    // #332 storm BUG 3: captured once at delivery-loop setup. Entries older than
    // sessionStartMs - STALE_THRESHOLD_MS are silently acked (cursor advanced)
    // without delivery, mirroring the relay's drain(). This stops a fresh/empty
    // cursor from re-delivering the entire historical backlog.
    const sessionStartMs = Date.now();

    // #332 storm BUG (re-entrancy): each tick does multiple slow cmux subprocess
    // calls and can exceed the 1s interval, so the interval can fire again while
    // the previous tick is still in-flight. Two overlapping ticks read the SAME
    // cursor seq and both deliver the entries after it → duplicate/storm
    // delivery. Mirror the relay's drain() `draining` guard: set on entry, clear
    // in a finally, skip overlapping fires.
    let delivering = false;

    const deliveryCore = async () => {
      const injectedSurfaces = opts.captainSurfaces ?? {};
      const allProjects = [...new Set([
        ...Object.keys(cfg.projects ?? {}),
        ...Object.keys(injectedSurfaces),
        ...store.listAll().map((t) => t.project),
      ])];

      for (const project of allProjects) {
        const projCfg = cfg.projects?.[project];
        const captainTitle = projCfg?.captainName ?? `${project}-captain`;

        // Try real discovery from cmux.
        const wsId = cmux.findWorkspaceId ? await cmux.findWorkspaceId(captainTitle) : null;
        let surface: PaneRef | null = null;
        let surfacesLength = 0;

        if (wsId) {
          const surfaces = await cmux.listSurfaces(wsId);
          surfacesLength = surfaces.length;
          surface = discoverCaptainSurface(surfaces, captainTitle);
        }

        // Fall back to injected surface (tests / config-less projects).
        if (!surface) surface = injectedSurfaces[project] ?? null;

        if (surface) {
          // Captain found — if previously reaped, un-reap and reset streak so
          // delivery resumes (a relaunched captain creates a new pane).
          if (stoppedProjects.has(project)) {
            stoppedProjects.delete(project);
            captainMissingStreak.set(project, 0);
          }
          captainMissingStreak.set(project, 0);
        } else {
          // Streak tracking: surfaces.length > 0 means cmux is reachable but the
          // captain's pane is provably absent. surfaces.length === 0 means cmux
          // was unreachable (fail-soft → []), which we treat as "unknown" — never
          // increment the streak (no false reaping on transient outages).
          if (surfacesLength > 0) {
            const streak = (captainMissingStreak.get(project) ?? 0) + 1;
            captainMissingStreak.set(project, streak);
            if (streak >= CAPTAIN_GONE_STREAK_K) {
              // Fire the reap log exactly ONCE on the transition (only the first
              // absent sweep past K). Do NOT re-fire on subsequent sweeps.
              if (!stoppedProjects.has(project)) {
                stoppedProjects.add(project);
                log(`captain ${captainTitle}: surface gone for ${CAPTAIN_GONE_STREAK_K} sweeps — stopping delivery`);
              }
            }
          }
          continue;
        }

        const cursor = await readCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER });
        const lastAcked = cursor?.lastAckedSeq ?? 0;
        let d = deliveries.get(project);
        if (!d) {
          d = new CaptainDelivery({
            maxDefers: cfg.relay?.maxDeferDeliveries ?? 300,
            stableProbePolls: cfg.relay?.stableProbePolls ?? 3,
          });
          deliveries.set(project, d);
        }
        for await (const entry of readFromCursor({ stateRoot, project, fromSeq: lastAcked + 1 })) {
          // #332 storm BUG 3: silently ack entries that pre-date this daemon
          // session by more than STALE_THRESHOLD_MS — leftovers from dead crews
          // or a prior captain session. Mirrors the relay's drain() skip so a
          // fresh/empty cursor never re-delivers the historical backlog.
          if (new Date(entry.ts).getTime() < sessionStartMs - STALE_THRESHOLD_MS) {
            await writeCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER, lastAckedSeq: entry.seq });
            continue;
          }
          const result = await d.deliver(entry, (text, sendOpts) =>
            cmux.send(surface!, text, sendOpts),
          );
          if ("delivered" in result) {
            await writeCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER, lastAckedSeq: entry.seq });
          } else {
            break;
          }
        }
      }
    };

    deliveryTick = async () => {
      if (delivering) return;
      delivering = true;
      try {
        await deliveryCore();
      } finally {
        delivering = false;
      }
    };

    // #332: daemon-direct blocked-crew detection. Reuses createInteractiveProbe
    // (from notify-relay.ts) with a direct cmux pane reader injected as the
    // readPaneTail dep. Matches the relay's PROBE_INTERVAL_MS (10s).
    const directPaneReader = createDirectCrewPaneReader(cmux, (project) => {
      const cfg2 = loadConfig();
      return cfg2.projects?.[project]?.captainName ?? `${project}-captain`;
    });

    const interactiveProbe = createInteractiveProbe({
      project: "_all_",
      listTasks: async () => store.listAll(),
      readPaneTail: directPaneReader,
      sendEvent: async (event) => {
        const rec = store.listAll().find((r) => r.id === event.id);
        if (rec) {
          await d.handle({ kind: "event", project: rec.project, event });
        }
      },
      now: () => Date.now(),
      log,
    });
    // #332 storm BUG (re-entrancy): the probe reads crew panes via slow cmux
    // subprocess calls and can exceed its 10s interval. Give it its own
    // independent guard (separate from `delivering`) so an overlapping probe
    // fire is skipped rather than stacking back-to-back cmux reads.
    let probing = false;
    probeTick = async () => {
      if (probing) return;
      probing = true;
      try {
        await interactiveProbe.tick();
      } finally {
        probing = false;
      }
    };
  }

  // #332: production delivery interval (1s poll). Gated on sweepMs so tests
  // with sweepMs:0 avoid a real timer. The interval is always fire-and-forget so
  // a slow tick never stacks.
  let deliveryTimer: NodeJS.Timeout | undefined;
  if (daemonDirectCmux && daemonCmux && opts.sweepMs && opts.sweepMs > 0) {
    deliveryTimer = setInterval(() => {
      void deliveryTick!().catch((e: unknown) => log(`delivery tick error: ${(e as Error).message}`));
    }, 1000);
    deliveryTimer.unref?.();
  }

  // #332: blocked-crew probe interval (10s). Same gate as delivery interval.
  let probeTimer: NodeJS.Timeout | undefined;
  if (daemonDirectCmux && daemonCmux && opts.sweepMs && opts.sweepMs > 0) {
    probeTimer = setInterval(() => {
      void probeTick!().catch((e: unknown) => log(`probe tick error: ${(e as Error).message}`));
    }, 10_000);
    probeTimer.unref?.();
  }

  let timer: NodeJS.Timeout | undefined;
  if (opts.sweepMs && opts.sweepMs > 0) {
    // sweep() is async (#139: it probes cmux surface liveness). Guard against an
    // overlapping run if a probe is slow — skip this tick rather than stacking
    // sweeps. Errors are swallowed so a flaky probe never crashes the daemon.
    let sweeping = false;
    timer = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      lastSweepAt = Date.now(); // Tier 0 observability: time of the most recent sweep
      void d.sweep()
        .catch((e: unknown) => log(`sweep failed: ${(e as Error).message}`))
        .finally(() => { sweeping = false; });
    }, opts.sweepMs);
    timer.unref?.();
  }

  const rotationInterval = opts.rotationIntervalMs ?? 60_000;
  const mboxCfg = {
    maxBytes: opts.mailboxConfig?.maxBytes ?? 5 * 1024 * 1024,
    maxAgeMs: opts.mailboxConfig?.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000,
    keepCount: opts.mailboxConfig?.keepCount ?? 3,
  };
  let rotationTimer: NodeJS.Timeout | undefined;
  if (rotationInterval > 0) {
    const inboxPath = join(stateRoot, "inbox");
    rotationTimer = setInterval(async () => {
      try {
        let entries: string[];
        try { entries = await readdir(inboxPath); }
        catch { return; }
        const projects = new Set(
          entries
            .filter((e) => e.endsWith(".log"))
            .map((e) => e.slice(0, -".log".length)),
        );
        for (const project of projects) {
          await rotateIfNeeded({ stateRoot, project, ...mboxCfg });
        }
      } catch (e) {
        log(`rotation timer error: ${(e as Error).message}`);
      }
    }, rotationInterval);
    rotationTimer.unref?.();
  }

  return {
    stop(): Promise<void> {
      if (deliveryTimer) clearInterval(deliveryTimer);
      if (probeTimer) clearInterval(probeTimer);
      if (timer) clearInterval(timer);
      if (rotationTimer) clearInterval(rotationTimer);
      try { cmuxEventsBridge.stop(); } catch { /* best-effort */ }
      for (const kill of activeHeadlessKills) kill();
      return new Promise<void>((resolve) => server.close(() => { log("stopped"); resolve(); }));
    },
    tickDelivery: deliveryTick,
    tickProbe: probeTick,
  };
}

// Executed by launchd (ProgramArguments → this file's compiled .js).
if (process.argv[1] && process.argv[1].endsWith("cockpitd.js")) {
  const h = startCockpitd({ sweepMs: 30000 });
  process.on("SIGTERM", () => { h.stop(); process.exit(0); });
}
