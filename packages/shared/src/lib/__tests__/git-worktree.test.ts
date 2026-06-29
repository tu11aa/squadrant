import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const merged = { ...actual, execFileSync: execFileSyncMock };
  return { ...merged, default: merged };
});

import { worktreePath, crewBranch, addWorktree, removeWorktree, resolveWorktreeBase } from "../git-worktree.js";

describe("worktreePath", () => {
  it("resolves <repoRoot>/<worktreeDir>/<project>-<name>", () => {
    expect(worktreePath("/tmp/brove", ".worktrees", "brove", "crew-1")).toBe(
      path.resolve("/tmp/brove", ".worktrees", "brove-crew-1"),
    );
  });

  it("honors a custom worktreeDir from config", () => {
    expect(worktreePath("/tmp/brove", ".wt", "brove", "fix-typos")).toBe(
      path.resolve("/tmp/brove", ".wt", "brove-fix-typos"),
    );
  });
});

describe("crewBranch", () => {
  it("namespaces the crew name under crew/", () => {
    expect(crewBranch("crew-1")).toBe("crew/crew-1");
  });
});

describe("addWorktree", () => {
  beforeEach(() => execFileSyncMock.mockReset());

  it("runs `git -C <repo> worktree add <path> -b crew/<name> <base>` and returns the path", () => {
    // No existing branch: show-ref throws (not found), worktree add succeeds.
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("not found"); }); // show-ref
    execFileSyncMock.mockReturnValue(Buffer.from("")); // worktree add

    const wt = addWorktree({
      repoRoot: "/tmp/brove",
      worktreeDir: ".worktrees",
      project: "brove",
      name: "crew-1",
      base: "develop",
    });

    const expectedPath = path.resolve("/tmp/brove", ".worktrees", "brove-crew-1");
    expect(wt).toBe(expectedPath);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/brove", "worktree", "add", expectedPath, "-b", "crew/crew-1", "develop"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  // ── #460: stale branch collision handling ──────────────────────────────────

  it("deletes and recreates the branch when it exists but has no unique commits (merged)", () => {
    // show-ref succeeds (branch exists), log returns empty (no unique commits),
    // branch -D succeeds, worktree add succeeds.
    execFileSyncMock.mockReturnValueOnce(Buffer.from(""));   // show-ref: branch exists
    execFileSyncMock.mockReturnValueOnce(Buffer.from(""));   // log: no unique commits
    execFileSyncMock.mockReturnValueOnce(Buffer.from(""));   // branch -D
    execFileSyncMock.mockReturnValue(Buffer.from(""));       // worktree add

    const spec = { repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "fix-1", base: "develop" };
    const wt = addWorktree(spec);

    const expectedPath = path.resolve("/tmp/brove", ".worktrees", "brove-fix-1");
    expect(wt).toBe(expectedPath);

    // branch -D must have been called
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/brove", "branch", "-D", "crew/fix-1"],
      expect.objectContaining({ stdio: "pipe" }),
    );
    // worktree add must use the original branch name
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/brove", "worktree", "add", expectedPath, "-b", "crew/fix-1", "develop"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("uniquifies the branch and path when the existing branch has unique commits (preserves history)", () => {
    // show-ref for original branch: exists; log: has commits;
    // show-ref for -2 branch: not found; worktree add with -2: succeeds.
    execFileSyncMock.mockReturnValueOnce(Buffer.from(""));                            // show-ref crew/fix-1: exists
    execFileSyncMock.mockReturnValueOnce(Buffer.from("abc123 some commit\n"));        // log: has commits
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("not found"); }); // show-ref crew/fix-1-2: not found
    execFileSyncMock.mockReturnValue(Buffer.from(""));                                // worktree add

    const spec = { repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "fix-1", base: "develop" };
    const wt = addWorktree(spec);

    // Path and branch should be uniquified to -2
    const expectedPath = path.resolve("/tmp/brove", ".worktrees", "brove-fix-1-2");
    expect(wt).toBe(expectedPath);

    // branch -D must NOT have been called (original branch with commits is untouched)
    const deleteCalls = execFileSyncMock.mock.calls.filter((c) => Array.isArray(c[1]) && c[1].includes("-D"));
    expect(deleteCalls).toHaveLength(0);

    // worktree add uses the uniquified name
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/brove", "worktree", "add", expectedPath, "-b", "crew/fix-1-2", "develop"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });
});

describe("resolveWorktreeBase", () => {
  beforeEach(() => execFileSyncMock.mockReset());

  it("returns the branch name from origin/HEAD when set", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("refs/remotes/origin/main\n"));
    expect(resolveWorktreeBase("/tmp/repo")).toBe("main");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/repo", "symbolic-ref", "refs/remotes/origin/HEAD"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });

  it("returns a non-main default branch when origin/HEAD points to it", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("refs/remotes/origin/develop\n"));
    expect(resolveWorktreeBase("/tmp/repo")).toBe("develop");
  });

  it("falls back to 'develop' when git returns undefined (no origin/HEAD)", () => {
    // vitest v3 re-reports errors thrown from mockImplementation even when caught
    // by production code. Instead, return undefined so .toString() throws a
    // TypeError inside the try block — same branch, correctly caught by catch{}.
    execFileSyncMock.mockReturnValue(undefined);
    expect(resolveWorktreeBase("/tmp/repo")).toBe("develop");
  });

  it("uses a custom fallback when provided and git fails", () => {
    execFileSyncMock.mockReturnValue(undefined);
    expect(resolveWorktreeBase("/tmp/repo", "trunk")).toBe("trunk");
  });
});

describe("removeWorktree", () => {
  beforeEach(() => execFileSyncMock.mockReset());

  it("runs `git -C <repo> worktree remove <path>` (no --force on the happy path)", () => {
    removeWorktree("/tmp/brove", "/tmp/brove/.worktrees/brove-crew-1");

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/brove", "worktree", "remove", "/tmp/brove/.worktrees/brove-crew-1"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("retries with --force when a plain remove fails (dirty/locked worktree)", () => {
    let calls = 0;
    execFileSyncMock.mockImplementation(() => {
      calls++;
      if (calls === 1) throw new Error("contains modified or untracked files");
      return "";
    });

    removeWorktree("/tmp/brove", "/tmp/brove/.worktrees/brove-crew-1");

    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(execFileSyncMock).toHaveBeenLastCalledWith(
      "git",
      ["-C", "/tmp/brove", "worktree", "remove", "--force", "/tmp/brove/.worktrees/brove-crew-1"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });
});
