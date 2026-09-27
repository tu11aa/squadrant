import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { saveConfigMock, getDefaultConfigMock, loadConfigMock, mockDefaultConfig } = vi.hoisted(() => {
  const make = () => ({
    commandName: "command",
    hubVault: "",
    projects: {},
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: { command: "auto", captain: "auto", crew: "auto" },
      roles: {
        command: { agent: "claude", model: "opus" },
        captain: { agent: "claude", model: "opus" },
        crew: { agent: "claude", model: "sonnet" },
        exploration: { agent: "claude", model: "haiku" },
        side: { agent: "claude", model: "opus" },
      },
      crewRouting: {
        rules: [
          { tier: "extreme", match: "redesign|architect|rewrite|from scratch|deep reasoning", agent: "claude", model: "opus" },
          { tier: "hard", match: "refactor|migrate|implement|feature|daemon|control-plane", agent: "claude", model: "sonnet" },
          { tier: "mobile", match: "mobile|ios|swift|android|kotlin|react native", agent: "codex" },
          { tier: "daily", match: "typo|rename|bump|docs|comment|lint|format", agent: "opencode" },
        ],
      },
    },
    metrics: { enabled: true, path: "/tmp/metrics.json" },
  });
  return {
    mockDefaultConfig: make,
    saveConfigMock: vi.fn(),
    getDefaultConfigMock: vi.fn(() => make()),
    loadConfigMock: vi.fn(() => make()),
  };
});

const ensureRuntimeSyncedMock = vi.hoisted(() => vi.fn());
const readUserLevelSourceMock = vi.hoisted(() => vi.fn(async () => ({ instructions: "", skills: [] })));
const detectClaudeAuthMock = vi.hoisted(() => vi.fn(() => ({ authenticated: true })));

const emitMock = vi.hoisted(() => vi.fn(async (_src: unknown, dest: { path: string }) => ({
  written: true,
  path: dest.path,
  bytesWritten: 42,
})));

const ensureGlobalOpencodeConfigMock = vi.hoisted(() =>
  vi.fn((): string | null => "/tmp/mock-opencode/opencode.json"),
);

vi.mock("../../lib/per-crew-settings.js", () => ({
  ensureGlobalOpencodeConfig: ensureGlobalOpencodeConfigMock,
  DEFAULT_GLOBAL_OPENCODE_CONFIG_PATH: "/tmp/mock-opencode/opencode.json",
}));

vi.mock("../../lib/claude-auth.js", () => ({
  detectClaudeAuth: detectClaudeAuthMock,
  parseClaudeAuthStatus: vi.fn(),
}));

vi.mock("@squadrant/shared", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/shared")>("@squadrant/shared");
  return {
    ...actual,
    saveConfig: saveConfigMock,
    getDefaultConfig: getDefaultConfigMock,
    loadConfig: loadConfigMock,
    ensureRuntimeSynced: ensureRuntimeSyncedMock,
    readUserLevelSource: readUserLevelSourceMock,
    DEFAULT_CONFIG_PATH: "/tmp/squadrant-test/config.json",
    resolveHome: (p: string) => p.replace("~", os.homedir()),
  };
});

vi.mock("@squadrant/workspaces", () => ({
  createObsidianDriver: vi.fn(() => ({ root: "/tmp" })),
  WorkspaceRegistry: class {
    get(_name: string) { return {}; }
  },
}));

