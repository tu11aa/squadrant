import { describe, it, expect } from "vitest";
import { reconstructHandoff, STALE_FETCH_WARNING_MS } from "../handoff-reconstruct.js";
import type { LiveRepoState, ClaudeMemSummary, TranscriptTail, HandoffConflict } from "../handoff-reconstruct.js";

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

describe("reconstructHandoff", () => {
  it("is marked reconstructed with an explicit time window", () => {
    const out = reconstructHandoff(live(), null, null, NOW);
    expect(out.reconstructed).toBe(true);
    expect(out.written_at).toBe(NOW);
    expect(out.timeWindow.to).toBe(NOW);
  });

  it("degrades gracefully to empty session fields when every source is empty", () => {
    const out = reconstructHandoff(live(), null, null, NOW);
    expect(out.session).toEqual({
      currentState: "",
      openBranches: [],
      nextSteps: [],
      blockedItems: [],
      decisions: [],
      activeTasks: "",
    });
    expect(out.sources).toEqual([]);
    expect(out.conflicts).toEqual([]);
  });

  it("lists open PRs as openBranches from live repo state", () => {
    const out = reconstructHandoff(
      live({ openPRs: [{ number: 12, title: "Fix thing", headRefName: "fix/thing" }] }),
      null,
      null,
      NOW,
    );
    expect(out.session.openBranches).toEqual(["#12 Fix thing (fix/thing)"]);
    expect(out.sources).toContain("live-repo");
  });

  it("adds an unopened-PR branch entry when HEAD is ahead of base with no PR", () => {
    const out = reconstructHandoff(live({ aheadOfBase: 3 }), null, null, NOW);
    expect(out.session.openBranches).toEqual(["develop — 3 commit(s) ahead of main, no open PR"]);
  });

  it("summarizes live crews into activeTasks and surfaces blocked ones", () => {
    const out = reconstructHandoff(
      live({
        liveCrews: [
          { name: "crew-1", state: "working", task: "fix bug" },
          { name: "crew-2", state: "blocked", task: "add feature", question: "which approach?" },
        ],
      }),
      null,
      null,
      NOW,
    );
    expect(out.session.activeTasks).toBe("2 live crew(s): 1 working, 1 blocked");
    expect(out.session.blockedItems).toEqual(["crew-2: which approach?"]);
    expect(out.sources).toContain("live-repo");
  });

  it("prefers claude-mem for currentState/nextSteps/decisions over transcript", () => {
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
    const transcript: TranscriptTail = {
      path: "/tmp/x.jsonl",
      mtimeIso: "2026-08-03T00:00:00.000Z",
      lastUserMessage: "ignore me",
      lastAssistantText: "ignore me too",
    };
    const out = reconstructHandoff(live(), claudeMem, transcript, NOW);
    expect(out.session.currentState).toBe("fixed the race in the liveness registry");
    expect(out.session.nextSteps).toEqual(["write a regression test", "ship v0.17.1"]);
    expect(out.session.decisions).toEqual(["retry budget — capped retries at 3, not configurable"]);
    expect(out.sources).toContain("claude-mem");
    expect(out.sources).not.toContain("transcript");
    expect(out.timeWindow.from).toBe("2026-08-01T00:00:00.000Z");
  });

  it("falls back to the transcript for currentState when claude-mem has nothing", () => {
    const transcript: TranscriptTail = {
      path: "/tmp/x.jsonl",
      mtimeIso: "2026-08-03T00:00:00.000Z",
      lastUserMessage: "what's next",
      lastAssistantText: "I've committed the fix and I'm waiting on CI",
    };
    const out = reconstructHandoff(live(), null, transcript, NOW);
    expect(out.session.currentState).toBe("I've committed the fix and I'm waiting on CI");
    expect(out.session.nextSteps).toEqual([]);
    expect(out.session.decisions).toEqual([]);
    expect(out.sources).toContain("transcript");
    expect(out.sources).not.toContain("claude-mem");
    expect(out.timeWindow.from).toBe("2026-08-03T00:00:00.000Z");
  });

  it("falls back to the transcript's last user message when there is no assistant text", () => {
    const transcript: TranscriptTail = {
      path: "/tmp/x.jsonl",
      mtimeIso: "2026-08-03T00:00:00.000Z",
      lastUserMessage: "please finish the migration",
      lastAssistantText: null,
    };
    const out = reconstructHandoff(live(), null, transcript, NOW);
    expect(out.session.currentState).toBe("Last user request: please finish the migration");
  });

  it("flags a conflict when claude-mem claims a still-open PR shipped, and live repo wins", () => {
    const claudeMem: ClaudeMemSummary = {
      latestSessionSummary: {
        request: null,
        completed: "PR #12 (fix/thing) was merged and the fix is live",
        nextSteps: null,
        createdAt: "2026-08-02T10:00:00.000Z",
      },
      recentDecisions: [],
      oldestCreatedAt: "2026-08-02T10:00:00.000Z",
    };
    const out = reconstructHandoff(
      live({ openPRs: [{ number: 12, title: "Fix thing", headRefName: "fix/thing" }] }),
      claudeMem,
      null,
      NOW,
    );
    // Live repo wins: PR #12 still shows up as an open branch.
    expect(out.session.openBranches).toEqual(["#12 Fix thing (fix/thing)"]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({
      field: "openBranches",
      fact: expect.stringContaining("PR #12"),
      resolution: expect.stringContaining("live repo"),
    });
    expect(out.conflicts[0].claim).toContain("merged");
  });

  it("does not flag a conflict when claude-mem and live repo agree", () => {
    const claudeMem: ClaudeMemSummary = {
      latestSessionSummary: {
        request: null,
        completed: "still working on PR #12 (fix/thing), CI is red",
        nextSteps: null,
        createdAt: "2026-08-02T10:00:00.000Z",
      },
      recentDecisions: [],
      oldestCreatedAt: "2026-08-02T10:00:00.000Z",
    };
    const out = reconstructHandoff(
      live({ openPRs: [{ number: 12, title: "Fix thing", headRefName: "fix/thing" }] }),
      claudeMem,
      null,
      NOW,
    );
    expect(out.conflicts).toEqual([]);
  });

  it("carries no warnings when aheadOfBase came from the gh API (always fresh)", () => {
    const out = reconstructHandoff(live({ aheadOfBaseSource: "gh-api", fetchAgeMs: null }), null, null, NOW);
    expect(out.warnings).toEqual([]);
  });

  it("warns when aheadOfBase is local-git and fetch age exceeds the staleness threshold", () => {
    const out = reconstructHandoff(
      live({ aheadOfBaseSource: "local-git", fetchAgeMs: STALE_FETCH_WARNING_MS + 1 }),
      null,
      null,
      NOW,
    );
    expect(out.warnings).toEqual([expect.stringContaining("local git")]);
  });

  it("does not warn when aheadOfBase is local-git but the fetch is recent", () => {
    const out = reconstructHandoff(
      live({ aheadOfBaseSource: "local-git", fetchAgeMs: STALE_FETCH_WARNING_MS - 1 }),
      null,
      null,
      NOW,
    );
    expect(out.warnings).toEqual([]);
  });

  it("warns when aheadOfBase is local-git and fetch age is unknown (no .git/FETCH_HEAD)", () => {
    const out = reconstructHandoff(live({ aheadOfBaseSource: "local-git", fetchAgeMs: null }), null, null, NOW);
    expect(out.warnings).toEqual([expect.stringContaining("no known last-fetch")]);
  });

  it("warns on a detached HEAD instead of silently letting it drive openBranches", () => {
    const out = reconstructHandoff(
      live({ branch: "HEAD", detached: true, aheadOfBase: 5 }),
      null,
      null,
      NOW,
    );
    expect(out.warnings).toEqual([expect.stringContaining("detached HEAD")]);
    // No "HEAD — 5 commit(s) ahead..." entry — HEAD isn't a meaningful branch name.
    expect(out.session.openBranches).toEqual([]);
  });

  it("surfaces aheadOfBaseSource and fetchAgeMs as first-class top-level fields, not just buried in a warning string", () => {
    const out = reconstructHandoff(
      live({ aheadOfBaseSource: "local-git", fetchAgeMs: 12 * 60 * 60 * 1000 }),
      null,
      null,
      NOW,
    );
    expect(out.aheadOfBaseSource).toBe("local-git");
    expect(out.fetchAgeMs).toBe(12 * 60 * 60 * 1000);
  });

  it("merges live-repo-internal conflicts (e.g. gh-vs-local base SHA disagreement) into the output", () => {
    const liveConflict: HandoffConflict = {
      field: "baseBranch",
      claim: "local git's last-known main is abc1234 (fetched 98h ago)",
      fact: "GitHub's live main is def5678",
      resolution: "GitHub API wins — local git may be stale",
    };
    const out = reconstructHandoff(live({ conflicts: [liveConflict] }), null, null, NOW);
    expect(out.conflicts).toContainEqual(liveConflict);
  });
});
