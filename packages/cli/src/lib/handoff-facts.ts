// handoff-facts.ts — #650/#651: gather verified facts, grouped by source
// with provenance. This does NOT author a handoff — no currentState/
// nextSteps/decisions/blockedItems synthesis, no narrative composition, no
// guessing at prose. Field-copying a claude-mem summary into "currentState"
// isn't synthesis, it's pretending to reason. Composing the actual handoff
// from these facts is judgment, and belongs to whoever reads them (the
// captain).
//
// Two things this file does NOT do, both learned the hard way:
// - It does NOT pick "the" transcript by mtime or content-sniff it for role.
//   Session identity comes from the captain-session-registry (#651) —
//   ground truth recorded at the source (SessionStart hook), not inferred.
// - It does NOT read every archived handoff or every session transcript.
//   The newest archived handoff is a CHECKPOINT — it already covers history
//   up to the moment it was written, so it's read in full and nothing
//   older is re-read. Only sessions that started AFTER the checkpoint (the
//   GAP — work no handoff covers) get their transcripts read. With no
//   checkpoint at all, this falls back to a bounded recency window.
//
// The one exception to "no judgment": a gh-vs-local base SHA mismatch is
// kept as a conflict (LiveRepoState.conflicts) — verifying two hard facts
// against each other, not guessing at the meaning of prose. Similarly, "is
// this session's startedAt after the checkpoint's timestamp" is arithmetic,
// not interpretation — by construction every gapSession therefore has no
// handoff of its own (if it had written one, THAT would be the checkpoint).

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

/**
 * Status of the current branch against its upstream tracking branch —
 * distinct from aheadOfBase, which compares against the PROJECT's base
 * branch (e.g. develop). Computed locally from git's own tracking data
 * (never a network call unless --fetch was passed) via
 * `git for-each-ref --format=%(upstream:track)`, which is how "gone" is
 * detected without needing a live query: if the last fetch/prune already
 * recorded the remote branch as deleted, git knows locally.
 */
export type UpstreamStatus = "up-to-date" | "behind" | "ahead" | "diverged" | "no-upstream" | "upstream-gone" | "unknown";

export interface BranchState {
  upstreamStatus: UpstreamStatus;
  aheadOfUpstream: number | null;
  behindUpstream: number | null;
  /** Whether the branch's tip is already reachable from origin/<base> (or local <base> as fallback) — null if undeterminable. */
  mergedIntoBase: boolean | null;
  /** Uncommitted changes (staged or unstaged) — null if undeterminable. */
  dirtyWorkingTree: boolean | null;
  /** True when sitting on a crew/* worktree branch — a captain checkout normally shouldn't be. */
  onUnexpectedBranch: boolean;
  /** Whether `git fetch origin` actually ran and succeeded (only possible when the caller opted in). */
  fetchPerformed: boolean;
}

export interface LiveRepoState {
  /** Raw `git rev-parse --abbrev-ref HEAD` output — literally "HEAD" when detached. */
  branch: string;
  detached: boolean;
  baseBranch: string;
  /** "gh-api" (always fresh) or "local-fallback" (gh unavailable). */
  baseBranchSource: "gh-api" | "local-fallback";
  recentCommits: string[];
  /** Commits on `branch` not yet on `baseBranch`. Null when branch === baseBranch — a self-comparison, not a real answer (see aheadOfBaseSource "n-a"). */
  aheadOfBase: number | null;
  /** "gh-api" (fresh, no fetch needed), "local-git" (only as fresh as the
   *  last fetch — see fetchAgeMs), "n-a" (branch === baseBranch, nothing to
   *  compare), or "unknown" (neither source available). */
  aheadOfBaseSource: "gh-api" | "local-git" | "n-a" | "unknown";
  /** Age of .git/FETCH_HEAD in ms; null when unknown (never fetched / unreadable). */
  fetchAgeMs: number | null;
  openPRs: LiveOpenPR[];
  liveCrews: LiveCrewSummary[];
  /** Disagreements discovered while gathering (e.g. gh vs local base SHA). */
  conflicts: HandoffConflict[];
  branchState: BranchState;
  /** Commits baseBranch is ahead of the release branch (main) — the "unreleased" delta. The comparison that's actually meaningful when standing ON baseBranch, where aheadOfBase is "n-a". Null when baseBranch IS the release branch, or gh is unavailable. */
  unreleasedAheadOfReleaseBranch: number | null;
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
  /** Earliest created_at among the rows actually considered. */
  oldestCreatedAt: string | null;
}

export interface TranscriptTail {
  path: string;
  mtimeIso: string;
  lastUserMessage: string | null;
  lastAssistantText: string | null;
}

/** A captain session recorded at the source (SessionStart hook) — ground
 *  truth for "who ran when", never inferred from file mtimes. */
