import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeHookToEvent, detectTrailingQuestion, deriveTranscriptPath, isPermissionNotification, formatAskUserQuestionPrompt, hasActiveBackgroundWork } from "../interactive/claude.js";

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

  // #139: SessionEnd means the crew session is GONE. It must NOT be liveness —
  // mapping it to task.progress resumed a dead crew to 'working', which the
  // watchdog then false-stalled ~budget later. It maps to task.session.ended,
  // which the reducer terminalizes (→ cancelled). Only PostToolUse and
  // SubagentStop count as resume-liveness.
  it("maps SessionEnd → task.session.ended (terminal, NOT liveness) (#139)", () => {
    const ev = mapClaudeHookToEvent("SessionEnd", { reason: "exit" }, TID);
    expect(ev).toEqual({ type: "task.session.ended", id: TID });
  });

  // PostToolUse fires after every tool call MID-turn, so it keeps the
  // heartbeat fresh during long working turns (fixes false CREW STALLED).
  // It must map to liveness, never a terminal state.
  it("maps PostToolUse → task.progress with note 'posttooluse' (mid-turn liveness, NOT terminal)", () => {
    const ev = mapClaudeHookToEvent("PostToolUse", { tool_name: "Bash" }, TID);
    expect(ev).toEqual({ type: "task.progress", id: TID, note: "posttooluse" });
  });

  it("unknown event → null", () => {
    expect(mapClaudeHookToEvent("PreToolUse", {}, TID)).toBeNull();
    expect(mapClaudeHookToEvent("", {}, TID)).toBeNull();
  });

  it("UserPromptSubmit → task.first-turn.confirmed (#470)", () => {
    const ev = mapClaudeHookToEvent("UserPromptSubmit", {}, TID);
    expect(ev).toEqual({ type: "task.first-turn.confirmed", id: TID });
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

// #560: AskUserQuestion is a TOOL call, not a hook event — Claude fires PreToolUse
// (matcher-scoped to "AskUserQuestion") right as the modal opens and blocks the
// turn awaiting a human selection. Before this, a crew's own hook set had no
// PreToolUse coverage at all, so it emitted nothing and the daemon never learned
// the crew was blocked.
describe("formatAskUserQuestionPrompt (#560 — real question/options text)", () => {
  it("formats a single question with its options", () => {
    const toolInput = {
      questions: [
        { question: "Which auth approach?", header: "Auth", multiSelect: false, options: [
          { label: "OAuth", description: "..." },
          { label: "API key", description: "..." },
        ] },
      ],
    };
    expect(formatAskUserQuestionPrompt(toolInput)).toBe("Which auth approach? (options: OAuth, API key)");
  });

  it("formats multiple questions, joined", () => {
    const toolInput = {
      questions: [
        { question: "Ship now?", options: [{ label: "Yes" }, { label: "No" }] },
        { question: "Which env?", options: [{ label: "staging" }, { label: "prod" }] },
      ],
    };
    expect(formatAskUserQuestionPrompt(toolInput)).toBe(
      "Ship now? (options: Yes, No) | Which env? (options: staging, prod)",
    );
  });

  it("formats a question with no options (free-form)", () => {
    expect(formatAskUserQuestionPrompt({ questions: [{ question: "What should I name it?" }] }))
      .toBe("What should I name it?");
  });

  it("returns null for missing/empty/malformed questions array — never throws", () => {
    expect(formatAskUserQuestionPrompt(undefined)).toBeNull();
    expect(formatAskUserQuestionPrompt(null)).toBeNull();
    expect(formatAskUserQuestionPrompt({})).toBeNull();
    expect(formatAskUserQuestionPrompt({ questions: [] })).toBeNull();
    expect(formatAskUserQuestionPrompt({ questions: "not an array" })).toBeNull();
    expect(formatAskUserQuestionPrompt({ questions: [{}, { question: 42 }] })).toBeNull();
  });
});

// #560 review fix: task.input.requested — NOT task.blocked — is the event that
// carries requestId and drives ctx.schedulePromotion (squadrantd.ts) — the
// answer-routing machinery #562 needs. task.blocked has no requestId field at
// all, so mapping AskUserQuestion to it would delete the only signal #562
// could build on. task.input.requested already does everything #560 needs
// too: state-machine.ts maps it to state 'blocked' with the question,
// telegram/format.ts renders it, tiers.ts includes it.
describe("mapClaudeHookToEvent PreToolUse AskUserQuestion (#560)", () => {
  const TID = "task-abc";

  it("tool_name AskUserQuestion → task.input.requested carrying the real question + options and a requestId", () => {
    const payload = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Silent fallback or labelled fallback?", options: [
            { label: "Silent" }, { label: "Labelled" },
          ] },
        ],
      },
    };
    const ev = mapClaudeHookToEvent("PreToolUse", payload, TID);
    expect(ev?.type).toBe("task.input.requested");
    expect(ev).toMatchObject({
      type: "task.input.requested",
      id: TID,
      question: "Silent fallback or labelled fallback? (options: Silent, Labelled)",
    });
    // requestId: Claude's PreToolUse payload carries no native per-tool-call id
    // (session_id/cwd/tool_name/tool_input only — verified against the
    // documented payload shape) — a real, distinct value is still required
    // (not a hardcoded 0) so schedulePromotion's `${taskId}#${requestId}` key
    // doesn't collide across successive prompts for the same crew.
    expect(typeof (ev as any).requestId).toBe("number");
    expect(Number.isFinite((ev as any).requestId)).toBe(true);
  });

  it("two calls in quick succession get distinct requestIds (no collision on schedulePromotion's dedup key)", () => {
    const payload = { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "A?" }] } };
    const first = mapClaudeHookToEvent("PreToolUse", payload, TID) as any;
    const second = mapClaudeHookToEvent("PreToolUse", { ...payload, tool_input: { questions: [{ question: "B?" }] } }, TID) as any;
    expect(first.requestId).not.toBe(second.requestId);
  });

  it("tool_name AskUserQuestion with malformed/missing tool_input → STILL task.input.requested with a generic fallback, never null", () => {
    for (const payload of [
      { tool_name: "AskUserQuestion" },
      { tool_name: "AskUserQuestion", tool_input: {} },
      { tool_name: "AskUserQuestion", tool_input: { questions: [] } },
      { tool_name: "AskUserQuestion", tool_input: null },
    ]) {
      const ev = mapClaudeHookToEvent("PreToolUse", payload, TID);
      expect(ev).not.toBeNull();
      expect(ev!.type).toBe("task.input.requested");
    }
  });

  it("other tool names (e.g. Bash) → null — matcher scoping means this shouldn't fire, but stay conservative if it does", () => {
    expect(mapClaudeHookToEvent("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }, TID)).toBeNull();
  });

  it("missing tool_name → null (unchanged pre-existing behavior for a bare/unmatched PreToolUse)", () => {
    expect(mapClaudeHookToEvent("PreToolUse", {}, TID)).toBeNull();
    expect(mapClaudeHookToEvent("PreToolUse", null, TID)).toBeNull();
  });

  it("anti-#2576 invariant: never task.done or task.failed regardless of tool_input shape", () => {
    const ev = mapClaudeHookToEvent("PreToolUse", { tool_name: "AskUserQuestion", tool_input: {} }, TID);
    expect(ev!.type).not.toBe("task.done");
    expect(ev!.type).not.toBe("task.failed");
  });
});

