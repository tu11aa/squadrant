// src/control/daemon/start.ts
// Core daemon assembly: wires all daemon/* factories, runs boot recovery,
// starts timers, and returns the DaemonHandle.
// Concrete driver construction (CodexInteractiveDriver, DaemonCmux, etc.)
// lives in the host (cockpitd.ts) — this file stays free of those imports.
import { join, dirname } from "node:path";
import { readdir } from "node:fs/promises";
import { createDaemon } from "../daemon.js";
import { createProbes, buildSurfaceProbe } from "./probes.js";
import { createDelivery } from "./delivery.js";
import { createGateResolver } from "./gates.js";
import { createServer } from "./server.js";
import { rotateIfNeeded, mailboxStats, readCursor } from "../mailbox.js";
import { projectHealth, type ComponentHealth } from "../liveness.js";
import type { DaemonSnapshotInputs } from "../snapshot.js";
import { loadConfig, TERMINAL_STATES, ensureCmuxAutoConfig } from "@cockpit/shared";
import { distBuiltAt, gatherLogStats, gatherStoreStats, gatherResults } from "./snapshot-gather.js";
import type { CockpitdOpts, DaemonContext } from "./context.js";

const CURSOR_SUBSCRIBER = "captain";
const SNAPSHOT_LOG_WINDOW_MS = 60 * 60 * 1000;

export interface DaemonHandle {
  stop(): Promise<void>;
  tickDelivery: (() => Promise<void>) | undefined;
  tickProbe: (() => Promise<void>) | undefined;
}

/** Wire all daemon/* factories, run boot recovery, start timers.
 *  ctx must already have: attach handlers, codexDriver, opencodeBridge,
 *  cmuxEventsBridge, daemonCmux, daemonDirectCmux set on it by the host. */
