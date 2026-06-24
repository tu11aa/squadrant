import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writePerCrewSettings,
  writePerCrewSettingsLocal,
  writePerCrewOpencodeConfig,
  healStaleCockpitRefs,
  CREW_PERMISSION_ALLOWLIST,
  mergeCrewPermissions,
} from "../per-crew-settings.js";

describe("writePerCrewSettings", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-per-crew-"));
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
    // Each event has an entry pointing at `squadrant crew _hook <event>`.
    const stopCmd = json.hooks.Stop[0].hooks[0].command;
    expect(stopCmd).toContain("squadrant crew _hook");
    expect(stopCmd).toContain("Stop");
  });

  it("includes a PostToolUse liveness hook (mid-turn heartbeat → fixes false CREW STALLED)", () => {
    const out = writePerCrewSettings({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    const json = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(Array.isArray(json.hooks.PostToolUse)).toBe(true);
    const cmd = json.hooks.PostToolUse[0].hooks[0].command;
    expect(cmd).toContain("squadrant crew _hook");
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-local-"));
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

describe("healStaleCockpitRefs — self-heal pre-rebrand tokens", () => {
  it("rewrites the hook command, config path, and hub vault tokens", () => {
    const raw = [
      "cockpit crew _hook Stop",
      "~/.config/cockpit/scripts/write-status.sh",
      "//Users/me/cockpit-hub/spokes/x/**",
    ].join("\n");
    expect(healStaleCockpitRefs(raw)).toBe(
      [
        "squadrant crew _hook Stop",
        "~/.config/squadrant/scripts/write-status.sh",
        "//Users/me/squadrant-hub/spokes/x/**",
      ].join("\n"),
    );
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = healStaleCockpitRefs("cockpit crew _hook Stop");
    expect(healStaleCockpitRefs(once)).toBe(once);
  });

  it("leaves unrelated text (e.g. Bash(cockpit:*)) untouched", () => {
    const raw = 'Bash(cockpit:*)';
    expect(healStaleCockpitRefs(raw)).toBe(raw);
  });
});

describe("writePerCrewSettingsLocal — self-heals stale cockpit hooks in existing file", () => {
  let tmp: string;
  const settingsPath = () => path.join(tmp, ".claude", "settings.local.json");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-heal-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rewrites pre-rebrand 'cockpit crew _hook' commands left in the file", () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "cockpit crew _hook Stop" }] }] },
        permissions: { allow: ["Bash(~/.config/cockpit/scripts/write-status.sh:*)"] },
      }, null, 2),
    );
    writePerCrewSettingsLocal({ projectCwd: tmp });
    const raw = fs.readFileSync(settingsPath(), "utf-8");
    expect(raw).not.toContain("cockpit crew _hook");
    expect(raw).not.toContain(".config/cockpit");
    expect(raw).toContain("squadrant crew _hook");
  });
});

describe("CREW_PERMISSION_ALLOWLIST — read-only and safe dev commands", () => {
  it("includes process/system read commands", () => {
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(ps:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(pgrep:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(lsof:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(top -l:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(uptime:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(whoami:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(uname:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(date:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(env:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(sysctl:*)");
  });

  it("includes file read/nav commands", () => {
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(ls:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(cat:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(head:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(tail:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(wc:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(grep:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(rg:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(find:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(pwd:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(stat:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(file:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(realpath:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(basename:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(dirname:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(du:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(df:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(tree:*)");
  });

  it("includes read-only text processing commands", () => {
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(sort:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(uniq:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(cut:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(tr:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(jq:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(diff:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(column:*)");
  });

  it("includes harmless utility commands", () => {
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(echo:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(which:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(true:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(sleep:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(printf:*)");
  });

  it("includes safe dev query commands", () => {
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(git show:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(git rev-parse:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(git remote -v:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(git stash list:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(npm ls:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(npm view:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(node --version:*)");
    expect(CREW_PERMISSION_ALLOWLIST).toContain("Bash(pnpm ls:*)");
  });

  it("does NOT include destructive, network, or privilege-escalation commands", () => {
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(rm:*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(curl:*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(wget:*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(sudo:*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(kill:*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(pkill:*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(git reset:*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(git clean:*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(git config:*)");
    expect(CREW_PERMISSION_ALLOWLIST).not.toContain("Bash(npm publish:*)");
  });
});

describe("mergeCrewPermissions", () => {
  it("adds all CREW_PERMISSION_ALLOWLIST entries to an empty settings object", () => {
    const result = mergeCrewPermissions({});
    const perms = result.permissions as { allow: string[] };
    for (const entry of CREW_PERMISSION_ALLOWLIST) {
      expect(perms.allow).toContain(entry);
    }
  });

  it("de-duplicates when existing allow already contains some allowlist entries", () => {
    const existing = { permissions: { allow: ["Bash(git commit:*)", "Bash(custom:*)"] } };
    const result = mergeCrewPermissions(existing);
    const perms = result.permissions as { allow: string[] };
    const counts = new Map<string, number>();
    for (const e of perms.allow) counts.set(e, (counts.get(e) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
  });

  it("preserves existing deny and ask keys alongside the merged allow", () => {
    const existing = {
      permissions: { allow: [], deny: ["Bash(sudo:*)"], ask: ["Bash(ssh:*)"] },
    };
    const result = mergeCrewPermissions(existing) as {
      permissions: { allow: string[]; deny: string[]; ask: string[] };
    };
    expect(result.permissions.deny).toEqual(["Bash(sudo:*)"]);
    expect(result.permissions.ask).toEqual(["Bash(ssh:*)"]);
  });

  it("does not mutate the input object", () => {
    const input = { permissions: { allow: ["Bash(python3:*)"] } };
    const snapshot = JSON.stringify(input);
    mergeCrewPermissions(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("writePerCrewOpencodeConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-per-crew-opencode-"));
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

  it("defaults bash to 'allow' (CP3 opt-in: default behavior unchanged)", () => {
    const out = writePerCrewOpencodeConfig({ stateRoot: tmp, project: "alpha", taskId: "tid-1" });
    const json = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(json.permission.bash).toBe("allow");
  });

  it("gateBash:true sets bash to 'ask' so the captain approves shell commands", () => {
    const out = writePerCrewOpencodeConfig({ stateRoot: tmp, project: "alpha", taskId: "tid-1", gateBash: true });
    const json = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(json.permission.bash).toBe("ask");
    // Only bash flips — every other tool stays auto-approved (surgical gate).
    expect(json.permission.edit).toBe("allow");
    expect(json.permission.read).toBe("allow");
    expect(json.permission.external_directory).toEqual({ "**": "allow" });
  });
});
