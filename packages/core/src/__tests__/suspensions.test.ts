import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awakeElapsedMs, createSuspensionClock, parseSleepWake, suspensionsPath, SUSPENSION_RETENTION_MS,
} from "../daemon/suspensions.js";
import { createDaemon } from "../daemon/reduce.js";
import { createStore } from "../store.js";
import { evaluateStall } from "../watchdog.js";
import type { TaskRecord } from "@squadrant/shared";

const MIN = 60_000;
const HOUR = 60 * MIN;

function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1", project: "p", name: "crew-1", provider: "claude", mode: "interactive", state: "working",
    task: "t", createdAt: 0, lastHeartbeat: 0, lastEvent: "task.progress", heartbeatBudgetMs: 5 * MIN,
    attempts: [], firstTurnConfirmedAt: 1, ...over,
  } as TaskRecord;
}

describe("awakeElapsedMs (#1112)", () => {
  const s = [{ from: 100, to: 200, kind: "sleep" as const }, { from: 300, to: 400, kind: "sleep" as const }];
  it("subtracts overlap with suspensions", () => {
    expect(awakeElapsedMs(s, 0, 500)).toBe(300);
    expect(awakeElapsedMs(s, 150, 350)).toBe(100);
    expect(awakeElapsedMs(s, 120, 180)).toBe(0);
    expect(awakeElapsedMs([], 0, 500)).toBe(500);
    expect(awakeElapsedMs(s, 500, 400)).toBe(0);
  });
});

describe("parseSleepWake", () => {
  it("reads the real sysctl output", () => {
    const out = "{ sec = 1794278048, usec = 586949 } Tue Nov 10 09:34:08 2026\n{ sec = 1794278073, usec = 478578 } Tue Nov 10 09:34:33 2026\n";
    expect(parseSleepWake(out)).toEqual({ sleepMs: 1794278048586, wakeMs: 1794278073478 });
    expect(parseSleepWake("garbage")).toBeNull();
  });
});

