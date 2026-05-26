import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSignalRequest } from "../crew-control.js";

describe("buildSignalRequest", () => {
  const SAVED = { ...process.env };

  beforeEach(() => {
    process.env.COCKPIT_CREW_TASK_ID = "task-xyz";
    process.env.COCKPIT_CREW_PROJECT = "alpha";
  });

  afterEach(() => {
    process.env = { ...SAVED };
  });

  it("done + message → task.done event with resultRef from writer", () => {
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
    expect(req.event).toEqual({ type: "task.done", id: "task-xyz", resultRef: "" });
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

  it("blocked without question → empty question string", () => {
    const req = buildSignalRequest("blocked", {});
    expect((req.event as { type: string; question: string }).question).toBe("");
  });

  it("failed without error → default error string", () => {
    const req = buildSignalRequest("failed", {});
    expect((req.event as { type: string; error: string }).error).toBe("crew signaled failed");
  });

  it("missing COCKPIT_CREW_TASK_ID → throws", () => {
    delete process.env.COCKPIT_CREW_TASK_ID;
    expect(() => buildSignalRequest("done", {})).toThrow(/COCKPIT_CREW_TASK_ID/);
  });

  it("missing COCKPIT_CREW_PROJECT → throws", () => {
    delete process.env.COCKPIT_CREW_PROJECT;
    expect(() => buildSignalRequest("done", {})).toThrow(/COCKPIT_CREW_PROJECT/);
  });
});
