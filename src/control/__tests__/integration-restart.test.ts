// src/control/__tests__/integration-restart.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";

describe("integration: daemon restart mid-task (success criterion)", () => {
  let stop: (() => void) | undefined; let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("a working interactive task survives a daemon restart as 'stalled' (no false done)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-int-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");

    let h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    // Construct the precondition (a WORKING interactive task) via `seed`, not
    // `dispatch`: red-team #4 fix makes interactive dispatch fail-loud until
    // the deferred interactive launcher exists. The success criterion under
    // test is reconcile behavior (working interactive → stalled across a
    // restart, never fabricated `done`), which is unchanged and still proven.
    await sendRequest(sock, { kind: "seed", record: {
      id: "t1", project: "p", provider: "claude", mode: "interactive",
      state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "task.started", heartbeatBudgetMs: 999999,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });

    // crash the daemon mid-task
    h.stop();

    // restart — reconcile() must run on boot
    h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    stop = h.stop;

    const st: any = await sendRequest(sock, { kind: "status", project: "p", id: "t1" });
    expect(st.state).toBe("stalled");          // surfaced deterministically
    expect(st.state).not.toBe("done");          // never fabricated success
  });
});

describe("integration: headless dead-pid conservative crash recovery", () => {
  it("dead headless pid reconciles to 'failed' on daemon restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-hl-dead-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    try {
      // Seed a working headless task with a pid into a live daemon, then stop it.
      const first = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
      await sendRequest(sock, { kind: "seed", record: {
        id: "h1", project: "p", provider: "claude", mode: "headless",
        state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
        lastEvent: "", heartbeatBudgetMs: 1000, pid: 99999,
        attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
      } });
      first.stop();

      // Restart with isPidAlive: () => false (simulating the child died while daemon was down).
      const dead = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, isPidAlive: () => false });
      const st: any = await sendRequest(sock, { kind: "status", project: "p", id: "h1" });
      dead.stop();

      // Conservative crash recovery: must be failed, never done, never silently working.
      expect(st.state).toBe("failed");
      expect(st.state).not.toBe("done");
      expect(st.state).not.toBe("working");
      // Proves it failed via reconcile's conservative path, not some other failure.
      expect(st.error).toMatch(/orphan|daemon restart/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("live headless pid stays 'working' after daemon bounce", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-hl-live-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    try {
      // Seed a working headless task with a pid, then stop daemon.
      const first = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
      await sendRequest(sock, { kind: "seed", record: {
        id: "h2", project: "p", provider: "claude", mode: "headless",
        state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
        lastEvent: "", heartbeatBudgetMs: 1000, pid: 99999,
        attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
      } });
      first.stop();

      // Restart with isPidAlive: () => true (child survived the daemon bounce).
      const alive = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, isPidAlive: () => true });
      const st: any = await sendRequest(sock, { kind: "status", project: "p", id: "h2" });
      alive.stop();

      // Live child survives a daemon bounce: must remain working.
      expect(st.state).toBe("working");
      // Reconcile correctly SKIPPED the record rather than transitioning it.
      expect(st.lastEvent).not.toBe("reconcile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
