// Unit tests for crew-spawn.ts orchestration logic.
// Uses mock deps and module mocks — no daemon, no workspaces, no agents, no git.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── module mocks (hoisted before imports) ───────────────────────────────────

const addWorktreeMock = vi.hoisted(() =>
  vi.fn().mockImplementation(
    (spec: { repoRoot: string; project: string; name: string }) =>
      `${spec.repoRoot}/.worktrees/${spec.project}-${spec.name}`,
  ),
);
const resolveWorktreeBaseMock = vi.hoisted(() => vi.fn().mockReturnValue("main"));
const removeWorktreeMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("@squadrant/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@squadrant/shared")>();
  return {
    ...actual,
    addWorktree: addWorktreeMock,
    resolveWorktreeBase: resolveWorktreeBaseMock,
    removeWorktree: removeWorktreeMock,
    loadConfig: loadConfigMock,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // Default: existsSync returns false so codex role file is treated as absent.
  const existsSync = vi.fn().mockReturnValue(false);
  const readFileSync = vi.fn().mockReturnValue("");
  return { ...actual, existsSync, readFileSync, default: { ...actual, existsSync, readFileSync } };
});

// Prevent reapCrewChildren from running real `ps auxE` during close tests.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const exec = vi.fn((_cmd: string, _opts: unknown, cb: (e: null, out: string) => void) => cb(null, ""));
  return { ...actual, exec, default: { ...actual, exec } };
});

// ─── imports (after mock declarations) ───────────────────────────────────────

import {
  runCrewSpawn,
  runCrewSend,
  runCrewRead,
  runCrewClose,
  runCrewList,
  type CrewSpawnInput,
  type CrewSpawnDeps,
  type ResolvedAgent,
} from "../crew-spawn.js";
import type { SquadrantConfig, RuntimeDriver, PaneRef, ControlEvent, TaskRecord } from "@squadrant/shared";

// ─── fixtures ────────────────────────────────────────────────────────────────

const PROJ_PATH = "/fake/repo";
const PROJECT = "myproj";
const CAPTAIN_NAME = "myproj-captain";

function makeConfig(overrides?: Partial<SquadrantConfig["defaults"]>): SquadrantConfig {
  return {
    version: 1,
    projects: {
      [PROJECT]: {
        path: PROJ_PATH,
        captainName: CAPTAIN_NAME,
        spokeVault: "/fake/vault",
      },
    },
    defaults: {
      worktreeDir: ".worktrees",
      permissions: { command: "acceptEdits", captain: "acceptEdits", crew: "acceptEdits" },
      ...overrides,
    },
    runtime: "cmux",
  } as unknown as SquadrantConfig;
}

function makePaneRef(suffix = "42"): PaneRef {
  return { workspaceId: "workspace:1", surfaceId: `surface:${suffix}` };
}

function makeRuntime(captainId = "workspace:1", existingSurfaces: PaneRef[] = []): RuntimeDriver {
  return {
    name: "mock",
    probe: vi.fn(),
    list: vi.fn(),
    status: vi.fn().mockResolvedValue({ id: captainId, name: CAPTAIN_NAME, status: "running" }),
    spawn: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(),
    stop: vi.fn(),
    newPane: vi.fn().mockImplementation(({ title }) => Promise.resolve({ ...makePaneRef(), title })),
    closePane: vi.fn().mockResolvedValue(undefined),
    sendToPane: vi.fn().mockResolvedValue(undefined),
    readPaneScreen: vi.fn().mockResolvedValue(""),
    listSurfaces: vi.fn().mockResolvedValue(existingSurfaces),
    spawnInjector: vi.fn(),
    sendToSurface: vi.fn(),
  } as unknown as RuntimeDriver;
}

function makeAgent(name = "claude"): ResolvedAgent {
  return {
    name,
    templateSuffix: name,
    buildCommand: vi.fn().mockReturnValue(`${name}-cli --interactive`),
  };
}

