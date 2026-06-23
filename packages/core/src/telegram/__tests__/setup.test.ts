import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TelegramClient } from "../client.js";
import { detectGroupId, detectGroupAndUser, writeTelegramConfig, resolveSetupGroup } from "../setup.js";

let tmpdir: string;
beforeEach(() => { tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "sq-tg-setup-")); });
afterEach(() => { fs.rmSync(tmpdir, { recursive: true, force: true }); });

describe("detectGroupId", () => {
  it("returns the chat id when getUpdates returns a supergroup message", async () => {
    const client = {
      getUpdates: async () => [
        { update_id: 1, message: { chat: { id: -100500, type: "supergroup", title: "G" }, message_id: 10, date: 0 } },
      ],
      sendMessage: async () => {},
      createForumTopic: async () => 0,
      getMe: async () => ({ id: 0, username: "" }),
    } as unknown as TelegramClient;
    const sleep = async () => {};

    const id = await detectGroupId(client, { timeoutMs: 5000, sleep });

    expect(id).toBe(-100500);
  });

  it("tracks offset and skips non-supergroup updates", async () => {
    let callCount = 0;
    const client = {
      getUpdates: async () => {
        callCount++;
        if (callCount === 1) {
          return [{ update_id: 1, message: { chat: { id: 99, type: "private" }, message_id: 10, date: 0 } }];
        }
        return [{ update_id: 2, message: { chat: { id: -100500, type: "supergroup", title: "G" }, message_id: 11, date: 0 } }];
      },
      sendMessage: async () => {},
      createForumTopic: async () => 0,
      getMe: async () => ({ id: 0, username: "" }),
    } as unknown as TelegramClient;
    const sleep = async () => {};

    const id = await detectGroupId(client, { timeoutMs: 5000, sleep });

    expect(id).toBe(-100500);
    expect(callCount).toBe(2);
  });

  it("throws when no supergroup message arrives before timeout", async () => {
    const client = {
      getUpdates: async () => [],
      sendMessage: async () => {},
      createForumTopic: async () => 0,
      getMe: async () => ({ id: 0, username: "" }),
    } as unknown as TelegramClient;
    const sleep = async () => {};

    await expect(detectGroupId(client, { timeoutMs: 10, sleep })).rejects.toThrow("Timed out");
  });
});

describe("detectGroupAndUser", () => {
  it("returns the supergroup id and the sender's user id from one message", async () => {
    const client = {
      getUpdates: async () => [
        { update_id: 1, message: { chat: { id: -100500, type: "supergroup", title: "G" }, from: { id: 777 }, message_id: 10, date: 0 } },
      ],
      sendMessage: async () => {},
      createForumTopic: async () => 0,
      getMe: async () => ({ id: 0, username: "" }),
    } as unknown as TelegramClient;

    const r = await detectGroupAndUser(client, { timeoutMs: 5000, sleep: async () => {} });

    expect(r).toEqual({ supergroupId: -100500, userId: 777 });
  });
});

describe("writeTelegramConfig", () => {
  it("writes users + remoteControl when provided", () => {
    const configPath = path.join(tmpdir, "config.json");
    writeTelegramConfig(configPath, { token: "T", supergroupId: -100, users: [777], remoteControl: true });
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(raw.telegram).toEqual({ botToken: "T", supergroupId: -100, chats: [-100], users: [777], remoteControl: true });
  });

  it("preserves existing users/remoteControl when re-run without them", () => {
    const configPath = path.join(tmpdir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      commandName: "cmd", hubVault: "/tmp/hub", projects: {},
      defaults: { maxCrew: 5, worktreeDir: ".wt", teammateMode: "in-process", permissions: { command: "auto", captain: "auto", crew: "auto" } },
      metrics: { enabled: true, path: "/tmp/metrics" },
      telegram: { botToken: "OLD", supergroupId: -1, chats: [-1], users: [5], remoteControl: true },
    }));

    writeTelegramConfig(configPath, { token: "NEW", supergroupId: -100 });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(raw.telegram.botToken).toBe("NEW");
    expect(raw.telegram.users).toEqual([5]);
    expect(raw.telegram.remoteControl).toBe(true);
  });

  it("creates a fresh config when the file does not exist", () => {
    const configPath = path.join(tmpdir, "nonexistent.json");

    writeTelegramConfig(configPath, { token: "TOK", supergroupId: -100500 });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(raw.telegram).toEqual({ botToken: "TOK", supergroupId: -100500, chats: [-100500] });
  });

  it("throws and does not modify the file when the existing config has invalid JSON", () => {
    const configPath = path.join(tmpdir, "config.json");
    const corrupt = "{ this is not valid json }";
    fs.writeFileSync(configPath, corrupt);

    expect(() => writeTelegramConfig(configPath, { token: "TOK", supergroupId: -100 })).toThrow(
      /refusing to overwrite corrupt config/,
    );

    expect(fs.readFileSync(configPath, "utf-8")).toBe(corrupt);
  });

  it("writes the telegram block into an existing config, preserving other keys", () => {
    const configPath = path.join(tmpdir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      commandName: "cmd",
      hubVault: "/tmp/hub",
      projects: { demo: { path: "/tmp", captainName: "c", host: "local" } },
      defaults: { maxCrew: 5, worktreeDir: ".wt", teammateMode: "in-process", permissions: { command: "auto", captain: "auto", crew: "auto" } },
      metrics: { enabled: true, path: "/tmp/metrics" },
    }));

    writeTelegramConfig(configPath, { token: "ABC:tok", supergroupId: -100500 });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(raw.telegram).toEqual({ botToken: "ABC:tok", supergroupId: -100500, chats: [-100500] });
    expect(raw.commandName).toBe("cmd");
    expect(raw.projects.demo.path).toBe("/tmp");
  });

  it("overwrites an existing telegram block", () => {
    const configPath = path.join(tmpdir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      commandName: "cmd",
      hubVault: "/tmp/hub",
      projects: {},
      defaults: { maxCrew: 5, worktreeDir: ".wt", teammateMode: "in-process", permissions: { command: "auto", captain: "auto", crew: "auto" } },
      metrics: { enabled: true, path: "/tmp/metrics" },
      telegram: { botToken: "OLD", supergroupId: -1, chats: [-1] },
    }));

    writeTelegramConfig(configPath, { token: "NEW", supergroupId: -100 });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(raw.telegram.botToken).toBe("NEW");
    expect(raw.telegram.supergroupId).toBe(-100);
  });
});

describe("resolveSetupGroup", () => {
  it("returns 'detect' when no existing supergroupId", () => {
    expect(resolveSetupGroup(undefined, { redetect: false })).toBe("detect");
  });

  it("returns 'reuse' when supergroupId exists and redetect is false", () => {
    expect(resolveSetupGroup(-100500, { redetect: false })).toBe("reuse");
  });

  it("returns 'detect' when supergroupId exists but redetect is true", () => {
    expect(resolveSetupGroup(-100500, { redetect: true })).toBe("detect");
  });

  it("returns 'detect' when supergroupId is undefined even with redetect true", () => {
    expect(resolveSetupGroup(undefined, { redetect: true })).toBe("detect");
  });
});
