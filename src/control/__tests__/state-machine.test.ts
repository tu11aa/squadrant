// src/control/__tests__/state-machine.test.ts
import { describe, it, expect } from "vitest";
import { reduce } from "../state-machine.js";
import type { TaskRecord, DispatchAttempt } from "../types.js";

function rec(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1", project: "p", provider: "claude", mode: "headless",
    state: "submitted", task: "do x", createdAt: 1000,
    lastHeartbeat: 1000, lastEvent: "", heartbeatBudgetMs: 300000,
    attempts: [{ attemptId: "a0", startedAt: 1000, lastHeartbeatAt: 1000 }],
    ...overrides,
  };
}

describe("state-machine reduce", () => {
  it("submitted + task.started → working, records pid/sessionId", () => {
    const next = reduce(rec(), { type: "task.started", id: "t1", pid: 42, sessionId: "s1" }, 2000);
    expect(next.state).toBe("working");
    expect(next.pid).toBe(42);
    expect(next.sessionId).toBe("s1");
    expect(next.lastHeartbeat).toBe(2000);
    expect(next.lastEvent).toBe("task.started");
  });

  it("working + task.done → done with resultRef", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.done", id: "t1", resultRef: "/r" }, 3000);
    expect(next.state).toBe("done");
    expect(next.resultRef).toBe("/r");
  });

  it("working + task.failed → failed with error+exitCode", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.failed", id: "t1", error: "boom", exitCode: 1 }, 3000);
    expect(next.state).toBe("failed");
    expect(next.error).toBe("boom");
    expect(next.exitCode).toBe(1);
  });

  it("submitted + task.blocked → blocked", () => {
    const next = reduce(rec(), { type: "task.blocked", id: "t1", reason: "need input", question: "which path?" }, 3500);
    expect(next.state).toBe("blocked");
    expect(next.question).toBe("which path?");
  });

  it("working + task.blocked → blocked carrying the question (#174 auto-detect)", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.blocked", id: "t1", reason: "crew asked a question (auto-detected)", question: "which db?" }, 3600);
    expect(next.state).toBe("blocked");
    expect(next.question).toBe("which db?");
  });

  it("blocked + task.blocked is idempotent — the FIRST question wins, no overwrite (#174)", () => {
    // The explicit `cockpit crew signal blocked` fires BEFORE the turn ends; the
    // auto-detect Stop hook may re-emit task.blocked afterward. The first question
    // must survive so the captain sees what the crew actually typed.
    const next = reduce(
      rec({ state: "blocked", question: "explicit question?" }),
      { type: "task.blocked", id: "t1", reason: "crew asked a question (auto-detected)", question: "auto-detected question?" },
      4200,
    );
    expect(next.state).toBe("blocked");
    expect(next.question).toBe("explicit question?");
    expect(next.lastHeartbeat).toBe(4200); // liveness still updates
  });

  it("blocked + task.progress does NOT auto-unblock (explicit reply required)", () => {
    const next = reduce(rec({ state: "blocked", question: "q?" }), { type: "task.progress", id: "t1" }, 4000);
    expect(next.state).toBe("blocked");
    expect(next.lastHeartbeat).toBe(4000); // liveness still updates
    expect(next.lastEvent).toBe("task.progress"); // lastEvent stays consistent
  });

  it("stalled + task.done → done", () => {
    const next = reduce(rec({ state: "stalled" }), { type: "task.done", id: "t1", resultRef: "/r" }, 4500);
    expect(next.state).toBe("done");
    expect(next.resultRef).toBe("/r");
  });

  it("blocked + task.started (resume after reply) → working, clears question", () => {
    const next = reduce(rec({ state: "blocked", question: "q?" }), { type: "task.started", id: "t1" }, 5000);
    expect(next.state).toBe("working");
    expect(next.question).toBeUndefined();
  });

  it("terminal state absorbs late events idempotently", () => {
    const done = rec({ state: "done", resultRef: "/r" });
    const next = reduce(done, { type: "task.failed", id: "t1", error: "late" }, 6000);
    expect(next).toBe(done); // same reference — no-op
  });

  it("task.reopened revives done → working, clears question and error", () => {
    const d = rec({ state: "done", resultRef: "/r", question: "old question", error: undefined });
    const next = reduce(d, { type: "task.reopened", id: "t1" }, 7000);
    expect(next.state).toBe("working");
    expect(next.question).toBeUndefined();
    expect(next.error).toBeUndefined();
    expect(next.lastHeartbeat).toBe(7000);
    expect(next.lastEvent).toBe("task.reopened");
    // resultRef is preserved even after reopen (informational)
    expect(next.resultRef).toBe("/r");
  });

  it("task.reopened revives failed → working, clears error", () => {
    const f = rec({ state: "failed", error: "boom", exitCode: 1 });
    const next = reduce(f, { type: "task.reopened", id: "t1" }, 8000);
    expect(next.state).toBe("working");
    expect(next.error).toBeUndefined();
    expect(next.exitCode).toBe(1); // preserved, informational
    expect(next.lastEvent).toBe("task.reopened");
  });

  it("task.reopened on working stays working (already active)", () => {
    const w = rec({ state: "working" });
    const next = reduce(w, { type: "task.reopened", id: "t1" }, 9000);
    expect(next.state).toBe("working");
    expect(next.lastHeartbeat).toBe(9000);
    expect(next.lastEvent).toBe("task.reopened");
  });

  it("task.reopened on stalled transitions to working", () => {
    const s = rec({ state: "stalled" });
    const next = reduce(s, { type: "task.reopened", id: "t1" }, 10000);
    expect(next.state).toBe("working");
    expect(next.lastEvent).toBe("task.reopened");
  });

  it("task.reopened on blocked transitions to working, clears question", () => {
    const b = rec({ state: "blocked", question: "which path?" });
    const next = reduce(b, { type: "task.reopened", id: "t1" }, 11000);
    expect(next.state).toBe("working");
    expect(next.question).toBeUndefined();
    expect(next.lastEvent).toBe("task.reopened");
  });

  it("terminal state STILL absorbs non-reopened events after task.reopened handling", () => {
    // Regression: opening one event does not disable the absorbing guard.
    const done = rec({ state: "done", resultRef: "/r" });
    const next = reduce(done, { type: "heartbeat", id: "t1" }, 12000);
    expect(next).toBe(done); // same reference — no-op
  });

  it("task.progress on working stays working (liveness tick, never terminal)", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.progress", id: "t1", note: "PostToolUse" }, 7000);
    expect(next.state).toBe("working");
    expect(next.lastHeartbeat).toBe(7000);
  });

  it("task.turn.completed transitions working → awaiting-input (#131 false-stall fix)", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.turn.completed", id: "t1", turnId: "hook-stop" }, 8000);
    expect(next.state).toBe("awaiting-input");
    expect(next.lastHeartbeat).toBe(8000);
  });

  it("task.progress on awaiting-input transitions back to working (#131 fix: next turn resumes)", () => {
    const taskTurnEnd = reduce(rec({ state: "working" }), { type: "task.turn.completed", id: "t1", turnId: "hook-stop" }, 8000);
    expect(taskTurnEnd.state).toBe("awaiting-input");
    const postToolUse = reduce(taskTurnEnd, { type: "task.progress", id: "t1", note: "posttooluse" }, 9000);
    expect(postToolUse.state).toBe("working");
    expect(postToolUse.lastHeartbeat).toBe(9000);
    expect(postToolUse.lastEvent).toBe("task.progress");
  });

  it("awaiting-input + task.done still transitions to done (terminal not blocked)", () => {
    const next = reduce(rec({ state: "awaiting-input" }), { type: "task.done", id: "t1", resultRef: "/r" }, 10000);
    expect(next.state).toBe("done");
  });

  it("awaiting-input + task.failed still transitions to failed", () => {
    const next = reduce(rec({ state: "awaiting-input" }), { type: "task.failed", id: "t1", error: "boom" }, 11000);
    expect(next.state).toBe("failed");
  });

  // ── Issue #184: crew close terminalization ──────────────────────────────────
  it("task.cancelled on working task → state 'cancelled', terminal and silent (#184)", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.cancelled", id: "t1", reason: "closed by captain" }, 5000);
    expect(next.state).toBe("cancelled");
    expect(next.lastHeartbeat).toBe(5000);
    expect(next.lastEvent).toBe("task.cancelled");
  });

  it("task.cancelled on blocked task → cancelled (#184)", () => {
    const next = reduce(rec({ state: "blocked", question: "q?" }), { type: "task.cancelled", id: "t1" }, 5001);
    expect(next.state).toBe("cancelled");
  });

  it("task.cancelled on awaiting-input task → cancelled (#184)", () => {
    const next = reduce(rec({ state: "awaiting-input" }), { type: "task.cancelled", id: "t1" }, 5002);
    expect(next.state).toBe("cancelled");
  });

  it("cancelled task absorbs task.progress — same reference, no transition (#184)", () => {
    const cancelled = rec({ state: "cancelled" });
    const next = reduce(cancelled, { type: "task.progress", id: "t1" }, 6000);
    expect(next).toBe(cancelled);
  });

  it("cancelled task absorbs task.blocked — stays cancelled, no re-notification (#184)", () => {
    const cancelled = rec({ state: "cancelled" });
    const next = reduce(cancelled, { type: "task.blocked", id: "t1", reason: "r", question: "q?" }, 6001);
    expect(next).toBe(cancelled);
  });

  it("done task absorbs task.cancelled — already terminal, no state change (#184)", () => {
    const done = rec({ state: "done", resultRef: "/r" });
    const next = reduce(done, { type: "task.cancelled", id: "t1", reason: "closed" }, 7000);
    expect(next).toBe(done);
  });
});

describe("DispatchAttempt schema", () => {
  it("a fresh TaskRecord has a single attempt with attemptId, startedAt, lastHeartbeatAt", () => {
    const rec: TaskRecord = {
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
    };
    expect(rec.attempts.length).toBe(1);
    expect(rec.attempts[0]?.attemptId).toBe("a1");
  });
});

describe("reducer · resumeRef-on-every-transition", () => {
  function base(): TaskRecord {
    return {
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 60000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
    };
  }
  it("task.session stamps resumeRef on the current attempt", () => {
    const r = reduce(base(), { type: "task.session", id: "t1", resumeRef: "TH-1" }, 100);
    expect(r.attempts.at(-1)?.resumeRef).toBe("TH-1");
    expect(r.attempts.length).toBe(1);
  });
  it("task.started updates pid on current attempt without losing resumeRef", () => {
    let r = reduce(base(), { type: "task.session", id: "t1", resumeRef: "TH-1" }, 100);
    r = reduce(r, { type: "task.started", id: "t1", pid: 1234 }, 200);
    expect(r.attempts.at(-1)?.resumeRef).toBe("TH-1");
    expect(r.attempts.at(-1)?.pid).toBe(1234);
    expect(r.state).toBe("working");
  });
});
