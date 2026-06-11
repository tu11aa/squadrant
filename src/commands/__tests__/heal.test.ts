// src/commands/__tests__/heal.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentHealth } from "../../control/liveness.js";

// ── pure helper (no I/O) ─────────────────────────────────────────────────────

import {
  buildHealStatus,
  healCmdFor,
  type HealStatusResult,
} from "../heal.js";

// ── fixture helpers ──────────────────────────────────────────────────────────

function makeRelay(state: ComponentHealth["state"], project = "brove"): ComponentHealth {
  return { kind: "relay", project, ref: "relay", state, lastSeenMs: state === "alive" ? Date.now() : null };
}
function makeDaemon(state: ComponentHealth["state"]): ComponentHealth {
  return { kind: "captain", project: "brove", ref: "brove-captain", state, lastSeenMs: null };
}
function makeCrew(state: ComponentHealth["state"]): ComponentHealth {
  return { kind: "crew", project: "brove", ref: "worker-1", state, lastSeenMs: null };
}

// ── healCmdFor ───────────────────────────────────────────────────────────────

describe("healCmdFor", () => {
  it("returns null for alive relay (already healthy)", () => {
    expect(healCmdFor(makeRelay("alive"))).toBeNull();
  });
  it("returns null for stale relay (recent heartbeat — let #240 supervisor handle it)", () => {
    expect(healCmdFor(makeRelay("stale"))).toBeNull();
  });
  it("returns heal relay cmd for gone relay", () => {
    const cmd = healCmdFor(makeRelay("gone", "brove"));
    expect(cmd).toBe("cockpit heal relay --project brove");
  });
  it("returns heal relay cmd for unknown relay (truly absent)", () => {
    const cmd = healCmdFor(makeRelay("unknown", "scaffold"));
    expect(cmd).toBe("cockpit heal relay --project scaffold");
  });
  it("returns null for non-relay components (no heal verb for captain/crew/command)", () => {
    expect(healCmdFor(makeDaemon("gone"))).toBeNull();
    expect(healCmdFor(makeCrew("gone"))).toBeNull();
  });
});

// ── buildHealStatus ──────────────────────────────────────────────────────────

