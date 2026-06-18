# Plugin System Phase 3 — Tracker Slot Implementation Plan

> **✅ Shipped** (PR #28, 2026-04-21). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abstract GitHub tracking operations (create-issue, merge-pr, get-checks, get-run-log) behind a `TrackerDriver` interface mirroring runtime (phase 1) and workspace (phase 2); expose one-shot ops via `cockpit tracker` CLI; migrate bash scripts (`execute-reaction.sh` auto-merge + auto-fix-ci paths) and add doctor probe.

**Architecture:** New `src/trackers/` directory parallel to `src/runtimes/` and `src/workspaces/`. `GitHubDriver` implements `TrackerDriver` via `gh` CLI (`child_process.execSync`). `TrackerRegistry` resolves provider per-project from `config.tracker` + `projects[name].tracker` + `reactions.json.github.repos`. Hybrid CLI: one-shot ops go through `cockpit tracker`; `poll-github.sh` stays raw.

**Tech Stack:** TypeScript, commander.js, vitest, Node 22 (`child_process`), gh CLI, bash.

**Spec:** `docs/specs/2026-04-21-plugin-system-tracker-design.md`

---

## File Structure

**Create:**
- `src/trackers/types.ts` — `TrackerDriver`, `Issue`, `PullRequest`, `CheckRun`, `ReviewDecision`, `TrackerScope`, `TrackerProbeResult`, `TrackerFactory`, `IssueFilter`
- `src/trackers/github.ts` — `createGitHubDriver(scope)` (gh-CLI-backed)
- `src/trackers/registry.ts` — `TrackerRegistry`
- `src/trackers/index.ts` — barrel
- `src/trackers/__tests__/github.test.ts`
- `src/trackers/__tests__/registry.test.ts`
- `src/trackers/__tests__/helpers/memory-tracker.ts` — in-memory test driver
- `src/commands/tracker.ts` — `cockpit tracker` CLI

**Modify:**
- `src/config.ts` — add `tracker?: string` to `ProjectConfig` and `CockpitConfig`
- `src/index.ts` — register `trackerCommand`
- `src/commands/doctor.ts` — probe configured trackers
- `scripts/execute-reaction.sh` — replace `gh pr merge`, `gh pr checks`, `gh run view` with `cockpit tracker` calls
- `README.md` — document `tracker` config field + CLI

**NOT modified (per spec §Non-Goals):**
- `scripts/poll-github.sh` — stays as canonical GitHub-polling script
- `scripts/match-reactions.sh` — provider-agnostic already
- `src/commands/feedback.ts` — opens browser URL (no `gh issue create` call today); stays unchanged
- `reactions.json` schema — GitHub vocabulary preserved; cross-tracker normalization deferred to #27

---

## Task 1: Add `tracker?` field to config types

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add `tracker?: string` to both interfaces**

In `src/config.ts`, update both interfaces. `ProjectConfig` already has `runtime?` and `workspace?` — add `tracker?` after those. Same for `CockpitConfig`.

```typescript
export interface ProjectConfig {
  path: string;
  captainName: string;
  spokeVault: string;
  host: string;
  group?: string;
  groupRole?: string;
  runtime?: string;
  workspace?: string;
  tracker?: string;  // NEW — overrides top-level tracker provider
}

export interface CockpitConfig {
  commandName: string;
  hubVault: string;
  projects: Record<string, ProjectConfig>;
  agents?: Record<string, AgentEntry>;
  runtime?: string;
  workspace?: string;
  tracker?: string;  // NEW — global default tracker ("github" when absent)
  defaults: {
    maxCrew: number;
    worktreeDir: string;
    teammateMode: string;
    permissions: PermissionConfig;
    models?: ModelRoutingConfig;
    roles?: RoleConfig;
  };
  metrics: {
    enabled: boolean;
    path: string;
  };
}
```

- [ ] **Step 2: Verify lint**

Run: `npm run lint`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(tracker): add optional tracker field to config types"
```

---

## Task 2: Define TrackerDriver interface

**Files:**
- Create: `src/trackers/types.ts`

- [ ] **Step 1: Write the types file**

Create `src/trackers/types.ts`:

```typescript
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
  runId?: string;
}

export type ReviewDecision =
  | "approved"
  | "changes_requested"
  | "review_required"
  | "none";

export interface TrackerProbeResult {
  installed: boolean;
  authenticated: boolean;
}

export interface TrackerScope {
  owner?: string;
  repo?: string;
  [key: string]: unknown;
}

export interface IssueFilter {
  labels?: string[];
  state?: "open" | "closed";
  assigned?: boolean;
}

export interface TrackerDriver {
  name: string;

  probe(): Promise<TrackerProbeResult>;

  listIssues(filter: IssueFilter): Promise<Issue[]>;
  createIssue(input: { title: string; body: string; labels?: string[] }): Promise<{
    number: number;
    url: string;
  }>;

  listPullRequests(filter: { state?: "open" | "closed" | "all" }): Promise<PullRequest[]>;
  getPullRequestChecks(number: number): Promise<CheckRun[]>;
  getPullRequestReviewDecision(number: number): Promise<ReviewDecision>;
  getRunLog(runId: string, options?: { tail?: number }): Promise<string>;
  mergePullRequest(number: number, method: "merge" | "squash" | "rebase"): Promise<void>;
}

export type TrackerFactory = (scope: TrackerScope) => TrackerDriver;
```

- [ ] **Step 2: Verify lint**

Run: `npm run lint`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/trackers/types.ts
git commit -m "feat(tracker): add TrackerDriver interface"
```

