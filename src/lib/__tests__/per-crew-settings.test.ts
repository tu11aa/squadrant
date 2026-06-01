import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writePerCrewSettings,
  writePerCrewSettingsLocal,
  writePerCrewOpencodeConfig,
  CREW_PERMISSION_ALLOWLIST,
} from "../per-crew-settings.js";

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

describe("writePerCrewSettingsLocal — permission allowlist", () => {
  let tmp: string;
  const settingsPath = () => path.join(tmp, ".claude", "settings.local.json");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-local-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a permissions.allow starter set covering common dev commands", () => {
    writePerCrewSettingsLocal({ projectCwd: tmp });
    const json = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(Array.isArray(json.permissions.allow)).toBe(true);
    for (const entry of CREW_PERMISSION_ALLOWLIST) {
      expect(json.permissions.allow).toContain(entry);
    }
    // Representative coverage: git mutations, installs, and the test runner.
    expect(json.permissions.allow).toContain("Bash(git commit:*)");
    expect(json.permissions.allow).toContain("Bash(npm install:*)");
    expect(json.permissions.allow).toContain("Bash(vitest:*)");
  });

  it("does NOT blanket-allow Bash or risky ops (so 2b still surfaces them)", () => {
    writePerCrewSettingsLocal({ projectCwd: tmp });
    const json = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(json.permissions.allow).not.toContain("Bash(*)");
    expect(json.permissions.allow).not.toContain("Bash(rm:*)");
    expect(json.permissions.allow).not.toContain("Bash(curl:*)");
  });

  it("merges with (does not clobber) a pre-existing permissions.allow", () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ permissions: { allow: ["Bash(python3:*)"], deny: ["Bash(sudo:*)"] } }, null, 2),
    );
    writePerCrewSettingsLocal({ projectCwd: tmp });
    const json = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    // The user's own entry survives...
    expect(json.permissions.allow).toContain("Bash(python3:*)");
    // ...alongside the starter set...
    expect(json.permissions.allow).toContain("Bash(git push:*)");
    // ...and unrelated permission keys are preserved.
    expect(json.permissions.deny).toEqual(["Bash(sudo:*)"]);
  });

  it("is idempotent — does not duplicate allowlist entries on a second write", () => {
    writePerCrewSettingsLocal({ projectCwd: tmp });
    writePerCrewSettingsLocal({ projectCwd: tmp });
    const json = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    const counts = new Map<string, number>();
    for (const e of json.permissions.allow) counts.set(e, (counts.get(e) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
  });
});

describe("writePerCrewOpencodeConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-per-crew-opencode-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes opencode.json to <stateRoot>/<project>/<taskId>/opencode.json", () => {
    const out = writePerCrewOpencodeConfig({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    expect(out).toBe(path.join(tmp, "alpha", "tid-1", "opencode.json"));
    expect(fs.existsSync(out)).toBe(true);
  });

  it("emits comprehensive permission block for autonomous crews", () => {
    const out = writePerCrewOpencodeConfig({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    const json = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(json).toEqual({
      permission: {
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        bash: "allow",
        webfetch: "allow",
        websearch: "allow",
        task: "allow",
        lsp: "allow",
        external_directory: { "**": "allow" },
      },
    });
  });

  it("is idempotent — same inputs produce identical file content", () => {
    const out1 = writePerCrewOpencodeConfig({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    const first = fs.readFileSync(out1, "utf-8");
    const out2 = writePerCrewOpencodeConfig({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    const second = fs.readFileSync(out2, "utf-8");
    expect(out1).toBe(out2);
    expect(first).toBe(second);
  });

  it("creates intermediate directories", () => {
    const deep = path.join(tmp, "missing", "deeper");
    const out = writePerCrewOpencodeConfig({ stateRoot: deep, project: "x", taskId: "y" });
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(path.dirname(out)).isDirectory()).toBe(true);
  });
});
