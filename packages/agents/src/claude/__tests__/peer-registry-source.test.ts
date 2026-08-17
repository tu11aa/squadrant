// Tests for ClaudePeerRegistrySource (#667 slice 1).
// Every dependency is injected: no real ~/.claude/sessions, no real timers,
// no real process.kill. A test that reads the real registry lies on CI.
import { describe, it, expect, vi } from "vitest";
import { ClaudePeerRegistrySource } from "../peer-registry-source.js";
import type { LifecycleSnapshot, LifecycleSourceDeps } from "@squadrant/core";

const NOW = 1_786_807_700_000;

function harness(opts: {
  files?: string[];
  bodies?: Record<string, object>;
  alive?: (pid: number) => boolean;
  resolve?: LifecycleSourceDeps["resolve"];
} = {}) {
  const reports: LifecycleSnapshot[] = [];
  const files = opts.files ?? ["51712.json"];
  const bodies = opts.bodies ?? {
    "51712.json": { pid: 51712, cwd: "/repo", entrypoint: "cli", status: "busy", statusUpdatedAt: NOW },
  };
  const deps: LifecycleSourceDeps = {
    resolve: opts.resolve ?? (() => ({ id: "task-1" })),
    report: (s) => reports.push(s),
  };
  const source = new ClaudePeerRegistrySource({
    readdir: () => files,
    readFile: (n) => JSON.stringify(bodies[n] ?? {}),
    isAlive: opts.alive ?? (() => true),
    now: () => NOW,
    pollMs: 0, // 0 disables the interval; tests drive poll() directly
  });
  return { source, deps, reports };
}

describe("ClaudePeerRegistrySource — port conformance", () => {
  it("has name 'claude-peer-registry'", () => {
    expect(harness().source.name).toBe("claude-peer-registry");
  });

  it("reports inactive health before start and active after", () => {
    const { source, deps } = harness();
    expect(source.health()).toEqual({ active: false, error: null });
    source.start(deps);
    expect(source.health()).toEqual({ active: true, error: null });
    source.stop();
    expect(source.health()).toEqual({ active: false, error: null });
  });

  it("start() is inert until a poll runs — registering must not do I/O", () => {
    const readdir = vi.fn(() => []);
    const source = new ClaudePeerRegistrySource({ readdir, pollMs: 0 });
    source.start({ resolve: () => undefined, report: () => {} });
    expect(readdir).not.toHaveBeenCalled();
  });
});

describe("ClaudePeerRegistrySource — polling", () => {
  it("reports a snapshot for a session that resolves to a crew", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.poll();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ taskId: "task-1", state: "running", origin: "agent", pid: 51712 });
  });

  it("skips sessions that resolve to no crew (operator's own windows)", () => {
    const { source, deps, reports } = harness({ resolve: () => undefined });
    source.start(deps);
    source.poll();
    expect(reports).toHaveLength(0);
  });

  it("passes pid, cwd and sessionId as correlation hints", () => {
    const resolve = vi.fn(() => ({ id: "task-1" }));
    const { source, deps } = harness({
      resolve,
      bodies: { "51712.json": { pid: 51712, cwd: "/repo", sessionId: "s-9", entrypoint: "cli", status: "idle" } },
    });
    source.start(deps);
    source.poll();
    expect(resolve).toHaveBeenCalledWith({ pid: 51712, cwd: "/repo", sessionId: "s-9" });
  });

  it("runs a dead pid through the guard: alive:false, state unknown", () => {
    const { source, deps, reports } = harness({ alive: () => false });
    source.start(deps);
    source.poll();
    expect(reports[0]).toMatchObject({ alive: false, state: "unknown" });
  });

  it("does not report an unchanged state twice", () => {
    // The registry is polled; without dedup every tick would re-report the same
    // state and flood the reducer with no new information.
    const { source, deps, reports } = harness();
    source.start(deps);
    source.poll();
    source.poll();
    expect(reports).toHaveLength(1);
  });

  it("reports again when the state changes", () => {
    const bodies: Record<string, object> = {
      "51712.json": { pid: 51712, cwd: "/repo", entrypoint: "cli", status: "busy", statusUpdatedAt: NOW },
    };
    const reports: LifecycleSnapshot[] = [];
    const source = new ClaudePeerRegistrySource({
      readdir: () => ["51712.json"],
      readFile: (n) => JSON.stringify(bodies[n]),
      isAlive: () => true,
      now: () => NOW,
      pollMs: 0,
    });
    source.start({ resolve: () => ({ id: "task-1" }), report: (s) => reports.push(s) });
    source.poll();
    bodies["51712.json"] = { pid: 51712, cwd: "/repo", entrypoint: "cli", status: "waiting",
                             waitingFor: "permission prompt", statusUpdatedAt: NOW + 10 };
    source.poll();
    expect(reports.map((r) => r.state)).toEqual(["running", "needsInput"]);
  });

  it("survives an unreadable registry directory and records the error in health", () => {
    const source = new ClaudePeerRegistrySource({
      readdir: () => { throw new Error("EACCES"); },
      pollMs: 0,
    });
    source.start({ resolve: () => undefined, report: () => {} });
    expect(() => source.poll()).not.toThrow();
    expect(source.health().error).toContain("EACCES");
  });

  it("clears a previous error once a poll succeeds", () => {
    let boom = true;
    const source = new ClaudePeerRegistrySource({
      readdir: () => { if (boom) throw new Error("EACCES"); return []; },
      pollMs: 0,
    });
    source.start({ resolve: () => undefined, report: () => {} });
    source.poll();
    expect(source.health().error).toContain("EACCES");
    boom = false;
    source.poll();
    expect(source.health().error).toBeNull();
  });
});

describe("ClaudePeerRegistrySource — snapshot() for the liveness floor", () => {
  it("returns undefined for an unknown crew", () => {
    const { source, deps } = harness();
    source.start(deps);
    expect(source.snapshot("nope")).toBeUndefined();
  });

  it("returns the last poll result downgraded to origin 'scan'", () => {
    // The port requires a poll result to be origin:"scan" and forbids it from
    // asserting needsInput. report() carries the trusted "agent" signal; this
    // read-back path is only the liveness floor and must not smuggle needsInput in.
    const { source, deps } = harness({
      bodies: { "51712.json": { pid: 51712, cwd: "/repo", entrypoint: "cli",
                                status: "waiting", waitingFor: "permission prompt" } },
    });
    source.start(deps);
    source.poll();
    const snap = source.snapshot("task-1");
    expect(snap?.origin).toBe("scan");
    expect(snap?.state).not.toBe("needsInput");
    expect(snap?.alive).toBe(true);
  });

  it("stops reporting and clears its cache on stop()", () => {
    const { source, deps } = harness();
    source.start(deps);
    source.poll();
    source.stop();
    expect(source.snapshot("task-1")).toBeUndefined();
  });
});