---

## Task 3: Write failing tests for GitHubDriver

**Files:**
- Create: `src/trackers/__tests__/github.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/trackers/__tests__/github.test.ts` with tests that mock `execSync` returning realistic `gh api` / `gh pr` JSON fixtures:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitHubDriver } from "../github.js";

const execMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execSync: execMock,
}));

describe("GitHubDriver", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("has name 'github'", () => {
    const driver = createGitHubDriver({ owner: "tu11aa", repo: "claude-cockpit" });
    expect(driver.name).toBe("github");
  });

  it("throws when scope.owner or scope.repo missing", () => {
    expect(() => createGitHubDriver({})).toThrow(/owner/i);
    expect(() => createGitHubDriver({ owner: "x" })).toThrow(/repo/i);
  });

  it("probe returns installed=true and authenticated=true when gh responds", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("gh --version")) return "gh version 2.40.0";
      if (cmd.includes("gh auth status")) return "Logged in";
      return "";
    });
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const probe = await driver.probe();
    expect(probe.installed).toBe(true);
    expect(probe.authenticated).toBe(true);
  });

  it("probe returns installed=false when gh not found", async () => {
    execMock.mockImplementation(() => { throw new Error("gh: command not found"); });
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const probe = await driver.probe();
    expect(probe.installed).toBe(false);
    expect(probe.authenticated).toBe(false);
  });

  it("listIssues parses gh api output", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("gh api")) {
        return JSON.stringify([
          {
            number: 1,
            title: "first",
            body: "body1",
            labels: [{ name: "bug" }, { name: "P1" }],
            state: "open",
            assignees: [{ login: "alice" }],
            html_url: "https://github.com/o/r/issues/1",
            updated_at: "2026-04-21T10:00:00Z",
            pull_request: undefined,
          },
        ]);
      }
      return "";
    });
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const issues = await driver.listIssues({ state: "open" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 1,
      title: "first",
      body: "body1",
      labels: ["bug", "P1"],
      state: "open",
      assignees: ["alice"],
      url: "https://github.com/o/r/issues/1",
      updatedAt: "2026-04-21T10:00:00Z",
    });
  });

  it("listIssues filters out pull_requests (gh api returns both on issues endpoint)", async () => {
    execMock.mockImplementation(() => JSON.stringify([
      { number: 1, title: "i", body: "", labels: [], state: "open", assignees: [], html_url: "", updated_at: "", pull_request: undefined },
      { number: 2, title: "p", body: "", labels: [], state: "open", assignees: [], html_url: "", updated_at: "", pull_request: { url: "..." } },
    ]));
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const issues = await driver.listIssues({});
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
  });

  it("listIssues respects `assigned: false` (unassigned-only)", async () => {
    execMock.mockImplementation(() => JSON.stringify([
      { number: 1, title: "a", body: "", labels: [], state: "open", assignees: [{ login: "x" }], html_url: "", updated_at: "", pull_request: undefined },
      { number: 2, title: "b", body: "", labels: [], state: "open", assignees: [], html_url: "", updated_at: "", pull_request: undefined },
    ]));
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const unassigned = await driver.listIssues({ assigned: false });
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0].number).toBe(2);
  });

  it("createIssue calls gh issue create and parses the returned URL", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue create")) return "https://github.com/o/r/issues/42\n";
      return "";
    });
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const result = await driver.createIssue({ title: "t", body: "b", labels: ["bug"] });
    expect(result.number).toBe(42);
    expect(result.url).toBe("https://github.com/o/r/issues/42");
    const calls = execMock.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes("gh issue create") && c.includes("--label bug"))).toBe(true);
  });

  it("listPullRequests parses gh api output", async () => {
    execMock.mockImplementation(() => JSON.stringify([
      {
        number: 7,
        title: "pr",
        body: "",
        labels: [],
        state: "open",
        merged: false,
        head: { sha: "abc123" },
        html_url: "https://github.com/o/r/pull/7",
        updated_at: "2026-04-21T10:00:00Z",
      },
    ]));
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const prs = await driver.listPullRequests({ state: "open" });
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(7);
    expect(prs[0].state).toBe("open");
    expect(prs[0].headSha).toBe("abc123");
  });

  it("listPullRequests reports merged state when merged=true", async () => {
    execMock.mockImplementation(() => JSON.stringify([
      { number: 7, title: "", body: "", labels: [], state: "closed", merged: true, head: { sha: "x" }, html_url: "", updated_at: "" },
    ]));
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const prs = await driver.listPullRequests({ state: "all" });
    expect(prs[0].state).toBe("merged");
  });

  it("getPullRequestChecks parses gh pr checks --json output", async () => {
    execMock.mockImplementation(() => JSON.stringify([
      { name: "test", state: "SUCCESS", link: "https://.../runs/123" },
      { name: "lint", state: "FAILURE", link: "https://.../runs/456" },
      { name: "deploy", state: "PENDING", link: "" },
    ]));
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const checks = await driver.getPullRequestChecks(7);
    expect(checks).toEqual([
      { name: "test", state: "success", link: "https://.../runs/123", runId: "123" },
      { name: "lint", state: "failure", link: "https://.../runs/456", runId: "456" },
      { name: "deploy", state: "pending", link: "", runId: undefined },
    ]);
  });

  it("getPullRequestReviewDecision returns lowercase decision", async () => {
    execMock.mockImplementation(() => JSON.stringify({ reviewDecision: "APPROVED" }));
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    expect(await driver.getPullRequestReviewDecision(7)).toBe("approved");
  });

  it("getPullRequestReviewDecision maps empty/null to 'none'", async () => {
    execMock.mockImplementation(() => JSON.stringify({ reviewDecision: "" }));
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    expect(await driver.getPullRequestReviewDecision(7)).toBe("none");
  });

  it("getRunLog returns --log-failed output, tailed to N lines", async () => {
    const bigLog = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("gh run view") && cmd.includes("--log-failed")) return bigLog;
      return "";
    });
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    const log = await driver.getRunLog("123", { tail: 5 });
    expect(log.split("\n")).toHaveLength(5);
    expect(log).toContain("line 200");
    expect(log).toContain("line 196");
  });

  it("mergePullRequest calls gh pr merge with the method and --auto", async () => {
    execMock.mockReturnValue("");
    const driver = createGitHubDriver({ owner: "o", repo: "r" });
    await driver.mergePullRequest(7, "squash");
    const calls = execMock.mock.calls.map(c => c[0] as string);
    expect(calls[0]).toContain("gh pr merge 7");
    expect(calls[0]).toContain("--squash");
    expect(calls[0]).toContain("--auto");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trackers/__tests__/github.test.ts`
Expected: FAIL with "Cannot find module '../github.js'"

---

## Task 4: Implement GitHubDriver

**Files:**
- Create: `src/trackers/github.ts`

- [ ] **Step 1: Write the implementation**

Create `src/trackers/github.ts`:

```typescript
import { execSync } from "node:child_process";
import type {
  CheckRun,
  Issue,
  IssueFilter,
  PullRequest,
  ReviewDecision,
  TrackerDriver,
  TrackerProbeResult,
  TrackerScope,
} from "./types.js";

function gh(args: string): string {
  return execSync(`gh ${args}`, { encoding: "utf-8" }).trim();
}

function safeGh(args: string): string {
  try {
    return gh(args);
  } catch {
    return "";
  }
}

function escape(s: string): string {
  return s.replace(/"/g, '\\"');
}

function parseLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => (typeof l === "string" ? l : l?.name)).filter((x): x is string => !!x);
}

function parseAssignees(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => (typeof a === "string" ? a : a?.login)).filter((x): x is string => !!x);
}

