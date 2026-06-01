import { describe, it, expect, vi } from "vitest";
import { CodexInteractiveDriver, shouldReattachCodex } from "../driver.js";
import { EventEmitter } from "node:events";

describe("shouldReattachCodex (boot reattach guard — anti-MCP-storm)", () => {
  const NOW = 1_000_000;
  const STALE = 10 * 60_000;
  const base = (over: any = {}) => ({
    id: "t", project: "p", provider: "codex", mode: "interactive",
    state: "awaiting-input", task: "x", createdAt: 0, lastHeartbeat: NOW,
    lastEvent: "", heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a", startedAt: 0, lastHeartbeatAt: NOW, resumeRef: "TH-1" }],
    ...over,
  });

  it("reattaches a fresh, non-terminal codex task with a resumeRef", () => {
    expect(shouldReattachCodex(base() as any, NOW, STALE)).toBe(true);
  });
  it("skips terminal tasks (done/failed/cancelled — incl. crews closed via codex-close)", () => {
    for (const state of ["done", "failed", "cancelled"]) {
      expect(shouldReattachCodex(base({ state }) as any, NOW, STALE)).toBe(false);
    }
  });
  it("skips STALE tasks (dead crew — no heartbeat within the window) → no MCP storm", () => {
    const stale = base({ attempts: [{ attemptId: "a", startedAt: 0, lastHeartbeatAt: NOW - STALE - 1, resumeRef: "TH-1" }] });
    expect(shouldReattachCodex(stale as any, NOW, STALE)).toBe(false);
  });
  it("skips tasks without a resumeRef", () => {
    const noref = base({ attempts: [{ attemptId: "a", startedAt: 0, lastHeartbeatAt: NOW }] });
    expect(shouldReattachCodex(noref as any, NOW, STALE)).toBe(false);
  });
  it("skips non-codex / non-interactive tasks", () => {
    expect(shouldReattachCodex(base({ provider: "claude" }) as any, NOW, STALE)).toBe(false);
    expect(shouldReattachCodex(base({ mode: "headless" }) as any, NOW, STALE)).toBe(false);
  });
});

