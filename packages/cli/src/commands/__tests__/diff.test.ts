import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskRecord } from "@squadrant/shared";
import { resolveDiffTarget, resolveDiffSources } from "../diff.js";
import type { DiffOptions } from "../diff.js";

// ─── resolveDiffTarget (pure) ──────────────────────────────────────────────

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    project: "brove",
    provider: "claude",
    mode: "interactive",
    state: "working",
    task: "fix the thing",
    createdAt: 0,
    lastHeartbeat: 0,
    lastEvent: "task.started",
    heartbeatBudgetMs: 300000,
    attempts: [],
    ...overrides,
  };
}

describe("resolveDiffTarget (#596)", () => {
  it("returns null when no task record matches the crew name", () => {
    expect(resolveDiffTarget([], "fix-579", "/repo")).toBeNull();
    expect(resolveDiffTarget([makeTask({ name: "other-crew" })], "fix-579", "/repo")).toBeNull();
  });

  it("resolves an isolated-worktree crew: cwd = task.cwd, isShared = false", () => {
    const tasks = [makeTask({ name: "fix-579", cwd: "/repo/.worktrees/brove-fix-579" })];
    expect(resolveDiffTarget(tasks, "fix-579", "/repo")).toEqual({
      cwd: "/repo/.worktrees/brove-fix-579",
      isShared: false,
    });
  });

  it("resolves a --shared crew (cwd === projectPath) as isShared: true", () => {
    const tasks = [makeTask({ name: "quick-fix", cwd: "/repo" })];
    expect(resolveDiffTarget(tasks, "quick-fix", "/repo")).toEqual({ cwd: "/repo", isShared: true });
  });

  it("picks the most-recently-created record when duplicates exist (#574 tie-break)", () => {
    const tasks = [
      makeTask({ id: "old", name: "fix-579", cwd: "/repo/.worktrees/old", createdAt: 100 }),
      makeTask({ id: "new", name: "fix-579", cwd: "/repo/.worktrees/new", createdAt: 200 }),
    ];
    expect(resolveDiffTarget(tasks, "fix-579", "/repo")).toEqual({
      cwd: "/repo/.worktrees/new",
      isShared: false,
    });
  });

  it("falls back to projectPath when a matched task has no cwd recorded", () => {
    const tasks = [makeTask({ name: "headless-crew", cwd: undefined })];
    expect(resolveDiffTarget(tasks, "headless-crew", "/repo")).toEqual({ cwd: "/repo", isShared: true });
  });
});

describe("resolveDiffSources (#599)", () => {
  const base: DiffOptions = { layout: "split", focus: true };

  it("no working-tree flag → empty array (falls back to branch-vs-base)", () => {
    expect(resolveDiffSources(base)).toEqual([]);
  });

  it("--staged → ['staged']", () => {
    expect(resolveDiffSources({ ...base, staged: true })).toEqual(["staged"]);
  });

  it("--unstaged → ['unstaged']", () => {
    expect(resolveDiffSources({ ...base, unstaged: true })).toEqual(["unstaged"]);
  });

  it("--working → both, unstaged first (VSCode 'Changes' before 'Staged Changes')", () => {
    expect(resolveDiffSources({ ...base, working: true })).toEqual(["unstaged", "staged"]);
  });

  it("--working wins when combined with --staged/--unstaged", () => {
    expect(resolveDiffSources({ ...base, working: true, staged: true, unstaged: true })).toEqual(["unstaged", "staged"]);
  });
});

// ─── diff command action (integration, mocked seams) ──────────────────────

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/shared")>("@squadrant/shared");
  return { ...actual, loadConfig };
});

const squadrantdCall = vi.hoisted(() => vi.fn());
vi.mock("../crew-control.js", () => ({ squadrantdCall }));

const showDiff = vi.hoisted(() => vi.fn());
const resolveCaptainWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/workspaces", () => ({ resolveCaptainWorkspace }));

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));

