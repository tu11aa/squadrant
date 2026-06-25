// packages/core/src/__tests__/daemon.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon, crewTag } from "../daemon.js";
import { createStore } from "../store.js";
import type { TaskRecord } from "@squadrant/shared";

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
    await d.reconcile();
    expect(store.get("p", "h1")?.state).toBe("failed");
    expect(store.get("p", "h1")?.error).toMatch(/orphan|daemon restart/i);
  });

  // #139: on daemon restart a LIVE interactive crew's cmux pane survives the
  // bounce, so it must NOT be moved to 'stalled' (the old behavior false-stalled
  // it AND fired CREW STALLED). Only a PROVABLY-gone surface is terminalized.
  it("reconcile: interactive orphan with a GONE surface → cancelled (silent) (#139)", async () => {
    const store = createStore(dir);
    store.put(rec("i1", { state: "working", mode: "interactive" }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 5000, isSurfaceAlive: async () => "gone", notify: async (a) => { calls.push(a); } });
    await d.reconcile();
    expect(store.get("p", "i1")?.state).toBe("cancelled");
    expect(calls.length).toBe(0); // silent — no CREW STALLED re-emitted
  });

  it("reconcile: interactive orphan with a LIVE surface stays working (reattachable) (#139)", async () => {
    const store = createStore(dir);
    store.put(rec("i2", { state: "working", mode: "interactive" }));
    const d = createDaemon({ store, now: () => 5000, isSurfaceAlive: async () => "alive" });
    await d.reconcile();
    expect(store.get("p", "i2")?.state).toBe("working");
  });

  it("reconcile: interactive orphan with UNKNOWN surface liveness stays working (never false-cancel) (#139)", async () => {
    const store = createStore(dir);
    store.put(rec("i3", { state: "working", mode: "interactive" }));
    const d = createDaemon({ store, now: () => 5000, isSurfaceAlive: async () => "unknown" });
    await d.reconcile();
    expect(store.get("p", "i3")?.state).toBe("working");
  });

  it("reconcile: working headless task with live pid → stays working", async () => {
    const store = createStore(dir);
    store.put(rec("h2", { state: "working", mode: "headless", pid: 4242 }));
    const d = createDaemon({ store, now: () => 5000, isPidAlive: () => true });
    await d.reconcile();
    expect(store.get("p", "h2")?.state).toBe("working");
  });

  // #259: crash-restart re-ran reconcile() → launchHeadless → real spawn, multiplying
  // orphans. An in-flight launch (no pid yet) must not be failed by reconcile.
  it("reconcile: headless task with in-flight launch is not marked failed (#259)", async () => {
    const store = createStore(dir);
    store.put(rec("hif", { state: "submitted", mode: "headless" }));
    const d = createDaemon({
      store, now: () => 5000,
      isPidAlive: () => false,
      isHeadlessInFlight: (id) => id === "hif",
    });
    await d.reconcile();
    expect(store.get("p", "hif")?.state).toBe("submitted");
  });

  it("sweep: marks an over-budget working HEADLESS task stalled", async () => {
    const store = createStore(dir);
    store.put(rec("s1", { mode: "headless", state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 100 }));
    const d = createDaemon({ store, now: () => 1000 });
    await d.sweep();
    expect(store.get("p", "s1")?.state).toBe("stalled");
  });

  // #354: a quiet INTERACTIVE crew with no tool in flight is alive-thinking, NOT
  // awaiting-input — the watchdog no longer flips it. It stays `working` and the
  // sweep emits a distinct, non-alarming CREW QUIET notify (once per episode).
  it("sweep: over-budget INTERACTIVE task with no tool in flight stays working + CREW QUIET (#354)", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    store.put(rec("s1i", { mode: "interactive", state: "working", lastHeartbeat: 0,
      heartbeatBudgetMs: 100, attempts: [{ attemptId: "a0", startedAt: 0, lastHeartbeatAt: 0 }] }));
    const d = createDaemon({ store, now: () => 1000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(store.get("p", "s1i")?.state).toBe("working");
    expect(calls.length).toBe(1);
    expect(calls[0].message).toMatch(/CREW QUIET/);
    expect(calls[0].event.type).toBe("task.quiet");
  });

  // #354: an interactive crew with a tool in flight (PreToolUse, no PostToolUse)
  // past the tool-stall budget IS a hung tool call → stalled, with a tool-named,
  // recoverable CREW STALLED warn.
  it("sweep: INTERACTIVE crew with a hung tool past tool-stall budget → stalled + CREW STALLED(tool) (#354)", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    store.put(rec("s1t", { mode: "interactive", state: "working", lastHeartbeat: 0,
      heartbeatBudgetMs: 100, pendingTool: { name: "Bash", since: 0 },
      attempts: [{ attemptId: "a0", startedAt: 0, lastHeartbeatAt: 0 }] }));
    // now far beyond the 10-min default tool-stall budget
    const d = createDaemon({ store, now: () => 11 * 60_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(store.get("p", "s1t")?.state).toBe("stalled");
    expect(calls.length).toBe(1);
    expect(calls[0].message).toMatch(/CREW STALLED.*Bash.*possibly hung/);
  });

  // #354: a long-but-live tool (within the tool-stall budget) does NOT trip —
  // the false-stalled guard for legit multi-minute test suites / builds.
  it("sweep: INTERACTIVE crew with a tool in flight WITHIN tool-stall budget → no stall, no QUIET (#354)", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    store.put(rec("s1l", { mode: "interactive", state: "working", lastHeartbeat: 0,
      heartbeatBudgetMs: 100, pendingTool: { name: "Bash", since: 0 },
      attempts: [{ attemptId: "a0", startedAt: 0, lastHeartbeatAt: 0 }] }));
    const d = createDaemon({ store, now: () => 5 * 60_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(store.get("p", "s1l")?.state).toBe("working");
    expect(calls.length).toBe(0);
  });

  it("sweep: recovers a stalled task that has a fresh heartbeat", async () => {
    const store = createStore(dir);
    store.put(rec("s2", { state: "stalled", lastHeartbeat: 990, heartbeatBudgetMs: 100 }));
    const d = createDaemon({ store, now: () => 1000 });
    await d.sweep();
    expect(store.get("p", "s2")?.state).toBe("working");
  });

  it("sweep: stalled task with old heartbeat is NOT recovered", async () => {
    const store = createStore(dir);
    // lastHeartbeat=0, budget=100, now=1000 → 1000-0=1000 > 100 → guard blocks recovery
    store.put(rec("s3", { state: "stalled", lastHeartbeat: 0, heartbeatBudgetMs: 100 }));
    const d = createDaemon({ store, now: () => 1000 });
    await d.sweep();
    expect(store.get("p", "s3")?.state).toBe("stalled");
  });

  // ── #139 backstop: sweep reaps interactive records whose surface is gone ─────
  // Covers opencode crews (no SessionEnd hook) and any missed claude SessionEnd.
  // A provably-gone surface means the crew can never make progress → cancelled,
  // silently (NOT oscillated working↔stalled, NOT a re-fired CREW STALLED).
  it("sweep: interactive WORKING record with a gone surface → cancelled (silent), within 24h budget (#139)", async () => {
    const store = createStore(dir);
    // Heartbeat is FRESH (well within the 24h budget) — proves the reap is
    // liveness-based, not a shorter timeout. The legitimate-idle false-stall fix
    // (#131/#133) keeps the 86400000ms budget; only a dead surface reaps.
    store.put(rec("g1", { mode: "interactive", state: "working", lastHeartbeat: 990, heartbeatBudgetMs: 86_400_000 }));
    const calls: any[] = [];
    const d = createDaemon({ store, now: () => 1000, isSurfaceAlive: async () => "gone", notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(store.get("p", "g1")?.state).toBe("cancelled");
    expect(calls.length).toBe(0); // silent reap
  });

  it("sweep: interactive AWAITING-INPUT record with a gone surface → cancelled (#139)", async () => {
    const store = createStore(dir);
    store.put(rec("g2", { mode: "interactive", state: "awaiting-input", lastHeartbeat: 990, heartbeatBudgetMs: 86_400_000 }));
    const d = createDaemon({ store, now: () => 1000, isSurfaceAlive: async () => "gone" });
    await d.sweep();
    expect(store.get("p", "g2")?.state).toBe("cancelled");
  });

  it("sweep: interactive STALLED record with a gone surface → cancelled (not left oscillating) (#139)", async () => {
    const store = createStore(dir);
    store.put(rec("g3", { mode: "interactive", state: "stalled", lastHeartbeat: 990, heartbeatBudgetMs: 86_400_000 }));
    const d = createDaemon({ store, now: () => 1000, isSurfaceAlive: async () => "gone" });
    await d.sweep();
    expect(store.get("p", "g3")?.state).toBe("cancelled");
  });

  // The critical non-regression: a LEGITIMATELY-IDLE live crew (surface alive)
  // that is over its heartbeat budget must NEVER be reaped. Post-#354 a quiet
  // thinking crew stays `working` (CREW QUIET, not awaiting-input); the point of
  // this test — alive/unknown surfaces are not false-reaped — still holds.
  it("sweep: interactive over-budget record with a LIVE surface → stays working, not reaped (#139/#354)", async () => {
    const store = createStore(dir);
    store.put(rec("g4", { mode: "interactive", state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 100,
      attempts: [{ attemptId: "a0", startedAt: 0, lastHeartbeatAt: 0 }] }));
    const d = createDaemon({ store, now: () => 1000, isSurfaceAlive: async () => "alive" });
    await d.sweep();
    expect(store.get("p", "g4")?.state).toBe("working");
  });

  it("sweep: interactive over-budget record with UNKNOWN surface → stays working, never false-reaped (#139/#354)", async () => {
    const store = createStore(dir);
    store.put(rec("g5", { mode: "interactive", state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 100,
      attempts: [{ attemptId: "a0", startedAt: 0, lastHeartbeatAt: 0 }] }));
    const d = createDaemon({ store, now: () => 1000, isSurfaceAlive: async () => "unknown" });
    await d.sweep();
    expect(store.get("p", "g5")?.state).toBe("working");
  });

  it("sweep: deletes terminal records older than TTL, keeps fresh terminal and old non-terminal (#378 GC)", async () => {
    const store = createStore(dir);
    const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
    const NOW = 1_000_000_000;

    // (a) cancelled, lastHeartbeat 8 days ago → should be GC'd
    store.put(rec("gc-old-term", { state: "cancelled", createdAt: NOW - EIGHT_DAYS_MS, lastHeartbeat: NOW - EIGHT_DAYS_MS, heartbeatBudgetMs: 86_400_000 }));
    // (b) cancelled, lastHeartbeat 1 min ago → should stay
    store.put(rec("gc-fresh-term", { state: "cancelled", createdAt: NOW - 60000, lastHeartbeat: NOW - 60000, heartbeatBudgetMs: 86_400_000 }));
    // (c) working, lastHeartbeat 8 days ago → should stay (non-terminal)
    store.put(rec("gc-old-live", { state: "working", createdAt: NOW - EIGHT_DAYS_MS, lastHeartbeat: NOW - EIGHT_DAYS_MS, heartbeatBudgetMs: 86_400_000, mode: "headless" }));

    const d = createDaemon({ store, now: () => NOW });
    await d.sweep();

    expect(store.get("p", "gc-old-term")).toBeUndefined();
    expect(store.get("p", "gc-fresh-term")?.state).toBe("cancelled");
    expect(store.get("p", "gc-old-live")).toBeTruthy();
  });

  it("sweep: headless records are never surface-reaped (pid is their liveness) (#139)", async () => {
    const store = createStore(dir);
    // A headless working record with a fresh heartbeat: even if isSurfaceAlive
    // says 'gone', headless mode must ignore it (it has no cmux surface).
    store.put(rec("g6", { mode: "headless", state: "working", lastHeartbeat: 990, heartbeatBudgetMs: 1000 }));
    const d = createDaemon({ store, now: () => 1000, isSurfaceAlive: async () => "gone" });
    await d.sweep();
    expect(store.get("p", "g6")?.state).toBe("working");
  });

  // ── Issue #227: SessionEnd surface-liveness gate ─────────────────────────
  // A task.session.ended event must ONLY terminalize the record when the
  // crew's surface is PROVABLY gone. If the surface is alive or liveness is
  // unknown, the event is a no-op — prevents a nested/spurious SessionEnd
  // from false-cancelling a live working crew (#227 regression). The
  // 'gone'-only / 'unknown'-never-reaps semantics are identical to the sweep.
  it("event: task.session.ended on a LIVE interactive surface → no-op, NOT cancelled (#227)", async () => {
    const store = createStore(dir);
    store.put(rec("s227a", { mode: "interactive", name: "crew-1", state: "working" }));
    const d = createDaemon({ store, now: () => 1000, isSurfaceAlive: async () => "alive" });
    const r = await d.handle({ kind: "event", project: "p", event: { type: "task.session.ended", id: "s227a" } });
    expect((r as TaskRecord).state).toBe("working");
    expect(store.get("p", "s227a")?.state).toBe("working");
  });

  it("event: task.session.ended on UNKNOWN surface liveness → no-op, NOT cancelled (#227)", async () => {
    const store = createStore(dir);
    store.put(rec("s227b", { mode: "interactive", name: "crew-1", state: "awaiting-input" }));
    // No isSurfaceAlive passed → defaults to always-unknown
    const d = createDaemon({ store, now: () => 1000 });
    const r = await d.handle({ kind: "event", project: "p", event: { type: "task.session.ended", id: "s227b" } });
    expect((r as TaskRecord).state).toBe("awaiting-input");
    expect(store.get("p", "s227b")?.state).toBe("awaiting-input");
  });

  it("event: task.session.ended on a GONE surface → cancelled (#139 regression preserved) (#227)", async () => {
    const store = createStore(dir);
    store.put(rec("s227c", { mode: "interactive", name: "crew-1", state: "blocked", question: "?" }));
    const d = createDaemon({ store, now: () => 1000, isSurfaceAlive: async () => "gone" });
    const r = await d.handle({ kind: "event", project: "p", event: { type: "task.session.ended", id: "s227c" } });
    expect((r as TaskRecord).state).toBe("cancelled");
    expect(store.get("p", "s227c")?.state).toBe("cancelled");
  });

  it("event: task.session.ended on an already-terminal task is a no-op regardless of liveness (#227)", async () => {
    const store = createStore(dir);
    store.put(rec("s227d", { state: "done", resultRef: "/r" }));
    const d = createDaemon({ store, now: () => 1000, isSurfaceAlive: async () => "alive" });
    const r = await d.handle({ kind: "event", project: "p", event: { type: "task.session.ended", id: "s227d" } });
    expect((r as TaskRecord).state).toBe("done"); // terminal state is absorbing — no state change
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
  // injected launchInteractive hook (which squadrantd wires to CodexInteractiveDriver).
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

// ── Issue #225: hard crew task-timeout ───────────────────────────────────────
// A per-task wall-clock ceiling distinct from the 24h interactive heartbeat
// budget. A crew can keep heartbeating (state 'working', never 'stalled') yet
// be stuck on one task for hours — nothing catches that today. This does.
// DETECT-ONLY: fires a CREW TIMEOUT notify push via the existing notify hook.
// Deduped: fires ONCE per overrun, not on every sweep.
describe("sweep: task-timeout (#225)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-d-timeout-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fires CREW TIMEOUT when task wall-clock exceeds ceiling while heartbeat is fresh", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    // createdAt=0, now=2000, ceiling=1000 → age 2000ms > ceiling
    // lastHeartbeat=1990 → heartbeat age 10ms < 24h budget → NOT stalled: proves
    // this catches the heartbeating-but-stuck scenario the stall watchdog misses
    store.put(rec("t225a", {
      state: "working", createdAt: 0,
      lastHeartbeat: 1990, heartbeatBudgetMs: 86_400_000,
    }));
    const d = createDaemon({ store, now: () => 2000, taskTimeoutMs: 1_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toMatch(/CREW TIMEOUT/);
  });

  it("escalation message names the crew and the full task id", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    store.put(rec("t225b", {
      state: "working", name: "my-crew", createdAt: 0,
      lastHeartbeat: 1990, heartbeatBudgetMs: 86_400_000,
    }));
    const d = createDaemon({ store, now: () => 2000, taskTimeoutMs: 1_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain("my-crew");
    expect(calls[0].message).toContain("t225b");
  });

  it("fires ONLY ONCE across multiple sweeps (dedup)", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    store.put(rec("t225c", {
      state: "working", createdAt: 0,
      lastHeartbeat: 1990, heartbeatBudgetMs: 86_400_000,
    }));
    const d = createDaemon({ store, now: () => 2000, taskTimeoutMs: 1_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    await d.sweep();
    await d.sweep();
    expect(calls.filter((c) => c.message.includes("CREW TIMEOUT"))).toHaveLength(1);
  });

  it("does NOT fire when task wall-clock is within the ceiling", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    // createdAt=0, now=500, ceiling=1000 → age 500ms < ceiling → no fire
    store.put(rec("t225d", {
      state: "working", createdAt: 0,
      lastHeartbeat: 490, heartbeatBudgetMs: 86_400_000,
    }));
    const d = createDaemon({ store, now: () => 500, taskTimeoutMs: 1_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(calls.filter((c) => c.message.includes("CREW TIMEOUT"))).toHaveLength(0);
  });

  it("does NOT fire for terminal tasks regardless of age", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    store.put(rec("t225e", { state: "done", createdAt: 0, resultRef: "/r", heartbeatBudgetMs: 86_400_000 }));
    store.put(rec("t225e2", { state: "failed", createdAt: 0, error: "x", heartbeatBudgetMs: 86_400_000 }));
    store.put(rec("t225e3", { state: "cancelled", createdAt: 0, heartbeatBudgetMs: 86_400_000 }));
    const d = createDaemon({ store, now: () => 9_999_999, taskTimeoutMs: 1_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(calls.filter((c) => c.message.includes("CREW TIMEOUT"))).toHaveLength(0);
  });

  it("uses DEFAULT_TASK_TIMEOUT_MS (8h) when taskTimeoutMs is not configured", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    const NINE_HOURS = 9 * 60 * 60 * 1000;
    store.put(rec("t225f", {
      state: "working", createdAt: 0,
      lastHeartbeat: NINE_HOURS - 100, heartbeatBudgetMs: 86_400_000,
    }));
    // No taskTimeoutMs → should use 8h default; 9h age exceeds it
    const d = createDaemon({ store, now: () => NINE_HOURS, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(calls.filter((c) => c.message.includes("CREW TIMEOUT"))).toHaveLength(1);
  });

  it("does NOT fire when no notify hook is wired (safe no-op)", async () => {
    const store = createStore(dir);
    store.put(rec("t225g", {
      state: "working", createdAt: 0,
      lastHeartbeat: 1990, heartbeatBudgetMs: 86_400_000,
    }));
    // No notify dep — must not throw
    const d = createDaemon({ store, now: () => 2000, taskTimeoutMs: 1_000 });
    await expect(d.sweep()).resolves.toBeUndefined();
  });

  // ── #225 root-fix: terminate-on-timeout (Fix C) ──────────────────────────────

  it("timeout terminates task record (state=cancelled, lastEvent=sweep.task-timeout)", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    store.put(rec("t225h", {
      state: "working", createdAt: 0,
      lastHeartbeat: 1990, heartbeatBudgetMs: 86_400_000,
    }));
    const d = createDaemon({ store, now: () => 2000, taskTimeoutMs: 1_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toMatch(/CREW TIMEOUT/);
    const r = store.get("p", "t225h");
    expect(r?.state).toBe("cancelled");
    expect(r?.lastEvent).toBe("sweep.task-timeout");
  });

  it("timeout message shows original state, not 'cancelled' (Fix C note 1)", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    store.put(rec("t225i", {
      state: "awaiting-input", createdAt: 0,
      lastHeartbeat: 1990, heartbeatBudgetMs: 86_400_000,
    }));
    const d = createDaemon({ store, now: () => 2000, taskTimeoutMs: 1_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    expect(calls[0].message).toContain("awaiting-input");
    expect(calls[0].message).not.toContain("state: cancelled");
  });

  it("flood proof: fresh daemon over same store never re-fires (Fix C persistent dedup)", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    const notify = async (a: any) => { calls.push(a); };
    store.put(rec("t225j", {
      state: "working", createdAt: 0,
      lastHeartbeat: 1990, heartbeatBudgetMs: 86_400_000,
    }));

    const d1 = createDaemon({ store, now: () => 2000, taskTimeoutMs: 1_000, notify });
    await d1.sweep();
    const timeoutCalls = () => calls.filter((c) => c.message.includes("CREW TIMEOUT")).length;
    expect(timeoutCalls()).toBe(1);

    // Second sweep on same daemon: task is terminal, no re-fire
    await d1.sweep();
    expect(timeoutCalls()).toBe(1);

    // Fresh daemon, same store, empty in-memory state — this is the flood scenario.
    // Terminal state in the store is the persistent dedup: must still be exactly 1.
    const d2 = createDaemon({ store, now: () => 2000, taskTimeoutMs: 1_000, notify });
    await d2.sweep();
    expect(timeoutCalls()).toBe(1);
  });

  // ── #378 regression: zombie resurrection ────────────────────────────────────
  // A timed-out interactive task with a hung pendingTool would have evaluateStall
  // operate on the stale `r` (still 'working'), clobbering the just-written
  // 'cancelled' state back to 'stalled'. This caused infinite CREW TIMEOUT re-fire.
  it("#378: timeout-cancelled state is NOT clobbered by evaluateStall on the same sweep", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    const TOOL_STALL_BUDGET_MS = 10 * 60 * 1000;
    // createdAt=0, now=2000, ceiling=1000 → age 2000ms > ceiling (triggers timeout)
    // pendingTool.since = 2000 - (TOOL_STALL_BUDGET_MS + 1000) → hung > tool-stall budget
    // → without the fix, evaluateStall would return state='stalled' and clobber 'cancelled'
    const now = 2000;
    store.put(rec("t378a", {
      state: "working", mode: "interactive", createdAt: 0,
      lastHeartbeat: 1990, heartbeatBudgetMs: 86_400_000,
      pendingTool: { name: "Bash", since: now - TOOL_STALL_BUDGET_MS - 1000 },
    }));
    const d = createDaemon({ store, now: () => now, taskTimeoutMs: 1_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    // Terminal state must survive — evaluateStall must not clobber it
    const r = store.get("p", "t378a");
    expect(r?.state).toBe("cancelled");
    expect(r?.lastEvent).toBe("sweep.task-timeout");
  });

  it("#378: second sweep on a timeout-cancelled task fires CREW TIMEOUT exactly once total", async () => {
    const store = createStore(dir);
    const calls: any[] = [];
    const TOOL_STALL_BUDGET_MS = 10 * 60 * 1000;
    const now = 2000;
    store.put(rec("t378b", {
      state: "working", mode: "interactive", createdAt: 0,
      lastHeartbeat: 1990, heartbeatBudgetMs: 86_400_000,
      pendingTool: { name: "Bash", since: now - TOOL_STALL_BUDGET_MS - 1000 },
    }));
    const d = createDaemon({ store, now: () => now, taskTimeoutMs: 1_000, notify: async (a) => { calls.push(a); } });
    await d.sweep();
    await d.sweep(); // second sweep — must see cancelled, skip entirely
    const timeoutCalls = calls.filter((c) => c.message.includes("CREW TIMEOUT")).length;
    expect(timeoutCalls).toBe(1);
    expect(store.get("p", "t378b")?.state).toBe("cancelled");
  });
});

// ── Issue #87: socket-boundary schema validation ──────────────────────────────

describe("daemon handle() socket-boundary validation (#87)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-val-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("handle() rejects completely unknown request kind with a clear structured error", async () => {
    const store = createStore(dir);
    const d = createDaemon({ store, now: () => 1000 });
    await expect(
      d.handle({ kind: "UNKNOWN_KIND_INJECTED_BY_ROGUE_CLIENT" } as any),
    ).rejects.toThrow(/unknown.*kind|unhandled.*kind/i);
  });

  it("handle() rejects unknown event type with a clear validation error — NOT a store corruption (#87)", async () => {
    const store = createStore(dir);
    const task = rec("t-validate", { state: "working" });
    store.put(task);
    const d = createDaemon({ store, now: () => 2000 });
    await expect(
      d.handle({
        kind: "event",
        project: "p",
        event: { type: "future.unknown.event.from.wire", id: "t-validate" } as any,
      }),
    ).rejects.toThrow(/unknown.*event.*type|event.*type.*unknown/i);
    // The store record must be UNCHANGED — no corruption from reduce() returning undefined.
    expect(store.get("p", "t-validate")?.state).toBe("working");
  });
});

// ── Issue #246: cross-project delegation report-back ──────────────────────────

describe("daemon report-back on settle with originProject (#246)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-246-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function rec246(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      id, project: "projB", provider: "claude", mode: "interactive",
      state: "working", task: "t", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
      originProject: "projA",
      ...overrides,
    };
  }

  it("fires notify to origin project when task transitions to done", async () => {
    const store = createStore(dir);
    const calls: Array<{ project: string; message: string }> = [];
    const notify = vi.fn(async (a: { project: string; message: string }) => { calls.push(a); });
    store.put(rec246("t-done"));
    const d = createDaemon({ store, now: () => 2000, notify });

    await d.handle({ kind: "event", project: "projB", event: { type: "task.done", id: "t-done", resultRef: "/tmp/r" } });

    const originCalls = calls.filter((c) => c.project === "projA");
    expect(originCalls.length).toBe(1);
    expect(originCalls[0].message).toMatch(/projB.*done|delegat/i);
  });

  it("fires notify to origin project when task transitions to blocked", async () => {
    const store = createStore(dir);
    const calls: Array<{ project: string; message: string }> = [];
    const notify = vi.fn(async (a: { project: string; message: string }) => { calls.push(a); });
    store.put(rec246("t-blocked"));
    const d = createDaemon({ store, now: () => 2000, notify });

    await d.handle({ kind: "event", project: "projB", event: { type: "task.blocked", id: "t-blocked", reason: "stuck", question: "help" } });

    const originCalls = calls.filter((c) => c.project === "projA");
    expect(originCalls.length).toBe(1);
    expect(originCalls[0].message).toMatch(/blocked|stuck/i);
  });

  it("fires notify to origin project when task transitions to failed", async () => {
    const store = createStore(dir);
    const calls: Array<{ project: string; message: string }> = [];
    const notify = vi.fn(async (a: { project: string; message: string }) => { calls.push(a); });
    store.put(rec246("t-failed"));
    const d = createDaemon({ store, now: () => 2000, notify });

    await d.handle({ kind: "event", project: "projB", event: { type: "task.failed", id: "t-failed", error: "oops" } });

    const originCalls = calls.filter((c) => c.project === "projA");
    expect(originCalls.length).toBe(1);
    expect(originCalls[0].message).toMatch(/failed|oops/i);
  });

  it("does NOT fire report-back when task has no originProject", async () => {
    const store = createStore(dir);
    const calls: Array<{ project: string; message: string }> = [];
    const notify = vi.fn(async (a: { project: string; message: string }) => { calls.push(a); });
    store.put(rec246("t-no-origin", { originProject: undefined }));
    const d = createDaemon({ store, now: () => 2000, notify });

    await d.handle({ kind: "event", project: "projB", event: { type: "task.done", id: "t-no-origin", resultRef: "/tmp/r" } });

    const originCalls = calls.filter((c) => c.project === "projA");
    expect(originCalls.length).toBe(0);
  });

  it("does NOT fire report-back when task settles but originProject equals project (self-delegation no-op)", async () => {
    const store = createStore(dir);
    const calls: Array<{ project: string; message: string }> = [];
    const notify = vi.fn(async (a: { project: string; message: string }) => { calls.push(a); });
    store.put(rec246("t-self", { originProject: "projB" })); // same as project
    const d = createDaemon({ store, now: () => 2000, notify });

    await d.handle({ kind: "event", project: "projB", event: { type: "task.done", id: "t-self", resultRef: "/tmp/r" } });

    // Exactly 1 notify call: the normal CREW DONE (no extra report-back since
    // originProject === project).
    expect(calls.length).toBe(1);
    expect(calls[0].project).toBe("projB");
  });

  it("fires notify to origin project on stall (sweep-synthetic)", async () => {
    const store = createStore(dir);
    const calls: Array<{ project: string; message: string }> = [];
    const notify = vi.fn(async (a: { project: string; message: string }) => { calls.push(a); });
    store.put(rec246("t-stall", { state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 100, mode: "headless" }));
    const d = createDaemon({ store, now: () => 2000, notify });

    await d.sweep();

    const originCalls = calls.filter((c) => c.project === "projA");
    expect(originCalls.length).toBe(1);
    expect(originCalls[0].message).toMatch(/stall|no heartbeat/i);
  });

  it("dispatched task with originProject notifies B (target) mailbox with delegation message", async () => {
    const store = createStore(dir);
    const calls: Array<{ project: string; message: string }> = [];
    const notify = vi.fn(async (a: { project: string; message: string }) => { calls.push(a); });
    const d = createDaemon({ store, now: () => 2000, notify });

    await d.handle({
      kind: "dispatch",
      record: rec246("t-deleg", { state: "submitted", project: "projB", originProject: "projA" }),
    });

    const bCalls = calls.filter((c) => c.project === "projB");
    expect(bCalls.length).toBe(1);
    expect(bCalls[0].message).toMatch(/cross.project|projA/i);
  });
});

// ── Issue #378: crewTag helper (notification tag disambiguation) ────────────
describe("crewTag (#378)", () => {
  it("named record includes name and short id", () => {
    const r: TaskRecord = {
      id: "abc123def456", project: "p", provider: "claude", mode: "interactive",
      state: "working", name: "my-crew", task: "t", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    };
    const tag = crewTag(r);
    expect(tag).toBe("[claude/my-crew · abc123de]");
  });

  it("unnamed record includes short id only", () => {
    const r: TaskRecord = {
      id: "abc123def456", project: "p", provider: "opencode", mode: "interactive",
      state: "done", task: "t", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", resultRef: "/r", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    };
    const tag = crewTag(r);
    expect(tag).toBe("[opencode/abc123de]");
  });
});

// ── Issue #378: purge request kind ──────────────────────────────────────────
describe("purge (#378)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-purge-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("purge a terminal record succeeds and record is gone", async () => {
    const store = createStore(dir);
    store.put(rec("p-term", { state: "done", resultRef: "/r" }));
    const d = createDaemon({ store, now: () => 2000 });
    const r = await d.handle({ kind: "purge", project: "p", id: "p-term" });
    expect((r as TaskRecord).id).toBe("p-term");
    expect(store.get("p", "p-term")).toBeUndefined();
  });

  it("purge a non-terminal record without force errors", async () => {
    const store = createStore(dir);
    store.put(rec("p-live", { state: "working" }));
    const d = createDaemon({ store, now: () => 2000 });
    await expect(
      d.handle({ kind: "purge", project: "p", id: "p-live" }),
    ).rejects.toThrow(/not terminal/i);
    expect(store.get("p", "p-live")?.state).toBe("working");
  });

  it("purge a non-terminal record with force succeeds", async () => {
    const store = createStore(dir);
    store.put(rec("p-force", { state: "working" }));
    const d = createDaemon({ store, now: () => 2000 });
    const r = await d.handle({ kind: "purge", project: "p", id: "p-force", force: true });
    expect((r as TaskRecord).id).toBe("p-force");
    expect(store.get("p", "p-force")).toBeUndefined();
  });

  it("purge an unknown task errors", async () => {
    const store = createStore(dir);
    const d = createDaemon({ store, now: () => 2000 });
    await expect(
      d.handle({ kind: "purge", project: "p", id: "no-such-id" }),
    ).rejects.toThrow(/unknown/i);
  });
});

