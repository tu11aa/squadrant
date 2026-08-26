// src/control/daemon/start.ts
// Core daemon assembly: wires all daemon/* factories, runs boot recovery,
// starts timers, and returns the DaemonHandle.
// Concrete driver construction (CodexInteractiveDriver, DaemonCmux, etc.)
// lives in the host (squadrantd.ts) — this file stays free of those imports.
import { join, dirname } from "node:path";
import { readdir } from "node:fs/promises";
import { createDaemon } from "./reduce.js";
import { createProbes, buildSurfaceProbe } from "./probes.js";
import { createDelivery } from "./delivery-loop.js";
import { createGateResolver } from "./gates.js";
import { createServer } from "./server.js";
import { rotateIfNeeded, mailboxStats, readCursor, appendCaptainMessage } from "../mailbox.js";
import { writeExitMarker, consumeExitMarker, writeRunningMarker, readRunningMarker, removeRunningMarker } from "./exit-marker.js";
import { projectHealth, deriveCaptainState, type ComponentHealth } from "../liveness.js";
import type { DaemonSnapshotInputs } from "../snapshot.js";
import { loadConfig, TERMINAL_STATES, ensureCmuxAutoConfig } from "@squadrant/shared";
import { distBuiltAt, gatherLogStats, gatherStoreStats, gatherResults } from "./snapshot-gather.js";
import type { SquadrantdOpts, DaemonContext } from "./context.js";

const CURSOR_SUBSCRIBER = "captain";
const SNAPSHOT_LOG_WINDOW_MS = 60 * 60 * 1000;

export interface DaemonHandle {
  /** `reason` is folded into the exit log line (e.g. "SIGTERM", "SIGINT") so a
   *  restart is diagnosable from the log instead of inferred (#535). */
  stop(reason?: string): Promise<void>;
  tickDelivery: (() => Promise<void>) | undefined;
  tickProbe: (() => Promise<void>) | undefined;
  /** #589: the mailbox-rotation tick, exposed for tests — also touches the
   *  running-marker heartbeat (see exit-marker.ts). undefined when rotation
   *  is disabled (rotationIntervalMs <= 0). */
  tickRotation: (() => Promise<void>) | undefined;
}

/** Wire all daemon/* factories, run boot recovery, start timers.
 *  ctx must already have: attach handlers, codexDriver, opencodeBridge,
 *  cmuxEventsBridge, daemonCmux, daemonDirectCmux set on it by the host. */
