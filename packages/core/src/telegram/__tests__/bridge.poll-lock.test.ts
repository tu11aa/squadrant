import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { TelegramConfig } from "@squadrant/shared";
import type { Update } from "@grammyjs/types";
import { createTelegramBridge, telegramPollLockPath, type TelegramBridge, type TelegramBridgeOptions } from "../bridge.js";
import { TelegramApiError, type TelegramClient } from "../client.js";

const CHAT = -100;

let stateRoot: string;
const bridges: TelegramBridge[] = [];
beforeEach(() => { stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tg-lock-")); });
afterEach(() => {
  for (const b of bridges.splice(0)) b.stop();
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

/** A fresh bot token per test so lock files can never collide across tests. */
const freshToken = () => "tok-" + crypto.randomUUID();

function cfgFor(token: string): TelegramConfig {
  return { botToken: token, supergroupId: CHAT, chats: [CHAT], pollMs: 1 };
}

function opts(token: string, client: TelegramClient, over: Partial<TelegramBridgeOptions> = {}): TelegramBridgeOptions {
  return { cfg: cfgFor(token), stateRoot, client, appendCaptainMessage: vi.fn(async () => {}), log: vi.fn(), ...over };
}

/** A client whose getUpdates parks forever (like a real 50s long-poll) and
 *  records the AbortSignal it was handed. */
function parkedClient() {
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const getUpdates = vi.fn((_offset: number, _timeout?: number, s?: AbortSignal) => {
    signal = s;
    started();
    return new Promise<Update[]>(() => {});
  });
  const client: TelegramClient = {
    getUpdates,
    sendMessage: vi.fn(async () => {}),
    createForumTopic: vi.fn(async () => 1),
    getMe: vi.fn(async () => ({ id: 1, username: "bot" })),
    setMyCommands: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageReplyMarkup: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {}),
  };
  return { client, getUpdates, startedP, signal: () => signal };
}

const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));
const start = (b: TelegramBridge) => { bridges.push(b); b.start(); };

describe("single-consumer poll lock (#830)", () => {
  it("a second bridge on the same token refuses to poll; the first holds the lock", async () => {
    const token = freshToken();
    const a = parkedClient();
    const b1 = createTelegramBridge(opts(token, a.client));
    start(b1);
    await a.startedP;
    expect(fs.existsSync(telegramPollLockPath(token))).toBe(true);

    const b2 = parkedClient();
    const log2 = vi.fn();
    start(createTelegramBridge(opts(token, b2.client, { log: log2 })));
    await tick();

    expect(b2.getUpdates).not.toHaveBeenCalled();
    expect(bridges[1].health().polling).toBe(false);
    expect(log2).toHaveBeenCalledTimes(1);
    expect(String(log2.mock.calls[0][0])).toMatch(/single-consumer|already/i);

    b1.stop();
    expect(fs.existsSync(telegramPollLockPath(token))).toBe(false);
  });

  it("reclaims a stale lock whose owner pid is gone (old mtime, no pid)", async () => {
    const token = freshToken();
    const file = telegramPollLockPath(token);
    fs.writeFileSync(file, "");
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, old, old);

    const c = parkedClient();
    start(createTelegramBridge(opts(token, c.client)));
    await vi.waitFor(() => expect(c.getUpdates).toHaveBeenCalled());
  });

  it("respects a lock held by a live pid even when its mtime is old", async () => {
    const token = freshToken();
    const file = telegramPollLockPath(token);
    fs.writeFileSync(file, String(process.pid));
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, old, old);

    const c = parkedClient();
    start(createTelegramBridge(opts(token, c.client)));
    await tick();
    expect(c.getUpdates).not.toHaveBeenCalled();
  });
});

describe("abortable long-poll (#830)", () => {
  it("stop() aborts an in-flight getUpdates and does not log it as a poll failure", async () => {
    const token = freshToken();
    const c = parkedClient();
    const log = vi.fn();
    const bridge = createTelegramBridge(opts(token, c.client, { log }));
    start(bridge);
    await c.startedP;

    expect(c.signal()?.aborted).toBe(false);
    bridge.stop();
    expect(c.signal()?.aborted).toBe(true);

    await tick();
    expect(c.getUpdates).toHaveBeenCalledTimes(1); // loop exited, no re-poll
    expect(log).not.toHaveBeenCalled();
    expect(bridge.health().polling).toBe(false);
  });
});

describe("repeated 409 is terminal (#830)", () => {
  it("stops after a bounded number of attempts and logs exactly once", async () => {
    const token = freshToken();
    const getUpdates = vi.fn(async () => {
      throw new TelegramApiError(409, "telegram getUpdates failed (409): Conflict: terminated by other getUpdates request");
    });
    const client = {
      ...parkedClient().client,
      getUpdates,
    } as TelegramClient;
    const log = vi.fn();
    const bridge = createTelegramBridge(opts(token, client, { log }));
    start(bridge);

    await vi.waitFor(() => expect(bridge.health().polling).toBe(false));

    expect(getUpdates).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/409/);
    expect(bridge.health().lastError).toMatch(/409/);
  });
});
