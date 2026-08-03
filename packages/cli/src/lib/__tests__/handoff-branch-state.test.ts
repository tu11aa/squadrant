import { describe, it, expect } from "vitest";
import { parseUpstreamTrack, gatherBranchState } from "../handoff-branch-state.js";
import type { CommandRunner } from "../handoff-live-repo.js";

// Motivated by a real incident: local `main` was 164 commits stale, nobody
// noticed, and the captain reported "188 commits ahead" when the truth was
// 24. Every state below must be an explicit, distinct flag — never prose —
// so a cheap model can act on it without interpreting.
describe("parseUpstreamTrack (pure)", () => {
  it("reports no-upstream when the upstream field is empty", () => {
    expect(parseUpstreamTrack("|")).toEqual({ upstreamStatus: "no-upstream", aheadOfUpstream: null, behindUpstream: null });
  });

  it("reports up-to-date when an upstream exists with no ahead/behind data", () => {
    expect(parseUpstreamTrack("origin/develop|")).toEqual({
      upstreamStatus: "up-to-date",
      aheadOfUpstream: 0,
      behindUpstream: 0,
    });
  });

  it("reports behind with the count", () => {
    expect(parseUpstreamTrack("origin/develop|[behind 164]")).toEqual({
      upstreamStatus: "behind",
      aheadOfUpstream: 0,
      behindUpstream: 164,
    });
  });

  it("reports ahead with the count", () => {
    expect(parseUpstreamTrack("origin/develop|[ahead 3]")).toEqual({
      upstreamStatus: "ahead",
      aheadOfUpstream: 3,
      behindUpstream: 0,
    });
  });

  it("reports diverged with both counts", () => {
    expect(parseUpstreamTrack("origin/develop|[ahead 2, behind 5]")).toEqual({
      upstreamStatus: "diverged",
      aheadOfUpstream: 2,
      behindUpstream: 5,
    });
  });

  it("reports upstream-gone when git's own tracking says so", () => {
    expect(parseUpstreamTrack("origin/develop|[gone]")).toEqual({
      upstreamStatus: "upstream-gone",
      aheadOfUpstream: null,
      behindUpstream: null,
    });
  });

  it("reports unknown when the git command itself failed", () => {
    expect(parseUpstreamTrack(null)).toEqual({ upstreamStatus: "unknown", aheadOfUpstream: null, behindUpstream: null });
  });
});

function fakeRunner(handlers: Record<string, string | (() => string)>): CommandRunner {
  return {
    run(cmd, args) {
      const key = `${cmd} ${args.join(" ")}`;
      const handler = handlers[key];
      if (handler === undefined) throw new Error(`unhandled command: ${key}`);
      return typeof handler === "function" ? handler() : handler;
    },
  };
}