vi.mock("@squadrant/agents", () => ({
  ProjectionRegistry: class {
    list() { return ["codex", "gemini", "opencode"]; }
    get(name: string) {
      return {
        name,
        destinations: (_scope: string) => [{ path: `/tmp/proj-${name}.md`, shared: true, format: "markdown" }],
        emit: emitMock,
      };
    }
  },
  createCursorEmitter: vi.fn(),
  createCodexEmitter: vi.fn(),
  createGeminiEmitter: vi.fn(),
  createOpencodeEmitter: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

let output: string[];
let errorOutput: string[];

function captureOutput() {
  output = [];
  errorOutput = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorOutput.push(args.map(String).join(" "));
  });
}

async function runInit(opts: {
  hub?: string;
  isTTY?: boolean;
  preset?: string;
} = {}) {
  const { initCommand } = await import("../init.js");
  // Override isTTY on process.stdin for this call
  Object.defineProperty(process.stdin, "isTTY", {
    value: opts.isTTY ?? false,
    configurable: true,
    writable: true,
  });
  const args = ["node", "squadrant"];
  if (opts.hub) args.push("--hub", opts.hub);
  if (opts.preset) args.push("--preset", opts.preset);
  await initCommand.parseAsync(args);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("init — non-TTY path", () => {
  beforeEach(() => {
    captureOutput();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("prints checklist and returns without blocking when stdin is not a TTY", async () => {
    await runInit({ isTTY: false });

    const text = output.join("\n");
    expect(text).toContain("1/5");
    expect(text).toContain("2/5");
    expect(text).toContain("3/5");
    expect(text).toContain("4/5");
    expect(text).toContain("5/5");
    expect(text).toContain("squadrant init");
    expect(text).toContain("/plugin marketplace add superpowers");
    expect(text).toContain("squadrant projects add");
    expect(text).toContain("squadrant telegram setup");
    expect(text).toContain("squadrant launch");
  });

  it("prints opencode CLI install + global config guidance (#140)", async () => {
    await runInit({ isTTY: false });

    const text = output.join("\n");
    expect(text).toContain("opencode");
    expect(text).toContain("npm install -g opencode-ai");
    expect(text).toContain("/tmp/mock-opencode/opencode.json");
  });

  it("does NOT call saveConfig or provision opencode config in non-TTY mode (no side effects)", async () => {
    await runInit({ isTTY: false });
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(ensureRuntimeSyncedMock).not.toHaveBeenCalled();
    expect(ensureGlobalOpencodeConfigMock).not.toHaveBeenCalled();
  });

  it("does not hang when stdin is /dev/null equivalent (isTTY=false)", async () => {
    // This verifies TTY-safety: the command should complete without awaiting any prompt.
    const settled = await Promise.race([
      runInit({ isTTY: false }).then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ]);
    expect(settled).toBe("done");
  });
});

describe("init — re-run-safe (TTY mode)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-init-test-"));
    captureOutput();
    vi.clearAllMocks();

    // Mock readline so promptLine() doesn't block
    vi.mock("node:readline", () => ({
      default: {
        createInterface: () => ({
          question: (_q: string, cb: (a: string) => void) => cb(""),
          close: vi.fn(),
        }),
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("skips config creation when config already exists", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      if (String(p) === "/tmp/squadrant-test/config.json") return true;
      return false;
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
      if (String(p) === "/tmp/squadrant-test/config.json") {
        return JSON.stringify({ workspace: "obsidian", projects: {} });
      }
      return "{}";
    });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);

    await runInit({ isTTY: true, hub: tmpDir });

    const text = output.join("\n");
    expect(text).toContain("Config already exists");
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("creates config when it does not exist", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation(() => false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => "{}");
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);

    await runInit({ isTTY: true, hub: tmpDir });

    expect(saveConfigMock).toHaveBeenCalledOnce();
  });

  it("skips hub scaffold when vault dir already exists", async () => {
    const hubPath = tmpDir;
    // Hub exists but config does not
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p) === hubPath;
    });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => "{}");
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);

    await runInit({ isTTY: true, hub: hubPath });

    const text = output.join("\n");
    expect(text).toContain("Hub vault already exists");
  });

  it("emits projections for non-Claude agents in step 2/5", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation(() => false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => "{}");
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);

    await runInit({ isTTY: true, hub: tmpDir });

    // emitMock should have been called for codex, gemini, opencode
    expect(emitMock).toHaveBeenCalledTimes(3);
    const text = output.join("\n");
    expect(text).toMatch(/codex.*proj-codex|proj-codex.*codex/i);
  });

  it("provisions a default global opencode config when absent (#141)", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation(() => false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => "{}");
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);
    ensureGlobalOpencodeConfigMock.mockReturnValueOnce("/tmp/mock-opencode/opencode.json");

    await runInit({ isTTY: true, hub: tmpDir });

    expect(ensureGlobalOpencodeConfigMock).toHaveBeenCalledOnce();
    const text = output.join("\n");
    expect(text).toContain("Default model config created at /tmp/mock-opencode/opencode.json");
  });

  it("does NOT overwrite an existing global opencode config", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation(() => false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => "{}");
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);
    ensureGlobalOpencodeConfigMock.mockReturnValueOnce(null);

    await runInit({ isTTY: true, hub: tmpDir });

    expect(ensureGlobalOpencodeConfigMock).toHaveBeenCalledOnce();
    const text = output.join("\n");
    expect(text).toContain("/tmp/mock-opencode/opencode.json already exists (unchanged)");
  });

  it("skips agent-teams write when already enabled", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation(() => false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);
    vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
      if (String(p).endsWith("settings.json")) {
        return JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" } });
      }
      return "{}";
    });
    // Make settingsPath.existsSync return true
    vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p).endsWith("settings.json"));

    await runInit({ isTTY: true, hub: tmpDir });

    const text = output.join("\n");
    expect(text).toContain("Agent Teams already enabled");
    // writeFileSync should not have been called for settings.json
    const settingsCalls = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock?.calls ?? [];
    const wrote = settingsCalls.some((args: unknown[]) => String(args[0]).endsWith("settings.json"));
    expect(wrote).toBe(false);
  });
});

