// An opencode CAPTAIN (unlike an opencode crew) was launched with a bare
// `opencode [--session X] [--port N]` command — buildAgentCmd's interactive
// branch ignores autoApprove — so it inherited only the global
// ~/.config/opencode/opencode.json (no `permission` block) and blocked on every
// tool approval. Crews already avoid this: crew-spawn writes a per-task
// allow-all config (writePerCrewOpencodeConfig) and prefixes the command with
// `OPENCODE_CONFIG=<path>`. This pins the same CLI-edge behaviour for captains.
//
// Exercises the REAL launchCommand action: launchOneWorkspace is mocked only so
// the test can invoke agentCmdFactory and capture the command string that would
// reach the workspace runtime.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({ home: "", roleAgent: "opencode" }));

// Redirect the home directory to a throwaway temp dir so the real
// writePerCrewOpencodeConfig (unchanged, no fs mocking) writes there instead of
// the developer's ~/.config/squadrant/state.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  const home = fs.mkdtempSync(path.join(actual.tmpdir(), "sq-cap-perms-"));
  hoisted.home = home;
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

const buildAgentCmdMock = vi.hoisted(() =>
  vi.fn((agentName: string) =>
    agentName === "opencode" ? "opencode --port 61099" : "claude --permission-mode auto",
  ),
);
const launchOneWorkspaceMock = vi.hoisted(() => vi.fn());

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
  readCaptainAddress: vi.fn(() => null),
  writeCaptainAddress: vi.fn(),
  realpathOrSelf: (p: string) => p,
  resolveAndPersistOpencodeCaptain: vi.fn(async () => null),
  discoverLiveOpencodeServer: vi.fn(),
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
        captainChannel: "on",
        permissions: {},
        roles: { captain: { agent: hoisted.roleAgent, model: "gpt-5" } },
        models: {},
      },
    }),
    resolveHome: (p: string) => p,
    ensureSpokeLayout: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "abc1234"), // isOpencodeCaptainDir: git rev-parse succeeds
  execSync: vi.fn(() => ""),
  execFile: vi.fn(),
}));

async function runLaunchAndGetCmd(): Promise<string> {
  const { launchCommand } = await import("../launch.js");
  let captured: { agentCmdFactory: (forceFresh: boolean) => string } | undefined;
  launchOneWorkspaceMock.mockImplementation(async (opts: unknown) => {
    captured = opts as typeof captured;
  });
  await launchCommand.parseAsync(["node", "squadrant", "demo"]);
  return captured!.agentCmdFactory(false);
}

describe("opencode captain permission auto-approval (CLI edge)", () => {
  beforeEach(() => {
    hoisted.roleAgent = "opencode";
    buildAgentCmdMock.mockClear();
    launchOneWorkspaceMock.mockClear();
  });

  it("prefixes OPENCODE_CONFIG pointing at an allow-all captain config", async () => {
    const cmd = await runLaunchAndGetCmd();
    const expectedPath = join(
      hoisted.home, ".config", "squadrant", "state", "demo", "captain", "opencode.json",
    );
    expect(cmd).toBe(`OPENCODE_CONFIG=${expectedPath} opencode --port 61099`);

    // The file the command points at must auto-approve bash/edit/read — the
    // exact permission prompt the captain used to block on.
    const written = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(written.permission.bash).toBe("allow");
    expect(written.permission.edit).toBe("allow");
    expect(written.permission.read).toBe("allow");
  });

  it("leaves a non-opencode (claude) captain command unchanged", async () => {
    hoisted.roleAgent = "claude";
    const cmd = await runLaunchAndGetCmd();
    expect(cmd).not.toContain("OPENCODE_CONFIG");
    expect(cmd).toBe("claude --permission-mode auto");
  });
});
