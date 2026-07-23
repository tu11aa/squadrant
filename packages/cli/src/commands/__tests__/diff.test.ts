import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskRecord } from "@squadrant/shared";
import { resolveDiffTarget, resolveDiffSources, resolveDiffMode, buildCrewDiffStats, parseCrewPick } from "../diff.js";
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

// ─── resolveDiffMode (#604) ─────────────────────────────────────────────────

describe("resolveDiffMode (#604)", () => {
  it("crew arg only → crew mode", () => {
    expect(resolveDiffMode("fix-579", {})).toEqual({ mode: "crew", crew: "fix-579" });
  });

  it("--pr only → pr mode", () => {
    expect(resolveDiffMode(undefined, { pr: "603" })).toEqual({ mode: "pr", pr: "603" });
  });

  it("--base + --head → refs mode", () => {
    expect(resolveDiffMode(undefined, { base: "develop", head: "some/branch" })).toEqual({
      mode: "refs",
      base: "develop",
      head: "some/branch",
    });
  });

  it("--against <ref> → refs mode, base=ref, head=HEAD", () => {
    expect(resolveDiffMode(undefined, { against: "develop" })).toEqual({
      mode: "refs",
      base: "develop",
      head: "HEAD",
    });
  });

  it("no crew, no flags → pick mode", () => {
    expect(resolveDiffMode(undefined, {})).toEqual({ mode: "pick" });
  });

  it("crew + --pr → throws mutually-exclusive error", () => {
    expect(() => resolveDiffMode("fix-579", { pr: "603" })).toThrow(/mutually exclusive/);
  });

  it("crew + --base → throws mutually-exclusive error", () => {
    expect(() => resolveDiffMode("fix-579", { base: "develop", head: "x" })).toThrow(/mutually exclusive/);
  });

  it("--pr + --base → throws mutually-exclusive error", () => {
    expect(() => resolveDiffMode(undefined, { pr: "603", base: "develop", head: "x" })).toThrow(/mutually exclusive/);
  });

  it("--against + --base → throws (ambiguous)", () => {
    expect(() => resolveDiffMode(undefined, { against: "develop", base: "other" })).toThrow(/--against/);
  });

  it("--base without --head → throws (must be used together)", () => {
    expect(() => resolveDiffMode(undefined, { base: "develop" })).toThrow(/--base and --head/);
  });

  it("--head without --base → throws (must be used together)", () => {
    expect(() => resolveDiffMode(undefined, { head: "some/branch" })).toThrow(/--base and --head/);
  });
});

// ─── buildCrewDiffStats (#604) ──────────────────────────────────────────────

describe("buildCrewDiffStats (#604)", () => {
  function makeLiveTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      id: "t1", project: "brove", provider: "claude", mode: "interactive", state: "working",
      task: "fix", createdAt: 1, lastHeartbeat: 1, lastEvent: "task.started",
      heartbeatBudgetMs: 300000, attempts: [], ...overrides,
    };
  }

  it("filters out terminal-state tasks", () => {
    const tasks = [
      makeLiveTask({ name: "alive", state: "working" }),
      makeLiveTask({ id: "t2", name: "dead", state: "done" }),
    ];
    const stats = buildCrewDiffStats(tasks, "/repo", "develop", () => "1 file changed");
    expect(stats.map((s) => s.name)).toEqual(["alive"]);
  });

  it("dedups by name, keeping the most-recently-created record", () => {
    const tasks = [
      makeLiveTask({ id: "old", name: "fix-579", cwd: "/repo/.worktrees/old", createdAt: 100 }),
      makeLiveTask({ id: "new", name: "fix-579", cwd: "/repo/.worktrees/new", createdAt: 200 }),
    ];
    const stats = buildCrewDiffStats(tasks, "/repo", "develop", () => "");
    expect(stats).toHaveLength(1);
    expect(stats[0].cwd).toBe("/repo/.worktrees/new");
  });

  it("falls back to projectPath when a task has no cwd", () => {
    const tasks = [makeLiveTask({ name: "shared-crew", cwd: undefined })];
    const stats = buildCrewDiffStats(tasks, "/repo", "develop", () => "");
    expect(stats[0].cwd).toBe("/repo");
  });

  it("calls getStat with (cwd, base) and trims the result", () => {
    const tasks = [makeLiveTask({ name: "fix-579", cwd: "/repo/.worktrees/fix-579" })];
    const getStat = vi.fn().mockReturnValue("  1 file changed, 2 insertions(+)  \n");
    const stats = buildCrewDiffStats(tasks, "/repo", "develop", getStat);
    expect(getStat).toHaveBeenCalledWith("/repo/.worktrees/fix-579", "develop");
    expect(stats[0].stat).toBe("1 file changed, 2 insertions(+)");
  });

  it("skips tasks with no name (unnamed/legacy records)", () => {
    const tasks = [makeLiveTask({ name: undefined })];
    expect(buildCrewDiffStats(tasks, "/repo", "develop", () => "")).toEqual([]);
  });
});

