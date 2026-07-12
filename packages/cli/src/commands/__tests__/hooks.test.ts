import { describe, it, expect } from "vitest";
import { mapHookSub } from "../hooks.js";

// #560: the "ask-question" sub fires from NativeHookSource's global
// PreToolUse+AskUserQuestion matcher install (see native-hook-source.ts). It
// must extract the SAME real question/options text the crew's own hook set
// does — the previous inline version read a `payload.question` field that
// doesn't exist on Claude's actual PreToolUse payload (tool_name/tool_input),
// so it always fell back to a hardcoded "awaiting input" placeholder.
describe("mapHookSub — ask-question (#560)", () => {
  const TID = "task-abc";

  it("delegates to the real AskUserQuestion extraction — carries the actual question + options", () => {
    const payload = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Which env should I deploy to?", options: [{ label: "staging" }, { label: "prod" }] },
        ],
      },
    };
    const ev = mapHookSub("ask-question", payload, TID);
    expect(ev).toEqual({
      type: "task.blocked",
      id: TID,
      reason: "crew opened an AskUserQuestion prompt",
      question: "Which env should I deploy to? (options: staging, prod)",
    });
  });

  it("still fires task.blocked even with a malformed/missing tool_input — never silently drops the signal", () => {
    const ev = mapHookSub("ask-question", { tool_name: "AskUserQuestion" }, TID);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("task.blocked");
  });

  it("other subs still map as before (no regression)", () => {
    expect(mapHookSub("pre-tool-use", {}, TID)).toEqual({ type: "task.progress", id: TID, note: "pre-tool-use" });
    expect(mapHookSub("prompt-submit", {}, TID)).toEqual({ type: "task.first-turn.confirmed", id: TID });
    expect(mapHookSub("unknown-sub", {}, TID)).toBeNull();
  });
});
