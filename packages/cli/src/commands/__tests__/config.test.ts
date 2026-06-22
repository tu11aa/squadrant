import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runConfigCheck, runConfigGet, runConfigSet } from "../config.js";
import { getDefaultConfig } from "@squadrant/shared";

const __thisDir = dirname(fileURLToPath(import.meta.url));
// Built CLI lives at <repo>/dist/index.js — five levels up from packages/cli/src/commands/__tests__/
const DIST_CLI = join(__thisDir, "..", "..", "..", "..", "..", "dist", "index.js");

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-cfg-"));
  cfgPath = path.join(dir, "config.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeUser(over: (c: ReturnType<typeof getDefaultConfig>) => void) {
  const c = getDefaultConfig();
  over(c);
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
}

describe("runConfigCheck", () => {
  it("reports drift without mutating when no flags given", () => {
    writeUser((c) => { delete (c.defaults as any).worktreeDir; });
    const res = runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: false, accept: false });
    expect(res.items.some((i) => i.path === "defaults.worktreeDir" && i.kind === "missing")).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.worktreeDir).toBeUndefined();
  });

  it("--fix applies safe items, writes config, and stamps when clean", () => {
    writeUser((c) => { delete (c.defaults as any).worktreeDir; });
    const res = runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: true, accept: false });
    expect(res.applied).toContain("defaults.worktreeDir");
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.worktreeDir).toBe(getDefaultConfig().defaults.worktreeDir);
    expect(onDisk._squadrantVersion).toBe("0.5.3");
  });

  it("--fix does NOT stamp when advisory/invalid drift remains", () => {
    writeUser((c) => { (c.defaults.roles as any).crew = { agent: "claude", model: "sonnet" }; });
    const res = runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: true, accept: false });
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk._squadrantVersion).toBeUndefined();
    expect(res.remaining.some((i) => i.kind === "changed-default")).toBe(true);
  });

  it("--accept stamps without changing config", () => {
    writeUser((c) => { (c.defaults.roles as any).crew = { agent: "claude", model: "sonnet" }; });
    runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: false, accept: true });
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk._squadrantVersion).toBe("0.5.3");
    expect(onDisk.defaults.roles.crew.model).toBe("sonnet");
  });
});

describe("runConfigGet / runConfigSet (dotted path)", () => {
  it("reads a nested value by dotted key", () => {
    writeUser((c) => { c.defaults.effort = "low"; });
    expect(runConfigGet("defaults.effort", cfgPath)).toBe("low");
  });

  it("throws on an unknown key", () => {
    writeUser(() => {});
    expect(() => runConfigGet("defaults.nope.deep", cfgPath)).toThrow();
  });

  it("sets a nested string value and persists it", () => {
    writeUser(() => {});
    runConfigSet("defaults.effort", "max", cfgPath);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.effort).toBe("max");
  });

  it("parses JSON-looking values (numbers/bools) but keeps bare strings", () => {
    writeUser(() => {});
    runConfigSet("defaults.maxCrew", "9", cfgPath);
    runConfigSet("defaults.effort", "balance", cfgPath);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.maxCrew).toBe(9);
    expect(onDisk.defaults.effort).toBe("balance");
  });
});

// #363: readPkgVersion() used "../../package.json" relative to import.meta.url
// which overshoots to the parent of the repo root when bundled in dist/index.js.
// Fixed to "../package.json" (one level up from dist/, landing on repo root).
// This test runs the built CLI from /tmp to confirm no ENOENT (#363 regression).
describe("readPkgVersion (bundled path, #363)", () => {
  it.skipIf(!fs.existsSync(DIST_CLI))("config check does not ENOENT when invoked from outside the repo", () => {
    const result = spawnSync("node", [DIST_CLI, "config", "check"], {
      cwd: os.tmpdir(),
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, SQUADRANT_DAEMON_SKIP: "1" },
    });
    expect(result.stderr ?? "").not.toMatch(/ENOENT/);
    expect(result.error).toBeUndefined();
  });
});