function fakeClient() {
  const ee = new EventEmitter() as any;
  ee.initialize = vi.fn().mockResolvedValue({});
  ee.startThread = vi.fn().mockResolvedValue({ threadId: "TH-1" });
  ee.resumeThread = vi.fn().mockResolvedValue({});
  ee.archiveThread = vi.fn().mockResolvedValue({});
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
      expect.objectContaining({ cwd: "/tmp/work", sandbox: "danger-full-access" }),
    );
    expect(events).toEqual([
      { type: "task.session", id: "t1", resumeRef: "TH-1" },
      { type: "task.started", id: "t1" },
    ]);
  });

  it("runs codex crews with danger-full-access (parity with unsandboxed claude/opencode) so `cockpit crew signal` reaches the daemon socket", async () => {
    const client = fakeClient();
    const drv = new CodexInteractiveDriver({ makeClient: () => client, emit: () => {} });
    await drv.dispatch({
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
      cwd: "/tmp/work",
    } as any);
    const params = client.startThread.mock.calls[0][0];
    expect(params.sandbox).toBe("danger-full-access");
    // approvalPolicy is independent of the sandbox axis — still gates when set.
    expect(params.approvalPolicy).toBe("never");
  });

  it("close() archives the thread and clears the task↔thread maps (crew-close teardown)", async () => {
    const client = fakeClient();
    const drv = new CodexInteractiveDriver({ makeClient: () => client, emit: () => {} });
    await drv.dispatch({
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
      cwd: "/tmp/work",
    } as any);
    await drv.close("t1");
    expect(client.archiveThread).toHaveBeenCalledWith("TH-1");
    // maps cleared → a later say() can't find the thread
    await expect(drv.say("t1", "hi")).rejects.toThrow(/no thread/);
  });

  it("close() is a no-op for an unknown task (idempotent)", async () => {
    const client = fakeClient();
    const drv = new CodexInteractiveDriver({ makeClient: () => client, emit: () => {} });
    await drv.close("nope");
    expect(client.archiveThread).not.toHaveBeenCalled();
  });

  it("injects task id, project, and the explicit-flag signal command into developerInstructions", async () => {
    const client = fakeClient();
    const drv = new CodexInteractiveDriver({
      makeClient: () => client,
      emit: () => {},
    });
    await drv.dispatch({
      id: "task-42", project: "demo", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
      cwd: "/tmp/work", roleInstructions: "ROLE BODY",
    } as any);
    const dev = client.startThread.mock.calls[0][0].developerInstructions as string;
    expect(dev).toContain("ROLE BODY");
    expect(dev).toContain("task-42");
    expect(dev).toContain("demo");
    expect(dev).toContain("cockpit crew signal done --task-id task-42 --project demo");
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

  describe("answer", () => {
    function dispatchedDriver() {
      const client = fakeClient();
      const events: any[] = [];
      const drv = new CodexInteractiveDriver({
        makeClient: () => client,
        emit: (ev) => events.push(ev),
      });
      const task = {
        id: "t1", project: "p", provider: "codex", mode: "interactive",
        state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
        lastEvent: "", heartbeatBudgetMs: 1000,
        attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
        cwd: "/tmp/work",
      } as any;
      return { client, drv, task, events };
    }

    it("old protocol execCommandApproval: approve → approved, deny → denied", async () => {
      const { client, drv, task } = dispatchedDriver();
      await drv.dispatch(task);
      client.emit("serverRequest", { id: 10, method: "execCommandApproval", params: { question: "run?" } });
      await drv.answer("t1", { text: "yes", decision: "approve" });
      expect(client.respondToServerRequest).toHaveBeenCalledWith(10, { decision: "approved" });

      client.emit("serverRequest", { id: 11, method: "execCommandApproval", params: { question: "run?" } });
      await drv.answer("t1", { text: "no", decision: "deny" });
      expect(client.respondToServerRequest).toHaveBeenCalledWith(11, { decision: "denied" });
    });

    it("old protocol applyPatchApproval: approve → approved, deny → denied", async () => {
      const { client, drv, task } = dispatchedDriver();
      await drv.dispatch(task);
      client.emit("serverRequest", { id: 20, method: "applyPatchApproval", params: { question: "patch?" } });
      await drv.answer("t1", { text: "ok", decision: "approve" });
      expect(client.respondToServerRequest).toHaveBeenCalledWith(20, { decision: "approved" });

      client.emit("serverRequest", { id: 21, method: "applyPatchApproval", params: { question: "patch?" } });
      await drv.answer("t1", { text: "no", decision: "deny" });
      expect(client.respondToServerRequest).toHaveBeenCalledWith(21, { decision: "denied" });
    });

    it("v2 commandExecution/requestApproval: approve → accept, deny → decline", async () => {
      const { client, drv, task } = dispatchedDriver();
      await drv.dispatch(task);
      client.emit("serverRequest", { id: 30, method: "item/commandExecution/requestApproval", params: { question: "run?" } });
      await drv.answer("t1", { text: "yes", decision: "approve" });
      expect(client.respondToServerRequest).toHaveBeenCalledWith(30, { decision: "accept" });

      client.emit("serverRequest", { id: 31, method: "item/commandExecution/requestApproval", params: { question: "run?" } });
      await drv.answer("t1", { text: "no", decision: "deny" });
      expect(client.respondToServerRequest).toHaveBeenCalledWith(31, { decision: "decline" });
    });

    it("v2 fileChange/requestApproval: approve → accept, deny → decline", async () => {
      const { client, drv, task } = dispatchedDriver();
      await drv.dispatch(task);
      client.emit("serverRequest", { id: 40, method: "item/fileChange/requestApproval", params: { question: "patch?" } });
      await drv.answer("t1", { text: "ok", decision: "approve" });
      expect(client.respondToServerRequest).toHaveBeenCalledWith(40, { decision: "accept" });

      client.emit("serverRequest", { id: 41, method: "item/fileChange/requestApproval", params: { question: "patch?" } });
      await drv.answer("t1", { text: "no", decision: "deny" });
      expect(client.respondToServerRequest).toHaveBeenCalledWith(41, { decision: "decline" });
    });

    it("passthrough: payload with no decision field is sent unchanged", async () => {
      const { client, drv, task } = dispatchedDriver();
      await drv.dispatch(task);
      client.emit("serverRequest", { id: 50, method: "item/tool/requestUserInput", params: { question: "enter value" } });
      await drv.answer("t1", { text: "hello" });
      expect(client.respondToServerRequest).toHaveBeenCalledWith(50, { text: "hello" });
    });

    it("throws when no pending server-request for task", async () => {
      const { client, drv, task } = dispatchedDriver();
      await drv.dispatch(task);
      await expect(drv.answer("t1", { text: "x" })).rejects.toThrow(/no pending server-request/);
    });
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
