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
    };
    const bridge = createTelegramBridge({ cfg, stateRoot: root, client, appendCaptainMessage: async () => {}, log: () => {} });
    active = bridge;

    bridge.pushLifecycle("squadrant", doneEv);
    await sent.promise;
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
