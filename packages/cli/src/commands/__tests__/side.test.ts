import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── mock setup (mirrors crew.test.ts pattern) ─────────────────────────────

const newPane = vi.hoisted(() => vi.fn());
const sendToPane = vi.hoisted(() => vi.fn());
const closePane = vi.hoisted(() => vi.fn());
const readPaneScreen = vi.hoisted(() => vi.fn());
const listSurfaces = vi.hoisted(() => vi.fn());
const status = vi.hoisted(() => vi.fn());
const buildCommand = vi.hoisted(() => vi.fn());

vi.mock("@cockpit/workspaces", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe: vi.fn(),
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
    get(name: string) { return (this.drivers as Record<string, unknown>)[name]; }
    async probeAll() { return {}; }
  },
  // side.ts + crew.ts (dynamically imported by regression test) pull these from
  // @cockpit/workspaces after the crew.ts thin-wrapper refactor (#367). Every
  // symbol either file imports must be declared here or the import resolves to
  // undefined and calls throw at runtime.
  resolveCaptainWorkspace: async (project: string) => {
    const config = loadConfig();
    const proj = config.projects[project];
    if (!proj) throw new Error(`Project '${project}' not found. Run 'cockpit projects list'.`);
    const ws = await status(proj.captainName);
    if (!ws) throw new Error(`Captain workspace '${proj.captainName}' is not running. Run 'cockpit launch ${project}' first.`);
    return { runtime: { newPane, closePane, sendToPane, readPaneScreen, listSurfaces, status }, workspaceId: ws.id };
  },
  listProjectCrews: async (_runtime: unknown, workspaceId: string, project: string) => {
    const surfaces: Array<{ title?: string }> = await listSurfaces(workspaceId);
    return surfaces.filter((s) => s.title?.startsWith(`🔧 ${project}:`));
  },
  findCrew: async (_runtime: unknown, workspaceId: string, project: string, name: string) => {
    const want = `🔧 ${project}:${name}`;
    const surfaces: Array<{ title?: string }> = await listSurfaces(workspaceId);
    return surfaces.find((s) => s.title === want) ?? null;
  },
  sendFirstTurnWhenReady: async (_runtime: unknown, pane: unknown, task: string) => {
    await sendToPane(pane, task);
  },
  getFreePort: async () => 12345,
}));

const loadConfig = vi.hoisted(() => vi.fn());
const addWorktreeMock = vi.hoisted(() => vi.fn());
const removeWorktreeMock = vi.hoisted(() => vi.fn());
const worktreePathMock = vi.hoisted(() => vi.fn());
const resolveWorktreeBaseMock = vi.hoisted(() => vi.fn().mockReturnValue("develop"));
vi.mock("@cockpit/shared", async () => {
  const actual = await vi.importActual<typeof import("@cockpit/shared")>("@cockpit/shared");
  return { ...actual, loadConfig, resolveHome: (p: string) => p, addWorktree: addWorktreeMock, removeWorktree: removeWorktreeMock, worktreePath: worktreePathMock, resolveWorktreeBase: resolveWorktreeBaseMock };
});

const claudeDriver = vi.hoisted(() => ({
  name: "claude",
  templateSuffix: "claude",
  probe: vi.fn(),
  buildCommand,
}));

vi.mock("@cockpit/agents", () => ({
  createClaudeDriver: () => claudeDriver,
  createCodexDriver: () => ({ ...claudeDriver, name: "codex", templateSuffix: "generic" }),
  createGeminiDriver: () => ({ ...claudeDriver, name: "gemini", templateSuffix: "generic" }),
  createOpencodeDriver: () => ({ ...claudeDriver, name: "opencode", templateSuffix: "opencode" }),
  CapabilityRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    get(name: string) { return (this.drivers as Record<string, unknown>)[name]; }
  },
}));

// per-crew-settings mock — needed by the crew regression test below.
const writePerCrewSettingsLocal = vi.hoisted(() => vi.fn());
vi.mock("../../lib/per-crew-settings.js", () => ({
  writePerCrewSettings: vi.fn(),
  writePerCrewSettingsLocal,
  writePerCrewOpencodeConfig: vi.fn(),
}));


// cockpitdCall and buildDispatchRequest are the daemon dispatch path.
// side.ts MUST NOT call these — the mocks let us assert that invariant.
const cockpitdCall = vi.hoisted(() => vi.fn());
const buildDispatchRequest = vi.hoisted(() => vi.fn());
vi.mock("../crew-control.js", () => ({
  cockpitdCall,
  buildDispatchRequest,
  sendCodexFirstTurn: vi.fn().mockResolvedValue(undefined),
}));

const existsSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const merged = { ...actual, existsSync: existsSyncMock };
  return { ...merged, default: merged };
});

import {
  runSideSpawn,
  runSideSend,
  runSideList,
  runSideClose,
  buildSideFirstTurn,
} from "../side.js";

