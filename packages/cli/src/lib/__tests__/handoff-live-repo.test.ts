import { describe, it, expect } from "vitest";
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

describe("gatherLiveRepoState", () => {
  it("collects branch, recent commits, ahead-of-base count, PRs, and live crews", () => {
    const runner = fakeRunner({
      "git -C /repo rev-parse --abbrev-ref HEAD": "feature/x\n",
      "git -C /repo log -15 --oneline": "abc123 do a thing\ndef456 do another\n",
      "git -C /repo rev-list --count develop..HEAD": "2\n",
      "gh pr list --json number,title,headRefName --limit 20":
        JSON.stringify([{ number: 12, title: "Fix thing", headRefName: "fix/thing" }]),
    });
    const tasks = [
      task({ name: "crew-1", state: "working", task: "fix bug" }),
      task({ name: "crew-2", state: "blocked", task: "add feature", question: "which approach?" }),
      task({ name: "crew-3", state: "done", task: "already shipped" }),
    ];

    const state = gatherLiveRepoState("/repo", "develop", tasks, runner);

    expect(state.branch).toBe("feature/x");
    expect(state.baseBranch).toBe("develop");
    expect(state.recentCommits).toEqual(["abc123 do a thing", "def456 do another"]);
    expect(state.aheadOfBase).toBe(2);
    expect(state.openPRs).toEqual([{ number: 12, title: "Fix thing", headRefName: "fix/thing" }]);
    // done is terminal — excluded from live crews.
    expect(state.liveCrews).toEqual([
      { name: "crew-1", state: "working", task: "fix bug", question: undefined },
      { name: "crew-2", state: "blocked", task: "add feature", question: "which approach?" },
    ]);
  });

  it("degrades gracefully when gh fails (no auth / no remote) instead of throwing", () => {
    const runner = fakeRunner({
      "git -C /repo rev-parse --abbrev-ref HEAD": "develop\n",
      "git -C /repo log -15 --oneline": "",
      "git -C /repo rev-list --count develop..HEAD": "0\n",
      "gh pr list --json number,title,headRefName --limit 20": () => {
        throw new Error("gh: not authenticated");
      },
    });

    const state = gatherLiveRepoState("/repo", "develop", [], runner);

    expect(state.openPRs).toEqual([]);
  });

  it("degrades gracefully when every git command fails", () => {
    const runner: CommandRunner = {
      run() {
        throw new Error("git not found");
      },
    };

    const state = gatherLiveRepoState("/repo", "develop", [], runner);

    expect(state).toEqual({
      branch: "",
      baseBranch: "develop",
      recentCommits: [],
      aheadOfBase: 0,
      openPRs: [],
      liveCrews: [],
    });
  });
});
