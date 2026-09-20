// #772 follow-up: a router-backed claude CAPTAIN launch must switch onto the U7
// permission gate (permission_mode=default + SQUADRANT_GATE=on) and carry the
// router env in a per-spawn --settings file. Native captains stay byte-for-byte
// unchanged (no gate env, no --settings, no file).
//
// Exercises the REAL launchCommand action + REAL prepareCaptainRoute +
// REAL writeRouterSettings; only launchOneWorkspace and the daemon credentials
// fetch are stubbed so we can capture the command that would reach the runtime.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({
  home: "",
  roleAgent: "claude",
  roleBackend: undefined as "native" | "direct" | "proxy" | undefined,
  claudeEnv: undefined as Record<string, string> | undefined,
}));

// Redirect home so the real writeRouterSettings writes into a throwaway dir.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  const home = fs.mkdtempSync(path.join(actual.tmpdir(), "sq-router-cap-"));
  hoisted.home = home;
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

const buildAgentCmdMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const permissionMode = args[4] as string;
    const settingsPath = args[11] as string | undefined;
    return `claude --permission-mode ${permissionMode}${settingsPath ? ` --settings ${settingsPath}` : ""}`;
  }),
);
const launchOneWorkspaceMock = vi.hoisted(() => vi.fn());
const fetchRouterCredentialsMock = vi.hoisted(() =>
  vi.fn(async (_project: string, backend: string) => ({
    backend,
    baseUrl: "http://127.0.0.1:53421",
    token: "minted-tok",
  })),
);

const ROUTER = {
  kind: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go",
  apiKey: "sk-router",
  authHeader: "x-api-key",
  isAnthropic: false,
};

vi.mock("@squadrant/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@squadrant/agents")>();
  return { ...actual, buildAgentCmd: buildAgentCmdMock };
});

// launch.ts imports fetchRouterCredentials from ./crew.js — stub only that.
vi.mock("../crew.js", () => ({ fetchRouterCredentials: fetchRouterCredentialsMock }));

vi.mock("@squadrant/workspaces", () => ({
  RuntimeRegistry: vi.fn().mockImplementation(() => ({ forProject: vi.fn(() => ({})), global: vi.fn(() => ({})) })),
  createCmuxDriver: vi.fn(() => ({})),
  createObsidianDriver: vi.fn(() => ({})),
  WorkspaceRegistry: vi.fn().mockImplementation(() => ({ forProject: vi.fn(() => ({})) })),
  isInsideCmux: vi.fn(() => true),
  cmuxLocal: vi.fn(() => ""),
  classifyStartupSurface: vi.fn(),
  classifyOpencodeStartupSurface: vi.fn(),
  getFreePort: vi.fn(async () => 71000),
}));

// Partial mock: keep the REAL prepareCaptainRoute, stub the pieces launch drives.
vi.mock("@squadrant/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@squadrant/core")>();
  return {
    ...actual,
    launchOneWorkspace: launchOneWorkspaceMock,
    loadSessions: vi.fn(() => ({ workspaces: {} })),
    ensureSocksDir: vi.fn(),
    captainSocketPath: (project: string) => `/tmp/cc-socks/squadrant-captain-${project}.sock`,
    deliverStartupPrompt: vi.fn(),
    readCaptainAddress: vi.fn(() => null),
    writeCaptainAddress: vi.fn(),
    realpathOrSelf: (p: string) => p,
    resolveAndPersistOpencodeCaptain: vi.fn(async () => null),
    discoverLiveOpencodeServer: vi.fn(),
  };
});

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
        permissions: { captain: "auto" },
        roles: {
          captain: {
            agent: hoisted.roleAgent,
            model: "deepseek-v4.1-flash",
            ...(hoisted.roleBackend ? { backend: hoisted.roleBackend } : {}),
          },
        },
        models: {},
        router: ROUTER,
        ...(hoisted.claudeEnv ? { claudeEnv: hoisted.claudeEnv } : {}),
      },
    }),
    resolveHome: (p: string) => p,
    ensureSpokeLayout: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "abc1234"),
  execSync: vi.fn(() => ""),
  execFile: vi.fn(),
}));

