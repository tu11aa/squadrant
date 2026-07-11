// src/lib/git-worktree.ts
//
// Per-crew git worktree isolation (#216). A FEATURE crew (spawned with
// `--worktree`) runs in its own worktree + branch so it can switch HEAD without
// dragging the captain's checkout. Small/one-off crews keep running on the
// shared root checkout (unchanged default). The side-effecting `git worktree`
// calls live here so crew.ts stays mockable and surgical — same seam pattern as
// per-crew-settings.ts.
//
// Builds and the daemon still run from the MAIN checkout's `dist`; worktrees
// edit source only (issue #216 caveat).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface WorktreeSpec {
  /** The project's root checkout (also the shared `.git` owner). */
  repoRoot: string;
  /** Config.defaults.worktreeDir, resolved relative to repoRoot (e.g. ".worktrees"). */
  worktreeDir: string;
  project: string;
  /** Crew name (e.g. "crew-1" or a --name value). */
  name: string;
  /** Branch to base the new crew branch on (GitFlow: "develop"). */
  base: string;
}

/** Deterministic worktree path: <repoRoot>/<worktreeDir>/<project>-<name>. */
export function worktreePath(repoRoot: string, worktreeDir: string, project: string, name: string): string {
  return path.resolve(repoRoot, worktreeDir, `${project}-${name}`);
}

/** Crew branch name for a worktree crew. */
export function crewBranch(name: string): string {
  return `crew/${name}`;
}

/**
 * #387: macOS Spotlight (mds/mdworker) indexing every crew worktree's
 * node_modules can itself starve CPU. A `.metadata_never_index` marker file
 * excludes its directory (recursively, including subdirectories created
 * later) from indexing. Dropping ONE marker in the worktree ROOT (once, the
 * first time a project spawns a worktree crew) covers every crew worktree
 * ever created under it after — no per-worktree marker needed. Best-effort
 * and macOS-only: never blocks worktree creation over an indexing nicety.
 */
function ensureSpotlightExcluded(repoRoot: string, worktreeDir: string): void {
  if (process.platform !== "darwin") return;
  try {
    const dir = path.resolve(repoRoot, worktreeDir);
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, ".metadata_never_index");
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, "");
  } catch {
    // Best-effort — Spotlight exclusion is a nicety, not a correctness requirement.
  }
}

// #359: derive the branch a new worktree should be based on. Reads origin/HEAD
// so main-based repos work without a hand-created `develop`. Falls back to
// `fallback` (default "develop") when origin/HEAD is unset.
export function resolveWorktreeBase(repoRoot: string, fallback = "develop"): string {
  try {
    const ref = execFileSync(
      "git",
      ["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"],
      { stdio: ["ignore", "pipe", "ignore"] },
    ).toString().trim();
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch {
    return fallback;
  }
  return fallback;
}

/**
 * Create the crew's worktree + branch and return its absolute path.
 * Handles a stale crew/<name> branch left by a previously-closed crew (#460):
 * - No existing branch → unchanged behavior.
 * - Existing branch with no unique commits (merged/empty) → delete and recreate fresh.
 * - Existing branch with unique commits → uniquify to crew/<name>-2, -3, … so no
 *   commits are lost and there is no collision. The returned path reflects the
 *   uniquified name.
 */
export function addWorktree(spec: WorktreeSpec): string {
  ensureSpotlightExcluded(spec.repoRoot, spec.worktreeDir);

  const originalBranch = crewBranch(spec.name);

  let targetName = spec.name;
  let targetBranch = originalBranch;

  // Check whether crew/<name> already exists from a prior closed crew.
  let branchExists = false;
  try {
    execFileSync(
      "git",
      ["-C", spec.repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${originalBranch}`],
      { stdio: "pipe" },
    );
    branchExists = true;
  } catch {
    // Branch does not exist — normal path, nothing to resolve.
  }

  if (branchExists) {
    const log = execFileSync(
      "git",
      ["-C", spec.repoRoot, "log", "--oneline", `${spec.base}..${originalBranch}`],
      { stdio: ["ignore", "pipe", "ignore"] },
    ).toString().trim();

    if (!log) {
      // No unique commits: safe to delete and let the worktree add recreate it.
      execFileSync(
        "git",
        ["-C", spec.repoRoot, "branch", "-D", originalBranch],
        { stdio: "pipe" },
      );
    } else {
      // Has unique commits: uniquify to crew/<name>-N so history is preserved.
      let suffix = 2;
      while (true) {
        const candidate = `${spec.name}-${suffix}`;
        const candidateBranch = crewBranch(candidate);
        let candidateExists = false;
        try {
          execFileSync(
            "git",
            ["-C", spec.repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${candidateBranch}`],
            { stdio: "pipe" },
          );
          candidateExists = true;
        } catch {
          // Candidate branch is free.
        }
        if (!candidateExists) {
          targetName = candidate;
          targetBranch = candidateBranch;
          break;
        }
        suffix++;
      }
    }
  }

  const wt = worktreePath(spec.repoRoot, spec.worktreeDir, spec.project, targetName);
  execFileSync(
    "git",
    ["-C", spec.repoRoot, "worktree", "add", wt, "-b", targetBranch, spec.base],
    { stdio: "pipe" },
  );
  installWorktreeDependencies(wt);
  return wt;
}

