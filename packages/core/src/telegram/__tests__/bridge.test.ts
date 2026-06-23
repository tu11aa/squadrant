import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TelegramConfig, ControlEvent } from "@squadrant/shared";
import { createTelegramBridge, type TelegramBridge } from "../bridge.js";
import type { TelegramClient } from "../client.js";
import { loadState, setTopic, setNotify, isNotifyActive } from "../state.js";

const cfg: TelegramConfig = { botToken: "T", supergroupId: -100500, chats: [-100111], pollMs: 1 };

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sq-tg-bridge-"));
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 2));
  }
}

let active: TelegramBridge | null = null;
afterEach(() => {
  active?.stop();
  active = null;
});

const doneEv: ControlEvent = { type: "task.done", id: "x", resultRef: "/r" };

describe("pushLifecycle (outbound)", () => {
  it("sends the formatted lifecycle text to the project's existing topic", async () => {
    const root = freshRoot();
    setTopic(root, "demo", 55);
    setNotify(root, "demo", true);
    const sent = deferred();
    const sendCalls: Array<[number, number | undefined, string]> = [];
    const client: TelegramClient = {
      getUpdates: async () => [],
      createForumTopic: async () => 1,
      sendMessage: async (c, th, text) => { sendCalls.push([c, th, text]); sent.resolve(); },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({ cfg, stateRoot: root, client, appendCaptainMessage: async () => {}, log: () => {} });
    active = bridge;

    bridge.pushLifecycle("demo", doneEv);
    await sent.promise;

    expect(sendCalls).toEqual([[-100500, 55, "✅ [demo] CREW DONE · x"]]);
  });

  it("creates and persists the topic on first use, then sends to it", async () => {
    const root = freshRoot();
    setNotify(root, "demo", true);
    const sent = deferred();
    const createCalls: Array<[number, string]> = [];
    const sendCalls: Array<[number, number | undefined, string]> = [];
    const client: TelegramClient = {
      getUpdates: async () => [],
      createForumTopic: async (c, n) => { createCalls.push([c, n]); return 77; },
      sendMessage: async (c, th, text) => { sendCalls.push([c, th, text]); sent.resolve(); },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({ cfg, stateRoot: root, client, appendCaptainMessage: async () => {}, log: () => {} });
    active = bridge;

    bridge.pushLifecycle("demo", doneEv);
    await sent.promise;

    expect(createCalls).toEqual([[-100500, "demo"]]);
    expect(loadState(root).topics).toEqual({ "demo::project": 77 });
    expect(sendCalls).toEqual([[-100500, 77, "✅ [demo] CREW DONE · x"]]);
  });

  it("swallows a rejecting sendMessage (crash-contained, logged, never throws)", async () => {
    const root = freshRoot();
    setTopic(root, "demo", 55);
    setNotify(root, "demo", true);
    const logged = deferred();
    const logs: string[] = [];
    const client: TelegramClient = {
      getUpdates: async () => [],
      createForumTopic: async () => 1,
      sendMessage: async () => { throw new Error("network down"); },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({
      cfg, stateRoot: root, client,
      appendCaptainMessage: async () => {},
      log: (m) => { logs.push(m); logged.resolve(); },
    });
    active = bridge;

    expect(() => bridge.pushLifecycle("demo", doneEv)).not.toThrow();
    await logged.promise;
    expect(logs.some((m) => m.includes("network down"))).toBe(true);
  });
});

describe("pushLifecycle notify gate", () => {
  it("drops the event when the project is MUTED (no client calls)", async () => {
    const root = freshRoot();
    const sendMessage = vi.fn();
    const createForumTopic = vi.fn();
    const client: TelegramClient = {
      getUpdates: async () => [],
      createForumTopic,
      sendMessage,
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({ cfg, stateRoot: root, client, appendCaptainMessage: async () => {}, log: () => {} });
    active = bridge;

    bridge.pushLifecycle("squadrant", doneEv);
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(createForumTopic).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("delivers when the project is ACTIVE", async () => {
    const root = freshRoot();
    setNotify(root, "squadrant", true);
    const sent = deferred();
    const client: TelegramClient = {
      getUpdates: async () => [],
      createForumTopic: async () => 7,
      sendMessage: async () => { sent.resolve(); },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    // Isolate from the real ~/.config/squadrant override (else a live crew="none"
    // tier filters out task.done and this never sends). The temp root has no
    // override → DEFAULT_NOTIFY (crew=alert_only) includes task.done.
    const bridge = createTelegramBridge({ cfg, stateRoot: root, configRoot: root, client, appendCaptainMessage: async () => {}, log: () => {} });
    active = bridge;

    bridge.pushLifecycle("squadrant", doneEv);
    await sent.promise;
  });
});

describe("auto-unmute + in-topic /mute /unmute", () => {
  const USER_ID = 42;
  const cfgWithControl: TelegramConfig = {
    botToken: "T", supergroupId: -100500, chats: [-100111], pollMs: 1,
    remoteControl: true, users: [USER_ID],
  } as any; // TelegramConfig already has these fields; `as any` bypasses stale dist types

  it("auto-unmutes a project when a normal message lands in its topic", async () => {
    const root = freshRoot();
    setTopic(root, "demo", 100);
    const appendCalls: unknown[] = [];
    let n = 0;
    const client: TelegramClient = {
      sendMessage: async () => {},
      createForumTopic: async () => 1,
      getUpdates: async () => {
        n++;
        if (n === 1) return [{ update_id: 10, message: { chat: { id: -100111 }, message_thread_id: 100, text: "hello", from: { id: USER_ID } } } as never];
        return [];
      },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({
      cfg, stateRoot: root, client,
      appendCaptainMessage: async (a) => { appendCalls.push(a); },
      log: () => {},
    });
    active = bridge;
    bridge.start();
    await waitFor(() => loadState(root).offset === 11);
    expect(isNotifyActive(root, "demo")).toBe(true);
    expect(appendCalls).toHaveLength(1);
  });

  it("auto-unmute works even when remoteControl is OFF", async () => {
    const root = freshRoot();
    setTopic(root, "demo", 100);
    const appendCalls: unknown[] = [];
    let n = 0;
    const client: TelegramClient = {
      sendMessage: async () => {},
      createForumTopic: async () => 1,
      getUpdates: async () => {
        n++;
        if (n === 1) return [{ update_id: 10, message: { chat: { id: -100111 }, message_thread_id: 100, text: "hi", from: { id: USER_ID } } } as never];
        return [];
      },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({
      cfg, stateRoot: root, client, // remoteControl=false (default cfg)
      appendCaptainMessage: async (a) => { appendCalls.push(a); },
      log: () => {},
    });
    active = bridge;
    bridge.start();
    await waitFor(() => loadState(root).offset === 11);
    expect(isNotifyActive(root, "demo")).toBe(true);
    expect(appendCalls).toHaveLength(1);
  });

  it("/unmute in topic toggles ON and does NOT append a captain message (authorized)", async () => {
    const root = freshRoot();
    setTopic(root, "demo", 100);
    setNotify(root, "demo", false);
    const appendCalls: unknown[] = [];
    const replyCalls: Array<[number | undefined, string]> = [];
    let n = 0;
    const client: TelegramClient = {
      sendMessage: async () => {},
      createForumTopic: async () => 1,
      getUpdates: async () => {
        n++;
        if (n === 1) return [{ update_id: 10, message: { chat: { id: -100111 }, message_thread_id: 100, text: "/unmute", from: { id: USER_ID } } } as never];
        return [];
      },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({
      cfg: cfgWithControl, stateRoot: root, client,
      appendCaptainMessage: async (a) => { appendCalls.push(a); },
      log: () => {},
      sendReply: async (threadId, text) => { replyCalls.push([threadId, text]); },
    });
    active = bridge;
    bridge.start();
    await waitFor(() => loadState(root).offset === 11);
    expect(isNotifyActive(root, "demo")).toBe(true);
    expect(appendCalls).toHaveLength(0);
    expect(replyCalls.some(([, t]) => t.includes("ON"))).toBe(true);
  });

  it("/mute in topic is rejected when remoteControl is OFF (notify unchanged)", async () => {
    const root = freshRoot();
    setTopic(root, "demo", 100);
    setNotify(root, "demo", true);
    const appendCalls: unknown[] = [];
    const replyCalls: Array<[number | undefined, string]> = [];
    let n = 0;
    const client: TelegramClient = {
      sendMessage: async () => {},
      createForumTopic: async () => 1,
      getUpdates: async () => {
        n++;
        if (n === 1) return [{ update_id: 10, message: { chat: { id: -100111 }, message_thread_id: 100, text: "/mute", from: { id: USER_ID } } } as never];
        return [];
      },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({
      cfg, stateRoot: root, client, // remoteControl=false
      appendCaptainMessage: async (a) => { appendCalls.push(a); },
      log: () => {},
      sendReply: async (threadId, text) => { replyCalls.push([threadId, text]); },
    });
    active = bridge;
    bridge.start();
    await waitFor(() => loadState(root).offset === 11);
    expect(isNotifyActive(root, "demo")).toBe(true); // unchanged
    expect(appendCalls).toHaveLength(0);
    expect(replyCalls.some(([, t]) => t.includes("not authorized"))).toBe(true);
  });
});

describe("inbound poll", () => {
  it("appends a captain.message for an allowlisted chat on a known thread", async () => {
    const root = freshRoot();
    setTopic(root, "demo", 100);
    const appended = deferred();
    const appendCalls: Array<{ project: string; text: string; source: string }> = [];
    let n = 0;
    const client: TelegramClient = {
      sendMessage: async () => {},
      createForumTopic: async () => 1,
      getUpdates: async () => {
        n++;
        if (n === 1) return [{ update_id: 10, message: { chat: { id: -100111 }, message_thread_id: 100, text: "hello" } } as never];
        return [];
      },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({
      cfg, stateRoot: root, client,
      appendCaptainMessage: async (a) => { appendCalls.push(a); appended.resolve(); },
      log: () => {},
    });
    active = bridge;

    bridge.start();
    await appended.promise;

    expect(appendCalls).toEqual([{ stateRoot: root, project: "demo", text: "📩 [from Telegram] hello", source: "telegram" }]);
    await waitFor(() => loadState(root).offset === 11);
  });

  it("drops a non-allowlisted chat (no append) but still advances the offset", async () => {
    const root = freshRoot();
    setTopic(root, "demo", 100);
    const appendCalls: unknown[] = [];
    let n = 0;
    const client: TelegramClient = {
      sendMessage: async () => {},
      createForumTopic: async () => 1,
      getUpdates: async () => {
        n++;
        if (n === 1) return [{ update_id: 10, message: { chat: { id: -999999 }, message_thread_id: 100, text: "hi" } } as never];
        return [];
      },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({
      cfg, stateRoot: root, client,
      appendCaptainMessage: async (a) => { appendCalls.push(a); },
      log: () => {},
    });
    active = bridge;

    bridge.start();
    await waitFor(() => n >= 2);
    await waitFor(() => loadState(root).offset === 11);
    expect(appendCalls).toHaveLength(0);
  });

  it("a throwing getUpdates does not escape start() — the loop catches and continues", async () => {
    const root = freshRoot();
    const second = deferred();
    const logs: string[] = [];
    let n = 0;
    const client: TelegramClient = {
      sendMessage: async () => {},
      createForumTopic: async () => 1,
      getUpdates: async () => {
        n++;
        if (n === 1) throw new Error("boom");
        if (n === 2) second.resolve();
        return [];
      },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({
      cfg, stateRoot: root, client,
      appendCaptainMessage: async () => {},
      log: (m) => { logs.push(m); },
    });
    active = bridge;

    expect(() => bridge.start()).not.toThrow();
    await second.promise;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => m.includes("boom"))).toBe(true);
  });
});

describe("lastUserId passive capture", () => {
  it("records m.from.id to state on an allowlisted inbound message", async () => {
    const root = freshRoot();
    setTopic(root, "demo", 100);
    let n = 0;
    const client: TelegramClient = {
      sendMessage: async () => {},
      createForumTopic: async () => 1,
      getUpdates: async () => {
        n++;
        if (n === 1) return [{ update_id: 10, message: { chat: { id: -100111 }, message_thread_id: 100, text: "hello", from: { id: 777 } } } as never];
        return [];
      },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({ cfg, stateRoot: root, client, appendCaptainMessage: async () => {}, log: () => {} });
    active = bridge;
    bridge.start();
    await waitFor(() => loadState(root).offset === 11);
    expect(loadState(root).lastUserId).toBe(777);
  });

  it("does not record from.id for a non-allowlisted chat", async () => {
    const root = freshRoot();
    let n = 0;
    const client: TelegramClient = {
      sendMessage: async () => {},
      createForumTopic: async () => 1,
      getUpdates: async () => {
        n++;
        if (n === 1) return [{ update_id: 10, message: { chat: { id: -999999 }, message_thread_id: 100, text: "hi", from: { id: 888 } } } as never];
        return [];
      },
      getMe: async () => ({ id: 0, username: "" }),
      setMyCommands: async () => {},
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    };
    const bridge = createTelegramBridge({ cfg, stateRoot: root, client, appendCaptainMessage: async () => {}, log: () => {} });
    active = bridge;
    bridge.start();
    await waitFor(() => n >= 2);
    expect(loadState(root).lastUserId).toBeUndefined();
  });
});
