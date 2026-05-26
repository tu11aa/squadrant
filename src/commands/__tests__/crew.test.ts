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
  createOpencodeDriver: () => ({ ...claudeDriver, name: "opencode", templateSuffix: "generic" }),
  CapabilityRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    get(name: string) { return this.drivers[name]; }
  },
}));

const cockpitdCall = vi.hoisted(() => vi.fn());
const buildDispatchRequest = vi.hoisted(() => vi.fn());
const sendCodexFirstTurn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../crew-control.js", () => ({
  cockpitdCall,
  buildDispatchRequest,
  sendCodexFirstTurn,
}));

const writePerCrewSettings = vi.hoisted(() => vi.fn());
vi.mock("../../lib/per-crew-settings.js", () => ({
  writePerCrewSettings,
}));

const existsSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const merged = { ...actual, existsSync: existsSyncMock, readFileSync: readFileSyncMock };
  return { ...merged, default: merged };
});

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
    cockpitdCall.mockReset();
    buildDispatchRequest.mockReset();
    sendCodexFirstTurn.mockReset();
    sendCodexFirstTurn.mockResolvedValue(undefined);
    writePerCrewSettings.mockReset();
    writePerCrewSettings.mockReturnValue("/tmp/per-crew/settings.json");
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
    // Default: pretend the codex role template is absent so older tests that
    // don't care about role injection still pass unchanged.
    existsSyncMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns a Claude crew through the daemon, env-prefixes the CLI, sends the task after boot", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --append-system-prompt-file /tmp/crew.md --settings /tmp/per-crew/settings.json");
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-cl1" } }));
    cockpitdCall.mockResolvedValue({ id: "task-cl1", project: "brove", provider: "claude", mode: "interactive" });

    const promise = runCrewSpawn({ project: "brove", task: "do the thing" });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    // Daemon dispatched FIRST, before the cmux tab.
    expect(buildDispatchRequest).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      mode: "interactive",
      project: "brove",
      cwd: "/tmp/brove",
      task: "do the thing",
    }));
    expect(cockpitdCall).toHaveBeenCalledTimes(1);
    // Per-crew settings.json written under the daemon-assigned taskId.
    expect(writePerCrewSettings).toHaveBeenCalledWith(expect.objectContaining({
      project: "brove",
      taskId: "task-cl1",
    }));
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({
      interactive: true,
      settingsPath: "/tmp/per-crew/settings.json",
    }));
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:5",
      direction: "tab",
      title: "🔧 brove:crew-1",
    }));
    // First sendToPane carries the env-prefix + CLI command in one line.
    expect(sendToPane.mock.calls[0]?.[1]).toContain("COCKPIT_CREW_TASK_ID=task-cl1");
    expect(sendToPane.mock.calls[0]?.[1]).toContain("COCKPIT_CREW_PROJECT=brove");
    expect(sendToPane.mock.calls[0]?.[1]).toContain("claude --append-system-prompt-file /tmp/crew.md");
    // Second sendToPane delivers the task as the first prompt.
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
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-an" } }));
    cockpitdCall.mockResolvedValue({ id: "task-an" });

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

  it("spawns an opencode crew interactively, then sends the task after the boot delay", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("opencode");

    const promise = runCrewSpawn({ project: "brove", task: "do the thing", agent: "opencode" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
    expect(sendToPane.mock.calls[0]).toEqual([
      { workspaceId: "workspace:5", surfaceId: "surface:9" },
      "opencode",
    ]);
    expect(sendToPane.mock.calls[1]).toEqual([
      { workspaceId: "workspace:5", surfaceId: "surface:9" },
      "do the thing",
    ]);
  });

  it("--agent codex routes through the control-plane daemon and opens an attach tab in the captain", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-abc" } }));
    cockpitdCall.mockResolvedValue({ id: "task-abc", project: "brove", provider: "codex", mode: "interactive" });

    const result = await runCrewSpawn({ project: "brove", task: "do the thing", agent: "codex" });

    // dispatch routed via daemon, not buildCommand
    expect(buildDispatchRequest).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      mode: "interactive",
      project: "brove",
      cwd: "/tmp/brove",
      task: "do the thing",
    }));
    expect(cockpitdCall).toHaveBeenCalledTimes(1);
    expect(buildCommand).not.toHaveBeenCalled();
    // tab placed in captain with crew-1 title (same UX as claude)
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:5",
      direction: "tab",
      title: "🔧 brove:crew-1",
    }));
    // sendToPane only opens the renderer; the task arg is delivered to the
    // daemon via sendCodexFirstTurn (attach-socket `say` op), not the tab.
    expect(sendToPane).toHaveBeenCalledTimes(1);
    expect(sendToPane).toHaveBeenCalledWith(
      { workspaceId: "workspace:5", surfaceId: "surface:9" },
      "cockpit crew attach task-abc",
    );
    expect(sendCodexFirstTurn).toHaveBeenCalledWith("task-abc", "do the thing");
    expect(result.title).toBe("🔧 brove:crew-1");
  });

  it("--agent codex skips the first-turn say when task is the legacy '(interactive)' placeholder", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-noop" } }));
    cockpitdCall.mockResolvedValue({ id: "task-noop" });

    await runCrewSpawn({ project: "brove", task: "(interactive)", agent: "codex" });

    expect(sendCodexFirstTurn).not.toHaveBeenCalled();
  });

  it("--agent codex forwards crew.generic.md role content as roleInstructions on dispatch", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-role" } }));
    cockpitdCall.mockResolvedValue({ id: "task-role" });

    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      "# Crew Member — Generic Agent\n\nYou are a crew member working on a specific task in a git worktree.\n",
    );

    await runCrewSpawn({ project: "brove", task: "do the thing", agent: "codex" });

    expect(buildDispatchRequest).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      roleInstructions: expect.stringContaining("You are a crew member"),
    }));
    expect(readFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("crew.generic.md"),
      "utf8",
    );
  });

  it("--agent codex --approval propagates approvalPolicy='untrusted' into the dispatch", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-xyz" } }));
    cockpitdCall.mockResolvedValue({ id: "task-xyz" });

    await runCrewSpawn({ project: "brove", task: "task", agent: "codex", approvalPolicy: "untrusted" });

    expect(buildDispatchRequest).toHaveBeenCalledWith(expect.objectContaining({
      approvalPolicy: "untrusted",
    }));
  });

  it("passes the configured crew model when spawn agent matches role agent", async () => {
    loadConfig.mockReturnValue({
      ...baseConfig,
      defaults: {
        ...baseConfig.defaults,
        roles: {
          command: { agent: "claude", model: "opus" },
          captain: { agent: "claude", model: "opus" },
          crew: { agent: "claude", model: "sonnet" },
          reactor: { agent: "claude", model: "sonnet" },
          exploration: { agent: "claude", model: "haiku" },
        },
      },
    });
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --model sonnet ...");
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-cm" } }));
    cockpitdCall.mockResolvedValue({ id: "task-cm" });

    const promise = runCrewSpawn({ project: "brove", task: "task" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ model: "sonnet" }));
  });

  it("does NOT pass crew model when spawn agent differs from configured role agent", async () => {
    // role config says crew=claude/sonnet, but user spawns with --agent gemini.
    // Model names are agent-specific, so we must NOT pass "sonnet" to gemini.
    // (Codex is excluded — it bypasses buildCommand via the interactive daemon path.)
    loadConfig.mockReturnValue({
      ...baseConfig,
      defaults: {
        ...baseConfig.defaults,
        roles: {
          command: { agent: "claude", model: "opus" },
          captain: { agent: "claude", model: "opus" },
          crew: { agent: "claude", model: "sonnet" },
          reactor: { agent: "claude", model: "sonnet" },
          exploration: { agent: "claude", model: "haiku" },
        },
      },
    });
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("gemini exec 'task'");

    await runCrewSpawn({ project: "brove", task: "task", agent: "gemini" });

    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it("respects --direction override", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude ...");
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-d" } }));
    cockpitdCall.mockResolvedValue({ id: "task-d" });

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