/**
 * #387: `git worktree add` never populates node_modules — a fresh worktree
 * has none. Node's module resolution walks up parent directories looking for
 * node_modules, and since worktrees live nested under <repoRoot>/<worktreeDir>/,
 * a worktree with no local node_modules silently falls through to the main
 * checkout's node_modules instead of failing — so a crew's tsc/vitest run can
 * type-check or test against the main repo's stale code without any error.
 * Installing here, synchronously, before the worktree is handed to a crew
 * closes that gap: the worktree always has its own complete dependency tree,
 * or worktree creation fails loudly instead of leaving a crew to discover the
 * gap mid-task.
 *
 * addWorktree() is called for every registered project, not just squadrant's
 * own repo — projects use pnpm, yarn, or npm, and some aren't JS projects at
 * all. Detect the package manager from its lockfile rather than assuming
 * pnpm; each is invoked with its own frozen/reproducible-install flag so this
 * never silently drifts the project's lockfile. No package.json → nothing to
 * install, not an error. package.json with no recognized lockfile → skip
 * rather than guess: without a lockfile there's no deterministic manifest to
 * freeze against, and guessing a package manager risks generating a stray
 * lockfile the crew never asked for — but that skip still leaves the worktree
 * without its own node_modules, i.e. still exposed to the exact silent
 * cross-checkout resolution this function exists to close. Warn on stderr so
 * that exposure is visible instead of silent.
 */
function installWorktreeDependencies(wt: string): void {
  if (!fs.existsSync(path.join(wt, "package.json"))) return;

  if (fs.existsSync(path.join(wt, "pnpm-lock.yaml"))) {
    execFileSync("pnpm", ["-C", wt, "install", "--frozen-lockfile"], { stdio: "pipe" });
  } else if (fs.existsSync(path.join(wt, "yarn.lock"))) {
    execFileSync("yarn", ["install", "--frozen-lockfile"], { cwd: wt, stdio: "pipe" });
  } else if (fs.existsSync(path.join(wt, "package-lock.json"))) {
    execFileSync("npm", ["ci"], { cwd: wt, stdio: "pipe" });
  } else if (fs.existsSync(path.join(wt, "bun.lockb"))) {
    execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: wt, stdio: "pipe" });
  } else {
    process.stderr.write(
      `worktree ${wt}: package.json present but no lockfile — dependencies not installed; local typechecks/tests may resolve against the main checkout instead of this worktree.\n`,
    );
  }
}

/**
 * Remove a crew's worktree (auto-clean on close). Tries a plain remove first;
 * a dirty/locked worktree makes git refuse, so we retry with --force. The
 * branch is left intact so the crew's commits survive the close.
 */
export function removeWorktree(repoRoot: string, wtPath: string): void {
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "remove", wtPath], { stdio: "pipe" });
  } catch {
    execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", wtPath], { stdio: "pipe" });
  }
}
