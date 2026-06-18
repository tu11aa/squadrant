# Auto-Status Poller — Implementation Plan

> **⛔ Superseded** — reactor retired in PR #155 — feature removed. Archived 2026-06-18 — this feature was removed.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reactor reaction that, every cycle, reads each registered project's captain cmux pane via `cockpit runtime read-screen`, classifies the tail content into one of `idle | busy | blocked | errored | offline`, and writes `{spokeVault}/status.md` with the state, timestamp, captain workspace name, and a 10-20 line activity excerpt. Pure machine; no agent action required. False positives are acceptable — it's a hint, not truth.

**Architecture:** A pure classifier (`src/reactor/status-classifier.ts`) takes raw screen text and returns `{ state, excerpt }`. An orchestrator (`src/reactor/auto-status.ts`) reads each registered project, calls the global runtime driver's `readScreen()` against the captain workspace, classifies, writes the spoke vault's `status.md`. A new CLI subcommand `cockpit reactor poll-status` runs the orchestrator. `scripts/reactor-cycle.sh` calls `cockpit reactor poll-status` between the GitHub poll and the captain-status event scan, so existing `captain-status` reactions still fire on the auto-derived state. `cockpit reactor check` runs the same orchestrator inline. A doctor probe checks that `status.md` mtime is within 2× `poll_interval` for every registered project.

**Tech Stack:** TypeScript, vitest (with `vi.hoisted` + `vi.mock`), Node 22, ES modules (imports end in `.js`), bash for `reactor-cycle.sh`.