function makeSpawnDeps(runtime: RuntimeDriver, agent: ResolvedAgent): CrewSpawnDeps {
  const rec: TaskRecord = {
    id: "task-001",
    project: PROJECT,
    provider: "claude",
    mode: "interactive",
    state: "submitted",
    task: "do work",
    cwd: PROJ_PATH,
    createdAt: 0,
    lastHeartbeat: 0,
    lastEvent: "dispatch",
    heartbeatBudgetMs: 300000,
    attempts: [],
  };
  return {
    runtime,
    resolveAgent: vi.fn().mockReturnValue(agent),
    dispatchCrew: vi.fn().mockResolvedValue(rec),
    writeSettingsLocal: vi.fn(),
    writeOpencodeConfig: vi.fn().mockReturnValue("/fake/opencode.json"),
    sendFirstTurn: vi.fn().mockResolvedValue(undefined),
    getFreePort: vi.fn().mockResolvedValue(9876),
    sendCodexFirstTurn: vi.fn().mockResolvedValue(undefined),
    onRouted: vi.fn(),
  };
}

// Reset call counts between tests; restore implementations that vi.clearAllMocks() clears.
beforeEach(() => {
  vi.clearAllMocks();
  addWorktreeMock.mockImplementation(
    (spec: { repoRoot: string; project: string; name: string }) =>
      `${spec.repoRoot}/.worktrees/${spec.project}-${spec.name}`,
  );
  resolveWorktreeBaseMock.mockReturnValue("main");
  loadConfigMock.mockReturnValue(makeConfig());
});

// ─── runCrewSpawn ────────────────────────────────────────────────────────────

