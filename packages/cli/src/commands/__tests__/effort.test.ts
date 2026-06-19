import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, saveConfig } from "@cockpit/shared";
import { runEffortGet, runEffortSet } from "../effort.js";

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-effort-"));
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
