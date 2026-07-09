import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, saveConfig } from "@squadrant/shared";
import type { SquadrantConfig, ProjectConfig } from "@squadrant/shared";
import { runEffortGet, runEffortSet, notifyCaptainsOfEffort, effortCommand } from "../effort.js";

const requireDaemon = vi.hoisted(() => vi.fn());
vi.mock("../../lib/require-daemon.js", () => ({
  requireDaemon,
}));

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-effort-"));
  cfgPath = path.join(dir, "config.json");
  saveConfig(getDefaultConfig(), cfgPath);
  vi.resetAllMocks();
  requireDaemon.mockResolvedValue(undefined);
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

  /** Track calls to appendCaptainMessage — used to prove the broadcast routes
   *  through the mailbox instead of driver.send. */
  function makeAppendSpy(): {
    fn: (project: string, text: string) => Promise<void>;
    projects: string[];
    texts: string[];
  } {
    const projects: string[] = [];
    const texts: string[] = [];
    return {
      fn: async (project, text) => {
        projects.push(project);
        texts.push(text);
      },
      projects,
      texts,
    };
  }

  it("does NOT call driver.send — enqueues to mailbox instead", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const projB = fs.mkdtempSync(path.join(dir, "projB-"));
    const config = configWithProjects({
      a: project(projA, "captain-a"),
      b: project(projB, "captain-b"),
    });
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();

    await notifyCaptainsOfEffort("low", config, makeDriver(sent), projA, spy.fn);

    // MUST NOT call driver.send
    expect(sent).toHaveLength(0);
    // MUST enqueue to mailbox instead — only project-b (cwd-projA excluded)
    expect(spy.projects).toEqual(["b"]);
    expect(spy.texts[0]).toContain("effort");
  });

  it("matches cwd through symlinks (realpath), still excluding self", async () => {
    const projA = fs.realpathSync(fs.mkdtempSync(path.join(dir, "projA-")));
    const link = path.join(dir, "link-to-a");
    fs.symlinkSync(projA, link);
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();

    // cwd given via the symlink should still resolve to projA and skip it.
    await notifyCaptainsOfEffort("max", config, makeDriver(sent), link, spy.fn);

    expect(sent).toHaveLength(0);
    expect(spy.projects).toHaveLength(0);
  });

  it("notifies every captain when cwd matches no project path", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const projB = fs.mkdtempSync(path.join(dir, "projB-"));
    const config = configWithProjects({
      a: project(projA, "captain-a"),
      b: project(projB, "captain-b"),
    });
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();

    await notifyCaptainsOfEffort("balance", config, makeDriver(sent), path.join(dir, "elsewhere"), spy.fn);

    expect(sent).toHaveLength(0);
    expect(spy.projects.sort()).toEqual(["a", "b"]);
  });

  it("handles driver failure gracefully without throwing (best effort)", async () => {
    const config = configWithProjects({
      a: project(path.join(dir, "projA"), "captain-a"),
    });

    const driver = {
      status: vi.fn().mockRejectedValue(new Error("daemon unreachable"))
    };
    
    const append = vi.fn();
    
    // Should NOT throw
    await notifyCaptainsOfEffort("low", config, driver, path.join(dir, "elsewhere"), append);
    
    // And should not have appended
    expect(append).not.toHaveBeenCalled();
  });
});
