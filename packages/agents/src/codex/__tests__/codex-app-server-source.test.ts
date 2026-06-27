// Tests for CodexAppServerSource — LifecycleSource adapter for codex app-server.
//
// All deps are injected; no real app-server is spawned.
import { describe, it, expect, beforeEach } from "vitest";
import { CodexAppServerSource } from "../codex-app-server-source.js";
import type { LifecycleSnapshot, LifecycleSourceDeps } from "@squadrant/core";
import type { ControlEvent } from "@squadrant/shared";

// ── fixtures ─────────────────────────────────────────────────────────────────

const TASK_ID = "task-abc123";
const TURN_ID = "turn-001";

function makeDeps() {
  const reports: LifecycleSnapshot[] = [];
  const deps: LifecycleSourceDeps = {
    resolve: () => undefined,
    report: (snap) => reports.push(snap),
  };
  return { deps, reports };
}

function makeSource() {
  return new CodexAppServerSource();
}

// ── start / stop ─────────────────────────────────────────────────────────────

describe("CodexAppServerSource — lifecycle", () => {
  it("has name 'codex-appserver'", () => {
    expect(makeSource().name).toBe("codex-appserver");
  });

  it("ignores observe() before start()", () => {
    const src = makeSource();
    // Should not throw; just drop the event.
    src.observe({ type: "task.turn.completed", id: TASK_ID, turnId: TURN_ID });
  });

  it("stops reporting after stop()", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource();
    src.start(deps);
    src.observe({ type: "task.turn.completed", id: TASK_ID, turnId: TURN_ID });
    expect(reports).toHaveLength(1);
    src.stop();
    src.observe({ type: "task.turn.completed", id: TASK_ID, turnId: TURN_ID });
    expect(reports).toHaveLength(1); // no new reports after stop
  });

  it("stop() clears the snapshot cache", () => {
    const { deps } = makeDeps();
    const src = makeSource();
    src.start(deps);
    src.observe({ type: "task.turn.completed", id: TASK_ID, turnId: TURN_ID });
    expect(src.snapshot(TASK_ID)).toBeDefined();
    src.stop();
    expect(src.snapshot(TASK_ID)).toBeUndefined();
  });
});

// ── running events ────────────────────────────────────────────────────────────

describe("CodexAppServerSource — running state", () => {
  let src: CodexAppServerSource;
  let reports: LifecycleSnapshot[];

  beforeEach(() => {
    const fixture = makeDeps();
    reports = fixture.reports;
    src = makeSource();
    src.start(fixture.deps);
  });

  it("task.started → running, alive:true, origin:agent", () => {
    src.observe({ type: "task.started", id: TASK_ID });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "running", alive: true, origin: "agent" });
  });

  it("task.reattached → running, alive:true", () => {
    src.observe({ type: "task.reattached", id: TASK_ID });
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "running", alive: true });
  });

  it("task.turn.started → running", () => {
    src.observe({ type: "task.turn.started", id: TASK_ID, turnId: TURN_ID });
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "running" });
  });

  it("task.delta → running (liveness heartbeat)", () => {
    src.observe({ type: "task.delta", id: TASK_ID, turnId: TURN_ID, chunk: "hi" });
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "running" });
  });

  it("task.progress → running (liveness heartbeat)", () => {
    src.observe({ type: "task.progress", id: TASK_ID, tool: "Bash" });
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "running" });
  });
});

// ── idle events ──────────────────────────────────────────────────────────────

describe("CodexAppServerSource — idle state", () => {
  let src: CodexAppServerSource;
  let reports: LifecycleSnapshot[];

  beforeEach(() => {
    const fixture = makeDeps();
    reports = fixture.reports;
    src = makeSource();
    src.start(fixture.deps);
  });

  it("task.turn.completed → idle, alive:true", () => {
    src.observe({ type: "task.turn.completed", id: TASK_ID, turnId: TURN_ID });
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "idle", alive: true, origin: "agent" });
  });

  it("task.failed → idle, alive:true (crew alive; turn ended with error)", () => {
    src.observe({ type: "task.failed", id: TASK_ID, error: "boom" });
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "idle", alive: true });
  });

  it("task.session.ended → idle, alive:false (process gone)", () => {
    src.observe({ type: "task.session.ended", id: TASK_ID });
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "idle", alive: false, origin: "agent" });
  });
});