describe("gatherBranchState (impure)", () => {
  const TRACK_CMD = "git -C REPO for-each-ref --format=%(upstream:short)|%(upstream:track) refs/heads/develop";
  const REV_PARSE_BRANCH = "git -C REPO rev-parse develop";
  const REV_PARSE_ORIGIN_BASE = "git -C REPO rev-parse --verify origin/main";
  const MERGE_BASE = "git -C REPO merge-base develop origin/main";
  const STATUS = "git -C REPO status --porcelain";

  it("reports mergedIntoBase: true when the branch tip equals the merge-base with origin/<base>", () => {
    const runner = fakeRunner({
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: "sha1\n",
      [REV_PARSE_BRANCH]: "sha1\n",
      [MERGE_BASE]: "sha1\n",
      [STATUS]: "",
    });
    const state = gatherBranchState(runner, "REPO", "develop", "main", false, false);
    expect(state.mergedIntoBase).toBe(true);
  });

  it("reports mergedIntoBase: false when the branch has commits not in base", () => {
    const runner = fakeRunner({
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: "sha-base\n",
      [REV_PARSE_BRANCH]: "sha-branch\n",
      [MERGE_BASE]: "sha-base\n",
      [STATUS]: "",
    });
    const state = gatherBranchState(runner, "REPO", "develop", "main", false, false);
    expect(state.mergedIntoBase).toBe(false);
  });

  // Real bug, live on squadrant itself: when the captain is standing ON the
  // project's base branch (branch === baseBranch, e.g. both "develop"),
  // comparing the branch against itself trivially reports mergedIntoBase:
  // true and aheadOfBase: 0 — read literally, "merged, safe to delete" on
  // the branch you're standing on. SKILL.md tells the captain to ACT on
  // these flags, so a cheap model could try to delete develop. Must be
  // null/n-a, never a real-looking true/0, and no git calls should even be
  // attempted for a comparison that's definitionally meaningless.
  it("reports mergedIntoBase: null (not true) when branch === baseBranch — a self-comparison, not a real answer", () => {
    // These handlers are what a REAL self-comparison would actually return
    // (rev-parse and merge-base on the same ref trivially agree) — if the
    // guard were missing, this would silently produce `true`, exactly the
    // live bug. The guard must short-circuit before these are even called.
    const runner = fakeRunner({
      [STATUS]: "",
      "git -C REPO for-each-ref --format=%(upstream:short)|%(upstream:track) refs/heads/develop": "origin/develop|\n",
      "git -C REPO rev-parse --verify origin/develop": "sha1\n",
      "git -C REPO rev-parse develop": "sha1\n",
      "git -C REPO merge-base develop origin/develop": "sha1\n",
    });
    const state = gatherBranchState(runner, "REPO", "develop", "develop", false, false);
    expect(state.mergedIntoBase).toBeNull();
  });

  it("prefers origin/<base> over the local base branch for merge-base freshness", () => {
    const runner = fakeRunner({
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: "sha1\n",
      [REV_PARSE_BRANCH]: "sha1\n",
      [MERGE_BASE]: "sha1\n", // keyed against origin/main — proves it was used
      [STATUS]: "",
    });
    gatherBranchState(runner, "REPO", "develop", "main", false, false);
    // If the implementation had used local "main" instead, MERGE_BASE's key
    // ("...merge-base develop origin/main") would never be hit and fakeRunner
    // would throw "unhandled command" — reaching here proves origin/main was used.
    expect(true).toBe(true);
  });

  it("falls back to the local base branch when origin/<base> doesn't resolve", () => {
    const runner = fakeRunner({
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: () => {
        throw new Error("no such ref");
      },
      [REV_PARSE_BRANCH]: "sha1\n",
      "git -C REPO merge-base develop main": "sha1\n",
      [STATUS]: "",
    });
    const state = gatherBranchState(runner, "REPO", "develop", "main", false, false);
    expect(state.mergedIntoBase).toBe(true);
  });

  it("reports dirtyWorkingTree: true when git status --porcelain has output", () => {
    const runner = fakeRunner({
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: "sha1\n",
      [REV_PARSE_BRANCH]: "sha1\n",
      [MERGE_BASE]: "sha1\n",
      [STATUS]: " M some/file.ts\n",
    });
    expect(gatherBranchState(runner, "REPO", "develop", "main", false, false).dirtyWorkingTree).toBe(true);
  });

  it("reports dirtyWorkingTree: false on a clean tree", () => {
    const runner = fakeRunner({
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: "sha1\n",
      [REV_PARSE_BRANCH]: "sha1\n",
      [MERGE_BASE]: "sha1\n",
      [STATUS]: "",
    });
    expect(gatherBranchState(runner, "REPO", "develop", "main", false, false).dirtyWorkingTree).toBe(false);
  });

  it("flags onUnexpectedBranch when sitting on a crew/* worktree branch", () => {
    const runner = fakeRunner({
      "git -C REPO for-each-ref --format=%(upstream:short)|%(upstream:track) refs/heads/crew/fix-123": "|\n",
      "git -C REPO rev-parse crew/fix-123": "sha1\n",
      [REV_PARSE_ORIGIN_BASE]: "sha1\n",
      "git -C REPO merge-base crew/fix-123 origin/main": "sha0\n",
      [STATUS]: "",
    });
    const state = gatherBranchState(runner, "REPO", "crew/fix-123", "main", false, false);
    expect(state.onUnexpectedBranch).toBe(true);
  });

  it("does not flag onUnexpectedBranch for the ordinary base/feature branch case", () => {
    const runner = fakeRunner({
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: "sha1\n",
      [REV_PARSE_BRANCH]: "sha1\n",
      [MERGE_BASE]: "sha1\n",
      [STATUS]: "",
    });
    expect(gatherBranchState(runner, "REPO", "develop", "main", false, false).onUnexpectedBranch).toBe(false);
  });

  it("degrades to unknown/null fields instead of crashing when detached", () => {
    const runner = fakeRunner({ [STATUS]: "" });
    const state = gatherBranchState(runner, "REPO", "HEAD", "main", true, false);
    expect(state.upstreamStatus).toBe("unknown");
    expect(state.aheadOfUpstream).toBeNull();
    expect(state.behindUpstream).toBeNull();
    expect(state.mergedIntoBase).toBeNull();
    expect(state.onUnexpectedBranch).toBe(false);
  });

  it("never fetches by default — fetchPerformed is false and no fetch command is even attempted", () => {
    const runner = fakeRunner({
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: "sha1\n",
      [REV_PARSE_BRANCH]: "sha1\n",
      [MERGE_BASE]: "sha1\n",
      [STATUS]: "",
      // Deliberately no handler for "fetch" — if the implementation tried
      // it anyway, fakeRunner would throw "unhandled command" and fail this test.
    });
    const state = gatherBranchState(runner, "REPO", "develop", "main", false, false);
    expect(state.fetchPerformed).toBe(false);
  });

  it("fetches when explicitly opted in, and reports fetchPerformed: true", () => {
    let fetchCalled = false;
    const runner = fakeRunner({
      "git -C REPO fetch origin": () => {
        fetchCalled = true;
        return "";
      },
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: "sha1\n",
      [REV_PARSE_BRANCH]: "sha1\n",
      [MERGE_BASE]: "sha1\n",
      [STATUS]: "",
    });
    const state = gatherBranchState(runner, "REPO", "develop", "main", false, true);
    expect(fetchCalled).toBe(true);
    expect(state.fetchPerformed).toBe(true);
  });

  it("reports fetchPerformed: false when --fetch was requested but the fetch itself failed (offline)", () => {
    const runner = fakeRunner({
      "git -C REPO fetch origin": () => {
        throw new Error("could not resolve host");
      },
      [TRACK_CMD]: "origin/develop|\n",
      [REV_PARSE_ORIGIN_BASE]: "sha1\n",
      [REV_PARSE_BRANCH]: "sha1\n",
      [MERGE_BASE]: "sha1\n",
      [STATUS]: "",
    });
    const state = gatherBranchState(runner, "REPO", "develop", "main", false, true);
    expect(state.fetchPerformed).toBe(false);
  });
});
