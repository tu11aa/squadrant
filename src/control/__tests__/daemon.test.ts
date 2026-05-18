// src/control/__tests__/daemon.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
});
