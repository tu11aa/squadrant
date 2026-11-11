import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const merged = { ...actual, execFileSync: execFileSyncMock };
  return { ...merged, default: merged };
});

// #387: ensureSpotlightExcluded touches the real filesystem (mkdir + marker
// file) — mock it so addWorktree tests stay hermetic instead of writing into
// /tmp on a real macOS dev machine.
const mkdirSyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn((_p?: unknown) => false));
const writeFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const merged = {
    ...actual,
    mkdirSync: mkdirSyncMock,
    existsSync: existsSyncMock,
    writeFileSync: writeFileSyncMock,
  };
  return { ...merged, default: merged };
});

import { worktreePath, crewBranch, addWorktree, removeWorktree, resolveWorktreeBase, worktreeDirtyFiles } from "../git-worktree.js";

// #387: addWorktree() runs for every registered project, not just pnpm ones —
// stub existsSync per project "kind" so installWorktreeDependencies sees the
// lockfile (or absence of package.json/lockfile) a real project would have.
function mockProjectFiles(kind: "pnpm" | "yarn" | "npm" | "bun" | "no-lockfile" | "non-js"): void {
  existsSyncMock.mockReset();
  existsSyncMock.mockImplementation((p: unknown) => {
    const s = String(p);
    if (kind === "non-js") return false;
    if (s.endsWith("package.json")) return true;
    switch (kind) {
      case "pnpm": return s.endsWith("pnpm-lock.yaml");
      case "yarn": return s.endsWith("yarn.lock");
      case "npm": return s.endsWith("package-lock.json");
      case "bun": return s.endsWith("bun.lockb");
      case "no-lockfile": return false;
    }
  });
}

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
  beforeEach(() => {
    execFileSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    mockProjectFiles("pnpm"); // default: squadrant itself is a pnpm project
  });

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

  // ── #387: install a real, isolated dependency tree so a crew's own worktree
  // never silently falls through to the main checkout's node_modules ────────

  it("installs dependencies in the new worktree via `pnpm -C <wt> install --frozen-lockfile`", () => {
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("not found"); }); // show-ref
    execFileSyncMock.mockReturnValue(Buffer.from("")); // worktree add, then pnpm install

    const wt = addWorktree({
      repoRoot: "/tmp/brove",
      worktreeDir: ".worktrees",
      project: "brove",
      name: "crew-1",
      base: "develop",
    });

    expect(execFileSyncMock).toHaveBeenLastCalledWith(
      "pnpm",
      ["-C", wt, "install", "--frozen-lockfile"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("propagates a failed install instead of handing the crew a broken worktree", () => {
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("not found"); }); // show-ref
    execFileSyncMock.mockReturnValueOnce(Buffer.from("")); // worktree add
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("ERR_PNPM_FROZEN_LOCKFILE"); }); // pnpm install

    expect(() =>
      addWorktree({
        repoRoot: "/tmp/brove",
        worktreeDir: ".worktrees",
        project: "brove",
        name: "crew-1",
        base: "develop",
      }),
    ).toThrow("ERR_PNPM_FROZEN_LOCKFILE");
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

// ── #387: addWorktree() serves every registered project, not just pnpm ones ─