const baseConfig = {
  commandName: "command",
  hubVault: "~/hub",
  projects: {
    brove: {
      path: "/tmp/brove",
      captainName: "brove-captain",
      spokeVault: "~/hub/spokes/brove",
      host: "local",
    },
  },
  defaults: {
    maxCrew: 5,
    worktreeDir: ".worktrees",
    teammateMode: "in-process",
    permissions: { command: "auto", captain: "auto", crew: "auto" },
    roles: {
      side: { agent: "claude", model: "opus" },
    },
  },
  metrics: { enabled: false, path: "" },
};

describe("cockpit side spawn", () => {
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
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    addWorktreeMock.mockReset();
    removeWorktreeMock.mockReset();
    worktreePathMock.mockReset();
    addWorktreeMock.mockReturnValue("/tmp/brove/.worktrees/brove-side-1");
    worktreePathMock.mockReturnValue("/tmp/brove/.worktrees/brove-side-1");

    // Staged boot: first read shows pre-launch, subsequent reads show stable TUI.
    let reads = 0;
    readPaneScreen.mockImplementation(async () => {
      reads++;
      if (reads === 1) return "booting…";
      if (reads <= 4) return "> ready";
      return "> ready\nworking…";
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("CRITICAL: does NOT call cockpitdCall or buildDispatchRequest (off daemon lifecycle)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --append-system-prompt-file /tmp/side.research.claude.md");

    const promise = runSideSpawn({ project: "brove", topic: "research oauth options", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(cockpitdCall).not.toHaveBeenCalled();
    expect(buildDispatchRequest).not.toHaveBeenCalled();
  });

  it("spawns with 🗒 title prefix and side-1 auto-name", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "research oauth", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      title: "🗒 brove:side-1",
    }));
    expect(result.title).toBe("🗒 brove:side-1");
  });

  it("wires the research template path (side.research.claude.md)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "research oauth", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        promptFile: expect.stringContaining("side.research.claude.md"),
        role: "side",
        interactive: true,
      }),
    );
  });

  it("uses the side model from config (opus)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --model opus");

    const promise = runSideSpawn({ project: "brove", topic: "research topic", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "opus" }),
    );
  });

  it("sends topic + context block as first turn (includes spokeVault)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "research oauth options", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    // Second sendToPane is the first-turn delivery (first is the CLI launch)
    const firstTurnCall = sendToPane.mock.calls[1];
    expect(firstTurnCall?.[1]).toContain("research oauth options");
    expect(firstTurnCall?.[1]).toContain("~/hub/spokes/brove");
    expect(firstTurnCall?.[1]).toContain("brove");
    expect(firstTurnCall?.[1]).toContain("research");
  });

  it("debug spawn creates a scratch worktree (addWorktree called)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "debug the crash", role: "debug" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(addWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/tmp/brove",
        project: "brove",
        base: "develop",
      }),
    );
  });

  it("research spawn does NOT create a worktree (addWorktree not called)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "research oauth", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(addWorktreeMock).not.toHaveBeenCalled();
  });

  it("debug spawn is off the daemon lifecycle (no cockpitdCall)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "debug the crash", role: "debug" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(cockpitdCall).not.toHaveBeenCalled();
    expect(buildDispatchRequest).not.toHaveBeenCalled();
  });

  it("debug spawn cd-prefixes into the scratch worktree path (#279 fix)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");
    addWorktreeMock.mockReturnValue("/tmp/brove/.worktrees/brove-side-1");

    const promise = runSideSpawn({ project: "brove", topic: "debug the crash", role: "debug" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    // First sendToPane call is the CLI launch — must cd into the scratch worktree
    const launchCall = sendToPane.mock.calls[0];
    expect(launchCall?.[1]).toContain("cd '/tmp/brove/.worktrees/brove-side-1'");
  });

  it("debug first turn includes scratch worktree path in context block", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");
    addWorktreeMock.mockReturnValue("/tmp/brove/.worktrees/brove-side-1");

    const promise = runSideSpawn({ project: "brove", topic: "debug the crash", role: "debug" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    const firstTurnCall = sendToPane.mock.calls[1];
    expect(firstTurnCall?.[1]).toContain("Scratch worktree: /tmp/brove/.worktrees/brove-side-1");
  });

  it("throws for unknown --role", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);

    await expect(
      runSideSpawn({ project: "brove", topic: "topic", role: "unknown-role" }),
    ).rejects.toThrow("Unknown side role");
  });

  it("auto-increments name avoiding existing side sessions", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([
      { surfaceId: "s1", title: "🗒 brove:side-1" },
      { surfaceId: "s2", title: "🗒 brove:side-2" },
    ]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "topic", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result.title).toBe("🗒 brove:side-3");
  });

  it("uses promptFile=undefined when template file is absent (existsSync=false)", async () => {
    existsSyncMock.mockReturnValue(false);
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "topic", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({ promptFile: undefined }),
    );
  });

  it("does not mix 🔧 crew titles into the side name counter", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    // Only crew tabs — side counter starts at 1
    listSurfaces.mockResolvedValue([
      { surfaceId: "s1", title: "🔧 brove:crew-1" },
      { surfaceId: "s2", title: "🔧 brove:crew-2" },
    ]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "topic", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result.title).toBe("🗒 brove:side-1");
  });
});

