import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TelegramConfig } from "@squadrant/shared";
import { loadProjectOverride } from "@squadrant/shared";
import { createTelegramBridge, type TelegramBridge } from "../bridge.js";
import type { TelegramClient } from "../client.js";
import { setTopic, isNotifyActive } from "../state.js";
import { buildSpawnPrompt } from "../panels.js";

const USER = 42;
const CHAT = -100111;
const cfg: TelegramConfig = {
  botToken: "T", supergroupId: -100500, chats: [CHAT], pollMs: 1,
  remoteControl: true, users: [USER],
} as any; // stale dist types lack remoteControl/users

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sq-tg-cb-"));
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

interface Harness {
  bridge: TelegramBridge;
  client: TelegramClient & { answerCallbackQuery: ReturnType<typeof vi.fn>; editMessageReplyMarkup: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> };
  runCommand: ReturnType<typeof vi.fn>;
  stateRoot: string;
  configRoot: string;
}

function makeHarness(callbackQuery: unknown, overrideCfg = cfg): Harness {
  const stateRoot = freshRoot();
  const configRoot = freshRoot();
  let n = 0;
  const answerCallbackQuery = vi.fn(async () => {});
  const editMessageReplyMarkup = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => {});
  const client = {
    sendMessage,
    answerCallbackQuery,
    editMessageReplyMarkup,
    createForumTopic: async () => 1,
    getMe: async () => ({ id: 0, username: "" }),
    setMyCommands: async () => {},
    getUpdates: async () => {
      n++;
      if (n === 1) return [{ update_id: 10, callback_query: callbackQuery } as never];
      return [];
    },
  } as unknown as Harness["client"];
  const runCommand = vi.fn(async () => "ok");
  const bridge = createTelegramBridge({
    cfg: overrideCfg, stateRoot, configRoot, client,
    appendCaptainMessage: async () => {},
    log: () => {},
    runCommand,
    // Mirror the daemon host: a panel/ForceReply reply forwards reply_markup to sendMessage.
    sendReply: async (threadId, text, markup) => { await client.sendMessage(cfg.supergroupId, threadId, text, markup); },
  });
  active = bridge;
  return { bridge, client, runCommand, stateRoot, configRoot };
}

