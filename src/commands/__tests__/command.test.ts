import { describe, it, expect, vi, beforeEach } from "vitest";

const newPane = vi.hoisted(() => vi.fn());
const sendToPane = vi.hoisted(() => vi.fn());
const buildCommand = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

vi.mock("../../runtimes/index.js", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe,
    list: vi.fn(),
    status: vi.fn(),
    spawn: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(),
    stop: vi.fn(),
    newPane,
    closePane: vi.fn(),
    sendToPane,
    readPaneScreen: vi.fn(),
  }),
  RuntimeRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    forProject() { return this.drivers.cmux; }
    global() { return this.drivers.cmux; }
    get(name: string) { return this.drivers[name]; }
    async probeAll() { return {}; }
  },
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../../config.js", () => ({
  loadConfig,
  resolveHome: (p: string) => p,
}));

const claudeDriver = vi.hoisted(() => ({
  name: "claude",
  templateSuffix: "claude",
  probe: vi.fn(),
  buildCommand,
}));

vi.mock("../../drivers/index.js", () => ({
  createClaudeDriver: () => claudeDriver,
  createCodexDriver: () => ({ ...claudeDriver, name: "codex", templateSuffix: "generic" }),
  createGeminiDriver: () => ({ ...claudeDriver, name: "gemini", templateSuffix: "generic" }),
  createAiderDriver: () => ({ ...claudeDriver, name: "aider", templateSuffix: "generic" }),
  CapabilityRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    get(name: string) { return this.drivers[name]; }
  },
}));

import { runCommandSpawn } from "../command.js";

describe("cockpit command", () => {
  beforeEach(() => {
    newPane.mockReset();
    sendToPane.mockReset();
    buildCommand.mockReset();
    loadConfig.mockReset();
    execSyncMock.mockReset();
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {},
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });
    execSyncMock.mockReturnValue("workspace:42 something");
    newPane.mockResolvedValue({ workspaceId: "workspace:42", surfaceId: "surface:9" });
    buildCommand.mockReturnValue('claude --append-system-prompt-file /tmp/command.md "do briefing"');
  });

  it("spawns a split pane in the current cmux workspace with the briefing prompt", async () => {
    const result = await runCommandSpawn({ task: "briefing" });

    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("current-workspace"),
      expect.anything(),
    );
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:42",
      direction: "right",
    }));
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({
      role: "command",
      prompt: expect.stringMatching(/briefing/i),
    }));
    expect(sendToPane).toHaveBeenCalledWith(
      { workspaceId: "workspace:42", surfaceId: "surface:9" },
      'claude --append-system-prompt-file /tmp/command.md "do briefing"',
    );
    expect(result).toEqual({ workspaceId: "workspace:42", surfaceId: "surface:9" });
  });

  it("uses learnings-review prompt when --task learnings-review", async () => {
    await runCommandSpawn({ task: "learnings-review" });

    const buildArgs = buildCommand.mock.calls[0][0];
    expect(buildArgs.prompt).toMatch(/learnings/i);
  });

  it("uses wiki-aggregate prompt when --task wiki-aggregate", async () => {
    await runCommandSpawn({ task: "wiki-aggregate" });

    const buildArgs = buildCommand.mock.calls[0][0];
    expect(buildArgs.prompt).toMatch(/wiki/i);
  });

  it("rejects unknown --task values", async () => {
    await expect(runCommandSpawn({ task: "bogus" as never }))
      .rejects.toThrow(/unknown task/i);
  });

  it("respects --agent override", async () => {
    await runCommandSpawn({ task: "briefing", agent: "codex" });

    expect(buildCommand).toHaveBeenCalled();
  });

  it("throws when current cmux workspace cannot be detected", async () => {
    execSyncMock.mockReturnValue("garbage");
    await expect(runCommandSpawn({ task: "briefing" }))
      .rejects.toThrow(/current cmux workspace/i);
  });
});