// ── needsInput events ─────────────────────────────────────────────────────────

describe("CodexAppServerSource — needsInput state", () => {
  let src: CodexAppServerSource;
  let reports: LifecycleSnapshot[];

  beforeEach(() => {
    const fixture = makeDeps();
    reports = fixture.reports;
    src = makeSource();
    src.start(fixture.deps);
  });

  it("task.approval.requested → needsInput with detail", () => {
    src.observe({
      type: "task.approval.requested",
      id: TASK_ID,
      requestId: 1,
      question: "Allow shell?",
      kind: "execCommandApproval",
    });
    expect(reports[0]).toMatchObject({
      taskId: TASK_ID,
      state: "needsInput",
      alive: true,
      origin: "agent",
      detail: { note: "Allow shell?", reason: "execCommandApproval" },
    });
  });

  it("task.input.requested → needsInput with detail", () => {
    src.observe({
      type: "task.input.requested",
      id: TASK_ID,
      requestId: 2,
      question: "What next?",
    });
    expect(reports[0]).toMatchObject({
      taskId: TASK_ID,
      state: "needsInput",
      alive: true,
      detail: { note: "What next?" },
    });
  });
});

// ── ignored events ───────────────────────────────────────────────────────────

describe("CodexAppServerSource — ignored (no report)", () => {
  let src: CodexAppServerSource;
  let reports: LifecycleSnapshot[];

  beforeEach(() => {
    const fixture = makeDeps();
    reports = fixture.reports;
    src = makeSource();
    src.start(fixture.deps);
  });

  const ignoredEvents: ControlEvent[] = [
    { type: "task.done", id: TASK_ID, resultRef: "/tmp/out.txt" },
    { type: "task.blocked", id: TASK_ID, reason: "blocked", question: "?" },
    { type: "task.cancelled", id: TASK_ID },
    { type: "task.session", id: TASK_ID, resumeRef: "thread-xyz" },
    { type: "task.stalled", id: TASK_ID, heartbeatBudgetMs: 60000 },
    { type: "task.quiet", id: TASK_ID, quietMs: 30000 },
    { type: "task.idle", id: TASK_ID, heartbeatBudgetMs: 60000 },
    { type: "task.timeout", id: TASK_ID, taskTimeoutMs: 3600000 },
    { type: "task.reconcile-failed", id: TASK_ID, reason: "no pane" },
    { type: "task.reopened", id: TASK_ID },
    { type: "heartbeat", id: TASK_ID },
  ];

  for (const ev of ignoredEvents) {
    it(`${ev.type} → no report (terminal or notify-only)`, () => {
      src.observe(ev);
      expect(reports).toHaveLength(0);
    });
  }
});

// ── snapshot() liveness floor ─────────────────────────────────────────────────

describe("CodexAppServerSource — snapshot()", () => {
  it("returns undefined before any observation", () => {
    const { deps } = makeDeps();
    const src = makeSource();
    src.start(deps);
    expect(src.snapshot(TASK_ID)).toBeUndefined();
  });

  it("returns last observed snapshot", () => {
    const { deps } = makeDeps();
    const src = makeSource();
    src.start(deps);
    src.observe({ type: "task.turn.completed", id: TASK_ID, turnId: TURN_ID });
    src.observe({ type: "task.approval.requested", id: TASK_ID, requestId: 1, question: "?", kind: "k" });
    const snap = src.snapshot(TASK_ID);
    expect(snap?.state).toBe("needsInput");
  });

  it("tracks multiple taskIds independently", () => {
    const { deps } = makeDeps();
    const src = makeSource();
    src.start(deps);
    src.observe({ type: "task.turn.completed", id: "task-A", turnId: TURN_ID });
    src.observe({ type: "task.started", id: "task-B" });
    expect(src.snapshot("task-A")?.state).toBe("idle");
    expect(src.snapshot("task-B")?.state).toBe("running");
  });
});

// ── anti-#2576 invariant ─────────────────────────────────────────────────────

describe("CodexAppServerSource — anti-#2576: never reports task.done", () => {
  it("task.done is ignored — no report emitted", () => {
    const { deps, reports } = makeDeps();
    const src = makeSource();
    src.start(deps);
    src.observe({ type: "task.done", id: TASK_ID, resultRef: "/out" });
    expect(reports).toHaveLength(0);
  });
});
