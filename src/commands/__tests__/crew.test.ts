import { describe, it, expect, vi, beforeEach } from "vitest";

const newPane = vi.hoisted(() => vi.fn());
const sendToPane = vi.hoisted(() => vi.fn());
const status = vi.hoisted(() => vi.fn());
const buildCommand = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => vi.fn());

vi.mock("../../runtimes/index.js", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe,
    list: vi.fn(),
    status,
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

import { runCrewSpawn } from "../crew.js";

describe("cockpit crew spawn", () => {
  beforeEach(() => {
    newPane.mockReset();
    sendToPane.mockReset();
    status.mockReset();
    buildCommand.mockReset();
    loadConfig.mockReset();
  });

  it("opens a split pane in the captain workspace and sends the agent command", async () => {
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {
        brove: { path: "/tmp/brove", captainName: "brove-captain", spokeVault: "~/hub/spokes/brove", host: "local" },
      },
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue('claude --append-system-prompt-file /tmp/crew.md "do the thing"');

    const result = await runCrewSpawn({ project: "brove", task: "do the thing" });

    expect(status).toHaveBeenCalledWith("brove-captain");
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:5",
      direction: "right",
    }));
    expect(sendToPane).toHaveBeenCalledWith(
      { workspaceId: "workspace:5", surfaceId: "surface:9" },
      'claude --append-system-prompt-file /tmp/crew.md "do the thing"',
    );
    expect(result).toEqual({ workspaceId: "workspace:5", surfaceId: "surface:9" });
  });

  it("throws when project is not registered", async () => {
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {},
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });

    await expect(runCrewSpawn({ project: "ghost", task: "x" }))
      .rejects.toThrow(/Project 'ghost' not found/);
  });

  it("throws when captain workspace is not running", async () => {
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {
        brove: { path: "/tmp/brove", captainName: "brove-captain", spokeVault: "~/hub/spokes/brove", host: "local" },
      },
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });
    status.mockResolvedValue(null);

    await expect(runCrewSpawn({ project: "brove", task: "x" }))
      .rejects.toThrow(/captain workspace 'brove-captain' is not running/i);
  });

  it("respects --direction and --agent overrides", async () => {
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {
        brove: { path: "/tmp/brove", captainName: "brove-captain", spokeVault: "~/hub/spokes/brove", host: "local" },
      },
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("codex 'task'");

    await runCrewSpawn({ project: "brove", task: "task", direction: "down", agent: "codex" });

    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({ direction: "down" }));
    expect(sendToPane).toHaveBeenCalledWith(
      expect.anything(),
      "codex 'task'",
    );
  });
});
