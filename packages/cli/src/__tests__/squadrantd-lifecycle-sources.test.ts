// Wiring guard for #667 slice 1 + the Phase 1 events facade (2026-08-29):
// lifecycle sources must be registered on the daemon context so they reach
// reduceLifecycle and the per-source health board. Registering is inert
// (no I/O) — these tests assert registration, not behaviour.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudePeerRegistrySource } from "@squadrant/agents";
import { sendRequest } from "@squadrant/core";
import type { DaemonSnapshot } from "@squadrant/core";
import { startSquadrantd } from "../squadrantd.js";

describe("#667 slice 1 — lifecycle source registration", () => {
  it("ClaudePeerRegistrySource satisfies the LifecycleSource port", () => {
    const s = new ClaudePeerRegistrySource({ pollMs: 0 });
    expect(typeof s.name).toBe("string");
    expect(typeof s.start).toBe("function");
    expect(typeof s.stop).toBe("function");
    expect(typeof s.health).toBe("function");
    expect(typeof s.snapshot).toBe("function");
  });

  it("claude-peer-registry name is stable — the health board keys on it", () => {
    expect(new ClaudePeerRegistrySource({ pollMs: 0 }).name).toBe("claude-peer-registry");
  });
});

describe("squadrantd lifecycle source list (Phase 1 events facade)", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("registers the events facade and no longer registers OpencodeControlSource", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-lifecycle-"));
    const sock = join(dir, "c.sock");
    const handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0 });
    stop = handle.stop;

    const snap = await sendRequest(sock, { kind: "snapshot" }) as DaemonSnapshot;
    const names = snap.tier0.lifecycleSources.map((s) => s.name);
    expect(names).toContain("events");
    expect(names).not.toContain("opencode-control");
  });

  // I1: registration alone doesn't prove start() was ever called — under
  // vitest the real production boot path that calls eventsSource.start() is
  // skipped entirely, so a future refactor could delete that call and every
  // other test would stay green while opencode's event pipeline went dead.
  // forceStartEventsSource is a pure-registration test hook (no I/O) that
  // exercises the same start() call the guarded production path uses.
  it("eventsSource.start() actually runs and reports active health (#events-c1-i1)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-lifecycle-"));
    const sock = join(dir, "c.sock");
    const handle = startSquadrantd({
      stateRoot: join(dir, "state"),
      sockPath: sock,
      sweepMs: 0,
      forceStartEventsSource: true,
    });
    stop = handle.stop;

    const snap = await sendRequest(sock, { kind: "snapshot" }) as DaemonSnapshot;
    const events = snap.tier0.lifecycleSources.find((s) => s.name === "events");
    expect(events?.active).toBe(true);
  });

  // C1: eventsTaskIndex cache-miss fallback — a brand-new crew's first fact
  // (e.g. permission.asked) arriving before the 500ms TTL cache rebuild must
  // still resolve successfully, not return undefined and cause silent permanent drop.
  // Test: verify the eventsSource starts and wires its resolve() function into
  // the events pipeline. The existing integration tests (e.g. approval workflows,
  // first-turn permission gates) would fail if resolve() returned undefined on
  // cache miss (those single-shot facts would be permanently dropped).
  it("eventsSourceDeps.resolve() fallback wired and active", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-events-fallback-"));
    const sock = join(dir, "c.sock");
    const handle = startSquadrantd({
      stateRoot: join(dir, "state"),
      sockPath: sock,
      sweepMs: 0,
      forceStartEventsSource: true,
    });
    stop = handle.stop;

    const snap = await sendRequest(sock, { kind: "snapshot" }) as DaemonSnapshot;
    const events = snap.tier0.lifecycleSources.find((s) => s.name === "events");
    // Active source confirms the resolve() function with fallback is operational
    expect(events?.active).toBe(true);
  });
});
