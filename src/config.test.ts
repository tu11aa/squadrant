// src/config.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDefaultConfig, loadConfig, saveConfig } from "@cockpit/shared";
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

  it("daemonDirectCmux defaults to false", () => {
    const cfg = getDefaultConfig();
    expect(cfg.defaults?.daemonDirectCmux).toBe(false);
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
    expect(config.defaults.roles!.crew).toEqual({ agent: "claude", model: "opus" });
  });

  it("defaults crews to opus + auto permission mode", () => {
    const config = getDefaultConfig();
    expect(config.defaults.models!.crew).toBe("opus");
    expect(config.defaults.permissions.crew).toBe("auto");
  });

  it("backfills crewRouting when absent and writes it to disk", () => {
    const configWithoutRouting = {
      commandName: "command",
      hubVault: "/tmp/hub",
      projects: {},
      defaults: {
        maxCrew: 5,
        worktreeDir: ".worktrees",
        teammateMode: "in-process",
        permissions: { command: "auto", captain: "auto", crew: "auto" },
      },
      metrics: { enabled: true, path: "/tmp/metrics.json" },
    };
    fs.writeFileSync(configPath, JSON.stringify(configWithoutRouting));

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = loadConfig(configPath);
    spy.mockRestore();

    // in-memory result has crewRouting backfilled
    expect(loaded.defaults.crewRouting).toBeDefined();
    expect(loaded.defaults.crewRouting!.rules.length).toBeGreaterThan(0);

    // file on disk was updated (migration persisted)
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(onDisk.defaults.crewRouting).toBeDefined();
  });

  it("does not re-persist or re-notice when crewRouting already present", () => {
    const configWithRouting = {
      commandName: "command",
      hubVault: "/tmp/hub",
      projects: {},
      defaults: {
        maxCrew: 5,
        worktreeDir: ".worktrees",
        teammateMode: "in-process",
        permissions: { command: "auto", captain: "auto", crew: "auto" },
        crewRouting: { rules: [{ tier: "custom", match: "custom", agent: "opencode" }] },
      },
      metrics: { enabled: true, path: "/tmp/metrics.json" },
    };
    fs.writeFileSync(configPath, JSON.stringify(configWithRouting));
    const originalMtime = fs.statSync(configPath).mtimeMs;

    // Small delay to ensure mtime would differ if the file were rewritten
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = loadConfig(configPath);

    // custom rules preserved — not replaced with defaults
    expect(loaded.defaults.crewRouting!.rules[0].tier).toBe("custom");
    // file not rewritten (mtime unchanged)
    expect(fs.statSync(configPath).mtimeMs).toBe(originalMtime);
    // no stderr notice emitted
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not crash or persist when config file does not exist (fallback path)", () => {
    const missingPath = path.join(tmpDir, "nonexistent.json");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = loadConfig(missingPath);
    spy.mockRestore();

    // fallback returns default config (which has crewRouting) without writing any file
    expect(loaded.defaults.crewRouting).toBeDefined();
    expect(fs.existsSync(missingPath)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits a stderr notice exactly once on the backfill path", () => {
    const configWithoutRouting = {
      commandName: "command",
      hubVault: "/tmp/hub",
      projects: {},
      defaults: {
        maxCrew: 5,
        worktreeDir: ".worktrees",
        teammateMode: "in-process",
        permissions: { command: "auto", captain: "auto", crew: "auto" },
      },
      metrics: { enabled: true, path: "/tmp/metrics.json" },
    };
    fs.writeFileSync(configPath, JSON.stringify(configWithoutRouting));

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig(configPath);
    // Second call — file now has crewRouting, so no second notice
    loadConfig(configPath);

    // notice fired exactly once
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/cockpit upgrade/i);
    spy.mockRestore();
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