// ─── parseCrewPick (#604) ───────────────────────────────────────────────────

describe("parseCrewPick (#604)", () => {
  const stats = [
    { name: "fix-579", cwd: "/a", stat: "1 file" },
    { name: "fix-580", cwd: "/b", stat: "2 files" },
  ];

  it("parses a 1-based numeric index", () => {
    expect(parseCrewPick("1", stats)).toBe("fix-579");
    expect(parseCrewPick("2", stats)).toBe("fix-580");
  });

  it("parses a crew name directly", () => {
    expect(parseCrewPick("fix-580", stats)).toBe("fix-580");
  });

  it("throws on an out-of-range index", () => {
    expect(() => parseCrewPick("3", stats)).toThrow(/Invalid selection/);
  });

  it("throws on an unknown name", () => {
    expect(() => parseCrewPick("ghost", stats)).toThrow(/Invalid selection/);
  });

  it("throws on empty input", () => {
    expect(() => parseCrewPick("", stats)).toThrow(/Invalid selection/);
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
const showPatch = vi.hoisted(() => vi.fn());
const resolveCaptainWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/workspaces", () => ({ resolveCaptainWorkspace }));

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));

const readlineQuestion = vi.hoisted(() => vi.fn());
vi.mock("node:readline", () => ({
  default: {
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb(readlineQuestion()),
      close: vi.fn(),
    }),
  },
}));

