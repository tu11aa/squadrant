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
});
