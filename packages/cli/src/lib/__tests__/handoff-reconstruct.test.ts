import { describe, it, expect } from "vitest";
import { reconstructHandoff } from "../handoff-reconstruct.js";
import type { LiveRepoState, ClaudeMemSummary, TranscriptTail } from "../handoff-reconstruct.js";

const NOW = "2026-08-03T16:00:00.000Z";

function live(overrides: Partial<LiveRepoState> = {}): LiveRepoState {
  return {
    branch: "develop",
    baseBranch: "main",
    recentCommits: [],
    aheadOfBase: 0,
    openPRs: [],
    liveCrews: [],
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
      liveRepoFact: expect.stringContaining("PR #12"),
      resolution: expect.stringContaining("live repo"),
    });
    expect(out.conflicts[0].claudeMemClaim).toContain("merged");
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
});
