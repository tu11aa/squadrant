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

// ── healCmdFor ───────────────────────────────────────────────────────────────

describe("healCmdFor", () => {
  it("returns null for all components (no heal verb exists)", () => {
    expect(healCmdFor(makeCaptain("alive"))).toBeNull();
    expect(healCmdFor(makeCaptain("gone"))).toBeNull();
    expect(healCmdFor(makeCaptain("unknown"))).toBeNull();
    expect(healCmdFor(makeCrew("gone"))).toBeNull();
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

  it("healthy=true when captain is gone (no heal verb → healCmd null)", () => {
    const components: ComponentHealth[] = [
      makeCaptain("gone", "brove"),
      makeCaptain("alive", "scaffold"),
    ];
    const result = buildHealStatus(components);
    // healCmdFor always returns null now, so healthy=true even for gone
    expect(result.components.find((c) => c.project === "brove")?.healCmd).toBeNull();
  });

  it("returns all component fields in output", () => {
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
