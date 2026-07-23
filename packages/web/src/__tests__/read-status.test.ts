import { describe, it, expect } from "vitest";
import type { SquadrantConfig } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import type { ComponentHealth } from "@squadrant/core";
import type { ReadStatusDeps } from "../read-status.js";
import { readAllStatuses, deriveRowState } from "../read-status.js";

function makeConfig(): SquadrantConfig {
  return {
    commandName: "command",
    hubVault: "/tmp/hub",
    projects: {
      brove:  { path: "/tmp/brove",  captainName: "brove-captain",  spokeVault: "/tmp/spokes/brove",  host: "local" },
      solder: { path: "/tmp/solder", captainName: "solder-captain", spokeVault: "/tmp/spokes/solder", host: "local" },
    },
    defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
    metrics: { enabled: false, path: "" },
  };
}

function mkTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    project: "brove",
    provider: "claude",
    mode: "headless",
    state: "done",
    task: "some task",
    createdAt: Date.now(),
    lastHeartbeat: Date.now(),
    lastEvent: "task.done",
    heartbeatBudgetMs: 300000,
    attempts: [],
    ...overrides,
  };
}

function makeAliveCall(extra: Record<string, ComponentHealth["state"]> = {}): ReadStatusDeps["call"] {
  return async (req: unknown) => {
    const r = req as { kind: string; project?: string };
    if (r.kind === "health") {
      return [
        { kind: "captain", project: "brove", ref: "brove-captain", state: extra.brove ?? "alive", lastSeenMs: null },
        { kind: "captain", project: "solder", ref: "solder-captain", state: extra.solder ?? "alive", lastSeenMs: null },
      ] as ComponentHealth[];
    }
    if (r.kind === "list") return [];
    throw new Error(`unexpected request kind: ${r.kind}`);
  };
}

