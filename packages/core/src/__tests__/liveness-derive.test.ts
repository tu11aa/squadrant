import { describe, it, expect } from "vitest";
import { deriveCaptainState, reconcileLiveness } from "../liveness.js";
import type { LivenessEntry } from "@squadrant/shared";

const base = (o: Partial<LivenessEntry> = {}): LivenessEntry => ({
  project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000,
  lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime", ...o,
});

describe("deriveCaptainState", () => {
  it("undefined entry → unknown", () => expect(deriveCaptainState(undefined)).toBe("unknown"));
  it("lastState=end → stopped (before pid check)", () =>
    expect(deriveCaptainState(base({ lastState: "end", pidAlive: false }))).toBe("stopped"));
  it("pid dead + record present (crash) → gone", () =>
    expect(deriveCaptainState(base({ lastState: "start", pidAlive: false }))).toBe("gone"));
  it("pid alive → alive", () => expect(deriveCaptainState(base())).toBe("alive"));
});

describe("reconcileLiveness — runtime ≥ agent > scan", () => {
  it("scan may set pidAlive=false but not override runtime presence", () => {
    const prev = base({ source: "runtime", lastState: "start", pidAlive: true });
    const scan = base({ source: "scan", pidAlive: false, lastSeenAt: 2_000 });
    const out = reconcileLiveness(prev, scan);
    expect(out.pidAlive).toBe(false);      // liveness axis updated
    expect(out.lastState).toBe("start");   // presence/intent unchanged by scan
    expect(out.source).toBe("runtime");
  });
  it("scan cannot resurrect a dead pid; only a newer runtime/agent open does", () => {
    const prev = base({ pidAlive: false, startedAt: 1_000 });
    const staleScan = base({ source: "scan", pidAlive: true, startedAt: 1_000, lastSeenAt: 900 });
    expect(reconcileLiveness(prev, staleScan).pidAlive).toBe(false);
    const reopen = base({ source: "runtime", pid: 200, startedAt: 3_000, pidAlive: true });
    expect(reconcileLiveness(prev, reopen).pidAlive).toBe(true);
  });
  it("runtime record end → lastState=end, entry kept (not dropped)", () => {
    const prev = base({ source: "runtime", lastState: "start" });
    const closed = base({ source: "runtime", lastState: "end", lastSeenAt: 2_000 });
    expect(reconcileLiveness(prev, closed).lastState).toBe("end");
  });
});