describe("handleCallback — notify", () => {
  it("authorized crew tap writes the override, answers, and edits the panel", async () => {
    const h = makeHarness({
      id: "c1", from: { id: USER }, data: "n:crew:none",
      message: { chat: { id: CHAT }, message_id: 42, message_thread_id: 9 },
    });
    setTopic(h.stateRoot, "squadrant", 9);
    h.bridge.start();
    await waitFor(() => h.client.answerCallbackQuery.mock.calls.length > 0);

    expect(loadProjectOverride("squadrant", h.configRoot).telegram?.notify?.crew).toBe("none");
    expect(h.client.answerCallbackQuery).toHaveBeenCalledWith("c1", expect.stringContaining("crew = none"));
    expect(h.client.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
  });

  it("active tap mutes via live state", async () => {
    const h = makeHarness({
      id: "c4", from: { id: USER }, data: "n:active:off",
      message: { chat: { id: CHAT }, message_id: 1, message_thread_id: 9 },
    });
    setTopic(h.stateRoot, "squadrant", 9);
    h.bridge.start();
    await waitFor(() => h.client.answerCallbackQuery.mock.calls.length > 0);
    expect(isNotifyActive(h.stateRoot, "squadrant")).toBe(false);
  });
});

describe("handleCallback — auth gate", () => {
  it("unauthorized tap answers not-authorized and does NOT apply or edit", async () => {
    const h = makeHarness({
      id: "c2", from: { id: 999 }, data: "n:crew:all",
      message: { chat: { id: CHAT }, message_id: 1, message_thread_id: 9 },
    });
    setTopic(h.stateRoot, "squadrant", 9);
    h.bridge.start();
    await waitFor(() => h.client.answerCallbackQuery.mock.calls.length > 0);

    expect(h.client.answerCallbackQuery).toHaveBeenCalledWith("c2", expect.stringContaining("not authorized"));
    expect(h.client.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(loadProjectOverride("squadrant", h.configRoot).telegram?.notify?.crew).toBeUndefined();
  });
});

describe("handleCallback — effort", () => {
  it("runs the effort command and answers", async () => {
    const h = makeHarness({
      id: "c3", from: { id: USER }, data: "e:low",
      message: { chat: { id: CHAT }, message_id: 7 },
    });
    h.bridge.start();
    await waitFor(() => h.client.answerCallbackQuery.mock.calls.length > 0);
    expect(h.runCommand).toHaveBeenCalledWith(["effort", "low"]);
    expect(h.client.answerCallbackQuery).toHaveBeenCalledWith("c3", expect.stringContaining("effort = low"));
  });
});

interface InboundHarness {
  bridge: TelegramBridge;
  sendMessage: ReturnType<typeof vi.fn>;
  appendCaptainMessage: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
  stateRoot: string;
  configRoot: string;
}

function writeConfig(configRoot: string, projects: string[]): void {
  const cfgJson = {
    projects: Object.fromEntries(projects.map((p) => [p, {}])),
    defaults: { effort: "balance", crewRouting: {} },
  };
  fs.writeFileSync(path.join(configRoot, "config.json"), JSON.stringify(cfgJson));
}

function makeInbound(message: unknown): InboundHarness {
  const stateRoot = freshRoot();
  const configRoot = freshRoot();
  let n = 0;
  const sendMessage = vi.fn(async () => {});
  const appendCaptainMessage = vi.fn(async () => {});
  const runCommand = vi.fn(async () => "ok");
  const client = {
    sendMessage,
    answerCallbackQuery: async () => {},
    editMessageReplyMarkup: async () => {},
    createForumTopic: async () => 1,
    getMe: async () => ({ id: 0, username: "" }),
    setMyCommands: async () => {},
    getUpdates: async () => {
      n++;
      if (n === 1) return [{ update_id: 10, message } as never];
      return [];
    },
  } as unknown as TelegramClient;
  const bridge = createTelegramBridge({
    cfg, stateRoot, configRoot, client,
    appendCaptainMessage,
    log: () => {},
    runCommand,
    // Mirror the daemon host: a panel reply forwards reply_markup to sendMessage.
    sendReply: async (threadId, text, markup) => { await client.sendMessage(cfg.supergroupId, threadId, text, markup); },
  });
  active = bridge;
  return { bridge, sendMessage, appendCaptainMessage, runCommand, stateRoot, configRoot };
}

describe("command panels (inbound)", () => {
  it("/notify in a project topic replies the panel, not a usage hint, and never appends", async () => {
    const h = makeInbound({ chat: { id: CHAT }, message_thread_id: 9, text: "/notify", from: { id: USER } });
    setTopic(h.stateRoot, "squadrant", 9);
    h.bridge.start();
    await waitFor(() => h.sendMessage.mock.calls.length > 0);
    const call = h.sendMessage.mock.calls.at(-1)!;
    expect(call[3]?.inline_keyboard).toBeTruthy(); // 4th arg = replyMarkup
    expect(h.appendCaptainMessage).not.toHaveBeenCalled();
  });

  it("/crews with no project replies a project picker", async () => {
    const h = makeInbound({ chat: { id: CHAT }, text: "/crews", from: { id: USER } });
    writeConfig(h.configRoot, ["brove", "solder"]);
    h.bridge.start();
    await waitFor(() => h.sendMessage.mock.calls.length > 0);
    const call = h.sendMessage.mock.calls.at(-1)!;
    const buttons = call[3].inline_keyboard.flat();
    expect(buttons.some((b: any) => b.callback_data === "cr:brove")).toBe(true);
    expect(buttons.some((b: any) => b.callback_data === "cr:solder")).toBe(true);
  });

  it("/effort with no mode replies the effort panel", async () => {
    const h = makeInbound({ chat: { id: CHAT }, text: "/effort", from: { id: USER } });
    writeConfig(h.configRoot, ["brove"]);
    h.bridge.start();
    await waitFor(() => h.sendMessage.mock.calls.length > 0);
    const call = h.sendMessage.mock.calls.at(-1)!;
    expect(call[3].inline_keyboard.flat().some((b: any) => b.callback_data === "e:balance")).toBe(true);
  });
});

describe("handleCallback — pickers", () => {
  it("mute pick mutes the project via live state", async () => {
    const h = makeHarness({
      id: "c5", from: { id: USER }, data: "mu:brove",
      message: { chat: { id: CHAT }, message_id: 3 },
    });
    h.bridge.start();
    await waitFor(() => h.client.answerCallbackQuery.mock.calls.length > 0);
    expect(isNotifyActive(h.stateRoot, "brove")).toBe(false);
    expect(h.client.answerCallbackQuery).toHaveBeenCalledWith("c5", expect.stringContaining("muted brove"));
  });

  it("launch pick runs the launch command", async () => {
    const h = makeHarness({
      id: "c6", from: { id: USER }, data: "lc:solder",
      message: { chat: { id: CHAT }, message_id: 4 },
    });
    h.bridge.start();
    await waitFor(() => h.client.answerCallbackQuery.mock.calls.length > 0);
    expect(h.runCommand).toHaveBeenCalledWith(["launch", "solder"]);
  });
});

describe("guided /spawn (slice 2)", () => {
  it("/spawn with no task replies a project picker (gated, not appended)", async () => {
    const h = makeInbound({ chat: { id: CHAT }, text: "/spawn", from: { id: USER } });
    writeConfig(h.configRoot, ["brove", "solder"]);
    h.bridge.start();
    await waitFor(() => h.sendMessage.mock.calls.length > 0);
    const call = h.sendMessage.mock.calls.at(-1)!;
    expect(call[3].inline_keyboard.flat().some((b: any) => b.callback_data.startsWith("sp:"))).toBe(true);
    expect(h.appendCaptainMessage).not.toHaveBeenCalled();
  });

  it("sp: tap sends a ForceReply prompt carrying the project", async () => {
    const h = makeHarness({
      id: "c1", from: { id: USER }, data: "sp:brove",
      message: { chat: { id: CHAT }, message_id: 5, message_thread_id: 7 },
    });
    h.bridge.start();
    await waitFor(() => h.client.sendMessage.mock.calls.length > 0);
    const call = h.client.sendMessage.mock.calls.at(-1)!;
    expect(call[2]).toContain("brove");                 // prompt text carries the project
    expect(call[3]).toMatchObject({ force_reply: true });
  });

  it("a reply to the spawn prompt runs crew spawn (authorized), not appended", async () => {
    const h = makeInbound({
      chat: { id: CHAT }, message_thread_id: 7, text: "audit the auth module",
      from: { id: USER }, reply_to_message: { text: buildSpawnPrompt("brove") },
    });
    h.bridge.start();
    await waitFor(() => h.runCommand.mock.calls.length > 0);
    expect(h.runCommand).toHaveBeenCalledWith(["crew", "spawn", "brove", "audit the auth module"]);
    expect(h.appendCaptainMessage).not.toHaveBeenCalled();
  });

  it("a reply to the spawn prompt from a non-allowlisted user is refused", async () => {
    const h = makeInbound({
      chat: { id: CHAT }, message_thread_id: 7, text: "do x",
      from: { id: 999 }, reply_to_message: { text: buildSpawnPrompt("brove") },
    });
    h.bridge.start();
    await waitFor(() => h.sendMessage.mock.calls.length > 0);
    expect(h.runCommand).not.toHaveBeenCalled();
    expect(h.appendCaptainMessage).not.toHaveBeenCalled();
  });

  it("an ordinary message (no reply_to spawn prompt) is still appended", async () => {
    const h = makeInbound({ chat: { id: CHAT }, message_thread_id: 9, text: "hello", from: { id: USER } });
    setTopic(h.stateRoot, "squadrant", 9);
    h.bridge.start();
    await waitFor(() => h.appendCaptainMessage.mock.calls.length > 0);
    expect(h.appendCaptainMessage).toHaveBeenCalled();
  });
});
