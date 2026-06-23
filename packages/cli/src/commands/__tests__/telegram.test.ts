import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, type SquadrantConfig, type TelegramConfig } from "@squadrant/shared";
import { loadState } from "@squadrant/core";
import { telegramCommand, runTelegramStatus, runTelegramLink, runTelegramSend, questionMasked } from "../telegram.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-tg-cmd-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const cfg: TelegramConfig = { botToken: "TKN", supergroupId: -100500, chats: [-100111] };

function fakeClient(onCreate?: () => void) {
  let next = 70;
  return {
    getUpdates: async () => [],
    sendMessage: async () => {},
    createForumTopic: async () => { onCreate?.(); return next++; },
    getMe: async () => ({ id: 0, username: "" }),
  };
}

describe("telegramCommand registration", () => {
  it("exposes the link, notify, send, setup, and status subcommands", () => {
    const names = telegramCommand.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["link", "notify", "send", "setup", "status"]);
  });
});

describe("runTelegramStatus", () => {
  it("reports token unset and no links when telegram is absent", () => {
    const config: SquadrantConfig = getDefaultConfig();
    const r = runTelegramStatus({ config, stateRoot: root, env: {} });
    expect(r.tokenSet).toBe(false);
    expect(r.supergroupId).toBeNull();
    expect(r.links).toEqual([]);
  });

  it("reports token set (from config), supergroup, and linked projects", () => {
    const config: SquadrantConfig = { ...getDefaultConfig(), telegram: cfg };
    fs.writeFileSync(path.join(root, "telegram-state.json"), JSON.stringify({ offset: 0, topics: { "demo::project": 88 } }));
    const r = runTelegramStatus({ config, stateRoot: root, env: {} });
    expect(r.tokenSet).toBe(true);
    expect(r.supergroupId).toBe(-100500);
    expect(r.links).toEqual([{ project: "demo", scope: "project", topicId: 88 }]);
  });

  it("treats TELEGRAM_BOT_TOKEN env as token set even without a config token", () => {
    const config: SquadrantConfig = { ...getDefaultConfig(), telegram: { ...cfg, botToken: undefined } };
    const r = runTelegramStatus({ config, stateRoot: root, env: { TELEGRAM_BOT_TOKEN: "envtok" } });
    expect(r.tokenSet).toBe(true);
  });
});

describe("runTelegramLink", () => {
  it("creates a forum topic, persists the binding, and returns the topic id", async () => {
    let creates = 0;
    const client = fakeClient(() => { creates++; });
    const r = await runTelegramLink({ project: "demo", cfg, client, stateRoot: root });
    expect(r.created).toBe(true);
    expect(typeof r.topicId).toBe("number");
    expect(loadState(root).topics["demo::project"]).toBe(r.topicId);
    expect(creates).toBe(1);
  });

  it("is idempotent: re-linking returns the existing topic without creating a new one", async () => {
    let creates = 0;
    const client = fakeClient(() => { creates++; });
    const first = await runTelegramLink({ project: "demo", cfg, client, stateRoot: root });
    const second = await runTelegramLink({ project: "demo", cfg, client, stateRoot: root });
    expect(second.created).toBe(false);
    expect(second.topicId).toBe(first.topicId);
    expect(creates).toBe(1);
  });
});

describe("runTelegramSend", () => {
  it("sends to the correct supergroup and topic, and returns their ids", async () => {
    const sent: Array<{ chatId: number; threadId: number | undefined; text: string }> = [];
    const client = {
      ...fakeClient(),
      sendMessage: async (chatId: number, threadId: number | undefined, text: string) => {
        sent.push({ chatId, threadId, text });
      },
    };
    fs.writeFileSync(path.join(root, "telegram-state.json"), JSON.stringify({ offset: 0, topics: { "demo::project": 42 } }));
    const r = await runTelegramSend({ project: "demo", message: "hello", cfg, client, stateRoot: root });
    expect(r.chatId).toBe(cfg.supergroupId);
    expect(r.topicId).toBe(42);
    expect(sent).toEqual([{ chatId: cfg.supergroupId, threadId: 42, text: "hello" }]);
  });

  it("throws a descriptive error when the project is not linked", async () => {
    const client = fakeClient();
    await expect(runTelegramSend({ project: "nope", message: "hi", cfg, client, stateRoot: root }))
      .rejects.toThrow('project "nope" is not linked — run: squadrant telegram link nope');
  });
});

import { runTelegramNotifySet, runTelegramNotifyStatus } from "../telegram.js";
import { isNotifyActive, setTopic as setTopicDirect } from "@squadrant/core";

describe("telegram notify CLI", () => {
  it("runTelegramNotifySet writes the flag", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cli-"));
    runTelegramNotifySet({ project: "squadrant", active: true, stateRoot: dir });
    expect(isNotifyActive(dir, "squadrant")).toBe(true);
    runTelegramNotifySet({ project: "squadrant", active: false, stateRoot: dir });
    expect(isNotifyActive(dir, "squadrant")).toBe(false);
  });

  it("runTelegramNotifyStatus lists known projects (from topics ∪ notify)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cli-"));
    setTopicDirect(dir, "alpha", 1);
    runTelegramNotifySet({ project: "beta", active: true, stateRoot: dir });
    const rows = runTelegramNotifyStatus({ stateRoot: dir }).sort((a, b) => a.project.localeCompare(b.project));
    expect(rows).toEqual([
      { project: "alpha", active: false },
      { project: "beta", active: true },
    ]);
  });
});

describe("questionMasked stdin teardown", () => {
  it("pauses stdin and removes keypress listener on enter so the event loop can drain", async () => {
    // Stub the stdin methods that require a real TTY
    const setRawMode = vi.fn().mockReturnValue(process.stdin);
    const resume = vi.fn().mockReturnValue(process.stdin);
    const pause = vi.fn().mockReturnValue(process.stdin);
    const origSetRawMode = (process.stdin as any).setRawMode;
    const origResume = process.stdin.resume.bind(process.stdin);
    const origPause = process.stdin.pause.bind(process.stdin);
    (process.stdin as any).setRawMode = setRawMode;
    process.stdin.resume = resume;
    process.stdin.pause = pause;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    try {
      const p = questionMasked();
      // Directly emit the enter keypress that questionMasked listens for
      process.stdin.emit("keypress", undefined, { name: "return", ctrl: false, meta: false, sequence: "" });
      const result = await p;

      expect(result).toBe("");
      expect(pause).toHaveBeenCalled();
      expect(setRawMode).toHaveBeenCalledWith(false);
      // Our listener must be gone — listener count must be 0 for 'keypress'
      expect(process.stdin.listenerCount("keypress")).toBe(0);
    } finally {
      (process.stdin as any).setRawMode = origSetRawMode;
      process.stdin.resume = origResume;
      process.stdin.pause = origPause;
      stdoutSpy.mockRestore();
    }
  });
});
