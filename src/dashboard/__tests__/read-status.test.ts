import { describe, it, expect } from "vitest";
import type { CockpitConfig } from "@cockpit/shared";
import type { TaskRecord } from "@cockpit/shared";
import { readAllStatuses } from "../read-status.js";

function makeConfig(): CockpitConfig {
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
      listTasks: async () => [mkTask({ state: "done" }), mkTask({ state: "submitted" })],
    });

    expect(rows[0].state).toBe("idle");
  });

  it("maps state to busy when any task is working", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      listTasks: async () => [mkTask({ state: "working" })],
    });

    expect(rows[0].state).toBe("busy");
  });

  it("maps state to blocked when any task is blocked", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      listTasks: async () => [mkTask({ state: "blocked" })],
    });

    expect(rows[0].state).toBe("blocked");
  });

  it("maps state to blocked when any task is awaiting-input", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      listTasks: async () => [mkTask({ state: "awaiting-input" })],
    });

    expect(rows[0].state).toBe("blocked");
  });

  it("maps state to errored when any task has failed", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      listTasks: async () => [mkTask({ state: "failed" })],
    });

    expect(rows[0].state).toBe("errored");
  });

  it("maps state to errored when any task is stalled", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      listTasks: async () => [mkTask({ state: "stalled" })],
    });

    expect(rows[0].state).toBe("errored");
  });

  it("state precedence: blocked beats errored", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
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

  it("builds summary-only excerpt when no active tasks", async () => {
    const rows = await readAllStatuses({
      config: makeConfig(),
      listTasks: async () => [mkTask({ state: "done" })],
    });

    expect(rows[0].excerpt).toBe("idle");
  });

  it("sets lastChecked to current ISO timestamp", async () => {
    const before = Date.now();
    const rows = await readAllStatuses({
      config: makeConfig(),
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
});
