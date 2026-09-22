import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { TelegramConfig } from "@squadrant/shared";
import type { Update } from "@grammyjs/types";
import { createTelegramBridge, pollBackoffMs, telegramPollLockPath, CONFLICT_409_SELF_HEAL_MS, type TelegramBridge, type TelegramBridgeOptions } from "../bridge.js";
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

describe("rate-limit back-off (#321)", () => {
  it("uses the API's retry_after when it sent one, the cadence otherwise", () => {
    expect(pollBackoffMs(new TelegramApiError(429, "too many", 7), 1000)).toBe(7000);
    expect(pollBackoffMs(new TelegramApiError(429, "too many"), 1000)).toBe(1000);
    expect(pollBackoffMs(new TelegramApiError(502, "bad gateway"), 1000)).toBe(1000);
    expect(pollBackoffMs(new Error("boom"), 1000)).toBe(1000);
  });

  it("holds the poll loop for the hinted delay instead of re-polling on cadence", async () => {
    // pollMs is 1 here, so a 100ms hinted delay is 100× the cadence — the call
    // count below can only stay at 1 if the hint actually gated the loop.
    const token = freshToken();
    const getUpdates = vi.fn(async () => {
      throw new TelegramApiError(429, "telegram getUpdates failed (429): Too Many Requests", 0.1);
    });
    const client = { ...parkedClient().client, getUpdates } as TelegramClient;
    const bridge = createTelegramBridge(opts(token, client));
    start(bridge);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(1));
    await tick(40);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getUpdates.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
  });
});

describe("restart-drain 409 tolerance (#850)", () => {
  it("a burst of 3 consecutive 409s right after start does NOT go terminal", async () => {
    const token = freshToken();
    const getUpdates = vi.fn(async () => {
      throw new TelegramApiError(409, "telegram getUpdates failed (409): Conflict: terminated by other getUpdates request");
    });
    const client = { ...parkedClient().client, getUpdates } as TelegramClient;
    const log = vi.fn();
    // Frozen clock: the sustained-409 window can never elapse in this test, so
    // the ONLY reason to survive here is the removal of the attempt-count guard.
    const bridge = createTelegramBridge(opts(token, client, { log, now: () => 1_000 }));
    start(bridge);

    await vi.waitFor(() => expect(getUpdates.mock.calls.length).toBeGreaterThanOrEqual(3));
    await tick(30);

    expect(bridge.health().polling).toBe(true);
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toMatch(/poll stopped/);
    expect(bridge.health().lastError).toMatch(/409/);
  });

  it("yields to a genuinely foreign live lock holder (real protection preserved)", async () => {
    const token = freshToken();
    const getUpdates = vi.fn(async () => {
      throw new TelegramApiError(409, "telegram getUpdates failed (409): Conflict: terminated by other getUpdates request");
    });
    const client = { ...parkedClient().client, getUpdates } as TelegramClient;
    const log = vi.fn();
    const foreignPid = process.ppid; // a live process that is not this one
    const bridge = createTelegramBridge(opts(token, client, { log, now: () => 1_000 }));
    start(bridge);
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalled());

    // A different live process takes the poll lock while we are polling.
    fs.writeFileSync(telegramPollLockPath(token), String(foreignPid));

    await vi.waitFor(() => expect(bridge.health().polling).toBe(false));
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/409/);
    expect(logged).toContain(String(foreignPid)); // the holder is named
  });

  it("after a terminal stop, re-attempts the poll with backoff (self-heal)", async () => {
    const token = freshToken();
    let clock = 0;
    const getUpdates = vi.fn(async () => {
      clock += 60_000; // each attempt pushes past the sustained window
      throw new TelegramApiError(409, "telegram getUpdates failed (409): Conflict: terminated by other getUpdates request");
    });
    const client = { ...parkedClient().client, getUpdates } as TelegramClient;
    const log = vi.fn();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const schedule = (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return () => {};
    };
    const bridge = createTelegramBridge(opts(token, client, { log, now: () => clock, schedule }));
    start(bridge);

    await vi.waitFor(() => expect(bridge.health().polling).toBe(false));
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/poll stopped/);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(CONFLICT_409_SELF_HEAL_MS);

    const before = getUpdates.mock.calls.length;
    timers[0].fn(); // the backoff elapses
    await vi.waitFor(() => expect(getUpdates.mock.calls.length).toBeGreaterThan(before));
  });
});
