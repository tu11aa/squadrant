import { describe, it, expect } from "vitest";
import { assembleHandoffFacts, STALE_FETCH_WARNING_MS } from "../handoff-facts.js";
import type { LiveRepoState, ClaudeMemSummary, TranscriptTail, HandoffConflict } from "../handoff-facts.js";

const NOW = "2026-08-03T16:00:00.000Z";

function live(overrides: Partial<LiveRepoState> = {}): LiveRepoState {
  return {
    branch: "develop",
    detached: false,
    baseBranch: "main",
    baseBranchSource: "gh-api",
    recentCommits: [],
    aheadOfBase: 0,
    aheadOfBaseSource: "gh-api",
    fetchAgeMs: null,
    openPRs: [],
    liveCrews: [],
    conflicts: [],
    ...overrides,
  };
}

// This module gathers verified facts — it does NOT author a handoff. No
// currentState/nextSteps/decisions/blockedItems synthesis, no narrative
// composition, no guessing at prose. Every group below is a raw pass-through
// of what was gathered, plus provenance. That's the whole contract.
describe("assembleHandoffFacts", () => {
  it("stamps meta with generatedAt and an explicit time window", () => {
    const out = assembleHandoffFacts(live(), null, null, NOW);
    expect(out.meta.generatedAt).toBe(NOW);
    expect(out.meta.timeWindow.to).toBe(NOW);
  });

  it("does not author a handoff — no currentState/nextSteps/decisions/session/reconstructed fields anywhere", () => {
    const out = assembleHandoffFacts(live(), null, null, NOW) as unknown as Record<string, unknown>;
    expect(out).not.toHaveProperty("session");
    expect(out).not.toHaveProperty("reconstructed");
    expect(out).not.toHaveProperty("written_at");
    expect(out).not.toHaveProperty("currentState");
    expect(out).not.toHaveProperty("nextSteps");
  });

  it("passes liveRepo through raw, plus a computed staleWarning", () => {
    const l = live({ branch: "feature/x", aheadOfBase: 3, openPRs: [{ number: 12, title: "Fix thing", headRefName: "fix/thing" }] });
    const out = assembleHandoffFacts(l, null, null, NOW);
    expect(out.liveRepo).toEqual({ ...l, staleWarning: null });
  });

  it("passes claude-mem through raw — no concatenation of title+text, no derived currentState", () => {
    const claudeMem: ClaudeMemSummary = {
      latestSessionSummary: {
        request: "investigate flaky test",
        completed: "fixed the race in the liveness registry",
        nextSteps: "write a regression test\nship v0.17.1",
        createdAt: "2026-08-02T10:00:00.000Z",
      },
      recentDecisions: [
        { title: "retry budget", text: "capped retries at 3, not configurable", createdAt: "2026-08-02T09:00:00.000Z" },
      ],
      oldestCreatedAt: "2026-08-01T00:00:00.000Z",
    };
    const out = assembleHandoffFacts(live(), claudeMem, null, NOW);
    expect(out.claudeMem).toEqual(claudeMem);
    expect(out.meta.timeWindow.from).toBe("2026-08-01T00:00:00.000Z");
  });

  it("passes the transcript through raw", () => {
    const transcript: TranscriptTail = {
      path: "/tmp/x.jsonl",
      mtimeIso: "2026-08-03T00:00:00.000Z",
      lastUserMessage: "what's next",
      lastAssistantText: "I've committed the fix and I'm waiting on CI",
    };
    const out = assembleHandoffFacts(live(), null, transcript, NOW);
    expect(out.transcript).toEqual(transcript);
    expect(out.meta.timeWindow.from).toBe("2026-08-03T00:00:00.000Z");
  });

  it("reports each of liveRepo/claudeMem/transcript as available or missing", () => {
    const out = assembleHandoffFacts(live({ openPRs: [{ number: 1, title: "x", headRefName: "x" }] }), null, null, NOW);
    expect(out.meta.sourcesAvailable).toEqual(["liveRepo"]);
    expect(out.meta.sourcesMissing).toEqual(["claudeMem", "transcript"]);
  });

  it("counts claudeMem as missing when the db was reachable but had nothing for this project (not just when null)", () => {
    const emptyClaudeMem: ClaudeMemSummary = { latestSessionSummary: null, recentDecisions: [], oldestCreatedAt: null };
    const out = assembleHandoffFacts(live(), emptyClaudeMem, null, NOW);
    expect(out.meta.sourcesMissing).toContain("claudeMem");
  });

  it("counts liveRepo as missing when every git/gh call failed", () => {
    const out = assembleHandoffFacts(live({ aheadOfBaseSource: "unknown" }), null, null, NOW);
    expect(out.meta.sourcesMissing).toContain("liveRepo");
  });

  it("warns when aheadOfBase is local-git and fetch age exceeds the staleness threshold", () => {
    const out = assembleHandoffFacts(live({ aheadOfBaseSource: "local-git", fetchAgeMs: STALE_FETCH_WARNING_MS + 1 }), null, null, NOW);
    expect(out.liveRepo.staleWarning).toContain("local git");
  });

  it("warns when aheadOfBase is local-git and fetch age is unknown", () => {
    const out = assembleHandoffFacts(live({ aheadOfBaseSource: "local-git", fetchAgeMs: null }), null, null, NOW);
    expect(out.liveRepo.staleWarning).toContain("no known last-fetch");
  });

  it("does not warn when aheadOfBase came from the gh API, regardless of fetch age", () => {
    const out = assembleHandoffFacts(live({ aheadOfBaseSource: "gh-api", fetchAgeMs: STALE_FETCH_WARNING_MS * 10 }), null, null, NOW);
    expect(out.liveRepo.staleWarning).toBeNull();
  });

  it("does not warn when aheadOfBase is local-git but the fetch was recent", () => {
    const out = assembleHandoffFacts(live({ aheadOfBaseSource: "local-git", fetchAgeMs: STALE_FETCH_WARNING_MS - 1 }), null, null, NOW);
    expect(out.liveRepo.staleWarning).toBeNull();
  });

  it("carries the gh-vs-local base SHA conflict through liveRepo.conflicts untouched — this is verification, not judgment, and stays", () => {
    const conflict: HandoffConflict = {
      field: "baseBranch",
      claim: "local git's last-known main is abc1234 (fetched 98h ago)",
      fact: "GitHub's live main is def5678",
      resolution: "GitHub API wins — local git may be stale",
    };
    const out = assembleHandoffFacts(live({ conflicts: [conflict] }), null, null, NOW);
    expect(out.liveRepo.conflicts).toEqual([conflict]);
  });
});
