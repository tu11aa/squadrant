// src/control/__tests__/squadrantd-smoke.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSquadrantd, defaultIsPidAlive } from "../squadrantd.js";
import { sendRequest } from "@squadrant/core";

describe("defaultIsPidAlive", () => {
  it("treats the current process as alive", () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
  });
  it("treats an almost-certainly-free pid as dead (ESRCH path)", () => {
    expect(defaultIsPidAlive(2147483646)).toBe(false);
  });
});

describe("squadrantd smoke", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("starts, accepts an event for a pre-seeded task, persists state", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cd-"));
    const sock = join(dir, "c.sock");
    const handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0 });
    stop = handle.stop;
    await sendRequest(sock, { kind: "seed", record: {
      id: "t1", project: "p", provider: "claude", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });
    const r: any = await sendRequest(sock, { kind: "event", project: "p", event: { type: "task.started", id: "t1" } });
    expect(r.state).toBe("working");
  });

  it("honors an injected isPidAlive on boot reconcile (dead pid → failed)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cd-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const working = {
      id: "h1", project: "p", provider: "claude", mode: "headless",
      state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, pid: 4242,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    };

    // Seed a working headless task via a first daemon instance, then stop it.
    const seeder = startSquadrantd({ stateRoot, sockPath: sock, sweepMs: 0 });
    await sendRequest(sock, { kind: "seed", record: working });
    seeder.stop();

    // Restart with injected dead-pid checker: boot reconcile must fail it.
    const dead = startSquadrantd({ stateRoot, sockPath: sock, sweepMs: 0, isPidAlive: () => false });
    stop = dead.stop;
    const failed: any = await sendRequest(sock, { kind: "status", project: "p", id: "h1" });
    expect(failed.state).toBe("failed");
    dead.stop();

    // Restart with alive checker on a fresh seed: boot reconcile must keep it working.
    const seeder2 = startSquadrantd({ stateRoot, sockPath: sock, sweepMs: 0 });
    await sendRequest(sock, { kind: "seed", record: working });
    seeder2.stop();
    const aliveD = startSquadrantd({ stateRoot, sockPath: sock, sweepMs: 0, isPidAlive: () => true });
    stop = aliveD.stop;
    const stillWorking: any = await sendRequest(sock, { kind: "status", project: "p", id: "h1" });
    expect(stillWorking.state).toBe("working");
  });
});
