import { describe, it, expect, vi } from "vitest";
import { CodexInteractiveDriver } from "../driver.js";
import { EventEmitter } from "node:events";

function fakeClient() {
  const ee = new EventEmitter() as any;
  ee.initialize = vi.fn().mockResolvedValue({});
  ee.startThread = vi.fn().mockResolvedValue({ threadId: "TH-1" });
  ee.resumeThread = vi.fn().mockResolvedValue({});
  ee.sendTurn = vi.fn().mockResolvedValue({ turnId: "T1" });
  ee.steerTurn = vi.fn().mockResolvedValue({});
  ee.interruptTurn = vi.fn().mockResolvedValue({});
  ee.respondToServerRequest = vi.fn();
  ee.start = vi.fn();
  ee.kill = vi.fn();
  return ee;
}

describe("CodexInteractiveDriver.dispatch", () => {
  it("ensures handshake, starts a thread, emits task.session + task.started", async () => {
    const client = fakeClient();
    const events: any[] = [];
    const drv = new CodexInteractiveDriver({
      makeClient: () => client,
      emit: (ev) => events.push(ev),
    });
    await drv.dispatch({
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
      cwd: "/tmp/work",
    } as any);
    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.startThread).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/work", sandbox: "workspace-write" }),
    );
    expect(events).toEqual([
      { type: "task.session", id: "t1", resumeRef: "TH-1" },
      { type: "task.started", id: "t1" },
    ]);
  });

  it("routes serverRequest with no threadId to the sole active task", async () => {
    const client = fakeClient();
    const events: any[] = [];
    const drv = new CodexInteractiveDriver({
      makeClient: () => client,
      emit: (ev) => events.push(ev),
    });
    await drv.dispatch({
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
      cwd: "/tmp/work",
    } as any);
    client.emit("serverRequest", {
      id: 42,
      method: "applyPatchApproval",
      params: { question: "ok?" },
    });
    const approval = events.find((e) => e.type === "task.approval.requested");
    expect(approval).toBeDefined();
    expect(approval).toMatchObject({ id: "t1", requestId: 42, kind: "applyPatchApproval" });
  });

  it("drops serverRequest with no threadId when multiple tasks are active", async () => {
    const client = fakeClient();
    let n = 0;
    client.startThread = vi.fn().mockImplementation(async () => ({ threadId: `TH-${++n}` }));
    const events: any[] = [];
    const drv = new CodexInteractiveDriver({
      makeClient: () => client,
      emit: (ev) => events.push(ev),
    });
    await drv.dispatch({
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
      cwd: "/tmp/work",
    } as any);
    await drv.dispatch({
      id: "t2", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "y", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a2", startedAt: 1, lastHeartbeatAt: 1 }],
      cwd: "/tmp/work",
    } as any);
    const before = events.length;
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    client.emit("serverRequest", {
      id: 99,
      method: "applyPatchApproval",
      params: { question: "ok?" },
    });
    writeSpy.mockRestore();
    expect(events.slice(before).some((e) => e.type === "task.approval.requested")).toBe(false);
    expect(events.slice(before).some((e) => e.type === "task.input.requested")).toBe(false);
  });

  it("if initialize rejects, emits task.failed with a clear handshake error", async () => {
    const client = fakeClient();
    client.initialize = vi.fn().mockRejectedValue(new Error("Not initialized"));
    const events: any[] = [];
    const drv = new CodexInteractiveDriver({
      makeClient: () => client,
      emit: (ev) => events.push(ev),
    });
    await drv.dispatch({
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
    } as any).catch(() => {});
    expect(events.some((e) => e.type === "task.failed" && /handshake/i.test(e.error))).toBe(true);
  });
});
