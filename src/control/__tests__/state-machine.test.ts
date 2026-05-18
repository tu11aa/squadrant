// src/control/__tests__/state-machine.test.ts
import { describe, it, expect } from "vitest";
import { reduce } from "../state-machine.js";
import type { TaskRecord } from "../types.js";

function rec(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1", project: "p", provider: "claude", mode: "headless",
    state: "submitted", task: "do x", createdAt: 1000,
    lastHeartbeat: 1000, lastEvent: "", heartbeatBudgetMs: 300000,
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

  it("blocked + task.progress does NOT auto-unblock (explicit reply required)", () => {
    const next = reduce(rec({ state: "blocked", question: "q?" }), { type: "task.progress", id: "t1" }, 4000);
    expect(next.state).toBe("blocked");
    expect(next.lastHeartbeat).toBe(4000); // liveness still updates
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

  it("bare Stop modelled as task.progress never yields done", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.progress", id: "t1", note: "Stop" }, 7000);
    expect(next.state).toBe("working");
  });
});
