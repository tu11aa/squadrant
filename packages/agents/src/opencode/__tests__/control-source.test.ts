// Tests for OpencodeControlSource (#667 slice 1).
// Mirrors codex-app-server-source.test.ts: all deps injected, no real SSE stream.
import { describe, it, expect } from "vitest";
import { OpencodeControlSource } from "../control-source.js";
import type { LifecycleSnapshot, LifecycleSourceDeps } from "@squadrant/core";
import type { ControlEvent } from "@squadrant/shared";

const TASK_ID = "task-abc123";

function harness() {
  const reports: LifecycleSnapshot[] = [];
  const deps: LifecycleSourceDeps = { resolve: () => undefined, report: (s) => reports.push(s) };
  const source = new OpencodeControlSource();
  return { source, deps, reports };
}

describe("OpencodeControlSource — port conformance", () => {
  it("has name 'opencode-control'", () => {
    expect(harness().source.name).toBe("opencode-control");
  });

  it("reports health active only between start and stop", () => {
    const { source, deps } = harness();
    expect(source.health()).toEqual({ active: false, error: null });
    source.start(deps);
    expect(source.health()).toEqual({ active: true, error: null });
    source.stop();
    expect(source.health()).toEqual({ active: false, error: null });
  });

  it("ignores events before start()", () => {
    const { source, reports } = harness();
    source.observe({ type: "task.started", id: TASK_ID } as ControlEvent);
    expect(reports).toHaveLength(0);
  });
});

describe("OpencodeControlSource — event mapping", () => {
  it("task.turn.completed maps to idle (turn ended, crew alive)", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.turn.completed", id: TASK_ID, turnId: "ses_1" } as ControlEvent);
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "idle", alive: true, origin: "agent" });
  });

  it("task.approval.requested maps to needsInput with the question as detail", () => {
    // This is the row that matters: opencode STATES it is stuck on a permission
    // prompt. Today squadrant guesses this from pane content (#484 / #590 class).
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.approval.requested", id: TASK_ID, requestId: 1,
                     question: "opencode requests permission to run bash: ls", kind: "bash" } as ControlEvent);
    expect(reports[0]).toMatchObject({ state: "needsInput", origin: "agent" });
    expect(reports[0].detail?.note).toContain("permission to run bash");
    expect(reports[0].detail?.reason).toBe("bash");
  });

  it("task.started maps to running (permission answered, turn resumes)", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.started", id: TASK_ID } as ControlEvent);
    expect(reports[0]).toMatchObject({ state: "running", alive: true });
  });

  it("origin is always 'agent' — these are the agent's own event bus", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.turn.completed", id: TASK_ID, turnId: "x" } as ControlEvent);
    expect(reports[0].origin).toBe("agent");
  });

  it("ignores terminal signals — those come only from `squadrant crew signal`", () => {
    // anti-#2576: session.idle is liveness, NOT completion. A source must never
    // terminalize a task; that stays with the explicit crew signal.
    const { source, deps, reports } = harness();
    source.start(deps);
    for (const type of ["task.done", "task.blocked", "task.cancelled"] as const) {
      source.observe({ type, id: TASK_ID } as ControlEvent);
    }
    expect(reports).toHaveLength(0);
  });

  it("ignores notify-only events", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.stalled", id: TASK_ID } as ControlEvent);
    expect(reports).toHaveLength(0);
  });
});

describe("OpencodeControlSource — snapshot() for the liveness floor", () => {
  it("returns undefined for an unseen crew", () => {
    const { source, deps } = harness();
    source.start(deps);
    expect(source.snapshot("nope")).toBeUndefined();
  });

  it("returns the last state as origin 'scan', never asserting needsInput", () => {
    const { source, deps } = harness();
    source.start(deps);
    source.observe({ type: "task.approval.requested", id: TASK_ID, requestId: 1,
                     question: "q", kind: "bash" } as ControlEvent);
    const snap = source.snapshot(TASK_ID);
    expect(snap?.origin).toBe("scan");
    expect(snap?.state).not.toBe("needsInput");
  });

  it("clears its cache on stop()", () => {
    const { source, deps } = harness();
    source.start(deps);
    source.observe({ type: "task.turn.completed", id: TASK_ID, turnId: "x" } as ControlEvent);
    source.stop();
    expect(source.snapshot(TASK_ID)).toBeUndefined();
  });
});