// src/__tests__/config.telegram.test.ts
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";

describe("telegram config", () => {
  it("round-trips a telegram block through loadConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        commandName: "x",
        hubVault: "/tmp/hub",
        projects: {},
        defaults: { maxCrew: 5, worktreeDir: ".w", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
        metrics: { enabled: false, path: "/tmp/m.json" },
        telegram: { botToken: "123:ABC", chats: { cockpit: -100123 } },
      }),
    );
    const cfg = loadConfig(p);
    expect(cfg.telegram?.botToken).toBe("123:ABC");
    expect(cfg.telegram?.chats.cockpit).toBe(-100123);
  });

  it("leaves telegram undefined when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        commandName: "x",
        hubVault: "/tmp/hub",
        projects: {},
        defaults: { maxCrew: 5, worktreeDir: ".w", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
        metrics: { enabled: false, path: "/tmp/m.json" },
      }),
    );
    expect(loadConfig(p).telegram).toBeUndefined();
  });
});