export function startDaemon(ctx: DaemonContext, opts: CockpitdOpts, pkgVersion: string): DaemonHandle {
  const {
    stateRoot, store, log, isPidAlive, resultsDir,
    taskTimeoutMs, inFlightHeadlessIds, activeHeadlessKills,
    broadcast, cancelPromotionsFor,
  } = ctx;
  const { daemonCmux } = ctx;

  const probes = createProbes(ctx);
  const { defaultNotify, deliveryTick: initialDeliveryTick } = createDelivery(ctx, daemonCmux);
  const notify = opts.notify ?? defaultNotify;
  const surfaceProbe = buildSurfaceProbe(ctx, probes, daemonCmux);

  const ingest = (project: string) => (e: import("@cockpit/shared").ControlEvent) =>
    void ctx.d.handle({ kind: "event", project, event: e });

  const d = createDaemon({
    store, now: () => Date.now(), isPidAlive, notify, taskTimeoutMs,
    isSurfaceAlive: surfaceProbe,
    launchHeadless: opts.launchHeadless!,
    isHeadlessInFlight: (id) => inFlightHeadlessIds.has(id),
    launchInteractive: async (rec) => {
      if (rec.provider === "codex") {
        await ctx.codexDriver.dispatch(rec as any);
        return;
      }
      if (rec.provider === "claude") {
        ingest(rec.project)({ type: "task.started", id: rec.id });
        return;
      }
      if (rec.provider === "opencode") {
        ingest(rec.project)({ type: "task.started", id: rec.id });
        if (rec.serverPort) ctx.opencodeBridge.start({ taskId: rec.id, port: rec.serverPort });
        return;
      }
      throw new Error(
        `interactive mode is not yet implemented for provider '${rec.provider}'; only 'codex', 'claude', and 'opencode' are supported`,
      );
    },
    resolveInteractiveGate: createGateResolver(ctx),
  });

  ctx.d = d;

  // ── Health + snapshot ─────────────────────────────────────────────────────

  function buildHealth(only?: string): ComponentHealth[] {
    const config = loadConfig();
    const now = Date.now();
    const known = new Set<string>([
      ...Object.keys(config.projects),
      ...store.listAll().map((t) => t.project),
    ]);
    const names = only ? [only] : [...known];
    const out: ComponentHealth[] = [];
    for (const project of names) {
      const proj = config.projects[project];
      const captainName = proj?.captainName ?? `${project}-captain`;
      // Captain liveness from the delivery loop: stopped=true → gone,
      // streak===0 → alive (last tick found the surface), else unknown.
      const stopped = ctx.stoppedProjects.has(project);
      const streak = ctx.captainMissingStreak.get(project);
      const captainStopped: boolean | null = stopped ? true : streak === 0 ? false : null;
      out.push(
        ...projectHealth({
          project, now, captainName,
          captainStopped,
          commandPresent: null,
          crews: store.list(project),
        }),
      );
    }
    return out;
  }

  async function gatherSnapshotInputs(now: number): Promise<DaemonSnapshotInputs> {
    const logPath = join(dirname(stateRoot), "cockpitd.log");
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
      processStartedAt: ctx.bootedAt,
      version: pkgVersion,
      distBuiltAt: distBuiltAt(),
      lastSweepAt: ctx.lastSweepAt.value,
      sweepCadenceMs: opts.sweepMs ?? 30_000,
      log: gatherLogStats(logPath, now, SNAPSHOT_LOG_WINDOW_MS),
      health: buildHealth(),
      projects,
      results: gatherResults(resultsDir),
    };
  }

  // ── Boot recovery ─────────────────────────────────────────────────────────

  void (async () => {
    try { await d.reconcile(); }
    catch (e) { log(`reconcile on boot failed: ${(e as Error).message}`); }

    // Restart-reattach: reattach live codex crews. Guard against the storm
    // (each reattach re-spawns per-thread MCP servers). Skip terminal and stale tasks.
    // Inline predicate avoids importing from the concrete codex driver module.
    const bootNow = Date.now();
    const REATTACH_STALE_MS = 10 * 60_000;
    for (const rec of store.listAll()) {
      if (rec.provider !== "codex" || rec.mode !== "interactive") continue;
      if (TERMINAL_STATES.has(rec.state)) continue;
      // Inline of shouldReattachCodex (concrete driver module stays in host).
      const lastAttempt = rec.attempts?.at(-1);
      const last = lastAttempt?.lastHeartbeatAt ?? rec.lastHeartbeat ?? 0;
      if (bootNow - last > REATTACH_STALE_MS) continue;
      if (!lastAttempt?.resumeRef) continue;
      ctx.codexDriver.reattach(rec).catch((e: unknown) => {
        log(`reattach failed for ${rec.id}: ${(e as Error).message}`);
      });
    }

    // Re-subscribe opencode SSE bridge after a daemon bounce.
    for (const rec of store.listAll()) {
      if (rec.provider !== "opencode" || rec.mode !== "interactive") continue;
      if (TERMINAL_STATES.has(rec.state)) continue;
      if (!rec.serverPort) continue;
      ctx.opencodeBridge.start({ taskId: rec.id, port: rec.serverPort });
    }

    // B1: start cmux native-events bridge. Skipped under vitest unless injected.
    const enableCmuxEvents = loadConfig().defaults.cmuxEventsBridge !== false;
    const cmuxEventsSafe = !!opts.cmuxEventsBridge || !process.env.VITEST;
    if (enableCmuxEvents && cmuxEventsSafe) {
      try { ctx.cmuxEventsBridge.start(); }
      catch (e) { log(`cmux events bridge start failed: ${(e as Error).message}`); }
    }

    // #348: cmux socket auto-config on boot.
    const autoConfigSafe = !!opts.runCmuxAutoConfig || !process.env.VITEST;
    if (autoConfigSafe) {
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

  // ── Server + timers ───────────────────────────────────────────────────────

  const server = createServer(ctx, { buildHealth, gatherSnapshotInputs, cancelPromotionsFor, broadcast });
  log(`started pid=${process.pid} sock=${ctx.sockPath} stateRoot=${stateRoot}`);

  let deliveryTick: (() => Promise<void>) | undefined = initialDeliveryTick;
  let probeTick: (() => Promise<void>) | undefined;

  if (daemonCmux) {
    probeTick = probes.buildInteractiveProbe({ cmux: daemonCmux });
  }

  let deliveryTimer: NodeJS.Timeout | undefined;
  if (daemonCmux && opts.sweepMs && opts.sweepMs > 0) {
    deliveryTimer = setInterval(() => {
      void deliveryTick!().catch((e: unknown) => log(`delivery tick error: ${(e as Error).message}`));
    }, 1000);
    deliveryTimer.unref?.();
  }

  let probeTimer: NodeJS.Timeout | undefined;
  if (daemonCmux && opts.sweepMs && opts.sweepMs > 0) {
    probeTimer = setInterval(() => {
      void probeTick!().catch((e: unknown) => log(`probe tick error: ${(e as Error).message}`));
    }, 10_000);
    probeTimer.unref?.();
  }

  let timer: NodeJS.Timeout | undefined;
  if (opts.sweepMs && opts.sweepMs > 0) {
    let sweeping = false;
    timer = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      ctx.lastSweepAt.value = Date.now();
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
        try { entries = await readdir(inboxPath); } catch { return; }
        const projects = new Set(
          entries.filter((e) => e.endsWith(".log")).map((e) => e.slice(0, -".log".length)),
        );
        for (const project of projects) await rotateIfNeeded({ stateRoot, project, ...mboxCfg });
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
      try { ctx.cmuxEventsBridge.stop(); } catch { /* best-effort */ }
      try { ctx.codexDriver.stop?.(); } catch { /* best-effort */ }
      for (const kill of ctx.activeHeadlessKills) kill();
      return new Promise<void>((resolve) => server.close(() => { log("stopped"); resolve(); }));
    },
    tickDelivery: deliveryTick,
    tickProbe: probeTick,
  };
}
