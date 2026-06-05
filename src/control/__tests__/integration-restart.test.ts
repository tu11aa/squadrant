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

  // #139: an interactive crew whose cmux pane is PROVABLY gone is terminalized
  // (cancelled) on daemon restart — never oscillated to 'stalled' (which fired
  // false CREW STALLED on every restart) and never fabricated to 'done'.
  it("interactive orphan with a GONE surface → cancelled on daemon restart (no false done/stalled)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-int-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");

    let h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    // Construct the precondition (a WORKING interactive task) via `seed`, not
    // `dispatch`: red-team #4 fix makes interactive dispatch fail-loud until the
    // deferred interactive launcher exists.
    await sendRequest(sock, { kind: "seed", record: {
      id: "t1", project: "p", provider: "claude", mode: "interactive",
      state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "task.started", heartbeatBudgetMs: 999999,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });

    // crash the daemon mid-task
    h.stop();

    // restart — reconcile() runs on boot; the crew's pane is gone (session died)
    h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, isSurfaceAlive: async () => "gone" });
    stop = h.stop;

    const st: any = await pollStatus(sock, "t1", (s) => s.state === "cancelled");
    expect(st.state).toBe("cancelled");        // terminalized, not oscillated
    expect(st.state).not.toBe("stalled");      // never re-emits CREW STALLED
    expect(st.state).not.toBe("done");         // never fabricated success
  });

  // The non-regression companion: when liveness is INDETERMINATE (cmux down at
  // boot — the common test/headless case), the crew stays 'working' (the
  // reattach loop + a later sweep re-check own it). Never false-cancelled, never
  // false-stalled, never falsely 'done'.
  it("interactive orphan with UNKNOWN surface liveness stays 'working' on restart (no false terminal)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-int-unk-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");

    let h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    await sendRequest(sock, { kind: "seed", record: {
      id: "t1", project: "p", provider: "claude", mode: "interactive",
      state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "task.started", heartbeatBudgetMs: 999999,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });
    h.stop();

    h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, isSurfaceAlive: async () => "unknown" });
    stop = h.stop;

    const st: any = await sendRequest(sock, { kind: "status", project: "p", id: "t1" });
    expect(st.state).toBe("working");
    expect(st.state).not.toBe("done");
    expect(st.state).not.toBe("cancelled");
  });
});

// Boot reconcile runs in an async IIFE, so a status query can race it; poll
// briefly until the predicate holds (or time out and return the last status).
async function pollStatus(
  sock: string,
  id: string,
  done: (s: any) => boolean,
  tries = 40,
): Promise<any> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    last = await sendRequest(sock, { kind: "status", project: "p", id });
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 10));
  }
  return last;
}

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
