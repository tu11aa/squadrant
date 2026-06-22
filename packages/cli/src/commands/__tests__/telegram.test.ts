import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, type SquadrantConfig, type TelegramConfig } from "@squadrant/shared";
import type { TelegramClient } from "@squadrant/core";
import { loadState } from "@squadrant/core";
import { telegramCommand, runTelegramStatus, runTelegramLink } from "../telegram.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-tg-cmd-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const cfg: TelegramConfig = { botToken: "TKN", supergroupId: -100500, chats: [-100111] };

function fakeClient(onCreate?: () => void): TelegramClient {
  let next = 70;
  return {
    getUpdates: async () => [],
    sendMessage: async () => {},
    createForumTopic: async () => { onCreate?.(); return next++; },
  };
}

describe("telegramCommand registration", () => {
  it("exposes the link and status subcommands", () => {
    const names = telegramCommand.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["link", "status"]);
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
