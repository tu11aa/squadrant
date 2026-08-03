import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatherLiveRepoState } from "../handoff-live-repo.js";
import type { CommandRunner } from "../handoff-live-repo.js";
import type { TaskRecord } from "@squadrant/shared";

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

function task(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "t1",
    project: "squadrant",
    provider: "claude",
    mode: "interactive",
    state: "working",
    task: "do the thing",
    createdAt: 0,
    lastHeartbeat: 0,
    lastEvent: "dispatch",
    heartbeatBudgetMs: 300000,
    attempts: [],
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-03T16:00:00.000Z");
const REPO_VIEW = "gh repo view --json nameWithOwner,defaultBranchRef";
const PR_LIST = "gh pr list --json number,title,headRefName --limit 20";

describe("gatherLiveRepoState", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-live-repo-"));
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("prefers the gh API for base branch and ahead-of-base — always fresh, no fetch needed", () => {
    const runner = fakeRunner({
      "git -C REPO rev-parse --abbrev-ref HEAD": "feature/x\n",
      "git -C REPO log -15 --oneline": "abc123 do a thing\n",
      [REPO_VIEW]: JSON.stringify({ nameWithOwner: "acme/squadrant", defaultBranchRef: { name: "develop" } }),
      "gh api repos/acme/squadrant/compare/develop...feature/x --jq .ahead_by": "3\n",
      "gh api repos/acme/squadrant/commits/develop --jq .sha": "sha-gh\n",
      "git -C REPO rev-parse origin/develop": "sha-gh\n",
      [PR_LIST]: JSON.stringify([{ number: 12, title: "Fix thing", headRefName: "fix/thing" }]),
    });

    const state = gatherLiveRepoState("REPO", "main", [], runner, NOW);

    expect(state.branch).toBe("feature/x");
    expect(state.detached).toBe(false);
    expect(state.baseBranch).toBe("develop");
    expect(state.baseBranchSource).toBe("gh-api");
    expect(state.aheadOfBase).toBe(3);
    expect(state.aheadOfBaseSource).toBe("gh-api");
    expect(state.openPRs).toEqual([{ number: 12, title: "Fix thing", headRefName: "fix/thing" }]);
    expect(state.conflicts).toEqual([]); // gh sha === local sha, no disagreement
  });

  it("falls back to local git ONLY when gh is entirely unavailable, using the fallback base branch and origin/<base>", () => {
    const runner: CommandRunner = {
      run(cmd, args) {
        const key = `${cmd} ${args.join(" ")}`;
        if (key === "git -C REPO rev-parse --abbrev-ref HEAD") return "develop\n";
        if (key === "git -C REPO log -15 --oneline") return "";
        if (key === "git -C REPO rev-list --count origin/main..HEAD") return "7\n";
        // Everything gh-related fails — no auth / no network / gh missing.
        if (cmd === "gh") throw new Error("gh: command not found");
        throw new Error(`unhandled command: ${key}`);
      },
    };

    const state = gatherLiveRepoState("REPO", "main", [], runner, NOW);

    expect(state.baseBranch).toBe("main"); // the passed-in fallback, never invented
    expect(state.baseBranchSource).toBe("local-fallback");
    expect(state.aheadOfBase).toBe(7);
    expect(state.aheadOfBaseSource).toBe("local-git");
    expect(state.openPRs).toEqual([]);
    expect(state.conflicts).toEqual([]); // no gh sha to compare against — nothing to disagree with
  });

  it("detects a gh-vs-local base SHA disagreement, prefers gh, and records the conflict", () => {
    const runner = fakeRunner({
      "git -C REPO rev-parse --abbrev-ref HEAD": "develop\n",
      "git -C REPO log -15 --oneline": "",
      [REPO_VIEW]: JSON.stringify({ nameWithOwner: "acme/squadrant", defaultBranchRef: { name: "main" } }),
      "gh api repos/acme/squadrant/compare/main...develop --jq .ahead_by": "24\n",
      "gh api repos/acme/squadrant/commits/main --jq .sha": "9c67e0ce\n",
      "git -C REPO rev-parse origin/main": "24b07815\n", // stale — 4 days since last fetch
      [PR_LIST]: "[]",
    });

    const state = gatherLiveRepoState("REPO", "develop", [], runner, NOW);

    // gh wins for the actual count used.
    expect(state.aheadOfBase).toBe(24);
    expect(state.aheadOfBaseSource).toBe("gh-api");
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]).toMatchObject({
      field: "baseBranch",
      resolution: expect.stringContaining("GitHub"),
    });
    expect(state.conflicts[0].claim).toContain("24b07815");
    expect(state.conflicts[0].fact).toContain("9c67e0ce");
  });

  it("does not flag a conflict when gh and local base SHAs agree", () => {
    const runner = fakeRunner({
      "git -C REPO rev-parse --abbrev-ref HEAD": "develop\n",
      "git -C REPO log -15 --oneline": "",
      [REPO_VIEW]: JSON.stringify({ nameWithOwner: "acme/squadrant", defaultBranchRef: { name: "main" } }),
      "gh api repos/acme/squadrant/compare/main...develop --jq .ahead_by": "1\n",
      "gh api repos/acme/squadrant/commits/main --jq .sha": "sameSha\n",
      "git -C REPO rev-parse origin/main": "sameSha\n",
      [PR_LIST]: "[]",
    });

    const state = gatherLiveRepoState("REPO", "develop", [], runner, NOW);

    expect(state.conflicts).toEqual([]);
  });

  it("reports a detached HEAD without treating it as a branch, and skips the gh compare (no branch to compare)", () => {
    const runner = fakeRunner({
      "git -C REPO rev-parse --abbrev-ref HEAD": "HEAD\n",
      "git -C REPO log -15 --oneline": "",
      [REPO_VIEW]: JSON.stringify({ nameWithOwner: "acme/squadrant", defaultBranchRef: { name: "main" } }),
      // Deliberately NO handler for a "compare/main...HEAD" call — if the
      // implementation tried it, fakeRunner throws and the test fails.
      "gh api repos/acme/squadrant/commits/main --jq .sha": "sha1\n",
      "git -C REPO rev-parse origin/main": "sha1\n",
      "git -C REPO rev-list --count origin/main..HEAD": "5\n",
      [PR_LIST]: "[]",
    });

    const state = gatherLiveRepoState("REPO", "main", [], runner, NOW);

    expect(state.branch).toBe("HEAD");
    expect(state.detached).toBe(true);
    // No gh compare for a detached HEAD — falls back to local git.
    expect(state.aheadOfBase).toBe(5);
    expect(state.aheadOfBaseSource).toBe("local-git");
  });

  it("computes fetchAgeMs from the real .git/FETCH_HEAD mtime", () => {
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    const fetchHead = path.join(repoDir, ".git", "FETCH_HEAD");
    fs.writeFileSync(fetchHead, "");
    const mtime = new Date(NOW - 3 * 60 * 60 * 1000); // 3h ago
    fs.utimesSync(fetchHead, mtime, mtime);

    const runner: CommandRunner = {
      run(cmd, args) {
        const key = `${cmd} ${args.join(" ")}`;
        if (key === `git -C ${repoDir} rev-parse --abbrev-ref HEAD`) return "develop\n";
        if (key === `git -C ${repoDir} log -15 --oneline`) return "";
        if (cmd === "gh") throw new Error("gh unavailable");
        if (key === `git -C ${repoDir} rev-list --count origin/main..HEAD`) return "0\n";
        throw new Error(`unhandled command: ${key}`);
      },
    };

    const state = gatherLiveRepoState(repoDir, "main", [], runner, NOW);

    expect(state.fetchAgeMs).toBe(3 * 60 * 60 * 1000);
  });

  it("reports fetchAgeMs: null when .git/FETCH_HEAD does not exist", () => {
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    const runner: CommandRunner = {
      run(cmd, args) {
        const key = `${cmd} ${args.join(" ")}`;
        if (key === `git -C ${repoDir} rev-parse --abbrev-ref HEAD`) return "develop\n";
        if (key === `git -C ${repoDir} log -15 --oneline`) return "";
        if (cmd === "gh") throw new Error("gh unavailable");
        if (key === `git -C ${repoDir} rev-list --count origin/main..HEAD`) return "0\n";
        throw new Error(`unhandled command: ${key}`);
      },
    };

    const state = gatherLiveRepoState(repoDir, "main", [], runner, NOW);

    expect(state.fetchAgeMs).toBeNull();
  });

  it("filters live crews by non-terminal state (unchanged from before)", () => {
    const runner = fakeRunner({
      "git -C REPO rev-parse --abbrev-ref HEAD": "develop\n",
      "git -C REPO log -15 --oneline": "",
      [REPO_VIEW]: () => {
        throw new Error("gh unavailable");
      },
      "git -C REPO rev-list --count origin/main..HEAD": "0\n",
      [PR_LIST]: () => {
        throw new Error("gh unavailable");
      },
    });
    const tasks = [
      task({ name: "crew-1", state: "working", task: "fix bug" }),
      task({ name: "crew-2", state: "blocked", task: "add feature", question: "which approach?" }),
      task({ name: "crew-3", state: "done", task: "already shipped" }),
    ];

    const state = gatherLiveRepoState("REPO", "main", tasks, runner, NOW);

    expect(state.liveCrews).toEqual([
      { name: "crew-1", state: "working", task: "fix bug", question: undefined },
      { name: "crew-2", state: "blocked", task: "add feature", question: "which approach?" },
    ]);
  });

  it("degrades gracefully to safe defaults when every git and gh command fails", () => {
    const runner: CommandRunner = {
      run() {
        throw new Error("nothing works");
      },
    };

    const state = gatherLiveRepoState("REPO", "main", [], runner, NOW);

    expect(state).toEqual({
      branch: "",
      detached: false,
      baseBranch: "main",
      baseBranchSource: "local-fallback",
      recentCommits: [],
      aheadOfBase: 0,
      aheadOfBaseSource: "unknown",
      fetchAgeMs: null,
      openPRs: [],
      liveCrews: [],
      conflicts: [],
    });
  });
});
