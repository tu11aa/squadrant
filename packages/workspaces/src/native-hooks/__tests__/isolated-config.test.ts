// #1046: a daemon under an isolated SQUADRANT_CONFIG must never write the
// user's global ~/.claude/settings.json. Real fs, temp HOME — no injected I/O,
// so the default-path resolution itself is what is under test.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeHooks } from "../native-hook-source.js";

const CLI = "'/dev/node' '/dev/dist/index.js'";

describe("installClaudeHooks — #1046 isolated SQUADRANT_CONFIG", () => {
  let root: string;
  let home: string;
  const saved = { HOME: process.env.HOME, SQUADRANT_CONFIG: process.env.SQUADRANT_CONFIG };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sq-1046-"));
    home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    process.env.HOME = home;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("never writes the global settings path; writes the isolated config's own file seeded from it", () => {
    const globalPath = join(home, ".claude", "settings.json");
    const globalRaw = JSON.stringify({
      enabledPlugins: { "x@y": true },
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "'/prod/node' '/prod/lib/node_modules/squadrant/dist/index.js' hooks claude stop", timeout: 10 }] }] },
    }, null, 2);
    writeFileSync(globalPath, globalRaw);
    process.env.SQUADRANT_CONFIG = join(root, "dev", "config.json");

    const written = installClaudeHooks({ cliCmd: CLI });

    expect(readFileSync(globalPath, "utf-8")).toBe(globalRaw);
    expect(written).toBe(join(root, "dev", "claude-settings.json"));
    const isolated = JSON.parse(readFileSync(written, "utf-8"));
    expect(isolated.enabledPlugins).toEqual({ "x@y": true });
    const stopCmds = isolated.hooks.Stop.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    expect(stopCmds).toEqual([`${CLI} hooks claude stop`]);
  });

  it("writes the isolated file even when no global settings exist", () => {
    process.env.SQUADRANT_CONFIG = join(root, "dev", "config.json");
    installClaudeHooks({ cliCmd: CLI });
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(root, "dev", "claude-settings.json"))).toBe(true);
  });

  it("default config (no SQUADRANT_CONFIG) still targets ~/.claude/settings.json", () => {
    delete process.env.SQUADRANT_CONFIG;
    expect(installClaudeHooks({ cliCmd: CLI })).toBe(join(home, ".claude", "settings.json"));
  });
});
