import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskRecord } from "@squadrant/shared";
import { resolveApproveTarget } from "../crew-control.js";

// ─── resolveApproveTarget (pure) ───────────────────────────────────────────

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    project: "brove",
    provider: "claude",
    mode: "interactive",
    state: "review",
    task: "add the flag",
    createdAt: 0,
    lastHeartbeat: 0,
    lastEvent: "task.review",
    heartbeatBudgetMs: 300000,
    attempts: [],
    ...overrides,
  };
}

describe("resolveApproveTarget (#599)", () => {
  it("returns null when no task record matches the crew name", () => {
    expect(resolveApproveTarget([], "fix-579")).toBeNull();
    expect(resolveApproveTarget([makeTask({ name: "other-crew" })], "fix-579")).toBeNull();
  });

  it("resolves the matching record", () => {
    const task = makeTask({ name: "fix-579" });
    expect(resolveApproveTarget([task], "fix-579")).toEqual(task);
  });

  it("picks the most-recently-created record when duplicates exist (#574 tie-break)", () => {
    const older = makeTask({ id: "old", name: "fix-579", createdAt: 100 });
    const newer = makeTask({ id: "new", name: "fix-579", createdAt: 200 });
    expect(resolveApproveTarget([older, newer], "fix-579")).toEqual(newer);
  });
});

// ─── runCrewApprove (integration, mocked seams) ────────────────────────────

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/shared")>("@squadrant/shared");
  return { ...actual, loadConfig };
});

describe("runCrewApprove (#599)", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
  });

  async function runAction(
    project: string,
    crew: string,
    deps: Partial<Parameters<typeof import("../crew-control.js").runCrewApprove>[2]> = {},
  ) {
    const { runCrewApprove } = await import("../crew-control.js");
    return runCrewApprove(project, crew, {
      call: vi.fn().mockResolvedValue(undefined),
      pushBranch: vi.fn(),
      createPr: vi.fn().mockReturnValue("https://github.com/x/y/pull/1"),
      ...deps,
    });
  }

  it("throws the standard 404 when the project isn't registered", async () => {
    loadConfig.mockReturnValue({ projects: {} });
    await expect(runAction("ghost", "crew-1")).rejects.toThrow("Project 'ghost' not found. Run 'squadrant projects list'.");
  });

  it("throws a clear error when the crew name has no task record", async () => {
    const call = vi.fn().mockResolvedValue([]);
    await expect(runAction("brove", "ghost-crew", { call })).rejects.toThrow(
      "Crew 'ghost-crew' not found for brove. Run 'squadrant crew list brove'.",
    );
  });

  it("throws when the crew is not in 'review' state — approve is only valid after signal review", async () => {
    const call = vi.fn().mockResolvedValue([
      { id: "t1", name: "fix-579", state: "working", cwd: "/repo/.worktrees/brove-fix-579", createdAt: 1 },
    ]);
    await expect(runAction("brove", "fix-579", { call })).rejects.toThrow(
      "Crew 'fix-579' is not awaiting review (state=working). Only a crew that signaled 'review' can be approved.",
    );
  });

  it("pushes the branch, opens the PR, then emits task.done to terminalize", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce([
        { id: "t1", name: "fix-579", state: "review", cwd: "/repo/.worktrees/brove-fix-579", task: "add the flag", reviewNote: "done, tests green", createdAt: 1 },
      ])
      .mockResolvedValueOnce(undefined);
    const pushBranch = vi.fn();
    const createPr = vi.fn().mockReturnValue("https://github.com/x/y/pull/42");

    const prUrl = await runAction("brove", "fix-579", { call, pushBranch, createPr });

    expect(pushBranch).toHaveBeenCalledWith("/repo/.worktrees/brove-fix-579", "crew/fix-579");
    expect(createPr).toHaveBeenCalledWith("/repo/.worktrees/brove-fix-579", {
      base: "develop",
      branch: "crew/fix-579",
      title: "add the flag",
      body: "done, tests green",
    });
    expect(call).toHaveBeenLastCalledWith({
      kind: "event",
      project: "brove",
      event: { type: "task.done", id: "t1", resultRef: "", message: "Approved — PR opened: https://github.com/x/y/pull/42" },
    });
    expect(prUrl).toBe("https://github.com/x/y/pull/42");
  });

  it("falls back to the task text as the PR body when the crew gave no review note", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce([
        { id: "t1", name: "fix-579", state: "review", cwd: "/repo", task: "add the flag", createdAt: 1 },
      ])
      .mockResolvedValueOnce(undefined);
    const createPr = vi.fn().mockReturnValue("https://x/1");
    await runAction("brove", "fix-579", { call, createPr });
    expect(createPr).toHaveBeenCalledWith("/repo", expect.objectContaining({ body: "add the flag" }));
  });

  it("falls back to the project root as cwd for a --shared crew with no recorded cwd", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce([{ id: "t1", name: "quick-fix", state: "review", task: "x", createdAt: 1 }])
      .mockResolvedValueOnce(undefined);
    const pushBranch = vi.fn();
    await runAction("brove", "quick-fix", { call, pushBranch });
    expect(pushBranch).toHaveBeenCalledWith("/repo", "crew/quick-fix");
  });

  it("never emits task.done when pushBranch throws (push failure aborts before terminalizing)", async () => {
    const call = vi.fn().mockResolvedValueOnce([
      { id: "t1", name: "fix-579", state: "review", cwd: "/repo", task: "x", createdAt: 1 },
    ]);
    const pushBranch = vi.fn().mockImplementation(() => { throw new Error("push rejected"); });
    await expect(runAction("brove", "fix-579", { call, pushBranch })).rejects.toThrow("push rejected");
    expect(call).toHaveBeenCalledTimes(1); // only the initial list — no task.done emitted
  });
});