describe("diffCommand action", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    squadrantdCall.mockReset();
    showDiff.mockReset();
    resolveCaptainWorkspace.mockReset();
    execFileSync.mockReset();
    resolveCaptainWorkspace.mockResolvedValue({ runtime: { name: "cmux", showDiff }, workspaceId: "workspace:1" });
  });

  async function runAction(project: string, crew: string, opts: Partial<DiffOptions> = {}) {
    const { runDiff } = await import("../diff.js");
    await runDiff(project, crew, { layout: "split", focus: true, ...opts });
  }

  it("throws the standard 404 when the project isn't registered", async () => {
    loadConfig.mockReturnValue({ projects: {} });
    await expect(runAction("ghost", "crew-1")).rejects.toThrow(
      "Project 'ghost' not found. Run 'squadrant projects list'.",
    );
  });

  it("throws a clear error when the crew name has no task record", async () => {
    loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
    squadrantdCall.mockResolvedValue([]);
    await expect(runAction("brove", "ghost-crew")).rejects.toThrow(
      "Crew 'ghost-crew' not found for brove. Run 'squadrant crew list brove'.",
    );
  });

  it("prints the no-changes message and never opens the diff viewer when the diff is empty", async () => {
    loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
    squadrantdCall.mockResolvedValue([
      { id: "t1", name: "fix-579", cwd: "/repo/.worktrees/brove-fix-579", createdAt: 1 },
    ]);
    execFileSync.mockReturnValue("");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAction("brove", "fix-579");
    expect(logSpy).toHaveBeenCalledWith("No changes on crew/fix-579 vs develop.");
    expect(showDiff).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("opens cmux diff with the resolved worktree/base/title on the happy path", async () => {
    loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
    squadrantdCall.mockResolvedValue([
      { id: "t1", name: "fix-579", cwd: "/repo/.worktrees/brove-fix-579", createdAt: 1 },
    ]);
    execFileSync.mockReturnValue(" 1 file changed, 2 insertions(+)\n");
    await runAction("brove", "fix-579", { layout: "unified", lastTurn: true, focus: false });
    expect(showDiff).toHaveBeenCalledWith({
      workspaceId: "workspace:1",
      cwd: "/repo/.worktrees/brove-fix-579",
      base: "develop",
      title: "crew/fix-579 vs develop",
      layout: "unified",
      focus: false,
      lastTurn: true,
      source: "branch",
    });
  });

  it("diffs base...HEAD on the root checkout for a --shared crew", async () => {
    loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
    squadrantdCall.mockResolvedValue([{ id: "t1", name: "quick-fix", cwd: "/repo", createdAt: 1 }]);
    execFileSync.mockReturnValue(" 1 file changed, 1 insertion(+)\n");
    await runAction("brove", "quick-fix");
    expect(execFileSync).toHaveBeenCalledWith(
      "git", ["-C", "/repo", "diff", "--stat", "develop...HEAD"], expect.any(Object),
    );
    expect(showDiff).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", base: "develop" }));
  });

  it("errors clearly when the resolved runtime has no showDiff capability (non-cmux, Phase 1 scope)", async () => {
    loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
    squadrantdCall.mockResolvedValue([
      { id: "t1", name: "fix-579", cwd: "/repo/.worktrees/brove-fix-579", createdAt: 1 },
    ]);
    execFileSync.mockReturnValue(" 1 file changed\n");
    resolveCaptainWorkspace.mockResolvedValue({ runtime: { name: "tmux" }, workspaceId: "workspace:1" });
    await expect(runAction("brove", "fix-579")).rejects.toThrow(
      "Runtime 'tmux' has no native diff viewer yet — Phase 1 supports cmux only.",
    );
  });

  // ── #599 Phase A: --staged/--unstaged/--working working-tree peek ──────

  beforeEach(() => {
    loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
    squadrantdCall.mockResolvedValue([
      { id: "t1", name: "fix-579", cwd: "/repo/.worktrees/brove-fix-579", createdAt: 1 },
    ]);
  });

  it("--staged opens a single 'staged' diff gated on `git diff --cached --stat`", async () => {
    execFileSync.mockReturnValue(" 1 file changed, 1 insertion(+)\n");
    await runAction("brove", "fix-579", { staged: true });
    expect(execFileSync).toHaveBeenCalledWith(
      "git", ["-C", "/repo/.worktrees/brove-fix-579", "diff", "--stat", "--cached"], expect.any(Object),
    );
    expect(showDiff).toHaveBeenCalledWith(expect.objectContaining({ source: "staged", cwd: "/repo/.worktrees/brove-fix-579" }));
    expect(showDiff).toHaveBeenCalledTimes(1);
  });

  it("--unstaged opens a single 'unstaged' diff gated on `git diff --stat`", async () => {
    execFileSync.mockReturnValue(" 1 file changed, 1 insertion(+)\n");
    await runAction("brove", "fix-579", { unstaged: true });
    expect(execFileSync).toHaveBeenCalledWith(
      "git", ["-C", "/repo/.worktrees/brove-fix-579", "diff", "--stat"], expect.any(Object),
    );
    expect(showDiff).toHaveBeenCalledWith(expect.objectContaining({ source: "unstaged" }));
    expect(showDiff).toHaveBeenCalledTimes(1);
  });

  it("--working opens BOTH unstaged and staged diffs when both have changes", async () => {
    execFileSync.mockReturnValue(" 1 file changed\n");
    await runAction("brove", "fix-579", { working: true });
    expect(showDiff).toHaveBeenCalledTimes(2);
    expect(showDiff).toHaveBeenNthCalledWith(1, expect.objectContaining({ source: "unstaged" }));
    expect(showDiff).toHaveBeenNthCalledWith(2, expect.objectContaining({ source: "staged" }));
  });

  it("--working skips a source with no changes and still opens the other", async () => {
    execFileSync.mockImplementation((_bin: string, args: string[]) =>
      args.includes("--cached") ? "" : " 1 file changed\n",
    );
    await runAction("brove", "fix-579", { working: true });
    expect(showDiff).toHaveBeenCalledTimes(1);
    expect(showDiff).toHaveBeenCalledWith(expect.objectContaining({ source: "unstaged" }));
  });

  it("--working prints a no-changes message and never opens the viewer when both sources are empty", async () => {
    execFileSync.mockReturnValue("");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAction("brove", "fix-579", { working: true });
    expect(logSpy).toHaveBeenCalledWith("No staged or unstaged changes on crew/fix-579.");
    expect(showDiff).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("--staged prints a source-specific no-changes message when empty", async () => {
    execFileSync.mockReturnValue("");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAction("brove", "fix-579", { staged: true });
    expect(logSpy).toHaveBeenCalledWith("No staged changes on crew/fix-579.");
    expect(showDiff).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
