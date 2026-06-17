import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runConfigCheck } from "../config.js";
import { getDefaultConfig } from "@cockpit/shared";

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-cfg-"));
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
    expect(onDisk._cockpitVersion).toBe("0.5.3");
  });

  it("--fix does NOT stamp when advisory/invalid drift remains", () => {
    writeUser((c) => { (c.defaults.roles as any).crew = { agent: "claude", model: "sonnet" }; });
    const res = runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: true, accept: false });
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk._cockpitVersion).toBeUndefined();
    expect(res.remaining.some((i) => i.kind === "changed-default")).toBe(true);
  });

  it("--accept stamps without changing config", () => {
    writeUser((c) => { (c.defaults.roles as any).crew = { agent: "claude", model: "sonnet" }; });
    runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: false, accept: true });
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk._cockpitVersion).toBe("0.5.3");
    expect(onDisk.defaults.roles.crew.model).toBe("sonnet");
  });
});
