// src/control/__tests__/crew-control.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildDispatchRequest, buildStatusRequest, buildGateResolveRequest, runCrewSignal } from "../commands/crew-control.js";
import type { TaskRecord } from "@squadrant/shared";

describe("crew-control request builders", () => {
  it("dispatch request carries project/provider/mode/task and a generated id", () => {
    const r = buildDispatchRequest({ project: "p", provider: "codex", mode: "headless", task: "fix x" });
    expect(r.kind).toBe("dispatch");
    expect(r.record.project).toBe("p");
    expect(r.record.provider).toBe("codex");
    expect(r.record.mode).toBe("headless");
    expect(r.record.task).toBe("fix x");
    expect(r.record.state).toBe("submitted");
    expect(typeof r.record.id).toBe("string");
    expect(r.record.id.length).toBeGreaterThan(0);
  });

  it("carries cwd onto the record when provided (codex needs it to edit code)", () => {
    const r = buildDispatchRequest({ project: "p", provider: "codex", mode: "headless", task: "t", cwd: "/work/wt" });
    expect(r.record.cwd).toBe("/work/wt");
  });

  it("cwd is omitted when not provided (inherit daemon cwd)", () => {
    const r = buildDispatchRequest({ project: "p", provider: "codex", mode: "headless", task: "t" });
    expect(r.record.cwd).toBeUndefined();
  });

  it("status request targets a task id", () => {
    expect(buildStatusRequest("p", "t9")).toEqual({ kind: "status", project: "p", id: "t9" });
  });

  it("carries approvalPolicy onto the record when set (--approval gate-primitive flow)", () => {
    const r = buildDispatchRequest({
      project: "p", provider: "codex", mode: "interactive", task: "(interactive)",
      approvalPolicy: "untrusted",
    });
    expect(r.record.approvalPolicy).toBe("untrusted");
  });

  it("approvalPolicy is omitted when not provided (default auto-approve)", () => {
    const r = buildDispatchRequest({ project: "p", provider: "codex", mode: "interactive", task: "t" });
    expect(r.record.approvalPolicy).toBeUndefined();
  });

  it("gate-resolve payload derives decision='approve' from message so codex receives a valid approval (matches crew-attach renderer)", () => {
    const r = buildGateResolveRequest({ project: "p", gateId: "g1", message: "approve" });
    expect(r.kind).toBe("gate-resolve");
    expect(r.gateId).toBe("g1");
    expect(r.payload).toEqual({ text: "approve", decision: "approve" });
  });
});

// #557: `crew signal done` returned exit 0 for a task that was already terminal
// (e.g. a duplicate/stale record picked by #574's divergent selection) — the
// daemon's reduce() silently absorbs any event on a terminal record, and the
// CLI never inspected the resulting state, so a signal that changed nothing
// still reported success. runCrewSignal must check current state FIRST and
// fail loudly instead of emitting an event that will be silently ignored.
describe("runCrewSignal (#557)", () => {
  it("fails loudly instead of silently succeeding when the target task is already terminal", async () => {
    const call = vi.fn().mockResolvedValue({ id: "t1", state: "done" } as Partial<TaskRecord>);
    await expect(
      runCrewSignal("done", { taskId: "t1", project: "p", message: "finished" }, { call }),
    ).rejects.toThrow(/already terminal/i);
    // Only the status check ran — no task.done event was sent for the no-op.
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(buildStatusRequest("p", "t1"));
  });

  it("sends the event normally when the target task is not yet terminal", async () => {
    const call = vi.fn().mockImplementation(async (req: any) => {
      if (req.kind === "status") return { id: "t1", state: "working" };
      return { ok: true };
    });
    await runCrewSignal("done", { taskId: "t1", project: "p", message: "finished", writeResult: () => "ref" }, { call });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ kind: "event", event: expect.objectContaining({ type: "task.done", id: "t1" }) }));
  });

  // Pre-merge review: the status call can resolve with no record at all — a
  // dropped/pruned task id (#554: terminal records are pruned past a 20-record
  // cap; the record can also simply not exist yet on a fresh/racy daemon). A
  // missing record is NOT evidence of "already terminal" — treating it as such
  // (or worse, dereferencing .state on it) must never crash `crew signal done`.
  // A crash here drops CREW DONE exactly like #574 did, just via a new door.
  it("does not throw a TypeError and still sends the event when status resolves with no record (dropped/pruned task, #554)", async () => {
    const call = vi.fn().mockImplementation(async (req: any) => {
      if (req.kind === "status") return undefined;
      return { ok: true };
    });
    await runCrewSignal("done", { taskId: "gone-id", project: "p", message: "finished", writeResult: () => "ref" }, { call });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ kind: "event", event: expect.objectContaining({ type: "task.done", id: "gone-id" }) }));
  });
});