**Spec:** `docs/specs/2026-05-05-cockpit-thin-redirect-design.md` decision #5.
**Issue:** [#43](https://github.com/tu11aa/claude-cockpit/issues/43) under umbrella [#40](https://github.com/tu11aa/claude-cockpit/issues/40).
**Branch:** `feature/auto-status-poller` off `develop`.

---

## File Structure

**Create:**
- `src/reactor/status-classifier.ts` — pure `classifyScreen(text, opts) → { state, excerpt }`
- `src/reactor/__tests__/status-classifier.test.ts` — classifier unit tests with realistic fixtures
- `src/reactor/auto-status.ts` — orchestrator: loops projects, reads pane via runtime, classifies, writes file
- `src/reactor/__tests__/auto-status.test.ts` — orchestrator tests with mocked runtime + filesystem

**Modify:**
- `src/commands/reactor.ts` — register `cockpit reactor poll-status` subcommand; have `cockpit reactor check` invoke the orchestrator before running the cycle script
- `scripts/reactor-cycle.sh` — invoke `cockpit reactor poll-status` between the GitHub poll and the captain-status scan
- `src/config.ts` — extend `ReactionsConfig` with an `auto_status` block (`enabled`, `lines`, `excerpt_lines`)
- `reactions.json` (repo-root template that init.ts copies) — add an `auto_status` block with sensible defaults
- `src/commands/doctor.ts` — add probe: per registered project, `status.md` mtime within 2× `poll_interval`
- `README.md` — one-paragraph note that auto-poller writes `status.md` (no agent action needed)

**No changes to:** `match-reactions.sh`, `execute-reaction.sh`, `poll-github.sh`, `write-status.sh` (manual-write helper retained for opt-in writes), `read-status.sh`, captain templates, crew templates, `.gitignore`, `.claude/`.

---

## Task 1: State classifier — pure function (TDD)

**Files:**
- Create: `src/reactor/status-classifier.ts`
- Create: `src/reactor/__tests__/status-classifier.test.ts`

The classifier is the only piece that has interesting branching. Build it pure and test it hard. Heuristics, in priority order:

1. **offline** — empty input, or contains `session ended`, `[process exited`, `[exited`, `agent stopped`
2. **errored** — last 50 lines contain `✗`, `panic:`, `FATAL`, `Error:` followed by traceback markers, or `error: ` at line start
3. **blocked** — tail contains `blocked` (case-insensitive), `waiting for input`, `needs input`, `stuck on`, `can't proceed`
4. **busy** — tail contains spinner char (`✻`, `⠋`, `⠙`, `⠹`, `⠸`, `⠼`, `⠴`, `⠦`, `⠧`, `⠇`, `⠏`), or words `Cogitat`, `Brewing`, `Thinking`, `Running`, `Compiling`, `Installing`, `Generating`, `Searching`
5. **idle** — content present but no above match; e.g. an empty agent prompt (`│ >`, `> `, `$ `, `❯ `) at end

Excerpt = the last `excerpt_lines` non-empty lines, joined with `\n`, trailing whitespace trimmed.

- [ ] **Step 1: Write failing tests**

Create `src/reactor/__tests__/status-classifier.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyScreen } from "../status-classifier.js";

const opts = { lines: 50, excerptLines: 10 };

describe("classifyScreen", () => {
  it("returns offline when input is empty", () => {
    const out = classifyScreen("", opts);
    expect(out.state).toBe("offline");
    expect(out.excerpt).toBe("");
  });

  it("returns offline when input is whitespace", () => {
    const out = classifyScreen("   \n\n  \t\n", opts);
    expect(out.state).toBe("offline");
  });

  it("returns offline when 'session ended' appears", () => {
    const out = classifyScreen("Welcome\nuser: hi\nassistant: bye\nsession ended\n", opts);
    expect(out.state).toBe("offline");
  });

  it("returns offline when '[process exited' appears", () => {
    const out = classifyScreen("running command\n[process exited with code 0]\n", opts);
    expect(out.state).toBe("offline");
  });

  it("returns errored when '✗' appears in tail", () => {
    const out = classifyScreen("doing work\n✗ build failed\n", opts);
    expect(out.state).toBe("errored");
  });

  it("returns errored on FATAL marker", () => {
    const out = classifyScreen("starting up\nFATAL: cannot bind port\n", opts);
    expect(out.state).toBe("errored");
  });

  it("returns errored on panic", () => {
    const out = classifyScreen("processing\npanic: index out of range\n", opts);
    expect(out.state).toBe("errored");
  });

  it("returns blocked on 'blocked' word", () => {
    const out = classifyScreen("ok\ncaptain is blocked on review\n", opts);
    expect(out.state).toBe("blocked");
  });

  it("returns blocked on 'waiting for input'", () => {
    const out = classifyScreen("ok\nwaiting for input from user\n", opts);
    expect(out.state).toBe("blocked");
  });

  it("returns busy on Claude spinner ✻ Cogitating", () => {
    const out = classifyScreen("│ > running task\n✻ Cogitating… (3s)\n", opts);
    expect(out.state).toBe("busy");
  });

  it("returns busy on braille spinner", () => {
    const out = classifyScreen("│ > tests\n⠋ running tests\n", opts);
    expect(out.state).toBe("busy");
  });

  it("returns busy on 'Brewing'", () => {
    const out = classifyScreen("doing\nBrewing response (2s)\n", opts);
    expect(out.state).toBe("busy");
  });

  it("returns busy on 'Compiling'", () => {
    const out = classifyScreen("starting build\nCompiling project...\n", opts);
    expect(out.state).toBe("busy");
  });

  it("returns idle when prompt visible and no busy markers", () => {
    const out = classifyScreen([
      "Last task complete.",
      "│ Welcome to Claude Code",
      "│ > ",
    ].join("\n"), opts);
    expect(out.state).toBe("idle");
  });

  it("returns idle on bare shell prompt", () => {
    const out = classifyScreen("$ ls\nfile.ts\n$ ", opts);
    expect(out.state).toBe("idle");
  });

  it("priority: errored beats blocked", () => {
    const out = classifyScreen("blocked on input\n✗ also failed\n", opts);
    expect(out.state).toBe("errored");
  });

  it("priority: blocked beats busy", () => {
    const out = classifyScreen("Compiling\nblocked on user response\n", opts);
    expect(out.state).toBe("blocked");
  });

  it("excerpt is last N non-empty lines joined", () => {
    const screen = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const out = classifyScreen(screen, { lines: 50, excerptLines: 5 });
    expect(out.excerpt.split("\n")).toEqual(["line 25", "line 26", "line 27", "line 28", "line 29"]);
  });

  it("excerpt skips blank lines", () => {
    const screen = "alpha\n\n\nbeta\n\ngamma\n";
    const out = classifyScreen(screen, { lines: 50, excerptLines: 3 });
    expect(out.excerpt).toBe("alpha\nbeta\ngamma");
  });

  it("only inspects last `lines` lines for classification", () => {
    const head = Array.from({ length: 200 }, () => "✗ old failure").join("\n");
    const tail = "│ > \n";
    const out = classifyScreen(head + "\n" + tail, { lines: 5, excerptLines: 3 });
    expect(out.state).toBe("idle");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/reactor/__tests__/status-classifier.test.ts`
Expected: FAIL — module `../status-classifier.js` not found.

- [ ] **Step 3: Implement `src/reactor/status-classifier.ts`**

```typescript
export type ScreenState = "idle" | "busy" | "blocked" | "errored" | "offline";

export interface ClassifyOptions {
  lines: number;        // window of trailing lines to inspect for state
  excerptLines: number; // window of trailing non-empty lines to keep as excerpt
}

export interface ClassifyResult {
  state: ScreenState;
  excerpt: string;
}

const OFFLINE_MARKERS = [
  /session ended/i,
  /\[process exited/i,
  /\[exited\b/i,
  /agent stopped/i,
];

const ERRORED_MARKERS = [
  /✗/,
  /\bpanic:/i,
  /\bFATAL\b/,
  /^error:\s/im,
  /\bTraceback \(most recent call last\)/,
];

const BLOCKED_MARKERS = [
  /\bblocked\b/i,
  /waiting for input/i,
  /needs input/i,
  /stuck on/i,
  /can'?t proceed/i,
];

// Spinner glyphs commonly emitted by Claude Code, Codex, Aider, npm/pnpm, cargo, etc.
const SPINNER_CHARS = ["✻", "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const BUSY_KEYWORDS = [
  /Cogitat/i,
  /Brewing/i,
  /Thinking/i,
  /\bRunning\b/i,
  /Compiling/i,
  /Installing/i,
  /Generating/i,
  /Searching/i,
];

function tailLines(text: string, n: number): string[] {
  const all = text.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - n));
}

function lastNonEmpty(lines: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const t = lines[i].replace(/\s+$/, "");
    if (t.trim().length > 0) out.unshift(t);
  }
  return out;
}

export function classifyScreen(text: string, opts: ClassifyOptions): ClassifyResult {
  const tail = tailLines(text, opts.lines);
  const excerptLines = lastNonEmpty(tail, opts.excerptLines);
  const excerpt = excerptLines.join("\n");

  if (excerpt.trim().length === 0) {
    return { state: "offline", excerpt: "" };
  }

  const tailJoined = tail.join("\n");

  if (OFFLINE_MARKERS.some((re) => re.test(tailJoined))) {
    return { state: "offline", excerpt };
  }

  if (ERRORED_MARKERS.some((re) => re.test(tailJoined))) {
    return { state: "errored", excerpt };
  }

  if (BLOCKED_MARKERS.some((re) => re.test(tailJoined))) {
    return { state: "blocked", excerpt };
  }

  const hasSpinnerChar = SPINNER_CHARS.some((c) => tailJoined.includes(c));
  if (hasSpinnerChar || BUSY_KEYWORDS.some((re) => re.test(tailJoined))) {
    return { state: "busy", excerpt };
  }

  return { state: "idle", excerpt };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/reactor/__tests__/status-classifier.test.ts`
Expected: all tests pass (20 cases).

- [ ] **Step 5: Commit**

```bash
git add src/reactor/status-classifier.ts src/reactor/__tests__/status-classifier.test.ts
git commit -m "feat(reactor): pure screen-state classifier (#43)"
```

---

## Task 2: Auto-status orchestrator (TDD)

**Files:**
- Create: `src/reactor/auto-status.ts`
- Create: `src/reactor/__tests__/auto-status.test.ts`

Orchestrator responsibilities:
1. Load `CockpitConfig` and `ReactionsConfig`.
2. For each registered project, look up the project's runtime driver, call `readScreen(captainName)`.
3. Run `classifyScreen` with `auto_status.lines` / `auto_status.excerpt_lines` (defaults 50 / 15).
4. Write `{spokeVault}/status.md` with frontmatter (`project`, `auto_state`, `auto_last_checked`, `captain_workspace`) plus the excerpt in a fenced block.
5. Return a result array `[{ project, state, vaultPath }, ...]` for callers (CLI, tests, future dashboard).

The function takes injected dependencies (`config`, `reactions`, `runtime`, `clock`, `writeFile`) so tests don't touch the real filesystem or runtime. Production callers wire defaults.

- [ ] **Step 1: Write failing tests**

Create `src/reactor/__tests__/auto-status.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CockpitConfig, ReactionsConfig } from "../../config.js";
import type { RuntimeDriver } from "../../runtimes/types.js";
import { runAutoStatus } from "../auto-status.js";

function makeConfig(): CockpitConfig {
  return {
    commandName: "command",
    hubVault: "/tmp/hub",
    projects: {
      brove: {
        path: "/tmp/brove",
        captainName: "brove-captain",
        spokeVault: "/tmp/spokes/brove",
        host: "local",
      },
      solder: {
        path: "/tmp/solder",
        captainName: "solder-captain",
        spokeVault: "/tmp/spokes/solder",
        host: "local",
      },
    },
    defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
    metrics: { enabled: false, path: "" },
  };
}

function makeReactions(overrides: Partial<ReactionsConfig["auto_status"]> = {}): ReactionsConfig {
  return {
    engine: { poll_interval: "5m", state_file: "/tmp/state.json", max_retries: 2 },
    github: { repos: {} },
    reactions: {},
    auto_status: { enabled: true, lines: 50, excerpt_lines: 10, ...overrides },
  };
}

function makeRuntime(screens: Record<string, string>): RuntimeDriver {
  return {
    name: "cmux",
    probe: vi.fn(),
    list: vi.fn(),
    status: vi.fn(),
    spawn: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(async (ref: string) => screens[ref] ?? ""),
    stop: vi.fn(),
    newPane: vi.fn(),
    closePane: vi.fn(),
    sendToPane: vi.fn(),
    readPaneScreen: vi.fn(),
  };
}

describe("runAutoStatus", () => {
  let writes: Array<{ path: string; content: string }>;
  let writeFile: (p: string, c: string) => void;
  const NOW = "2026-05-05T12:00:00.000Z";

  beforeEach(() => {
    writes = [];
    writeFile = (p, c) => { writes.push({ path: p, content: c }); };
  });

  it("classifies and writes status.md for every registered project", async () => {
    const runtime = makeRuntime({
      "brove-captain": "│ > \nReady.\n",
      "solder-captain": "✻ Cogitating…\n",
    });
    const results = await runAutoStatus({
      config: makeConfig(),
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(results).toEqual([
      { project: "brove",  state: "idle", vaultPath: "/tmp/spokes/brove/status.md" },
      { project: "solder", state: "busy", vaultPath: "/tmp/spokes/solder/status.md" },
    ]);
    expect(writes).toHaveLength(2);
  });

  it("writes frontmatter with auto_state, auto_last_checked, captain_workspace", async () => {
    const runtime = makeRuntime({ "brove-captain": "│ > \nReady.\n" });
    const cfg = makeConfig();
    delete cfg.projects.solder;

    await runAutoStatus({
      config: cfg,
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    const w = writes[0];
    expect(w.path).toBe("/tmp/spokes/brove/status.md");
    expect(w.content).toMatch(/^---$/m);
    expect(w.content).toContain("project: brove");
    expect(w.content).toContain("auto_state: idle");
    expect(w.content).toContain(`auto_last_checked: "${NOW}"`);
    expect(w.content).toContain("captain_workspace: brove-captain");
  });

  it("writes the activity excerpt in a fenced block", async () => {
    const runtime = makeRuntime({
      "brove-captain": "alpha\nbeta\ngamma\n│ > \n",
    });
    const cfg = makeConfig();
    delete cfg.projects.solder;

    await runAutoStatus({
      config: cfg,
      reactions: makeReactions({ excerpt_lines: 5 }),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(writes[0].content).toContain("## Last activity excerpt");
    expect(writes[0].content).toMatch(/```\nalpha\nbeta\ngamma\n│ >\n```/);
  });

  it("marks state offline when readScreen returns empty", async () => {
    const runtime = makeRuntime({});
    const cfg = makeConfig();
    delete cfg.projects.solder;

    const results = await runAutoStatus({
      config: cfg,
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(results[0].state).toBe("offline");
    expect(writes[0].content).toContain("auto_state: offline");
  });

  it("skips polling when auto_status.enabled is false", async () => {
    const runtime = makeRuntime({ "brove-captain": "✻ Cogitating…\n" });
    const results = await runAutoStatus({
      config: makeConfig(),
      reactions: makeReactions({ enabled: false }),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(results).toEqual([]);
    expect(writes).toEqual([]);
    expect(runtime.readScreen).not.toHaveBeenCalled();
  });

  it("continues polling other projects when one runtime call throws", async () => {
    const runtime: RuntimeDriver = {
      ...makeRuntime({}),
      readScreen: vi.fn(async (ref: string) => {
        if (ref === "brove-captain") throw new Error("runtime offline");
        return "│ > \nReady.\n";
      }),
    };
    const results = await runAutoStatus({
      config: makeConfig(),
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
    });

    expect(results).toEqual([
      { project: "brove",  state: "offline", vaultPath: "/tmp/spokes/brove/status.md" },
      { project: "solder", state: "idle",    vaultPath: "/tmp/spokes/solder/status.md" },
    ]);
  });

  it("uses the per-project runtime driver from the registry", async () => {
    const runtimePicker = vi.fn((): RuntimeDriver => makeRuntime({ "brove-captain": "│ > \n" }));
    await runAutoStatus({
      config: makeConfig(),
      reactions: makeReactions(),
      runtime: runtimePicker,
      now: () => NOW,
      writeFile,
    });

    expect(runtimePicker).toHaveBeenCalledWith("brove");
    expect(runtimePicker).toHaveBeenCalledWith("solder");
  });

  it("creates the spoke vault directory before writing", async () => {
    const runtime = makeRuntime({ "brove-captain": "│ > \n" });
    const mkdirs: string[] = [];
    const cfg = makeConfig();
    delete cfg.projects.solder;

    await runAutoStatus({
      config: cfg,
      reactions: makeReactions(),
      runtime: () => runtime,
      now: () => NOW,
      writeFile,
      mkdir: (p) => { mkdirs.push(p); },
    });

    expect(mkdirs).toContain("/tmp/spokes/brove");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/reactor/__tests__/auto-status.test.ts`
Expected: FAIL — module `../auto-status.js` not found.

- [ ] **Step 3: Implement `src/reactor/auto-status.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import type { CockpitConfig, ReactionsConfig } from "../config.js";
import { resolveHome } from "../config.js";
import type { RuntimeDriver } from "../runtimes/types.js";
import { classifyScreen, type ScreenState } from "./status-classifier.js";

export interface AutoStatusResult {
  project: string;
  state: ScreenState;
  vaultPath: string;
}

export interface AutoStatusDeps {
  config: CockpitConfig;
  reactions: ReactionsConfig;
  runtime: (project: string) => RuntimeDriver;
  now?: () => string;
  writeFile?: (filePath: string, content: string) => void;
  mkdir?: (dirPath: string) => void;
}

const DEFAULT_AUTO_STATUS = { enabled: true, lines: 50, excerpt_lines: 15 };

function buildStatusMarkdown(input: {
  project: string;
  captainWorkspace: string;
  state: ScreenState;
  lastChecked: string;
  excerpt: string;
}): string {
  const fenced = "```";
  return [
    "---",
    `project: ${input.project}`,
    `auto_state: ${input.state}`,
    `auto_last_checked: "${input.lastChecked}"`,
    `captain_workspace: ${input.captainWorkspace}`,
    "---",
    "",
    "# Status (auto-derived)",
    "",
    "> Written by `cockpit reactor poll-status`. Manual writes (`write-status.sh`) are opt-in and may be clobbered on the next poll.",
    "",
    "## Last activity excerpt",
    "",
    fenced,
    input.excerpt,
    fenced,
    "",
  ].join("\n");
}

