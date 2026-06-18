// src/control/cockpitd.ts — host: constructs concrete drivers + thin shim.
// All daemon logic lives in daemon/start.ts; this file owns only the
// concrete class instantiation and the launchd entry guard.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { buildContext } from "@cockpit/core";
import { createAttach } from "@cockpit/core";
import { startDaemon } from "@cockpit/core";
import { createRelayHealer } from "@cockpit/core";
export type { CockpitdOpts } from "@cockpit/core";
export { defaultIsPidAlive } from "@cockpit/core";
export { discoverCaptainSurface } from "@cockpit/core";
import type { AttachFrame } from "@cockpit/core";
import type { PaneRef } from "@cockpit/shared";
import { runHeadless, CodexInteractiveDriver, OpencodeSseBridge } from "@cockpit/agents";
import { CmuxEventsBridge, DaemonCmux } from "@cockpit/workspaces";
import { loadConfig, TERMINAL_STATES } from "@cockpit/shared";
import { createCmuxDriver, RuntimeRegistry } from "@cockpit/workspaces";

const SELF_PATH = fileURLToPath(import.meta.url);
function readPkgVersion(): string {
  try {
    const pkgPath = join(dirname(SELF_PATH), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")).version as string) ?? "unknown";
  } catch { return "unknown"; }
}
const PKG_VERSION = readPkgVersion();

export type ListSurfacesFn = (wsId: string) => Promise<PaneRef[]>;

export function startCockpitd(opts: import("@cockpit/core").CockpitdOpts = {}) {
  const ctx = buildContext(opts);
  const { stateRoot, store, log, spawn, writeResult, inFlightHeadlessIds, activeHeadlessKills } = ctx;

  const { broadcast, schedulePromotion, cancelPromotionsFor } = createAttach(ctx);
  ctx.broadcast = broadcast;
  ctx.schedulePromotion = schedulePromotion;
  ctx.cancelPromotionsFor = cancelPromotionsFor;

  // ── Concrete driver construction ──────────────────────────────────────────
  // Emit callbacks close over ctx lazily: ctx.d, ctx.broadcast, and
  // ctx.schedulePromotion are late-bound by startDaemon before any emit fires.

  const codexDriver = opts.codexDriver ?? new CodexInteractiveDriver({
    emit: (ev) => {
      const found = ctx.store.listAll().find((r) => r.id === ev.id);
      if (!found) return;
      void ctx.d.handle({ kind: "event", project: found.project, event: ev });
      if (ev.type === "task.delta")
        ctx.broadcast(ev.id, { type: "delta", taskId: ev.id, text: ev.chunk } as AttachFrame);
      else if (ev.type === "task.turn.started")
        ctx.broadcast(ev.id, { type: "turn-started", taskId: ev.id } as AttachFrame);
      else if (ev.type === "task.turn.completed")
        ctx.broadcast(ev.id, { type: "turn-completed", taskId: ev.id } as AttachFrame);
      else if (ev.type === "task.input.requested") {
        ctx.broadcast(ev.id, { type: "input-requested", taskId: ev.id, requestId: ev.requestId, question: ev.question } as AttachFrame);
        ctx.schedulePromotion(ev.id, ev.requestId, "input", ev.question);
      } else if (ev.type === "task.approval.requested") {
        ctx.broadcast(ev.id, { type: "approval-requested", taskId: ev.id, requestId: ev.requestId, question: ev.question, kind: ev.kind } as AttachFrame);
        ctx.schedulePromotion(ev.id, ev.requestId, "approval", ev.question);
      } else if (ev.type === "task.reattached")
        ctx.broadcast(ev.id, { type: "reattached", taskId: ev.id } as AttachFrame);
    },
  });

  const opencodeBridge = opts.opencodeBridge ?? new OpencodeSseBridge({
    emit: (ev) => {
      const found = store.listAll().find((r) => r.id === ev.id);
      if (!found) return;
      void ctx.d.handle({ kind: "event", project: found.project, event: ev });
      if (ev.type === "task.approval.requested")
        ctx.schedulePromotion(ev.id, ev.requestId, "approval", ev.question);
    },
    log,
  });

  const cmuxEventsBridge = opts.cmuxEventsBridge ?? new CmuxEventsBridge({
    emit: (ev) => {
      const found = store.listAll().find((r) => r.id === ev.id);
      if (!found) return;
      void ctx.d.handle({ kind: "event", project: found.project, event: ev });
    },
    resolve: (hook) => {
      if (!hook.cwd) return undefined;
      return store.listAll().find(
        (r) => r.mode === "interactive" && !TERMINAL_STATES.has(r.state) && r.cwd === hook.cwd,
      );
    },
    cursorFile: join(stateRoot, "cmux-events.seq"),
    log,
  });

  ctx.codexDriver = codexDriver;
  ctx.opencodeBridge = opencodeBridge;
  ctx.cmuxEventsBridge = cmuxEventsBridge;

  // ── daemonCmux resolution ─────────────────────────────────────────────────
  const daemonDirectCmux = opts.daemonDirectCmux ?? loadConfig().defaults?.daemonDirectCmux ?? false;
  const daemonCmux = opts.daemonCmux
    ?? (daemonDirectCmux ? (opts.makeDaemonCmux ?? (() => new DaemonCmux(createCmuxDriver())))() : undefined);
  ctx.daemonDirectCmux = daemonDirectCmux;
  ctx.daemonCmux = daemonCmux;

  // ── launchHeadless default ────────────────────────────────────────────────
  // Kept here so this file is the sole importer of headless-launcher (daemon/* can't).
  const launchHeadless = opts.launchHeadless ?? (async (rec) => {
    const ingest = (e: import("@cockpit/shared").ControlEvent) =>
      void ctx.d.handle({ kind: "event", project: rec.project, event: e });
    const handle = runHeadless({
      provider: rec.provider, task: rec.task, id: rec.id, sessionId: rec.sessionId,
      cwd: rec.cwd, spawn, emit: ingest, writeResult,
    });
    inFlightHeadlessIds.add(rec.id);
    activeHeadlessKills.add(handle.kill);
    try { await handle.result; } finally {
      inFlightHeadlessIds.delete(rec.id);
      activeHeadlessKills.delete(handle.kill);
    }
  });

  const healRelay = opts.healRelay ?? createRelayHealer(log, (project, config) => {
    const proj = config.projects[project];
    if (!proj) return null;
    return new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, config);
  });

  return startDaemon(ctx, { ...opts, launchHeadless, healRelay }, PKG_VERSION);
}

// Executed by launchd (ProgramArguments → this file's compiled .js).
if (process.argv[1] && process.argv[1].endsWith("cockpitd.js")) {
  const h = startCockpitd({ sweepMs: 30000 });
  process.on("SIGTERM", () => { h.stop(); process.exit(0); });
}
