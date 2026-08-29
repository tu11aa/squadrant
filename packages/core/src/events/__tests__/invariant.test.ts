import { describe, it, expect } from "vitest";
import { freshTrace, checkFact } from "../invariant.js";
import type { AgentFact, RawFact } from "../fact.js";

const at0 = 1_000_000;
const mk = (raw: RawFact, at = at0): AgentFact =>
  ({ ...raw, seq: 0, taskId: "t1", at, source: "cmux-events", origin: "agent" });

const codes = (v: { code: string }[]) => v.map((x) => x.code);

describe("depth invariants", () => {
  it("I1: a close with depth 0 is a violation", () => {
    const t = freshTrace();
    expect(codes(checkFact(t, mk({ kind: "tool.closed" }), {}))).toEqual(["I1"]);
  });

  it("balanced open/close produces no violation", () => {
    const t = freshTrace();
    expect(checkFact(t, mk({ kind: "tool.opened", tool: "Bash" }), {})).toEqual([]);
    expect(checkFact(t, mk({ kind: "tool.closed" }), {})).toEqual([]);
  });

  it("tracks parallel tools by depth, not by a single slot", () => {
    const t = freshTrace();
    for (const tool of ["Read", "Grep", "Bash"]) {
      checkFact(t, mk({ kind: "tool.opened", tool }), {});
    }
    checkFact(t, mk({ kind: "tool.closed" }), {});
    // Two still open — a turn end here is still a violation.
    expect(codes(checkFact(t, mk({ kind: "turn.ended" }), {}))).toEqual(["I2"]);
  });

  it("I2: turn end with tools still open is a violation — this is #542", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Edit" }), {});
    const v = checkFact(t, mk({ kind: "turn.ended" }), {});
    expect(codes(v)).toEqual(["I2"]);
    expect(v[0]!.message).toContain("1");
  });

  it("I2: turn end with everything closed is clean, and resets depth", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Edit" }), {});
    checkFact(t, mk({ kind: "tool.closed" }), {});
    expect(checkFact(t, mk({ kind: "turn.ended" }), {})).toEqual([]);
    expect(t.depth).toBe(0);
  });

  it("I2 resets depth so one lost close does not poison every later turn", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Edit" }), {});
    checkFact(t, mk({ kind: "turn.ended" }), {});      // violation, depth reset
    checkFact(t, mk({ kind: "tool.opened", tool: "Read" }), {});
    checkFact(t, mk({ kind: "tool.closed" }), {});
    expect(checkFact(t, mk({ kind: "turn.ended" }), {})).toEqual([]);
  });

  it("I3: an open older than the stall budget is a violation", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Bash" }, at0), {});
    const v = checkFact(t, mk({ kind: "activity" }, at0 + 61_000), { stallBudgetMs: 60_000 });
    expect(codes(v)).toEqual(["I3"]);
  });

  it("I3 does not fire before the budget elapses", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Bash" }, at0), {});
    const v = checkFact(t, mk({ kind: "activity" }, at0 + 59_000), { stallBudgetMs: 60_000 });
    expect(v).toEqual([]);
  });

  it("I3 reports at most once per open window", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Bash" }, at0), {});
    const opts = { stallBudgetMs: 60_000 };
    expect(codes(checkFact(t, mk({ kind: "activity" }, at0 + 61_000), opts))).toEqual(["I3"]);
    expect(checkFact(t, mk({ kind: "activity" }, at0 + 62_000), opts)).toEqual([]);
  });
});
