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

  it("sweep: marks an over-budget working HEADLESS task stalled", async () => {
    const store = createStore(dir);
    store.put(rec("s1", { mode: "headless", state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 100 }));
    const d = createDaemon({ store, now: () => 1000 });
    d.sweep();
    expect(store.get("p", "s1")?.state).toBe("stalled");
  });

  it("sweep: marks an over-budget working INTERACTIVE task awaiting-input (not stalled)", async () => {
    const store = createStore(dir);
    store.put(rec("s1i", { mode: "interactive", state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 100 }));
    const d = createDaemon({ store, now: () => 1000 });
    d.sweep();
    expect(store.get("p", "s1i")?.state).toBe("awaiting-input");
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

  it("gate-resolve marks the gate resolved and calls resolveInteractiveGate", async () => {
    const calls: any[] = [];
    const recIn: any = {
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "blocked", task: "x", createdAt: 1, lastHeartbeat: 1, lastEvent: "",
      heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a", startedAt: 1, lastHeartbeatAt: 1 }],
      gates: [{ gateId: "g1", taskId: "t1", kind: "input", question: "?", state: "pending", createdAt: 1 }],
    };
    const store: any = {
      put: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      listAll: () => [recIn],
      quarantine: vi.fn(),
    };
    const d = createDaemon({
      store,
      now: () => 100,
      resolveInteractiveGate: (taskId: string, payload: unknown) => { calls.push(["answer", taskId, payload]); },
    });
    const res: any = await d.handle({ kind: "gate-resolve", project: "p", gateId: "g1", resolvedBy: "captain", payload: { text: "ok" } });
    expect(store.put).toHaveBeenCalled();
    const written = (store.put as any).mock.calls[0][0];
    expect(written.gates[0].state).toBe("resolved");
    expect(written.gates[0].resolvedBy).toBe("captain");
    expect(calls).toEqual([["answer", "t1", { text: "ok" }]]);
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

// ── Issue #184: crew close must terminalize daemon task silently ─────────────
describe("daemon – crew close terminalization (#184)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-d-cancel-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("task.cancelled on blocked task → state 'cancelled', no notify fired", async () => {
    const store = createStore(dir);
    store.put(rec("t-cancel", { state: "blocked", question: "awaiting captain?" }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 2000, notify: async (a) => { calls.push(a); } });
    await d.handle({ kind: "event", project: "p", event: { type: "task.cancelled", id: "t-cancel", reason: "closed by captain" } });
    expect(store.get("p", "t-cancel")?.state).toBe("cancelled");
    expect(calls.length).toBe(0); // captain-initiated close is silent — no CREW CANCELLED push
  });

  it("task.cancelled on working task → cancelled, no notify fired", async () => {
    const store = createStore(dir);
    store.put(rec("t-cancel-w", { state: "working" }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 2000, notify: async (a) => { calls.push(a); } });
    await d.handle({ kind: "event", project: "p", event: { type: "task.cancelled", id: "t-cancel-w" } });
    expect(store.get("p", "t-cancel-w")?.state).toBe("cancelled");
    expect(calls.length).toBe(0);
  });

  it("task.cancelled on awaiting-input task → cancelled, no notify fired", async () => {
    const store = createStore(dir);
    store.put(rec("t-cancel-i", { state: "awaiting-input" }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 2000, notify: async (a) => { calls.push(a); } });
    await d.handle({ kind: "event", project: "p", event: { type: "task.cancelled", id: "t-cancel-i" } });
    expect(store.get("p", "t-cancel-i")?.state).toBe("cancelled");
    expect(calls.length).toBe(0);
  });
});

// ── Bug #183: silent re-block — blocked crew misses second permission prompt ──
// Root cause: runCrewSend emits no resume event for blocked tasks.
// task.progress keeps state=blocked (anti-auto-unblock, state-machine:58).
// A second task.blocked on an already-blocked task hits the idempotency guard
// (state-machine:69) and firePush prev===next swallows it silently.
// Fix: runCrewSend must emit task.started for blocked/awaiting-input tasks
// before sending to pane — clearing to working so the next real block re-fires.
describe("daemon – blocked crew resume path (#183)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-d-resume-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("blocked + task.progress stays blocked AND second task.blocked fires NO notify (bug path)", async () => {
    // Demonstrates the silent-miss: without a resume event the captain never
    // learns about the second permission prompt.
    const store = createStore(dir);
    store.put(rec("t-miss", { state: "blocked", question: "first prompt" }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 2000, notify: async (a) => { calls.push(a); } });
    // Captain sends answer via pane → crew resumes → PostToolUse fires progress
    await d.handle({ kind: "event", project: "p", event: { type: "task.progress", id: "t-miss", note: "posttooluse" } });
    expect(store.get("p", "t-miss")?.state).toBe("blocked"); // stays blocked (correct per anti-auto-unblock)
    // Crew hits a second permission prompt
    await d.handle({ kind: "event", project: "p", event: { type: "task.blocked", id: "t-miss", reason: "r", question: "second prompt" } });
    expect(store.get("p", "t-miss")?.state).toBe("blocked");
    expect(calls.length).toBe(0); // second block silently absorbed — captain missed it
  });

  it("blocked + task.started (resume) → working + second task.blocked fires CREW BLOCKED (#183 fix path)", async () => {
    // The fix: runCrewSend emits task.started before sendToPane so the crew
    // re-enters working state and the next real block fires a fresh notification.
    const store = createStore(dir);
    store.put(rec("t-fix", { state: "blocked", question: "first prompt" }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 2000, notify: async (a) => { calls.push(a); } });
    // runCrewSend emits task.started before delivering captain's answer to pane
    await d.handle({ kind: "event", project: "p", event: { type: "task.started", id: "t-fix" } });
    expect(store.get("p", "t-fix")?.state).toBe("working"); // cleared to working
    expect(store.get("p", "t-fix")?.question).toBeUndefined(); // question cleared
    // Crew hits a second permission prompt
    await d.handle({ kind: "event", project: "p", event: { type: "task.blocked", id: "t-fix", reason: "r", question: "second prompt" } });
    expect(store.get("p", "t-fix")?.state).toBe("blocked");
    expect(calls.length).toBe(1); // CREW BLOCKED fired for second prompt
    expect(calls[0].message).toContain("CREW BLOCKED");
    expect(calls[0].message).toContain("second prompt");
  });

  // ── #214: DONE message preservation (unified formatter) ───────────────────
  it("CREW DONE prefers the crew's signal-done message over the task snippet", async () => {
    const store = createStore(dir);
    store.put(rec("t-dm", { state: "working", task: "the original assigned task" }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 2000, notify: async (a) => { calls.push(a); } });
    await d.handle({ kind: "event", project: "p", event: { type: "task.done", id: "t-dm", resultRef: "/r", message: "fixed the formatter, all tests pass" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe("CREW DONE [claude/t-dm]: fixed the formatter, all tests pass");
  });

  it("CREW DONE falls back to the task snippet when no message is provided", async () => {
    const store = createStore(dir);
    store.put(rec("t-ds", { state: "working", task: "implement the thing" }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 2000, notify: async (a) => { calls.push(a); } });
    await d.handle({ kind: "event", project: "p", event: { type: "task.done", id: "t-ds", resultRef: "/r" } });
    expect(calls[0].message).toBe("CREW DONE [claude/t-ds]: implement the thing");
  });

  // ── #210: CREW IDLE debounce ──────────────────────────────────────────────
  // awaiting-input fires CREW IDLE, but must NOT spam during an active
  // captain-driven back-and-forth: a turn-end shortly after the captain's own
  // task.started (crew send/reply) is suppressed; a genuine self-idle delivers.
  describe("CREW IDLE debounce (#210)", () => {
    it("suppresses CREW IDLE when the turn ends within the debounce window of a captain turn", async () => {
      const store = createStore(dir);
      store.put(rec("t-deb", { state: "working" }));
      const calls: any[] = [];
      let nowMs = 10_000;
      const d = createDaemon({ store, now: () => nowMs, notify: async (a) => { calls.push(a); } });
      // Captain sends → task.started (working → working, records lastCaptainTurnAt)
      await d.handle({ kind: "event", project: "p", event: { type: "task.started", id: "t-deb" } });
      // Crew finishes the turn 3s later (well within the window)
      nowMs = 13_000;
      await d.handle({ kind: "event", project: "p", event: { type: "task.turn.completed", id: "t-deb", turnId: "turn-1" } });
      expect(store.get("p", "t-deb")?.state).toBe("awaiting-input");
      expect(calls.filter((c) => c.message.includes("CREW IDLE"))).toHaveLength(0);
    });

    it("delivers CREW IDLE for a self-idle turn-end long after the captain's last turn", async () => {
      const store = createStore(dir);
      store.put(rec("t-self", { state: "working" }));
      const calls: any[] = [];
      let nowMs = 10_000;
      const d = createDaemon({ store, now: () => nowMs, notify: async (a) => { calls.push(a); } });
      await d.handle({ kind: "event", project: "p", event: { type: "task.started", id: "t-self" } });
      // Turn ends far outside the debounce window → genuine idle, must deliver
      nowMs = 10_000 + 5 * 60_000;
      await d.handle({ kind: "event", project: "p", event: { type: "task.turn.completed", id: "t-self", turnId: "turn-1" } });
      const idle = calls.filter((c) => c.message.includes("CREW IDLE"));
      expect(idle).toHaveLength(1);
    });

    it("delivers CREW IDLE for a turn-end with no prior captain turn at all", async () => {
      const store = createStore(dir);
      store.put(rec("t-none", { state: "working" }));
      const calls: any[] = [];
      const d = createDaemon({ store, now: () => 50_000, notify: async (a) => { calls.push(a); } });
      await d.handle({ kind: "event", project: "p", event: { type: "task.turn.completed", id: "t-none", turnId: "turn-1" } });
      expect(calls.filter((c) => c.message.includes("CREW IDLE"))).toHaveLength(1);
    });

    it("does NOT debounce CREW BLOCKED even right after a captain turn", async () => {
      const store = createStore(dir);
      store.put(rec("t-blk", { state: "working" }));
      const calls: any[] = [];
      const d = createDaemon({ store, now: () => 2000, notify: async (a) => { calls.push(a); } });
      await d.handle({ kind: "event", project: "p", event: { type: "task.started", id: "t-blk" } });
      await d.handle({ kind: "event", project: "p", event: { type: "task.blocked", id: "t-blk", reason: "r", question: "q" } });
      expect(calls.filter((c) => c.message.includes("CREW BLOCKED"))).toHaveLength(1);
    });
  });

  it("awaiting-input + task.started → working + subsequent task.blocked fires CREW BLOCKED (#183)", async () => {
    // Same fix path for crews that went idle (awaiting-input) before captain replied.
    const store = createStore(dir);
    store.put(rec("t-idle", { state: "awaiting-input" }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 2000, notify: async (a) => { calls.push(a); } });
    await d.handle({ kind: "event", project: "p", event: { type: "task.started", id: "t-idle" } });
    expect(store.get("p", "t-idle")?.state).toBe("working");
    await d.handle({ kind: "event", project: "p", event: { type: "task.blocked", id: "t-idle", reason: "r", question: "a prompt" } });
    expect(calls.length).toBe(1);
    expect(calls[0].message).toContain("CREW BLOCKED");
  });
});
