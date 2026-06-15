// src/control/__tests__/cockpitd-snapshot.test.ts
//
// Thin integration smoke for the read-only `snapshot` verb: boots a daemon
// against a temp state root, seeds a task, and asserts the assembled
// DaemonSnapshot shape (Tier 0/1/2). Pure assembly is covered in snapshot.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";
import type { DaemonSnapshot } from "../snapshot.js";

describe("cockpitd snapshot verb", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("returns a Tier 0/1/2 snapshot and leaves the health verb intact", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-snap-"));
    const sock = join(dir, "c.sock");
    const handle = startCockpitd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0 });
    stop = handle.stop;

    await sendRequest(sock, { kind: "seed", record: {
      id: "t1", project: "demo", provider: "claude", mode: "interactive",
      state: "working", task: "wire snapshot", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });

    const snap = await sendRequest(sock, { kind: "snapshot" }) as DaemonSnapshot;

    // Tier 0 — daemon self
    expect(snap.tier0.pid).toBe(process.pid);
    expect(snap.tier0.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof snap.tier0.version).toBe("string");
    expect(["fresh", "stale"]).toContain(snap.tier0.build.state);
    expect(snap.tier0.sweep.lastSweepAt).toBeNull(); // sweepMs:0 → never swept
    expect(typeof snap.tier0.log.sizeBytes).toBe("number");

    // Tier 1 — component health for the seeded project
    expect(snap.tier1.some((c) => c.project === "demo")).toBe(true);

    // Tier 2 — per-project data plane + global results
    const demo = snap.tier2.projects.find((p) => p.project === "demo");
    expect(demo).toBeDefined();
    expect(demo!.store.byState.working).toBe(1);
    expect(demo!.delivery.behind).toBeGreaterThanOrEqual(0);
    expect(typeof snap.tier2.results.fileCount).toBe("number");

    // The pre-existing health verb is unchanged.
    const health = await sendRequest(sock, { kind: "health", project: "demo" }) as unknown[];
    expect(Array.isArray(health)).toBe(true);
  });
});
