import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildSignalRequest, runCrewSignal } from "../crew-control.js";

describe("buildSignalRequest", () => {
  const SAVED = { ...process.env };

  beforeEach(() => {
    process.env.SQUADRANT_CREW_TASK_ID = "task-xyz";
    process.env.SQUADRANT_CREW_PROJECT = "alpha";
  });

  afterEach(() => {
    process.env = { ...SAVED };
  });

  it("done + message → task.done event with resultRef from writer AND message field for relay display", () => {
    const writes: Array<{ id: string; payload: string }> = [];
    const writeResult = (id: string, payload: string) => {
      writes.push({ id, payload });
      return `/tmp/results/${id}.txt`;
    };
    const req = buildSignalRequest("done", { message: "all green", writeResult });
    expect(req.kind).toBe("event");
    expect(req.project).toBe("alpha");
    expect(req.event).toEqual({
      type: "task.done",
      id: "task-xyz",
      resultRef: "/tmp/results/task-xyz.txt",
      message: "all green",
    });
    expect(writes).toEqual([{ id: "task-xyz", payload: "all green" }]);
  });

  it("done without message → empty payload, resultRef still set", () => {
    const writeResult = (id: string) => `/tmp/${id}`;
    const req = buildSignalRequest("done", { writeResult });
    expect(req.event).toEqual({ type: "task.done", id: "task-xyz", resultRef: "/tmp/task-xyz" });
  });

  it("done without writeResult → resultRef is empty string", () => {
    const req = buildSignalRequest("done", { message: "x" });
    expect(req.event).toEqual({ type: "task.done", id: "task-xyz", resultRef: "", message: "x" });
  });

  it("blocked + question → task.blocked event", () => {
    const req = buildSignalRequest("blocked", { question: "what next?" });
    expect(req.event).toEqual({
      type: "task.blocked",
      id: "task-xyz",
      reason: "crew signaled blocked",
      question: "what next?",
    });
  });

  it("failed + error → task.failed event", () => {
    const req = buildSignalRequest("failed", { error: "build broke" });
    expect(req.event).toEqual({ type: "task.failed", id: "task-xyz", error: "build broke" });
  });

  // #599: review-gate checkpoint — parallel to done/blocked, not terminal.
  it("review + message → task.review event carrying the crew's summary", () => {
    const req = buildSignalRequest("review", { message: "added the flag, tests green" });
    expect(req.event).toEqual({ type: "task.review", id: "task-xyz", message: "added the flag, tests green" });
  });

  it("review without message → task.review event with no message field", () => {
    const req = buildSignalRequest("review", {});
    expect(req.event).toEqual({ type: "task.review", id: "task-xyz" });
  });

  it("blocked without question → empty question string", () => {
    const req = buildSignalRequest("blocked", {});
    expect((req.event as { type: string; question: string }).question).toBe("");
  });

  it("failed without error → default error string", () => {
    const req = buildSignalRequest("failed", {});
    expect((req.event as { type: string; error: string }).error).toBe("crew signaled failed");
  });

  it("missing SQUADRANT_CREW_TASK_ID → throws", () => {
    delete process.env.SQUADRANT_CREW_TASK_ID;
    expect(() => buildSignalRequest("done", {})).toThrow(/SQUADRANT_CREW_TASK_ID/);
  });

  it("missing SQUADRANT_CREW_PROJECT → throws", () => {
    delete process.env.SQUADRANT_CREW_PROJECT;
    expect(() => buildSignalRequest("done", {})).toThrow(/SQUADRANT_CREW_PROJECT/);
  });

  // The codex case: a long-lived shared app-server serves all codex tasks as
  // threads, so a process-level env var is unsafe. Explicit flags let a codex
  // crew signal its own task with NO env vars set.
  it("explicit taskId+project flags build a targeted request with NO env set (codex case)", () => {
    delete process.env.SQUADRANT_CREW_TASK_ID;
    delete process.env.SQUADRANT_CREW_PROJECT;
    const req = buildSignalRequest("done", { taskId: "X", project: "P", message: "m" });
    expect(req.project).toBe("P");
    expect(req.event).toMatchObject({ type: "task.done", id: "X", message: "m" });
  });

  // Regression guard: claude/opencode keep using env when no flags are given.
  it("no flags + env set → unchanged env-based behavior (claude/opencode guard)", () => {
    const req = buildSignalRequest("done", { message: "m" });
    expect(req.project).toBe("alpha");
    expect(req.event).toMatchObject({ type: "task.done", id: "task-xyz" });
  });

  it("flags take precedence over env when both present", () => {
    const req = buildSignalRequest("done", { taskId: "flag-id", project: "flag-proj" });
    expect(req.project).toBe("flag-proj");
    expect((req.event as { id: string }).id).toBe("flag-id");
  });
});

describe("runCrewSignal('review') (#599)", () => {
  const SAVED = { ...process.env };
  beforeEach(() => {
    process.env.SQUADRANT_CREW_TASK_ID = "task-xyz";
    process.env.SQUADRANT_CREW_PROJECT = "alpha";
  });
  afterEach(() => { process.env = { ...SAVED }; });

  it("status check passes (like blocked) — 'review' is not a terminal state, so the signal always emits", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ state: "working" }) // status check
      .mockResolvedValueOnce(undefined); // the emitted event
    await runCrewSignal("review", { message: "ready" }, { call });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenLastCalledWith({
      kind: "event", project: "alpha", event: { type: "task.review", id: "task-xyz", message: "ready" },
    });
  });

  it("re-signaling review from an already-'review' task is allowed (not terminal, re-request after feedback)", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ state: "review" })
      .mockResolvedValueOnce(undefined);
    await expect(runCrewSignal("review", { message: "addressed feedback" }, { call })).resolves.toBeUndefined();
  });

  it("throws if the task is already terminal (mirrors done/blocked/failed behavior)", async () => {
    const call = vi.fn().mockResolvedValueOnce({ state: "done" });
    await expect(runCrewSignal("review", {}, { call })).rejects.toThrow(/already terminal/);
  });
});
