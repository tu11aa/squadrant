# Plugin/Extension System — Phase 3: Tracker Slot

> **✅ Shipped** (PR #28, 2026-04-21). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-04-21
**Status:** Draft — design only, implementation in next sprint
**Issue:** [#9](https://github.com/tu11aa/claude-cockpit/issues/9)
**Phase:** 3 of N (tracker slot after runtime + workspace)
**Depends on:** Phase 1 (runtime, PR #20) + Phase 2 (workspace, PR #26)

## Problem

Cockpit's issue/PR tracking layer is tightly coupled to GitHub via the `gh` CLI. Across 7 files — `scripts/poll-github.sh`, `scripts/match-reactions.sh`, `scripts/execute-reaction.sh`, `scripts/reactor-cycle.sh`, `src/commands/reactor.ts`, `src/commands/feedback.ts`, `src/config.ts` — every issue/PR operation shells out to `gh`. The reactor engine's declarative `reactions.json` bakes GitHub vocabulary (`source: "github-issues"`, `trigger.review_decision`, `action: "auto-merge"`) directly into the schema.

Swapping GitHub for Linear, Jira, or GitLab requires editing every one of those call-sites and either renaming vocabulary or living with the github-named-everything.

## Goal

Abstract issue/PR tracking behind a `TrackerDriver` interface mirroring the phase 1 (runtime) and phase 2 (workspace) patterns. GitHub remains the default and only shipped implementation. The abstraction:

- Moves one-shot gh CLI operations (create-issue, merge-pr, get-checks, get-run-log) behind a driver boundary exposed through `cockpit tracker` CLI
- Leaves provider-specific polling (`poll-github.sh`) as-is — a future Linear provider adds `poll-linear.sh` alongside rather than wrapping
- Ships as thin primitive ops (no cross-provider enrichment) — follow-up [#27](https://github.com/tu11aa/claude-cockpit/issues/27) tracks cross-tracker normalization when a second provider lands

## Non-Goals

- **Additional providers** (Linear, Jira, GitLab, Asana) — each is a follow-up PR.
- **Normalized cross-tracker vocabulary** — `reactions.json` keeps its GitHub-shaped keys (`github-issues`, `github-prs`). Deferred as follow-up when a 2nd provider ships.
- **Rewriting `poll-github.sh`** — it stays as the canonical GitHub-polling script. Future providers add their own poll scripts.
- **Enriched list operations** — drivers expose primitive ops only. Callers (today: the reactor) compose multi-call enrichment patterns in their own code.
- **GitHub project-board GraphQL** abstraction — `update-project-status` in `reactions.json` is already a TODO in `execute-reaction.sh`. Stays TODO for now.
- **External plugin loading** from `node_modules` — deferred to phase 5.
- **Notifier slot** — phase 4.
- **Strict typing of `TrackerScope`** — shipping loose (`[key: string]: unknown`) to match phases 1 and 2. Tightening tracked when the first non-GitHub provider lands.

## Architecture: Tracker Driver (mirrors Runtime + Workspace)

```
cockpit core
  └── src/trackers/
        ├── types.ts         ← TrackerDriver interface + types
        ├── github.ts        ← GitHub (gh-CLI-backed) driver
        ├── registry.ts      ← TrackerRegistry — config + reactions-based scope resolution
        ├── index.ts         ← re-exports
        └── __tests__/       ← unit tests + in-memory helper
```

TS callers and one-shot bash operations go through the driver. `poll-github.sh` remains provider-specific and unchanged.

## 1. Tracker Driver Interface

```typescript
// src/trackers/types.ts
export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  assignees: string[];
  url: string;
  updatedAt: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed" | "merged";
  headSha: string;
  url: string;
  updatedAt: string;
}

export interface CheckRun {
  name: string;
  state: "success" | "failure" | "pending" | "skipped";
  link?: string;
  runId?: string;   // provider-specific identifier used by getRunLog
}

export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";

export interface TrackerProbeResult {
  installed: boolean;       // provider CLI/deps present (e.g., gh)
  authenticated: boolean;   // auth valid
}

export interface TrackerScope {
  owner?: string;
  repo?: string;
  [key: string]: unknown;   // provider-specific (loose; follow-up tightening tracked)
}

export interface IssueFilter {
  labels?: string[];
  state?: "open" | "closed";
  assigned?: boolean;       // undefined = any, true = has assignee, false = unassigned
}

export interface TrackerDriver {
  name: string;             // "github", "linear", ...

  probe(): Promise<TrackerProbeResult>;

  listIssues(filter: IssueFilter): Promise<Issue[]>;
  createIssue(input: { title: string; body: string; labels?: string[] }): Promise<{ number: number; url: string }>;

  listPullRequests(filter: { state?: "open" | "closed" | "all" }): Promise<PullRequest[]>;
  getPullRequestChecks(number: number): Promise<CheckRun[]>;
  getPullRequestReviewDecision(number: number): Promise<ReviewDecision>;
  getRunLog(runId: string, options?: { tail?: number }): Promise<string>;
  mergePullRequest(number: number, method: "merge" | "squash" | "rebase"): Promise<void>;
}

export type TrackerFactory = (scope: TrackerScope) => TrackerDriver;
```

### Contract notes

- **All operations are async and primitive.** No N+1 enrichment (e.g., `listPullRequests` does NOT fetch checks per PR). Callers that need enrichment compose `listPullRequests` + `getPullRequestChecks` in their own code.
- **`listIssues.assigned` is tri-state.** `undefined` = any, `true` = has at least one assignee, `false` = unassigned. The reactor's `not_assigned: true` maps to `assigned: false`.
- **`Issue.state` is binary (`open` | `closed`).** `PullRequest.state` is ternary (`open` | `closed` | `merged`) because merge is a separate concept from close. `mergePullRequest` transitions a PR to `merged`.
- **`CheckRun.runId` is provider-specific.** For GitHub it's the workflow run ID used by `gh run view --log-failed`. For other providers it might be something else. Drivers are responsible for resolving this identifier from their own data model.
- **`probe()` returns two flags.** `installed` = the provider CLI/library is present (e.g., `gh` binary); `authenticated` = auth check passes (e.g., `gh auth status`).

## 2. Registry & Config

```typescript
// src/trackers/registry.ts
export class TrackerRegistry {
  constructor(private factories: Record<string, TrackerFactory>) {}

  forProject(
    projectName: string,
    config: CockpitConfig,
    reactions: ReactionsConfig,
  ): TrackerDriver {
    const name = config.projects[projectName]?.tracker ?? config.tracker ?? DEFAULT_TRACKER;
    const repoConfig = reactions.github?.repos[projectName] ?? {};
    return this.get(name)({ owner: repoConfig.owner, repo: repoConfig.repo });
  }

  get(name: string): TrackerFactory { /* ... throws on unknown ... */ }

  async probeAll(): Promise<Record<string, TrackerProbeResult>> { /* ... */ }
}
```

Config additions (both optional, default `"github"`; no migration required):

```jsonc
// ~/.config/cockpit/config.json
{
  "tracker": "github",             // NEW — global default
  "projects": {
    "brove": {
      "tracker": "github",         // NEW — optional per-project override
      "path": "~/projects/brove",
      "captainName": "brove-captain",
      "spokeVault": "~/cockpit-hub/spokes/brove",
      "host": "local",
      "runtime": "cmux",
      "workspace": "obsidian"
    }
  }
}
```

`reactions.json` stays as-is. Scope resolution reads `reactions.json.github.repos[projectName]` for the GitHub provider because that's where repo mapping currently lives. A future Linear provider would read from `reactions.json.linear.projects[...]` (added by the Linear PR).

## 3. CLI Subcommand (one-shot ops only)

New command at `src/commands/tracker.ts`:

```
cockpit tracker create-issue <project> <title> [--body -] [--label x,y,z]
cockpit tracker merge-pr <project> <number> [--method squash|merge|rebase]
cockpit tracker get-checks <project> <pr-number> [--json]
cockpit tracker get-run-log <project> <run-id> [--tail N]
cockpit tracker list-issues <project> [--label x] [--state open|closed] [--unassigned]
```

Deliberately **not** exposing `list-pull-requests` / `get-pr-review-decision` — those are hot-path poll operations used only by `poll-github.sh`, which stays raw gh-cli per phase 3's hybrid decision.

`create-issue` with `--body -` reads from stdin.

Process-spawn overhead (~100ms) is acceptable: each CLI call is a one-shot user- or reactor-action, not a loop.

## 4. Refactor Surface

| File | Current | After |
|------|---------|-------|
| `src/commands/feedback.ts` | `execSync("gh issue create --repo ... --title ... --body ...")` | `TrackerRegistry → driver.createIssue(...)` |
| `scripts/execute-reaction.sh` `auto-merge` case | `gh pr merge "$NUMBER" --repo "$REPO_INFO" --"$MERGE_METHOD" --auto` | `cockpit tracker merge-pr "$PROJECT" "$NUMBER" --method "$MERGE_METHOD"` |
| `scripts/execute-reaction.sh` `auto-fix-ci` case | `gh pr checks` + parse + `gh run view --log-failed` | `cockpit tracker get-checks "$PROJECT" "$NUMBER" --json` + `cockpit tracker get-run-log "$PROJECT" "$RUN_ID" --tail 100` |
| `scripts/poll-github.sh` | raw `gh api` calls | **unchanged** — provider-specific polling stays specialized |
| `scripts/match-reactions.sh` | provider-agnostic | **unchanged** |
| `src/commands/doctor.ts` | no tracker-specific check today | probe configured trackers; reports `installed` + `authenticated` |

## 5. Testing

Mirror `src/runtimes/__tests__/` and `src/workspaces/__tests__/`:

- **Unit tests** for `GitHubDriver` — mock `execSync` with realistic `gh api` / `gh pr` fixtures covering issues list, PR list, check-runs JSON, run log tail, merge call, issue create call.
- **Unit tests** for `TrackerRegistry` — project override > global > default > unknown-provider throw.
- **In-memory test driver** — `createMemoryTrackerDriver(initial?)` backed by an in-memory issue/PR list. Used by `feedback.ts` tests and any future TS caller.
- **Integration smoke** — `cockpit tracker list-issues <project> --state open` against a real repo, gated behind `SKIP_INTEGRATION=1`.
- **Bash regression** — smoke-test `execute-reaction.sh` `auto-merge` and `auto-fix-ci` paths against a mock `cockpit` binary that records calls.

## 6. Rollout

1. Land this spec and implementation plan.
2. Implement `src/trackers/` with only `GitHubDriver`.
3. Add in-memory test driver.
4. Add `cockpit tracker` CLI subcommand.
5. Migrate `src/commands/feedback.ts` to use `driver.createIssue`.
6. Migrate `execute-reaction.sh` `auto-merge` and `auto-fix-ci` cases.
7. Add doctor probe for configured trackers.
8. Add config docs to README.
9. Ship as single PR.

## 7. Relationship to Other Work

- **Builds on:** Phase 1 runtime (PR #20), Phase 2 workspace (PR #26). Same driver+registry+CLI pattern.
- **Unblocks:** Linear driver (PR), GitLab driver (PR), Jira driver (PR) — each is a self-contained future addition.
- **Precedes:** Phase 4 — notifier slot (cmux-send → Slack/Discord). Simpler; narrow surface.
- **Follow-up:** [#27](https://github.com/tu11aa/claude-cockpit/issues/27) — Normalize cross-tracker vocabulary in `reactions.json` once a 2nd tracker ships.