describe("runCrewSpawn", () => {
  it("throws when project is not in config", async () => {
    const config = makeConfig();
    const runtime = makeRuntime();
    const deps = makeSpawnDeps(runtime, makeAgent());
    await expect(runCrewSpawn({ project: "unknown", task: "do work" }, config, deps)).rejects.toThrow(
      "Project 'unknown' not found",
    );
  });

  it("throws when captain is not running", async () => {
    const config = makeConfig();
    const runtime = makeRuntime();
    vi.mocked(runtime.status).mockResolvedValue(null);
    const deps = makeSpawnDeps(runtime, makeAgent());
    await expect(runCrewSpawn({ project: PROJECT, task: "do work" }, config, deps)).rejects.toThrow(
      "is not running",
    );
  });

  it("throws when crew name is already taken", async () => {
    const config = makeConfig();
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    const deps = makeSpawnDeps(runtime, makeAgent());
    await expect(
      runCrewSpawn({ project: PROJECT, task: "do work", name: "crew-1" }, config, deps),
    ).rejects.toThrow("already exists");
  });

  it("auto-names to crew-1 when no crews exist", async () => {
    const config = makeConfig();
    const runtime = makeRuntime();
    const deps = makeSpawnDeps(runtime, makeAgent());
    const pane = await runCrewSpawn({ project: PROJECT, task: "do work" }, config, deps);
    expect(pane.title).toBe("🔧 myproj:crew-1");
  });

  it("auto-names to crew-2 when crew-1 already exists", async () => {
    const config = makeConfig();
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    const deps = makeSpawnDeps(runtime, makeAgent());
    const pane = await runCrewSpawn({ project: PROJECT, task: "do work" }, config, deps);
    expect(pane.title).toBe("🔧 myproj:crew-2");
  });

  it("throws for unknown agent", async () => {
    const config = makeConfig();
    const runtime = makeRuntime();
    const deps = makeSpawnDeps(runtime, makeAgent());
    deps.resolveAgent = vi.fn().mockReturnValue(null);
    await expect(
      runCrewSpawn({ project: PROJECT, task: "do work", agent: "bogus" }, config, deps),
    ).rejects.toThrow("Unknown agent 'bogus'");
  });

  describe("claude branch", () => {
    it("dispatches, writes settings, launches pane, sends first turn", async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      const agent = makeAgent("claude");
      const deps = makeSpawnDeps(runtime, agent);

      await runCrewSpawn({ project: PROJECT, task: "fix the bug" }, config, deps);

      expect(deps.dispatchCrew).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "claude", mode: "interactive", project: PROJECT }),
      );
      expect(deps.writeSettingsLocal).toHaveBeenCalledWith(expect.stringContaining(PROJ_PATH));
      expect(runtime.newPane).toHaveBeenCalledOnce();
      expect(runtime.sendToPane).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("SQUADRANT_CREW_TASK_ID=task-001"),
      );
      expect(deps.sendFirstTurn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("squadrant crew signal done"),
        expect.any(String),
      );
    });

    it("respects permissionMode from config", async () => {
      const config = makeConfig({ permissions: { command: "auto", captain: "auto", crew: "auto" } });
      const runtime = makeRuntime();
      const agent = makeAgent("claude");
      const deps = makeSpawnDeps(runtime, agent);
      await runCrewSpawn({ project: PROJECT, task: "t" }, config, deps);
      expect(agent.buildCommand).toHaveBeenCalledWith(
        expect.objectContaining({ permissionMode: "auto" }),
      );
    });

    it("uses worktree cwd by default (no --shared)", async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      const agent = makeAgent("claude");
      const deps = makeSpawnDeps(runtime, agent);
      await runCrewSpawn({ project: PROJECT, task: "t" }, config, deps);
      expect(addWorktreeMock).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: PROJ_PATH, project: PROJECT }),
      );
    });

    it("uses proj.path for --shared (no addWorktree)", async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      const agent = makeAgent("claude");
      const deps = makeSpawnDeps(runtime, agent);
      await runCrewSpawn({ project: PROJECT, task: "t", shared: true }, config, deps);
      expect(addWorktreeMock).not.toHaveBeenCalled();
      expect(runtime.sendToPane).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining(`cd '${PROJ_PATH}'`),
      );
    });
  });

  describe("opencode branch", () => {
    it("gets free port, dispatches with budgetMs 86400000, writes opencode config", async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      const agent = makeAgent("opencode");
      const deps = makeSpawnDeps(runtime, agent);
      deps.resolveAgent = vi.fn().mockReturnValue(agent);

      await runCrewSpawn(
        { project: PROJECT, task: "do work", agent: "opencode", agentExplicit: true },
        config,
        deps,
      );

      expect(deps.getFreePort).toHaveBeenCalledOnce();
      expect(deps.dispatchCrew).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "opencode", budgetMs: 86400000, serverPort: 9876 }),
      );
      expect(deps.writeOpencodeConfig).toHaveBeenCalledWith(
        expect.objectContaining({ project: PROJECT, taskId: "task-001" }),
      );
      expect(deps.sendFirstTurn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ splashMarker: "Ask anything…" }),
      );
    });

    it("sets gateBash when approval flag is set", async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      const agent = makeAgent("opencode");
      const deps = makeSpawnDeps(runtime, agent);
      deps.resolveAgent = vi.fn().mockReturnValue(agent);

      await runCrewSpawn(
        { project: PROJECT, task: "t", agent: "opencode", agentExplicit: true, approval: true },
        config,
        deps,
      );

      expect(deps.writeOpencodeConfig).toHaveBeenCalledWith(
        expect.objectContaining({ gateBash: true }),
      );
    });
  });

  describe("codex branch", () => {
    it("dispatches codex, creates pane with attach command, sends first turn fire-and-forget", async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      const agent = makeAgent("codex");
      const deps = makeSpawnDeps(runtime, agent);
      deps.resolveAgent = vi.fn().mockReturnValue(agent);

      await runCrewSpawn(
        { project: PROJECT, task: "do work", agent: "codex", agentExplicit: true },
        config,
        deps,
      );

      expect(deps.dispatchCrew).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "codex", mode: "interactive" }),
      );
      expect(runtime.sendToPane).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("squadrant crew attach task-001"),
      );
      expect(deps.sendCodexFirstTurn).toHaveBeenCalledWith("task-001", "do work");
    });
  });

  describe("routing", () => {
    it("suppresses routing when agentExplicit is true", async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      const agent = makeAgent("claude");
      const deps = makeSpawnDeps(runtime, agent);
      deps.resolveAgent = vi.fn().mockReturnValue(agent);

      await runCrewSpawn(
        { project: PROJECT, task: "do work", agent: "claude", agentExplicit: true },
        config,
        deps,
      );

      expect(deps.onRouted).not.toHaveBeenCalled();
      expect(deps.resolveAgent).toHaveBeenCalledWith("claude");
    });

    it("fires onRouted and applies model when routing matches", async () => {
      const config = {
        ...makeConfig(),
        defaults: {
          ...makeConfig().defaults,
          crewRouting: {
            rules: [{ match: "daemon", agent: "opencode", tier: "standard", model: "gpt-4" }],
          },
        },
      } as unknown as SquadrantConfig;
      const runtime = makeRuntime();
      const agent = makeAgent("opencode");
      const deps = makeSpawnDeps(runtime, agent);
      deps.resolveAgent = vi.fn().mockReturnValue(agent);

      await runCrewSpawn({ project: PROJECT, task: "fix daemon bug" }, config, deps);

      expect(deps.onRouted).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "opencode", tier: "standard" }),
      );
      expect(agent.buildCommand).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-4" }),
      );
    });

    it("suppresses routing when model is explicitly provided", async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      const agent = makeAgent("claude");
      const deps = makeSpawnDeps(runtime, agent);
      deps.resolveAgent = vi.fn().mockReturnValue(agent);

      await runCrewSpawn({ project: PROJECT, task: "do work", model: "opus" }, config, deps);

      expect(deps.onRouted).not.toHaveBeenCalled();
      expect(agent.buildCommand).toHaveBeenCalledWith(
        expect.objectContaining({ model: "opus" }),
      );
    });
  });
});