export function startDaemon(ctx: DaemonContext, opts: SquadrantdOpts, pkgVersion: string): DaemonHandle {
  const {
    stateRoot, store, log, isPidAlive, resultsDir,
    taskTimeoutMs, inFlightHeadlessIds, activeHeadlessKills,
    broadcast, cancelPromotionsFor,
  } = ctx;
  const { daemonCmux } = ctx;

  const probes = createProbes(ctx);
  // #595: built before createDelivery so reapOrphanedCrews can be gated on the
  // crew's own surface liveness instead of the captain's alone.
  const surfaceProbe = buildSurfaceProbe(ctx, probes, daemonCmux);
  const { defaultNotify, deliveryTick: initialDeliveryTick, deliveryStats, inFlightDelivery } = createDelivery(ctx, daemonCmux, surfaceProbe);
  // Compose the Telegram outbound push onto the notify fan-out: a captain
  // notification also pushes to the project's Telegram topic. When no bridge is
  // configured, notify is the base function unchanged (zero behavior change).
  // pushLifecycle is best-effort and never throws (the bridge swallows errors),
  // so it can't delay or break captain delivery.
  const baseNotify = opts.notify ?? defaultNotify;
  const notify: DaemonContext["notify"] = ctx.telegramBridge
    ? async (args) => {
        await baseNotify(args);
        ctx.telegramBridge!.pushLifecycle(args.project, args.event);
      }
    : baseNotify;

  const ingest = (project: string) => (e: import("@squadrant/shared").ControlEvent) =>
    void ctx.d.handle({ kind: "event", project, event: e });

  const d = createDaemon({
    store, now: () => Date.now(), isPidAlive, notify, taskTimeoutMs, takeoverNudgeHours: ctx.takeoverNudgeHours,
    isSurfaceAlive: surfaceProbe,
    resendFirstTurn: ctx.resendFirstTurn,
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
      // Captain liveness from the ground-truth registry (Task 4) — runtime
      // snapshot + pid floor, survives daemon restart (§4.1/§4.5).
      const capEntry = ctx.livenessRegistry.get(project);
      out.push(
        ...projectHealth({
          project, now, captainName,
          captainStopped: null,
          captainState: deriveCaptainState(capEntry),
          commandPresent: null,
          crews: store.list(project),
          // #579/#484 Gap 3: surface the same deferral stats already exposed to
          // the snapshot (line ~135 below) on the health row too, so `squadrant
          // doctor` / `squadrant status --detailed` show a stuck delivery with
          // zero configuration.
          captainDeferral: deliveryStats(project),
        }),
      );
    }
    return out;
  }

  async function gatherSnapshotInputs(now: number): Promise<DaemonSnapshotInputs> {
    const logPath = join(dirname(stateRoot), "squadrantd.log");
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
          deferral: deliveryStats(project),
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
      telegram: ctx.telegramBridge
        ? { configured: true, ...ctx.telegramBridge.health() }
        : { configured: false, polling: false, lastSuccessfulPollAt: null, lastError: null, lastErrorAt: null },
      lifecycleSources: ctx.lifecycleSources.map((s) => ({ name: s.name, ...(s.health?.() ?? { active: true, error: null }) })),
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

    // Telegram inbound long-poll (opt-in). The real bridge is only constructed
    // by the host when config.telegram is present and not under vitest, so
    // ctx.telegramBridge here is either that real bridge or an injected fake.
    if (ctx.telegramBridge) {
      try { ctx.telegramBridge.start(); }
      catch (e) { log(`telegram bridge start failed: ${(e as Error).message}`); }
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
  // #535: greppable boot marker — a restart must be diagnosable from the log,
  // never inferred from process START time.
  log(`boot pid=${process.pid} version=${pkgVersion} socket=${ctx.sockPath} stateRoot=${stateRoot}`);

  // #589: read back the previous exit marker (if any) and surface the gap
  // between that exit and this boot — the 2026-07-20 outage's 23-minutes-awake
  // silent gap must be visible from the log alone next time, not reconstructed
  // after the fact from unrelated timestamps.
  const bootTs = new Date().toISOString();
  {
    const sendDownAlert = (minutes: number, reasonText: string) => {
      const text = `⚠️ daemon was down for ${minutes} min (last exit reason=${reasonText})`;
      // Same project-list source as the Tier 2 snapshot below — injectable
      // for tests, defaults to every configured project in production.
      const alertProjects = opts.registeredProjects ?? Object.keys(loadConfig().projects);
      for (const project of alertProjects) {
        appendCaptainMessage({ stateRoot, project, text, source: "daemon" })
          .catch((e) => log(`boot-gap alert failed project=${project}: ${(e as Error).message}`));
      }
    };

    const { marker, gapMs } = consumeExitMarker(stateRoot);
    // Read BEFORE writing this boot's own fresh running marker below.
    const prevRunning = readRunningMarker(stateRoot);
    if (marker) {
      log(`previous exit ts=${marker.ts} reason=${marker.reason} gap=${((gapMs ?? 0) / 1000).toFixed(1)}s`);
      if ((gapMs ?? 0) > 60_000) sendDownAlert(Math.round((gapMs ?? 0) / 60_000), marker.reason);
    } else if (prevRunning) {
      // #589: a running marker survived with no exit marker to explain it —
      // the prior daemon died without running any JS shutdown code (SIGKILL,
      // OOM, power loss). Without this heartbeat marker, this is exactly the
      // silent case #589 is about: it would read as "previous exit: none",
      // indistinguishable from a genuine first boot.
      const lastHeartbeatMs = new Date(prevRunning.lastHeartbeatTs).getTime();
      const uncleanGapMs = Math.max(0, Date.now() - lastHeartbeatMs);
      log(`previous exit: UNCLEAN (no marker; last heartbeat ${prevRunning.lastHeartbeatTs}, gap=${(uncleanGapMs / 1000).toFixed(1)}s)`);
      if (uncleanGapMs > 60_000) {
        sendDownAlert(Math.round(uncleanGapMs / 60_000), "unclean/unknown — no exit marker, likely SIGKILL/OOM/power-loss");
      }
    } else {
      log("previous exit: none (clean or first boot)");
    }
    // A fresh running marker for THIS boot, regardless of which branch above
    // fired — the rotation-tick heartbeat below re-touches lastHeartbeatTs.
    writeRunningMarker(stateRoot, { pid: process.pid, bootTs, lastHeartbeatTs: bootTs }, log);
  }

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
  let rotationTick: (() => Promise<void>) | undefined;
  if (rotationInterval > 0) {
    const inboxPath = join(stateRoot, "inbox");
    rotationTick = async () => {
      try {
        let entries: string[];
        try { entries = await readdir(inboxPath); } catch { return; }
        const projects = new Set(
          entries.filter((e) => e.endsWith(".log")).map((e) => e.slice(0, -".log".length)),
        );
        for (const project of projects) await rotateIfNeeded({ stateRoot, project, ...mboxCfg });
      } catch (e) {
        log(`rotation timer error: ${(e as Error).message}`);
      } finally {
        // #589: this timer is the daemon's existing ~60s cadence — piggyback
        // the running-marker heartbeat on it rather than adding a new timer.
        writeRunningMarker(stateRoot, { pid: process.pid, bootTs, lastHeartbeatTs: new Date().toISOString() }, log);
      }
    };
    rotationTimer = setInterval(() => { void rotationTick!(); }, rotationInterval);
    rotationTimer.unref?.();
  }

  return {
    stop(reason = "requested"): Promise<void> {
      // #589/#590: capture signal-source evidence (ppid, whether launchd is
      // the parent, process uptime) and the in-flight delivery state BEFORE
      // any async teardown — Node gives no siginfo for who sent a signal, so
      // ppid + uptime + in-flight delivery is the evidence actually available,
      // and it must be captured synchronously so it lands even if the caller
      // fires-and-forgets stop() (the historical #535 bug).
      const ppid = process.ppid;
      const uptimeMs = Math.round(process.uptime() * 1000);
      const inFlight = inFlightDelivery();
      log(
        `exit pid=${process.pid} reason=${reason} ppid=${ppid} launchd=${ppid === 1} ` +
        `uptimeMs=${uptimeMs} inFlightDelivery=${inFlight ? `${inFlight.project}#${inFlight.seq}(defers=${inFlight.deferCount})` : "none"}`,
      );
      writeExitMarker(stateRoot, { ts: new Date().toISOString(), pid: process.pid, reason, ppid, uptimeMs, inFlightDelivery: inFlight }, log);
      // #589: a graceful stop diagnoses itself (the exit marker above) — the
      // running marker's only job is flagging an UNCLEAN death, so remove it
      // here. Its absence next boot (alongside the fresh exit marker) is what
      // marks this shutdown as clean, not unclean.
      removeRunningMarker(stateRoot, log);
      if (deliveryTimer) clearInterval(deliveryTimer);
      if (probeTimer) clearInterval(probeTimer);
      if (timer) clearInterval(timer);
      if (rotationTimer) clearInterval(rotationTimer);
      try { ctx.cmuxEventsBridge.stop(); } catch { /* best-effort */ }
      try { ctx.telegramBridge?.stop(); } catch { /* best-effort */ }
      try { ctx.codexDriver.stop?.(); } catch { /* best-effort */ }
      for (const kill of ctx.activeHeadlessKills) kill();
      return new Promise<void>((resolve) => server.close(() => { log(`exit-complete pid=${process.pid}`); resolve(); }));
    },
    tickDelivery: deliveryTick,
    tickProbe: probeTick,
    tickRotation: rotationTick,
  };
}
