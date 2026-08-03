// handoff-reconstruct.ts — #650 Phase 2: rebuild a handoff when none exists.
//
// Three tiers, in trust order when they disagree: live repo state (exact,
// current) > claude-mem (distilled, can be stale) > transcript (inference).
// The gathering functions below are impure (git/gh/sqlite/fs); this file's
// merge function, reconstructHandoff, is pure and does the actual
// trust-ordering and conflict detection so it can be unit-tested without IO.

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

export interface HandoffConflict {
  field: string;
  /** The lower-trust tier's claim (claude-mem narrative, or a stale local git ref). */
  claim: string;
  /** The higher-trust tier's actual fact (live repo state, or the gh API). */
  fact: string;
  resolution: string;
}

/** Past this age, a local-git-sourced number gets an explicit staleness warning. */
export const STALE_FETCH_WARNING_MS = 24 * 60 * 60 * 1000;

export interface ReconstructedHandoffSession {
  currentState: string;
  openBranches: string[];
  nextSteps: string[];
  blockedItems: string[];
  decisions: string[];
  activeTasks: string;
}

export interface ReconstructedHandoff {
  written_at: string;
  reconstructed: true;
  sources: string[];
  timeWindow: { from: string | null; to: string };
  /** Where aheadOfBase came from — see LiveRepoState.aheadOfBaseSource. First-class, not buried in `warnings`. */
  aheadOfBaseSource: LiveRepoState["aheadOfBaseSource"];
  /** Age of the local git fetch aheadOfBase relied on, if it came from local-git. */
  fetchAgeMs: number | null;
  conflicts: HandoffConflict[];
  warnings: string[];
  session: ReconstructedHandoffSession;
}

function splitLines(text: string | null): string[] {
  if (!text) return [];
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

function summarizeActiveTasks(crews: LiveCrewSummary[]): string {
  if (crews.length === 0) return "";
  const counts = new Map<string, number>();
  for (const c of crews) counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
  const parts = [...counts.entries()].map(([state, n]) => `${n} ${state}`);
  return `${crews.length} live crew(s): ${parts.join(", ")}`;
}

function buildOpenBranches(live: LiveRepoState): string[] {
  const branches = live.openPRs.map((pr) => `#${pr.number} ${pr.title} (${pr.headRefName})`);
  // A detached HEAD isn't a branch — don't let it silently masquerade as one.
  if (live.detached) return branches;
  const branchHasPr = live.openPRs.some((pr) => pr.headRefName === live.branch);
  if (live.aheadOfBase > 0 && !branchHasPr) {
    branches.push(`${live.branch} — ${live.aheadOfBase} commit(s) ahead of ${live.baseBranch}, no open PR`);
  }
  return branches;
}

function buildWarnings(live: LiveRepoState): string[] {
  const warnings: string[] = [];
  if (live.detached) {
    warnings.push(
      "captain checkout is on a detached HEAD (not a branch) — branch-derived fields may not reflect meaningful work",
    );
  }
  if (live.aheadOfBaseSource === "local-git") {
    if (live.fetchAgeMs === null) {
      warnings.push("aheadOfBase came from local git with no known last-fetch time — treat as possibly stale");
    } else if (live.fetchAgeMs > STALE_FETCH_WARNING_MS) {
      const hours = Math.round(live.fetchAgeMs / 3_600_000);
      warnings.push(`aheadOfBase came from local git, last fetched ${hours}h ago — may be stale`);
    }
  }
  return warnings;
}

// Bounded, literal heuristic for the one concrete failure case reconstruction
// must guard against: claude-mem's narrative claiming a PR shipped while the
// PR is demonstrably still open. Not general contradiction detection.
const SHIP_WORDS = /\b(merged|shipped|closed|done)\b/i;

function detectConflicts(live: LiveRepoState, claudeMem: ClaudeMemSummary | null): HandoffConflict[] {
  if (!claudeMem) return [];
  const texts = [
    claudeMem.latestSessionSummary?.completed ?? null,
    claudeMem.latestSessionSummary?.nextSteps ?? null,
    ...claudeMem.recentDecisions.map((d) => d.text),
  ].filter((t): t is string => !!t);

  const conflicts: HandoffConflict[] = [];
  for (const pr of live.openPRs) {
    const hit = texts.find((t) => (t.includes(`#${pr.number}`) || t.includes(pr.headRefName)) && SHIP_WORDS.test(t));
    if (hit) {
      conflicts.push({
        field: "openBranches",
        claim: hit.trim(),
        fact: `PR #${pr.number} (${pr.headRefName}) is still open`,
        resolution: "live repo state wins — kept in openBranches",
      });
    }
  }
  return conflicts;
}

export function reconstructHandoff(
  live: LiveRepoState,
  claudeMem: ClaudeMemSummary | null,
  transcript: TranscriptTail | null,
  now: string,
): ReconstructedHandoff {
  const sources: string[] = [];
  if (live.openPRs.length > 0 || live.aheadOfBase > 0 || live.liveCrews.length > 0) {
    sources.push("live-repo");
  }

  let currentState = "";
  let nextSteps: string[] = [];
  let decisions: string[] = [];

  if (claudeMem?.latestSessionSummary) {
    const s = claudeMem.latestSessionSummary;
    currentState = s.completed || s.request || "";
    nextSteps = splitLines(s.nextSteps);
    if (currentState || nextSteps.length > 0) sources.push("claude-mem");
  }
  if (claudeMem && claudeMem.recentDecisions.length > 0) {
    decisions = claudeMem.recentDecisions
      .map((d) => (d.title ? `${d.title} — ${d.text ?? ""}`.trim() : d.text ?? ""))
      .filter(Boolean);
    if (decisions.length > 0 && !sources.includes("claude-mem")) sources.push("claude-mem");
  }

  if (!currentState && transcript?.lastAssistantText) {
    currentState = transcript.lastAssistantText;
    sources.push("transcript");
  } else if (!currentState && transcript?.lastUserMessage) {
    currentState = `Last user request: ${transcript.lastUserMessage}`;
    sources.push("transcript");
  }

  return {
    written_at: now,
    reconstructed: true,
    sources,
    timeWindow: { from: claudeMem?.oldestCreatedAt ?? transcript?.mtimeIso ?? null, to: now },
    aheadOfBaseSource: live.aheadOfBaseSource,
    fetchAgeMs: live.fetchAgeMs,
    conflicts: [...live.conflicts, ...detectConflicts(live, claudeMem)],
    warnings: buildWarnings(live),
    session: {
      currentState,
      openBranches: buildOpenBranches(live),
      nextSteps,
      blockedItems: live.liveCrews
        .filter((c) => c.state === "blocked" && c.question)
        .map((c) => `${c.name}: ${c.question}`),
      decisions,
      activeTasks: summarizeActiveTasks(live.liveCrews),
    },
  };
}
