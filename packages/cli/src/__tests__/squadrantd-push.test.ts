// src/control/__tests__/squadrantd-push.test.ts
//
// Phase 3.5 (#109): daemon-side push notifications to captain on terminal
// task events. Tests the daemon.ts injection point with a fake `notify`
// dep — no real cmux, no real config, just the trigger logic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "@squadrant/core";
import { createStore } from "@squadrant/core";
import type { TaskRecord, ControlEvent } from "@squadrant/shared";

function rec(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, project: "p", provider: "claude", mode: "interactive",
    state: "working", task: "build the foo widget", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    ...overrides,
  };
}

interface NotifyCall {
  project: string;
  message: string;
}

function fakeNotify() {
  const calls: NotifyCall[] = [];
  return {
    calls,
    notify: (args: { project: string; message: string; record: TaskRecord; event: ControlEvent }) => {
      calls.push({ project: args.project, message: args.message });
    },
  };
}

describe("squadrantd push notifications (#109)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-push-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("done event triggers exactly one notify with CREW DONE prefix", async () => {
    const store = createStore(dir);
    store.put(rec("task-12345678", { task: "ship the widget" }));
    const n = fakeNotify();
    const d = createDaemon({ store, now: () => 2000, notify: n.notify });
    await d.handle({
      kind: "event",
      project: "p",
      event: { type: "task.done", id: "task-12345678", resultRef: "/tmp/missing-file-on-purpose" },
    });
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]?.project).toBe("p");
    expect(n.calls[0]?.message).toMatch(/^CREW DONE \[claude\/task-123/);
  });

  it("blocked event triggers CREW BLOCKED with the question", async () => {
    const store = createStore(dir);
    store.put(rec("task-blocked-1"));
    const n = fakeNotify();
    const d = createDaemon({ store, now: () => 2000, notify: n.notify });
    await d.handle({
      kind: "event",
      project: "p",
      event: { type: "task.blocked", id: "task-blocked-1", reason: "need-input", question: "which db?" },
    });
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]?.message).toMatch(/^CREW BLOCKED \[claude\/task-blo/);
    expect(n.calls[0]?.message).toContain("which db?");
  });

  it("failed event triggers CREW FAILED with the error", async () => {
    const store = createStore(dir);
    store.put(rec("task-failed-1"));
    const n = fakeNotify();
    const d = createDaemon({ store, now: () => 2000, notify: n.notify });
    await d.handle({
      kind: "event",
      project: "p",
      event: { type: "task.failed", id: "task-failed-1", error: "boom: subprocess crashed" },
    });
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]?.message).toMatch(/^CREW FAILED \[claude\/task-fai/);
    expect(n.calls[0]?.message).toContain("boom: subprocess crashed");
  });

  it("HEADLESS stall (from sweep) triggers CREW STALLED with budget", async () => {
    const store = createStore(dir);
    store.put(rec("task-stall-1", { mode: "headless", state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 250 }));
    const n = fakeNotify();
    const d = createDaemon({ store, now: () => 5000, notify: n.notify });
    await d.sweep();
    expect(store.get("p", "task-stall-1")?.state).toBe("stalled");
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]?.message).toMatch(/^CREW STALLED \[claude\/task-sta/);
    expect(n.calls[0]?.message).toMatch(/no heartbeat/i);
  });

  it("INTERACTIVE quiet (from sweep) triggers exactly one CREW QUIET notify, stays working (#354)", async () => {
    const store = createStore(dir);
    // rec() defaults to mode: "interactive"; no pendingTool → alive-thinking path.
    // firstTurnConfirmedAt set: this crew received its task and is quietly thinking (#466).
    store.put(rec("task-idle-1", { state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 250, firstTurnConfirmedAt: 1 }));
    const n = fakeNotify();
    const d = createDaemon({ store, now: () => 5000, notify: n.notify });
    await d.sweep();
    // Stays working — a quiet thinking turn is NOT awaiting-input (that lie is gone).
    expect(store.get("p", "task-idle-1")?.state).toBe("working");
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]?.message).toMatch(/^CREW QUIET \[claude\/task-idl/);
    expect(n.calls[0]?.message).not.toMatch(/stall/i);              // not a failure
    expect(n.calls[0]?.message).not.toMatch(/awaiting your input/i); // not idle/turn-end
    expect(n.calls[0]?.message).toMatch(/deep thinking/i);
  });

  it("CREW QUIET fires once per quiet episode across repeated sweeps → no storm (#354)", async () => {
    const store = createStore(dir);
    store.put(rec("task-idle-2", { state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 250, firstTurnConfirmedAt: 1 }));
    const n = fakeNotify();
    const d = createDaemon({ store, now: () => 5000, notify: n.notify });
    await d.sweep(); // quiet → one CREW QUIET
    await d.sweep(); // same liveness episode → debounced, no re-notify
    await d.sweep();
    expect(store.get("p", "task-idle-2")?.state).toBe("working");
    expect(n.calls).toHaveLength(1);
  });

  it("awaiting-input + task.started (captain resumes) → working, no extra notify", async () => {
    const store = createStore(dir);
    store.put(rec("task-idle-3", { state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 250, firstTurnConfirmedAt: 1 }));
    const n = fakeNotify();
    const d = createDaemon({ store, now: () => 5000, notify: n.notify });
    await d.sweep(); // → awaiting-input, push #1 (CREW IDLE)
    await d.handle({ kind: "event", project: "p", event: { type: "task.started", id: "task-idle-3" } });
    expect(store.get("p", "task-idle-3")?.state).toBe("working");
    expect(n.calls).toHaveLength(1); // working is not an attention state → no extra push
  });

  it("redundant terminal event does NOT re-notify (state-change guard)", async () => {
    const store = createStore(dir);
    // Already done — state machine ignores further events idempotently.
    store.put(rec("task-done-already", { state: "done" }));
    const n = fakeNotify();
    const d = createDaemon({ store, now: () => 2000, notify: n.notify });
    await d.handle({
      kind: "event",
      project: "p",
      event: { type: "task.done", id: "task-done-already", resultRef: "/tmp/x" },
    });
    expect(n.calls).toHaveLength(0);
  });

  it("liveness events (progress/heartbeat) do NOT notify", async () => {
    const store = createStore(dir);
    store.put(rec("task-live-1", { state: "working" }));
    const n = fakeNotify();
    const d = createDaemon({ store, now: () => 2000, notify: n.notify });
    await d.handle({
      kind: "event",
      project: "p",
      event: { type: "task.progress", id: "task-live-1" },
    });
    await d.handle({
      kind: "event",
      project: "p",
      event: { type: "heartbeat", id: "task-live-1" },
    });
    expect(n.calls).toHaveLength(0);
  });

  it("notifier throwing does NOT crash the daemon; event still applies", async () => {
    const store = createStore(dir);
    store.put(rec("task-bang-1"));
    const throwingNotify = () => { throw new Error("cmux is down"); };
    const d = createDaemon({ store, now: () => 2000, notify: throwingNotify });
    // The handle call must NOT reject.
    const r = await d.handle({
      kind: "event",
      project: "p",
      event: { type: "task.done", id: "task-bang-1", resultRef: "/tmp/x" },
    });
    expect((r as TaskRecord).state).toBe("done");
    // And the store still reflects the new state.
    expect(store.get("p", "task-bang-1")?.state).toBe("done");
  });
});
