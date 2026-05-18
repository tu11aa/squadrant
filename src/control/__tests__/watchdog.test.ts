// src/control/__tests__/watchdog.test.ts
import { describe, it, expect } from "vitest";
import { evaluateStall, recoverStall } from "../watchdog.js";
import type { TaskRecord } from "../types.js";

function rec(o: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1", project: "p", provider: "claude", mode: "headless",
    state: "working", task: "t", createdAt: 0, lastHeartbeat: 1000,
    lastEvent: "", heartbeatBudgetMs: 5000, ...o,
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
