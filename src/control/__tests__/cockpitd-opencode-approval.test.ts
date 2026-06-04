// src/control/__tests__/cockpitd-opencode-approval.test.ts
//
// CP3 (opencode permission gate): the captain's gate-resolve for an OPENCODE
// task must route to opencodeBridge.answer (which POSTs the decision to the
// crew's server), while a codex task still routes to codexDriver.answer.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";
import type { TaskRecord } from "../types.js";

function fakeCodexDriver(answer: ReturnType<typeof vi.fn>) {
  return {
    dispatch: vi.fn(), reattach: vi.fn(), say: vi.fn(), steer: vi.fn(),
    interrupt: vi.fn(), answer, close: vi.fn(),
  } as never;
}

function seedRecord(o: { id: string; provider: TaskRecord["provider"]; gateKind: "approval" | "input" }): TaskRecord {
  return {
    id: o.id, project: "p", provider: o.provider, mode: "interactive",
    state: "blocked", task: "x", createdAt: 1, lastHeartbeat: 1, lastEvent: "",
    heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a", startedAt: 1, lastHeartbeatAt: 1 }],
    gates: [{ gateId: `g-${o.id}`, taskId: o.id, kind: o.gateKind, question: "?", state: "pending", createdAt: 1 }],
  };
}

describe("cockpitd opencode approval routing (CP3)", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("routes an opencode gate-resolve to opencodeBridge.answer, not codex", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cp3-"));
    const sock = join(dir, "c.sock");
    const ocAnswer = vi.fn().mockResolvedValue(true);
    const codexAnswer = vi.fn().mockResolvedValue(undefined);
    const handle = startCockpitd({
      stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0,
      opencodeBridge: { start: vi.fn(), stop: vi.fn(), answer: ocAnswer },
      codexDriver: fakeCodexDriver(codexAnswer),
    });
    stop = handle.stop;
    await sendRequest(sock, { kind: "seed", record: seedRecord({ id: "o1", provider: "opencode", gateKind: "approval" }) });
    await sendRequest(sock, {
      kind: "gate-resolve", project: "p", gateId: "g-o1", resolvedBy: "captain",
      payload: { text: "approve", decision: "approve" },
    });
    expect(ocAnswer).toHaveBeenCalledWith("o1", "approve");
    expect(codexAnswer).not.toHaveBeenCalled();
  });

  it("maps a deny decision to opencodeBridge.answer('deny')", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cp3-"));
    const sock = join(dir, "c.sock");
    const ocAnswer = vi.fn().mockResolvedValue(true);
    const handle = startCockpitd({
      stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0,
      opencodeBridge: { start: vi.fn(), stop: vi.fn(), answer: ocAnswer },
      codexDriver: fakeCodexDriver(vi.fn()),
    });
    stop = handle.stop;
    await sendRequest(sock, { kind: "seed", record: seedRecord({ id: "o2", provider: "opencode", gateKind: "approval" }) });
    await sendRequest(sock, {
      kind: "gate-resolve", project: "p", gateId: "g-o2", resolvedBy: "captain",
      payload: { text: "deny", decision: "deny" },
    });
    expect(ocAnswer).toHaveBeenCalledWith("o2", "deny");
  });

  it("still routes a codex gate-resolve to codexDriver.answer", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cp3-"));
    const sock = join(dir, "c.sock");
    const ocAnswer = vi.fn().mockResolvedValue(true);
    const codexAnswer = vi.fn().mockResolvedValue(undefined);
    const handle = startCockpitd({
      stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0,
      opencodeBridge: { start: vi.fn(), stop: vi.fn(), answer: ocAnswer },
      codexDriver: fakeCodexDriver(codexAnswer),
    });
    stop = handle.stop;
    await sendRequest(sock, { kind: "seed", record: seedRecord({ id: "c1", provider: "codex", gateKind: "approval" }) });
    await sendRequest(sock, {
      kind: "gate-resolve", project: "p", gateId: "g-c1", resolvedBy: "captain",
      payload: { text: "approve", decision: "approve" },
    });
    expect(codexAnswer).toHaveBeenCalledWith("c1", { text: "approve", decision: "approve" });
    expect(ocAnswer).not.toHaveBeenCalled();
  });
});
