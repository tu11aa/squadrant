import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  stateRoot, logsRoot, daemonLogPath, reservedStateNameError, sessionsPath, legacyStateDir, legacyDaemonLogPath, legacySessionsPath, stateSeedMarkerPath, seedStateFromLegacy, resolveReadPath,
} from "../state-paths.js";

const KEYS = ["SQUADRANT_STATE_DIR", "SQUADRANT_CONFIG", "XDG_STATE_HOME"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("stateRoot / logsRoot (#983 6a)", () => {
  it("defaults to ~/.local/state/squadrant", () => {
    expect(stateRoot()).toBe(path.join(os.homedir(), ".local", "state", "squadrant"));
    expect(logsRoot()).toBe(path.join(os.homedir(), ".local", "state", "squadrant", "logs"));
  });

  it("honours XDG_STATE_HOME", () => {
    process.env.XDG_STATE_HOME = "/tmp/xdg";
    expect(stateRoot()).toBe("/tmp/xdg/squadrant");
    expect(logsRoot()).toBe("/tmp/xdg/squadrant/logs");
  });

  it("SQUADRANT_STATE_DIR wins over everything", () => {
    process.env.XDG_STATE_HOME = "/tmp/xdg";
    process.env.SQUADRANT_CONFIG = "/tmp/x/config.json";
    process.env.SQUADRANT_STATE_DIR = "/tmp/s";
    expect(stateRoot()).toBe("/tmp/s");
    expect(logsRoot()).toBe("/tmp/s/logs");
    expect(daemonLogPath()).toBe("/tmp/s/logs/squadrantd.log");
    expect(sessionsPath()).toBe("/tmp/s/sessions.json");
  });

  it("a non-default SQUADRANT_CONFIG keeps state beside it (isolated harnesses)", () => {
    process.env.XDG_STATE_HOME = "/tmp/xdg";
    process.env.SQUADRANT_CONFIG = "/tmp/x/config.json";
    expect(stateRoot()).toBe("/tmp/x/state");
    expect(logsRoot()).toBe("/tmp/x/state/logs");
  });

  it("SQUADRANT_CONFIG at the default path does not map back to the legacy dir", () => {
    process.env.SQUADRANT_CONFIG = path.join(os.homedir(), ".config", "squadrant", "config.json");
    expect(stateRoot()).toBe(path.join(os.homedir(), ".local", "state", "squadrant"));
    process.env.XDG_STATE_HOME = "/tmp/xdg";
    expect(stateRoot()).toBe("/tmp/xdg/squadrant");
  });

  it("legacyStateDir is the old ~/.config location; the marker sits in the new root", () => {
    const cfgDir = path.join(os.homedir(), ".config", "squadrant");
    expect(legacyStateDir()).toBe(path.join(cfgDir, "state"));
    expect(legacyDaemonLogPath()).toBe(path.join(cfgDir, "squadrantd.log"));
    expect(legacySessionsPath()).toBe(path.join(cfgDir, "sessions.json"));
    process.env.SQUADRANT_STATE_DIR = "/tmp/s";
    expect(stateSeedMarkerPath()).toBe("/tmp/s/.seeded-from-legacy");
  });
});

describe("seedStateFromLegacy (#983 6a dual-read)", () => {
  let tmp: string; let legacy: string; let root: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "state-seed-"));
    legacy = path.join(tmp, "legacy"); root = path.join(tmp, "new");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

  it("copies legacy data into the new root, never overwrites, never deletes", () => {
    write(path.join(legacy, "proj", "tasks", "a.json"), "legacy-a");
    write(path.join(legacy, "liveness.json"), "legacy-live");
    write(path.join(root, "liveness.json"), "new-live");

    expect(seedStateFromLegacy({ root, legacy }).seeded).toBe(true);
    expect(fs.readFileSync(path.join(root, "proj", "tasks", "a.json"), "utf8")).toBe("legacy-a");
    expect(fs.readFileSync(path.join(root, "liveness.json"), "utf8")).toBe("new-live");
    expect(fs.readFileSync(path.join(legacy, "proj", "tasks", "a.json"), "utf8")).toBe("legacy-a");
    expect(fs.existsSync(path.join(root, ".seeded-from-legacy"))).toBe(true);
  });

  it("is a no-op once the marker exists (consumed data is not resurrected)", () => {
    write(path.join(legacy, "inbox", "m.json"), "x");
    seedStateFromLegacy({ root, legacy });
    fs.rmSync(path.join(root, "inbox", "m.json"));
    expect(seedStateFromLegacy({ root, legacy }).seeded).toBe(false);
    expect(fs.existsSync(path.join(root, "inbox", "m.json"))).toBe(false);
  });

  it("does nothing when there is no legacy data, or legacy is the root itself", () => {
    expect(seedStateFromLegacy({ root, legacy }).seeded).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
    write(path.join(legacy, "a.json"), "x");
    expect(seedStateFromLegacy({ root: legacy, legacy }).seeded).toBe(false);
    expect(fs.existsSync(path.join(legacy, ".seeded-from-legacy"))).toBe(false);
  });
});

describe("resolveReadPath (#983 6a single-file fallback)", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "state-read-")); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("prefers the new path, falls back to legacy, else returns the new path", () => {
    const next = path.join(tmp, "new.json"); const old = path.join(tmp, "old.json");
    expect(resolveReadPath(next, old)).toBe(next);
    fs.writeFileSync(old, "o");
    expect(resolveReadPath(next, old)).toBe(old);
    fs.writeFileSync(next, "n");
    expect(resolveReadPath(next, old)).toBe(next);
  });
});

describe("no hardcoded legacy state root in packages (#983 6a grep-test)", () => {
  it("every state path goes through stateRoot()", () => {
    const repo = path.resolve(__dirname, "../../../../..");
    const bad = [
      ".config/squadrant/state",
      '".config", "squadrant", "state"',
      'CONFIG_DIR, "state")',
      'DEFAULT_CONFIG_PATH), "state")',
      'dirname(stateRoot)',
    ];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        // state-paths.ts is the one home of the legacy-fallback path.
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && e.name !== "state-paths.ts") {
          const src = fs.readFileSync(p, "utf8");
          for (const b of bad) if (src.includes(b)) hits.push(`${path.relative(repo, p)}: ${b}`);
        }
      }
    };
    walk(path.join(repo, "packages"));
    expect(hits).toEqual([]);
  });
});

describe("reservedStateNameError (#983 6a flat layout guard)", () => {
  it("rejects project names that would collide with state-root entries", () => {
    for (const n of ["audit", "logs", "inbox", "rules-inject", "_results", "_x", ".hidden"]) {
      const err = reservedStateNameError(n);
      expect(err).toContain(`'${n}'`);
      expect(err).toMatch(/reserved/);
    }
    for (const n of ["flooros", "squadrant", "my_app", "a.b"]) expect(reservedStateNameError(n)).toBeNull();
  });
});
