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
});
