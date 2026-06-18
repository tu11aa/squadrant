import { describe, it, expect } from "vitest";
import {
  buildFreshness,
  assembleDaemonSnapshot,
  type DaemonSnapshotInputs,
} from "@cockpit/core";
import type { ComponentHealth } from "@cockpit/core";

// ── buildFreshness ────────────────────────────────────────────────────────────
describe("buildFreshness", () => {
  it("is fresh when the process started after the dist was built", () => {
    expect(buildFreshness(2000, 1000)).toBe("fresh");
  });
  it("is stale when the process started before the dist was built (running old code)", () => {
    expect(buildFreshness(1000, 2000)).toBe("stale");
  });
  it("treats an exactly-equal boundary as fresh", () => {
    expect(buildFreshness(1500, 1500)).toBe("fresh");
  });
});

// ── assembleDaemonSnapshot ────────────────────────────────────────────────────
const HEALTH: ComponentHealth[] = [
  { kind: "relay", project: "cockpit", ref: "relay", state: "alive", lastSeenMs: 900 },
  { kind: "captain", project: "cockpit", ref: "cockpit-captain", state: "alive", lastSeenMs: 900 },
];

function inputs(over: Partial<DaemonSnapshotInputs> = {}): DaemonSnapshotInputs {
  return {
    pid: 4821,
    processStartedAt: 1_000,
    version: "0.6.1",
    distBuiltAt: 500,
    lastSweepAt: 9_000,
    sweepCadenceMs: 30_000,
    log: { errorCount: 0, sizeBytes: 1234, windowMs: 3_600_000 },
    health: HEALTH,
    projects: [
      {
        project: "cockpit",
        mailbox: { maxSeq: 12, sizeBytes: 1300, oldestEntryAgeMs: 60_000, rotationCount: 0 },
        lastAckedSeq: 12,
        storeByState: { working: 3, blocked: 1 },
        corruptCount: 0,
      },
    ],
    results: { fileCount: 294, totalBytes: 18_000_000 },
    ...over,
  };
}

describe("assembleDaemonSnapshot", () => {
  const NOW = 10_000;

  it("assembles Tier 0 daemon self-health with uptime, freshness and sweep age", () => {
    const snap = assembleDaemonSnapshot(inputs(), NOW);
    expect(snap.tier0.pid).toBe(4821);
    expect(snap.tier0.uptimeMs).toBe(NOW - 1_000);
    expect(snap.tier0.version).toBe("0.6.1");
    expect(snap.tier0.build).toEqual({ state: "fresh", processStartedAt: 1_000, distBuiltAt: 500 });
    expect(snap.tier0.sweep).toEqual({ lastSweepAt: 9_000, ageMs: 1_000, cadenceMs: 30_000 });
    expect(snap.tier0.log).toEqual({ errorCount: 0, sizeBytes: 1234, windowMs: 3_600_000 });
  });

  it("flags a stale build in Tier 0", () => {
    const snap = assembleDaemonSnapshot(inputs({ processStartedAt: 100, distBuiltAt: 9_999 }), NOW);
    expect(snap.tier0.build.state).toBe("stale");
  });

  it("reports a null sweep age when the daemon has not yet swept", () => {
    const snap = assembleDaemonSnapshot(inputs({ lastSweepAt: null }), NOW);
    expect(snap.tier0.sweep.lastSweepAt).toBeNull();
    expect(snap.tier0.sweep.ageMs).toBeNull();
  });

  it("passes Tier 1 component health through verbatim", () => {
    const snap = assembleDaemonSnapshot(inputs(), NOW);
    expect(snap.tier1).toEqual(HEALTH);
  });

  it("assembles Tier 2 per-project mailbox, delivery lag and store counts", () => {
    const snap = assembleDaemonSnapshot(inputs(), NOW);
    const p = snap.tier2.projects[0];
    expect(p.project).toBe("cockpit");
    expect(p.mailbox).toEqual({ maxSeq: 12, sizeBytes: 1300, oldestEntryAgeMs: 60_000, rotationCount: 0 });
    expect(p.delivery).toEqual({ maxSeq: 12, lastAckedSeq: 12, behind: 0 });
    expect(p.store).toEqual({ byState: { working: 3, blocked: 1 }, corruptCount: 0 });
  });

  it("computes delivery lag as maxSeq minus lastAckedSeq", () => {
    const snap = assembleDaemonSnapshot(
      inputs({
        projects: [
          {
            project: "pact",
            mailbox: { maxSeq: 10, sizeBytes: 200, oldestEntryAgeMs: 3 * 86_400_000, rotationCount: 1 },
            lastAckedSeq: 6,
            storeByState: {},
            corruptCount: 2,
          },
        ],
      }),
      NOW,
    );
    expect(snap.tier2.projects[0].delivery.behind).toBe(4);
    expect(snap.tier2.projects[0].store.corruptCount).toBe(2);
  });

  it("never reports negative delivery lag (cursor ahead of max seq)", () => {
    const snap = assembleDaemonSnapshot(
      inputs({
        projects: [
          {
            project: "x",
            mailbox: { maxSeq: 5, sizeBytes: 0, oldestEntryAgeMs: 0, rotationCount: 0 },
            lastAckedSeq: 9,
            storeByState: {},
            corruptCount: 0,
          },
        ],
      }),
      NOW,
    );
    expect(snap.tier2.projects[0].delivery.behind).toBe(0);
  });

  it("passes global _results artifact stats through", () => {
    const snap = assembleDaemonSnapshot(inputs(), NOW);
    expect(snap.tier2.results).toEqual({ fileCount: 294, totalBytes: 18_000_000 });
  });
});
