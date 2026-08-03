import { describe, it, expect } from "vitest";
import { assembleHandoffFacts, STALE_FETCH_WARNING_MS } from "../handoff-facts.js";
import type {
  LiveRepoState,
  ClaudeMemSummary,
  HandoffConflict,
  CaptainSessionRecord,
  SessionWithTranscript,
  ArchivedHandoff,
  TranscriptTail,
} from "../handoff-facts.js";

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
    branchState: {
      upstreamStatus: "up-to-date",
      aheadOfUpstream: 0,
      behindUpstream: 0,
      mergedIntoBase: false,
      dirtyWorkingTree: false,
      onUnexpectedBranch: false,
      fetchPerformed: false,
    },
    unreleasedAheadOfReleaseBranch: null,
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<CaptainSessionRecord> = {}): CaptainSessionRecord {
  return {
    sessionId: "sess-1",
    project: "squadrant",
    agent: "claude",
    startedAt: "2026-08-01T00:00:00.000Z",
    cwd: "/repo",
    transcriptPath: "/repo/.claude/sess-1.jsonl",
    ...overrides,
  };
}

function transcript(overrides: Partial<TranscriptTail> = {}): TranscriptTail {
  return {
    path: "/repo/.claude/sess-1.jsonl",
    mtimeIso: "2026-08-01T01:00:00.000Z",
    lastUserMessage: "do the thing",
    lastAssistantText: "done",
    ...overrides,
  };
}

function archivedHandoff(overrides: Partial<ArchivedHandoff> = {}): ArchivedHandoff {
  return {
    filename: "2026-08-01.json",
    path: "/vault/handoffs/2026-08-01.json",
    ageMs: 6 * 60 * 60 * 1000,
    content: { written_at: "2026-08-01T00:00:00.000Z", session: { currentState: "mid-flight" } },
    ...overrides,
  };
}

