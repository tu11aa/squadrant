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

/**
 * #359: derive the branch a new worktree should be based on.
 * #661: prefer the captain's CHECKED-OUT branch. Reading origin/HEAD first meant
 * every spawn on a repo whose integration branch is not the GitHub default
 * branch started stale — 155 commits at prism-app — silently, with the damage
 * only surfacing at PR time as a diff full of unrelated reverts.
 * Order: checked-out branch → origin/HEAD → fallback.
 */
export function resolveWorktreeBase(repoRoot: string, fallback = "develop"): string {
  try {
    const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (head && head !== "HEAD") return head;   // "HEAD" means detached
  } catch {
    // fall through to origin/HEAD
  }
  try {
    const ref = execFileSync("git", ["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
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
  try {
    installWorktreeDependencies(wt);
  } catch (err) {
    // The worktree + branch were created a moment ago for a crew that will now
    // never start; leave neither behind (they would collide with the next spawn).
    cleanupFailedWorktree(spec, wt, targetBranch);
    throw err;
  }
  return wt;
}

/** Undo `git worktree add` after a failed install. Best-effort: the original install error is what the caller needs. */
function cleanupFailedWorktree(spec: WorktreeSpec, wt: string, branch: string): void {
  try {
    removeWorktree(spec.repoRoot, wt, { force: true });
  } catch {
    // Already gone or never fully created — nothing more to remove.
  }
  try {
    // Only delete the branch if it holds nothing beyond base (it was just created, so it shouldn't).
    const log = execFileSync("git", ["-C", spec.repoRoot, "log", "--oneline", `${spec.base}..${branch}`],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (!log) execFileSync("git", ["-C", spec.repoRoot, "branch", "-D", branch], { stdio: "pipe" });
  } catch {
    // Branch missing or unreadable — leave it rather than risk deleting commits.
  }
}

const OUTDATED_LOCKFILE = [
  /ERR_PNPM_OUTDATED_LOCKFILE/,                          // pnpm
  /npm ci.*\bin sync\b|not in sync/i,                    // npm ci
  /lockfile needs to be updated/i,                       // yarn
  /lockfile had changes, but lockfile is frozen/i,       // bun
];

/** Text a failed execFileSync carries: message + captured stdout/stderr. */
function installFailureText(err: unknown): string {
  const e = err as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
  return [e.message, e.stdout, e.stderr].map((x) => (x ? String(x) : "")).filter(Boolean).join("\n");
}

/**
 * Run a frozen install; if it fails ONLY because the repo's lockfile is stale,
 * retry once unfrozen. Any other failure (or a failed retry) throws an Error
 * carrying the package manager's real output, not just "Command failed".
 */
function runInstall(wt: string, cmd: string, frozenArgs: string[], fallbackArgs: string[], opts: { cwd?: string }): void {
  const run = (args: string[]) => execFileSync(cmd, args, { ...opts, stdio: "pipe" });
  const fail = (args: string[], err: unknown): never => {
    const tail = installFailureText(err).trim().split("\n").slice(-20).join("\n");
    throw new Error(`dependency install failed in worktree ${wt} (${cmd} ${args.join(" ")}):\n${tail}`);
  };
  try {
    run(frozenArgs);
    return;
  } catch (err) {
    if (!OUTDATED_LOCKFILE.some((re) => re.test(installFailureText(err)))) return fail(frozenArgs, err);
  }
  process.stderr.write(
    `worktree ${wt}: the lockfile in the repo is stale (out of date with package.json); the frozen install failed, so this worktree regenerated it. Do NOT commit the regenerated lockfile.\n`,
  );
  try {
    run(fallbackArgs);
  } catch (err) {
    fail(fallbackArgs, err);
  }
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
 *
 * A frozen install fails when the repo's committed lockfile is stale. That is
 * the repo's problem, not the crew's, so it must not block the spawn: if (and
 * only if) the failure is an outdated-lockfile error, retry once unfrozen and
 * warn on stderr that the regenerated lockfile must not be committed. Any other
 * failure aborts the spawn; addWorktree() then removes the worktree and branch
 * it just created, and the thrown error carries the package manager's output.
 */
function installWorktreeDependencies(wt: string): void {
  if (!fs.existsSync(path.join(wt, "package.json"))) return;

  if (fs.existsSync(path.join(wt, "pnpm-lock.yaml"))) {
    runInstall(wt, "pnpm", ["-C", wt, "install", "--frozen-lockfile"], ["-C", wt, "install", "--no-frozen-lockfile"], {});
  } else if (fs.existsSync(path.join(wt, "yarn.lock"))) {
    runInstall(wt, "yarn", ["install", "--frozen-lockfile"], ["install"], { cwd: wt });
  } else if (fs.existsSync(path.join(wt, "package-lock.json"))) {
    runInstall(wt, "npm", ["ci"], ["install"], { cwd: wt });
  } else if (fs.existsSync(path.join(wt, "bun.lockb"))) {
    runInstall(wt, "bun", ["install", "--frozen-lockfile"], ["install"], { cwd: wt });
  } else {
    process.stderr.write(
      `worktree ${wt}: package.json present but no lockfile — dependencies not installed; local typechecks/tests may resolve against the main checkout instead of this worktree.\n`,
    );
  }
}

/** #889: files squadrant itself writes into a crew worktree; never the user's work when untracked. */
export const SQUADRANT_GENERATED_PATHS: readonly string[] = [".claude/settings.local.json"];

/** `git status --porcelain` entries as [XY, path]; empty on git failure. */
function worktreeStatus(wtPath: string): Array<[string, string]> {
  try {
    return execFileSync("git", ["-C", wtPath, "status", "--porcelain", "--untracked-files=all"],
      { stdio: ["ignore", "pipe", "ignore"] })
      .toString().split("\n").filter(Boolean)
      .map((l): [string, string] => [l.slice(0, 2), l.slice(3).trim()]);
  } catch {
    return [];
  }
}

const isGeneratedUntracked = ([xy, file]: [string, string]) =>
  xy === "??" && SQUADRANT_GENERATED_PATHS.includes(file);

/** #649: files that would be destroyed by removing this worktree (minus untracked squadrant-generated ones, #889). */
export function worktreeDirtyFiles(wtPath: string): string[] {
  return worktreeStatus(wtPath).filter((e) => !isGeneratedUntracked(e)).map(([, file]) => file);
}

/** #889: delete untracked squadrant-generated files so `git worktree remove` (no --force) can proceed. */
export function removeGeneratedWorktreeFiles(wtPath: string): void {
  for (const [, file] of worktreeStatus(wtPath).filter(isGeneratedUntracked)) {
    fs.rmSync(path.join(wtPath, file), { force: true });
  }
}

/**
 * Remove a crew's worktree. The branch is left intact so commits survive.
 *
 * #649: this used to catch git's refusal and retry with --force. Git refuses to
 * remove a dirty worktree precisely to protect uncommitted work; catching that
 * and forcing past it destroyed an operator's uncommitted .env files at
 * prism-app. The refusal now stands — callers pass force explicitly.
 */
export function removeWorktree(repoRoot: string, wtPath: string, opts?: { force?: boolean }): void {
  const args = ["-C", repoRoot, "worktree", "remove", ...(opts?.force ? ["--force"] : []), wtPath];
  execFileSync("git", args, { stdio: "pipe" });
}
