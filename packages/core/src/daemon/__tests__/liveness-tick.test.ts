import { describe, it, expect } from "vitest";
import { LivenessRegistry } from "../liveness-registry.js";
import { runLivenessTick } from "../delivery-loop.js";
import { deriveCaptainState } from "../../liveness.js";
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
  it("captain absent from snapshot + pid confirmed dead → markEnded (stopped), entry kept", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => false, now: () => 5_000 });
    expect(reg.get("p")?.lastState).toBe("end");
  });

  // #565: absence from a single snapshot is not proof of death. Reproduces the
  // live incident — bet2fun-app's captain vanished from the runtime snapshot
  // (its cmux record degraded to role:"unknown") while its pid was still very
  // much alive; the old code inferred "ended" from absence alone and silently
  // paused delivery + reaped its live crews forever.
  it("captain absent from snapshot but pid still alive → NOT marked ended (#565 fail-safe)", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    const lines: string[] = [];
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => true, now: () => 5_000, log: (m) => lines.push(m) });
    expect(reg.get("p")?.lastState).toBe("start");
    expect(deriveCaptainState(reg.get("p"))).toBe("alive");
    expect(lines).toContainEqual(expect.stringContaining("missing from snapshot but not confirmed dead"));
  });

  it("captain absent from snapshot with an unknown (null) pid → left alone, not marked ended (#565 fail-safe)", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: null, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => { throw new Error("must not be called with a null pid"); }, now: () => 5_000 });
    expect(reg.get("p")?.lastState).toBe("start");
  });

  // #565 root cause: cmux degraded the live captain's launchCommand so
  // roleFromTemplate can no longer classify it — the record shows up with
  // role:"unknown" even though its sessionId is the one we already confirmed
  // is this project's captain.
  it("record with role:unknown but a known-captain sessionId is still treated as the captain (#565)", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "end", lastSeenAt: 1_000, pidAlive: false, source: "runtime" });
    const degraded: RuntimeLivenessRecord = { role: "unknown", project: "p", pid: 100, sessionId: "s", present: true };
    await runLivenessTick({ registry: reg, liveness: async () => [degraded], isPidAlive: () => true, now: () => 5_000 });
    expect(deriveCaptainState(reg.get("p"))).toBe("alive");
  });
  it("present record + dead pid → pidAlive false (→ gone)", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true, isRestorable: true };
    await runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => false, now: () => 5_000 });
    expect(reg.get("p")?.pidAlive).toBe(false);
  });

  it("captain absent from snapshot + pid confirmed dead (→ stopped) triggers reap", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    const reaped: string[] = [];
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => false, now: () => 5_000, reap: (p) => { reaped.push(p); return 0; } });
    expect(reaped).toEqual(["p"]);
  });

  it("captain absent from snapshot but pid still alive → NOT reaped (#565 fail-safe)", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    const reaped: string[] = [];
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => true, now: () => 5_000, reap: (p) => { reaped.push(p); return 0; } });
    expect(reaped).toEqual([]);
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
  it("logs the state transition when a captain goes absent + pid confirmed dead (→ stopped)", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    const lines: string[] = [];
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => false, now: () => 5_000, log: (m) => lines.push(m) });
    expect(lines).toContainEqual(expect.stringContaining("[captain/runtime] p pid=100 → stopped"));
  });
  it("no log dep supplied → tick still completes (optional)", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true };
    await expect(
      runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => true, now: () => 5_000 }),
    ).resolves.toBeUndefined();
  });

  // ── #527: multiple cmux sessions sharing a project cwd ─────────────────

  it("two records same project, DEAD pid iterated LAST → picks alive (regression for #527)", async () => {
    const reg = memReg();
    const live: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s1", present: true };
    const dead: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 200, sessionId: "s2", present: true, isRestorable: true };
    await runLivenessTick({
      registry: reg,
      liveness: async () => [live, dead],
      isPidAlive: (pid) => pid === 100,
      now: () => 5_000,
    });
    expect(reg.get("p")?.pidAlive).toBe(true);
    expect(deriveCaptainState(reg.get("p"))).toBe("alive");
  });

  it("two records same project, both pids dead → captain gone", async () => {
    const reg = memReg();
    const dead1: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s1", present: true, isRestorable: true };
    const dead2: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 200, sessionId: "s2", present: true, isRestorable: true };
    await runLivenessTick({
      registry: reg,
      liveness: async () => [dead1, dead2],
      isPidAlive: () => false,
      now: () => 5_000,
    });
    expect(reg.get("p")?.pidAlive).toBe(false);
    expect(deriveCaptainState(reg.get("p"))).toBe("gone");
  });
});
