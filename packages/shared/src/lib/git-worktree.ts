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
 * Create the crew's worktree + branch and return its absolute path.
 * Fails loud (throws) if git refuses — e.g. the base branch is missing or the
 * branch/path already exists. The caller's name-uniqueness check already
 * prevents live duplicates; a re-spawned-after-close name can collide on the
 * existing branch (rare — pick a new --name).
 */
export function addWorktree(spec: WorktreeSpec): string {
  const wt = worktreePath(spec.repoRoot, spec.worktreeDir, spec.project, spec.name);
  execFileSync(
    "git",
    ["-C", spec.repoRoot, "worktree", "add", wt, "-b", crewBranch(spec.name), spec.base],
    { stdio: "pipe" },
  );
  return wt;
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
