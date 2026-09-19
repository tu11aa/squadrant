// #797 issues 3 & 4: `squadrant launch --fresh` must not resume the old
// opencode session, and every launch must refresh captain.json — including a
// relaunch onto an already-existing workspace, where nothing is respawned and
// the record must be refreshed from the LIVE server instead of a fresh port
// that was never bound.
//
// Exercises the REAL launchCommand action: launchOneWorkspace is mocked so the
// test can invoke the onCreated / onAlreadyExists callbacks launch.ts wires,
// and assert what they persist.

import { describe, it, expect, vi, beforeEach } from "vitest";

const buildAgentCmdMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => "opencode --port 61099"));
const launchOneWorkspaceMock = vi.hoisted(() => vi.fn());
const writeCaptainAddressMock = vi.hoisted(() => vi.fn());
const resolveAndPersistMock = vi.hoisted(() => vi.fn(async () => null));
const discoverMock = vi.hoisted(() => vi.fn());

const priorRecord = {
  agent: "opencode", port: 58525, sessionId: "ses_old",
  directory: "/tmp/demo", launchedAt: "2026-09-18T08:30:32.196Z",
};

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
  WorkspaceRegistry: vi.fn().mockImplementation(() => ({ forProject: vi.fn(() => ({})) })),
  isInsideCmux: vi.fn(() => true),
  cmuxLocal: vi.fn(() => ""),
  classifyStartupSurface: vi.fn(),
  classifyOpencodeStartupSurface: vi.fn(),
  getFreePort: vi.fn(async () => 71000),
}));

vi.mock("@squadrant/core", () => ({
  launchOneWorkspace: launchOneWorkspaceMock,
  loadSessions: vi.fn(() => ({ workspaces: {} })),
  CC_SOCKS_DIR: "/tmp/cc-socks",
  ensureSocksDir: vi.fn(),
  captainSocketPath: (project: string) => `/tmp/cc-socks/squadrant-captain-${project}.sock`,
  deliverStartupPrompt: vi.fn(),
  readCaptainAddress: vi.fn(() => priorRecord),
  writeCaptainAddress: writeCaptainAddressMock,
  realpathOrSelf: (p: string) => p,
  resolveAndPersistOpencodeCaptain: resolveAndPersistMock,
  discoverLiveOpencodeServer: discoverMock,
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
        demo: { captainName: "demo-captain", path: "/tmp/demo", spokeVault: "/tmp/demo/.spoke" },
      },
      defaults: {
        captainChannel: "on", permissions: {}, roles: { captain: { agent: "opencode", model: "gpt-5" } }, models: {},
      },
    }),
    resolveHome: (p: string) => p,
    ensureSpokeLayout: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn() };
});

// The opencode-captain launch now writes a per-captain allow-all config at the
// CLI edge. node:fs above mocks mkdirSync to a no-op, so stub the writer to keep
// this test off the real filesystem; readGlobalOpencodeModel is preserved.
vi.mock("../../lib/per-crew-settings.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/per-crew-settings.js")>("../../lib/per-crew-settings.js");
  return { ...actual, writePerCrewOpencodeConfig: vi.fn(() => "/tmp/fake-captain-opencode.json") };
});

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "abc1234"), // isOpencodeCaptainDir: git rev-parse succeeds
  execSync: vi.fn(() => ""),
  execFile: vi.fn(),
}));

async function runLaunch(flags: string[]): Promise<{ opts: any }> {
  const { launchCommand } = await import("../launch.js");
  let captured: any;
  launchOneWorkspaceMock.mockImplementation(async (opts: unknown) => { captured = opts; });
  await launchCommand.parseAsync(["node", "squadrant", "demo", ...flags]);
  return { opts: captured };
}

describe("opencode captain record refresh on launch (#797)", () => {
  beforeEach(() => {
    buildAgentCmdMock.mockClear();
    launchOneWorkspaceMock.mockClear();
    writeCaptainAddressMock.mockClear();
    resolveAndPersistMock.mockClear();
    discoverMock.mockReset();
  });

  it("--fresh does NOT resume: captainBoot.sessionId is undefined", async () => {
    const { opts } = await runLaunch(["--fresh"]);
    // agentCmdFactory receives the resolved forceFresh and builds captainBoot.
    opts.agentCmdFactory(true);
    const captainBoot = buildAgentCmdMock.mock.calls.at(-1)![10] as { port?: number; sessionId?: string };
    expect(captainBoot).toMatchObject({ port: 71000 });
    expect(captainBoot.sessionId).toBeUndefined();
  });

  it("a plain relaunch resumes the prior session id", async () => {
    const { opts } = await runLaunch([]);
    opts.agentCmdFactory(false);
    const captainBoot = buildAgentCmdMock.mock.calls.at(-1)![10] as { port?: number; sessionId?: string };
    expect(captainBoot).toMatchObject({ port: 71000, sessionId: "ses_old" });
  });

  it("onCreated persists the known resume session id immediately (no created-after gate)", async () => {
    const { opts } = await runLaunch([]);
    opts.agentCmdFactory(false); // resolve the resume id
    opts.onCreated("demo-captain");
    expect(resolveAndPersistMock).toHaveBeenCalledWith(expect.objectContaining({
      project: "demo", port: 71000, sessionId: "ses_old",
    }));
  });

  it("onAlreadyExists refreshes the record from the LIVE server, not the unbound fresh port", async () => {
    discoverMock.mockReturnValue({ pid: 26805, port: 61099, sessionId: "ses_old" });
    const { opts } = await runLaunch([]);
    opts.onAlreadyExists("demo-captain");
    expect(discoverMock).toHaveBeenCalledWith({ directory: "/tmp/demo", sessionId: "ses_old" });
    expect(writeCaptainAddressMock).toHaveBeenCalledWith(expect.any(String), "demo", expect.objectContaining({
      agent: "opencode", port: 61099, sessionId: "ses_old",
    }));
  });
});
