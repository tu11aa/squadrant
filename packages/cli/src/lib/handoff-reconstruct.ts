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
  branch: string;
  baseBranch: string;
  recentCommits: string[];
  /** Commits on `branch` not yet on `baseBranch`. */
  aheadOfBase: number;
  openPRs: LiveOpenPR[];
  liveCrews: LiveCrewSummary[];
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
  claudeMemClaim: string;
  liveRepoFact: string;
  resolution: string;
}

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
  conflicts: HandoffConflict[];
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
  const branchHasPr = live.openPRs.some((pr) => pr.headRefName === live.branch);
  if (live.aheadOfBase > 0 && !branchHasPr) {
    branches.push(`${live.branch} — ${live.aheadOfBase} commit(s) ahead of ${live.baseBranch}, no open PR`);
  }
  return branches;
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
        claudeMemClaim: hit.trim(),
        liveRepoFact: `PR #${pr.number} (${pr.headRefName}) is still open`,
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
    conflicts: detectConflicts(live, claudeMem),
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
