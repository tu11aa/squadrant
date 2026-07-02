// src/squadrantd.ts — host: constructs concrete drivers + thin shim.
// All daemon logic lives in daemon/start.ts; this file owns only the
// concrete class instantiation and the launchd entry guard.
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { buildContext } from "@squadrant/core";
import { createAttach } from "@squadrant/core";
import { startDaemon } from "@squadrant/core";
import { isDaemonSocketLive } from "@squadrant/core";
import { appendCaptainMessage, createTelegramClient, createTelegramBridge, createEnsureCaptainAlive } from "@squadrant/core";
import { reduceLifecycle } from "@squadrant/core";
import type { TelegramBridge } from "@squadrant/core";
import type { LifecycleSnapshot, LifecycleSourceDeps } from "@squadrant/core";
import type { TelegramConfig } from "@squadrant/shared";
import { createRunCommand, createIsCaptainAlive, createLaunch } from "@squadrant/core";
import { buildCompletionProtocol } from "@squadrant/core";
export type { SquadrantdOpts } from "@squadrant/core";
export { defaultIsPidAlive } from "@squadrant/core";
export { discoverCaptainSurface } from "@squadrant/core";
import type { AttachFrame } from "@squadrant/core";
import type { PaneRef } from "@squadrant/shared";
import { runHeadless, CodexInteractiveDriver, OpencodeSseBridge, CodexAppServerSource } from "@squadrant/agents";
import { CmuxEventsBridge, DaemonCmux, CmuxStoreSource, NativeHookSource, resendCrewFirstTurn } from "@squadrant/workspaces";
import { loadConfig, TERMINAL_STATES } from "@squadrant/shared";
import { createCmuxDriver } from "@squadrant/workspaces";

const SELF_PATH = fileURLToPath(import.meta.url);
// Bundled CLI bin sits next to this daemon entry (dist/index.js · dist/squadrantd.js).
// Dist-relative + invariant to source moves (see learning #363). Run via
// `process.execPath <CLI_BIN> ...argv` so we don't depend on PATH (launchd's is minimal).
const CLI_BIN = join(dirname(SELF_PATH), "index.js");
const DAEMON_SOCK = join(homedir(), ".config", "squadrant", "squadrant.sock");
function readPkgVersion(): string {
  try {
    const pkgPath = join(dirname(SELF_PATH), "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")).version as string) ?? "unknown";
  } catch { return "unknown"; }
}
const PKG_VERSION = readPkgVersion();

export type ListSurfacesFn = (wsId: string) => Promise<PaneRef[]>;

/** Construct the real Telegram bridge over a fetch-based client. Token comes from
 *  config or the TELEGRAM_BOT_TOKEN env var; with neither, the bridge is disabled. */
function buildTelegramBridge(
  cfg: TelegramConfig,
  stateRoot: string,
  log: (m: string) => void,
): TelegramBridge | undefined {
  const token = cfg.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log("telegram: config present but no botToken / TELEGRAM_BOT_TOKEN set — bridge disabled");
    return undefined;
  }
  const client = createTelegramClient({ token });
  // Control surfaces (#402/#403). These act only when remoteControl is on AND the
  // sender is allowlisted (gated inside the bridge); passing them is always safe.
  const ensureCaptainAlive = createEnsureCaptainAlive({
    isAlive: createIsCaptainAlive(DAEMON_SOCK),
    launch: createLaunch(CLI_BIN),
  });
  const runCommand = createRunCommand(CLI_BIN);
  const sendReply = (threadId: number | undefined, text: string, replyMarkup?: unknown) =>
    client.sendMessage(cfg.supergroupId, threadId, text, replyMarkup);
  return createTelegramBridge({
    cfg, stateRoot, configRoot: dirname(stateRoot), client, appendCaptainMessage, log,
    ensureCaptainAlive, runCommand, sendReply,
  });
}