// ─── runCrewSend ─────────────────────────────────────────────────────────────

describe("runCrewSend", () => {
  it("throws when crew pane not found", async () => {
    const runtime = makeRuntime("ws:1", []);
    await expect(
      runCrewSend(PROJECT, "crew-1", "hello", runtime, "ws:1", {
        listTasks: vi.fn().mockResolvedValue([]),
        emitEvent: vi.fn(),
      }),
    ).rejects.toThrow("Crew 'crew-1' not found");
  });

  it("sends message to found crew pane", async () => {
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    await runCrewSend(PROJECT, "crew-1", "hello", runtime, "workspace:1", {
      listTasks: vi.fn().mockResolvedValue([]),
      emitEvent: vi.fn(),
    });
    expect(runtime.sendToPane).toHaveBeenCalledWith(expect.anything(), "hello");
  });

  it("emits task.reopened for terminal task before sending", async () => {
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const task = { id: "t1", name: "crew-1", state: "done" } as Partial<TaskRecord>;
    await runCrewSend(PROJECT, "crew-1", "msg", runtime, "workspace:1", {
      listTasks: vi.fn().mockResolvedValue([task]),
      emitEvent,
    });
    expect(emitEvent).toHaveBeenCalledWith(PROJECT, { type: "task.reopened", id: "t1" });
    expect(runtime.sendToPane).toHaveBeenCalledWith(expect.anything(), "msg");
  });

  it("emits task.started for blocked task before sending", async () => {
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const task = { id: "t1", name: "crew-1", state: "blocked" } as Partial<TaskRecord>;
    await runCrewSend(PROJECT, "crew-1", "msg", runtime, "workspace:1", {
      listTasks: vi.fn().mockResolvedValue([task]),
      emitEvent,
    });
    expect(emitEvent).toHaveBeenCalledWith(PROJECT, { type: "task.started", id: "t1" });
  });

  it("swallows daemon errors and still delivers the message", async () => {
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    await runCrewSend(PROJECT, "crew-1", "msg", runtime, "workspace:1", {
      listTasks: vi.fn().mockRejectedValue(new Error("daemon down")),
      emitEvent: vi.fn(),
    });
    expect(runtime.sendToPane).toHaveBeenCalledWith(expect.anything(), "msg");
  });
});

// ─── runCrewRead ─────────────────────────────────────────────────────────────

describe("runCrewRead", () => {
  it("throws when crew pane not found", async () => {
    const runtime = makeRuntime("ws:1", []);
    await expect(runCrewRead(PROJECT, "crew-1", runtime, "ws:1")).rejects.toThrow(
      "Crew 'crew-1' not found",
    );
  });

  it("returns pane screen for found crew", async () => {
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    vi.mocked(runtime.readPaneScreen).mockResolvedValue("screen content");
    const result = await runCrewRead(PROJECT, "crew-1", runtime, "workspace:1");
    expect(result).toBe("screen content");
  });
});

// ─── runCrewList ─────────────────────────────────────────────────────────────

