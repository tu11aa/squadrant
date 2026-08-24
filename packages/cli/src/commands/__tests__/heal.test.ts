// src/commands/__tests__/heal.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentHealth } from "@squadrant/core";

// ── pure helper (no I/O) ─────────────────────────────────────────────────────

import {
  buildHealStatus,
  healCmdFor,
  type HealStatusResult,
} from "../heal.js";

// ── fixture helpers ──────────────────────────────────────────────────────────

function makeCaptain(state: ComponentHealth["state"], project = "brove"): ComponentHealth {
  return { kind: "captain", project, ref: `${project}-captain`, state, lastSeenMs: state === "alive" ? Date.now() : null };
}
function makeCrew(state: ComponentHealth["state"]): ComponentHealth {
  return { kind: "crew", project: "brove", ref: "worker-1", state, lastSeenMs: null };
}
function makeDelivery(state: ComponentHealth["state"], project = "brove", detail?: string): ComponentHealth {
  return { kind: "delivery", project, ref: "delivery", state, lastSeenMs: null, detail };
}

// ── healCmdFor ───────────────────────────────────────────────────────────────

describe("healCmdFor", () => {
  it("returns null for all components (no heal verb exists)", () => {
    expect(healCmdFor(makeCaptain("alive"))).toBeNull();
    expect(healCmdFor(makeCaptain("gone"))).toBeNull();
    expect(healCmdFor(makeCaptain("unknown"))).toBeNull();
    expect(healCmdFor(makeCaptain("stopped"))).toBeNull();
    expect(healCmdFor(makeCrew("gone"))).toBeNull();
    expect(healCmdFor(makeDelivery("stale"))).toBeNull();
  });
});

// ── buildHealStatus ──────────────────────────────────────────────────────────

describe("buildHealStatus", () => {
  it("healthy=true when all components are alive", () => {
    const components: ComponentHealth[] = [
      makeCaptain("alive", "brove"),
      makeCaptain("alive", "scaffold"),
    ];
    const result = buildHealStatus(components);
    expect(result.healthy).toBe(true);
    expect(result.components.every((c) => c.healCmd === null)).toBe(true);
  });

  it("healthy=true when captain is gone (no heal verb → healCmd null, daemon handles recovery)", () => {
    const components: ComponentHealth[] = [
      makeCaptain("gone", "brove"),
      makeCaptain("alive", "scaffold"),
    ];
    const result = buildHealStatus(components);
    expect(result.healthy).toBe(true);
  });

  it("healthy=true when crew is stale (routine idle crew does not make whole system unhealthy)", () => {
    const components: ComponentHealth[] = [
      makeCaptain("alive", "brove"),
      makeCrew("stale"),
    ];
    const result = buildHealStatus(components);
    expect(result.healthy).toBe(true);
  });

  it("healthy=false when delivery is stuck (#715)", () => {
    const components: ComponentHealth[] = [
      makeCaptain("alive", "squadrant"),
      makeDelivery("stale", "squadrant", "⚠️ delivery stuck (300+ retries, reason: no-box)"),
    ];
    const result = buildHealStatus(components);
    expect(result.healthy).toBe(false);
    const deliv = result.components.find((c) => c.kind === "delivery");
    expect(deliv).toBeDefined();
    expect(deliv?.state).toBe("stale");
    expect(deliv?.detail).toBe("⚠️ delivery stuck (300+ retries, reason: no-box)");
    expect(deliv?.healCmd).toBeNull();
  });

  it("healthy=false when delivery is deferring (#715)", () => {
    const components: ComponentHealth[] = [
      makeCaptain("alive", "squadrant"),
      makeDelivery("stale", "squadrant", "delivery deferred (15 retries, reason: draft)"),
    ];
    const result = buildHealStatus(components);
    expect(result.healthy).toBe(false);
    const deliv = result.components.find((c) => c.kind === "delivery");
    expect(deliv?.state).toBe("stale");
    expect(deliv?.detail).toBe("delivery deferred (15 retries, reason: draft)");
  });

  it("healthy=true when captain is stopped (intentional close)", () => {
    const components: ComponentHealth[] = [
      makeCaptain("stopped", "brove"),
    ];
    const result = buildHealStatus(components);
    expect(result.healthy).toBe(true);
  });

  it("returns all component fields including detail in output", () => {
    const captain = makeCaptain("gone", "brove");
    const result = buildHealStatus([captain]);
    const out = result.components[0];
    expect(out.kind).toBe("captain");
    expect(out.project).toBe("brove");
    expect(out.state).toBe("gone");
    expect(out.healCmd).toBeNull();
  });

  it("empty component list → healthy=true", () => {
    const result = buildHealStatus([]);
    expect(result.healthy).toBe(true);
  });

  it("daemon-unreachable (null components) → healthy=false", () => {
    const result = buildHealStatus(null);
    expect(result.healthy).toBe(false);
    expect(result.daemonUnreachable).toBe(true);
  });
});

