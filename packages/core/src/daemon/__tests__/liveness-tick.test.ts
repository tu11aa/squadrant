import { describe, it, expect } from "vitest";
import { LivenessRegistry } from "../liveness-registry.js";
import { runLivenessTick } from "../delivery-loop.js";
import type { RuntimeLivenessRecord } from "@squadrant/shared";

const memReg = () => new LivenessRegistry({ path: "/x/l.json", readFile: () => undefined, writeFile: () => {} });

describe("runLivenessTick", () => {
  it("registers a captain from the runtime snapshot and marks it alive", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true };
    await runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => true, now: () => 5_000 });
    expect(reg.get("p")?.pidAlive).toBe(true);
    expect(reg.get("p")?.lastState).toBe("start");
  });
  it("captain absent from snapshot → markEnded (stopped), entry kept", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => true, now: () => 5_000 });
    expect(reg.get("p")?.lastState).toBe("end");
  });
  it("present record + dead pid → pidAlive false (→ gone)", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true, isRestorable: true };
    await runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => false, now: () => 5_000 });
    expect(reg.get("p")?.pidAlive).toBe(false);
  });

  it("captain absent from snapshot (→ stopped) triggers reap", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    const reaped: string[] = [];
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => true, now: () => 5_000, reap: (p) => { reaped.push(p); return 0; } });
    expect(reaped).toEqual(["p"]);
  });
  it("present record + dead pid (→ gone) triggers reap", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true, isRestorable: true };
    const reaped: string[] = [];
    await runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => false, now: () => 5_000, reap: (p) => { reaped.push(p); return 0; } });
    expect(reaped).toEqual(["p"]);
  });
  it("alive captain does not trigger reap", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true };
    const reaped: string[] = [];
    await runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => true, now: () => 5_000, reap: (p) => { reaped.push(p); return 0; } });
    expect(reaped).toEqual([]);
  });
  it("no reap dep supplied → tick still completes (optional)", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    await expect(
      runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => true, now: () => 5_000 }),
    ).resolves.toBeUndefined();
  });

  it("liveness() throwing (bad read, e.g. locked/corrupt store) leaves the registry untouched — NOT markEnded", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    const reaped: string[] = [];
    await runLivenessTick({
      registry: reg,
      liveness: async () => { throw new Error("all store files unreadable this tick"); },
      isPidAlive: () => true,
      now: () => 5_000,
      reap: (p) => { reaped.push(p); return 0; },
    });
    expect(reg.get("p")?.lastState).toBe("start"); // NOT "end" — no false close
    expect(reg.get("p")?.pidAlive).toBe(true);
    expect(reaped).toEqual([]); // no reap on a failed read
  });

  it("logs [role/source] project pid=… → state when applying a present record", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true };
    const lines: string[] = [];
    await runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => true, now: () => 5_000, log: (m) => lines.push(m) });
    expect(lines).toContainEqual(expect.stringContaining("[captain/runtime] p pid=100 → alive"));
  });
  it("logs the state transition when a captain goes absent (→ stopped)", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    const lines: string[] = [];
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => true, now: () => 5_000, log: (m) => lines.push(m) });
    expect(lines).toContainEqual(expect.stringContaining("[captain/runtime] p pid=100 → stopped"));
  });
  it("no log dep supplied → tick still completes (optional)", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true };
    await expect(
      runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => true, now: () => 5_000 }),
    ).resolves.toBeUndefined();
  });
});
