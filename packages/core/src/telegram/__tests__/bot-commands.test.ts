import { describe, it, expect } from "vitest";
import { BOT_COMMANDS } from "../bot-commands.js";

describe("BOT_COMMANDS", () => {
  it("exposes the curated user-facing menu", () => {
    const names = BOT_COMMANDS.map((c) => c.command);
    expect(names).toEqual(["status", "projects", "crews", "launch", "effort", "spawn", "notify", "mute", "unmute", "help"]);
    for (const c of BOT_COMMANDS) expect(c.description.length).toBeGreaterThan(0);
  });

  it("includes effort, excludes config", () => {
    const names = BOT_COMMANDS.map((c) => c.command);
    expect(names).toContain("effort");
    expect(names).not.toContain("config");
  });
});
