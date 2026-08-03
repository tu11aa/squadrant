// handoff-live-repo.ts — #650 Phase 2: the "live repo state" tier, the
// highest-trust source for handoff reconstruction (exact and current, unlike
// claude-mem or transcript inference). Every git/gh call degrades to an
// empty/zero value on failure — a missing remote, an unauthenticated `gh`,
// or a repo with no commits must never crash reconstruction.
import { execFileSync } from "node:child_process";
import { TERMINAL_STATES } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import type { LiveOpenPR, LiveCrewSummary, LiveRepoState } from "./handoff-reconstruct.js";

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

/**
 * Gather the live-repo tier: branch, recent commits, ahead-of-base count,
 * open PRs, and live (non-terminal) crews. `tasks` is the caller's already
 * fetched crew-task list (a daemon round-trip, so it isn't gathered here).
 */
export function gatherLiveRepoState(
  projectPath: string,
  baseBranch: string,
  tasks: TaskRecord[],
  runner: CommandRunner = defaultCommandRunner,
): LiveRepoState {
  const branch = (tryRun(runner, "git", ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"], projectPath) ?? "").trim();

  const log = tryRun(runner, "git", ["-C", projectPath, "log", `-${RECENT_COMMITS_LIMIT}`, "--oneline"], projectPath) ?? "";
  const recentCommits = log.split("\n").map((l) => l.trim()).filter(Boolean);

  const countOut = tryRun(runner, "git", ["-C", projectPath, "rev-list", "--count", `${baseBranch}..HEAD`], projectPath);
  const aheadOfBase = countOut ? Number.parseInt(countOut.trim(), 10) || 0 : 0;

  return {
    branch,
    baseBranch,
    recentCommits,
    aheadOfBase,
    openPRs: gatherOpenPRs(runner, projectPath),
    liveCrews: gatherLiveCrews(tasks),
  };
}
