import { describe, it, expect } from "vitest";
import { mergeSnapshot } from "../snapshot-merge.js";
import type { DaemonSnapshot } from "@squadrant/core";
import type { ExternalProbes } from "../probes.js";

const external: ExternalProbes = {
  cmux: { state: "alive" },
  agentClis: [{ cli: "claude", state: "alive" }],
  vaults: { hub: { path: "/h", state: "alive" }, spokes: [] },
  config: { parseable: { state: "alive" }, projectPaths: [], sessions: { state: "alive" } },
};

const daemon: DaemonSnapshot = {
  tier0: {
    pid: 1, uptimeMs: 5, version: "0.6.1",
    build: { state: "fresh", processStartedAt: 1, distBuiltAt: 0 },
    sweep: { lastSweepAt: 1, ageMs: 4, cadenceMs: 30_000 },
    log: { errorCount: 0, sizeBytes: 0, windowMs: 3_600_000 },
  },
  tier1: [],
  tier2: { projects: [], results: { fileCount: 0, totalBytes: 0 } },
};

describe("mergeSnapshot", () => {
  it("combines a daemon snapshot with external probes and stamps generatedAt", () => {
    const full = mergeSnapshot(daemon, external, 12_345);
    expect(full.generatedAt).toBe(12_345);
    expect(full.daemon).toBe(daemon);
    expect(full.external).toBe(external);
  });

  it("keeps Tier 3/4 externals when the daemon is unreachable", () => {
    const full = mergeSnapshot("unreachable", external, 9);
    expect(full.daemon).toBe("unreachable");
    expect(full.external.cmux.state).toBe("alive");
    expect(full.external.agentClis).toHaveLength(1);
  });
});
