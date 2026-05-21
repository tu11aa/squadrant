// src/control/__tests__/daemon.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../daemon.js";
import { createStore } from "../store.js";
import type { TaskRecord } from "../types.js";

function rec(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, project: "p", provider: "claude", mode: "interactive",
    state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    ...overrides,
  };
}

describe("daemon handler", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-d-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ingests an event and persists the new state", async () => {
    const store = createStore(dir);
    store.put(rec("t1"));
    const d = createDaemon({ store, now: () => 2000 });
    const r = await d.handle({ kind: "event", event: { type: "task.started", id: "t1" }, project: "p" });
    expect((r as TaskRecord).state).toBe("working");
    expect(store.get("p", "t1")?.state).toBe("working");
  });

  it("answers a status query from the store", async () => {
    const store = createStore(dir);
    store.put(rec("t1"));
    const d = createDaemon({ store, now: () => 2000 });
    const r = await d.handle({ kind: "status", project: "p", id: "t1" });
    expect((r as TaskRecord).id).toBe("t1");
  });

  it("rejects reply to a non-blocked task", async () => {
    const store = createStore(dir);
    store.put(rec("t1", { state: "working" }));
    const d = createDaemon({ store, now: () => 2000 });
    await expect(
      d.handle({ kind: "reply", project: "p", id: "t1", message: "x" }),
    ).rejects.toThrow(/not blocked/i);
  });

  it("reconcile: working headless task with dead pid → failed", async () => {
    const store = createStore(dir);
    store.put(rec("h1", { state: "working", mode: "headless", pid: 999999 }));
    const d = createDaemon({ store, now: () => 5000, isPidAlive: () => false });
    d.reconcile();
    expect(store.get("p", "h1")?.state).toBe("failed");
    expect(store.get("p", "h1")?.error).toMatch(/orphan|daemon restart/i);
  });

  it("reconcile: working interactive task → stalled (hook source gone)", async () => {
    const store = createStore(dir);
    store.put(rec("i1", { state: "working", mode: "interactive" }));
    const d = createDaemon({ store, now: () => 5000, isPidAlive: () => false });
    d.reconcile();
    expect(store.get("p", "i1")?.state).toBe("stalled");
  });

  it("reconcile: working headless task with live pid → stays working", async () => {
    const store = createStore(dir);
    store.put(rec("h2", { state: "working", mode: "headless", pid: 4242 }));
    const d = createDaemon({ store, now: () => 5000, isPidAlive: () => true });
    d.reconcile();
    expect(store.get("p", "h2")?.state).toBe("working");
  });

  it("sweep: marks an over-budget working task stalled", async () => {
    const store = createStore(dir);
    store.put(rec("s1", { state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 100 }));
    const d = createDaemon({ store, now: () => 1000 });
    d.sweep();
    expect(store.get("p", "s1")?.state).toBe("stalled");
  });

  it("sweep: recovers a stalled task that has a fresh heartbeat", async () => {
    const store = createStore(dir);
    store.put(rec("s2", { state: "stalled", lastHeartbeat: 990, heartbeatBudgetMs: 100 }));
    const d = createDaemon({ store, now: () => 1000 });
    d.sweep();
    expect(store.get("p", "s2")?.state).toBe("working");
  });

  it("sweep: stalled task with old heartbeat is NOT recovered", async () => {
    const store = createStore(dir);
    // lastHeartbeat=0, budget=100, now=1000 → 1000-0=1000 > 100 → guard blocks recovery
    store.put(rec("s3", { state: "stalled", lastHeartbeat: 0, heartbeatBudgetMs: 100 }));
    const d = createDaemon({ store, now: () => 1000 });
    d.sweep();
    expect(store.get("p", "s3")?.state).toBe("stalled");
  });

  it("dispatch persists submitted then (headless) triggers launch hook", async () => {
    const store = createStore(dir);
    const launched: string[] = [];
    const d = createDaemon({
      store, now: () => 1, isPidAlive: () => true,
      launchHeadless: async (r) => { launched.push(r.id); },
    });
    const r: any = await d.handle({ kind: "dispatch", record: {
      id: "h9", project: "p", provider: "claude", mode: "headless",
      state: "submitted", task: "go", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });
    expect(r.state).toBe("submitted");
    expect(store.get("p", "h9")).toBeTruthy();
    expect(launched).toEqual(["h9"]);
  });

  // Red-team #4 (High): interactive dispatch with no interactive launcher must
  // FAIL LOUD, never silently sit in `submitted` forever.
  it("dispatch interactive (no launcher) → failed loud, never headless", async () => {
    const store = createStore(dir);
    const launched: string[] = [];
    const d = createDaemon({
      store, now: () => 1, launchHeadless: async (r) => { launched.push(r.id); },
    });
    const r: any = await d.handle({ kind: "dispatch", record: {
      id: "i9", project: "p", provider: "claude", mode: "interactive",
      state: "submitted", task: "go", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });
    expect(launched).toEqual([]);                 // headless launcher untouched
    expect(r.state).toBe("failed");               // loud, not black-hole
    expect(r.lastEvent).toBe("no-launcher");
    expect(r.error).toMatch(/interactive mode is not yet implemented/i);
    expect(store.get("p", "i9")?.state).toBe("failed"); // persisted
  });

  it("dispatch interactive uses launchInteractive when wired (forward hook)", async () => {
    const store = createStore(dir);
    const launched: string[] = [];
    const d = createDaemon({
      store, now: () => 1, launchInteractive: async (r) => { launched.push(r.id); },
    });
    const r: any = await d.handle({ kind: "dispatch", record: {
      id: "i10", project: "p", provider: "claude", mode: "interactive",
      state: "submitted", task: "go", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });
    expect(launched).toEqual(["i10"]);
    expect(r.state).toBe("submitted"); // launcher owns the lifecycle, not failed
  });

  it("dispatch headless: launchHeadless rejection drives task failed, daemon does not throw", async () => {
    const store = createStore(dir);
    const d = createDaemon({
      store, now: () => 1, isPidAlive: () => true,
      launchHeadless: async () => { throw new Error("no adapter for gemini"); },
    });
    const r: any = await d.handle({ kind: "dispatch", record: {
      id: "g9", project: "p", provider: "gemini", mode: "headless",
      state: "submitted", task: "go", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });
    expect(r.state).toBe("submitted"); // dispatch returns immediately
    await new Promise((res) => setTimeout(res, 10)); // let the rejection settle
    const after = store.get("p", "g9");
    expect(after?.state).toBe("failed");
    expect(after?.error).toBe("no adapter for gemini");
  });

  // Regression: daemon must route provider=codex interactive dispatch to the
  // injected launchInteractive hook (which cockpitd wires to CodexInteractiveDriver).
  it("daemon routes codex interactive dispatch to the driver", async () => {
    const calls: any[] = [];
    const fakeDriver = {
      dispatch: vi.fn().mockImplementation(async (rec: any) => { calls.push(["dispatch", rec.id]); }),
      reattach: vi.fn(),
      say: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), answer: vi.fn(),
    } as any;
    const store = createStore(dir);
    const d = createDaemon({
      store, now: () => 1,
      launchInteractive: (rec) =>
        rec.provider === "codex"
          ? fakeDriver.dispatch(rec)
          : Promise.reject(new Error("unhandled")),
    });
    const record: any = {
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "hi", createdAt: 1, lastHeartbeat: 1, lastEvent: "",
      heartbeatBudgetMs: 1000, attempts: [{ attemptId: "a", startedAt: 1, lastHeartbeatAt: 1 }],
    };
    await d.handle({ kind: "dispatch", record });
    expect(calls).toEqual([["dispatch", "t1"]]);
  });
});