// ── integration: runHealStatus (mocked I/O) ──────────────────────────────────

describe("runHealStatus (integration, mocked I/O)", () => {
  let queryHealthMock: ReturnType<typeof vi.fn>;
  let stdoutLines: string[];
  let stderrLines: string[];
  let exitCode: number | undefined;

  beforeEach(async () => {
    stdoutLines = [];
    stderrLines = [];
    exitCode = undefined;
    queryHealthMock = vi.fn();
  });

  it("exits 0 and prints healthy when all alive", async () => {
    queryHealthMock.mockResolvedValue([makeCaptain("alive", "brove")]);
    const { runHealStatus } = await import("../heal.js");
    const code = await runHealStatus({
      project: undefined,
      json: false,
      queryHealth: queryHealthMock,
      // #671: without this, runHealStatus falls back to a REAL socket connect()
      // against ~/.config/squadrant/squadrant.sock — passing or failing this
      // test depending on whether a daemon happens to be running on the
      // machine it executes on (it was, locally; it wasn't, on CI). Stubbed
      // so this test asserts the healthy path hermetically, independent of
      // any real daemon state.
      isDaemonAlive: async () => true,
      stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { stderrLines.push(s); } } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(0);
    const out = stdoutLines.join("");
    expect(out).toContain("healthy");
  });

  it("exits 2 and prints unhealthy when delivery is stuck (#715)", async () => {
    queryHealthMock.mockResolvedValue([
      makeCaptain("alive", "squadrant"),
      makeDelivery("stale", "squadrant", "⚠️ delivery stuck (300+ retries, reason: no-box)"),
    ]);
    const { runHealStatus } = await import("../heal.js");
    const code = await runHealStatus({
      project: undefined,
      json: false,
      queryHealth: queryHealthMock,
      isDaemonAlive: async () => true,
      stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { stderrLines.push(s); } } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(2);
    const out = stdoutLines.join("");
    expect(out).toContain("Unhealthy components:");
    expect(out).toContain("delivery");
    expect(out).toContain("stale");
    expect(out).toContain("⚠️ delivery stuck (300+ retries, reason: no-box)");
  });

  it("exits 2 with --json and outputs structured error when delivery is stuck (#715)", async () => {
    queryHealthMock.mockResolvedValue([
      makeCaptain("alive", "squadrant"),
      makeDelivery("stale", "squadrant", "⚠️ delivery stuck (300+ retries, reason: no-box)"),
    ]);
    const { runHealStatus } = await import("../heal.js");
    const code = await runHealStatus({
      project: undefined,
      json: true,
      queryHealth: queryHealthMock,
      isDaemonAlive: async () => true,
      stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { stderrLines.push(s); } } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutLines.join(""));
    expect(parsed.healthy).toBe(false);
    const deliv = parsed.components.find((c: any) => c.kind === "delivery");
    expect(deliv.state).toBe("stale");
    expect(deliv.detail).toContain("delivery stuck");
    expect(deliv.healCmd).toBeNull();
  });

  it("exits 1 and prints error when daemon unreachable", async () => {
    queryHealthMock.mockResolvedValue(null);
    const { runHealStatus } = await import("../heal.js");
    const code = await runHealStatus({
      project: undefined,
      json: false,
      queryHealth: queryHealthMock,
      // Daemon IS alive (probe true) — this test exercises the separate
      // "queryHealth itself returned null" unreachable path, not the #671
      // liveness gate, and must not depend on a real socket to do so.
      isDaemonAlive: async () => true,
      stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { stderrLines.push(s); } } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(1);
    const err = stderrLines.join("");
    expect(err).toContain("daemon unreachable");
  });
});

// ── regression: ground-truth daemon liveness (#671) ───────────────────────────
//
// #671: during the #670 incident, `heal status` printed "✔ all components
// healthy" while the daemon was booted out and zero squadrantd processes were
// running. buildHealStatus([]) is vacuously "healthy" (empty.every() === true)
// — legitimate for a freshly-started daemon with no registered projects, but
// indistinguishable from "the daemon never actually answered". runHealStatus
// must assert daemon liveness directly (connect() to the socket) rather than
// inferring it from whether the component query happened to return rows.

describe("runHealStatus — ground-truth daemon liveness (#671)", () => {
  it("reports unhealthy when the daemon liveness probe fails, even though the component query returns an empty (not null) list — the exact false-green repro", async () => {
    const queryHealthMock = vi.fn().mockResolvedValue([]); // the observed false-green condition
    const isDaemonAlive = vi.fn().mockResolvedValue(false);
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const { runHealStatus } = await import("../heal.js");

    const code = await runHealStatus({
      project: undefined,
      json: false,
      queryHealth: queryHealthMock,
      isDaemonAlive,
      stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { stderrLines.push(s); } } as unknown as NodeJS.WritableStream,
    });

    expect(isDaemonAlive).toHaveBeenCalled();
    expect(code).toBe(1);
    expect(stderrLines.join("")).toContain("daemon unreachable");
    expect(stdoutLines.join("")).not.toContain("healthy");
  });

  it("still reports healthy when the daemon is genuinely alive with zero registered projects (legitimate fresh-install case)", async () => {
    const queryHealthMock = vi.fn().mockResolvedValue([]);
    const isDaemonAlive = vi.fn().mockResolvedValue(true);
    const stdoutLines: string[] = [];
    const { runHealStatus } = await import("../heal.js");

    const code = await runHealStatus({
      project: undefined,
      json: false,
      queryHealth: queryHealthMock,
      isDaemonAlive,
      stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: () => false } as unknown as NodeJS.WritableStream,
    });

    expect(code).toBe(0);
    expect(stdoutLines.join("")).toContain("healthy");
  });
});

// ── integration: runHealDaemon (mocked I/O) ───────────────────────────────────

// ── heal captain (#699) ────────────────────────────────────────────────────

import type { RuntimeLivenessRecord, LivenessEntry } from "@squadrant/shared";

describe("resolveLiveCaptain", () => {
  it("returns the live captain record for the given project", async () => {
    const { resolveLiveCaptain } = await import("../heal.js");
    const records: RuntimeLivenessRecord[] = [
      { role: "captain", project: "squadrant", pid: 12236, sessionId: "s1", present: true },
      { role: "captain", project: "helpa", pid: 999, sessionId: "s2", present: true },
    ];
    const resolved = resolveLiveCaptain(records, "squadrant", () => true);
    expect(resolved).toEqual({ project: "squadrant", pid: 12236, sessionId: "s1" });
  });

  it("never invents an entry for a dead pid", async () => {
    const { resolveLiveCaptain } = await import("../heal.js");
    const records: RuntimeLivenessRecord[] = [
      { role: "captain", project: "squadrant", pid: 12236, sessionId: "s1", present: true },
    ];
    const resolved = resolveLiveCaptain(records, "squadrant", () => false);
    expect(resolved).toBeNull();
  });

  it("returns null when no record matches the project", async () => {
    const { resolveLiveCaptain } = await import("../heal.js");
    const resolved = resolveLiveCaptain([], "squadrant", () => true);
    expect(resolved).toBeNull();
  });

  it("returns null when the only candidate has a null (hibernated) pid — heal captain only re-adopts a RUNNING captain", async () => {
    const { resolveLiveCaptain } = await import("../heal.js");
    const records: RuntimeLivenessRecord[] = [
      { role: "captain", project: "squadrant", pid: null, sessionId: "s1", present: true },
    ];
    const resolved = resolveLiveCaptain(records, "squadrant", () => true);
    expect(resolved).toBeNull();
  });
});

describe("runHealCaptain (integration, mocked I/O)", () => {
  function makeDeps(overrides: Partial<{
    records: RuntimeLivenessRecord[];
    entry: LivenessEntry | undefined;
    isPidAlive: (pid: number) => boolean;
    reloadEntry: (project: string) => LivenessEntry | undefined;
  }> = {}) {
    // Default reloadEntry simulates the no-race case: whatever applyEntry most
    // recently wrote for a project is what a fresh disk read returns — i.e.
    // the write survived the daemon restart cleanly.
    const lastApplied = new Map<string, LivenessEntry>();
    const applyEntry = vi.fn((e: LivenessEntry) => { lastApplied.set(e.project, e); });
    const kickstartDaemon = vi.fn();
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    return {
      applyEntry,
      kickstartDaemon,
      stdoutLines,
      stderrLines,
      opts: {
        liveness: async () => overrides.records ?? [],
        isPidAlive: overrides.isPidAlive ?? (() => true),
        now: () => 1000,
        getEntry: () => overrides.entry,
        applyEntry,
        kickstartDaemon,
        reloadEntry: overrides.reloadEntry ?? ((project: string) => lastApplied.get(project)),
        stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
        stderr: { write: (s: string) => { stderrLines.push(s); } } as unknown as NodeJS.WritableStream,
      },
    };
  }

  it("re-adopts a live captain: writes the corrected entry and kickstarts the daemon", async () => {
    const { runHealCaptain } = await import("../heal.js");
    const { opts, applyEntry, kickstartDaemon, stdoutLines } = makeDeps({
      records: [{ role: "captain", project: "squadrant", pid: 12236, sessionId: "new-session", present: true }],
      entry: { project: "squadrant", role: "captain", pid: 5057, sessionId: "stale-session", startedAt: 1, lastState: "end", lastSeenAt: 1, pidAlive: false, source: "runtime" },
    });
    const code = await runHealCaptain(["squadrant"], opts);
    expect(code).toBe(0);
    expect(applyEntry).toHaveBeenCalledWith(expect.objectContaining({
      project: "squadrant", role: "captain", pid: 12236, sessionId: "new-session",
      lastState: "start", pidAlive: true, source: "runtime",
    }));
    expect(kickstartDaemon).toHaveBeenCalledOnce();
    expect(stdoutLines.join("")).toContain("squadrant");
  });

  it("is idempotent: a second run against an already-correct registry entry writes nothing and does not kickstart", async () => {
    const { runHealCaptain } = await import("../heal.js");
    const { opts, applyEntry, kickstartDaemon } = makeDeps({
      records: [{ role: "captain", project: "squadrant", pid: 12236, sessionId: "s1", present: true }],
      entry: { project: "squadrant", role: "captain", pid: 12236, sessionId: "s1", startedAt: 500, lastState: "start", lastSeenAt: 500, pidAlive: true, source: "runtime" },
    });
    const code = await runHealCaptain(["squadrant"], opts);
    expect(code).toBe(0);
    expect(applyEntry).not.toHaveBeenCalled();
    expect(kickstartDaemon).not.toHaveBeenCalled();
  });

  it("never invents an entry for a dead pid — skips the project, does not write or kickstart", async () => {
    const { runHealCaptain } = await import("../heal.js");
    const { opts, applyEntry, kickstartDaemon, stdoutLines } = makeDeps({
      records: [{ role: "captain", project: "squadrant", pid: 12236, sessionId: "s1", present: true }],
      isPidAlive: () => false,
    });
    const code = await runHealCaptain(["squadrant"], opts);
    expect(code).toBe(0);
    expect(applyEntry).not.toHaveBeenCalled();
    expect(kickstartDaemon).not.toHaveBeenCalled();
    expect(stdoutLines.join("")).toContain("no live captain");
  });

  it("handles a cmux store read failure gracefully — never throws, exits 1", async () => {
    const { runHealCaptain } = await import("../heal.js");
    const { opts, stderrLines } = makeDeps();
    opts.liveness = async () => { throw new Error("could not read cmux state dir"); };
    const code = await runHealCaptain(["squadrant"], opts);
    expect(code).toBe(1);
    expect(stderrLines.join("")).toContain("could not read cmux state dir");
  });

  it("heals multiple projects with --all", async () => {
    const { runHealCaptain } = await import("../heal.js");
    const { opts, applyEntry, kickstartDaemon } = makeDeps({
      records: [
        { role: "captain", project: "squadrant", pid: 12236, sessionId: "s1", present: true },
        { role: "captain", project: "helpa", pid: 4242, sessionId: "s2", present: true },
      ],
    });
    const code = await runHealCaptain(["squadrant", "helpa"], opts);
    expect(code).toBe(0);
    expect(applyEntry).toHaveBeenCalledTimes(2);
    expect(kickstartDaemon).toHaveBeenCalledOnce();
  });

  // ── #699 review: verify-after-kickstart race (the running daemon persists
  // its own in-memory map every tick and can clobber our write in the window
  // before the kill from `kickstart -k` actually lands) ──────────────────────

  it("detects a clobbered write after kickstart, retries once, and succeeds", async () => {
    const { runHealCaptain } = await import("../heal.js");
    const staleEntry: LivenessEntry = {
      project: "squadrant", role: "captain", pid: 5057, sessionId: "stale-session",
      startedAt: 1, lastState: "end", lastSeenAt: 1, pidAlive: false, source: "runtime",
    };
    let reloadCalls = 0;
    const { opts, applyEntry, kickstartDaemon, stdoutLines } = makeDeps({
      records: [{ role: "captain", project: "squadrant", pid: 12236, sessionId: "new-session", present: true }],
      entry: staleEntry,
      reloadEntry: () => {
        reloadCalls++;
        // First verify (right after the first kickstart) simulates the race:
        // the still-dying old daemon's own periodic persist clobbered our write.
        if (reloadCalls === 1) return staleEntry;
        return { project: "squadrant", role: "captain", pid: 12236, sessionId: "new-session", startedAt: 1000, lastState: "start", lastSeenAt: 1000, pidAlive: true, source: "runtime" };
      },
    });
    const code = await runHealCaptain(["squadrant"], opts);
    expect(code).toBe(0);
    expect(applyEntry).toHaveBeenCalledTimes(2); // initial write + one retry
    expect(kickstartDaemon).toHaveBeenCalledTimes(2);
    expect(stdoutLines.join("")).toContain("re-adopted");
  });

  it("reports failure honestly when the clobber survives the retry — never claims success for a change that didn't land", async () => {
    const { runHealCaptain } = await import("../heal.js");
    const staleEntry: LivenessEntry = {
      project: "squadrant", role: "captain", pid: 5057, sessionId: "stale-session",
      startedAt: 1, lastState: "end", lastSeenAt: 1, pidAlive: false, source: "runtime",
    };
    const { opts, applyEntry, kickstartDaemon, stderrLines, stdoutLines } = makeDeps({
      records: [{ role: "captain", project: "squadrant", pid: 12236, sessionId: "new-session", present: true }],
      entry: staleEntry,
      reloadEntry: () => staleEntry, // never lands, on either attempt
    });
    const code = await runHealCaptain(["squadrant"], opts);
    expect(code).toBe(1);
    expect(applyEntry).toHaveBeenCalledTimes(2); // initial + one retry, no more
    expect(kickstartDaemon).toHaveBeenCalledTimes(2);
    expect(stderrLines.join("")).toContain("squadrant");
    expect(stdoutLines.join("")).not.toContain("re-adopted");
  });

  it("in a multi-project heal, reports each project's outcome independently (one lands, one doesn't)", async () => {
    const { runHealCaptain } = await import("../heal.js");
    const { opts, stdoutLines, stderrLines } = makeDeps({
      records: [
        { role: "captain", project: "squadrant", pid: 12236, sessionId: "s1", present: true },
        { role: "captain", project: "helpa", pid: 4242, sessionId: "s2", present: true },
      ],
      reloadEntry: (project) => {
        if (project === "squadrant") {
          return { project, role: "captain", pid: 12236, sessionId: "s1", startedAt: 1000, lastState: "start", lastSeenAt: 1000, pidAlive: true, source: "runtime" };
        }
        return undefined; // helpa never lands, even after retry
      },
    });
    const code = await runHealCaptain(["squadrant", "helpa"], opts);
    expect(code).toBe(1);
    expect(stdoutLines.join("")).toContain("squadrant");
    expect(stderrLines.join("")).toContain("helpa");
  });
});

describe("runHealDaemon (integration, mocked I/O)", () => {
  it("calls ensureDaemon and exits 0", async () => {
    const ensure = vi.fn();
    const lines: string[] = [];
    const { runHealDaemon } = await import("../heal.js");
    const code = await runHealDaemon({
      ensureDaemon: ensure,
      stdout: { write: (s: string) => { lines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: () => false } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(0);
    expect(ensure).toHaveBeenCalledOnce();
    expect(lines.join("")).toContain("daemon");
  });

  it("exits 1 and prints error when ensureDaemon throws", async () => {
    const ensure = vi.fn().mockImplementation(() => { throw new Error("launchctl failed"); });
    const errLines: string[] = [];
    const { runHealDaemon } = await import("../heal.js");
    const code = await runHealDaemon({
      ensureDaemon: ensure,
      stdout: { write: () => false } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { errLines.push(s); } } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(1);
    expect(errLines.join("")).toContain("launchctl failed");
  });
});