describe("init — provider preset (#826)", () => {
  let tmpDir: string;

  function freshFs() {
    vi.spyOn(fs, "existsSync").mockImplementation(() => false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => "{}");
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);
  }

  function existingFs(config: unknown) {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => String(p) === "/tmp/squadrant-test/config.json",
    );
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation((p) =>
      String(p) === "/tmp/squadrant-test/config.json" ? JSON.stringify(config) : "{}",
    );
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);
  }

  function savedConfig(): Record<string, any> {
    expect(saveConfigMock).toHaveBeenCalled();
    return saveConfigMock.mock.calls[saveConfigMock.mock.calls.length - 1][0] as Record<string, any>;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-init-preset-"));
    captureOutput();
    vi.clearAllMocks();
    detectClaudeAuthMock.mockReturnValue({ authenticated: true });
    vi.mock("node:readline", () => ({
      default: {
        createInterface: () => ({
          question: (_q: string, cb: (a: string) => void) => cb(""),
          close: vi.fn(),
        }),
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("--preset a on a fresh config writes the claude/auto default", async () => {
    freshFs();
    await runInit({ isTTY: false, preset: "a", hub: tmpDir });

    const cfg = savedConfig();
    expect(cfg.defaults.roles.crew).toEqual({ agent: "claude", model: "sonnet" });
    expect(cfg.defaults.permissions.captain).toBe("auto");
  });

  it("--preset b applies opencode roles non-interactively", async () => {
    freshFs();
    await runInit({ isTTY: false, preset: "b", hub: tmpDir });

    const cfg = savedConfig();
    expect(cfg.defaults.roles.crew).toEqual({
      agent: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
    });
    // Routing rules must resolve to the same agent family as roles.
    expect(cfg.defaults.crewRouting.rules.some((r: any) => r.agent === "claude")).toBe(false);
    expect(cfg.defaults.crewRouting.rules.find((r: any) => r.tier === "hard").agent).toBe("opencode");
  });

  it("--preset c applies codex roles (codex moved from d to c)", async () => {
    freshFs();
    await runInit({ isTTY: false, preset: "c", hub: tmpDir });

    const cfg = savedConfig();
    expect(cfg.defaults.roles.crew).toEqual({ agent: "codex" });
    expect(cfg.defaults.crewRouting.rules.every((r: any) => r.agent === "codex")).toBe(true);
  });

  it("--preset d is accepted as a deprecated alias for codex's new id c", async () => {
    freshFs();
    await runInit({ isTTY: false, preset: "d", hub: tmpDir });
    const cfg = savedConfig();
    expect(cfg.defaults.roles.crew).toEqual({ agent: "codex" });
  });

  it("rejects an invalid --preset without writing config", async () => {
    freshFs();
    await runInit({ isTTY: false, preset: "z", hub: tmpDir });
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(errorOutput.join("\n")).toMatch(/unknown.*preset/i);
  });

  it("re-running init on an existing config does not clobber roles/permissions", async () => {
    const existing = mockDefaultConfig();
    existing.defaults.roles = { crew: { agent: "opencode", model: "custom" } } as never;
    existing.defaults.permissions = { command: "auto", captain: "default", crew: "default" } as never;
    loadConfigMock.mockReturnValue(existing as never);
    existingFs(existing);

    await runInit({ isTTY: true, hub: tmpDir });

    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("--preset b explicitly overrides an existing preset-A config", async () => {
    const existing = mockDefaultConfig();
    loadConfigMock.mockReturnValue(existing as never);
    existingFs(existing);

    await runInit({ isTTY: false, preset: "b", hub: tmpDir });

    const cfg = savedConfig();
    expect(cfg.defaults.roles.crew.agent).toBe("opencode");
  });

  it("asks one provider question interactively and applies the default (A)", async () => {
    freshFs();
    await runInit({ isTTY: true, hub: tmpDir });

    const cfg = savedConfig();
    expect(cfg.defaults.roles.crew).toEqual({ agent: "claude", model: "sonnet" });
    expect(output.join("\n")).toContain("Choose your provider");
  });

  it("warns when no Anthropic credential is detected for preset A", async () => {
    freshFs();
    detectClaudeAuthMock.mockReturnValue({ authenticated: false, reason: "unavailable" } as never);
    await runInit({ isTTY: true, hub: tmpDir });

    const text = output.join("\n");
    expect(text).toMatch(/no anthropic credential/i);
    // Still applies the chosen default rather than aborting.
    expect(savedConfig().defaults.roles.crew.agent).toBe("claude");
  });

  it("prints exactly what will change before writing", async () => {
    freshFs();
    await runInit({ isTTY: false, preset: "b", hub: tmpDir });
    const text = output.join("\n");
    expect(text).toContain("defaults.roles");
  });
});
