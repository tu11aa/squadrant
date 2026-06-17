// src/control/cockpitd.ts
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createDaemon } from "./daemon.js";
import { buildContext } from "./daemon/context.js";
import { createAttach } from "./daemon/attach.js";
import { createProbes, buildSurfaceProbe } from "./daemon/probes.js";
import { createDelivery } from "./daemon/delivery.js";
import { createGateResolver } from "./daemon/gates.js";
import { createServer } from "./daemon/server.js";
export type { CockpitdOpts } from "./daemon/context.js";
export { defaultIsPidAlive } from "./daemon/context.js";
import type { AttachFrame } from "./protocol.js";
import { runHeadless } from "./headless-launcher.js";
import { CodexInteractiveDriver, shouldReattachCodex } from "./codex/driver.js";
import { OpencodeSseBridge } from "./opencode/sse-bridge.js";
import { CmuxEventsBridge } from "./cmux/events-bridge.js";
import { rotateIfNeeded, mailboxStats, readCursor } from "./mailbox.js";
import { createRelayHealer } from "./relay-healer.js";
import { STALE_THRESHOLD_MS } from "../commands/notify-relay.js";
import { projectHealth, type ComponentHealth } from "./liveness.js";
import type { DaemonSnapshotInputs } from "./snapshot.js";
import { loadConfig } from "@cockpit/shared";
import { readdir } from "node:fs/promises";
import type { TaskRecord, ControlEvent } from "@cockpit/shared";
import { TERMINAL_STATES } from "@cockpit/shared";
import type { Socket } from "node:net";
import type { PaneRef } from "../runtimes/types.js";
import { DaemonCmux } from "./cmux/daemon-cmux.js";
import { ensureCmuxAutoConfig, type AutoConfigResult } from "@cockpit/shared";
import { createCmuxDriver } from "../runtimes/index.js";
import { distBuiltAt, gatherLogStats, gatherStoreStats, gatherResults } from "./daemon/snapshot-gather.js";

// This module's own compiled file — its mtime is used in readPkgVersion() only.
// distBuiltAt() now lives in daemon/snapshot-gather.ts.
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

export type ListSurfacesFn = (wsId: string) => Promise<PaneRef[]>;

/**
 * Pure: search a list of surfaces for one whose title matches the captain name.
 * Part of #332 daemon-direct captain-surface discovery (Task 5).
 */
export function discoverCaptainSurface(surfaces: PaneRef[], captainTitle: string): PaneRef | null {
  return surfaces.find((s) => s.title === captainTitle) ?? null;
}

export function startCockpitd(opts: CockpitdOpts = {}) {
  const ctx = buildContext(opts);
  const {
    stateRoot, sockPath, store, log, isPidAlive, spawn, resultsDir, writeResult,
    taskTimeoutMs, attachConns, pendingProbes, probeResults, inFlightProbes,
    inFlightHeadlessIds, activeHeadlessKills, captainMissingStreak, stoppedProjects,
  } = ctx;
  const bootedAt = ctx.bootedAt;

  const probes = createProbes(ctx);

  const { broadcast, schedulePromotion, cancelPromotionsFor } = createAttach(ctx);
  ctx.broadcast = broadcast;
  ctx.schedulePromotion = schedulePromotion;
  ctx.cancelPromotionsFor = cancelPromotionsFor;

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

  // Set late-bound driver fields so daemon/* modules (gates.ts, server.ts) can
  // reference them lazily via ctx at call time.
  ctx.codexDriver = codexDriver;
  ctx.opencodeBridge = opencodeBridge;
  ctx.cmuxEventsBridge = cmuxEventsBridge;

  const ingest = (project: string) => (e: import("@cockpit/shared").ControlEvent) =>
    void d.handle({ kind: "event", project, event: e });

  // #332: daemon-direct flag resolved here so both the surface-liveness probe
  // and the delivery loop agree on the same value.
  const daemonDirectCmux = opts.daemonDirectCmux ?? loadConfig().defaults?.daemonDirectCmux ?? false;

  // #332: construct DaemonCmux in production when the flag is ON but no
  // injectable was provided. The factory is overridable for tests.
  const daemonCmux = opts.daemonCmux
    ?? (daemonDirectCmux ? (opts.makeDaemonCmux ?? (() => new DaemonCmux(createCmuxDriver())))() : undefined);

  // Set late-bound driver fields on ctx before createDelivery reads them.
  ctx.daemonDirectCmux = daemonDirectCmux;
  ctx.daemonCmux = daemonCmux;

  const { defaultNotify, deliveryTick: initialDeliveryTick } = createDelivery(ctx, daemonCmux, daemonDirectCmux);
  const notify = opts.notify ?? defaultNotify;

  const surfaceProbe = buildSurfaceProbe(ctx, probes, daemonDirectCmux, daemonCmux);

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
    resolveInteractiveGate: createGateResolver(ctx),
  });

  ctx.d = d; // late-bind so daemon/* closures that reference ctx.d resolve correctly

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
      lastSweepAt: ctx.lastSweepAt.value,
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

    // #348: when daemon-direct is opt-in ON, ensure the cmux socket auto-config
    // (comment-preserving write + non-cmux probe) on every boot. Idempotent, and
    // it recovers the "cmux not running at first write" edge case (§3.4 / §4.4):
    // the next boot re-probes once cmux is (re)launched. Gated on the flag so it's
    // a no-op under the relay default; skipped under vitest unless injected so
    // daemon tests never touch the real cmux.json or spawn the orphan probe.
    const autoConfigSafe = !!opts.runCmuxAutoConfig || !process.env.VITEST;
    if (daemonDirectCmux && autoConfigSafe) {
      try {
        const r = await (opts.runCmuxAutoConfig ?? ensureCmuxAutoConfig)();
        if (r.configChanged) log(`cmux autoconfig: wrote automation socket mode to ${r.configPath}`);
        if (r.needsRestart && r.promptedThisRun) {
          log("cmux autoconfig: socket still rejects the daemon — restart cmux to enable daemon-direct delivery");
        }
      } catch (e) {
        log(`cmux autoconfig failed: ${(e as Error).message}`);
      }
    }
  })();

  const server = createServer(ctx, {
    buildHealth,
    gatherSnapshotInputs,
    cancelPromotionsFor,
    broadcast,
  });
  log(`started pid=${process.pid} sock=${sockPath} stateRoot=${stateRoot}`);

  // #332: daemon-direct delivery loop — see daemon/delivery.ts.
  let deliveryTick: (() => Promise<void>) | undefined = initialDeliveryTick;
  let probeTick: (() => Promise<void>) | undefined;

  if (daemonDirectCmux && daemonCmux) {
    // #332: daemon-direct blocked-crew detection (probe-tick guard is inside
    // createProbes.buildInteractiveProbe so re-entrancy is handled there).
    probeTick = probes.buildInteractiveProbe({ cmux: daemonCmux });
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
      ctx.lastSweepAt.value = Date.now(); // Tier 0 observability: time of the most recent sweep
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
