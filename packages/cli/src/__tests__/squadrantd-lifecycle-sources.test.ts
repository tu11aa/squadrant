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
});