describe("suspension clock (#1112)", () => {
  function make(extra: Partial<Parameters<typeof createSuspensionClock>[0]> = {}) {
    let t = 1_000_000;
    const clock = createSuspensionClock({ now: () => t, intervalMs: 5_000, tickGapMs: 30_000, postWakeGraceMs: 120_000, ...extra });
    return { clock, set: (x: number) => { t = x; }, adv: (d: number) => { t += d; return t; } };
  }

  it("ignores a normal tick cadence and a backwards clock", () => {
    const { clock, adv, set } = make({ readOs: () => null });
    adv(5_000); clock.tick(); adv(5_000); clock.tick();
    set(500_000); clock.tick();
    expect(clock.list()).toEqual([]);
  });

  it("records a gap the OS confirms, and awake time excludes it", () => {
    const start = 1_000_000;
    const { clock, adv } = make({ readOs: () => ({ sleepMs: start + 10_000, wakeMs: start + 15 * MIN }) });
    adv(10_000); clock.tick();
    adv(15 * MIN); clock.tick();
    expect(clock.list()).toHaveLength(1);
    expect(clock.awakeElapsed(start, start + 15 * MIN + 10_000)).toBe(10_000);
  });

  it("does NOT treat an unconfirmed gap as a suspension (event-loop stall)", () => {
    const start = 1_000_000;
    const { clock, adv } = make({ readOs: () => ({ sleepMs: start - 3 * HOUR, wakeMs: start - 3 * HOUR + 1000 }) });
    adv(10 * MIN); clock.tick();
    expect(clock.list()).toEqual([]);
  });

  it("falls back to the tick gap alone when the OS cannot answer", () => {
    const { clock, adv } = make({ readOs: () => null });
    adv(10 * MIN); clock.tick();
    expect(clock.list()).toHaveLength(1);
  });

  it("pauses only for the post-wake grace window", () => {
    const { clock, adv } = make({ readOs: () => null });
    adv(10 * MIN); clock.tick();
    const wake = clock.list()[0].to;
    expect(clock.paused(wake + 1_000)).toBe(true);
    expect(clock.paused(wake + 119_000)).toBe(true);
    expect(clock.paused(wake + 121_000)).toBe(false);
  });

  it("merges touching gaps (dark-wake chain) into one entry", () => {
    let t = 0;
    const clock = createSuspensionClock({ now: () => t, readOs: () => null, intervalMs: 5_000, tickGapMs: 30_000 });
    t = 10 * MIN; clock.tick();
    t = 20 * MIN; clock.tick();
    expect(clock.list()).toHaveLength(1);
    expect(clock.list()[0]).toMatchObject({ from: 0, to: 20 * MIN });
  });

  it("drops entries older than 48h (and keeps separate gaps separate)", () => {
    let t = 0;
    const clock = createSuspensionClock({ now: () => t, readOs: () => null, intervalMs: 5_000, tickGapMs: 30_000 });
    t = 10 * MIN; clock.tick();
    t = 10 * MIN + 1_000; clock.tick(); // awake blip between the two gaps
    t = 3 * HOUR; clock.tick();
    expect(clock.list()).toHaveLength(2);
    t = 3 * HOUR + SUSPENSION_RETENTION_MS + 20 * MIN; clock.tick();
    expect(clock.list()).toHaveLength(1);
  });

  it("persists and reloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "susp-"));
    try {
      const path = suspensionsPath(dir);
      let t = Date.now();
      const a = createSuspensionClock({ path, now: () => t, readOs: () => null });
      t += 10 * MIN; a.tick();
      const b = createSuspensionClock({ path, now: () => t, readOs: () => null });
      expect(b.list()).toEqual(a.list());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("boot gap is daemon-down unless the OS saw a sleep in the window", () => {
    const now = 10 * HOUR;
    const slept = createSuspensionClock({ now: () => now, readOs: () => ({ sleepMs: 1 * HOUR, wakeMs: 2 * HOUR }) });
    slept.recordBootGap(0, now);
    expect(slept.list()[0].kind).toBe("sleep");
    const down = createSuspensionClock({ now: () => now, readOs: () => ({ sleepMs: -5 * HOUR, wakeMs: -4 * HOUR }) });
    down.recordBootGap(0, now);
    expect(down.list()[0].kind).toBe("daemon-down");
  });
});

describe("awake time drives the timer-based actions (#1112)", () => {
  const sleeps = [{ from: 10 * MIN, to: 14 * HOUR, kind: "sleep" as const }];
  const awake = (a: number, b: number) => awakeElapsedMs(sleeps, a, b);
  const dir = () => mkdtempSync(join(tmpdir(), "susp-d-"));

  it("evaluateStall: a pending tool that spanned a sleep is not stalled", () => {
    const r = rec({ pendingTool: { name: "Bash", since: 5 * MIN } as any });
    const now = 14 * HOUR + MIN;
    expect(evaluateStall(r, now)?.state).toBe("stalled");
    expect(evaluateStall(r, now, undefined, undefined, awake)).toBeNull();
  });

  it("ceiling: 14h of sleep does not cancel a live crew, 8h of awake time still does", async () => {
    const d1 = dir();
    try {
      const store = createStore(d1);
      store.put(rec());
      const now = 14 * HOUR + 2 * MIN;
      const calls: any[] = [];
      const d = createDaemon({ store, now: () => now, taskTimeoutMs: 8 * HOUR, awakeElapsed: awake, timersPaused: () => false, notify: async (a) => { calls.push(a); } });
      await d.sweep();
      expect(store.get("p", "t1")?.state).not.toBe("cancelled");
      expect(calls.filter((c) => /CREW TIMEOUT/.test(c.message))).toHaveLength(0);

      const later = now + 8 * HOUR;
      const d2 = createDaemon({ store, now: () => later, taskTimeoutMs: 8 * HOUR, awakeElapsed: awake, timersPaused: () => false, notify: async (a) => { calls.push(a); } });
      await d2.sweep();
      expect(store.get("p", "t1")?.state).toBe("cancelled");
    } finally { rmSync(d1, { recursive: true, force: true }); }
  });

  it("post-wake grace pauses the ceiling, stall, quiet and blocked re-nudge; surface-gone reap still runs", async () => {
    const d1 = dir();
    try {
      const store = createStore(d1);
      store.put(rec({ id: "over", createdAt: 0 }));
      store.put(rec({ id: "tool", pendingTool: { name: "Bash", since: 0 } as any, createdAt: 12 * HOUR }));
      store.put(rec({ id: "quiet", createdAt: 12 * HOUR, lastHeartbeat: 12 * HOUR }));
      store.put(rec({ id: "blk", state: "blocked", question: "q?", createdAt: 12 * HOUR, lastHeartbeat: 12 * HOUR }));
      store.put(rec({ id: "gone", state: "awaiting-input", createdAt: 12 * HOUR }));
      const calls: any[] = [];
      const d = createDaemon({
        store, now: () => 12 * HOUR + HOUR, taskTimeoutMs: HOUR, timersPaused: () => true,
        isSurfaceAlive: async (r) => (r.id === "gone" ? "gone" : "alive"),
        notify: async (a) => { calls.push(a); },
      });
      await d.sweep();
      expect(calls).toEqual([]);
      expect(store.get("p", "over")?.state).toBe("working");
      expect(store.get("p", "tool")?.state).toBe("working");
      expect(store.get("p", "gone")?.state).toBe("cancelled");
    } finally { rmSync(d1, { recursive: true, force: true }); }
  });
});
