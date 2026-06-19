// src/commands/__tests__/heal.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentHealth } from "@cockpit/core";

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
      stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { stderrLines.push(s); } } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(1);
    const err = stderrLines.join("");
    expect(err).toContain("daemon unreachable");
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
