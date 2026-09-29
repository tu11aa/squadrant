// #828 P6-C phase 2: when the permission gate is ON (mode=on, engine=auto-gate,
// credential present), an opencode CAPTAIN launches through the auto-gate
// opencode adapter (`squadrant gate opencode-run --port <n>`) instead of a bare
// `opencode …` command — reusing the SAME port squadrant already allocated for
// its own SSE bridge. Gate off/on-but-unusable must leave the command exactly
// as launch-opencode-captain-perms.test.ts already pins.
//
// Exercises the REAL launchCommand action: launchOneWorkspace is mocked only so
// the test can invoke agentCmdFactory and capture the command string that would
// reach the workspace runtime. decideOpencodeGateWrap/buildOpencodeGateRunCommand
// are mocked at the @squadrant/core boundary — their own logic is unit-tested in
// packages/core/src/__tests__/auto-gate.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({
  home: "",
  wrap: { wrap: false, warn: false, reason: "test-default" } as { wrap: boolean; warn: boolean; reason: string },
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  const home = fs.mkdtempSync(path.join(actual.tmpdir(), "sq-cap-gate-"));
  hoisted.home = home;
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

const buildAgentCmdMock = vi.hoisted(() => vi.fn(() => "opencode --port 61099"));
const launchOneWorkspaceMock = vi.hoisted(() => vi.fn());
const decideOpencodeGateWrapMock = vi.hoisted(() => vi.fn(() => hoisted.wrap));
const buildOpencodeGateRunCommandMock = vi.hoisted(() =>
  vi.fn((o: { port: number; sessionId?: string }) =>
    o.sessionId ? `squadrant gate opencode-run --port ${o.port} --session ${o.sessionId}` : `squadrant gate opencode-run --port ${o.port}`,
  ),
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
  prepareCaptainRoute: vi.fn(async (o: { model?: string; configuredPermissionMode: string }) => ({
    backend: "native" as const, model: o.model, permissionMode: o.configuredPermissionMode, env: {},
  })),
  renderEnvAssignments: vi.fn(() => ""),
  decideOpencodeGateWrap: decideOpencodeGateWrapMock,
  buildOpencodeGateRunCommand: buildOpencodeGateRunCommandMock,
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
        roles: { captain: { agent: "opencode", model: "gpt-5" } },
        models: {},
        gate: { mode: "on", engine: "auto-gate" },
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

describe("opencode captain gate wiring (#828 P6-C phase 2)", () => {
  beforeEach(() => {
    buildAgentCmdMock.mockClear();
    launchOneWorkspaceMock.mockClear();
    decideOpencodeGateWrapMock.mockClear();
    buildOpencodeGateRunCommandMock.mockClear();
    hoisted.wrap = { wrap: false, warn: false, reason: "test-default" };
  });

  it("routes through the auto-gate opencode adapter on squadrant's own port when the gate wraps", async () => {
    hoisted.wrap = { wrap: true, warn: false, reason: "gate on, engine=auto-gate, credential present" };
    const cmd = await runLaunchAndGetCmd();
    expect(buildOpencodeGateRunCommandMock).toHaveBeenCalledWith({ port: 71000, sessionId: undefined });
    expect(cmd).toContain("squadrant gate opencode-run --port 71000");
    expect(cmd).not.toContain("opencode --port 61099");
  });

  it("#828: wrapped captain's opencode config asks for bash/edit so the watcher decides", async () => {
    hoisted.wrap = { wrap: true, warn: false, reason: "gate on, engine=auto-gate, credential present" };
    await runLaunchAndGetCmd();
    const cfg = JSON.parse(readFileSync(join(hoisted.home, ".config", "squadrant", "state", "demo", "captain", "opencode.json"), "utf-8"));
    expect(cfg.permission.bash).toBe("ask");
    expect(cfg.permission.edit).toBe("ask");
    expect(cfg.permission.read).toBe("allow");
  });

  it("#828: unwrapped captain's opencode config stays allow-all", async () => {
    await runLaunchAndGetCmd();
    const cfg = JSON.parse(readFileSync(join(hoisted.home, ".config", "squadrant", "state", "demo", "captain", "opencode.json"), "utf-8"));
    expect(cfg.permission.bash).toBe("allow");
    expect(cfg.permission.edit).toBe("allow");
  });

  it("falls back to the plain command, unchanged, when the gate declines to wrap", async () => {
    hoisted.wrap = { wrap: false, warn: false, reason: "gate mode='off' engine='auto-gate'" };
    const cmd = await runLaunchAndGetCmd();
    expect(buildOpencodeGateRunCommandMock).not.toHaveBeenCalled();
    expect(cmd).toContain("opencode --port 61099");
    expect(cmd).not.toContain("gate opencode-run");
  });

  it("safety fallback: gate on but no credential — direct launch, unchanged command", async () => {
    hoisted.wrap = { wrap: false, warn: true, reason: "auto-gate credential not present (TYPESAFE_API_KEY / ~/.auto-gate-key)" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cmd = await runLaunchAndGetCmd();
    expect(cmd).toContain("opencode --port 61099");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("auto-gate credential not present"));
    errSpy.mockRestore();
  });
});