export interface CaptainSessionRecord {
  sessionId: string;
  project: string;
  agent: string;
  startedAt: string;
  cwd: string;
  transcriptPath: string;
}

export interface SessionWithTranscript {
  session: CaptainSessionRecord;
  transcript: TranscriptTail | null;
}

/** A real handoff a prior session actually wrote, archived (not deleted) by
 *  read-handoff.sh. Emitted raw — never merged into other tiers. */
export interface ArchivedHandoff {
  filename: string;
  path: string;
  ageMs: number;
  content: unknown;
}

/** Past this age, a local-git-sourced aheadOfBase gets an explicit staleness warning. */
export const STALE_FETCH_WARNING_MS = 24 * 60 * 60 * 1000;

/** Fallback recency bound used ONLY when there is no checkpoint at all
 *  (nothing has ever been archived) — otherwise the checkpoint itself is
 *  the boundary, unbounded. Overridable per call. */
export const SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface HandoffFactsLiveRepo extends LiveRepoState {
  staleWarning: string | null;
}

export interface HandoffFacts {
  meta: {
    generatedAt: string;
    /** Which checkpoint was used, or null if there was none (see usedFallbackWindow). */
    checkpointFilename: string | null;
    /** True when there was no checkpoint and selection fell back to a bounded recency window. */
    usedFallbackWindow: boolean;
    /** The fallback window actually used, only when usedFallbackWindow is true. */
    fallbackWindowMs: number | null;
    /** sessionId of every session in gapSessions — the boundary at a glance. */
    gapSessionIds: string[];
    sourcesAvailable: string[];
    sourcesMissing: string[];
    /** Non-null when the session registry itself couldn't be consulted (e.g. no file yet). */
    registryNote: string | null;
  };
  liveRepo: HandoffFactsLiveRepo;
  claudeMem: ClaudeMemSummary | null;
  /** The newest archived handoff, read in full — the baseline everything before it is covered by. Null if none exists yet. */
  checkpoint: ArchivedHandoff | null;
  /** Captain sessions that started after the checkpoint (or, with no checkpoint, within the fallback window) — the work no handoff covers. Newest first. */
  gapSessions: SessionWithTranscript[];
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
  checkpoint: ArchivedHandoff | null,
  gapSessions: SessionWithTranscript[],
): { available: string[]; missing: string[] } {
  const available: string[] = [];
  const missing: string[] = [];

  const liveHasData =
    live.openPRs.length > 0 || live.liveCrews.length > 0 || live.aheadOfBaseSource !== "unknown" || live.recentCommits.length > 0;
  (liveHasData ? available : missing).push("liveRepo");

  const claudeMemHasData = !!claudeMem && (claudeMem.latestSessionSummary !== null || claudeMem.recentDecisions.length > 0);
  (claudeMemHasData ? available : missing).push("claudeMem");

  (checkpoint ? available : missing).push("checkpoint");
  (gapSessions.length > 0 ? available : missing).push("gapSessions");

  return { available, missing };
}

export interface AssembleHandoffFactsExtras {
  /** Non-null when the session registry itself couldn't be consulted (e.g. no file yet). */
  registryNote?: string | null;
  /** True when there was no checkpoint and gapSessions selection fell back to a bounded recency window. */
  usedFallbackWindow?: boolean;
  /** The fallback window actually used, only meaningful when usedFallbackWindow is true. */
  fallbackWindowMs?: number;
}

/** Pure. Wraps already-gathered facts into {meta, liveRepo, claudeMem, checkpoint, gapSessions} with provenance — no synthesis. */
export function assembleHandoffFacts(
  live: LiveRepoState,
  claudeMem: ClaudeMemSummary | null,
  gapSessions: SessionWithTranscript[],
  checkpoint: ArchivedHandoff | null,
  now: string,
  extras: AssembleHandoffFactsExtras = {},
): HandoffFacts {
  const sortedGap = [...gapSessions].sort((a, b) => Date.parse(b.session.startedAt) - Date.parse(a.session.startedAt));
  const { available, missing } = sourceAvailability(live, claudeMem, checkpoint, sortedGap);

  return {
    meta: {
      generatedAt: now,
      checkpointFilename: checkpoint?.filename ?? null,
      usedFallbackWindow: extras.usedFallbackWindow ?? false,
      fallbackWindowMs: extras.usedFallbackWindow ? (extras.fallbackWindowMs ?? SESSION_WINDOW_MS) : null,
      gapSessionIds: sortedGap.map((s) => s.session.sessionId),
      sourcesAvailable: available,
      sourcesMissing: missing,
      registryNote: extras.registryNote ?? null,
    },
    liveRepo: { ...live, staleWarning: staleWarning(live) },
    claudeMem,
    checkpoint,
    gapSessions: sortedGap,
  };
}
