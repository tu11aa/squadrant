import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePerCrewSettings } from "../per-crew-settings.js";

describe("writePerCrewSettings", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-per-crew-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes settings.json to <stateRoot>/<project>/<taskId>/settings.json", () => {
    const out = writePerCrewSettings({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    expect(out).toBe(path.join(tmp, "alpha", "tid-1", "settings.json"));
    expect(fs.existsSync(out)).toBe(true);
  });

  it("content equals mergeClaudeHooks({}, hookCmd)", () => {
    const out = writePerCrewSettings({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    const json = JSON.parse(fs.readFileSync(out, "utf-8"));
    // Hook events must be present (Stop, SubagentStop, SessionEnd).
    expect(Array.isArray(json.hooks.Stop)).toBe(true);
    expect(Array.isArray(json.hooks.SubagentStop)).toBe(true);
    expect(Array.isArray(json.hooks.SessionEnd)).toBe(true);
    // Each event has an entry pointing at `cockpit crew _hook <event>`.
    const stopCmd = json.hooks.Stop[0].hooks[0].command;
    expect(stopCmd).toContain("cockpit crew _hook");
    expect(stopCmd).toContain("Stop");
  });

  it("includes a PostToolUse liveness hook (mid-turn heartbeat → fixes false CREW STALLED)", () => {
    const out = writePerCrewSettings({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    const json = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(Array.isArray(json.hooks.PostToolUse)).toBe(true);
    const cmd = json.hooks.PostToolUse[0].hooks[0].command;
    expect(cmd).toContain("cockpit crew _hook");
    expect(cmd).toContain("PostToolUse");
  });

  it("custom hookCmd is honored", () => {
    const out = writePerCrewSettings({
      stateRoot: tmp,
      project: "beta",
      taskId: "tid-2",
      hookCmd: "/custom/bin/hook",
    });
    const json = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(json.hooks.Stop[0].hooks[0].command).toContain("/custom/bin/hook");
  });

  it("is idempotent — same inputs produce identical file content", () => {
    const out1 = writePerCrewSettings({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    const first = fs.readFileSync(out1, "utf-8");
    const out2 = writePerCrewSettings({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    const second = fs.readFileSync(out2, "utf-8");
    expect(out1).toBe(out2);
    expect(first).toBe(second);
  });

  it("creates intermediate directories", () => {
    const deep = path.join(tmp, "missing", "deeper");
    const out = writePerCrewSettings({ stateRoot: deep, project: "x", taskId: "y" });
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(path.dirname(out)).isDirectory()).toBe(true);
  });
});