// This module gathers verified facts — it does NOT author a handoff. No
// currentState/nextSteps/decisions/blockedItems synthesis, no narrative
// composition, no guessing at prose, and (per #651) no mtime-guessing or
// content-sniffing for session identity — that comes from the registry.
// #651 correction: the newest archived handoff is a CHECKPOINT read in
// full; only sessions AFTER it (the gap) get their transcripts read — not
// a union of everything in some fixed window.
describe("assembleHandoffFacts", () => {
  it("stamps meta with generatedAt", () => {
    const out = assembleHandoffFacts(live(), null, [], null, NOW);
    expect(out.meta.generatedAt).toBe(NOW);
  });

  it("does not author a handoff — no currentState/nextSteps/decisions/session/reconstructed fields anywhere", () => {
    const out = assembleHandoffFacts(live(), null, [], null, NOW) as unknown as Record<string, unknown>;
    expect(out).not.toHaveProperty("session");
    expect(out).not.toHaveProperty("reconstructed");
    expect(out).not.toHaveProperty("written_at");
    expect(out).not.toHaveProperty("currentState");
  });

  it("passes liveRepo through raw, plus a computed staleWarning", () => {
    const l = live({ branch: "feature/x", aheadOfBase: 3, openPRs: [{ number: 12, title: "Fix thing", headRefName: "fix/thing" }] });
    const out = assembleHandoffFacts(l, null, [], null, NOW);
    expect(out.liveRepo).toEqual({ ...l, staleWarning: null });
  });

  it("passes claude-mem through raw — no concatenation, no derived currentState", () => {
    const claudeMem: ClaudeMemSummary = {
      latestSessionSummary: { request: "x", completed: "y", nextSteps: "z", createdAt: "2026-08-02T10:00:00.000Z" },
      recentDecisions: [{ title: "t", text: "d", createdAt: "2026-08-02T09:00:00.000Z" }],
      oldestCreatedAt: "2026-08-01T00:00:00.000Z",
    };
    const out = assembleHandoffFacts(live(), claudeMem, [], null, NOW);
    expect(out.claudeMem).toEqual(claudeMem);
  });

  it("passes the checkpoint through raw and untouched", () => {
    const checkpoint = archivedHandoff();
    const out = assembleHandoffFacts(live(), null, [], checkpoint, NOW);
    expect(out.checkpoint).toEqual(checkpoint);
    expect(out.meta.checkpointFilename).toBe(checkpoint.filename);
  });

  it("has checkpointFilename: null and usedFallbackWindow: true when there is no checkpoint", () => {
    const out = assembleHandoffFacts(live(), null, [], null, NOW);
    expect(out.checkpoint).toBeNull();
    expect(out.meta.checkpointFilename).toBeNull();
  });

  it("passes gap sessions through raw, with their transcripts, newest first", () => {
    const sessions: SessionWithTranscript[] = [
      { session: sessionRecord({ sessionId: "older", startedAt: "2026-08-01T00:00:00.000Z" }), transcript: transcript() },
      { session: sessionRecord({ sessionId: "newer", startedAt: "2026-08-02T00:00:00.000Z" }), transcript: null },
    ];
    const out = assembleHandoffFacts(live(), null, sessions, null, NOW);
    expect(out.gapSessions.map((s) => s.session.sessionId)).toEqual(["newer", "older"]);
    expect(out.gapSessions[1].transcript).toEqual(transcript());
    expect(out.gapSessions[0].transcript).toBeNull();
  });

  it("reports gapSessionIds in meta so the captain can see the boundary at a glance", () => {
    const sessions: SessionWithTranscript[] = [
      { session: sessionRecord({ sessionId: "a" }), transcript: null },
      { session: sessionRecord({ sessionId: "b" }), transcript: null },
    ];
    const out = assembleHandoffFacts(live(), null, sessions, null, NOW);
    expect(out.meta.gapSessionIds.sort()).toEqual(["a", "b"]);
  });

  it("reports liveRepo/claudeMem/checkpoint/gapSessions as available or missing", () => {
    const out = assembleHandoffFacts(live({ openPRs: [{ number: 1, title: "x", headRefName: "x" }] }), null, [], null, NOW);
    expect(out.meta.sourcesAvailable).toEqual(["liveRepo"]);
    expect(out.meta.sourcesMissing).toEqual(["claudeMem", "checkpoint", "gapSessions"]);
  });

  it("carries usedFallbackWindow + fallbackWindowMs through extras", () => {
    const out = assembleHandoffFacts(live(), null, [], null, NOW, { usedFallbackWindow: true, fallbackWindowMs: 86_400_000 });
    expect(out.meta.usedFallbackWindow).toBe(true);
    expect(out.meta.fallbackWindowMs).toBe(86_400_000);
  });

  it("usedFallbackWindow defaults to false and fallbackWindowMs to null", () => {
    const out = assembleHandoffFacts(live(), null, [], archivedHandoff(), NOW);
    expect(out.meta.usedFallbackWindow).toBe(false);
    expect(out.meta.fallbackWindowMs).toBeNull();
  });

  it("carries a registryNote through to meta (e.g. no registry file found yet)", () => {
    const out = assembleHandoffFacts(live(), null, [], null, NOW, { registryNote: "no session registry found" });
    expect(out.meta.registryNote).toBe("no session registry found");
  });

  it("warns when aheadOfBase is local-git and fetch age exceeds the staleness threshold", () => {
    const out = assembleHandoffFacts(live({ aheadOfBaseSource: "local-git", fetchAgeMs: STALE_FETCH_WARNING_MS + 1 }), null, [], null, NOW);
    expect(out.liveRepo.staleWarning).toContain("local git");
  });

  it("does not warn when aheadOfBase came from the gh API, regardless of fetch age", () => {
    const out = assembleHandoffFacts(live({ aheadOfBaseSource: "gh-api", fetchAgeMs: STALE_FETCH_WARNING_MS * 10 }), null, [], null, NOW);
    expect(out.liveRepo.staleWarning).toBeNull();
  });

  it("carries the gh-vs-local base SHA conflict through liveRepo.conflicts untouched — verification, not judgment, stays", () => {
    const conflict: HandoffConflict = {
      field: "baseBranch",
      claim: "local git's last-known main is abc1234 (fetched 98h ago)",
      fact: "GitHub's live main is def5678",
      resolution: "GitHub API wins — local git may be stale",
    };
    const out = assembleHandoffFacts(live({ conflicts: [conflict] }), null, [], null, NOW);
    expect(out.liveRepo.conflicts).toEqual([conflict]);
  });
});