describe("buildSideFirstTurn", () => {
  it("includes topic, project, role, and spokeVault", () => {
    const result = buildSideFirstTurn(
      "research oauth options",
      "brove",
      "research",
      "~/hub/spokes/brove",
    );
    expect(result).toContain("research oauth options");
    expect(result).toContain("brove");
    expect(result).toContain("research");
    expect(result).toContain("~/hub/spokes/brove");
  });

  it("puts the topic first (before the context block)", () => {
    const result = buildSideFirstTurn("my topic", "proj", "research", "/vault");
    expect(result.indexOf("my topic")).toBeLessThan(result.indexOf("---"));
  });

  it("separates topic from context with a divider line", () => {
    const result = buildSideFirstTurn("topic text", "proj", "research", "/vault");
    expect(result).toContain("\n---\n");
  });
});

describe("runSideList / runSideClose / runSideSend", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    listSurfaces.mockReset();
    status.mockReset();
    sendToPane.mockReset();
    closePane.mockReset();
    existsSyncMock.mockReset();
    removeWorktreeMock.mockReset();
    worktreePathMock.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    worktreePathMock.mockReturnValue("/tmp/brove/.worktrees/brove-side-1");
  });

  it("runSideList returns only 🗒-prefixed sessions for this project", async () => {
    listSurfaces.mockResolvedValue([
      { surfaceId: "s1", title: "🗒 brove:side-1" },
      { surfaceId: "s2", title: "🔧 brove:crew-1" }, // crew — must be excluded
      { surfaceId: "s3", title: "🗒 brove:side-2" },
      { surfaceId: "s4", title: "🗒 other:side-1" }, // different project — excluded
    ]);

    const result = await runSideList("brove");

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual(["side-1", "side-2"]);
  });

  it("runSideClose closes the matching pane", async () => {
    listSurfaces.mockResolvedValue([{ surfaceId: "s1", title: "🗒 brove:side-1" }]);
    closePane.mockResolvedValue(undefined);

    await runSideClose("brove", "side-1");

    expect(closePane).toHaveBeenCalledWith(expect.objectContaining({ surfaceId: "s1" }));
  });

  it("runSideClose throws when session not found", async () => {
    listSurfaces.mockResolvedValue([]);
    existsSyncMock.mockReturnValue(false);

    await expect(runSideClose("brove", "side-99")).rejects.toThrow("not found");
  });

  it("runSideClose prunes scratch worktree when worktree path exists (debug session)", async () => {
    listSurfaces.mockResolvedValue([{ surfaceId: "s1", title: "🗒 brove:side-1" }]);
    closePane.mockResolvedValue(undefined);
    existsSyncMock.mockReturnValue(true); // worktree path exists → debug session

    await runSideClose("brove", "side-1");

    expect(removeWorktreeMock).toHaveBeenCalledWith(
      "/tmp/brove",
      "/tmp/brove/.worktrees/brove-side-1",
    );
  });

  it("runSideClose does NOT call removeWorktree when worktree path absent (research session)", async () => {
    listSurfaces.mockResolvedValue([{ surfaceId: "s1", title: "🗒 brove:side-1" }]);
    closePane.mockResolvedValue(undefined);
    existsSyncMock.mockReturnValue(false); // no worktree → research session

    await runSideClose("brove", "side-1");

    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it("runSideSend sends to the matching pane without touching daemon", async () => {
    listSurfaces.mockResolvedValue([{ surfaceId: "s1", title: "🗒 brove:side-1" }]);

    await runSideSend("brove", "side-1", "follow-up message");

    expect(sendToPane).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceId: "s1" }),
      "follow-up message",
    );
    expect(cockpitdCall).not.toHaveBeenCalled();
  });

  it("runSideSend throws when session not found", async () => {
    listSurfaces.mockResolvedValue([]);

    await expect(runSideSend("brove", "side-99", "hi")).rejects.toThrow("not found");
  });
});

describe("crew spawn regression — daemon path unchanged", () => {
  it("cockpit crew spawn still calls cockpitdCall (daemon path intact)", async () => {
    const { runCrewSpawn } = await import("../crew.js");

    vi.useFakeTimers();

    let reads = 0;
    readPaneScreen.mockImplementation(async () => {
      reads++;
      if (reads === 1) return "booting…";
      if (reads <= 4) return "> ready";
      return "> ready\nworking…";
    });

    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");
    buildDispatchRequest.mockImplementation((o: unknown) => ({
      kind: "dispatch",
      record: { ...(o as object), id: "task-cl1" },
    }));
    cockpitdCall.mockResolvedValue({
      id: "task-cl1",
      project: "brove",
      provider: "claude",
      mode: "interactive",
    });
    writePerCrewSettingsLocal.mockReturnValue("/tmp/.claude/settings.local.json");

    const promise = runCrewSpawn({ project: "brove", task: "do the thing" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(cockpitdCall).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