describe("runCrewList", () => {
  it("returns empty array when no crew panes", async () => {
    const runtime = makeRuntime("ws:1", []);
    const result = await runCrewList(PROJECT, runtime, "ws:1");
    expect(result).toEqual([]);
  });

  it("returns crew names from titles, excluding non-crew panes", async () => {
    const panes = [
      { ...makePaneRef("1"), title: "🔧 myproj:crew-1" },
      { ...makePaneRef("2"), title: "🔧 myproj:crew-2" },
      { ...makePaneRef("3"), title: "🗒 myproj:side-1" }, // side session — excluded
    ];
    const runtime = makeRuntime("ws:1", panes);
    const result = await runCrewList(PROJECT, runtime, "ws:1");
    expect(result).toEqual([
      { name: "crew-1", surfaceId: "surface:1" },
      { name: "crew-2", surfaceId: "surface:2" },
    ]);
  });
});

// ─── runCrewClose ────────────────────────────────────────────────────────────

describe("runCrewClose", () => {
  it("throws when neither pane nor daemon task found", async () => {
    const runtime = makeRuntime("ws:1", []);
    await expect(
      runCrewClose(PROJECT, "crew-1", runtime, "ws:1", {
        listTasks: vi.fn().mockResolvedValue([]),
        emitEvent: vi.fn(),
        closeCodexThread: vi.fn(),
      }),
    ).rejects.toThrow("Crew 'crew-1' not found");
  });

  it("closes pane and emits task.cancelled for non-terminal task", async () => {
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const task = { id: "t1", name: "crew-1", state: "working", provider: "claude", cwd: PROJ_PATH } as Partial<TaskRecord>;

    await runCrewClose(PROJECT, "crew-1", runtime, "workspace:1", {
      listTasks: vi.fn().mockResolvedValue([task]),
      emitEvent,
      closeCodexThread: vi.fn(),
    });

    expect(emitEvent).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ type: "task.cancelled", id: "t1" }),
    );
    expect(runtime.closePane).toHaveBeenCalledOnce();
  });

  it("calls closeCodexThread for codex tasks", async () => {
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    const closeCodexThread = vi.fn().mockResolvedValue(undefined);
    const task = { id: "t1", name: "crew-1", state: "working", provider: "codex", cwd: PROJ_PATH } as Partial<TaskRecord>;

    await runCrewClose(PROJECT, "crew-1", runtime, "workspace:1", {
      listTasks: vi.fn().mockResolvedValue([task]),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      closeCodexThread,
    });

    expect(closeCodexThread).toHaveBeenCalledWith("t1");
  });

  it("does not emit task.cancelled for already-terminal task", async () => {
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const task = { id: "t1", name: "crew-1", state: "done", provider: "claude", cwd: PROJ_PATH } as Partial<TaskRecord>;

    await runCrewClose(PROJECT, "crew-1", runtime, "workspace:1", {
      listTasks: vi.fn().mockResolvedValue([task]),
      emitEvent,
      closeCodexThread: vi.fn(),
    });

    expect(emitEvent).not.toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ type: "task.cancelled" }),
    );
    expect(runtime.closePane).toHaveBeenCalledOnce();
  });

  it("succeeds without throwing when pane is gone but daemon task exists (dead crew)", async () => {
    const runtime = makeRuntime("workspace:1", []);
    const task = { id: "t1", name: "crew-1", state: "done", provider: "claude", cwd: PROJ_PATH } as Partial<TaskRecord>;

    await expect(
      runCrewClose(PROJECT, "crew-1", runtime, "workspace:1", {
        listTasks: vi.fn().mockResolvedValue([task]),
        emitEvent: vi.fn().mockResolvedValue(undefined),
        closeCodexThread: vi.fn(),
      }),
    ).resolves.not.toThrow();

    expect(runtime.closePane).not.toHaveBeenCalled();
  });

  it("swallows daemon errors and still closes the pane", async () => {
    const existing = { ...makePaneRef("5"), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime("workspace:1", [existing]);

    await runCrewClose(PROJECT, "crew-1", runtime, "workspace:1", {
      listTasks: vi.fn().mockRejectedValue(new Error("daemon down")),
      emitEvent: vi.fn(),
      closeCodexThread: vi.fn(),
    });

    // pane found, pane closed; no throw despite daemon error
    expect(runtime.closePane).toHaveBeenCalledOnce();
  });
});
