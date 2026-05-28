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