describe("buildHealStatus", () => {
  it("healthy=true when all components are alive", () => {
    const components: ComponentHealth[] = [
      makeRelay("alive", "brove"),
      makeRelay("alive", "scaffold"),
    ];
    const result = buildHealStatus(components);
    expect(result.healthy).toBe(true);
    expect(result.components.every((c) => c.healCmd === null)).toBe(true);
  });

  it("healthy=false when any relay is gone", () => {
    const components: ComponentHealth[] = [
      makeRelay("gone", "brove"),
      makeRelay("alive", "scaffold"),
    ];
    const result = buildHealStatus(components);
    expect(result.healthy).toBe(false);
    const down = result.components.find((c) => c.project === "brove" && c.kind === "relay");
    expect(down?.healCmd).toBe("cockpit heal relay --project brove");
  });

  it("healthy=false when relay is unknown", () => {
    const result = buildHealStatus([makeRelay("unknown", "brove")]);
    expect(result.healthy).toBe(false);
    expect(result.components[0].healCmd).toBe("cockpit heal relay --project brove");
  });

  it("healthy=true when relay is stale (recent heartbeat — #240 supervisor covers it)", () => {
    const result = buildHealStatus([makeRelay("stale", "brove")]);
    expect(result.healthy).toBe(true);
    expect(result.components[0].healCmd).toBeNull();
  });

  it("returns all component fields in output", () => {
    const relay = makeRelay("gone", "brove");
    const result = buildHealStatus([relay]);
    const out = result.components[0];
    expect(out.kind).toBe("relay");
    expect(out.project).toBe("brove");
    expect(out.ref).toBe("relay");
    expect(out.state).toBe("gone");
    expect(typeof out.healCmd === "string" || out.healCmd === null).toBe(true);
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

    vi.doMock("../health-view.js", () => ({ queryHealth: queryHealthMock }));
  });

  it("exits 0 and prints healthy when all alive", async () => {
    queryHealthMock.mockResolvedValue([makeRelay("alive", "brove")]);
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

  it("exits 2 when a relay is gone, shows heal command", async () => {
    queryHealthMock.mockResolvedValue([makeRelay("gone", "brove")]);
    const { runHealStatus } = await import("../heal.js");
    const code = await runHealStatus({
      project: undefined,
      json: false,
      queryHealth: queryHealthMock,
      stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { stderrLines.push(s); } } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(2);
    const out = stdoutLines.join("");
    expect(out).toContain("cockpit heal relay --project brove");
  });

  it("--json outputs valid JSON with healthy=false and healCmd", async () => {
    queryHealthMock.mockResolvedValue([makeRelay("gone", "brove")]);
    const { runHealStatus } = await import("../heal.js");
    await runHealStatus({
      project: undefined,
      json: true,
      queryHealth: queryHealthMock,
      stdout: { write: (s: string) => { stdoutLines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { stderrLines.push(s); } } as unknown as NodeJS.WritableStream,
    });
    const parsed = JSON.parse(stdoutLines.join(""));
    expect(parsed.healthy).toBe(false);
    const comp = parsed.components.find((c: { kind: string; project: string }) => c.kind === "relay" && c.project === "brove");
    expect(comp.healCmd).toBe("cockpit heal relay --project brove");
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

// ── integration: runHealRelay (mocked I/O) ────────────────────────────────────

describe("runHealRelay (integration, mocked I/O)", () => {
  it("exits 0 with 'already healthy' when relay is alive (strict idempotency)", async () => {
    const queryHealth = vi.fn().mockResolvedValue([makeRelay("alive", "brove")]);
    const healer = vi.fn().mockResolvedValue(undefined);
    const lines: string[] = [];
    const { runHealRelay } = await import("../heal.js");
    const code = await runHealRelay({
      project: "brove",
      queryHealth,
      relayHealer: healer,
      stdout: { write: (s: string) => { lines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: () => false } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(0);
    expect(healer).not.toHaveBeenCalled();
    expect(lines.join("")).toContain("already healthy");
  });

  it("exits 0 with 'already healthy' when relay is stale (recent heartbeat — #240 supervisor covers it)", async () => {
    const queryHealth = vi.fn().mockResolvedValue([makeRelay("stale", "brove")]);
    const healer = vi.fn().mockResolvedValue(undefined);
    const lines: string[] = [];
    const { runHealRelay } = await import("../heal.js");
    const code = await runHealRelay({
      project: "brove",
      queryHealth,
      relayHealer: healer,
      stdout: { write: (s: string) => { lines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: () => false } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(0);
    expect(healer).not.toHaveBeenCalled();
    expect(lines.join("")).toContain("already healthy");
  });

  it("calls healer and exits 0 when relay is gone", async () => {
    const queryHealth = vi.fn().mockResolvedValue([makeRelay("gone", "brove")]);
    const healer = vi.fn().mockResolvedValue(undefined);
    const lines: string[] = [];
    const { runHealRelay } = await import("../heal.js");
    const code = await runHealRelay({
      project: "brove",
      queryHealth,
      relayHealer: healer,
      stdout: { write: (s: string) => { lines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: () => false } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(0);
    expect(healer).toHaveBeenCalledWith("brove");
    expect(lines.join("")).toContain("relay");
  });

  it("calls healer and exits 0 when relay is unknown (truly absent)", async () => {
    const queryHealth = vi.fn().mockResolvedValue([makeRelay("unknown", "brove")]);
    const healer = vi.fn().mockResolvedValue(undefined);
    const lines: string[] = [];
    const { runHealRelay } = await import("../heal.js");
    const code = await runHealRelay({
      project: "brove",
      queryHealth,
      relayHealer: healer,
      stdout: { write: (s: string) => { lines.push(s); } } as unknown as NodeJS.WritableStream,
      stderr: { write: () => false } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(0);
    expect(healer).toHaveBeenCalledWith("brove");
  });

  it("exits 1 when daemon unreachable", async () => {
    const queryHealth = vi.fn().mockResolvedValue(null);
    const healer = vi.fn();
    const errLines: string[] = [];
    const { runHealRelay } = await import("../heal.js");
    const code = await runHealRelay({
      project: "brove",
      queryHealth,
      relayHealer: healer,
      stdout: { write: () => false } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { errLines.push(s); } } as unknown as NodeJS.WritableStream,
    });
    expect(code).toBe(1);
    expect(healer).not.toHaveBeenCalled();
    expect(errLines.join("")).toContain("daemon unreachable");
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
