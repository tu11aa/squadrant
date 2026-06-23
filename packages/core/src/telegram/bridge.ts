// Daemon-internal Telegram subsystem (modeled on CmuxEventsBridge). Owns one
// outbound hook (pushLifecycle) and one inbound getUpdates long-poll. Opt-in and
// crash-contained: no send/poll error may escape into the daemon.
import os from "node:os";
import path from "node:path";
import type { ControlEvent, TelegramConfig } from "@squadrant/shared";
import { resolveNotify, loadProjectOverride, saveProjectOverride } from "@squadrant/shared";
import type { TelegramClient } from "./client.js";
import { isAuthorized, isControlEnabled } from "./auth.js";
import { parseCommand } from "./commands.js";
import type { EnsureResult } from "./ensure-captain.js";
import { formatInbound, formatLifecycle, topicName } from "./format.js";
import { findProjectByThread, loadState, saveState, setNotify, setTopic, topicKey } from "./state.js";
import { tierIncludes } from "./tiers.js";

export interface TelegramBridge {
  start(): void;
  stop(): void;
  /** Outbound, best-effort: a Telegram failure is swallowed (logged), never thrown. */
  pushLifecycle(project: string, ev: ControlEvent): void;
}

export interface TelegramBridgeOptions {
  cfg: TelegramConfig;
  stateRoot: string;
  /** Root for per-project override files. Defaults to ~/.config/squadrant. */
  configRoot?: string;
  client: TelegramClient;
  appendCaptainMessage: (a: { stateRoot: string; project: string; text: string; source: "telegram" }) => Promise<void>;
  log: (msg: string) => void;
  // ── Control surfaces (#402/#403/#321) — all optional. When undefined the bridge
  // keeps exact v1 behavior (queue-only project topics, General topic dropped).
  /** Boot-if-down before delivering to a project topic. Injected by the daemon host. */
  ensureCaptainAlive?: (project: string) => Promise<EnsureResult>;
  /** Execute a curated squadrant CLI argv and return capped output. */
  runCommand?: (argv: string[]) => Promise<string>;
  /** Post a reply to the General topic (threadId undefined) or a project topic. */
  sendReply?: (threadId: number | undefined, text: string) => Promise<void>;
}

// Bot API long-poll window. The loop also sleeps cfg.pollMs between iterations so
// a fast-returning poll can't busy-loop.
const LONG_POLL_SEC = 50;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CREW_TIERS = ["all", "alert_only", "done_only", "none"];

/** Parse a `/notify crew <tier>` or `/notify cap <on|off>` preference command.
 *  Returns null for anything else (ordinary message or malformed). */
export function parseNotifyPref(text: string): { dimension: "crew" | "cap"; value: string } | null {
  const parts = text.trim().split(/\s+/);
  if (parts[0]?.toLowerCase() !== "/notify") return null;
  const dimension = parts[1]?.toLowerCase();
  if ((dimension === "crew" || dimension === "cap") && parts[2]) return { dimension, value: parts[2].toLowerCase() };
  return null;
}

