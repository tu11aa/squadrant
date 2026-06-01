import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeHookToEvent, detectTrailingQuestion, deriveTranscriptPath, isPermissionNotification } from "../interactive/claude.js";

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
    // NARROW EXCEPTIONS to task.blocked (never task.done/task.failed):
    //   #174: Stop + trailing question → task.blocked
    //   #notification-hook: Notification + permission message → task.blocked
    // This sweep uses {} payloads (no message/question) so neither exception fires —
    // Notification with {} has no message → task.progress, not task.blocked.
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

describe("deriveTranscriptPath (#174 delivery)", () => {
  const SAVED_HOME = process.env.HOME;
  afterEach(() => { process.env.HOME = SAVED_HOME; });

  it("builds ~/.claude/projects/<escaped-cwd>/<session>.jsonl for a normal cwd", () => {
    process.env.HOME = "/home/tester";
    expect(deriveTranscriptPath("sess-123", "/Users/q3labsadmin/me/claude-cockpit"))
      .toBe("/home/tester/.claude/projects/-Users-q3labsadmin-me-claude-cockpit/sess-123.jsonl");
  });

  it("matches the real Claude escaping convention (dots and slashes both → '-')", () => {
    // Verified against the live dir name under ~/.claude/projects:
    // /Users/q3labsadmin/.claude-mem/observer-sessions
    //   -> -Users-q3labsadmin--claude-mem-observer-sessions  (the '/.' becomes '--')
    process.env.HOME = "/home/tester";
    expect(deriveTranscriptPath("s", "/Users/q3labsadmin/.claude-mem/observer-sessions"))
      .toBe("/home/tester/.claude/projects/-Users-q3labsadmin--claude-mem-observer-sessions/s.jsonl");
  });

  it("returns null when sessionId is missing", () => {
    expect(deriveTranscriptPath("", "/Users/x")).toBeNull();
    expect(deriveTranscriptPath(undefined as unknown as string, "/Users/x")).toBeNull();
  });

  it("returns null when cwd is missing", () => {
    expect(deriveTranscriptPath("sess", "")).toBeNull();
    expect(deriveTranscriptPath("sess", undefined as unknown as string)).toBeNull();
  });
});

