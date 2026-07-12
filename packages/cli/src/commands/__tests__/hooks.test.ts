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

  // task.input.requested — not task.blocked — is the event that carries
  // requestId and drives ctx.schedulePromotion (squadrantd.ts), the
  // answer-routing machinery #562 depends on. It already does everything
  // #560 needs too (state-machine.ts maps it to state 'blocked').
  it("delegates to the real AskUserQuestion extraction — carries the actual question + options + a requestId", () => {
    const payload = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Which env should I deploy to?", options: [{ label: "staging" }, { label: "prod" }] },
        ],
      },
    };
    const ev = mapHookSub("ask-question", payload, TID);
    expect(ev?.type).toBe("task.input.requested");
    expect(ev).toMatchObject({
      type: "task.input.requested",
      id: TID,
      question: "Which env should I deploy to? (options: staging, prod)",
    });
    expect(typeof (ev as any).requestId).toBe("number");
  });

  it("still fires task.input.requested even with a malformed/missing tool_input — never silently drops the signal", () => {
    const ev = mapHookSub("ask-question", { tool_name: "AskUserQuestion" }, TID);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("task.input.requested");
  });

  it("other subs still map as before (no regression)", () => {
    expect(mapHookSub("pre-tool-use", {}, TID)).toEqual({ type: "task.progress", id: TID, note: "pre-tool-use" });
    expect(mapHookSub("prompt-submit", {}, TID)).toEqual({ type: "task.first-turn.confirmed", id: TID });
    expect(mapHookSub("unknown-sub", {}, TID)).toBeNull();
  });
});
