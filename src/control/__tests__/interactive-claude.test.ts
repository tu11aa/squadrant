// src/control/__tests__/interactive-claude.test.ts
import { describe, it, expect } from "vitest";
import { mergeClaudeHooks } from "../interactive/claude.js";

const HOOK_CMD = "cockpit crew _hook";

describe("claude interactive hook merge", () => {
  it("adds Stop+SubagentStop+SessionEnd hooks to empty settings", () => {
    const out = mergeClaudeHooks({}, HOOK_CMD);
    expect(out.hooks.Stop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SubagentStop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SessionEnd[0].hooks[0].command).toContain(HOOK_CMD);
  });

  it("adds a PostToolUse hook (mid-turn liveness) so the heartbeat stays fresh during long turns", () => {
    const out = mergeClaudeHooks({}, HOOK_CMD);
    expect(out.hooks.PostToolUse[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.PostToolUse[0].hooks[0].command).toContain("PostToolUse");
  });

  it("is idempotent — merging twice yields one cockpit entry per event", () => {
    const once = mergeClaudeHooks({}, HOOK_CMD);
    const twice = mergeClaudeHooks(once, HOOK_CMD);
    const cockpitEntries = twice.hooks.Stop.flatMap((m: any) => m.hooks)
      .filter((h: any) => h.command.includes(HOOK_CMD));
    expect(cockpitEntries).toHaveLength(1);
  });

  it("preserves a user's pre-existing unrelated Stop hook", () => {
    const existing = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "user-thing" }] }] } };
    const out = mergeClaudeHooks(existing, HOOK_CMD);
    const cmds = out.hooks.Stop.flatMap((m: any) => m.hooks).map((h: any) => h.command);
    expect(cmds).toContain("user-thing");
    expect(cmds.some((c: string) => c.includes(HOOK_CMD))).toBe(true);
  });

  it("tolerates hooks.Stop being an object {}", () => {
    const out = mergeClaudeHooks({ hooks: { Stop: {} } }, HOOK_CMD);
    expect(Array.isArray(out.hooks.Stop)).toBe(true);
    const cmds = out.hooks.Stop.flatMap((m: any) => m.hooks).map((h: any) => h.command);
    expect(cmds.filter((c: string) => c.includes(HOOK_CMD))).toHaveLength(1);
  });

  it("tolerates hooks.Stop being a string or number", () => {
    for (const bad of ["x", 42]) {
      const out = mergeClaudeHooks({ hooks: { Stop: bad } }, HOOK_CMD);
      expect(Array.isArray(out.hooks.Stop)).toBe(true);
      const cmds = out.hooks.Stop.flatMap((m: any) => m.hooks).map((h: any) => h.command);
      expect(cmds.filter((c: string) => c.includes(HOOK_CMD))).toHaveLength(1);
    }
  });

  it("tolerates a null element and empty-hooks group inside hooks.Stop", () => {
    const out = mergeClaudeHooks({ hooks: { Stop: [null, { matcher: "", hooks: [] }] } }, HOOK_CMD);
    const cmds = out.hooks.Stop.flatMap((m: any) => m?.hooks ?? []).map((h: any) => h.command);
    expect(cmds.some((c: string) => c.includes(HOOK_CMD))).toBe(true);
  });

  it("tolerates a non-array m.hooks inside the array", () => {
    const out = mergeClaudeHooks({ hooks: { Stop: [{ matcher: "", hooks: {} }] } }, HOOK_CMD);
    const cmds = out.hooks.Stop.flatMap((m: any) => (Array.isArray(m?.hooks) ? m.hooks : [])).map((h: any) => h.command);
    expect(cmds.some((c: string) => c.includes(HOOK_CMD))).toBe(true);
  });

  it("adds cockpit hooks when settings has no hooks key at all", () => {
    const out = mergeClaudeHooks({ other: 1 }, HOOK_CMD);
    expect(out.hooks.Stop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SubagentStop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SessionEnd[0].hooks[0].command).toContain(HOOK_CMD);
  });

  it("handles hooks being null", () => {
    const out = mergeClaudeHooks({ hooks: null }, HOOK_CMD);
    expect(out.hooks.Stop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SubagentStop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SessionEnd[0].hooks[0].command).toContain(HOOK_CMD);
  });

  it("registers a Notification hook for instant permission-prompt detection (#notification-hook)", () => {
    const out = mergeClaudeHooks({}, HOOK_CMD);
    expect(out.hooks.Notification).toBeDefined();
    expect(out.hooks.Notification[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.Notification[0].hooks[0].command).toContain("Notification");
  });
});