function extractRunId(link: string | undefined): string | undefined {
  if (!link) return undefined;
  const match = link.match(/\/runs\/(\d+)/);
  return match ? match[1] : undefined;
}

export function createGitHubDriver(scope: TrackerScope): TrackerDriver {
  const { owner, repo } = scope;
  if (typeof owner !== "string" || !owner) {
    throw new Error("GitHubDriver requires scope.owner (string)");
  }
  if (typeof repo !== "string" || !repo) {
    throw new Error("GitHubDriver requires scope.repo (string)");
  }
  const repoFlag = `--repo "${owner}/${repo}"`;

  return {
    name: "github",

    async probe(): Promise<TrackerProbeResult> {
      const version = safeGh("--version");
      const installed = !!version;
      const authenticated = installed && !!safeGh("auth status");
      return { installed, authenticated };
    },

    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      const state = filter.state ?? "open";
      const raw = safeGh(`api "repos/${owner}/${repo}/issues?state=${state}&per_page=100"`);
      if (!raw) return [];
      let items: Array<Record<string, unknown>>;
      try {
        items = JSON.parse(raw);
      } catch {
        return [];
      }
      const issues: Issue[] = [];
      for (const item of items) {
        if (item.pull_request) continue; // gh returns PRs on issues endpoint
        const labels = parseLabels(item.labels);
        if (filter.labels && filter.labels.length > 0) {
          if (!filter.labels.every((l) => labels.includes(l))) continue;
        }
        const assignees = parseAssignees(item.assignees);
        if (filter.assigned === true && assignees.length === 0) continue;
        if (filter.assigned === false && assignees.length > 0) continue;
        issues.push({
          number: Number(item.number),
          title: String(item.title ?? ""),
          body: String(item.body ?? ""),
          labels,
          state: (item.state === "closed" ? "closed" : "open") as "open" | "closed",
          assignees,
          url: String(item.html_url ?? ""),
          updatedAt: String(item.updated_at ?? ""),
        });
      }
      return issues;
    },

    async createIssue(input): Promise<{ number: number; url: string }> {
      const labelFlags = (input.labels ?? []).map((l) => `--label "${escape(l)}"`).join(" ");
      const output = gh(
        `issue create ${repoFlag} --title "${escape(input.title)}" --body "${escape(input.body)}" ${labelFlags}`.trim(),
      );
      const match = output.match(/\/issues\/(\d+)/);
      const number = match ? Number(match[1]) : 0;
      return { number, url: output.trim() };
    },

    async listPullRequests(filter): Promise<PullRequest[]> {
      const state = filter.state ?? "open";
      const raw = safeGh(`api "repos/${owner}/${repo}/pulls?state=${state}&per_page=100"`);
      if (!raw) return [];
      let items: Array<Record<string, unknown>>;
      try {
        items = JSON.parse(raw);
      } catch {
        return [];
      }
      return items.map((item) => {
        const merged = !!item.merged;
        const rawState = String(item.state ?? "open");
        const prState: "open" | "closed" | "merged" = merged
          ? "merged"
          : rawState === "closed"
          ? "closed"
          : "open";
        const head = (item.head as Record<string, unknown> | undefined) ?? {};
        return {
          number: Number(item.number),
          title: String(item.title ?? ""),
          body: String(item.body ?? ""),
          labels: parseLabels(item.labels),
          state: prState,
          headSha: String(head.sha ?? ""),
          url: String(item.html_url ?? ""),
          updatedAt: String(item.updated_at ?? ""),
        };
      });
    },

    async getPullRequestChecks(number: number): Promise<CheckRun[]> {
      const raw = safeGh(`pr checks ${number} ${repoFlag} --json name,state,link`);
      if (!raw) return [];
      let items: Array<Record<string, unknown>>;
      try {
        items = JSON.parse(raw);
      } catch {
        return [];
      }
      return items.map((item) => {
        const link = item.link ? String(item.link) : "";
        const rawState = String(item.state ?? "").toLowerCase();
        const state: CheckRun["state"] =
          rawState === "success" ? "success"
          : rawState === "failure" ? "failure"
          : rawState === "skipped" ? "skipped"
          : "pending";
        return {
          name: String(item.name ?? ""),
          state,
          link,
          runId: extractRunId(link),
        };
      });
    },

    async getPullRequestReviewDecision(number: number): Promise<ReviewDecision> {
      const raw = safeGh(`pr view ${number} ${repoFlag} --json reviewDecision`);
      if (!raw) return "none";
      try {
        const data = JSON.parse(raw) as { reviewDecision?: string };
        const decision = (data.reviewDecision ?? "").toLowerCase();
        if (decision === "approved") return "approved";
        if (decision === "changes_requested") return "changes_requested";
        if (decision === "review_required") return "review_required";
        return "none";
      } catch {
        return "none";
      }
    },

    async getRunLog(runId: string, options): Promise<string> {
      const raw = safeGh(`run view ${runId} ${repoFlag} --log-failed`);
      if (!raw) return "";
      if (options?.tail === undefined) return raw;
      const lines = raw.split("\n");
      return lines.slice(Math.max(0, lines.length - options.tail)).join("\n");
    },

    async mergePullRequest(number: number, method): Promise<void> {
      gh(`pr merge ${number} ${repoFlag} --${method} --auto`);
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/trackers/__tests__/github.test.ts`
Expected: PASS, all ~15 tests.

If a test fails: fix the implementation (do NOT change tests). If a test is genuinely wrong, STOP and report BLOCKED.

- [ ] **Step 3: Commit**

```bash
git add src/trackers/github.ts src/trackers/__tests__/github.test.ts
git commit -m "feat(tracker): add GitHubDriver implementing TrackerDriver"
```

---

## Task 5: TrackerRegistry TDD

**Files:**
- Create: `src/trackers/__tests__/registry.test.ts`
- Create: `src/trackers/registry.ts`

- [ ] **Step 1: Write the test file**

Create `src/trackers/__tests__/registry.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { TrackerRegistry } from "../registry.js";
import type { TrackerDriver, TrackerScope } from "../types.js";
import type { CockpitConfig, ReactionsConfig } from "../../config.js";

function stubFactory(name: string): (scope: TrackerScope) => TrackerDriver {
  return (scope) => ({
    name,
    probe: vi.fn(async () => ({ installed: true, authenticated: true })),
    listIssues: vi.fn(async () => []),
    createIssue: vi.fn(async () => ({ number: 0, url: `${name}:${scope.owner}/${scope.repo}` })),
    listPullRequests: vi.fn(async () => []),
    getPullRequestChecks: vi.fn(async () => []),
    getPullRequestReviewDecision: vi.fn(async () => "none" as const),
    getRunLog: vi.fn(async () => ""),
    mergePullRequest: vi.fn(async () => {}),
  });
}

function baseConfig(overrides: Partial<CockpitConfig> = {}): CockpitConfig {
  return {
    commandName: "cmd",
    hubVault: "~/hub",
    projects: {},
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: { command: "default", captain: "acceptEdits" },
    },
    metrics: { enabled: false, path: "" },
    ...overrides,
  };
}

function baseReactions(overrides: Partial<ReactionsConfig> = {}): ReactionsConfig {
  return {
    engine: { poll_interval: "5m", state_file: "", max_retries: 2 },
    github: { repos: {} },
    reactions: {},
    ...overrides,
  };
}

describe("TrackerRegistry", () => {
  it("returns github driver by default", () => {
    const registry = new TrackerRegistry({ github: stubFactory("github") });
    const config = baseConfig({
      projects: { brove: { path: "/p", captainName: "c", spokeVault: "~/s", host: "local" } },
    });
    const reactions = baseReactions({ github: { repos: { brove: { owner: "tu11aa", repo: "brove" } } } });
    const driver = registry.forProject("brove", config, reactions);
    expect(driver.name).toBe("github");
  });

  it("uses top-level tracker override", () => {
    const registry = new TrackerRegistry({
      github: stubFactory("github"),
      linear: stubFactory("linear"),
    });
    const config = baseConfig({
      tracker: "linear",
      projects: { brove: { path: "/p", captainName: "c", spokeVault: "~/s", host: "local" } },
    });
    const reactions = baseReactions();
    const driver = registry.forProject("brove", config, reactions);
    expect(driver.name).toBe("linear");
  });

  it("project-level tracker overrides top-level", () => {
    const registry = new TrackerRegistry({
      github: stubFactory("github"),
      linear: stubFactory("linear"),
      jira: stubFactory("jira"),
    });
    const config = baseConfig({
      tracker: "linear",
      projects: {
        brove: { path: "/p", captainName: "c", spokeVault: "~/s", host: "local", tracker: "jira" },
      },
    });
    const reactions = baseReactions();
    const driver = registry.forProject("brove", config, reactions);
    expect(driver.name).toBe("jira");
  });

  it("throws when configured provider has no factory", () => {
    const registry = new TrackerRegistry({ github: stubFactory("github") });
    const config = baseConfig({
      tracker: "unknown",
      projects: { brove: { path: "/p", captainName: "c", spokeVault: "~/s", host: "local" } },
    });
    const reactions = baseReactions();
    expect(() => registry.forProject("brove", config, reactions)).toThrowError(/unknown/i);
  });

  it("throws for unknown project", () => {
    const registry = new TrackerRegistry({ github: stubFactory("github") });
    expect(() => registry.forProject("nope", baseConfig(), baseReactions())).toThrowError(/not found/i);
  });

  it("passes owner/repo from reactions.json into factory scope", async () => {
    const registry = new TrackerRegistry({ github: stubFactory("github") });
    const config = baseConfig({
      projects: { brove: { path: "/p", captainName: "c", spokeVault: "~/s", host: "local" } },
    });
    const reactions = baseReactions({
      github: { repos: { brove: { owner: "tu11aa", repo: "claude-cockpit" } } },
    });
    const driver = registry.forProject("brove", config, reactions);
    const result = await driver.createIssue({ title: "", body: "" });
    expect(result.url).toBe("github:tu11aa/claude-cockpit");
  });

  it("probeAll returns results keyed by provider", async () => {
    const registry = new TrackerRegistry({
      github: stubFactory("github"),
      linear: stubFactory("linear"),
    });
    const results = await registry.probeAll();
    expect(results.github.installed).toBe(true);
    expect(results.linear.installed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/trackers/__tests__/registry.test.ts`
Expected: FAIL with "Cannot find module '../registry.js'"

- [ ] **Step 3: Implement registry**

Create `src/trackers/registry.ts`:

```typescript
import type { CockpitConfig, ReactionsConfig } from "../config.js";
import type {
  TrackerDriver,
  TrackerFactory,
  TrackerProbeResult,
} from "./types.js";

const DEFAULT_TRACKER = "github";

export class TrackerRegistry {
  constructor(private factories: Record<string, TrackerFactory>) {}

  forProject(
    projectName: string,
    config: CockpitConfig,
    reactions: ReactionsConfig,
  ): TrackerDriver {
    const proj = config.projects[projectName];
    if (!proj) throw new Error(`Project '${projectName}' not found`);
    const name = proj.tracker ?? config.tracker ?? DEFAULT_TRACKER;
    const repoConfig = reactions.github?.repos?.[projectName] ?? {};
    return this.get(name)({
      owner: (repoConfig as { owner?: string }).owner,
      repo: (repoConfig as { repo?: string }).repo,
    });
  }

  get(name: string): TrackerFactory {
    const factory = this.factories[name];
    if (!factory) {
      throw new Error(`Unknown tracker provider '${name}' — no factory registered`);
    }
    return factory;
  }

  async probeAll(): Promise<Record<string, TrackerProbeResult>> {
    const results: Record<string, TrackerProbeResult> = {};
    for (const [name, factory] of Object.entries(this.factories)) {
      try {
        const driver = factory({ owner: "probe", repo: "probe" });
        results[name] = await driver.probe();
      } catch {
        results[name] = { installed: false, authenticated: false };
      }
    }
    return results;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/trackers/__tests__/registry.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/trackers/registry.ts src/trackers/__tests__/registry.test.ts
git commit -m "feat(tracker): add TrackerRegistry with project-level override"
```

---

## Task 6: Add trackers barrel + in-memory helper

**Files:**
- Create: `src/trackers/index.ts`
- Create: `src/trackers/__tests__/helpers/memory-tracker.ts`
- Create: `src/trackers/__tests__/helpers/memory-tracker.test.ts`

- [ ] **Step 1: Write the barrel**

Create `src/trackers/index.ts`:

```typescript
export { createGitHubDriver } from "./github.js";
export { TrackerRegistry } from "./registry.js";
export type {
  CheckRun,
  Issue,
  IssueFilter,
  PullRequest,
  ReviewDecision,
  TrackerDriver,
  TrackerFactory,
  TrackerProbeResult,
  TrackerScope,
} from "./types.js";
```

- [ ] **Step 2: Write the in-memory helper**

Create `src/trackers/__tests__/helpers/memory-tracker.ts`:

```typescript
import type { CheckRun, Issue, PullRequest, ReviewDecision, TrackerDriver } from "../../types.js";

export interface MemoryTrackerState {
  issues: Issue[];
  prs: PullRequest[];
  checks: Record<number, CheckRun[]>;
  reviews: Record<number, ReviewDecision>;
  logs: Record<string, string>;
}

export function createMemoryTrackerDriver(initial?: Partial<MemoryTrackerState>): TrackerDriver & {
  state: MemoryTrackerState;
} {
  const state: MemoryTrackerState = {
    issues: initial?.issues ?? [],
    prs: initial?.prs ?? [],
    checks: initial?.checks ?? {},
    reviews: initial?.reviews ?? {},
    logs: initial?.logs ?? {},
  };

  return {
    name: "memory",
    state,

    async probe() {
      return { installed: true, authenticated: true };
    },

    async listIssues(filter) {
      return state.issues.filter((i) => {
        if (filter.state && i.state !== filter.state) return false;
        if (filter.labels && !filter.labels.every((l) => i.labels.includes(l))) return false;
        if (filter.assigned === true && i.assignees.length === 0) return false;
        if (filter.assigned === false && i.assignees.length > 0) return false;
        return true;
      });
    },

    async createIssue(input) {
      const number = state.issues.length + 1;
      const issue: Issue = {
        number,
        title: input.title,
        body: input.body,
        labels: input.labels ?? [],
        state: "open",
        assignees: [],
        url: `memory://issues/${number}`,
        updatedAt: new Date().toISOString(),
      };
      state.issues.push(issue);
      return { number, url: issue.url };
    },

    async listPullRequests(filter) {
      if (!filter.state || filter.state === "all") return state.prs;
      return state.prs.filter((p) => p.state === filter.state);
    },

    async getPullRequestChecks(number) {
      return state.checks[number] ?? [];
    },

    async getPullRequestReviewDecision(number) {
      return state.reviews[number] ?? "none";
    },

    async getRunLog(runId, options) {
      const log = state.logs[runId] ?? "";
      if (options?.tail === undefined) return log;
      const lines = log.split("\n");
      return lines.slice(Math.max(0, lines.length - options.tail)).join("\n");
    },

    async mergePullRequest(number) {
      const pr = state.prs.find((p) => p.number === number);
      if (pr) pr.state = "merged";
    },
  };
}
```

Create smoke test `src/trackers/__tests__/helpers/memory-tracker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createMemoryTrackerDriver } from "./memory-tracker.js";

describe("createMemoryTrackerDriver", () => {
  it("createIssue → listIssues round-trips", async () => {
    const d = createMemoryTrackerDriver();
    const r = await d.createIssue({ title: "t", body: "b", labels: ["bug"] });
    expect(r.number).toBe(1);
    const list = await d.listIssues({});
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("t");
  });

  it("listIssues filters by label intersection", async () => {
    const d = createMemoryTrackerDriver();
    await d.createIssue({ title: "a", body: "", labels: ["bug"] });
    await d.createIssue({ title: "b", body: "", labels: ["bug", "P1"] });
    expect(await d.listIssues({ labels: ["P1"] })).toHaveLength(1);
  });

  it("mergePullRequest updates state to merged", async () => {
    const d = createMemoryTrackerDriver({
      prs: [{ number: 1, title: "", body: "", labels: [], state: "open", headSha: "", url: "", updatedAt: "" }],
    });
    await d.mergePullRequest(1, "squash");
    const prs = await d.listPullRequests({ state: "all" });
    expect(prs[0].state).toBe("merged");
  });
});
```

- [ ] **Step 3: Verify build + tests**

Run: `npm run build && npx vitest run src/trackers/__tests__/helpers/`
Expected: build exits 0, tests 3/3 pass.

- [ ] **Step 4: Commit**

```bash
git add src/trackers/index.ts src/trackers/__tests__/helpers/
git commit -m "feat(tracker): add trackers barrel and in-memory test driver"
```

---

## Task 7: `cockpit tracker` CLI subcommand

**Files:**
- Create: `src/commands/tracker.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the command file**

Create `src/commands/tracker.ts`:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, loadReactions, type CockpitConfig, type ReactionsConfig } from "../config.js";
import { createGitHubDriver, TrackerRegistry } from "../trackers/index.js";
import type { TrackerDriver } from "../trackers/types.js";

function buildRegistry(): TrackerRegistry {
  return new TrackerRegistry({ github: createGitHubDriver });
}

function resolveDriver(
  registry: TrackerRegistry,
  config: CockpitConfig,
  reactions: ReactionsConfig,
  project: string,
): TrackerDriver {
  return registry.forProject(project, config, reactions);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const trackerCommand = new Command("tracker")
  .description("Interact with the tracker layer (issues/PRs). Bridges bash scripts to the TrackerDriver.");

trackerCommand
  .command("create-issue")
  .description("Create an issue in the project's tracker repo")
  .argument("<project>", "Project name")
  .argument("<title>", "Issue title")
  .option("--body <body>", "Issue body (use '-' to read from stdin)", "")
  .option("--label <labels>", "Comma-separated labels", "")
  .action(async (project: string, title: string, opts: { body: string; label: string }) => {
    const config = loadConfig();
    const reactions = loadReactions();
    try {
      const driver = resolveDriver(buildRegistry(), config, reactions, project);
      const body = opts.body === "-" ? await readStdin() : opts.body;
      const labels = opts.label ? opts.label.split(",").map((l) => l.trim()).filter(Boolean) : undefined;
      const result = await driver.createIssue({ title, body, labels });
      console.log(result.url);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

trackerCommand
  .command("merge-pr")
  .description("Enable auto-merge on a PR with the given method")
  .argument("<project>", "Project name")
  .argument("<number>", "PR number")
  .option("--method <method>", "Merge method: squash, merge, rebase", "squash")
  .action(async (project: string, numberStr: string, opts: { method: string }) => {
    const config = loadConfig();
    const reactions = loadReactions();
    try {
      const driver = resolveDriver(buildRegistry(), config, reactions, project);
      const method = (opts.method === "merge" || opts.method === "rebase" ? opts.method : "squash") as "merge" | "squash" | "rebase";
      await driver.mergePullRequest(Number(numberStr), method);
      console.log(chalk.green(`✔ Merge enabled for PR #${numberStr} (${method})`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

trackerCommand
  .command("get-checks")
  .description("Print PR check runs")
  .argument("<project>", "Project name")
  .argument("<number>", "PR number")
  .option("-j, --json", "Output as JSON")
  .action(async (project: string, numberStr: string, opts: { json?: boolean }) => {
    const config = loadConfig();
    const reactions = loadReactions();
    try {
      const driver = resolveDriver(buildRegistry(), config, reactions, project);
      const checks = await driver.getPullRequestChecks(Number(numberStr));
      if (opts.json) {
        console.log(JSON.stringify(checks, null, 2));
      } else {
        for (const c of checks) {
          console.log(`${c.state.padEnd(8)}${c.name}`);
        }
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

trackerCommand
  .command("get-run-log")
  .description("Print the failing log tail of a workflow run")
  .argument("<project>", "Project name")
  .argument("<run-id>", "Run ID")
  .option("--tail <n>", "Tail N lines", "100")
  .action(async (project: string, runId: string, opts: { tail: string }) => {
    const config = loadConfig();
    const reactions = loadReactions();
    try {
      const driver = resolveDriver(buildRegistry(), config, reactions, project);
      const log = await driver.getRunLog(runId, { tail: Number(opts.tail) });
      process.stdout.write(log);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

trackerCommand
  .command("list-issues")
  .description("List issues in the project's tracker repo")
  .argument("<project>", "Project name")
  .option("--label <label>", "Filter by label")
  .option("--state <state>", "open | closed", "open")
  .option("--unassigned", "Only unassigned issues")
  .action(async (project: string, opts: { label?: string; state: string; unassigned?: boolean }) => {
    const config = loadConfig();
    const reactions = loadReactions();
    try {
      const driver = resolveDriver(buildRegistry(), config, reactions, project);
      const state = (opts.state === "closed" ? "closed" : "open") as "open" | "closed";
      const filter = {
        state,
        labels: opts.label ? [opts.label] : undefined,
        assigned: opts.unassigned ? false : undefined,
      };
      const issues = await driver.listIssues(filter);
      for (const i of issues) {
        console.log(`#${i.number}\t${i.title}`);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Register in `src/index.ts`**

Add import alongside other command imports:

```typescript
import { trackerCommand } from "./commands/tracker.js";
```

And register after the workspace command:

```typescript
program.addCommand(trackerCommand);
```

- [ ] **Step 3: Build + smoke**

Run:
```
npm run build
node dist/index.js tracker --help
```
Expected: exit 0, shows 5 subcommands (create-issue, merge-pr, get-checks, get-run-log, list-issues).

- [ ] **Step 4: Commit**

```bash
git add src/commands/tracker.ts src/index.ts
git commit -m "feat(tracker): add 'cockpit tracker' CLI subcommand"
```

---

## Task 8: Migrate execute-reaction.sh

**Files:**
- Modify: `scripts/execute-reaction.sh`

- [ ] **Step 1: Replace the `auto-merge` case**

Find the `auto-merge)` branch in `scripts/execute-reaction.sh` (around line 87-104). Replace the `gh pr merge` call:

```bash
  auto-merge)
    if cockpit tracker merge-pr "$PROJECT" "$NUMBER" --method "$MERGE_METHOD"; then
      echo "✔ Auto-merge enabled for PR #${NUMBER} on ${PROJECT} (${MERGE_METHOD})"
    else
      echo "✘ Merge failed for PR #${NUMBER} on ${PROJECT}" >&2
      exit 1
    fi
    ;;
```

Remove the `REPO_INFO=$(python3 -c "..."` block at the top of that case — no longer needed since `cockpit tracker` resolves the project-to-repo mapping from config internally.

- [ ] **Step 2: Replace the `auto-fix-ci` case's gh calls**

Find the `auto-fix-ci)` branch (around line 160-200). Replace this block:

```bash
    REPO_INFO=$(python3 -c "...")
    if [ -z "$REPO_INFO" ] || [ "$REPO_INFO" = "/" ]; then
      echo "✘ No repo configured for project '$PROJECT'" >&2
      exit 1
    fi

    # Fetch failed check names + log tail for the PR's head commit
    FAIL_SUMMARY=$(gh pr checks "$NUMBER" --repo "$REPO_INFO" 2>/dev/null | awk -F'\t' '$2=="fail"{print "- "$1" ("$4")"}' | head -20 || true)
    FAIL_RUN_ID=$(gh pr checks "$NUMBER" --repo "$REPO_INFO" --json name,state,link 2>/dev/null \
      | python3 -c "
import json, sys, re
try:
    checks = json.load(sys.stdin)
    for c in checks:
        if c.get('state') == 'FAILURE':
            m = re.search(r'/runs/(\d+)', c.get('link',''))
            if m:
                print(m.group(1)); break
except Exception:
    pass
" 2>/dev/null || true)

    LOG_TAIL=""
    if [ -n "$FAIL_RUN_ID" ]; then
      LOG_TAIL=$(gh run view "$FAIL_RUN_ID" --repo "$REPO_INFO" --log-failed 2>/dev/null | tail -100 || true)
    fi
```

With:

```bash
    # Fetch failed check summary + run ID from tracker
    CHECKS_JSON=$(cockpit tracker get-checks "$PROJECT" "$NUMBER" --json 2>/dev/null || echo "[]")
    FAIL_SUMMARY=$(echo "$CHECKS_JSON" | python3 -c "
import json, sys
try:
    checks = json.load(sys.stdin)
    for c in checks:
        if c.get('state') == 'failure':
            print(f\"- {c.get('name','')} ({c.get('link','')})\")
except Exception:
    pass
" 2>/dev/null | head -20 || true)

    FAIL_RUN_ID=$(echo "$CHECKS_JSON" | python3 -c "
import json, sys
try:
    for c in json.load(sys.stdin):
        if c.get('state') == 'failure' and c.get('runId'):
            print(c['runId']); break
except Exception:
    pass
" 2>/dev/null || true)

    LOG_TAIL=""
    if [ -n "$FAIL_RUN_ID" ]; then
      LOG_TAIL=$(cockpit tracker get-run-log "$PROJECT" "$FAIL_RUN_ID" --tail 100 2>/dev/null || true)
    fi
```

The `CAPTAIN_PROMPT` construction below and the retry counter logic stay unchanged.

- [ ] **Step 3: Syntax check + grep**

Run: `bash -n scripts/execute-reaction.sh`
Expected: no output, exit 0.

Run: `grep -c "gh pr\|gh run\|gh api" scripts/execute-reaction.sh`
Expected: 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/execute-reaction.sh
git commit -m "refactor(reactor): migrate auto-merge and auto-fix-ci to 'cockpit tracker'"
```

---

## Task 9: Doctor probe for trackers

**Files:**
- Modify: `src/commands/doctor.ts`

- [ ] **Step 1: Add tracker probe**

Add import at the top of `src/commands/doctor.ts`:

```typescript
import { createGitHubDriver, TrackerRegistry } from "../trackers/index.js";
```

Inside the action, after the workspace probe block (the `for (const [name, proj] of Object.entries(config.projects))` loop that probes workspace spokes), add:

```typescript
// Probe tracker providers
const trackers = new TrackerRegistry({ github: createGitHubDriver });
const trackerProbes = await trackers.probeAll();
for (const [name, probe] of Object.entries(trackerProbes)) {
  results.push(check(
    `Tracker '${name}' installed`,
    probe.installed,
  ));
  if (probe.installed) {
    results.push(check(
      `Tracker '${name}' authenticated`,
      probe.authenticated,
    ));
  }
}
```

- [ ] **Step 2: Build + run doctor**

Run: `npm run build && node dist/index.js doctor`
Expected: new `Tracker 'github' installed` + `Tracker 'github' authenticated` lines appear.

- [ ] **Step 3: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "refactor(doctor): probe tracker providers via TrackerRegistry"
```

---

## Task 10: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add tracker CLI rows to Commands table**

After the existing `cockpit workspace read --hub <path>` row, insert:

```markdown
| `cockpit tracker create-issue <project> <title>` | Create an issue in the project's tracker repo |
| `cockpit tracker merge-pr <project> <num>` | Enable auto-merge on a PR |
| `cockpit tracker get-checks <project> <num>` | Print PR check runs |
```

- [ ] **Step 2: Add `tracker` fields to Config JSON example**

Add at top level (alongside `runtime` and `workspace`):

```json
"tracker": "github",
```

And per-project in `brove`:

```json
"tracker": "github"
```

(Adjust comma placement to keep valid JSON.)

- [ ] **Step 3: Add Architecture subsection**

After the `### Workspace Abstraction` subsection, add:

```markdown
### Tracker Abstraction

Issue/PR operations run behind a pluggable **tracker driver** (currently only `github`). One-shot ops — create-issue, merge-pr, get-checks, get-run-log, list-issues — go through the driver instead of `gh` CLI directly. Bash scripts call `cockpit tracker <op>`. Polling stays provider-specific (`scripts/poll-github.sh`); future providers add their own poll scripts. Each project may override the global default via its `tracker` field. New backends (Linear, Jira, GitLab) are added as driver files in `src/trackers/` — see `docs/specs/2026-04-21-plugin-system-tracker-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document tracker config field and CLI subcommand"
```

---

## Task 11: Full-suite verification

**Files:** none.

- [ ] **Step 1: Test suite**

Run: `npm run test -- --run`
Expected: all new tracker tests pass (~15 github, 7 registry, 3 memory-tracker = 25 new); baseline preserved (2 pre-existing config.test.ts failures acceptable).

- [ ] **Step 2: Lint + build**

Run: `npm run lint && npm run build`
Expected: exits 0 on both.

- [ ] **Step 3: CLI smoke**

Run:
- `node dist/index.js tracker --help` — shows 5 subcommands
- `node dist/index.js tracker list-issues <real-project> --state open` — lists issues
- `node dist/index.js doctor` — shows Tracker checks

- [ ] **Step 4: No commit — verification only**

---

## Self-Review Notes

- **Spec coverage:** Every section of the design spec has implementing tasks (§1 Interface → T2; §2 Registry + Config → T1, T5; §3 CLI → T7; §4 Refactor → T8, T9, T10; §5 Testing → T3, T5, T6).
- **Type consistency:** `TrackerDriver` methods (`probe`, `listIssues`, `createIssue`, `listPullRequests`, `getPullRequestChecks`, `getPullRequestReviewDecision`, `getRunLog`, `mergePullRequest`) identical across types, github impl, memory-driver, registry tests, CLI. `Issue`/`PullRequest`/`CheckRun` shapes consistent.
- **Deferred scope** (per spec §Non-Goals): no additional providers; no cross-tracker normalization; `poll-github.sh` + `match-reactions.sh` + `feedback.ts` unchanged; no GitHub Projects GraphQL abstraction.
- **Spec note correction:** The design spec's §4 refactor table listed `feedback.ts` with `gh issue create` — that was wrong. `feedback.ts` opens a browser URL (no gh call). This plan correctly skips `feedback.ts`.
- **Commit discipline:** 10 atomic commits across 11 tasks (Task 11 is verify-only unless fixes needed).
