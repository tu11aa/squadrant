// packages/core/src/events/__tests__/to-control-event.test.ts
import { describe, it, expect } from "vitest";
import { toControlEvent } from "../to-control-event.js";
import type { AgentFact, RawFact } from "../fact.js";

const mk = (raw: RawFact): AgentFact =>
  ({ ...raw, seq: 0, taskId: "t1", at: 1000, source: "opencode-sse", origin: "agent" });

describe("toControlEvent", () => {
  it("turn.ended reproduces task.turn.completed with the carried turnId", () => {
    expect(toControlEvent(mk({ kind: "turn.ended", turnId: "ses_9" }))).toEqual([
      { type: "task.turn.completed", id: "t1", turnId: "ses_9" },
    ]);
  });

  it("turn.ended without a turnId falls back to the source name", () => {
    expect(toControlEvent(mk({ kind: "turn.ended" }))).toEqual([
      { type: "task.turn.completed", id: "t1", turnId: "opencode-sse" },
    ]);
  });

  it("permission.requested reproduces task.approval.requested verbatim", () => {
    const out = toControlEvent(mk({
      kind: "permission.requested",
      question: "opencode requests permission to run bash: ls",
      requestId: 7,
      tool: "bash",
    }));
    expect(out).toEqual([{
      type: "task.approval.requested",
      id: "t1",
      requestId: 7,
      question: "opencode requests permission to run bash: ls",
      kind: "bash",
    }]);
  });

  it("activity and unknown emit nothing — they are liveness only", () => {
    expect(toControlEvent(mk({ kind: "activity" }))).toEqual([]);
    expect(toControlEvent(mk({ kind: "unknown", name: "wat" }))).toEqual([]);
  });

  it("an inferred fact never produces a terminal event (I4)", () => {
    const inferred: AgentFact = {
      kind: "session.ended", seq: 0, taskId: "t1", at: 1000,
      source: "pane", origin: "inferred",
    };
    expect(toControlEvent(inferred)).toEqual([]);
  });

  it("an agent-origin session.ended does terminalise", () => {
    const agent: AgentFact = {
      kind: "session.ended", seq: 0, taskId: "t1", at: 1000,
      source: "claude-hook", origin: "agent",
    };
    expect(toControlEvent(agent)).toEqual([{ type: "task.session.ended", id: "t1" }]);
  });
});
