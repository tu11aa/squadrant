// src/control/__tests__/watchdog.test.ts
import { describe, it, expect } from "vitest";
import { evaluateStall, recoverStall } from "@cockpit/core";
import { reduce } from "@cockpit/core";
import type { TaskRecord } from "@cockpit/shared";

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

  it("working INTERACTIVE past budget → awaiting-input, not stalled", () => {
    // An idle interactive crew has simply ended a turn and is awaiting the
    // captain's next message — that is NOT a stall. Surface it as the
    // answerable 'awaiting-input' state so the captain gets an accurate,
    // non-alarming nudge instead of a misleading CREW STALLED.
    const out = evaluateStall(rec({ mode: "interactive" }), 6001);
    expect(out?.state).toBe("awaiting-input");
    expect(out?.state).not.toBe("stalled");
    expect(out?.lastEvent).toBe("watchdog.idle");
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

describe("idle interactive-codex = warn-don't-autofail (spec §4.8, #90 slice)", () => {
  // #90's intent ("warn-don't-autofail") was that an idle interactive-codex
  // task must remain answerable, never auto-failed. We now express that as
  // 'awaiting-input' rather than 'stalled': both are non-terminal & answerable,
  // but 'awaiting-input' reads to the captain as normal idle (turn ended)
  // instead of a failure, and resumes to 'working' on the next liveness/turn.
  function rec(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "working", task: "x", createdAt: 1000, lastHeartbeat: 1000,
      lastEvent: "task.started", heartbeatBudgetMs: 5000,
      attempts: [{ attemptId: "a0", startedAt: 1000, lastHeartbeatAt: 1000 }],
      ...overrides,
    };
  }

  it("an idle interactive-codex task is non-terminal & answerable (awaiting-input, never failed)", () => {
    const idle = evaluateStall(rec(), 100_000);
    expect(idle).not.toBeNull();
    expect(idle!.state).toBe("awaiting-input");
    expect(idle!.state).not.toBe("failed");
    expect(idle!.state).not.toBe("done");
  });

  it("an idle interactive-codex task resumes to working on the next turn (task.started/PostToolUse)", () => {
    // awaiting-input → working is the reducer's job (task.started / task.progress);
    // the watchdog itself never re-stalls an awaiting-input task.
    const idle = evaluateStall(rec(), 100_000)!;
    expect(evaluateStall(idle, 200_000)).toBeNull(); // no re-stall while idle
    expect(recoverStall(idle, 101_000)).toBeNull();  // recoverStall only acts on 'stalled'
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