describe("addWorktree — stale lockfile fallback and failed-install cleanup", () => {
  const spec = { repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "crew-1", base: "develop" };
  const wt = path.resolve("/tmp/brove", ".worktrees", "brove-crew-1");
  const installErr = (stderr: string) => Object.assign(new Error("Command failed: pnpm"), { stderr: Buffer.from(stderr) });
  let stderrSpy: { mock: { calls: unknown[][] }; mockRestore(): void };

  beforeEach(() => {
    execFileSyncMock.mockReset();
    mockProjectFiles("pnpm");
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => stderrSpy.mockRestore());

  /** Script execFileSync by command: git show-ref misses; pnpm calls handled by `pnpm`. */
  function script(pnpm: (args: string[]) => Buffer, branchLog = "") {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "pnpm") return pnpm(args);
      if (args.includes("show-ref")) throw new Error("not found");
      if (args.includes("log")) return Buffer.from(branchLog);
      return Buffer.from("");
    });
  }
  const gitCalls = () => execFileSyncMock.mock.calls.filter((c) => c[0] === "git").map((c) => c[1] as string[]);

  it("retries with --no-frozen-lockfile on ERR_PNPM_OUTDATED_LOCKFILE, warns, and returns the worktree", () => {
    script((args) => {
      if (args.includes("--frozen-lockfile")) throw installErr("ERR_PNPM_OUTDATED_LOCKFILE  pnpm-lock.yaml is not up to date");
      return Buffer.from("");
    });
    expect(addWorktree(spec)).toBe(wt);
    expect(execFileSyncMock).toHaveBeenCalledWith("pnpm", ["-C", wt, "install", "--no-frozen-lockfile"], expect.anything());
    expect(String(stderrSpy.mock.calls[0][0])).toMatch(/lockfile in the repo is stale.*Do NOT commit/);
    expect(gitCalls().some((a) => a.includes("remove"))).toBe(false);
  });

  it("when the fallback also fails: removes worktree + branch and surfaces the real stderr", () => {
    script((args) => {
      throw installErr(args.includes("--frozen-lockfile") ? "ERR_PNPM_OUTDATED_LOCKFILE" : "ERR_PNPM_FETCH_404 registry unreachable");
    });
    expect(() => addWorktree(spec)).toThrow(/ERR_PNPM_FETCH_404 registry unreachable/);
    const git = gitCalls();
    expect(git).toContainEqual(["-C", "/tmp/brove", "worktree", "remove", "--force", wt]);
    expect(git).toContainEqual(["-C", "/tmp/brove", "branch", "-D", "crew/crew-1"]);
  });

  it("a non-lockfile install error does not fall back; cleans up and includes stderr", () => {
    script(() => { throw installErr("ERR_PNPM_NO_MATCHING_VERSION nothing matches"); });
    expect(() => addWorktree(spec)).toThrow(/ERR_PNPM_NO_MATCHING_VERSION nothing matches/);
    expect(execFileSyncMock.mock.calls.filter((c) => c[0] === "pnpm")).toHaveLength(1);
    expect(gitCalls()).toContainEqual(["-C", "/tmp/brove", "worktree", "remove", "--force", wt]);
    expect(gitCalls()).toContainEqual(["-C", "/tmp/brove", "branch", "-D", "crew/crew-1"]);
  });

  it("keeps the branch when it somehow holds commits beyond base", () => {
    script(() => { throw installErr("boom"); }, "abc123 a commit");
    expect(() => addWorktree(spec)).toThrow(/boom/);
    expect(gitCalls().some((a) => a.includes("-D"))).toBe(false);
  });
});

describe("addWorktree — package manager detection (#387)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("not found"); }); // show-ref
    execFileSyncMock.mockReturnValue(Buffer.from("")); // worktree add, then install
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it("installs a yarn project via `yarn install --frozen-lockfile`", () => {
    mockProjectFiles("yarn");

    const wt = addWorktree({ repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "crew-1", base: "develop" });

    expect(execFileSyncMock).toHaveBeenLastCalledWith(
      "yarn",
      ["install", "--frozen-lockfile"],
      expect.objectContaining({ cwd: wt, stdio: "pipe" }),
    );
  });

  it("installs an npm project via `npm ci`", () => {
    mockProjectFiles("npm");

    const wt = addWorktree({ repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "crew-1", base: "develop" });

    expect(execFileSyncMock).toHaveBeenLastCalledWith(
      "npm",
      ["ci"],
      expect.objectContaining({ cwd: wt, stdio: "pipe" }),
    );
  });

  it("installs a bun project via `bun install --frozen-lockfile`", () => {
    mockProjectFiles("bun");

    const wt = addWorktree({ repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "crew-1", base: "develop" });

    expect(execFileSyncMock).toHaveBeenLastCalledWith(
      "bun",
      ["install", "--frozen-lockfile"],
      expect.objectContaining({ cwd: wt, stdio: "pipe" }),
    );
  });

  it("skips install for a non-JS project (no package.json) without throwing", () => {
    mockProjectFiles("non-js");

    expect(() =>
      addWorktree({ repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "crew-1", base: "develop" }),
    ).not.toThrow();

    const nonGitCalls = execFileSyncMock.mock.calls.filter((c) => c[0] !== "git");
    expect(nonGitCalls).toHaveLength(0);
  });

  it("skips install when package.json has no recognized lockfile, without guessing a package manager, but warns on stderr", () => {
    mockProjectFiles("no-lockfile");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    let wt = "";
    expect(() => {
      wt = addWorktree({ repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "crew-1", base: "develop" });
    }).not.toThrow();

    const nonGitCalls = execFileSyncMock.mock.calls.filter((c) => c[0] !== "git");
    expect(nonGitCalls).toHaveLength(0);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining(wt));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("no lockfile"));

    stderrWrite.mockRestore();
  });
});

