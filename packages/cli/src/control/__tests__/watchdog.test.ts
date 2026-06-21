// src/control/__tests__/watchdog.test.ts
import { describe, it, expect } from "vitest";
import { evaluateStall, recoverStall } from "@squadrant/core";
import { reduce } from "@squadrant/core";
import type { TaskRecord } from "@squadrant/shared";

function rec(o: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1", project: "p", provider: "claude", mode: "headless",
    state: "working", task: "t", createdAt: 0, lastHeartbeat: 1000,
    lastEvent: "", heartbeatBudgetMs: 5000,
    attempts: [{ attemptId: "a0", startedAt: 0, lastHeartbeatAt: 1000 }],
    ...o,
  };
}

describe("evaluateStall", () => {
  it("working HEADLESS past budget → stalled", () => {
    const out = evaluateStall(rec(), 6001);
    expect(out?.state).toBe("stalled");
    expect(out?.lastEvent).toBe("watchdog.stall");
  });

  it("working INTERACTIVE past budget with NO tool in flight → null (alive-thinking, #354)", () => {
    // A quiet interactive crew with no tool in flight is deep-thinking, not
    // stalled and NOT awaiting-input (the turn never ended). evaluateStall stays
    // out of it; the daemon sweep surfaces CREW QUIET instead. This replaces the
    // old wall-clock → 'awaiting-input' flip that produced the false CREW IDLE.
    expect(evaluateStall(rec({ mode: "interactive" }), 6001)).toBeNull();
  });

  it("working INTERACTIVE with a hung tool past tool-stall budget → stalled (#354)", () => {
    // A PreToolUse with no matching PostToolUse, outstanding past the tool-stall
    // budget, is a hung tool call — recoverable CREW STALLED, named by tool.
    const out = evaluateStall(rec({ mode: "interactive", pendingTool: { name: "Bash", since: 0 } }), 11 * 60_000);
    expect(out?.state).toBe("stalled");
    expect(out?.lastEvent).toBe("watchdog.tool-stall");
  });

  it("working INTERACTIVE with a tool in flight WITHIN tool-stall budget → null (legit long tool, #354)", () => {
    // A 5-min test suite / build is a long unpaired PreToolUse but must NOT trip.
    const out = evaluateStall(rec({ mode: "interactive", pendingTool: { name: "Bash", since: 0 } }), 5 * 60_000);
    expect(out).toBeNull();
  });

  it("working within budget → no change (null)", () => {
    expect(evaluateStall(rec(), 5999)).toBeNull();
  });

  it("working exactly at budget boundary → no change (null)", () => {
    expect(evaluateStall(rec(), 6000)).toBeNull();
  });

  it("non-working state is never stalled", () => {
    expect(evaluateStall(rec({ state: "blocked" }), 999999)).toBeNull();
    expect(evaluateStall(rec({ state: "done" }), 999999)).toBeNull();
  });
});

describe("recoverStall", () => {
  it("recoverStall: stalled + fresh heartbeat → working", () => {
    const stalled = rec({ state: "stalled" });
    const out = recoverStall(stalled, 7000);
    expect(out?.state).toBe("working");
    expect(out?.lastHeartbeat).toBe(7000);
    expect(out?.lastEvent).toBe("watchdog.recover");
  });

  it("recoverStall: non-stalled → null", () => {
    expect(recoverStall(rec({ state: "working" }), 7000)).toBeNull();
  });
});

describe("idle interactive = warn-don't-autofail (spec §4.8, #90 slice; #354 degradation)", () => {
  // #90's intent ("warn-don't-autofail") was that an idle interactive task must
  // remain answerable, never auto-failed. Post-#354 a quiet interactive crew
  // with no tool in flight stays `working` (CREW QUIET) — strictly more
  // answerable than the old 'awaiting-input' flip, and certainly never failed.
  // codex/opencode have no PreToolUse feed, so they never set pendingTool and so
  // always take this Tier-A (QUIET-only) path — the clean degradation.
  function rec(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "working", task: "x", createdAt: 1000, lastHeartbeat: 1000,
      lastEvent: "task.started", heartbeatBudgetMs: 5000,
      attempts: [{ attemptId: "a0", startedAt: 1000, lastHeartbeatAt: 1000 }],
      ...overrides,
    };
  }

  it("a quiet interactive task (no tool in flight) is never stalled/failed by the watchdog (#354)", () => {
    const out = evaluateStall(rec(), 100_000);
    expect(out).toBeNull(); // stays working — the sweep emits CREW QUIET, not a state change
  });

  it("the watchdog never re-stalls and recoverStall ignores a working task", () => {
    expect(evaluateStall(rec(), 200_000)).toBeNull();
    expect(recoverStall(rec(), 101_000)).toBeNull(); // recoverStall only acts on 'stalled'
  });
});

// ── Issue #89: masking-heartbeat regression ──────────────────────────────────
// A late { type: "heartbeat" } from a dead attempt updates rec.lastHeartbeat
// but bypasses stampAttempt, so attempts[-1].lastHeartbeatAt stays anchored to
// the new dispatch's task.started time. evaluateStall must key off lastHeartbeatAt
// so the stale pulse from the dead attempt cannot hide a hung new dispatch.
describe("masking-heartbeat regression (#89)", () => {
  function baseRec(): TaskRecord {
    return {
      id: "t1", project: "p", provider: "claude", mode: "headless",
      state: "submitted", task: "do x", createdAt: 0,
      lastHeartbeat: 0, lastEvent: "", heartbeatBudgetMs: 5000,
      attempts: [{ attemptId: "a0", startedAt: 0, lastHeartbeatAt: 0 }],
    };
  }

  it("stale heartbeat from dead attempt does not mask stall on hung re-dispatch", () => {
    // Attempt A starts at T=100.
    let r = reduce(baseRec(), { type: "task.started", id: "t1", pid: 10 }, 100);
    expect(r.attempts.at(-1)!.lastHeartbeatAt).toBe(100);

    // Attempt A crashes at T=200 → terminal.
    r = reduce(r, { type: "task.failed", id: "t1", error: "crash" }, 200);
    expect(r.state).toBe("failed");

    // Re-dispatch: captain reopens at T=300.
    r = reduce(r, { type: "task.reopened", id: "t1" }, 300);
    expect(r.state).toBe("working");

    // New dispatch: task.started at T=400 stamps lastHeartbeatAt on the attempt.
    r = reduce(r, { type: "task.started", id: "t1", pid: 20 }, 400);
    expect(r.attempts.at(-1)!.lastHeartbeatAt).toBe(400);

    // New dispatch is HUNG — no output, no events from pid 20.

    // Late heartbeat from dead attempt A arrives at T=4500 (still within 5s budget
    // if measured from rec.lastHeartbeat). It updates rec.lastHeartbeat but does NOT
    // call stampAttempt, so lastHeartbeatAt stays anchored at 400.
    r = reduce(r, { type: "heartbeat", id: "t1" }, 4500);
    expect(r.lastHeartbeat).toBe(4500);
    expect(r.attempts.at(-1)!.lastHeartbeatAt).toBe(400); // unchanged

    // Watchdog fires at T=5401.
    // Old (buggy) path: now - rec.lastHeartbeat = 5401-4500 = 901 ≤ 5000 → null (false-alive).
    // Fixed path:       now - lastHeartbeatAt    = 5401-400  = 5001 > 5000 → stalled.
    const result = evaluateStall(r, 5401);
    expect(result?.state).toBe("stalled");
  });
});
