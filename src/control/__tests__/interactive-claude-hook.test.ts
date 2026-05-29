import { describe, it, expect } from "vitest";
import { mapClaudeHookToEvent } from "../interactive/claude.js";

describe("mapClaudeHookToEvent", () => {
  const TID = "task-abc";

  it("maps Stop → task.turn.completed (turn boundary → awaiting-input, #131)", () => {
    const ev = mapClaudeHookToEvent("Stop", { session_id: "x" }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("maps SubagentStop → task.progress with note 'subagentstop'", () => {
    const ev = mapClaudeHookToEvent("SubagentStop", {}, TID);
    expect(ev).toEqual({ type: "task.progress", id: TID, note: "subagentstop" });
  });

  it("maps SessionEnd → task.progress with note 'sessionend' (NOT terminal)", () => {
    const ev = mapClaudeHookToEvent("SessionEnd", { reason: "exit" }, TID);
    expect(ev).toEqual({ type: "task.progress", id: TID, note: "sessionend" });
  });

  // PostToolUse fires after every tool call MID-turn, so it keeps the
  // heartbeat fresh during long working turns (fixes false CREW STALLED).
  // It must map to liveness, never a terminal state.
  it("maps PostToolUse → task.progress with note 'posttooluse' (mid-turn liveness, NOT terminal)", () => {
    const ev = mapClaudeHookToEvent("PostToolUse", { tool_name: "Bash" }, TID);
    expect(ev).toEqual({ type: "task.progress", id: TID, note: "posttooluse" });
  });

  it("unknown event → null", () => {
    expect(mapClaudeHookToEvent("UserPromptSubmit", {}, TID)).toBeNull();
    expect(mapClaudeHookToEvent("PreToolUse", {}, TID)).toBeNull();
    expect(mapClaudeHookToEvent("", {}, TID)).toBeNull();
  });

  it("anti-#2576 invariant: NO input produces task.done or task.failed", () => {
    // Walk the entire known Claude hook event surface plus the bare-name aliases
    // a careless implementation might emit.
    const ALL_KNOWN = [
      "Stop",
      "SubagentStop",
      "SessionEnd",
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "Notification",
    ];
    for (const evName of ALL_KNOWN) {
      const ev = mapClaudeHookToEvent(evName, {}, TID);
      if (ev) {
        expect(ev.type).not.toBe("task.done");
        expect(ev.type).not.toBe("task.failed");
        expect(ev.type).not.toBe("task.blocked");
      }
    }
  });

  it("payload is not required (Claude payloads vary)", () => {
    expect(mapClaudeHookToEvent("Stop", undefined, TID)).not.toBeNull();
    expect(mapClaudeHookToEvent("Stop", null, TID)).not.toBeNull();
  });
});
