// Daemon-internal Telegram subsystem (modeled on CmuxEventsBridge). Owns one
// outbound hook (pushLifecycle) and one inbound getUpdates long-poll. Opt-in and
// crash-contained: no send/poll error may escape into the daemon.
import type { ControlEvent, TelegramConfig } from "@squadrant/shared";
import type { TelegramClient } from "./client.js";
import { formatInbound, formatLifecycle, topicName } from "./format.js";
import { findProjectByThread, loadState, saveState, setTopic, topicKey } from "./state.js";

export interface TelegramBridge {
  start(): void;
  stop(): void;
  /** Outbound, best-effort: a Telegram failure is swallowed (logged), never thrown. */
  pushLifecycle(project: string, ev: ControlEvent): void;
}

export interface TelegramBridgeOptions {
  cfg: TelegramConfig;
  stateRoot: string;
  client: TelegramClient;
  appendCaptainMessage: (a: { stateRoot: string; project: string; text: string; source: "telegram" }) => Promise<void>;
  log: (msg: string) => void;
}

// Bot API long-poll window. The loop also sleeps cfg.pollMs between iterations so
// a fast-returning poll can't busy-loop.
const LONG_POLL_SEC = 50;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createTelegramBridge(opts: TelegramBridgeOptions): TelegramBridge {
  const { cfg, stateRoot, client, appendCaptainMessage, log } = opts;
  const pollMs = cfg.pollMs ?? 1000;
  let running = false;

  function persistOffset(next: number): void {
    const s = loadState(stateRoot);
    s.offset = next;
    saveState(stateRoot, s);
  }

  // Outbound: resolve (or lazily create) the project's topic, then send.
  async function deliverOutbound(project: string, ev: ControlEvent): Promise<void> {
    let threadId = loadState(stateRoot).topics[topicKey(project)];
    if (threadId === undefined) {
      threadId = await client.createForumTopic(cfg.supergroupId, topicName(project));
      setTopic(stateRoot, project, threadId);
    }
    await client.sendMessage(cfg.supergroupId, threadId, formatLifecycle(project, ev));
  }

  // Inbound: one update → at most one captain.message. Returns nothing; throws only
  // on an append (delivery-infra) failure so the caller can decline to advance the
  // offset (at-least-once). Allowlist/resolution misses are silent drops.
  async function handleUpdate(u: { message?: { chat: { id: number }; message_thread_id?: number; text?: string } }): Promise<void> {
    const m = u.message;
    if (!m || m.text === undefined || m.message_thread_id === undefined) return;
    if (!cfg.chats.includes(m.chat.id)) return; // not an allowlisted chat
    const resolved = findProjectByThread(stateRoot, m.message_thread_id);
    if (!resolved) return; // no project bound to this topic
    await appendCaptainMessage({ stateRoot, project: resolved.project, text: formatInbound(m.text), source: "telegram" });
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