export async function runAutoStatus(deps: AutoStatusDeps): Promise<AutoStatusResult[]> {
  const cfg = deps.reactions.auto_status ?? DEFAULT_AUTO_STATUS;
  if (!cfg.enabled) return [];

  const lines = cfg.lines ?? DEFAULT_AUTO_STATUS.lines;
  const excerptLines = cfg.excerpt_lines ?? DEFAULT_AUTO_STATUS.excerpt_lines;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c));
  const mkdir = deps.mkdir ?? ((p) => fs.mkdirSync(p, { recursive: true }));

  const results: AutoStatusResult[] = [];

  for (const [name, project] of Object.entries(deps.config.projects)) {
    const captain = project.captainName;
    const vaultDir = resolveHome(project.spokeVault);
    const statusPath = path.join(vaultDir, "status.md");

    let screen = "";
    try {
      const driver = deps.runtime(name);
      screen = await driver.readScreen(captain);
    } catch {
      screen = "";
    }

    const { state, excerpt } = classifyScreen(screen, { lines, excerptLines });

    try {
      mkdir(vaultDir);
      writeFile(statusPath, buildStatusMarkdown({
        project: name,
        captainWorkspace: captain,
        state,
        lastChecked: now,
        excerpt,
      }));
    } catch {
      // best-effort: skip projects whose vault is unreachable
    }

    results.push({ project: name, state, vaultPath: statusPath });
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/reactor/__tests__/auto-status.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reactor/auto-status.ts src/reactor/__tests__/auto-status.test.ts
git commit -m "feat(reactor): auto-status orchestrator (#43)"
```

---

## Task 3: Extend `ReactionsConfig` schema with `auto_status`

**Files:**
- Modify: `src/config.ts`
- Modify: `reactions.json` (repo-root template)

- [ ] **Step 1: Add the type**

In `src/config.ts`, add this interface near the other reactions types (just below `ReactionRule`):

```typescript
export interface AutoStatusConfig {
  enabled: boolean;
  lines: number;        // window of trailing lines fed to the classifier
  excerpt_lines: number;// number of trailing non-empty lines kept as activity excerpt
}
```

Then add `auto_status?: AutoStatusConfig;` to the `ReactionsConfig` interface (right after `reactions: Record<...>`).

- [ ] **Step 2: Default value in `loadReactions` fallback**

In the empty-config fallback inside `loadReactions`, add `auto_status: { enabled: true, lines: 50, excerpt_lines: 15 }` next to the other engine defaults.

- [ ] **Step 3: Update the repo-root `reactions.json` template**

Add a top-level `auto_status` block right after `engine`:

```json
  "auto_status": {
    "enabled": true,
    "lines": 50,
    "excerpt_lines": 15
  },
```

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts reactions.json
git commit -m "feat(config): add auto_status block to reactions schema (#43)"
```

---

## Task 4: Add `cockpit reactor poll-status` subcommand

**Files:**
- Modify: `src/commands/reactor.ts`

The subcommand wires `runAutoStatus` to a CLI entry point. It loads config + reactions, builds the runtime registry, and prints a one-line summary per project.

- [ ] **Step 1: Add the new subcommand**

At the top of `src/commands/reactor.ts`, add the import for the registry helpers (next to the existing `loadConfig`/`loadReactions` import):

```typescript
import { loadConfig as loadFullConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import { runAutoStatus } from "../reactor/auto-status.js";
```

(If any of these already exist in the file, do not duplicate. As of the current code, none of them are imported in `reactor.ts`.)

Then, at the bottom of the file (after `cockpit reactor reset`), add:

```typescript
// cockpit reactor poll-status — run one auto-status poll across registered projects
reactorCommand
  .command("poll-status")
  .description("Read each captain's pane, classify state, write {spokeVault}/status.md")
  .option("--json", "Emit results as JSON instead of human output")
  .action(async (opts: { json?: boolean }) => {
    const config = loadFullConfig();
    const reactions = loadReactions();

    if (Object.keys(config.projects).length === 0) {
      if (opts.json) {
        console.log("[]");
      } else {
        console.log(chalk.yellow("\n  No projects registered. Add one with: cockpit projects add <name> <path>\n"));
      }
      return;
    }

    const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
    const results = await runAutoStatus({
      config,
      reactions,
      runtime: (project) => registry.forProject(project, config),
    });

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log(chalk.dim("\n  Auto-status disabled in reactions.json (auto_status.enabled = false).\n"));
      return;
    }

    console.log(chalk.bold("\n  📊 Auto-status poll\n"));
    for (const r of results) {
      const icon = ({
        idle: chalk.green("●"),
        busy: chalk.cyan("◐"),
        blocked: chalk.yellow("⏸"),
        errored: chalk.red("✗"),
        offline: chalk.dim("○"),
      } as const)[r.state];
      console.log(`  ${icon} ${chalk.cyan(r.project.padEnd(16))} ${r.state.padEnd(8)} → ${chalk.dim(r.vaultPath)}`);
    }
    console.log("");
  });
```

- [ ] **Step 2: Build + smoke-test help**

Run: `npm run build && node dist/index.js reactor poll-status --help`
Expected: prints "Read each captain's pane, classify state, write {spokeVault}/status.md" and `--json`.

- [ ] **Step 3: Commit**

```bash
git add src/commands/reactor.ts
git commit -m "feat(reactor): cockpit reactor poll-status CLI (#43)"
```

---

## Task 5: Run auto-status before the cycle in `cockpit reactor check`

**Files:**
- Modify: `src/commands/reactor.ts` (the existing `check` action)

Goal: when a user runs `cockpit reactor check` (the inline path), the auto-status poll runs first so the GitHub poll's downstream `captain-status` reactions see fresh data.

- [ ] **Step 1: Inline the auto-status call into `reactor check`**

In `src/commands/reactor.ts`, find the `.action((opts: { dryRun?: boolean })` for the `check` subcommand. Replace its body with an async version that runs the poller first:

```typescript
  .action(async (opts: { dryRun?: boolean }) => {
    if (!checkGhCli()) return;

    const config = loadFullConfig();
    const reactions = loadReactions();
    const repos = reactions.github?.repos || {};
    const repoCount = Object.keys(repos).length;

    if (repoCount === 0) {
      console.log(chalk.yellow("\n  No GitHub repos configured. Add one with: cockpit reactor add <project>\n"));
      return;
    }

    console.log(chalk.bold(`\n  ⚡ Running reaction cycle (${repoCount} repos)\n`));

    if (Object.keys(config.projects).length > 0 && reactions.auto_status?.enabled !== false) {
      console.log(chalk.dim("  Polling captain panes (auto-status)..."));
      const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
      const results = await runAutoStatus({
        config,
        reactions,
        runtime: (project) => registry.forProject(project, config),
      });
      for (const r of results) {
        console.log(chalk.dim(`    ${r.project.padEnd(16)} ${r.state}`));
      }
    }

    const scriptsDir = getScriptsDir();
    const cycleScript = path.join(scriptsDir, "reactor-cycle.sh");
    // ...rest of the body unchanged: dry-run branch and full execSync(cycleScript) branch...
  });
```

Keep the rest of the existing body (the `if (opts.dryRun)` branch and the `else { ... execSync(cycleScript) ... }` branch) intact below the new block.

- [ ] **Step 2: Build + smoke-test (dry-run)**

Run: `npm run build && node dist/index.js reactor check --dry-run`
Expected: prints "Polling captain panes (auto-status)…" then "Polling GitHub..." (or skips if no repos).

- [ ] **Step 3: Commit**

```bash
git add src/commands/reactor.ts
git commit -m "feat(reactor): poll captain panes before each cycle (#43)"
```

---

## Task 6: Wire the poller into `scripts/reactor-cycle.sh`

**Files:**
- Modify: `scripts/reactor-cycle.sh`

The reactor workspace runs `reactor-cycle.sh` directly on a timer. Inline the new step between "📡 Polling GitHub" and "📊 Checking captain status" so the captain-status events the matcher reads come from the freshly-written `status.md`.

- [ ] **Step 1: Insert the new step**

In `scripts/reactor-cycle.sh`, find the line `echo "📊 Checking captain status..."` and immediately above it add:

```bash
# Step 1.5: Auto-status poll — read captain panes, classify, write status.md
echo "📡 Polling captain panes (auto-status)..."
if command -v cockpit >/dev/null 2>&1; then
  cockpit reactor poll-status 2>&1 | sed 's/^/   /' || echo "   ⚠️  Auto-status poll failed (continuing)"
else
  echo "   ⚠️  cockpit CLI not on PATH — skipping auto-status"
fi
```

(The `command -v cockpit` guard ensures the script doesn't break if a user runs `reactor-cycle.sh` directly without the CLI installed; the existing reactor workspace always has `cockpit` on PATH.)

- [ ] **Step 2: Smoke-test the script**

Run: `bash scripts/reactor-cycle.sh /tmp/empty-reactions.json` after first creating an empty reactions file:
```bash
echo '{"engine":{"poll_interval":"5m","state_file":"/tmp/s.json","max_retries":2},"github":{"repos":{}},"reactions":{},"auto_status":{"enabled":false}}' > /tmp/empty-reactions.json
```
Expected: prints "📡 Polling captain panes (auto-status)..." line; the rest of the cycle exits cleanly because there are no GitHub events.

- [ ] **Step 3: Commit**

```bash
git add scripts/reactor-cycle.sh
git commit -m "feat(reactor): invoke poll-status from reactor-cycle.sh (#43)"
```

---

## Task 7: Doctor probe — auto-poller freshness

**Files:**
- Modify: `src/commands/doctor.ts`

Probe: for each registered project, `status.md` exists and its mtime is within `2 × poll_interval`. If older — or missing — the probe fails.

- [ ] **Step 1: Add a duration parser + probe**

At the top of `src/commands/doctor.ts`, near the other helpers, add:

```typescript
function parsePollIntervalSeconds(s: string | undefined): number {
  if (!s) return 300;
  const m = String(s).match(/^(\d+)(m|h|d|s)$/);
  if (!m) return 300;
  const v = parseInt(m[1], 10);
  switch (m[2]) {
    case "s": return v;
    case "m": return v * 60;
    case "h": return v * 60 * 60;
    case "d": return v * 60 * 60 * 24;
    default:  return 300;
  }
}
```

- [ ] **Step 2: Wire the probe into the doctor action**

Inside the `.action(async () => { ... })` block of `doctorCommand`, add the import (at the top of the file):

```typescript
import { loadReactions } from "../config.js";
```

Then add this block right before the final `const passed = results.filter(Boolean).length;` line:

```typescript
    // Auto-status poller freshness — see #43
    const reactions = loadReactions();
    const autoStatus = reactions.auto_status;
    if (autoStatus?.enabled !== false) {
      const intervalSec = parsePollIntervalSeconds(reactions.engine?.poll_interval);
      const staleThresholdMs = intervalSec * 2 * 1000;
      for (const [name, proj] of Object.entries(config.projects)) {
        const statusPath = path.join(
          proj.spokeVault.startsWith("~")
            ? proj.spokeVault.replace("~", process.env.HOME || "")
            : proj.spokeVault,
          "status.md",
        );
        let fresh = false;
        try {
          const st = await stat(statusPath);
          fresh = (Date.now() - st.mtimeMs) <= staleThresholdMs;
        } catch {
          fresh = false;
        }
        results.push(check(
          `Auto-status fresh — '${name}' status.md within 2× poll interval`,
          fresh,
        ));
      }
    }
```

- [ ] **Step 3: Build + smoke-test**

Run: `npm run build && node dist/index.js doctor`
Expected: doctor output now ends with one "Auto-status fresh — '<project>' …" line per registered project. (FAIL is acceptable here while the reactor isn't yet running; the probe just reports the truth.)

- [ ] **Step 4: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "feat(doctor): probe auto-poller freshness per project (#43)"
```

---

## Task 8: README — one-paragraph note about the auto-poller

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find the Knowledge System section**

In `README.md`, locate the `### Knowledge System` block (recently rewritten in #42). The first bullet currently reads roughly:
```markdown
- **Status** — auto-derived by the reactor's poller from each captain's pane buffer (#43). Captains do not write status on every event.
```

Replace that single bullet with a slightly fuller version that names the new CLI:
```markdown
- **Status (auto)** — every reactor cycle (`cockpit reactor poll-status`) reads each captain's cmux pane, classifies the tail into `idle | busy | blocked | errored | offline`, and writes `{spokeVault}/status.md`. No agent action required. Manual `write-status.sh` writes are opt-in and may be clobbered on the next poll.
```

- [ ] **Step 2: Add a one-line row to the commands table**

Find the commands table. Right after the existing `cockpit reactor check` row, add:
```markdown
| `cockpit reactor poll-status [--json]` | Run one auto-status poll across all registered projects (writes `{spokeVault}/status.md`). |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document auto-status poller (#43)"
```

---

## Task 9: Full-suite verification + PR

- [ ] **Step 1: Build clean**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass except the 2 pre-existing emoji-related `commandName` failures in `src/config.test.ts` (unrelated to #43).

- [ ] **Step 3: Re-link cockpit and smoke-test the full path**

```bash
npm link
cockpit reactor poll-status --json | jq .   # JSON shape per project
cockpit reactor poll-status                 # human output, one line per project
cockpit reactor check --dry-run             # auto-status step runs first
cockpit doctor | tail -20                   # auto-status freshness lines visible
```

If you have a registered project with a real captain workspace running, also verify by hand:
```bash
cat ~/$(jq -r '.projects | to_entries[0].value.spokeVault' ~/.config/cockpit/config.json | sed 's|^~|.|')/status.md
```
Expected: the printed file has frontmatter (`auto_state`, `auto_last_checked`, `captain_workspace`) and a `## Last activity excerpt` block with recent pane content.

- [ ] **Step 4: Audit — no new direct cmux invocations**

```bash
git grep -nE '/Applications/cmux\.app/Contents/Resources/bin/cmux' -- 'src/' 'plugin/' 'orchestrator/' 'scripts/'
```
Expected: only the pre-existing hits in `src/runtimes/cmux.ts`, `src/commands/launch.ts`, `src/commands/command.ts`. No new hits in `src/reactor/`, `src/commands/reactor.ts`, or `src/commands/doctor.ts`.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin feature/auto-status-poller
gh pr create --base develop --title "Auto-status poller (#43)" --body "$(cat <<'EOF'
Closes #43 (under umbrella #40).

## Summary

Pure-machine status inference for every registered project. Every reactor cycle now:

1. reads each captain's cmux pane via `cockpit runtime read-screen`,
2. classifies the last 50 lines into `idle | busy | blocked | errored | offline`,
3. writes `{spokeVault}/status.md` with frontmatter + activity excerpt.

Captain does nothing. Pattern validated by jmux, tmux-orchestrator, tmux-mcp (per spec decision #5).

## What's new

- `src/reactor/status-classifier.ts` — pure classifier (~70 LOC, 20 unit tests covering each state, marker priority, excerpt windowing).
- `src/reactor/auto-status.ts` — orchestrator with injected runtime/clock/fs deps for testability.
- `cockpit reactor poll-status [--json]` — manual one-shot CLI.
- `cockpit reactor check` — runs auto-status before the GitHub cycle so `captain-status` reactions see fresh data.
- `scripts/reactor-cycle.sh` — invokes `cockpit reactor poll-status` between the GitHub poll and the captain-status scan.
- `cockpit doctor` — per-project probe that `status.md` mtime is within 2× `poll_interval`.
- `reactions.json` schema — new `auto_status` block (`enabled`, `lines`, `excerpt_lines`).

## Non-goals

- No notification routing on state change. State writes are the only output.
- No agent involvement. Decision #5 is explicitly machine-only.
- No replacement for the existing reactor cycle infrastructure — extends it.

## Test plan

- [x] 20 unit tests for `classifyScreen` (each state, marker priority, excerpt windowing, line cap).
- [x] 8 unit tests for `runAutoStatus` (multi-project, frontmatter shape, excerpt fence, offline on empty, disabled toggle, runtime-throw fallback, per-project runtime registry, mkdir).
- [x] Build + lint clean.
- [x] Manual smoke: `cockpit reactor poll-status` against a live cmux workspace produces a status.md with the expected shape.
- [x] No new direct cmux binary calls outside `src/runtimes/cmux.ts`.
EOF
)"
```

- [ ] **Step 6: Verify CI is green and request review** (or self-merge for solo).

---

## Self-Review Checklist

Before declaring this plan complete, verify:

1. **Spec coverage** — every checkbox in #43 is covered:
   - [x] `auto-status` reaction added to reactions config (Task 3 — `auto_status` block + `reactions.json` template)
   - [x] State classifier implemented in TypeScript, ~50–100 LOC (Task 1)
   - [x] Output written to `{spokeVault}/status.md` via the runtime/workspace driver path (Task 2 — uses `resolveHome` + Node fs; the workspace driver is not strictly required for a flat file write inside a known vault path. Same pattern as `write-status.sh`.)
   - [x] Unit tests with mocked screen text → expected state (Task 1, 20 cases)
   - [x] `cockpit reactor check` integration runs status polling in a single cycle (Task 5)
   - [x] Doctor probe — `status.md` mtime within 2× poll interval (Task 7)

2. **No drive-by refactoring** — Karpathy principles: every changed line traces to a checkbox in #43. Existing scripts (`write-status.sh`, `read-status.sh`, `match-reactions.sh`, `execute-reaction.sh`, `poll-github.sh`) are untouched. The "captain-status" event source in `match-reactions.sh` continues to read the same frontmatter shape; we add `auto_state` alongside the existing keys without breaking it. The four plugin slots (runtime, workspace, tracker, notifier) are not modified.

3. **Pure machine, cross-agent** — the classifier matches generic spinner/work/error markers, not Claude-specific text alone. Codex, Gemini, Aider, and shell sessions all classify reasonably. The orchestrator never invokes an agent.

4. **All new code has tests** — `status-classifier.ts` and `auto-status.ts` are fully covered. The CLI subcommand thin-wraps `runAutoStatus`; the orchestrator's tests already cover the logic.

5. **Cross-agent runtime** — auto-status reads via `cockpit runtime`'s `readScreen` method, which is part of the `RuntimeDriver` abstraction (slot 1). Adding a `tmux` driver later requires zero changes here.

6. **Hard rules respected** — no edits to `.gitignore`, no edits to `.claude/`, no destructive operations. PR is opened against `develop`, not `main`.
