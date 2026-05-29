import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeHookToEvent, detectTrailingQuestion } from "../interactive/claude.js";

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

describe("detectTrailingQuestion", () => {
  it("returns the question when the last non-empty line ends with '?'", () => {
    expect(detectTrailingQuestion("I looked into it.\n\nWhich auth approach should I use?"))
      .toBe("Which auth approach should I use?");
  });

  it("returns null for a plain statement / done-summary", () => {
    expect(detectTrailingQuestion("Done. All tests pass and the branch is pushed.")).toBeNull();
    expect(detectTrailingQuestion(
      "Summary:\n- Added the parser\n- Wrote tests\n- Pushed the branch.")).toBeNull();
  });

  it("ignores a question that lives inside a fenced code block", () => {
    const text = "Here is the snippet:\n```ts\n// is this right?\nconst x = 1;\n```";
    expect(detectTrailingQuestion(text)).toBeNull();
  });

  it("ignores a rhetorical mid-text question (only the trailing line counts)", () => {
    const text = "Why does this fail? Because the path was wrong. I fixed it and pushed.";
    expect(detectTrailingQuestion(text)).toBeNull();
  });

  it("returns null for empty / whitespace input", () => {
    expect(detectTrailingQuestion("")).toBeNull();
    expect(detectTrailingQuestion("   \n  \n")).toBeNull();
  });
});

describe("mapClaudeHookToEvent Stop transcript path (#174)", () => {
  const TID = "task-abc";
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-transcript-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeTranscript(entries: unknown[]): string {
    const p = join(dir, "transcript.jsonl");
    writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n"));
    return p;
  }

  const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const user = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

  it("Stop + transcript whose last assistant message is a question → task.blocked with the question", () => {
    const path = writeTranscript([user("go"), assistant("Which database should I target?")]);
    const ev = mapClaudeHookToEvent("Stop", { transcript_path: path }, TID);
    expect(ev).toEqual({
      type: "task.blocked",
      id: TID,
      reason: "crew asked a question (auto-detected)",
      question: "Which database should I target?",
    });
  });

  it("Stop + transcript whose last assistant message is a statement → task.turn.completed", () => {
    const path = writeTranscript([user("go"), assistant("Done. Pushed the branch.")]);
    const ev = mapClaudeHookToEvent("Stop", { transcript_path: path }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("Stop with no transcript_path → task.turn.completed (unchanged fallback)", () => {
    const ev = mapClaudeHookToEvent("Stop", { session_id: "x" }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("Stop + nonexistent / malformed transcript path → task.turn.completed, never throws", () => {
    expect(mapClaudeHookToEvent("Stop", { transcript_path: join(dir, "nope.jsonl") }, TID))
      .toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, "{not json\n{also not json");
    expect(mapClaudeHookToEvent("Stop", { transcript_path: bad }, TID))
      .toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });
});
