// src/control/__tests__/watchdog.test.ts
import { describe, it, expect } from "vitest";
import { evaluateStall, recoverStall } from "../watchdog.js";
import type { TaskRecord } from "../types.js";

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
  it("working past budget → stalled", () => {
    const out = evaluateStall(rec(), 6001);
    expect(out?.state).toBe("stalled");
    expect(out?.lastEvent).toBe("watchdog.stall");
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

describe("stalled = warn-don't-autofail for interactive-codex (spec §4.8, #90 slice)", () => {
  function rec(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "working", task: "x", createdAt: 1000, lastHeartbeat: 1000,
      lastEvent: "task.started", heartbeatBudgetMs: 5000,
      attempts: [{ attemptId: "a0", startedAt: 1000, lastHeartbeatAt: 1000 }],
      ...overrides,
    };
  }

  it("a stalled interactive-codex task is non-terminal (never failed)", () => {
    const stalled = evaluateStall(rec(), 100_000);
    expect(stalled).not.toBeNull();
    expect(stalled!.state).toBe("stalled");
    expect(stalled!.state).not.toBe("failed");
    expect(stalled!.state).not.toBe("done");
  });

  it("a stalled interactive-codex task recovers to working on next liveness", () => {
    const stalled = evaluateStall(rec(), 100_000)!;
    const recovered = recoverStall(stalled, 101_000);
    expect(recovered).not.toBeNull();
    expect(recovered!.state).toBe("working");
  });
});
