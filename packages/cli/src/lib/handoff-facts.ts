// handoff-facts.ts — #650: gather verified facts, grouped by source with
// provenance. This does NOT author a handoff — no currentState/nextSteps/
// decisions/blockedItems synthesis, no narrative composition, no guessing
// at prose. Field-copying a claude-mem summary into "currentState" isn't
// synthesis, it's pretending to reason. Composing the actual handoff from
// these facts is judgment, and belongs to whoever reads them (the captain).
//
// The one exception: a gh-vs-local base SHA mismatch is kept as a conflict
// (see LiveRepoState.conflicts) — that's verifying two hard facts against
// each other, not guessing at the meaning of prose.

export interface LiveOpenPR {
  number: number;
  title: string;
  headRefName: string;
}

export interface LiveCrewSummary {
  name: string;
  state: string;
  task: string;
  question?: string;
}

export interface HandoffConflict {
  field: string;
  /** The lower-trust tier's claim (a stale local git ref). */
  claim: string;
  /** The higher-trust tier's actual fact (the gh API). */
  fact: string;
  resolution: string;
}

export interface LiveRepoState {
  /** Raw `git rev-parse --abbrev-ref HEAD` output — literally "HEAD" when detached. */
  branch: string;
  detached: boolean;
  baseBranch: string;
  /** "gh-api" (always fresh) or "local-fallback" (gh unavailable). */
  baseBranchSource: "gh-api" | "local-fallback";
  recentCommits: string[];
  /** Commits on `branch` not yet on `baseBranch`. */
  aheadOfBase: number;
  /** "gh-api" (fresh, no fetch needed), "local-git" (only as fresh as the
   *  last fetch — see fetchAgeMs), or "unknown" (neither source available). */
  aheadOfBaseSource: "gh-api" | "local-git" | "unknown";
  /** Age of .git/FETCH_HEAD in ms; null when unknown (never fetched / unreadable). */
  fetchAgeMs: number | null;
  openPRs: LiveOpenPR[];
  liveCrews: LiveCrewSummary[];
  /** Disagreements discovered while gathering (e.g. gh vs local base SHA). */
  conflicts: HandoffConflict[];
}

export interface ClaudeMemSessionSummary {
  request: string | null;
  completed: string | null;
  nextSteps: string | null;
  createdAt: string;
}

export interface ClaudeMemDecision {
  title: string | null;
  text: string | null;
  createdAt: string;
}

export interface ClaudeMemSummary {
  latestSessionSummary: ClaudeMemSessionSummary | null;
  recentDecisions: ClaudeMemDecision[];
  /** Earliest created_at among the rows actually considered — feeds timeWindow.from. */
  oldestCreatedAt: string | null;
}

export interface TranscriptTail {
  path: string;
  mtimeIso: string;
  lastUserMessage: string | null;
  lastAssistantText: string | null;
}

/** Past this age, a local-git-sourced aheadOfBase gets an explicit staleness warning. */
export const STALE_FETCH_WARNING_MS = 24 * 60 * 60 * 1000;

export interface HandoffFactsLiveRepo extends LiveRepoState {
  staleWarning: string | null;
}

export interface HandoffFacts {
  meta: {
    generatedAt: string;
    timeWindow: { from: string | null; to: string };
    sourcesAvailable: string[];
    sourcesMissing: string[];
  };
  liveRepo: HandoffFactsLiveRepo;
  claudeMem: ClaudeMemSummary | null;
  transcript: TranscriptTail | null;
}

// Mechanical (age > threshold), not judgment — unlike guessing at what a
// claude-mem narrative means, "is this number older than N hours" is a fact.
function staleWarning(live: LiveRepoState): string | null {
  if (live.aheadOfBaseSource !== "local-git") return null;
  if (live.fetchAgeMs === null) {
    return "aheadOfBase came from local git with no known last-fetch time — treat as possibly stale";
  }
  if (live.fetchAgeMs > STALE_FETCH_WARNING_MS) {
    const hours = Math.round(live.fetchAgeMs / 3_600_000);
    return `aheadOfBase came from local git, last fetched ${hours}h ago — may be stale`;
  }
  return null;
}

function sourceAvailability(
  live: LiveRepoState,
  claudeMem: ClaudeMemSummary | null,
  transcript: TranscriptTail | null,
): { available: string[]; missing: string[] } {
  const available: string[] = [];
  const missing: string[] = [];

  const liveHasData =
    live.openPRs.length > 0 || live.liveCrews.length > 0 || live.aheadOfBaseSource !== "unknown" || live.recentCommits.length > 0;
  (liveHasData ? available : missing).push("liveRepo");

  const claudeMemHasData = !!claudeMem && (claudeMem.latestSessionSummary !== null || claudeMem.recentDecisions.length > 0);
  (claudeMemHasData ? available : missing).push("claudeMem");

  (transcript ? available : missing).push("transcript");

  return { available, missing };
}

/** Pure. Wraps already-gathered facts into {meta, liveRepo, claudeMem, transcript} with provenance — no synthesis. */
export function assembleHandoffFacts(
  live: LiveRepoState,
  claudeMem: ClaudeMemSummary | null,
  transcript: TranscriptTail | null,
  now: string,
): HandoffFacts {
  const { available, missing } = sourceAvailability(live, claudeMem, transcript);

  return {
    meta: {
      generatedAt: now,
      timeWindow: { from: claudeMem?.oldestCreatedAt ?? transcript?.mtimeIso ?? null, to: now },
      sourcesAvailable: available,
      sourcesMissing: missing,
    },
    liveRepo: { ...live, staleWarning: staleWarning(live) },
    claudeMem,
    transcript,
  };
}
