import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, saveConfig } from "@squadrant/shared";
import type { SquadrantConfig, ProjectConfig } from "@squadrant/shared";
import { runEffortGet, runEffortSet, notifyCaptainsOfEffort } from "../effort.js";

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-effort-"));
  cfgPath = path.join(dir, "config.json");
  saveConfig(getDefaultConfig(), cfgPath);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("effort get", () => {
  it("returns 'balance' and a description when effort is absent", () => {
    const config = getDefaultConfig();
    delete (config.defaults as any).effort;
    saveConfig(config, cfgPath);
    const result = runEffortGet(cfgPath);
    expect(result.effort).toBe("balance");
    expect(result.description).toBeTruthy();
    expect(result.description).toContain("balance");
  });

  it("returns 'low' when config has effort=low", () => {
    const config = getDefaultConfig();
    (config.defaults as any).effort = "low";
    saveConfig(config, cfgPath);
    const result = runEffortGet(cfgPath);
    expect(result.effort).toBe("low");
    expect(result.description).toContain("low");
  });

  it("returns 'max' when config has effort=max", () => {
    const config = getDefaultConfig();
    (config.defaults as any).effort = "max";
    saveConfig(config, cfgPath);
    const result = runEffortGet(cfgPath);
    expect(result.effort).toBe("max");
  });
});

describe("effort set", () => {
  it("writes 'low' to defaults.effort on disk", () => {
    runEffortSet("low", cfgPath);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.effort).toBe("low");
  });

  it("writes 'max' to defaults.effort on disk", () => {
    runEffortSet("max", cfgPath);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.effort).toBe("max");
  });

  it("writes 'balance' to defaults.effort on disk", () => {
    runEffortSet("balance", cfgPath);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.effort).toBe("balance");
  });

  it("round-trips: set 'low' then get returns 'low'", () => {
    runEffortSet("low", cfgPath);
    const result = runEffortGet(cfgPath);
    expect(result.effort).toBe("low");
  });

  it("rejects invalid value without writing config", () => {
    const before = fs.readFileSync(cfgPath, "utf-8");
    expect(() => runEffortSet("turbo", cfgPath)).toThrow();
    const after = fs.readFileSync(cfgPath, "utf-8");
    expect(after).toBe(before);
  });

  it("error for invalid value lists all 3 valid options", () => {
    let msg = "";
    try { runEffortSet("turbo", cfgPath); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("max");
    expect(msg).toContain("balance");
    expect(msg).toContain("low");
  });

  it("existing config without effort field loads and saves without side effects on other fields", () => {
    const config = getDefaultConfig();
    delete (config.defaults as any).effort;
    saveConfig(config, cfgPath);
    runEffortSet("balance", cfgPath);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.effort).toBe("balance");
    expect(onDisk.defaults.maxCrew).toBe(config.defaults.maxCrew);
    expect(onDisk.defaults.worktreeDir).toBe(config.defaults.worktreeDir);
  });
});

describe("effort notify (self-notification exclusion)", () => {
  // Records every (captainName, message) the fake driver was asked to send.
  function makeDriver(sent: Array<{ captain: string; message: string }>) {
    return {
      async status(name: string) {
        return { id: name }; // captainName doubles as the surface id
      },
      async send(ref: string, message: string) {
        sent.push({ captain: ref, message });
      },
    };
  }

  function configWithProjects(projects: Record<string, ProjectConfig>): SquadrantConfig {
    const config = getDefaultConfig();
    config.projects = projects;
    return config;
  }

  function project(p: string, captainName: string): ProjectConfig {
    return { path: p, captainName, spokeVault: "", host: "" };
  }

  it("does NOT notify the captain whose project path is the cwd, but DOES notify the others", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const projB = fs.mkdtempSync(path.join(dir, "projB-"));
    const config = configWithProjects({
      a: project(projA, "captain-a"),
      b: project(projB, "captain-b"),
    });
    const sent: Array<{ captain: string; message: string }> = [];

    await notifyCaptainsOfEffort("low", config, makeDriver(sent), projA);

    const captains = sent.map((s) => s.captain);
    expect(captains).not.toContain("captain-a"); // self — already saw stdout
    expect(captains).toContain("captain-b"); // other running captain still notified
    expect(captains).toHaveLength(1);
  });

  it("matches cwd through symlinks (realpath), still excluding self", async () => {
    const projA = fs.realpathSync(fs.mkdtempSync(path.join(dir, "projA-")));
    const link = path.join(dir, "link-to-a");
    fs.symlinkSync(projA, link);
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const sent: Array<{ captain: string; message: string }> = [];

    // cwd given via the symlink should still resolve to projA and skip it.
    await notifyCaptainsOfEffort("max", config, makeDriver(sent), link);

    expect(sent).toHaveLength(0);
  });

  it("notifies every captain when cwd matches no project path", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const projB = fs.mkdtempSync(path.join(dir, "projB-"));
    const config = configWithProjects({
      a: project(projA, "captain-a"),
      b: project(projB, "captain-b"),
    });
    const sent: Array<{ captain: string; message: string }> = [];

    await notifyCaptainsOfEffort("balance", config, makeDriver(sent), path.join(dir, "elsewhere"));

    expect(sent.map((s) => s.captain).sort()).toEqual(["captain-a", "captain-b"]);
  });
});
