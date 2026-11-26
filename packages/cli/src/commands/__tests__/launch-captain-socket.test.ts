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

const buildAgentCmdMock = vi.hoisted(() => vi.fn(() => "claude"));
const captainEnv = vi.hoisted(() => ({ value: undefined as Record<string, string> | undefined }));
const captainAgent = vi.hoisted(() => ({ value: "claude" }));
const launchedCmds = vi.hoisted(() => [] as unknown[]);
const launchOneWorkspaceMock = vi.hoisted(() =>
  vi.fn(async (opts: { agentCmdFactory: (forceFresh: boolean) => unknown; initialPrompt?: string }) => {
    launchedCmds.push(opts.agentCmdFactory(false));
  }),
);

vi.mock("@squadrant/agents", () => ({
  createClaudeDriver: vi.fn(() => ({})),
  createCodexDriver: vi.fn(() => ({})),
  createGeminiDriver: vi.fn(() => ({})),
  createOpencodeDriver: vi.fn(() => ({})),
  CapabilityRegistry: vi.fn().mockImplementation(() => ({})),
  buildAgentCmd: buildAgentCmdMock,
  hasClaudeSession: vi.fn(() => true),
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
  // #786: launch.ts now imports these from the workspaces barrel.
  classifyOpencodeStartupSurface: vi.fn(),
  getFreePort: vi.fn(async () => 51220),
}));

vi.mock("@squadrant/core", () => ({
  launchOneWorkspace: launchOneWorkspaceMock,
  loadSessions: vi.fn(() => ({ workspaces: {} })),
  CC_SOCKS_DIR: "/tmp/cc-socks",
  ensureSocksDir: vi.fn(),
  // Real formula (matches packages/core/src/captain-channel.ts byte-for-byte)
  // — a mock that hardcoded a fixed string would defeat the point of this test.
  captainSocketPath: (project: string) => {
    if (!/^[A-Za-z0-9._-]+$/.test(project)) {
      throw new Error(`captain-channel: project name '${project}' is not a safe socket filename`);
    }
    return `/tmp/cc-socks/squadrant-captain-${project}.sock`;
  },
  deliverStartupPrompt: vi.fn(),
  shellQuote: (p: string) => "'" + p.replace(/'/g, "'\\''") + "'",
  // #786: launch.ts now imports these from @squadrant/core.
  readCaptainAddress: vi.fn(() => null),
  writeCaptainAddress: vi.fn(),
  realpathOrSelf: (p: string) => p,
  resolveAndPersistOpencodeCaptain: vi.fn(async () => null),
  // #772: native passthrough — these tests exercise socket/session wiring, not router routing.
  prepareCaptainRoute: vi.fn(async (o: { model?: string; configuredPermissionMode: string }) => ({
    backend: "native" as const, model: o.model, permissionMode: o.configuredPermissionMode, env: {},
  })),
  renderEnvAssignments: vi.fn(() => ""),
  roleEnvPrefix: vi.fn((e?: Record<string, string>) => (e ? "ROLE_ENV " : "")),
  decideOpencodeGateWrap: vi.fn(() => ({ wrap: false, warn: false, reason: "test-default" })),
  buildOpencodeGateRunCommand: vi.fn(() => "squadrant gate opencode-run --port 0"),
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
      defaults: { captainChannel: "on", permissions: {}, roles: captainEnv.value ? { captain: { agent: captainAgent.value, env: captainEnv.value } } : { captain: { agent: captainAgent.value } }, models: {} },
    }),
    resolveHome: (p: string) => p,
    ensureWorkspace: vi.fn(),
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
    launchedCmds.length = 0;
    captainEnv.value = undefined;
    captainAgent.value = "claude";
  });

  // #1102: typing the startup prompt into the pane raced Claude Code's paste window — the Enter
  // landed as a newline and the captain sat idle. Claude takes it as a launch-time positional
  // instead (as crews and side sessions do); other agents keep the pane delivery.
  it("hands a claude captain its startup prompt as the last launch arg and types nothing into the pane", async () => {
    const { launchCommand } = await import("../launch.js");
    await launchCommand.parseAsync(["node", "squadrant", "launch", "--all"]);
    expect(launchedCmds).toHaveLength(2);
    for (const c of launchedCmds) {
      expect(String(c)).toMatch(/^claude 'Run your startup checklist: use the squadrant:captain-startup skill, complete all startup steps, then report ready\.'$/);
    }
    expect(launchOneWorkspaceMock.mock.calls.every(([o]) => o.initialPrompt === undefined)).toBe(true);
  });

  it("keeps the pane-delivered startup prompt for a non-claude captain", async () => {
    captainAgent.value = "codex";
    const { launchCommand } = await import("../launch.js");
    await launchCommand.parseAsync(["node", "squadrant", "launch", "--all"]);
    expect(launchedCmds.every((c) => String(c) === "claude")).toBe(true);
    expect(launchOneWorkspaceMock.mock.calls.length).toBe(2);
    expect(launchOneWorkspaceMock.mock.calls.every(([o]) => o.initialPrompt?.startsWith("Run your startup checklist"))).toBe(true);
  });

  it("#1143: prefixes the captain launch command with roles.captain.env, and leaves it alone when absent", async () => {
    const { launchCommand } = await import("../launch.js");
    await launchCommand.parseAsync(["node", "squadrant", "launch", "--all"]);
    expect(launchedCmds.every((c) => !String(c).startsWith("ROLE_ENV "))).toBe(true);

    launchedCmds.length = 0;
    captainEnv.value = { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "0" };
    await launchCommand.parseAsync(["node", "squadrant", "launch", "--all"]);
    expect(launchedCmds).toHaveLength(2);
    expect(launchedCmds.every((c) => String(c).startsWith("ROLE_ENV "))).toBe(true);
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

  it("gives each captain a distinct #708 session name derived from its own project name", async () => {
    const { launchCommand } = await import("../launch.js");
    await launchCommand.parseAsync(["node", "squadrant", "launch", "--all"]);

    const sessionNames = buildAgentCmdMock.mock.calls.map((call) => (call as unknown[])[8]);
    expect(sessionNames).toEqual(["squadrant-captain-alpha", "squadrant-captain-beta"]);
    // Same failure class as #706: both collapsing onto one name, or "undefined".
    expect(new Set(sessionNames).size).toBe(2);
    expect(sessionNames.every((n) => !String(n).includes("undefined"))).toBe(true);
  });
});
