import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";

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
  createOpencodeDriver: () => ({ ...claudeDriver, name: "opencode", templateSuffix: "opencode" }),
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
const writePerCrewSettingsLocal = vi.hoisted(() => vi.fn());
const writePerCrewOpencodeConfig = vi.hoisted(() => vi.fn());
vi.mock("../../lib/per-crew-settings.js", () => ({
  writePerCrewSettings,
  writePerCrewSettingsLocal,
  writePerCrewOpencodeConfig,
}));

const existsSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const merged = { ...actual, existsSync: existsSyncMock, readFileSync: readFileSyncMock };
  return { ...merged, default: merged };
});

import { runCrewSpawn, runCrewSend, runCrewRead, runCrewClose, runCrewList, sendFirstTurnWhenReady, reapCrewChildren } from "../crew.js";

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
    // Staged boot: first read (the call-site preLaunch snapshot) shows the
    // un-entered launch line; subsequent reads show a stable TUI prompt that
    // has advanced past it, so sendFirstTurnWhenReady's readiness gate fires.
    let reads = 0;
    readPaneScreen.mockImplementation(async () => {
      reads++;
      if (reads === 1) return "booting…";
      if (reads <= 4) return "> ready";
      return "> ready\nworking…";
    });
    listSurfaces.mockReset();
    status.mockReset();
    buildCommand.mockReset();
    loadConfig.mockReset();
    cockpitdCall.mockReset();
    buildDispatchRequest.mockReset();
    sendCodexFirstTurn.mockReset();
    sendCodexFirstTurn.mockResolvedValue(undefined);
    writePerCrewSettings.mockReset();
    writePerCrewSettingsLocal.mockReset();
    writePerCrewSettingsLocal.mockReturnValue("/tmp/brove/.claude/settings.local.json");
    writePerCrewOpencodeConfig.mockReset();
    writePerCrewOpencodeConfig.mockReturnValue("/tmp/per-crew/opencode.json");
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
    buildCommand.mockReturnValue("claude --append-system-prompt-file /tmp/crew.md");
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
    // Cockpit hooks written to .claude/settings.local.json (auto-loaded source).
    expect(writePerCrewSettingsLocal).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: "/tmp/brove",
    }));
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({
      interactive: true,
    }));
    // No --settings flag — hooks come from .claude/settings.local.json.
    expect(buildCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      settingsPath: expect.any(String),
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

  it("spawns an opencode crew through the daemon, sets env vars + OPENCODE_CONFIG, sends task after boot", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("opencode");
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-oc1" } }));
    cockpitdCall.mockResolvedValue({ id: "task-oc1", project: "brove", provider: "opencode", mode: "interactive" });

    const promise = runCrewSpawn({ project: "brove", task: "do the thing", agent: "opencode" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    // Daemon dispatched FIRST, before the cmux tab.
    expect(buildDispatchRequest).toHaveBeenCalledWith(expect.objectContaining({
      provider: "opencode",
      mode: "interactive",
      project: "brove",
      cwd: "/tmp/brove",
      task: "do the thing",
      budgetMs: 86400000,
    }));
    expect(cockpitdCall).toHaveBeenCalledTimes(1);
    // Per-crew opencode config uses the daemon-assigned taskId.
    expect(writePerCrewOpencodeConfig).toHaveBeenCalledWith(expect.objectContaining({
      project: "brove",
      taskId: "task-oc1",
    }));
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:5",
      direction: "tab",
      title: "🔧 brove:crew-1",
    }));
    // First sendToPane carries env-prefix + CLI command.
    expect(sendToPane.mock.calls[0]?.[1]).toContain("COCKPIT_CREW_TASK_ID=task-oc1");
    expect(sendToPane.mock.calls[0]?.[1]).toContain("COCKPIT_CREW_PROJECT=brove");
    expect(sendToPane.mock.calls[0]?.[1]).toContain("OPENCODE_CONFIG=/tmp/per-crew/opencode.json");
    expect(sendToPane.mock.calls[0]?.[1]).toContain("opencode");
    // Second sendToPane delivers the task as the first prompt.
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

  it("passes the configured crew permission mode to buildCommand", async () => {
    loadConfig.mockReturnValue({
      ...baseConfig,
      defaults: {
        ...baseConfig.defaults,
        permissions: { command: "auto", captain: "auto", crew: "auto" },
      },
    });
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --permission-mode auto ...");
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-pm" } }));
    cockpitdCall.mockResolvedValue({ id: "task-pm" });

    const promise = runCrewSpawn({ project: "brove", task: "task" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "auto" }));
  });

  it("falls back to acceptEdits when no crew permission mode is configured", async () => {
    // baseConfig.defaults.permissions = {} → no crew key set.
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude ...");
    buildDispatchRequest.mockImplementation((o) => ({ kind: "dispatch", record: { ...o, id: "task-pmf" } }));
    cockpitdCall.mockResolvedValue({ id: "task-pmf" });

    const promise = runCrewSpawn({ project: "brove", task: "task" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "acceptEdits" }));
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

describe("sendFirstTurnWhenReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen.mockReset();
    sendToPane.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls until pane stabilizes then sends the task once", async () => {
    let callCount = 0;
    readPaneScreen.mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) return "";
      if (callCount <= 3) return "> ";        // stable prompt, advanced past launch
      if (callCount === 4) return "> ";       // preSend snapshot
      return "> do the thing";                // after-send: screen changed → no re-send
    });

    const pane = { workspaceId: "w:1", surfaceId: "s:1" };
    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane } as any,
      pane,
      "do the thing",
      "$ launch",
    );

    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    expect(sendToPane).toHaveBeenCalledTimes(1);
    expect(sendToPane).toHaveBeenCalledWith(pane, "do the thing");
  });

  it("falls back to sending even if pane never stabilises", async () => {
    readPaneScreen.mockResolvedValue("");

    const pane = { workspaceId: "w:1", surfaceId: "s:1" };
    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane } as any,
      pane,
      "do the thing",
      "$ launch",
    );

    await vi.advanceTimersByTimeAsync(21000);
    await promise;

    // Two calls: fallback send + one re-send (post-send check sees an unchanged screen)
    expect(sendToPane).toHaveBeenCalledTimes(2);
    expect(sendToPane).toHaveBeenNthCalledWith(1, pane, "do the thing");
    expect(sendToPane).toHaveBeenNthCalledWith(2, pane, "do the thing");
  }, 15000);

  it("re-sends once when the screen is unchanged after the first send", async () => {
    readPaneScreen.mockResolvedValue("> ");

    const pane = { workspaceId: "w:1", surfaceId: "s:1" };
    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane } as any,
      pane,
      "do the thing",
      "$ launch",
    );

    await vi.advanceTimersByTimeAsync(3500);
    await promise;

    // Two calls: initial send + one re-send (preSend === afterScreen)
    expect(sendToPane).toHaveBeenCalledTimes(2);
    expect(sendToPane).toHaveBeenNthCalledWith(1, pane, "do the thing");
    expect(sendToPane).toHaveBeenNthCalledWith(2, pane, "do the thing");
  });

  // #168: sendToPane (since #136) collapses newlines to spaces, so a multi-line
  // task never appears verbatim in the pane render. The old post-send check
  // `!afterScreen.includes(task)` therefore always re-sent → duplicate first
  // turn. The fix compares the screen before vs after sending instead.
  it("does NOT re-send a multi-line task when the pane render collapses newlines", async () => {
    const task = "line one\nline two\nline three";
    let callCount = 0;
    readPaneScreen.mockImplementation(async () => {
      callCount++;
      // reads 1-2: poll (stable), read 3: preSend snapshot — all the bare prompt.
      if (callCount <= 3) return "> ";
      return "> line one line two line three";               // after-send: collapsed render
    });

    const pane = { workspaceId: "w:1", surfaceId: "s:1" };
    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane } as any,
      pane,
      task,
      "$ launch",
    );

    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    // The screen changed after the send (task was received), so no re-send —
    // even though `afterScreen.includes(task)` is false for the multi-line task.
    expect(sendToPane).toHaveBeenCalledTimes(1);
    expect(sendToPane).toHaveBeenCalledWith(pane, task);
  });

  // opencode boot-race: the screen can be momentarily static while the launch
  // command still sits un-entered on the shell line. Sending then concatenates
  // onto that line → shell parse error. The readiness gate must require the
  // screen to ADVANCE past the launch-line snapshot, not merely be static.
  it("does NOT send the first turn while the pane still shows the un-entered launch line", async () => {
    const launchLine = "$ COCKPIT_CREW_TASK_ID=t1 opencode";
    readPaneScreen.mockResolvedValue(launchLine);

    const pane = { workspaceId: "w:1", surfaceId: "s:1" };
    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane } as any,
      pane,
      "do the thing",
      launchLine,
    );

    // Well under the 20s timeout: the screen never advanced past the launch
    // line, so the readiness gate must not have fired yet.
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendToPane).not.toHaveBeenCalled();

    // Drain to the timeout so the fallback send fires and the promise resolves.
    await vi.advanceTimersByTimeAsync(20000);
    await promise;
  }, 15000);
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
    cockpitdCall.mockReset();
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

  it("send emits task.reopened when the crew's daemon task is terminal", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
    ]);
    // Simulate a daemon with a done task matching the crew name.
    cockpitdCall.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string; project?: string };
      if (r.kind === "list") {
        return [{ id: "task-done-1", name: "crew-1", project: "brove", state: "done", provider: "claude", mode: "interactive", task: "old task", createdAt: 1000, lastHeartbeat: 1000, lastEvent: "task.done", heartbeatBudgetMs: 300000, attempts: [] }];
      }
      return undefined;
    });

    await runCrewSend("brove", "crew-1", "follow up");

    // Should have called list then event (task.reopened)
    expect(cockpitdCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "list", project: "brove" }));
    expect(cockpitdCall).toHaveBeenCalledWith(expect.objectContaining({
      kind: "event",
      project: "brove",
      event: { type: "task.reopened", id: "task-done-1" },
    }));
    expect(sendToPane).toHaveBeenCalledWith(
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
      "follow up",
    );
  });

  it("send does NOT emit task.reopened when the crew's task is working (non-terminal)", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
    ]);
    cockpitdCall.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string };
      if (r.kind === "list") {
        return [{ id: "task-w-1", name: "crew-1", project: "brove", state: "working", provider: "claude", mode: "interactive", task: "current", createdAt: 2000, lastHeartbeat: 2000, lastEvent: "task.started", heartbeatBudgetMs: 300000, attempts: [] }];
      }
      return undefined;
    });

    await runCrewSend("brove", "crew-1", "follow up");

    // Only one call to cockpitdCall — the list to check state; no event emitted.
    const callKinds = (cockpitdCall.mock.calls as Array<[{ kind: string }]>)
      .map(([req]) => req.kind);
    expect(callKinds).toEqual(["list"]);
    expect(sendToPane).toHaveBeenCalledWith(
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
      "follow up",
    );
  });

  it("send tolerates daemon being down (best-effort, caught)", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
    ]);
    // Daemon throws on every call.
    cockpitdCall.mockRejectedValue(new Error("daemon unreachable"));

    await runCrewSend("brove", "crew-1", "follow up");

    // sendToPane still fires even with daemon errors.
    expect(sendToPane).toHaveBeenCalledWith(
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
      "follow up",
    );
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

  it("close emits task.cancelled for a non-terminal crew task before closing the pane (#184)", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
    ]);
    cockpitdCall.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string };
      if (r.kind === "list") {
        return [{ id: "task-b1", name: "crew-1", project: "brove", state: "blocked", provider: "claude", mode: "interactive", task: "task", createdAt: 1000, lastHeartbeat: 1000, lastEvent: "task.blocked", heartbeatBudgetMs: 300000, attempts: [] }];
      }
      return undefined;
    });

    await runCrewClose("brove", "crew-1");

    expect(cockpitdCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "list", project: "brove" }));
    expect(cockpitdCall).toHaveBeenCalledWith(expect.objectContaining({
      kind: "event",
      project: "brove",
      event: { type: "task.cancelled", id: "task-b1", reason: "closed by captain" },
    }));
    expect(closePane).toHaveBeenCalled();
  });

  it("close skips task.cancelled when the crew task is already terminal (#184)", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
    ]);
    cockpitdCall.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string };
      if (r.kind === "list") {
        return [{ id: "task-d1", name: "crew-1", project: "brove", state: "done", provider: "claude", mode: "interactive", task: "task", createdAt: 1000, lastHeartbeat: 1000, lastEvent: "task.done", heartbeatBudgetMs: 300000, attempts: [] }];
      }
      return undefined;
    });

    await runCrewClose("brove", "crew-1");

    const callKinds = (cockpitdCall.mock.calls as Array<[{ kind: string }]>).map(([req]) => req.kind);
    expect(callKinds).toEqual(["list"]); // only list, no event emitted
    expect(closePane).toHaveBeenCalled();
  });

  it("close still calls closePane when daemon is unreachable (#184)", async () => {
    listSurfaces.mockResolvedValue([
      { workspaceId: "workspace:5", surfaceId: "surface:10", title: "🔧 brove:crew-1" },
    ]);
    cockpitdCall.mockRejectedValue(new Error("ENOENT: daemon socket not found"));

    await runCrewClose("brove", "crew-1");

    expect(closePane).toHaveBeenCalled();
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

describe("reapCrewChildren", () => {
  it("kills node processes tagged with the crew task ID and leaves sibling processes alive", async () => {
    const taskId = `reap-crew-test-${process.pid}-${Date.now()}`;
    const siblingId = `reap-sibling-test-${process.pid}-${Date.now()}`;

    // Spawn a long-running node process as the "crew child" (inherits COCKPIT_CREW_TASK_ID=taskId)
    const crewChild = spawn("node", ["-e", "setInterval(() => {}, 999999)"], {
      env: { ...process.env, COCKPIT_CREW_TASK_ID: taskId },
      stdio: "ignore",
    });

    // Spawn a sibling with a DIFFERENT task ID — must NOT be killed
    const sibling = spawn("node", ["-e", "setInterval(() => {}, 999999)"], {
      env: { ...process.env, COCKPIT_CREW_TASK_ID: siblingId },
      stdio: "ignore",
    });

    // Give ps time to see the new processes
    await new Promise<void>((r) => setTimeout(r, 400));

    const crewPid = crewChild.pid!;
    const siblingPid = sibling.pid!;

    // Both alive before reap
    expect(() => process.kill(crewPid, 0)).not.toThrow();
    expect(() => process.kill(siblingPid, 0)).not.toThrow();

    // Reap with a short grace period so the test doesn't take 2 seconds
    await reapCrewChildren(taskId, 50);

    // Crew child must be dead
    expect(() => process.kill(crewPid, 0)).toThrow();
    // Sibling with a different task ID must still be alive
    expect(() => process.kill(siblingPid, 0)).not.toThrow();

    sibling.kill("SIGKILL");
  }, 10000);

  it("is a no-op and does not throw when no processes carry the task ID", async () => {
    await expect(reapCrewChildren("nonexistent-task-id-xyz-abc", 50)).resolves.toBeUndefined();
  });
});
