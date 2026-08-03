// handoff-branch-state.ts — verified repo-state facts as explicit flags,
// not prose, so a cheap model can act on them without interpreting. Direct
// response to a real incident: local `main` was 164 commits behind the real
// origin/main with no signal anything was wrong, and the captain reported
// "188 commits ahead" when the true count (against origin/main) was 24.
//
// Every check here is local-only by default (no network) — `git for-each-ref
// --format=%(upstream:track)` reads git's own tracking data, which already
// knows about a deleted remote branch ("gone") if the last fetch/prune
// recorded it, with no live query needed. `--fetch` is the explicit,
// caller-opted-in exception: it runs one `git fetch origin` before these
// checks, updating the remote-tracking refs this module reads from. Without
// that flag, this module never mutates anything.
import type { CommandRunner } from "./handoff-live-repo.js";
import type { BranchState, UpstreamStatus } from "./handoff-facts.js";

function tryRun(runner: CommandRunner, cmd: string, args: string[], cwd: string): string | null {
  try {
    return runner.run(cmd, args, cwd);
  } catch {
    return null;
  }
}

/** Pure. Parses one `git for-each-ref --format=%(upstream:short)|%(upstream:track)` line. `raw === null` means the git call itself failed. */
export function parseUpstreamTrack(raw: string | null): {
  upstreamStatus: UpstreamStatus;
  aheadOfUpstream: number | null;
  behindUpstream: number | null;
} {
  if (raw === null) return { upstreamStatus: "unknown", aheadOfUpstream: null, behindUpstream: null };

  const [upstreamShort = "", track = ""] = raw.trim().split("|");
  if (!upstreamShort.trim()) return { upstreamStatus: "no-upstream", aheadOfUpstream: null, behindUpstream: null };
  if (track.includes("[gone]")) return { upstreamStatus: "upstream-gone", aheadOfUpstream: null, behindUpstream: null };

  const aheadMatch = track.match(/ahead (\d+)/);
  const behindMatch = track.match(/behind (\d+)/);
  const ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
  const behind = behindMatch ? Number(behindMatch[1]) : 0;

  if (ahead > 0 && behind > 0) return { upstreamStatus: "diverged", aheadOfUpstream: ahead, behindUpstream: behind };
  if (ahead > 0) return { upstreamStatus: "ahead", aheadOfUpstream: ahead, behindUpstream: 0 };
  if (behind > 0) return { upstreamStatus: "behind", aheadOfUpstream: 0, behindUpstream: behind };
  return { upstreamStatus: "up-to-date", aheadOfUpstream: 0, behindUpstream: 0 };
}

/** Compares merge-base(branch, target) against branch's own tip — equal means branch is fully contained in target (merged). Avoids relying on exit-code differentiation from `--is-ancestor`. */
function gatherMergedIntoBase(runner: CommandRunner, projectPath: string, branch: string, baseBranch: string): boolean | null {
  const originBase = `origin/${baseBranch}`;
  const originResolved = tryRun(runner, "git", ["-C", projectPath, "rev-parse", "--verify", originBase], projectPath) !== null;
  const target = originResolved ? originBase : baseBranch;

  const branchSha = tryRun(runner, "git", ["-C", projectPath, "rev-parse", branch], projectPath);
  const mergeBaseSha = tryRun(runner, "git", ["-C", projectPath, "merge-base", branch, target], projectPath);
  if (branchSha === null || mergeBaseSha === null) return null;
  return branchSha.trim() === mergeBaseSha.trim();
}

function gatherDirty(runner: CommandRunner, projectPath: string): boolean | null {
  const status = tryRun(runner, "git", ["-C", projectPath, "status", "--porcelain"], projectPath);
  if (status === null) return null;
  return status.trim().length > 0;
}

/**
 * Gather verified branch-state facts. `fetch: true` runs `git fetch origin`
 * first (the only place this module ever mutates anything) — its success
 * is reported via `fetchPerformed`, never assumed.
 */
export function gatherBranchState(
  runner: CommandRunner,
  projectPath: string,
  branch: string,
  baseBranch: string,
  detached: boolean,
  fetch: boolean,
): BranchState {
  const fetchPerformed = fetch && tryRun(runner, "git", ["-C", projectPath, "fetch", "origin"], projectPath) !== null;
  const dirtyWorkingTree = gatherDirty(runner, projectPath);

  if (detached) {
    return {
      upstreamStatus: "unknown",
      aheadOfUpstream: null,
      behindUpstream: null,
      mergedIntoBase: null,
      dirtyWorkingTree,
      onUnexpectedBranch: false,
      fetchPerformed,
    };
  }

  const trackRaw = tryRun(
    runner,
    "git",
    ["-C", projectPath, "for-each-ref", "--format=%(upstream:short)|%(upstream:track)", `refs/heads/${branch}`],
    projectPath,
  );
  const { upstreamStatus, aheadOfUpstream, behindUpstream } = parseUpstreamTrack(trackRaw);

  return {
    upstreamStatus,
    aheadOfUpstream,
    behindUpstream,
    mergedIntoBase: gatherMergedIntoBase(runner, projectPath, branch, baseBranch),
    dirtyWorkingTree,
    onUnexpectedBranch: branch.startsWith("crew/"),
    fetchPerformed,
  };
}
