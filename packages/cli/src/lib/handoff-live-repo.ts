// handoff-live-repo.ts — #650 Phase 2: the "live repo" tier, split into two
// sub-tiers of different freshness (corrected trust order):
//
//   gh API (always fresh, no fetch needed) > local git (only as fresh as
//   the last fetch — see fetchAgeMs)
//
// Proven bug this guards against: a captain's local `main` can be 100+
// commits behind the real `origin/main` with no signal that anything is
// wrong — `git log main..develop` then reports a wildly inflated commit
// count. gh API calls hit GitHub directly and are never stale; local git is
// used ONLY when gh is unavailable, is always compared against the
// `origin/<base>` remote-tracking ref (never the bare local branch, which
// drifts further), and is always paired with how old the last fetch was.
// Every git/gh call degrades to a safe default on failure — a missing
// remote, an unauthenticated `gh`, or a repo with no commits must never
// crash reconstruction. This module never runs `git fetch` — read-only,
// side-effect-free, by design (a network call at captain boot can hang
// offline or on bad auth).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TERMINAL_STATES } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import type { LiveOpenPR, LiveCrewSummary, LiveRepoState, HandoffConflict } from "./handoff-reconstruct.js";

export const RECENT_COMMITS_LIMIT = 15;
export const OPEN_PR_LIMIT = 20;

export interface CommandRunner {
  run(cmd: string, args: string[], cwd: string): string;
}

export const defaultCommandRunner: CommandRunner = {
  run(cmd, args, cwd) {
    // stderr is piped (not inherited) — failures here are expected and
    // caught by tryRun below; letting them through would spam the
    // terminal with raw git/gh error text on every degraded call.
    return execFileSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  },
};

function tryRun(runner: CommandRunner, cmd: string, args: string[], cwd: string): string | null {
  try {
    return runner.run(cmd, args, cwd);
  } catch {
    return null;
  }
}

