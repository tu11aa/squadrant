import { describe, it, expect } from "vitest";
import {
  probeCmux,
  probeAgentClis,
  probeVaults,
  probeProjectPaths,
  probeSessions,
  runExternalProbes,
  type ProbeRunners,
} from "../probes.js";
import type { CockpitConfig } from "@cockpit/shared";

function cfg(over: Partial<CockpitConfig> = {}): CockpitConfig {
  return {
    commandName: "command",
    hubVault: "/vaults/hub",
    projects: {
      cockpit: { path: "/repos/cockpit", captainName: "cockpit-captain", spokeVault: "/vaults/cockpit", host: "local" },
    },
    defaults: {
      maxCrew: 4, worktreeDir: ".wt", teammateMode: "x",
      permissions: { command: "auto", captain: "auto" },
    },
    metrics: { enabled: false, path: "/m" },
    ...over,
  };
}

// A runner set where every external call succeeds. Tests override per-case.
function okRunners(over: Partial<ProbeRunners> = {}): ProbeRunners {
  return {
    probeCmuxBin: async () => true,
    probeOnPath: async () => true,
    pathExists: () => true,
    loadConfig: () => cfg(),
    loadSessionsHashes: () => ["hash-a"],
    ...over,
  };
}

describe("probeCmux", () => {
  it("is alive when the cmux binary responds", async () => {
    expect((await probeCmux(okRunners())).state).toBe("alive");
  });
  it("is gone when cmux is not reachable", async () => {
    expect((await probeCmux(okRunners({ probeCmuxBin: async () => false }))).state).toBe("gone");
  });
  it("is unknown (never throws) when the probe itself throws", async () => {
    const p = await probeCmux(okRunners({ probeCmuxBin: async () => { throw new Error("boom"); } }));
    expect(p.state).toBe("unknown");
  });
  it("is unknown when the probe hangs past the timeout", async () => {
    const p = await probeCmux(okRunners({ probeCmuxBin: () => new Promise(() => {}) }), 10);
    expect(p.state).toBe("unknown");
  });
});

describe("probeAgentClis", () => {
  it("maps each known CLI to alive/gone by PATH resolution", async () => {
    const probes = await probeAgentClis(okRunners({
      probeOnPath: async (cli) => cli === "claude" || cli === "codex",
    }));
    const byCli = Object.fromEntries(probes.map((p) => [p.cli, p.state]));
    expect(byCli).toEqual({ claude: "alive", codex: "alive", gemini: "gone", opencode: "gone" });
  });
  it("maps a thrown PATH lookup to unknown without failing the others", async () => {
    const probes = await probeAgentClis(okRunners({
      probeOnPath: async (cli) => { if (cli === "gemini") throw new Error("x"); return true; },
    }));
    const byCli = Object.fromEntries(probes.map((p) => [p.cli, p.state]));
    expect(byCli.gemini).toBe("unknown");
    expect(byCli.claude).toBe("alive");
  });
});

describe("probeVaults", () => {
  it("is alive when the hub dir and its .obsidian/ both exist, and spoke dir exists", () => {
    const v = probeVaults(okRunners(), cfg());
    expect(v.hub.state).toBe("alive");
    expect(v.spokes[0].project).toBe("cockpit");
    expect(v.spokes[0].state).toBe("alive");
  });
  it("hub is gone when the vault directory is missing", () => {
    const v = probeVaults(okRunners({ pathExists: () => false }), cfg());
    expect(v.hub.state).toBe("gone");
  });
  it("hub is gone when its dir exists but has no .obsidian/", () => {
    const v = probeVaults(okRunners({ pathExists: (p) => !p.endsWith(".obsidian") }), cfg());
    expect(v.hub.state).toBe("gone");
  });
  // Spokes live inside the hub vault — they correctly have no .obsidian/ of their own.
  it("spoke is alive when its directory exists even without .obsidian/", () => {
    const v = probeVaults(okRunners({ pathExists: (p) => !p.endsWith(".obsidian") }), cfg());
    expect(v.spokes[0].state).toBe("alive");
  });
  it("spoke is gone when its directory is missing", () => {
    // hub dir + hub .obsidian/ exist; spoke dir is missing
    const v = probeVaults(
      okRunners({ pathExists: (p) => p === cfg().hubVault || p.endsWith(".obsidian") }),
      cfg(),
    );
    expect(v.spokes[0].state).toBe("gone");
  });
});

describe("probeProjectPaths", () => {
  it("is alive when the project path resolves, gone otherwise", () => {
    const paths = probeProjectPaths(okRunners({ pathExists: (p) => p === "/repos/cockpit" }), cfg());
    expect(paths[0]).toMatchObject({ project: "cockpit", state: "alive" });
    const missing = probeProjectPaths(okRunners({ pathExists: () => false }), cfg());
    expect(missing[0].state).toBe("gone");
  });
});

describe("probeSessions", () => {
  it("is alive when a single template hash is recorded", () => {
    expect(probeSessions(okRunners()).state).toBe("alive");
  });
  it("is stale/caution (not fault) when multiple distinct template hashes are recorded", () => {
    const s = probeSessions(okRunners({ loadSessionsHashes: () => ["a", "b"] }));
    expect(s.state).toBe("stale"); // drift is expected across template versions — caution, not fault
    expect(s.detail).toMatch(/drift/);
  });
  it("is unknown when no sessions are recorded", () => {
    expect(probeSessions(okRunners({ loadSessionsHashes: () => [] })).state).toBe("unknown");
  });
  it("is unknown when sessions.json is unreadable", () => {
    expect(probeSessions(okRunners({ loadSessionsHashes: () => { throw new Error("bad"); } })).state).toBe("unknown");
  });
});

describe("runExternalProbes", () => {
  it("assembles all tiers and keeps going when config is unparseable", async () => {
    const probes = await runExternalProbes(okRunners({
      loadConfig: () => { throw new Error("bad json"); },
    }));
    expect(probes.cmux.state).toBe("alive");
    expect(probes.config.parseable.state).toBe("gone");
    expect(probes.vaults.spokes).toEqual([]);
    expect(probes.config.projectPaths).toEqual([]);
  });
  it("assembles a fully-healthy snapshot from healthy runners", async () => {
    const probes = await runExternalProbes(okRunners());
    expect(probes.cmux.state).toBe("alive");
    expect(probes.config.parseable.state).toBe("alive");
    expect(probes.vaults.hub.state).toBe("alive");
    expect(probes.agentClis).toHaveLength(4);
  });
});