const SETTINGS_PATH = (): string =>
  join(hoisted.home, ".config", "squadrant", "state", "demo", "captain", "router-settings.json");

async function runLaunchAndGetCmd(extraArgs: string[] = []): Promise<string> {
  const { launchCommand } = await import("../launch.js");
  let captured: { agentCmdFactory: (forceFresh: boolean) => string } | undefined;
  launchOneWorkspaceMock.mockImplementation(async (opts: unknown) => {
    captured = opts as typeof captured;
  });
  await launchCommand.parseAsync(["node", "squadrant", "demo", ...extraArgs]);
  return captured!.agentCmdFactory(false);
}

describe("router-backed captain launch (#772)", () => {
  beforeEach(() => {
    hoisted.roleAgent = "claude";
    hoisted.roleBackend = undefined;
    hoisted.claudeEnv = undefined;
    buildAgentCmdMock.mockClear();
    launchOneWorkspaceMock.mockClear();
    fetchRouterCredentialsMock.mockClear();
  });

  it("roles.captain.backend=proxy → permission_mode=default, SQUADRANT_GATE=on, and a --settings file", async () => {
    hoisted.roleBackend = "proxy";
    const cmd = await runLaunchAndGetCmd();

    expect(cmd).toContain("SQUADRANT_GATE=$'on'");
    expect(cmd).toContain("--permission-mode default");
    expect(cmd).toContain(`--settings ${SETTINGS_PATH()}`);
    expect(buildAgentCmdMock).toHaveBeenCalledWith(
      "claude",
      expect.anything(),
      "captain",
      expect.any(Boolean),
      "default",
      "deepseek-v4.1-flash",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      SETTINGS_PATH(),
    );
    expect(fetchRouterCredentialsMock).toHaveBeenCalledWith("demo", "proxy", expect.anything());

    const written = JSON.parse(readFileSync(SETTINGS_PATH(), "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:53421");
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("minted-tok");
    expect(written.env.ANTHROPIC_MODEL).toBe("deepseek-v4.1-flash");
  });

  it("carries non-ANTHROPIC claudeEnv keys into the written --settings env, keeping the shim URL (D1)", async () => {
    hoisted.roleBackend = "proxy";
    hoisted.claudeEnv = {
      ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    };
    await runLaunchAndGetCmd();

    const written = JSON.parse(readFileSync(SETTINGS_PATH(), "utf-8"));
    expect(written.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe("1");
    // Shim wins — claudeEnv's ANTHROPIC_* must not leak through.
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:53421");
  });

  it("--backend proxy overrides an unset role backend", async () => {
    const cmd = await runLaunchAndGetCmd(["--backend", "proxy"]);
    expect(cmd).toContain("SQUADRANT_GATE=$'on'");
    expect(buildAgentCmdMock).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      "default", expect.anything(), expect.anything(), expect.anything(),
      expect.anything(), undefined, undefined, SETTINGS_PATH(),
    );
  });

  it("native captain is byte-for-byte unchanged (no gate env, no --settings, no file)", async () => {
    hoisted.roleBackend = undefined;
    if (existsSync(SETTINGS_PATH())) {
      // ensure a clean baseline for this test
      const { unlinkSync } = await import("node:fs");
      unlinkSync(SETTINGS_PATH());
    }
    const cmd = await runLaunchAndGetCmd();

    expect(cmd).toBe("claude --permission-mode auto");
    expect(cmd).not.toContain("SQUADRANT_GATE");
    expect(cmd).not.toContain("--settings");
    expect(buildAgentCmdMock).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      "auto", expect.anything(), expect.anything(), expect.anything(),
      expect.anything(), undefined, undefined, undefined,
    );
    expect(fetchRouterCredentialsMock).not.toHaveBeenCalled();
    expect(existsSync(SETTINGS_PATH())).toBe(false);
  });
});
