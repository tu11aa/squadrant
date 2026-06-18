// src/control/__tests__/integration-codex-restart.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "@cockpit/core";

describe("integration: interactive-codex restart-reattach (closes #86 interactive slice)", () => {
  let stop: (() => void) | undefined; let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("on restart, non-terminal interactive-codex tasks with resumeRef trigger driver.reattach()", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cd-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");

    // First boot: seed a working interactive-codex task with a resumeRef. Use a
    // fake driver so no real codex spawns.
    const fakeDriver1: any = {
      dispatch: vi.fn(), reattach: vi.fn().mockResolvedValue(undefined),
      say: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), answer: vi.fn(),
    };
    let h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, codexDriver: fakeDriver1 } as any);
    // Fresh heartbeat = a still-live crew. The reattach guard only resumes
    // recently-active tasks; stale zombies (dead crews) are skipped to avoid the
    // boot MCP storm. See shouldReattachCodex.
    const fresh = Date.now();
    await sendRequest(sock, { kind: "seed", record: {
      id: "tc1", project: "p", provider: "codex", mode: "interactive",
      state: "working", task: "x", createdAt: 1, lastHeartbeat: fresh,
      lastEvent: "task.started", heartbeatBudgetMs: 999999,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: fresh, resumeRef: "TH-OLD" }],
    } });
    h.stop();

    // Restart with a fresh fake driver; assert reattach() was called with the seeded record.
    const fakeDriver2: any = {
      dispatch: vi.fn(), reattach: vi.fn().mockResolvedValue(undefined),
      say: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), answer: vi.fn(),
    };
    h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, codexDriver: fakeDriver2 } as any);
    stop = h.stop;

    // Give the fire-and-forget reattach loop one microtask tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeDriver2.reattach).toHaveBeenCalledTimes(1);
    const arg = fakeDriver2.reattach.mock.calls[0][0];
    expect(arg.id).toBe("tc1");
    expect(arg.attempts.at(-1)?.resumeRef).toBe("TH-OLD");
  });

  it("on restart, codex-interactive tasks WITHOUT resumeRef are skipped (no reattach call)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cd-skip-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");

    const fake1: any = { dispatch: vi.fn(), reattach: vi.fn(), say: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), answer: vi.fn() };
    let h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, codexDriver: fake1 } as any);
    await sendRequest(sock, { kind: "seed", record: {
      id: "tc2", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 999999,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }], // no resumeRef
    } });
    h.stop();

    const fake2: any = { dispatch: vi.fn(), reattach: vi.fn(), say: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), answer: vi.fn() };
    h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, codexDriver: fake2 } as any);
    stop = h.stop;
    await new Promise((r) => setTimeout(r, 0));
    expect(fake2.reattach).not.toHaveBeenCalled();
  });

  it("on restart, terminal interactive-codex tasks are NOT reattached", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cd-term-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");

    const fake1: any = { dispatch: vi.fn(), reattach: vi.fn(), say: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), answer: vi.fn() };
    let h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, codexDriver: fake1 } as any);
    await sendRequest(sock, { kind: "seed", record: {
      id: "tc3", project: "p", provider: "codex", mode: "interactive",
      state: "done", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 999999,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1, resumeRef: "TH-X" }],
    } });
    h.stop();

    const fake2: any = { dispatch: vi.fn(), reattach: vi.fn(), say: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), answer: vi.fn() };
    h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, codexDriver: fake2 } as any);
    stop = h.stop;
    await new Promise((r) => setTimeout(r, 0));
    expect(fake2.reattach).not.toHaveBeenCalled();
  });
});
