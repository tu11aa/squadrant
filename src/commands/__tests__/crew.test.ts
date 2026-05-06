import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const newPane = vi.hoisted(() => vi.fn());
const sendToPane = vi.hoisted(() => vi.fn());
const closePane = vi.hoisted(() => vi.fn());
const readPaneScreen = vi.hoisted(() => vi.fn());
const listSurfaces = vi.hoisted(() => vi.fn());
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
    closePane,
    sendToPane,
    readPaneScreen,
    listSurfaces,
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

import { runCrewSpawn, runCrewSend, runCrewRead, runCrewClose, runCrewList } from "../crew.js";

const baseConfig = {
  commandName: "command",
  hubVault: "~/hub",
  projects: {
    brove: { path: "/tmp/brove", captainName: "brove-captain", spokeVault: "~/hub/spokes/brove", host: "local" },
  },
  defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
  metrics: { enabled: false, path: "" },
};

describe("cockpit crew spawn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    newPane.mockReset();
    sendToPane.mockReset();
    closePane.mockReset();
    readPaneScreen.mockReset();
    listSurfaces.mockReset();
    status.mockReset();
    buildCommand.mockReset();
    loadConfig.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns a Claude crew interactively, names it crew-1, then sends the task after the boot delay", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --append-system-prompt-file /tmp/crew.md");

    const promise = runCrewSpawn({ project: "brove", task: "do the thing" });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:5",
      direction: "tab",
      title: "🔧 brove:crew-1",
    }));
    expect(sendToPane.mock.calls[0]).toEqual([
      { workspaceId: "workspace:5", surfaceId: "surface:9" },
      "claude --append-system-prompt-file /tmp/crew.md",
    ]);
    expect(sendToPane.mock.calls[1]).toEqual([
      { workspaceId: "workspace:5", surfaceId: "surface:9" },
      "do the thing",
    ]);
    expect(result.title).toBe("🔧 brove:crew-1");
  });

  it("auto-names the next crew based on existing tabs (crew-1 + crew-3 → crew-2)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
      { workspaceId: "workspace:5", surfaceId: "surface:12", title: "🔧 brove:crew-3" },
    ]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:13" });
    buildCommand.mockReturnValue("claude ...");

    const promise = runCrewSpawn({ project: "brove", task: "task" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({ title: "🔧 brove:crew-2" }));
  });

  it("respects --name and refuses if a crew with that name already exists", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:fix-typos" },
    ]);

    await expect(runCrewSpawn({ project: "brove", task: "x", name: "fix-typos" }))
      .rejects.toThrow(/already exists/);
  });

  it("non-Claude agent crews stay print-mode (no boot delay, no second send)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("codex exec 'task'");

    const result = await runCrewSpawn({ project: "brove", task: "task", agent: "codex" });

    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ interactive: false }));
    expect(sendToPane).toHaveBeenCalledTimes(1);
    expect(result.title).toBe("🔧 brove:crew-1");
  });

  it("respects --direction override", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude ...");

    const promise = runCrewSpawn({ project: "brove", task: "task", direction: "down" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({ direction: "down" }));
  });

  it("throws when project is not registered", async () => {
    loadConfig.mockReturnValue({ ...baseConfig, projects: {} });
    await expect(runCrewSpawn({ project: "ghost", task: "x" }))
      .rejects.toThrow(/Project 'ghost' not found/);
  });

  it("throws when captain workspace is not running", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue(null);
    await expect(runCrewSpawn({ project: "brove", task: "x" }))
      .rejects.toThrow(/captain workspace 'brove-captain' is not running/i);
  });
});

describe("cockpit crew send/read/close/list", () => {
  beforeEach(() => {
    listSurfaces.mockReset();
    status.mockReset();
    sendToPane.mockReset();
    closePane.mockReset();
    readPaneScreen.mockReset();
    loadConfig.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
  });

  it("send delivers a message to the matching crew tab", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
    ]);

    await runCrewSend("brove", "crew-1", "follow up");

    expect(sendToPane).toHaveBeenCalledWith(
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
      "follow up",
    );
  });

  it("send throws when crew name is not found", async () => {
    listSurfaces.mockResolvedValue([]);
    await expect(runCrewSend("brove", "ghost", "msg"))
      .rejects.toThrow(/Crew 'ghost' not found/);
  });

  it("read returns the crew's screen content", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
    ]);
    readPaneScreen.mockResolvedValue("crew screen text");

    const text = await runCrewRead("brove", "crew-1");
    expect(text).toBe("crew screen text");
  });

  it("close shuts the crew tab", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
    ]);

    await runCrewClose("brove", "crew-1");

    expect(closePane).toHaveBeenCalledWith({
      workspaceId: "workspace:5",
      surfaceId: "surface:10",
      title: "🔧 brove:crew-1",
    });
  });

  it("list returns all crews for the project, ignoring non-crew tabs", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:9", title: "captain shell" },
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
      { workspaceId: "workspace:5", surfaceId: "surface:11", title: "🔧 brove:fix-typos" },
      { workspaceId: "workspace:5", surfaceId: "surface:12", title: "🔧 other:crew-1" },
    ]);

    const crews = await runCrewList("brove");
    expect(crews).toEqual([
      { name: "crew-1", surfaceId: "surface:10" },
      { name: "fix-typos", surfaceId: "surface:11" },
    ]);
  });
});
