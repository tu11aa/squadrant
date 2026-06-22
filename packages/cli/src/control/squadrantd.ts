// src/control/squadrantd.ts — host: constructs concrete drivers + thin shim.
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
import type { TelegramBridge } from "@squadrant/core";
import type { TelegramConfig } from "@squadrant/shared";
import { createRunCommand, createIsCaptainAlive, createLaunch } from "./telegram-control.js";
export type { SquadrantdOpts } from "@squadrant/core";
export { defaultIsPidAlive } from "@squadrant/core";
export { discoverCaptainSurface } from "@squadrant/core";
import type { AttachFrame } from "@squadrant/core";
import type { PaneRef } from "@squadrant/shared";
import { runHeadless, CodexInteractiveDriver, OpencodeSseBridge } from "@squadrant/agents";
import { CmuxEventsBridge, DaemonCmux } from "@squadrant/workspaces";
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
  const sendReply = (threadId: number | undefined, text: string) =>
    client.sendMessage(cfg.supergroupId, threadId, text);
  return createTelegramBridge({
    cfg, stateRoot, client, appendCaptainMessage, log,
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

  return startDaemon(ctx, { ...opts, launchHeadless }, PKG_VERSION);
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
