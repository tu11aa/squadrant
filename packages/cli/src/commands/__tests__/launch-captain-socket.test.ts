// src/commands/__tests__/launch-captain-socket.test.ts
//
// #706 regression: the captain socket path passed to buildAgentCmd must be
// derived from launchOne's `projectName` parameter, not the command-level
// `project` positional captured by the outer .action() closure. `project` is
// only ever set on the single-project launch path — on `--all` and the
// interactive-parallel path it is undefined, so every captain that command
// launches collapsed onto the same
// /tmp/cc-socks/squadrant-captain-undefined.sock (first bind wins).
//
// This exercises the REAL launchCommand action (not just the pure
// resolveCaptainSocketPath helper in launch.test.ts): if launch.ts ever
// reintroduces `${project}` at the buildAgentCmd call site, the two captains
// spawned by --all below would receive the identical socket path and this
// test fails, even though a unit test of the helper alone would not catch it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const buildAgentCmdMock = vi.hoisted(() => vi.fn(() => ({ agentName: "claude", cmd: ["claude"], env: {} })));
const launchOneWorkspaceMock = vi.hoisted(() =>
  vi.fn(async (opts: { agentCmdFactory: (forceFresh: boolean) => unknown }) => {
    opts.agentCmdFactory(false);
  }),
);

vi.mock("@squadrant/agents", () => ({
  createClaudeDriver: vi.fn(() => ({})),
  createCodexDriver: vi.fn(() => ({})),
  createGeminiDriver: vi.fn(() => ({})),
  createOpencodeDriver: vi.fn(() => ({})),
  CapabilityRegistry: vi.fn().mockImplementation(() => ({})),
  buildAgentCmd: buildAgentCmdMock,
}));

vi.mock("@squadrant/workspaces", () => ({
  RuntimeRegistry: vi.fn().mockImplementation(() => ({
    forProject: vi.fn(() => ({})),
    global: vi.fn(() => ({})),
  })),
  createCmuxDriver: vi.fn(() => ({})),
  createObsidianDriver: vi.fn(() => ({})),
  WorkspaceRegistry: vi.fn().mockImplementation(() => ({
    forProject: vi.fn(() => ({})),
  })),
  isInsideCmux: vi.fn(() => true),
  cmuxLocal: vi.fn(() => ""),
  classifyStartupSurface: vi.fn(),
}));

vi.mock("@squadrant/core", () => ({
  launchOneWorkspace: launchOneWorkspaceMock,
  loadSessions: vi.fn(() => ({ workspaces: {} })),
  CC_SOCKS_DIR: "/tmp/cc-socks",
  // Real formula (matches packages/core/src/captain-channel.ts byte-for-byte)
  // — a mock that hardcoded a fixed string would defeat the point of this test.
  captainSocketPath: (project: string) => {
    if (!/^[A-Za-z0-9._-]+$/.test(project)) {
      throw new Error(`captain-channel: project name '${project}' is not a safe socket filename`);
    }
    return `/tmp/cc-socks/squadrant-captain-${project}.sock`;
  },
  deliverStartupPrompt: vi.fn(),
}));

vi.mock("@squadrant/shared", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/shared")>("@squadrant/shared");
  return {
    ...actual,
    resolveCmuxBin: () => "/Applications/cmux.app/Contents/Resources/bin/cmux",
    resetCmuxBinCache: vi.fn(),
    loadConfig: () => ({
      hubVault: "/tmp/squadrant-hub",
      projects: {
        alpha: { captainName: "alpha-captain", path: "/tmp/alpha", spokeVault: "/tmp/alpha/.spoke" },
        beta: { captainName: "beta-captain", path: "/tmp/beta", spokeVault: "/tmp/beta/.spoke" },
      },
      defaults: { captainChannel: "on", permissions: {}, roles: {}, models: {} },
    }),
    resolveHome: (p: string) => p,
    ensureSpokeLayout: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn() };
});

describe("launchCommand --all (#706 per-project captain socket wiring)", () => {
  beforeEach(() => {
    buildAgentCmdMock.mockClear();
    launchOneWorkspaceMock.mockClear();
  });

  it("gives each captain a distinct socket path derived from its own project name", async () => {
    const { launchCommand } = await import("../launch.js");
    await launchCommand.parseAsync(["node", "squadrant", "launch", "--all"]);

    expect(buildAgentCmdMock).toHaveBeenCalledTimes(2);
    const socketPaths = buildAgentCmdMock.mock.calls.map((call) => (call as unknown[])[7]);

    expect(socketPaths).toEqual([
      "/tmp/cc-socks/squadrant-captain-alpha.sock",
      "/tmp/cc-socks/squadrant-captain-beta.sock",
    ]);
    // The #706 failure mode: both captains collapsing onto the same path.
    expect(new Set(socketPaths).size).toBe(2);
    expect(socketPaths.every((p) => !String(p).includes("undefined"))).toBe(true);
  });
});
