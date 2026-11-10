// #1112 replay: the 2026-11-09 night. Laptop lid closed ~17h, 61 dark wakes (~15 min
// asleep, ~2 min awake each). Two Claude crews print network/sleep errors on every
// wake. Assert: the captain gets at most one alert per crew per error class, and no
// live crew is cancelled by the wall-clock ceiling.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store.js";
import { createDaemon } from "../daemon/reduce.js";
import { createInteractiveProbe } from "../daemon/interactive-probe.js";
import { createSuspensionClock } from "../daemon/suspensions.js";
import type { ControlEvent, TaskRecord } from "@squadrant/shared";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DNS = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
const SLEEP = "API Error: Your computer went to sleep mid-response. The response above may be incomplete.";
const RETRY = (n: number) => `✻ API error · Retrying in ${n}s · attempt ${n + 1}/10`;
const BOX = ["╭────────────╮", "│ >          │", "╰────────────╯"];

function crew(id: string, name: string): TaskRecord {
  return {
    id, name, project: "p", provider: "claude", mode: "interactive", state: "working", task: "t",
    createdAt: 0, lastHeartbeat: 0, lastEvent: "task.progress", heartbeatBudgetMs: 5 * MIN,
    attempts: [], firstTurnConfirmedAt: 1,
  } as TaskRecord;
}

async function replayNight(withSuspensionClock: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "night-"));
  try {
    const store = createStore(dir);
    store.put(crew("a", "crew-a"));
    store.put(crew("b", "crew-b"));
    let t = 0;
    let lastTickAt = 0;
    const alerts: Array<{ id: string; type: string; message: string }> = [];
    const notify = async (a: { record: TaskRecord; event: ControlEvent; message: string }) => {
      alerts.push({ id: a.record.id, type: a.event.type, message: a.message });
    };
    const clock = createSuspensionClock({
      now: () => t, intervalMs: 10_000, tickGapMs: 30_000, postWakeGraceMs: 120_000,
      readOs: () => ({ sleepMs: lastTickAt + 1_000, wakeMs: t }),
    });
    const d = createDaemon({
      store, now: () => t, taskTimeoutMs: 8 * HOUR, notify,
      ...(withSuspensionClock ? { awakeElapsed: clock.awakeElapsed, timersPaused: clock.paused } : {}),
      isSurfaceAlive: async () => "alive",
    });
    let tail = "";
    const probe = createInteractiveProbe({
      project: "p", listTasks: async () => store.list("p"), readPaneTail: async () => tail,
      sendEvent: async () => {}, now: () => t, log: () => {}, checkAlive: async () => "alive", notify,
    });

    let spin = 0;
    for (let wake = 0; wake < 61; wake++) {
      t += 15 * MIN; // asleep
      for (let s = 0; s < 12; s++) { // awake ~2 min, ticking every 10s
        if (withSuspensionClock) clock.tick();
        spin++;
        tail = [wake % 2 ? DNS : SLEEP, RETRY(spin % 9), `✻ Thinking… (${spin}s)`, ...BOX].join("\n");
        await probe.tick();
        await d.sweep();
        lastTickAt = t;
        t += 10_000;
      }
    }
    const states = { a: store.get("p", "a")?.state, b: store.get("p", "b")?.state };
    return { alerts, states, t };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("sleep-night replay (#1112)", () => {
  it("at most one alert per crew per error class; no live crew is cancelled", async () => {
    const { alerts, states, t } = await replayNight(true);
    expect(t).toBeGreaterThan(14 * HOUR); // wall clock is well past the 8h ceiling
    const warns = alerts.filter((a) => a.type === "task.warn");
    const perKey = new Map<string, number>();
    for (const w of warns) {
      const cls = /ENOTFOUND/.test(w.message) ? "network" : /went to sleep/.test(w.message) ? "sleep" : "other";
      const k = `${w.id}:${cls}`;
      perKey.set(k, (perKey.get(k) ?? 0) + 1);
    }
    expect(perKey.size).toBeGreaterThan(0);
    for (const [k, n] of perKey) expect(n, k).toBe(1);
    expect(warns.some((w) => /Retrying/.test(w.message))).toBe(false);
    expect(alerts.filter((a) => a.type === "task.timeout")).toEqual([]);
    expect(states).toEqual({ a: "working", b: "working" });
  });

  it("control: without the suspension clock the same night cancels the live crews", async () => {
    const { alerts, states } = await replayNight(false);
    expect(alerts.some((a) => a.type === "task.timeout")).toBe(true);
    expect(states.a).toBe("cancelled");
  });
});
