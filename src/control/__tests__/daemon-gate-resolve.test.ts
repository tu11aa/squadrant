// src/control/__tests__/daemon-gate-resolve.test.ts
import { describe, it, expect, vi } from "vitest";
import { createDaemon } from "../daemon.js";

describe("daemon gate-resolve", () => {
  it("resolves a pending gate and invokes resolveInteractiveGate dep", async () => {
    const records: any[] = [];
    const fakeStore = {
      put: vi.fn((r: any) => records.push(r)),
      get: vi.fn(),
      list: vi.fn(),
      listAll: () => [
        {
          id: "t1",
          project: "p",
          provider: "codex",
          mode: "interactive",
          state: "blocked",
          task: "hi",
          createdAt: 1,
          lastHeartbeat: 1,
          lastEvent: "",
          heartbeatBudgetMs: 1000,
          attempts: [{ attemptId: "a", startedAt: 1, lastHeartbeatAt: 1 }],
          gates: [
            {
              gateId: "g1",
              taskId: "t1",
              kind: "input",
              question: "?",
              state: "pending",
              createdAt: 1,
            },
          ],
        },
      ],
      quarantine: vi.fn(),
    } as any;
    const resolveSpy = vi.fn().mockResolvedValue(undefined);
    const d = createDaemon({ store: fakeStore, now: () => 1, resolveInteractiveGate: resolveSpy });
    await d.handle({
      kind: "gate-resolve",
      project: "p",
      gateId: "g1",
      resolvedBy: "captain",
      payload: { text: "yes" },
    });
    expect(resolveSpy).toHaveBeenCalledWith("t1", { text: "yes" });
    expect(records[0].gates[0].state).toBe("resolved");
    expect(records[0].gates[0].resolvedBy).toBe("captain");
  });

  it("throws when gateId is unknown", async () => {
    const fakeStore = {
      put: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      listAll: () => [],
      quarantine: vi.fn(),
    } as any;
    const d = createDaemon({ store: fakeStore, now: () => 1 });
    await expect(
      d.handle({ kind: "gate-resolve", project: "p", gateId: "missing", resolvedBy: "x", payload: {} }),
    ).rejects.toThrow(/not found/i);
  });
});
