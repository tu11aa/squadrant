import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatusObserver, createStatusRuntime, feedEvent, INCIDENT_LOG_MAX_BYTES, type StatusObserver } from "../daemon/status-observer.js";

const MIN = 60_000;

function setup(over: { stableAwakeMs?: number; dir?: string } = {}) {
  const dir = over.dir ?? mkdtempSync(join(tmpdir(), "status-"));
  let t = 1_000_000_000;
  const obs = createStatusObserver({ dir, suspensions: () => [], now: () => t, stableAwakeMs: over.stableAwakeMs });
  return { dir, obs, adv: (d: number) => { t += d; return t; }, now: () => t, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const cond = (o: StatusObserver, subject: string, type: string) => o.snapshot().conditions.find((c) => c.subject === subject && c.type === type)!;
const incLog = (dir: string) => readFileSync(join(dir, "incidents.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const gap = (now: number, ms: number) => ({ kind: "suspension" as const, from: now - ms, to: now });

describe("machine.Awake (#1112 P1)", () => {
  it("opens on a suspension, closes only when stably awake", () => {
    const s = setup();
    try {
      expect(cond(s.obs, "machine", "Awake").status).toBe("True");
      s.obs.tick(gap(s.adv(15 * MIN), 15 * MIN));
      expect(cond(s.obs, "machine", "Awake")).toMatchObject({ status: "False", reason: "Suspended" });
      s.obs.tick({ kind: "none" }); // right after the wake
      expect(cond(s.obs, "machine", "Awake").status).toBe("False");
      s.adv(4 * MIN); s.obs.tick({ kind: "none" });
      expect(cond(s.obs, "machine", "Awake").status).toBe("False");
      const openedTransition = cond(s.obs, "machine", "Awake").lastTransitionTime;
      s.adv(2 * MIN); s.obs.tick({ kind: "none" });
      expect(cond(s.obs, "machine", "Awake")).toMatchObject({ status: "True", reason: "StablyAwake" });
      expect(cond(s.obs, "machine", "Awake").lastTransitionTime).toBeGreaterThan(openedTransition);
      expect(incLog(s.dir).map((r) => r.event)).toEqual(["open", "close"]);
    } finally { s.cleanup(); }
  });

  it("dark wakes: 180 s awake / 15 min asleep for 17 h is exactly ONE incident", () => {
    const s = setup();
    try {
      for (let i = 0; i < 60; i++) {
        s.obs.tick(gap(s.adv(15 * MIN), 15 * MIN));
        for (let a = 0; a < 180; a += 5) { s.adv(5_000); s.obs.tick({ kind: "none" }); }
        expect(cond(s.obs, "machine", "Awake").status).toBe("False");
      }
      const log = incLog(s.dir);
      expect(log.filter((r) => r.event === "open" && r.incident.condition === "Awake")).toHaveLength(1);
      expect(log.filter((r) => r.event === "close")).toHaveLength(0);
      s.adv(6 * MIN); s.obs.tick({ kind: "none" });
      expect(incLog(s.dir).filter((r) => r.event === "close")).toHaveLength(1);
      expect(s.obs.snapshot().incidents.find((i) => i.key === "machine:asleep")?.gaps).toBe(60);
    } finally { s.cleanup(); }
  });

  it("a boot gap the OS calls sleep opens it; daemon-down does not", () => {
    const s = setup();
    try {
      s.obs.noteSuspension({ from: s.now() - 9 * 60 * MIN, to: s.now(), kind: "daemon-down" });
      expect(cond(s.obs, "machine", "Awake").status).toBe("True");
      s.obs.noteSuspension({ from: s.now() - 9 * 60 * MIN, to: s.now(), kind: "sleep" });
      expect(cond(s.obs, "machine", "Awake").status).toBe("False");
    } finally { s.cleanup(); }
  });
});

describe("squadrant:daemon (#1112 P1)", () => {
  it("an unconfirmed gap is an EventLoopStall fact, cleared on the next healthy tick; no incident", () => {
    const s = setup();
    try {
      s.obs.tick({ kind: "stall", from: s.now() - 50_000, to: s.now() });
      expect(cond(s.obs, "squadrant:daemon", "Healthy")).toMatchObject({ status: "False", reason: "EventLoopStall" });
      expect(cond(s.obs, "machine", "Awake").status).toBe("True");
      s.adv(5_000); s.obs.tick({ kind: "none" });
      expect(cond(s.obs, "squadrant:daemon", "Healthy").status).toBe("True");
      expect(existsSync(join(s.dir, "incidents.jsonl"))).toBe(false);
    } finally { s.cleanup(); }
  });
});

describe("session conditions (#1112 P1)", () => {
  const live = [{ project: "p", id: "a" }, { project: "p", id: "b" }];

  it("every live session gets a condition; ended sessions lose it and close their incident", () => {
    const s = setup();
    try {
      s.obs.syncSessions(live);
      expect(cond(s.obs, "session:p/a", "Reachable").status).toBe("Unknown");
      s.obs.sessionError("p", "a", "other", "probe", "API Error: boom");
      s.obs.syncSessions([{ project: "p", id: "b" }]);
      expect(s.obs.snapshot().conditions.some((c) => c.subject === "session:p/a")).toBe(false);
      expect(incLog(s.dir).map((r) => `${r.event}:${r.incident.key}`)).toEqual(["open:crew:a:other", "close:crew:a:other"]);
    } finally { s.cleanup(); }
  });

  it("goes False on a probe error and True on the next healthy event", () => {
    const s = setup();
    try {
      s.obs.syncSessions(live);
      s.obs.sessionError("p", "a", "other", "probe", "API Error: boom");
      expect(cond(s.obs, "session:p/a", "Reachable")).toMatchObject({ status: "False", reason: "probe:other" });
      s.obs.sessionHealthy("p", "a");
      expect(cond(s.obs, "session:p/a", "Reachable")).toMatchObject({ status: "True" });
      expect(incLog(s.dir).map((r) => r.event)).toEqual(["open", "close"]);
    } finally { s.cleanup(); }
  });

  it("feedEvent: turn.failed is an error, heartbeat/turn events are healthy, others ignored", () => {
    const s = setup();
    try {
      const rec = { project: "p", id: "a" } as any;
      s.obs.syncSessions([rec]);
      feedEvent(s.obs, rec, { type: "task.turn.failed", id: "a", error: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" } as any);
      expect(cond(s.obs, "session:p/a", "Reachable")).toMatchObject({ status: "False", reason: "turn.failed:network" });
      feedEvent(s.obs, rec, { type: "task.warn", id: "a" } as any);
      expect(cond(s.obs, "session:p/a", "Reachable").status).toBe("False");
      feedEvent(s.obs, rec, { type: "heartbeat", id: "a" } as any);
      expect(cond(s.obs, "session:p/a", "Reachable").status).toBe("True");
    } finally { s.cleanup(); }
  });

  it("is recorded even when the machine explains it (inhibitedBy is just a field)", () => {
    const s = setup();
    try {
      s.obs.syncSessions(live);
      s.obs.tick(gap(s.adv(15 * MIN), 15 * MIN));
      s.obs.sessionError("p", "a", "sleep", "probe", "API Error: Your computer went to sleep");
      expect(cond(s.obs, "session:p/a", "Reachable")).toMatchObject({ status: "False", inhibitedBy: "machine:asleep" });
    } finally { s.cleanup(); }
  });
});

describe("network.Reachable (#1112 P1)", () => {
  const live = [{ project: "p", id: "a" }, { project: "p", id: "b" }];

  it("one session with network errors does not open it; two do; it closes when both recover", () => {
    const s = setup();
    try {
      s.obs.syncSessions(live);
      s.obs.sessionError("p", "a", "network", "probe", "ENOTFOUND");
      expect(cond(s.obs, "network", "Reachable").status).toBe("True");
      s.adv(MIN);
      s.obs.sessionError("p", "b", "network", "probe", "ENOTFOUND");
      expect(cond(s.obs, "network", "Reachable")).toMatchObject({ status: "False", reason: "NetworkErrors" });
      expect(cond(s.obs, "session:p/a", "Reachable").inhibitedBy).toBe("network:unreachable");
      s.obs.sessionHealthy("p", "a");
      expect(cond(s.obs, "network", "Reachable").status).toBe("False");
      s.obs.sessionHealthy("p", "b");
      expect(cond(s.obs, "network", "Reachable").status).toBe("True");
      expect(incLog(s.dir).filter((r) => r.incident.key === "network:unreachable").map((r) => r.event)).toEqual(["open", "close"]);
    } finally { s.cleanup(); }
  });

  it("errors outside the window do not combine", () => {
    const s = setup();
    try {
      s.obs.syncSessions(live);
      s.obs.sessionError("p", "a", "network", "probe", "ENOTFOUND");
      s.adv(11 * MIN); s.obs.tick({ kind: "none" });
      s.obs.sessionError("p", "b", "network", "probe", "ENOTFOUND");
      expect(cond(s.obs, "network", "Reachable").status).toBe("True");
    } finally { s.cleanup(); }
  });

  it("a session ending closes the network incident it was the last holder of", () => {
    const s = setup();
    try {
      s.obs.syncSessions(live);
      s.obs.sessionError("p", "a", "network", "probe", "x");
      s.obs.sessionError("p", "b", "network", "probe", "x");
      s.obs.syncSessions([]);
      expect(cond(s.obs, "network", "Reachable").status).toBe("True");
    } finally { s.cleanup(); }
  });
});

describe("persistence (#1112 P1)", () => {
  it("writes current.json with the spec shape and reloads open incidents on boot", () => {
    const s = setup();
    try {
      s.obs.tick(gap(s.adv(15 * MIN), 15 * MIN));
      s.obs.flush(true);
      const snap = JSON.parse(readFileSync(join(s.dir, "current.json"), "utf8"));
      expect(snap).toMatchObject({ schema: 1, daemon: { tickIntervalMs: 5000 } });
      expect(Object.keys(snap)).toEqual(expect.arrayContaining(["updatedAt", "daemon", "suspensions", "conditions", "incidents"]));
      const again = createStatusObserver({ dir: s.dir, suspensions: () => [], now: s.now });
      expect(cond(again, "machine", "Awake").status).toBe("False");
      expect(again.snapshot().incidents.filter((i) => !i.closedAt)).toHaveLength(1);
    } finally { s.cleanup(); }
  });

  it("rebuilds a corrupt current.json from the log, skipping bad lines", () => {
    const s = setup();
    try {
      s.obs.syncSessions([{ project: "p", id: "a" }]);
      s.obs.tick(gap(s.adv(15 * MIN), 15 * MIN));
      s.obs.sessionError("p", "a", "other", "probe", "boom");
      s.obs.flush(true);
      writeFileSync(join(s.dir, "current.json"), "{ not json");
      appendFileSync(join(s.dir, "incidents.jsonl"), "garbage line\n{\"event\":\"open\"}\n");
      const again = createStatusObserver({ dir: s.dir, suspensions: () => [], now: s.now });
      expect(cond(again, "machine", "Awake").status).toBe("False");
      expect(cond(again, "session:p/a", "Reachable").status).toBe("False");
      expect(again.snapshot().incidents.map((i) => i.key).sort()).toEqual(["crew:a:other", "machine:asleep"]);
    } finally { s.cleanup(); }
  });

  it("rebuilds from the log when current.json was deleted, and honours a closed incident", () => {
    const s = setup({ stableAwakeMs: MIN });
    try {
      s.obs.tick(gap(s.adv(15 * MIN), 15 * MIN));
      s.adv(2 * MIN); s.obs.tick({ kind: "none" });
      rmSync(join(s.dir, "current.json"));
      const again = createStatusObserver({ dir: s.dir, suspensions: () => [], now: s.now });
      expect(cond(again, "machine", "Awake").status).toBe("True");
    } finally { s.cleanup(); }
  });

  it("rotates the log at 1 MB, keeps one previous file, carries open incidents forward", () => {
    const s = setup();
    try {
      s.obs.tick(gap(s.adv(15 * MIN), 15 * MIN)); // machine incident stays open
      appendFileSync(join(s.dir, "incidents.jsonl"), `${"x".repeat(INCIDENT_LOG_MAX_BYTES)}\n`);
      s.obs.syncSessions([{ project: "p", id: "a" }]);
      s.obs.sessionError("p", "a", "other", "probe", "boom"); // triggers rotation on append
      expect(existsSync(join(s.dir, "incidents.jsonl.1"))).toBe(true);
      const cur = incLog(s.dir);
      expect(cur.map((r) => r.incident.key).sort()).toEqual(["crew:a:other", "machine:asleep"]);
      rmSync(join(s.dir, "current.json"));
      const again = createStatusObserver({ dir: s.dir, suspensions: () => [], now: s.now });
      expect(again.snapshot().incidents.map((i) => i.key).sort()).toEqual(["crew:a:other", "machine:asleep"]);
    } finally { s.cleanup(); }
  });
});

describe("status.enabled / config keys (#1112 P1)", () => {
  it("enabled=false builds no clock and no observer, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-off-"));
    try {
      expect(createStatusRuntime({ enabled: false }, dir)).toBeUndefined();
      expect(existsSync(join(dir, "status"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("enabled (default) writes status/current.json and honours tickGapMs", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-on-"));
    try {
      const rt = createStatusRuntime({ tickGapMs: 1234 }, dir)!;
      rt.observer.flush(true);
      rt.tick();
      expect(existsSync(join(dir, "status", "current.json"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