// #761: Stop/PermissionRequest/Notification payloads all carry prompt_id — a
// real per-turn correlation id that matched across events of the same turn
// (verified live, 2026-09-04 compat study §8.3). Replaces the constant
// "hook-stop" turnId the #492 turn-boundary work could not get a real id for.
describe("mapClaudeHookToEvent Stop turnId (#761)", () => {
  const TID = "task-abc";

  it("Stop with prompt_id → turnId is the real per-turn id", () => {
    const ev = mapClaudeHookToEvent("Stop", { prompt_id: "204d13c6-abcd" }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "204d13c6-abcd" });
  });

  it("Stop without prompt_id → turnId falls back to the constant (older clients)", () => {
    const ev = mapClaudeHookToEvent("Stop", { session_id: "x" }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("Stop with empty-string prompt_id → falls back to the constant", () => {
    const ev = mapClaudeHookToEvent("Stop", { prompt_id: "" }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("logs permission_mode when present (log-only, no behaviour change)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ev = mapClaudeHookToEvent("Stop", { prompt_id: "p1", permission_mode: "acceptEdits" }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "p1" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("acceptEdits"));
    spy.mockRestore();
  });

  it("does not log when permission_mode is absent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mapClaudeHookToEvent("Stop", { prompt_id: "p1" }, TID);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// #760: notification_type is a REQUIRED, structured field on current Claude
// clients (14-value enum) — a much more robust classifier than the English
// substring test, which stays only as the fallback for older clients that
// omit the field entirely.
describe("mapClaudeHookToEvent Notification notification_type (#760)", () => {
  const TID = "task-abc";

  it("notification_type=permission_prompt → task.blocked even without permission wording in message", () => {
    const ev = mapClaudeHookToEvent("Notification", { message: "hi", notification_type: "permission_prompt" }, TID);
    expect(ev).toEqual({
      type: "task.blocked", id: TID,
      reason: "crew awaiting permission (notification hook)", question: "hi",
    });
  });

  it("notification_type=worker_permission_prompt → task.blocked", () => {
    const ev = mapClaudeHookToEvent("Notification", { message: "worker needs approval", notification_type: "worker_permission_prompt" }, TID);
    expect(ev?.type).toBe("task.blocked");
  });

  it("notification_type=agent_needs_input → task.input.requested with a requestId", () => {
    const ev = mapClaudeHookToEvent("Notification", { message: "need input", notification_type: "agent_needs_input" }, TID);
    expect(ev?.type).toBe("task.input.requested");
    expect(typeof (ev as any).requestId).toBe("number");
    expect((ev as any).question).toBe("need input");
  });

  it("notification_type=idle_prompt → task.progress (liveness only, never blocked)", () => {
    const ev = mapClaudeHookToEvent("Notification", { message: "Claude is thinking", notification_type: "idle_prompt" }, TID);
    expect(ev).toEqual({ type: "task.progress", id: TID, note: "notification" });
  });

  it("notification_type=quota_auto_resume_fired → task.progress (no dedicated source yet, never blocked)", () => {
    const ev = mapClaudeHookToEvent("Notification", { message: "quota resumed", notification_type: "quota_auto_resume_fired" }, TID);
    expect(ev).toEqual({ type: "task.progress", id: TID, note: "notification" });
  });

  it("missing notification_type (older client) falls back to substring detection — permission message still blocks", () => {
    const ev = mapClaudeHookToEvent("Notification", { message: "Claude needs your permission" }, TID);
    expect(ev?.type).toBe("task.blocked");
  });

  it("missing notification_type, non-permission message → task.progress (unchanged fallback)", () => {
    const ev = mapClaudeHookToEvent("Notification", { message: "Waiting for your input" }, TID);
    expect(ev).toEqual({ type: "task.progress", id: TID, note: "notification" });
  });
});

// #760: PermissionRequest fires ~6s BEFORE the matching Notification, and
// carries the tool name + input directly — a strictly better task.blocked
// source than sniffing Notification.message.
describe("mapClaudeHookToEvent PermissionRequest (#760)", () => {
  const TID = "task-abc";

  it("maps PermissionRequest → task.blocked with a question naming the tool and a short input hint", () => {
    const payload = { tool_name: "Write", tool_input: { file_path: "/tmp/needs-approval.txt", content: "x".repeat(500) } };
    const ev = mapClaudeHookToEvent("PermissionRequest", payload, TID);
    expect(ev?.type).toBe("task.blocked");
    const question = (ev as any).question as string;
    expect(question).toContain("Write");
    expect(question).toContain("/tmp/needs-approval.txt");
    expect(question.length).toBeLessThan(200); // never dumps the full 500-char content
  });

  it("maps PermissionRequest for Bash → question includes a truncated command hint", () => {
    const ev = mapClaudeHookToEvent("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }, TID);
    expect((ev as any).question).toContain("Bash");
    expect((ev as any).question).toContain("rm -rf /tmp/x");
  });

  it("maps PermissionRequest with missing/malformed tool_input → still task.blocked, generic hint, never throws", () => {
    expect(mapClaudeHookToEvent("PermissionRequest", { tool_name: "Read" }, TID)?.type).toBe("task.blocked");
    expect(mapClaudeHookToEvent("PermissionRequest", {}, TID)?.type).toBe("task.blocked");
    expect(mapClaudeHookToEvent("PermissionRequest", null, TID)?.type).toBe("task.blocked");
  });

  it("anti-#2576 invariant: PermissionRequest never emits task.done or task.failed", () => {
    const ev = mapClaudeHookToEvent("PermissionRequest", { tool_name: "Write", tool_input: {} }, TID);
    expect(ev!.type).not.toBe("task.done");
    expect(ev!.type).not.toBe("task.failed");
  });
});

// #762: background_tasks/session_crons are a structural, agent-reported veto
// on turn-completion — stronger than the #492 pendingTool veto because they
// also cover Claude's own background tasks and session crons, which
// pendingTool cannot see. Both fields are .optional() on the wire; absence
// must mean false (matches cmux's own hasActiveClaudeBackgroundWork handling).
describe("hasActiveBackgroundWork (#762)", () => {
  it("false when both fields absent", () => {
    expect(hasActiveBackgroundWork({})).toBe(false);
    expect(hasActiveBackgroundWork(null)).toBe(false);
    expect(hasActiveBackgroundWork(undefined)).toBe(false);
  });

  it("false when both present but empty (matches cmux's absence-means-false)", () => {
    expect(hasActiveBackgroundWork({ background_tasks: [], session_crons: [] })).toBe(false);
  });

  it("true when background_tasks is non-empty", () => {
    expect(hasActiveBackgroundWork({ background_tasks: [{ status: "running" }], session_crons: [] })).toBe(true);
  });

  it("true when session_crons is non-empty", () => {
    expect(hasActiveBackgroundWork({ background_tasks: [], session_crons: [{ id: "cron-1" }] })).toBe(true);
  });

  it("ignores non-array values for either field", () => {
    expect(hasActiveBackgroundWork({ background_tasks: "not-an-array", session_crons: "also-not" })).toBe(false);
  });
});

describe("mapClaudeHookToEvent Stop background_tasks/session_crons veto (#762)", () => {
  const TID = "task-abc";

  it("Stop with non-empty background_tasks → task.progress instead of task.turn.completed", () => {
    const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Done.", background_tasks: [{ status: "running" }] }, TID);
    expect(ev).toEqual({ type: "task.progress", id: TID, note: "stop-background-work" });
  });

  it("Stop with non-empty session_crons → task.progress instead of task.turn.completed", () => {
    const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Done.", session_crons: [{ id: "c1" }] }, TID);
    expect(ev).toEqual({ type: "task.progress", id: TID, note: "stop-background-work" });
  });

  it("Stop with empty background_tasks/session_crons → unchanged task.turn.completed", () => {
    const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Done.", background_tasks: [], session_crons: [] }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("Stop with no background_tasks/session_crons fields at all → unchanged task.turn.completed", () => {
    const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Done." }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "hook-stop" });
  });

  it("a trailing question STILL wins over an active background-task veto (explicit human ask beats liveness)", () => {
    const ev = mapClaudeHookToEvent(
      "Stop",
      { last_assistant_message: "Which config should I use?", background_tasks: [{ status: "running" }] },
      TID,
    );
    expect(ev?.type).toBe("task.blocked");
  });

  it("background-task veto composes with the #761 turnId resolution — turnId is only relevant on the non-vetoed path", () => {
    const ev = mapClaudeHookToEvent("Stop", { prompt_id: "p1", last_assistant_message: "Done.", background_tasks: [] }, TID);
    expect(ev).toEqual({ type: "task.turn.completed", id: TID, turnId: "p1" });
  });
});
