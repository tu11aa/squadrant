import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const saveConfigMock = vi.hoisted(() => vi.fn());
const getDefaultConfigMock = vi.hoisted(() => vi.fn(() => ({ hubVault: "", projects: {} })));
const loadConfigMock = vi.hoisted(() => vi.fn(() => ({ projects: {} })));
const ensureRuntimeSyncedMock = vi.hoisted(() => vi.fn());
const readUserLevelSourceMock = vi.hoisted(() => vi.fn(async () => ({ instructions: "", skills: [] })));

const emitMock = vi.hoisted(() => vi.fn(async (_src: unknown, dest: { path: string }) => ({
  written: true,
  path: dest.path,
  bytesWritten: 42,
})));

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
let originalStdin: PropertyDescriptor | undefined;

function captureOutput() {
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });
}

async function runInit(opts: { hub?: string; isTTY?: boolean } = {}) {
  const { initCommand } = await import("../init.js");
  // Override isTTY on process.stdin for this call
  Object.defineProperty(process.stdin, "isTTY", {
    value: opts.isTTY ?? false,
    configurable: true,
    writable: true,
  });
  await initCommand.parseAsync(["node", "squadrant", ...(opts.hub ? ["--hub", opts.hub] : [])]);
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

  it("does NOT call saveConfig in non-TTY mode (no side effects)", async () => {
    await runInit({ isTTY: false });
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(ensureRuntimeSyncedMock).not.toHaveBeenCalled();
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
    const wrote = settingsCalls.some(([p]: [string]) => String(p).endsWith("settings.json"));
    expect(wrote).toBe(false);
  });
});
