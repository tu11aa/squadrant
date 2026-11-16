import { describe, it, expect, vi } from "vitest";
import { DEFAULT_CONTEXT_BUDGET, resolveContextBudget } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import { createWarmNudger, warmIdleMinutes, warmNudgeMessage } from "../crew-warm-nudge.js";

const MIN = 60_000;
const NOW = 10_000 * MIN;
const budget = { ...DEFAULT_CONTEXT_BUDGET };
const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "t1", name: "alpha", project: "p", provider: "claude", mode: "interactive", state: "awaiting-input",
  task: "x", createdAt: 1, lastHeartbeat: NOW - 50 * MIN, lastEvent: "task.turn.completed", heartbeatBudgetMs: 1, attempts: [],
  ...over,
} as TaskRecord);

function harness(tokens: number | null = 180_000, b = budget) {
  let t = task();
  let now = NOW;
  const enqueue = vi.fn(async () => undefined);
  const n = createWarmNudger({ now: () => now, budgetFor: () => b, tasks: () => [t], crewTokens: () => tokens, enqueue });
  return { n, enqueue, set: (o: Partial<TaskRecord>) => { t = task({ ...t, ...o }); }, advance: (ms: number) => { now += ms; } };
}

describe("warmIdleMinutes", () => {
  it("is open from the idle threshold until the cache TTL", () => {
    expect(warmIdleMinutes(task({ lastHeartbeat: NOW - 49 * MIN }), NOW, budget)).toBeNull();
    expect(warmIdleMinutes(task(), NOW, budget)).toBe(50);
    expect(warmIdleMinutes(task({ lastHeartbeat: NOW - 59 * MIN }), NOW, budget)).toBe(59);
    expect(warmIdleMinutes(task({ lastHeartbeat: NOW - 60 * MIN }), NOW, budget)).toBeNull();
  });
  it("skips busy, blocked, closed, held and non-compactable crews", () => {
    for (const state of ["working", "submitted", "blocked", "stalled", "cancelled", "failed"] as const)
      expect(warmIdleMinutes(task({ state }), NOW, budget)).toBeNull();
    expect(warmIdleMinutes(task({ operatorHold: { since: 1 } }), NOW, budget)).toBeNull();
    expect(warmIdleMinutes(task({ provider: "codex" }), NOW, budget)).toBeNull();
    expect(warmIdleMinutes(task({ provider: "gemini" }), NOW, budget)).toBeNull();
    expect(warmIdleMinutes(task({ state: "done" }), NOW, budget)).toBe(50);
    expect(warmIdleMinutes(task({ state: "review" }), NOW, budget)).toBe(50);
  });
  it("off switches silence it", () => {
    expect(warmIdleMinutes(task(), NOW, { ...budget, warmNudge: false })).toBeNull();
    expect(warmIdleMinutes(task(), NOW, { ...budget, enabled: false })).toBeNull();
  });
});

describe("warmNudgeMessage", () => {
  it("is one line with the compact command", () => {
    const m = warmNudgeMessage("p", "alpha", 50, 180_000);
    expect(m).toContain("crew alpha idle 50m at 180k ctx; its cache expires in ~10m.");
    expect(m).toContain("squadrant crew compact p alpha --keep");
    expect(m).not.toContain("\n");
  });
});

describe("createWarmNudger", () => {
  it("fires once per idle period", async () => {
    const h = harness();
    await h.n.tick(["p"]); await h.n.tick(["p"]);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
  it("does not fire below the ctx threshold or when unmeasurable", async () => {
    for (const tokens of [99_999, null]) {
      const h = harness(tokens);
      await h.n.tick(["p"]);
      expect(h.enqueue).not.toHaveBeenCalled();
    }
  });
  it("fires once the ctx reaches the threshold", async () => {
    const h = harness(100_000);
    await h.n.tick(["p"]);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
  it("re-arms after activity (heartbeat moves) or a compact", async () => {
    const h = harness();
    await h.n.tick(["p"]);
    h.set({ lastHeartbeat: NOW }); // active again
    h.advance(50 * MIN);           // idle 50m anew
    await h.n.tick(["p"]);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
  });
  it("ignores superseded task records of the same crew name", async () => {
    const enqueue = vi.fn(async () => undefined);
    const old = task({ id: "old", createdAt: 1, state: "done" });
    const live = task({ id: "live", createdAt: 2, state: "working" });
    await createWarmNudger({ now: () => NOW, budgetFor: () => budget, tasks: () => [old, live], crewTokens: () => 200_000, enqueue }).tick(["p"]);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("is silent when disabled and survives an enqueue error", async () => {
    const off = harness(180_000, { ...budget, warmNudge: false });
    await off.n.tick(["p"]);
    expect(off.enqueue).not.toHaveBeenCalled();
    const log = vi.fn();
    await createWarmNudger({ now: () => NOW, budgetFor: () => budget, tasks: () => [task()], crewTokens: () => 200_000, enqueue: async () => { throw new Error("boom"); }, log }).tick(["p"]);
    expect(log).toHaveBeenCalledWith("warm nudge p: boom");
  });
});

describe("resolveContextBudget warm-nudge keys", () => {
  it("layers global and project values, ignoring bad ones", () => {
    const b = resolveContextBudget({ warmNudge: false, warmNudgeIdleMin: 1 }, { contextBudget: { warmNudgeCtx: 5, warmNudgeIdleMin: -3 } } as never);
    expect(b).toMatchObject({ warmNudge: false, warmNudgeIdleMin: 1, warmNudgeCtx: 5 });
  });
});