export function createTelegramBridge(opts: TelegramBridgeOptions): TelegramBridge {
  const { cfg, stateRoot, client, appendCaptainMessage, log, ensureCaptainAlive, runCommand, sendReply } = opts;
  const configRoot = opts.configRoot ?? path.join(os.homedir(), ".config", "squadrant");
  const pollMs = cfg.pollMs ?? 1000;
  let running = false;

  function persistOffset(next: number): void {
    const s = loadState(stateRoot);
    s.offset = next;
    saveState(stateRoot, s);
  }

  // Outbound: resolve active (live state wins over config default) + crew-tier
  // filter, then resolve (or lazily create) the project's topic and send.
  async function deliverOutbound(project: string, ev: ControlEvent): Promise<void> {
    const resolved = resolveNotify(cfg.notify, loadProjectOverride(project, configRoot));
    const live = loadState(stateRoot).notify[project]; // boolean | undefined
    const active = live ?? resolved.active;
    if (!active) return;                                // muted → no topic create, no send
    if (!tierIncludes(resolved.crew, ev.type)) return; // tier filter
    let threadId = loadState(stateRoot).topics[topicKey(project)];
    if (threadId === undefined) {
      threadId = await client.createForumTopic(cfg.supergroupId, topicName(project));
      setTopic(stateRoot, project, threadId);
    }
    await client.sendMessage(cfg.supergroupId, threadId, formatLifecycle(project, ev));
  }

  // Reply best-effort: a send failure must never escape into the poll loop.
  async function reply(threadId: number | undefined, text: string): Promise<void> {
    if (!sendReply) return;
    try {
      await sendReply(threadId, text);
    } catch (e) {
      log(`telegram reply failed: ${(e as Error).message}`);
    }
  }

  // General topic (no thread id): curated command channel (#402). Fail-closed —
  // a slash command runs ONLY when remoteControl is on AND the sender is
  // allowlisted. Freeform text gets a /help hint (never silently dropped).
  // Command/reply failures are caught here so they can't escape the poll loop.
  async function handleGeneral(text: string, fromId: number | undefined): Promise<void> {
    if (!text.startsWith("/")) {
      await reply(undefined, "Send /help for commands.");
      return;
    }
    if (!isControlEnabled(cfg) || !isAuthorized(fromId, cfg)) {
      await reply(undefined, "⛔ not authorized");
      return;
    }
    const parsed = parseCommand(text);
    if (parsed.kind !== "ok") {
      await reply(undefined, parsed.message);
      return;
    }
    try {
      const out = runCommand ? await runCommand(parsed.argv) : "(command runner unavailable)";
      await reply(undefined, out);
    } catch (e) {
      await reply(undefined, `⚠️ command failed: ${(e as Error).message}`);
      log(`telegram command failed argv=${JSON.stringify(parsed.argv)}: ${(e as Error).message}`);
    }
  }

  // Recognize the two in-topic notification toggles. Returns the desired active
  // state, or null if the text is an ordinary message.
  function notifyToggle(text: string): boolean | null {
    const first = text.trim().split(/\s+/)[0]?.toLowerCase();
    if (first === "/unmute") return true;
    if (first === "/mute") return false;
    return null;
  }

  // Project topic: the v1 captain.message flow + Gap-1 auto-launch (#403). When
  // control is off OR the sender isn't allowlisted, behaves exactly as v1
  // (append only). The append throws on delivery-infra failure so the caller can
  // decline to advance the offset (at-least-once); auto-launch failures are
  // contained and never block the append.
  async function handleProjectTopic(text: string, threadId: number, fromId: number | undefined): Promise<void> {
    const resolved = findProjectByThread(stateRoot, threadId);
    if (!resolved) return; // no project bound to this topic

    const toggle = notifyToggle(text);
    if (toggle !== null) {
      // Explicit toggle command — fail-closed, never appended as a captain message.
      if (!isControlEnabled(cfg) || !isAuthorized(fromId, cfg)) {
        await reply(threadId, "⛔ not authorized");
        return;
      }
      setNotify(stateRoot, resolved.project, toggle);
      await reply(threadId, toggle ? `🔔 ${resolved.project} notifications ON` : `🔕 ${resolved.project} notifications OFF`);
      return;
    }

    const pref = parseNotifyPref(text);
    if (pref !== null) {
      // Deliberate preference change — fail-closed, writes the per-project config
      // file (not live state), never appended as a captain message.
      if (!isControlEnabled(cfg) || !isAuthorized(fromId, cfg)) {
        await reply(threadId, "⛔ not authorized");
        return;
      }
      if (pref.dimension === "crew") {
        if (!CREW_TIERS.includes(pref.value)) {
          await reply(threadId, "crew must be all|alert_only|done_only|none");
          return;
        }
        saveProjectOverride(resolved.project, { telegram: { notify: { crew: pref.value as never } } }, configRoot);
      } else {
        if (pref.value !== "on" && pref.value !== "off") {
          await reply(threadId, "cap must be on|off");
          return;
        }
        saveProjectOverride(resolved.project, { telegram: { notify: { cap: pref.value === "on" } } }, configRoot);
      }
      await reply(threadId, `✅ ${pref.dimension} = ${pref.value}`);
      return;
    }

    setNotify(stateRoot, resolved.project, true); // engagement → auto-unmute (sticky)
    if (ensureCaptainAlive && isControlEnabled(cfg) && isAuthorized(fromId, cfg)) {
      try {
        const r = await ensureCaptainAlive(resolved.project);
        if (r === "timeout") await reply(threadId, "⚠️ captain didn't warm up; message queued.");
      } catch (e) {
        log(`telegram auto-launch failed project=${resolved.project}: ${(e as Error).message}`);
      }
    }
    await appendCaptainMessage({ stateRoot, project: resolved.project, text: formatInbound(text), source: "telegram" });
  }

  // Inbound: classify by thread id. General topic → command channel; project
  // topic → captain.message (+ auto-launch). Throws only on append failure.
  async function handleUpdate(u: { message?: { chat: { id: number }; message_thread_id?: number; text?: string; from?: { id: number } } }): Promise<void> {
    const m = u.message;
    if (!m || m.text === undefined) return;
    if (!cfg.chats.includes(m.chat.id)) return; // not an allowlisted chat (coarse filter)
    if (m.message_thread_id === undefined) {
      await handleGeneral(m.text, m.from?.id);
      return;
    }
    await handleProjectTopic(m.text, m.message_thread_id, m.from?.id);
  }

  async function pollLoop(): Promise<void> {
    while (running) {
      try {
        const offset = loadState(stateRoot).offset;
        const updates = await client.getUpdates(offset, LONG_POLL_SEC);
        for (const u of updates) {
          await handleUpdate(u);
          persistOffset(u.update_id + 1);
        }
      } catch (e) {
        log(`telegram inbound poll failed: ${(e as Error).message}`);
      }
      if (running) await sleep(pollMs);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      void pollLoop();
    },
    stop() {
      running = false;
    },
    pushLifecycle(project, ev) {
      // Fire-and-forget; all errors swallowed so outbound can never throw into
      // the daemon's notify path.
      void deliverOutbound(project, ev).catch((e) => {
        log(`telegram outbound failed project=${project}: ${(e as Error).message}`);
      });
    },
  };
}