describe("mapClaudeHookToEvent Stop derived-path fallback (#174 delivery)", () => {
  const TID = "task-abc";
  const SAVED_HOME = process.env.HOME;
  let home: string;

  const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const user = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

  // Lay down a fake ~/.claude/projects/<escaped-cwd>/<session>.jsonl under a tmp HOME
  // so the derived-path branch reads a real file without touching the real home.
  function writeDerivedTranscript(cwd: string, sessionId: string, entries: unknown[]): void {
    const escaped = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projDir = join(home, ".claude", "projects", escaped);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${sessionId}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
  }

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "cp-home-")); process.env.HOME = home; });
  afterEach(() => { process.env.HOME = SAVED_HOME; rmSync(home, { recursive: true, force: true }); });

  it("no transcript_path but session_id+cwd resolve to a transcript ending in a question → task.blocked", () => {
    const cwd = "/Users/q3labsadmin/me/claude-cockpit";
    writeDerivedTranscript(cwd, "sess-q", [user("go"), assistant("Which config file should I edit?")]);
    const ev = mapClaudeHookToEvent("Stop", { session_id: "sess-q", cwd }, TID);
    expect(ev).toEqual({
      type: "task.blocked",
      id: TID,
      reason: "crew asked a question (auto-detected)",
      question: "Which config file should I edit?",
    });
  });

  it("no transcript_path, derived transcript ends in a statement → task.turn.completed", () => {
    const cwd = "/Users/q3labsadmin/me/claude-cockpit";
    writeDerivedTranscript(cwd, "sess-s", [user("go"), assistant("Done. Pushed the branch.")]);
    const ev = mapClaudeHookToEvent("Stop", { session_id: "sess-s", cwd }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("transcript_path present but unreadable → falls through to derived path (question) → task.blocked", () => {
    const cwd = "/Users/q3labsadmin/me/claude-cockpit";
    writeDerivedTranscript(cwd, "sess-fb", [user("go"), assistant("Should I delete the old branch?")]);
    const ev = mapClaudeHookToEvent(
      "Stop",
      { transcript_path: join(home, "does-not-exist.jsonl"), session_id: "sess-fb", cwd },
      TID,
    );
    expect(ev).toEqual({
      type: "task.blocked",
      id: TID,
      reason: "crew asked a question (auto-detected)",
      question: "Should I delete the old branch?",
    });
  });

  it("neither transcript_path nor session_id → task.turn.completed, never throws", () => {
    const ev = mapClaudeHookToEvent("Stop", { cwd: "/Users/q3labsadmin/me/claude-cockpit" }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("session_id+cwd present but no transcript file on disk → task.turn.completed, never throws", () => {
    const ev = mapClaudeHookToEvent("Stop", { session_id: "missing", cwd: "/Users/q3labsadmin/me/claude-cockpit" }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });
});

describe("isPermissionNotification", () => {
  it("returns true when message contains 'permission'", () => {
    expect(isPermissionNotification("Claude needs your permission to use Bash")).toBe(true);
    expect(isPermissionNotification("This operation requires permission")).toBe(true);
    expect(isPermissionNotification("permission to write file")).toBe(true);
  });

  it("returns true when message contains 'approve'", () => {
    expect(isPermissionNotification("Please approve this action")).toBe(true);
    expect(isPermissionNotification("Approve the tool use to continue")).toBe(true);
  });

  it("returns false for idle/liveness notifications (not permission requests)", () => {
    expect(isPermissionNotification("Waiting for your input")).toBe(false);
    expect(isPermissionNotification("Claude is thinking...")).toBe(false);
    expect(isPermissionNotification("I've finished the task and pushed the branch.")).toBe(false);
  });

  it("returns false for empty or whitespace string", () => {
    expect(isPermissionNotification("")).toBe(false);
    expect(isPermissionNotification("   ")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPermissionNotification("Claude Needs Your PERMISSION to run")).toBe(true);
    expect(isPermissionNotification("APPROVE this command")).toBe(true);
  });
});

describe("mapClaudeHookToEvent Notification (instant permission detection, #notification-hook)", () => {
  const TID = "task-abc";

  it("permission message → task.blocked with reason='crew awaiting permission (notification hook)' and question=message", () => {
    const msg = "Claude needs your permission to use Bash";
    const ev = mapClaudeHookToEvent("Notification", { message: msg }, TID);
    expect(ev).toEqual({
      type: "task.blocked",
      id: TID,
      reason: "crew awaiting permission (notification hook)",
      question: msg,
    });
  });

  it("idle/non-permission message → task.progress with note 'notification'", () => {
    expect(mapClaudeHookToEvent("Notification", { message: "Waiting for your input" }, TID))
      .toEqual({ type: "task.progress", id: TID, note: "notification" });
  });

  it("missing message field → task.progress, never throws", () => {
    expect(mapClaudeHookToEvent("Notification", {}, TID))
      .toEqual({ type: "task.progress", id: TID, note: "notification" });
  });

  it("null payload → task.progress, never throws", () => {
    expect(mapClaudeHookToEvent("Notification", null, TID))
      .toEqual({ type: "task.progress", id: TID, note: "notification" });
  });

  it("undefined payload → task.progress, never throws", () => {
    expect(mapClaudeHookToEvent("Notification", undefined, TID))
      .toEqual({ type: "task.progress", id: TID, note: "notification" });
  });

  it("non-string message (e.g. a number) → task.progress, never throws", () => {
    expect(mapClaudeHookToEvent("Notification", { message: 42 }, TID))
      .toEqual({ type: "task.progress", id: TID, note: "notification" });
  });

  it("empty message string → task.progress (not a permission request)", () => {
    expect(mapClaudeHookToEvent("Notification", { message: "" }, TID))
      .toEqual({ type: "task.progress", id: TID, note: "notification" });
  });

  it("NEVER emits task.done or task.failed regardless of message", () => {
    for (const msg of ["needs your permission", "please approve", "approve this", ""]) {
      const ev = mapClaudeHookToEvent("Notification", { message: msg }, TID);
      if (ev) {
        expect(ev.type).not.toBe("task.done");
        expect(ev.type).not.toBe("task.failed");
      }
    }
  });
});

// Verified against claude-cli 2.1.156: the real Stop payload carries the final
// assistant text DIRECTLY as `last_assistant_message` (full text incl. trailing
// question, no transcript I/O). This is the primary #174 detection source — it
// must win over transcript files and work even when none exist on disk.
describe("mapClaudeHookToEvent Stop last_assistant_message (#174 primary source)", () => {
  const TID = "task-abc";

  it("trailing question in last_assistant_message → task.blocked (no transcript needed)", () => {
    const ev = mapClaudeHookToEvent(
      "Stop",
      { last_assistant_message: "I've drafted the change. Which config file should I edit?" },
      TID,
    );
    expect(ev).toEqual({
      type: "task.blocked",
      id: TID,
      reason: "crew asked a question (auto-detected)",
      question: "I've drafted the change. Which config file should I edit?",
    });
  });

  it("statement in last_assistant_message → task.turn.completed", () => {
    const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Done. Pushed the branch." }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("last_assistant_message wins over a transcript_path that ends in a statement", () => {
    // payload field says question; transcript (unread) is irrelevant — no I/O happens.
    const ev = mapClaudeHookToEvent(
      "Stop",
      { last_assistant_message: "Should I delete the old branch?", transcript_path: "/no/such/file.jsonl" },
      TID,
    );
    expect(ev).toEqual({
      type: "task.blocked",
      id: TID,
      reason: "crew asked a question (auto-detected)",
      question: "Should I delete the old branch?",
    });
  });

  it("empty/whitespace last_assistant_message falls through to transcript resolution", () => {
    const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "   " }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });
});