function tryInt(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

interface GhRepoInfo {
  nameWithOwner: string;
  defaultBranch: string;
}

/** One combined gh call for repo identity + default branch — both always fresh, no fetch. */
function gatherGhRepoInfo(runner: CommandRunner, projectPath: string): GhRepoInfo | null {
  const out = tryRun(runner, "gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], projectPath);
  if (!out) return null;
  try {
    const parsed = JSON.parse(out) as { nameWithOwner: string; defaultBranchRef: { name: string } | null };
    if (!parsed.defaultBranchRef) return null;
    return { nameWithOwner: parsed.nameWithOwner, defaultBranch: parsed.defaultBranchRef.name };
  } catch {
    return null;
  }
}

function gatherOpenPRs(runner: CommandRunner, projectPath: string): LiveOpenPR[] {
  const out = tryRun(
    runner,
    "gh",
    ["pr", "list", "--json", "number,title,headRefName", "--limit", String(OPEN_PR_LIMIT)],
    projectPath,
  );
  if (!out) return [];
  try {
    const parsed = JSON.parse(out) as Array<{ number: number; title: string; headRefName: string }>;
    return parsed.map((pr) => ({ number: pr.number, title: pr.title, headRefName: pr.headRefName }));
  } catch {
    return [];
  }
}

function gatherLiveCrews(tasks: TaskRecord[]): LiveCrewSummary[] {
  return tasks
    .filter((t) => !TERMINAL_STATES.has(t.state))
    .map((t) => ({ name: t.name ?? t.id, state: t.state, task: t.task, question: t.question }));
}

/** ahead_by from GitHub's compare API — exact, server-computed, no local objects needed. Only meaningful for a PUSHED branch. */
function ghAheadOfBase(runner: CommandRunner, projectPath: string, nameWithOwner: string, base: string, branch: string): number | null {
  return tryInt(
    tryRun(runner, "gh", ["api", `repos/${nameWithOwner}/compare/${base}...${branch}`, "--jq", ".ahead_by"], projectPath),
  );
}

/** The base branch's current SHA per GitHub — always fresh, no fetch needed. */
function ghBaseSha(runner: CommandRunner, projectPath: string, nameWithOwner: string, base: string): string | null {
  const out = tryRun(runner, "gh", ["api", `repos/${nameWithOwner}/commits/${base}`, "--jq", ".sha"], projectPath);
  return out ? out.trim() : null;
}

/** The base branch's SHA per our last local fetch — only as fresh as fetchAgeMs. */
function localBaseSha(runner: CommandRunner, projectPath: string, base: string): string | null {
  const out = tryRun(runner, "git", ["-C", projectPath, "rev-parse", `origin/${base}`], projectPath);
  return out ? out.trim() : null;
}

/** Local commit count ahead of the remote-tracking ref — NEVER the bare local base branch, which drifts further from origin without warning. */
function localAheadOfBase(runner: CommandRunner, projectPath: string, base: string): number | null {
  return tryInt(tryRun(runner, "git", ["-C", projectPath, "rev-list", "--count", `origin/${base}..HEAD`], projectPath));
}

function readFetchAgeMs(projectPath: string, now: number): number | null {
  try {
    const stat = fs.statSync(path.join(projectPath, ".git", "FETCH_HEAD"));
    return now - stat.mtime.getTime();
  } catch {
    return null;
  }
}

/**
 * Gather the live-repo tier. `tasks` is the caller's already-fetched
 * crew-task list (a daemon round-trip, so it isn't gathered here).
 * `fallbackBaseBranch` is used only when gh is unavailable — never invented.
 */
export function gatherLiveRepoState(
  projectPath: string,
  fallbackBaseBranch: string,
  tasks: TaskRecord[],
  runner: CommandRunner = defaultCommandRunner,
  now: number = Date.now(),
): LiveRepoState {
  const branch = (tryRun(runner, "git", ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"], projectPath) ?? "").trim();
  const detached = branch === "HEAD";

  const log = tryRun(runner, "git", ["-C", projectPath, "log", `-${RECENT_COMMITS_LIMIT}`, "--oneline"], projectPath) ?? "";
  const recentCommits = log.split("\n").map((l) => l.trim()).filter(Boolean);

  const ghInfo = gatherGhRepoInfo(runner, projectPath);
  const baseBranch = ghInfo?.defaultBranch ?? fallbackBaseBranch;
  const baseBranchSource: LiveRepoState["baseBranchSource"] = ghInfo ? "gh-api" : "local-fallback";

  const fetchAgeMs = readFetchAgeMs(projectPath, now);

  let aheadOfBase = 0;
  let aheadOfBaseSource: LiveRepoState["aheadOfBaseSource"] = "unknown";
  if (ghInfo && !detached) {
    const ghAhead = ghAheadOfBase(runner, projectPath, ghInfo.nameWithOwner, baseBranch, branch);
    if (ghAhead !== null) {
      aheadOfBase = ghAhead;
      aheadOfBaseSource = "gh-api";
    }
  }
  if (aheadOfBaseSource === "unknown") {
    const localAhead = localAheadOfBase(runner, projectPath, baseBranch);
    if (localAhead !== null) {
      aheadOfBase = localAhead;
      aheadOfBaseSource = "local-git";
    }
  }

  const conflicts: HandoffConflict[] = [];
  if (ghInfo) {
    const ghSha = ghBaseSha(runner, projectPath, ghInfo.nameWithOwner, baseBranch);
    const localSha = localBaseSha(runner, projectPath, baseBranch);
    if (ghSha && localSha && ghSha !== localSha) {
      const ageNote = fetchAgeMs !== null ? `fetched ${Math.round(fetchAgeMs / 3_600_000)}h ago` : "fetch age unknown";
      conflicts.push({
        field: "baseBranch",
        claim: `local git's last-known ${baseBranch} is ${localSha} (${ageNote})`,
        fact: `GitHub's live ${baseBranch} is ${ghSha}`,
        resolution: "GitHub API wins — local git may be stale",
      });
    }
  }

  return {
    branch,
    detached,
    baseBranch,
    baseBranchSource,
    recentCommits,
    aheadOfBase,
    aheadOfBaseSource,
    fetchAgeMs,
    openPRs: gatherOpenPRs(runner, projectPath),
    liveCrews: gatherLiveCrews(tasks),
    conflicts,
  };
}