describe("diffCommand action", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    squadrantdCall.mockReset();
    showDiff.mockReset();
    showPatch.mockReset();
    resolveCaptainWorkspace.mockReset();
    execFileSync.mockReset();
    readlineQuestion.mockReset();
    resolveCaptainWorkspace.mockResolvedValue({ runtime: { name: "cmux", showDiff, showPatch }, workspaceId: "workspace:1" });
  });

  async function runAction(project: string, crew: string | undefined, opts: Partial<DiffOptions> = {}) {
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

  // ── #604 mode 1: --pr <N> ──────────────────────────────────────────────

  describe("--pr <N> (#604)", () => {
    beforeEach(() => {
      loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
    });

    it("runs `gh pr diff <n>` from the project path and feeds the patch to showPatch", async () => {
      execFileSync.mockReturnValue("diff --git a/x b/x\n+hi\n");
      await runAction("brove", undefined, { pr: "603" });
      expect(execFileSync).toHaveBeenCalledWith("gh", ["pr", "diff", "603"], { cwd: "/repo", encoding: "utf-8" });
      expect(showPatch).toHaveBeenCalledWith({
        workspaceId: "workspace:1",
        patch: "diff --git a/x b/x\n+hi\n",
        title: "PR #603",
        layout: "split",
        focus: true,
      });
      expect(showDiff).not.toHaveBeenCalled();
    });

    it("prints a no-changes message and never opens the viewer when the PR patch is empty", async () => {
      execFileSync.mockReturnValue("");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAction("brove", undefined, { pr: "603" });
      expect(logSpy).toHaveBeenCalledWith("No changes in PR #603.");
      expect(showPatch).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it("throws a clear error when `gh pr diff` fails (unknown PR)", async () => {
      execFileSync.mockImplementation(() => {
        throw new Error("no pull requests found for branch");
      });
      await expect(runAction("brove", undefined, { pr: "9999" })).rejects.toThrow(
        /Could not fetch PR #9999 diff/,
      );
      expect(showPatch).not.toHaveBeenCalled();
    });

    it("throws mutually-exclusive error when combined with a crew arg", async () => {
      await expect(runAction("brove", "fix-579", { pr: "603" })).rejects.toThrow(/mutually exclusive/);
      expect(squadrantdCall).not.toHaveBeenCalled();
    });

    it("errors clearly when the runtime has no showPatch capability", async () => {
      resolveCaptainWorkspace.mockResolvedValue({ runtime: { name: "tmux" }, workspaceId: "workspace:1" });
      await expect(runAction("brove", undefined, { pr: "603" })).rejects.toThrow(
        "Runtime 'tmux' has no native patch viewer yet — Phase 1 supports cmux only.",
      );
    });
  });

  // ── #604 mode 2: --base/--head, --against alias ────────────────────────

  describe("--base/--head and --against (#604)", () => {
    beforeEach(() => {
      loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
    });

    it("runs `git diff <base>...<head>` (merge-base form) and feeds the patch to showPatch", async () => {
      execFileSync.mockReturnValue("diff --git a/y b/y\n+yo\n");
      await runAction("brove", undefined, { base: "develop", head: "some/branch" });
      expect(execFileSync).toHaveBeenCalledWith(
        "git", ["-C", "/repo", "diff", "develop...some/branch"], { encoding: "utf-8" },
      );
      expect(showPatch).toHaveBeenCalledWith({
        workspaceId: "workspace:1",
        patch: "diff --git a/y b/y\n+yo\n",
        title: "develop...some/branch",
        layout: "split",
        focus: true,
      });
    });

    it("--against <ref> diffs <ref>...HEAD without needing --head", async () => {
      execFileSync.mockReturnValue("diff --git a/z b/z\n+z\n");
      await runAction("brove", undefined, { against: "develop" });
      expect(execFileSync).toHaveBeenCalledWith(
        "git", ["-C", "/repo", "diff", "develop...HEAD"], { encoding: "utf-8" },
      );
      expect(showPatch).toHaveBeenCalledWith(expect.objectContaining({ title: "develop...HEAD" }));
    });

    it("prints a no-changes message and never opens the viewer when the ref diff is empty", async () => {
      execFileSync.mockReturnValue("");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAction("brove", undefined, { base: "develop", head: "develop" });
      expect(logSpy).toHaveBeenCalledWith("No changes in develop...develop.");
      expect(showPatch).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it("throws a clear error on a bad ref", async () => {
      execFileSync.mockImplementation(() => {
        throw new Error("unknown revision or path not in the working tree");
      });
      await expect(runAction("brove", undefined, { base: "ghost-ref", head: "develop" })).rejects.toThrow(
        /Could not diff ghost-ref\.\.\.develop/,
      );
    });

    it("throws when --base is given without --head", async () => {
      await expect(runAction("brove", undefined, { base: "develop" })).rejects.toThrow(/--base and --head/);
      expect(squadrantdCall).not.toHaveBeenCalled();
    });
  });

  // ── #604 mode 3: no crew, no flags → list + pick ────────────────────────

  describe("no crew, no flags — list + pick (#604 Phase 2 of #596)", () => {
    beforeEach(() => {
      loadConfig.mockReturnValue({ projects: { brove: { path: "/repo", captainName: "brove-captain" } } });
    });

    it("lists live crews with a diffstat, prompts, and opens the picked crew's diff", async () => {
      squadrantdCall.mockResolvedValue([
        { id: "t1", name: "fix-579", cwd: "/repo/.worktrees/fix-579", createdAt: 1, state: "working" },
        { id: "t2", name: "fix-580", cwd: "/repo/.worktrees/fix-580", createdAt: 2, state: "working" },
      ]);
      execFileSync.mockImplementation((_bin: string, args: string[]) => {
        if (args.includes("--stat")) {
          return args.includes("/repo/.worktrees/fix-580") ? "2 files changed" : "1 file changed";
        }
        return "";
      });
      readlineQuestion.mockReturnValue("2");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAction("brove", undefined, {});
      expect(logSpy).toHaveBeenCalledWith("Live crews for brove (vs develop):");
      expect(showDiff).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/.worktrees/fix-580", title: "crew/fix-580 vs develop" }));
      logSpy.mockRestore();
    });

    it("throws a clear error when there are no live crews", async () => {
      squadrantdCall.mockResolvedValue([
        { id: "t1", name: "done-crew", cwd: "/repo/.worktrees/done-crew", createdAt: 1, state: "done" },
      ]);
      await expect(runAction("brove", undefined, {})).rejects.toThrow(/No live crews for brove/);
      expect(showDiff).not.toHaveBeenCalled();
    });

    it("throws a clear error on an invalid pick", async () => {
      squadrantdCall.mockResolvedValue([
        { id: "t1", name: "fix-579", cwd: "/repo/.worktrees/fix-579", createdAt: 1, state: "working" },
      ]);
      execFileSync.mockReturnValue("1 file changed");
      readlineQuestion.mockReturnValue("99");
      vi.spyOn(console, "log").mockImplementation(() => {});
      await expect(runAction("brove", undefined, {})).rejects.toThrow(/Invalid selection/);
    });
  });
});
