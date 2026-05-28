// src/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDefaultConfig, loadConfig, saveConfig } from "./config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("config", () => {
  const tmpDir = path.join(os.tmpdir(), "cockpit-test-" + Date.now());
  const configPath = path.join(tmpDir, "config.json");

  beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns default config", () => {
    const config = getDefaultConfig();
    expect(config.commandName).toBe("🏛️ command");
    expect(config.projects).toEqual({});
    expect(config.defaults.maxCrew).toBe(5);
    expect(config.defaults.worktreeDir).toBe(".worktrees");
    expect(config.defaults.teammateMode).toBe("in-process");
    expect(config.metrics.enabled).toBe(true);
  });

  it("saves and loads config", () => {
    const config = getDefaultConfig();
    config.projects.brove = {
      path: "/tmp/brove",
      captainName: "brove-captain",
      spokeVault: "/tmp/brove/.cockpit-vault",
      host: "local",
    };
    saveConfig(config, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded.projects.brove.path).toBe("/tmp/brove");
    expect(loaded.projects.brove.captainName).toBe("brove-captain");
  });

  it("returns default config when file does not exist", () => {
    const loaded = loadConfig(path.join(tmpDir, "nonexistent.json"));
    expect(loaded.commandName).toBe("🏛️ command");
  });

  it("supports new agents config", () => {
    const config = getDefaultConfig();
    expect(config.agents).toBeDefined();
    expect(config.agents!.claude).toEqual({ cli: "claude", driver: "claude" });
  });

  it("supports new roles config", () => {
    const config = getDefaultConfig();
    expect(config.defaults.roles).toBeDefined();
    expect(config.defaults.roles!.command).toEqual({ agent: "claude", model: "opus" });
    expect(config.defaults.roles!.crew).toEqual({ agent: "claude", model: "sonnet" });
  });

  it("migrates old models config to roles on load", () => {
    const oldConfig = {
      commandName: "command",
      hubVault: "/tmp/hub",
      projects: {},
      defaults: {
        maxCrew: 5,
        worktreeDir: ".worktrees",
        teammateMode: "in-process",
        permissions: { command: "default", captain: "acceptEdits" },
        models: { command: "opus", captain: "opus", crew: "sonnet", exploration: "haiku", review: "opus" },
      },
      metrics: { enabled: true, path: "/tmp/metrics.json" },
    };
    fs.writeFileSync(configPath, JSON.stringify(oldConfig));
    const loaded = loadConfig(configPath);
    expect(loaded.defaults.roles).toBeDefined();
    expect(loaded.defaults.roles!.crew).toEqual({ agent: "claude", model: "sonnet" });
    expect(loaded.defaults.models).toBeDefined();
  });

  it("preserves new roles config on load", () => {
    const newConfig = {
      commandName: "command",
      hubVault: "/tmp/hub",
      projects: {},
      agents: {
        claude: { cli: "claude", driver: "claude" },
        codex: { cli: "codex", driver: "codex" },
      },
      defaults: {
        maxCrew: 5,
        worktreeDir: ".worktrees",
        teammateMode: "in-process",
        permissions: { command: "default", captain: "acceptEdits" },
        roles: {
          command: { agent: "claude", model: "opus" },
          captain: { agent: "claude", model: "opus" },
          crew: { agent: "codex", model: "o3" },
          exploration: { agent: "claude", model: "haiku" },
        },
      },
      metrics: { enabled: true, path: "/tmp/metrics.json" },
    };
    fs.writeFileSync(configPath, JSON.stringify(newConfig));
    const loaded = loadConfig(configPath);
    expect(loaded.defaults.roles!.crew).toEqual({ agent: "codex", model: "o3" });
    expect(loaded.agents!.codex).toEqual({ cli: "codex", driver: "codex" });
  });
});