// ── #387: Spotlight (mds) exclusion marker on the worktree root ─────────────

describe("addWorktree — Spotlight exclusion (#387)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("not found"); }); // show-ref
    execFileSyncMock.mockReturnValue(Buffer.from("")); // worktree add, pnpm install
    mkdirSyncMock.mockReset();
    existsSyncMock.mockReset().mockReturnValue(false);
    writeFileSyncMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("drops a .metadata_never_index marker in the worktree root on darwin", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    addWorktree({ repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "crew-1", base: "develop" });

    const worktreeDirAbs = path.resolve("/tmp/brove", ".worktrees");
    expect(mkdirSyncMock).toHaveBeenCalledWith(worktreeDirAbs, { recursive: true });
    expect(writeFileSyncMock).toHaveBeenCalledWith(path.join(worktreeDirAbs, ".metadata_never_index"), "");
  });

  it("skips the marker on non-darwin platforms", () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    addWorktree({ repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "crew-1", base: "develop" });

    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("does not rewrite the marker when it already exists (one marker covers every worktree under it)", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    existsSyncMock.mockReturnValue(true);

    addWorktree({ repoRoot: "/tmp/brove", worktreeDir: ".worktrees", project: "brove", name: "crew-1", base: "develop" });

    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("resolveWorktreeBase", () => {
  beforeEach(() => execFileSyncMock.mockReset());

  it("returns the checked-out branch if it is not detached", () => {
    execFileSyncMock.mockReturnValueOnce(Buffer.from("feature-branch\n"));
    expect(resolveWorktreeBase("/tmp/repo")).toBe("feature-branch");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/repo", "rev-parse", "--abbrev-ref", "HEAD"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });

  it("falls back to origin/HEAD if HEAD is detached", () => {
    execFileSyncMock.mockReturnValueOnce(Buffer.from("HEAD\n"));
    execFileSyncMock.mockReturnValueOnce(Buffer.from("refs/remotes/origin/main\n"));
    expect(resolveWorktreeBase("/tmp/repo")).toBe("main");
  });

  it("returns the branch name from origin/HEAD when rev-parse fails", () => {
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("git error"); });
    execFileSyncMock.mockReturnValueOnce(Buffer.from("refs/remotes/origin/main\n"));
    expect(resolveWorktreeBase("/tmp/repo")).toBe("main");
  });

  it("returns a non-main default branch when origin/HEAD points to it", () => {
    execFileSyncMock.mockReturnValueOnce(Buffer.from("HEAD\n"));
    execFileSyncMock.mockReturnValueOnce(Buffer.from("refs/remotes/origin/develop\n"));
    expect(resolveWorktreeBase("/tmp/repo")).toBe("develop");
  });

  it("falls back to 'develop' when git returns undefined (no origin/HEAD)", () => {
    execFileSyncMock.mockReturnValueOnce(Buffer.from("HEAD\n"));
    execFileSyncMock.mockReturnValueOnce(undefined);
    expect(resolveWorktreeBase("/tmp/repo")).toBe("develop");
  });

  it("uses a custom fallback when provided and git fails", () => {
    execFileSyncMock.mockReturnValueOnce(Buffer.from("HEAD\n"));
    execFileSyncMock.mockReturnValueOnce(undefined);
    expect(resolveWorktreeBase("/tmp/repo", "trunk")).toBe("trunk");
  });
});

describe("worktreeDirtyFiles", () => {
  beforeEach(() => execFileSyncMock.mockReset());

  it("returns files from porcelain status", () => {
    execFileSyncMock.mockReturnValue(Buffer.from(" M modified.txt\n?? untracked.js\n"));
    expect(worktreeDirtyFiles("/tmp/wt")).toEqual(["modified.txt", "untracked.js"]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/wt", "status", "--porcelain", "--untracked-files=all"],
      expect.anything()
    );
  });

  it("returns empty array when git fails", () => {
    execFileSyncMock.mockReturnValue(undefined);
    expect(worktreeDirtyFiles("/tmp/wt")).toEqual([]);
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

  it("runs with --force when opts.force is true", () => {
    removeWorktree("/tmp/brove", "/tmp/brove/.worktrees/brove-crew-1", { force: true });

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/brove", "worktree", "remove", "--force", "/tmp/brove/.worktrees/brove-crew-1"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });
});
