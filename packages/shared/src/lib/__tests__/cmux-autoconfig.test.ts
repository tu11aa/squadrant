import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCmuxAutoConfig } from "../cmux-autoconfig.js";

let dir: string;
let configPath: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmux-auto-"));
  configPath = join(dir, "cmux.json");
  statePath = join(dir, "cmux-autoconfig.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureCmuxAutoConfig", () => {
  it("writes config and reports reachable without a restart prompt", async () => {
    const r = await ensureCmuxAutoConfig({
      configPath,
      statePath,
      probe: async () => "reachable",
    });
    expect(r.configChanged).toBe(true);
    expect(r.verdict).toBe("reachable");
    expect(r.needsRestart).toBe(false);
    expect(r.promptedThisRun).toBe(false);
    expect(existsSync(statePath)).toBe(false); // no marker when nothing to prompt
  });

  it("prompts once when the socket is still denied (config written, restart needed)", async () => {
    const first = await ensureCmuxAutoConfig({
      configPath,
      statePath,
      probe: async () => "denied",
    });
    expect(first.needsRestart).toBe(true);
    expect(first.promptedThisRun).toBe(true);
    expect(existsSync(statePath)).toBe(true);

    // Second run, still denied → must NOT nag again.
    const second = await ensureCmuxAutoConfig({
      configPath,
      statePath,
      probe: async () => "denied",
    });
    expect(second.needsRestart).toBe(true);
    expect(second.promptedThisRun).toBe(false);
  });

  it("clears the prompt marker once the socket becomes reachable", async () => {
    await ensureCmuxAutoConfig({ configPath, statePath, probe: async () => "denied" });
    expect(existsSync(statePath)).toBe(true);

    const r = await ensureCmuxAutoConfig({ configPath, statePath, probe: async () => "reachable" });
    expect(r.promptedThisRun).toBe(false);
    expect(existsSync(statePath)).toBe(false); // marker reset so a future regression re-prompts
  });

  it("does not prompt on an unknown verdict (fail-soft, no nag)", async () => {
    const r = await ensureCmuxAutoConfig({ configPath, statePath, probe: async () => "unknown" });
    expect(r.verdict).toBe("unknown");
    expect(r.needsRestart).toBe(false);
    expect(r.promptedThisRun).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  it("is idempotent on config (no re-write when already set)", async () => {
    writeFileSync(configPath, `{ "automation": { "socketControlMode": "automation" } }\n`);
    const r = await ensureCmuxAutoConfig({ configPath, statePath, probe: async () => "reachable" });
    expect(r.configChanged).toBe(false);
    expect(r.configAlreadySet).toBe(true);
  });
});