describe("readAllStatuses", () => {
  it("returns one row per registered project", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      listTasks: async () => [],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].project).toBe("brove");
    expect(rows[1].project).toBe("solder");
  });

  it("maps state to idle when no tasks or all done", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [mkTask({ state: "done" }), mkTask({ state: "submitted" })],
    });

    expect(rows[0].state).toBe("idle");
  });

  it("maps state to busy when any task is working", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [mkTask({ state: "working" })],
    });

    expect(rows[0].state).toBe("busy");
  });

  it("maps state to blocked when any task is blocked", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [mkTask({ state: "blocked" })],
    });

    expect(rows[0].state).toBe("blocked");
  });

  it("maps state to blocked when any task is awaiting-input", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [mkTask({ state: "awaiting-input" })],
    });

    expect(rows[0].state).toBe("blocked");
  });

  it("maps state to blocked when any task is awaiting review (#599)", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [mkTask({ state: "review" })],
    });

    expect(rows[0].state).toBe("blocked");
  });

  it("maps state to errored when any task has failed", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [mkTask({ state: "failed" })],
    });

    expect(rows[0].state).toBe("errored");
  });

  it("maps state to errored when any task is stalled", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [mkTask({ state: "stalled" })],
    });

    expect(rows[0].state).toBe("errored");
  });

  it("state precedence: blocked beats errored", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [
        mkTask({ state: "blocked" }),
        mkTask({ state: "failed" }),
        mkTask({ state: "working" }),
      ],
    });

    expect(rows[0].state).toBe("blocked");
  });

  it("state precedence: errored beats busy", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [
        mkTask({ state: "failed" }),
        mkTask({ state: "working" }),
      ],
    });

    expect(rows[0].state).toBe("errored");
  });

  it("yields offline when daemon rejects", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      listTasks: async () => { throw new Error("daemon unreachable"); },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe("offline");
    expect(rows[0].lastChecked).toBeTruthy();
    expect(rows[0].captainWorkspace).toBe("brove-captain");
  });

  it("preserves project name from config", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall({ brove: "alive", solder: "alive" }),
      listTasks: async (project) => {
        if (project === "brove") return [mkTask({ state: "working", task: "brove task" })];
        return [mkTask({ state: "done", task: "solder task" })];
      },
    });

    expect(rows[0].project).toBe("brove");
    expect(rows[1].project).toBe("solder");
  });

  it("builds excerpt with active task titles", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [
        mkTask({ state: "working", name: "feat-x", task: "build feature x" }),
        mkTask({ state: "blocked", name: "fix-y", task: "fix bug y" }),
      ],
    });

    expect(rows[0].excerpt).toContain("1 working");
    expect(rows[0].excerpt).toContain("1 blocked");
    expect(rows[0].excerpt).toContain("feat-x");
    expect(rows[0].excerpt).toContain("fix-y");
  });

  it("counts a 'review' task into the blocked bucket and its title into the excerpt (#599)", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [mkTask({ state: "review", name: "fix-579", task: "add the flag" })],
    });

    expect(rows[0].excerpt).toContain("1 blocked");
    expect(rows[0].excerpt).toContain("fix-579");
  });

  it("builds summary-only excerpt when no active tasks", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [mkTask({ state: "done" })],
    });

    expect(rows[0].excerpt).toBe("idle");
  });

  it("sets lastChecked to current ISO timestamp", async () => {
    const before = Date.now();
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall(),
      listTasks: async () => [],
    });
    const after = Date.now();
    const ts = Date.parse(rows[0].lastChecked);

    expect(ts).not.toBeNaN();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("per-project daemon isolation: one offline, one busy", async () => {
    let callCount = 0;
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: makeAliveCall({ solder: "alive" }),
      listTasks: async (project) => {
        callCount++;
        if (project === "brove") throw new Error("down");
        return [mkTask({ state: "working" })];
      },
    });

    expect(rows[0].state).toBe("offline");
    expect(rows[1].state).toBe("busy");
    expect(callCount).toBe(2);
  });

  it("captain unknown → offline when health endpoint omitted a project", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: async (req: unknown) => {
        const r = req as { kind: string; project?: string };
        if (r.kind === "health") return [] as ComponentHealth[]; // no captain entries at all
        if (r.kind === "list") return [mkTask({ state: "working" })];
        throw new Error(`unexpected request kind: ${r.kind}`);
      },
    });

    // Both projects have working tasks but both captains are unknown (not in health)
    expect(rows[0].state).toBe("offline");
    expect(rows[1].state).toBe("offline");
  });

  it("captain state from health dominates task-derived state, fetched once and indexed per project", async () => {
    let healthCalls = 0;
    const rows = await readAllStatuses({
      config: makeConfig(),
      call: async (req: unknown) => {
        const r = req as { kind: string; project?: string };
        if (r.kind === "health") {
          healthCalls++;
          return [
            { kind: "captain", project: "brove", ref: "brove-captain", state: "gone", lastSeenMs: null },
            { kind: "captain", project: "solder", ref: "solder-captain", state: "alive", lastSeenMs: null },
          ] as ComponentHealth[];
        }
        if (r.kind === "list") return [mkTask({ state: "working" })];
        throw new Error(`unexpected request kind: ${r.kind}`);
      },
    });

    expect(rows[0].state).toBe("offline"); // brove: gone dominates despite a working task
    expect(rows[1].state).toBe("busy");    // solder: alive → task-derived
    expect(healthCalls).toBe(1);           // fetched once, not per project
  });
});

describe("deriveRowState", () => {
  it("captain gone → offline regardless of working tasks", () => {
    expect(deriveRowState([mkTask({ state: "working" })], "gone")).toBe("offline");
  });
  it("captain stopped → offline", () => {
    expect(deriveRowState([], "stopped")).toBe("offline");
  });
  it("captain alive → task-derived", () => {
    expect(deriveRowState([mkTask({ state: "working" })], "alive")).toBe("busy");
  });
  it("captain unknown → offline (no registry entry = not running)", () => {
    expect(deriveRowState([], "unknown")).toBe("offline");
  });
  it("captain unknown → offline regardless of working tasks", () => {
    expect(deriveRowState([mkTask({ state: "working" })], "unknown")).toBe("offline");
  });
});