export function startSquadrantd(opts: import("@squadrant/core").SquadrantdOpts = {}) {
  const ctx = buildContext(opts);
  const { stateRoot, store, log, spawn, writeResult, inFlightHeadlessIds, activeHeadlessKills } = ctx;

  const { broadcast, schedulePromotion, cancelPromotionsFor } = createAttach(ctx);
  ctx.broadcast = broadcast;
  ctx.schedulePromotion = schedulePromotion;
  ctx.cancelPromotionsFor = cancelPromotionsFor;

  // ── Concrete driver construction ──────────────────────────────────────────
  // Emit callbacks close over ctx lazily: ctx.d, ctx.broadcast, and
  // ctx.schedulePromotion are late-bound by startDaemon before any emit fires.

  // D5: codex app-server LifecycleSource — must be created before codexDriver
  // so the emit closure can call observe(). start() is called in the VITEST-
  // guarded block below after startDaemon() sets ctx.d.
  const codexAppServerSource = new CodexAppServerSource();

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
      codexAppServerSource.observe(ev);
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

  const cmuxStoreSource = new CmuxStoreSource({ log });
  const nativeHookSource = new NativeHookSource({ log });

  ctx.codexDriver = codexDriver;
  ctx.opencodeBridge = opencodeBridge;
  ctx.cmuxEventsBridge = cmuxEventsBridge;
  // B4: register for per-source health aggregation in the snapshot. Registering
  // is inert (no I/O) — only start() below (VITEST-guarded) actually runs a
  // source, so health() correctly reports inactive until then.
  ctx.lifecycleSources = [cmuxStoreSource, nativeHookSource, codexAppServerSource];

  // ── Telegram bridge (opt-in #65) ──────────────────────────────────────────
  // Built only when config.telegram is present. Skipped under vitest because the
  // bridge's pushLifecycle is composed onto notify and would hit the network;
  // tests inject opts.telegramBridge instead.
  const tgCfg = loadConfig().telegram;
  ctx.telegramBridge = opts.telegramBridge
    ?? (tgCfg && !process.env.VITEST ? buildTelegramBridge(tgCfg, stateRoot, log) : undefined);

  // ── daemonCmux resolution ─────────────────────────────────────────────────
  ctx.daemonCmux = opts.daemonCmux
    ?? (opts.makeDaemonCmux ?? (() => new DaemonCmux(createCmuxDriver())))();

  // ── #466 self-heal: first-turn resend wiring ──────────────────────────────
  // Uses a fresh cmux RuntimeDriver (independent of daemonCmux's narrower
  // DaemonSurfaceDriver seam, which lacks the paste/sendKey primitives) to
  // drive the same paste-settle-Enter delivery path a manual `crew send` uses.
  // Scoped to claude crews — the facet #466's frozen frame confirmed; other
  // providers safely report non-delivery (the daemon's sweep loop still alerts
  // via CREW UNDELIVERED rather than silently retrying forever).
  const resendRuntime = createCmuxDriver();
  ctx.resendFirstTurn = opts.resendFirstTurn ?? (async (rec) => {
    if (rec.provider !== "claude" || !rec.name) return { delivered: false };
    const proj = loadConfig().projects[rec.project];
    const captainName = proj?.captainName ?? `${rec.project}-captain`;
    const message = `${rec.task}\n\n${buildCompletionProtocol(rec.id, rec.project)}`;
    return resendCrewFirstTurn(resendRuntime, captainName, rec.project, rec.name, message);
  });

  // ── launchHeadless default ────────────────────────────────────────────────
  // Kept here so this file is the sole importer of headless-launcher (daemon/* can't).
  const launchHeadless = opts.launchHeadless ?? (async (rec) => {
    const ingest = (e: import("@squadrant/shared").ControlEvent) =>
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

  const h = startDaemon(ctx, { ...opts, launchHeadless }, PKG_VERSION);

  // A1: start cmux store-file backup lifecycle source alongside CmuxEventsBridge (B1).
  // startDaemon() guarantees ctx.d is set before returning. Skipped under vitest
  // (mirrors the B1 guard in start.ts — real fs.watch would touch disk in tests).
  if (!process.env.VITEST) {
    const prevSnaps = new Map<string, LifecycleSnapshot>();
    const storeDeps: LifecycleSourceDeps = {
      resolve: (hint) => {
        if (!hint.cwd && hint.pid == null) return undefined;
        return store.listAll().find(
          (r) => r.mode === "interactive" && !TERMINAL_STATES.has(r.state) &&
            (r.cwd === hint.cwd || (hint.pid != null && r.pid === hint.pid)),
        );
      },
      report: (snap) => {
        const found = store.listAll().find((r) => r.id === snap.taskId);
        if (!found) return;
        const prev = prevSnaps.get(snap.taskId);
        const newState = reduceLifecycle(prev, snap);
        const changed = !prev || newState !== prev.state;
        prevSnaps.set(snap.taskId, snap);
        if (!snap.alive) {
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.session.ended", id: snap.taskId } });
          return;
        }
        if (!changed) return;
        if (newState === "idle") {
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.turn.completed", id: snap.taskId, turnId: "cmux-store" } });
        } else if (newState === "running") {
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.progress", id: snap.taskId } });
        } else if (newState === "needsInput") {
          const question = snap.detail?.note ?? snap.detail?.reason ?? "crew awaiting input";
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.blocked", id: snap.taskId, reason: "needsInput", question } });
        }
      },
      log,
    };
    try { cmuxStoreSource.start(storeDeps); }
    catch (e) { log(`cmux store source start failed: ${(e as Error).message}`); }

    // C1: start native hook source (primary LifecycleSource C). Installs squadrant-
    // owned hooks into ~/.claude/settings.json (idempotent, namespaced per D4).
    try { nativeHookSource.install(); }
    catch (e) { log(`native hook install failed: ${(e as Error).message}`); }
    const hookPrevSnaps = new Map<string, LifecycleSnapshot>();
    const hookDeps: LifecycleSourceDeps = {
      resolve: (hint) => {
        if (!hint.cwd && hint.pid == null) return undefined;
        return store.listAll().find(
          (r) => r.mode === "interactive" && !TERMINAL_STATES.has(r.state) &&
            (r.cwd === hint.cwd || (hint.pid != null && r.pid === hint.pid)),
        );
      },
      report: (snap) => {
        const found = store.listAll().find((r) => r.id === snap.taskId);
        if (!found) return;
        const prev = hookPrevSnaps.get(snap.taskId);
        const newState = reduceLifecycle(prev, snap);
        const changed = !prev || newState !== prev.state;
        hookPrevSnaps.set(snap.taskId, snap);
        if (!snap.alive) {
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.session.ended", id: snap.taskId } });
          return;
        }
        if (!changed) return;
        if (newState === "idle") {
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.turn.completed", id: snap.taskId, turnId: "native-hook" } });
        } else if (newState === "running") {
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.progress", id: snap.taskId } });
        } else if (newState === "needsInput") {
          const question = snap.detail?.note ?? snap.detail?.reason ?? "crew awaiting input";
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.blocked", id: snap.taskId, reason: "needsInput", question } });
        }
      },
      log,
    };
    try { nativeHookSource.start(hookDeps); }
    catch (e) { log(`native hook source start failed: ${(e as Error).message}`); }

    // D5: start codex app-server lifecycle source. codexAppServerSource.observe()
    // is already wired into the codexDriver emit above; start() connects the deps.
    const codexPrevSnaps = new Map<string, LifecycleSnapshot>();
    const codexSourceDeps: LifecycleSourceDeps = {
      resolve: () => undefined,  // taskId comes from ControlEvent.id; resolve() unused
      report: (snap) => {
        const found = store.listAll().find((r) => r.id === snap.taskId);
        if (!found) return;
        const prev = codexPrevSnaps.get(snap.taskId);
        const newState = reduceLifecycle(prev, snap);
        const changed = !prev || newState !== prev.state;
        codexPrevSnaps.set(snap.taskId, snap);
        if (!snap.alive) {
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.session.ended", id: snap.taskId } });
          return;
        }
        if (!changed) return;
        if (newState === "idle") {
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.turn.completed", id: snap.taskId, turnId: "codex-appserver" } });
        } else if (newState === "running") {
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.progress", id: snap.taskId } });
        } else if (newState === "needsInput") {
          const question = snap.detail?.note ?? snap.detail?.reason ?? "crew awaiting input";
          void ctx.d.handle({ kind: "event", project: found.project, event: { type: "task.blocked", id: snap.taskId, reason: "needsInput", question } });
        }
      },
      log,
    };
    try { codexAppServerSource.start(codexSourceDeps); }
    catch (e) { log(`codex app-server source start failed: ${(e as Error).message}`); }
  }

  const origStop = h.stop.bind(h);
  h.stop = async () => {
    try { cmuxStoreSource.stop(); } catch { /* best-effort */ }
    try { nativeHookSource.stop(); } catch { /* best-effort */ }
    try { codexAppServerSource.stop(); } catch { /* best-effort */ }
    return origStop();
  };

  return h;
}

// Executed by launchd (ProgramArguments → this file's compiled .js).
if (process.argv[1] && process.argv[1].endsWith("squadrantd.js")) {
  void (async () => {
    // #360 layer 1: this entry takes no CLI flags. A build smoke-test like
    // `node dist/squadrantd.js --help` must NOT boot a daemon — it would hang
    // and steal the shared socket. Print a one-liner and exit.
    const arg = process.argv[2];
    if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v") {
      process.stdout.write("squadrantd: launchd-managed daemon entry (no CLI args). Use `squadrant` for commands.\n");
      process.exit(0);
    }
    // #360 layer 2: refuse to start if a live daemon already owns the socket.
    // startServer does unlink-then-bind; without this guard a second invocation
    // unlinks the live socket, orphaning the running daemon on its now-anonymous
    // inode so every new connect() to the path is refused.
    const sock = join(homedir(), ".config", "squadrant", "squadrant.sock");
    if (await isDaemonSocketLive(sock)) {
      process.stderr.write(`[squadrantd] refusing to start: a live daemon already owns ${sock}\n`);
      process.exit(0);
    }
    const h = startSquadrantd({ sweepMs: 30000 });
    process.on("SIGTERM", () => { h.stop(); process.exit(0); });
  })();
}
