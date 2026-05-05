# Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single live view of every registered project's auto-derived state, with two consumers of the same data:

1. **`cockpit dashboard --once`** — read `{spokeVault}/status.md` for every registered project, parse its frontmatter (`auto_state`, `auto_last_checked`, `captain_workspace`) + last-activity excerpt, render a compact ANSI-colored grid to stdout, exit.
2. **`cockpit dashboard --pane`** — open a sidebar pane in the current cmux workspace running a 10-second loop of `--once`.
3. **`cockpit dashboard sync-hub`** — copy each spoke `status.md` to `{hubVault}/projects/<name>.md` so an Obsidian Dataview page in the hub vault can aggregate them. Wired into `scripts/reactor-cycle.sh` after the auto-status poll.
4. **Hub `dashboard.md`** — Dataview query that reads the mirrored frontmatter and renders a project status table inside Obsidian. Idempotently written by `cockpit init`.

**Architecture:** Pure read layer (`src/dashboard/read-status.ts`) parses one status file and aggregates across all configured projects. Pure renderer (`src/dashboard/render.ts`) turns aggregated rows into a colored grid. Pure-ish hub mirror (`src/dashboard/sync-hub.ts`) writes `{hubVault}/projects/<name>.md`. The CLI (`src/commands/dashboard.ts`) wires them together; the `--pane` variant uses the existing `RuntimeDriver.newPane`/`sendToPane` primitives (already in #41) — no new direct cmux calls.

**Tech Stack:** TypeScript, vitest (with `vi.hoisted` + `vi.mock`), Node 22, ES modules (imports end in `.js`), bash for `reactor-cycle.sh`.

**Spec:** `docs/specs/2026-05-05-cockpit-thin-redirect-design.md` decision #6.
**Issue:** [#44](https://github.com/tu11aa/claude-cockpit/issues/44) under umbrella [#40](https://github.com/tu11aa/claude-cockpit/issues/40).
**Branch:** `feature/dashboard` off `develop`.

**Depends on:** #43 (merged) — auto-poller writes the `status.md` files this consumes.

---

## File Structure

**Create:**
- `src/dashboard/read-status.ts` — pure: parse one `status.md`, aggregate across `config.projects`
- `src/dashboard/render.ts` — pure: render aggregated rows as ANSI-colored grid
- `src/dashboard/sync-hub.ts` — pure-ish: mirror spoke `status.md` files into hub `projects/`
- `src/dashboard/__tests__/read-status.test.ts`
- `src/dashboard/__tests__/render.test.ts`
- `src/dashboard/__tests__/sync-hub.test.ts`
- `src/commands/dashboard.ts` — `cockpit dashboard {--once,--pane,sync-hub}`
- `src/commands/__tests__/dashboard.test.ts`

**Modify:**
- `src/index.ts` — register `dashboardCommand`
- `scripts/reactor-cycle.sh` — call `cockpit dashboard sync-hub` right after `cockpit reactor poll-status`
- `src/commands/init.ts` — always (idempotently) refresh `{hubVault}/dashboard.md` from the template and ensure `{hubVault}/projects/` exists
- `obsidian/hub/dashboard.md` — replace contents with a Dataview query keyed on the new `auto_state` / `auto_last_checked` / `captain_workspace` frontmatter
- `README.md` — add a `### Dashboard` section and rows in the commands table

**No changes to:** `src/reactor/auto-status.ts`, `src/reactor/status-classifier.ts`, `src/runtimes/cmux.ts`, role templates, `.gitignore`, `.claude/`.

---

## Task 1: Status reader — pure parse + aggregate (TDD)

**Files:**
- Create: `src/dashboard/read-status.ts`
- Create: `src/dashboard/__tests__/read-status.test.ts`

The reader has two pieces:
- `parseStatusFile(text) → ProjectStatus | null` — extracts frontmatter keys (`project`, `auto_state`, `auto_last_checked`, `captain_workspace`) and the contents of the `## Last activity excerpt` fenced block.
- `readAllStatuses(deps) → ProjectStatus[]` — for every entry in `config.projects`, reads `{spokeVault}/status.md` and returns one row per project. Missing/unreadable files return a row with `state: "unknown"` so the dashboard still shows the project.

The reader injects `readFile` so tests don't touch the real filesystem.

- [ ] **Step 1: Write failing tests**

Create `src/dashboard/__tests__/read-status.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { CockpitConfig } from "../../config.js";
import { parseStatusFile, readAllStatuses } from "../read-status.js";

const SAMPLE = [
  "---",
  "project: brove",
  "auto_state: idle",
  'auto_last_checked: "2026-05-05T12:00:00.000Z"',
  "captain_workspace: brove-captain",
  "---",
  "",
  "# Status (auto-derived)",
  "",
  "## Last activity excerpt",
  "",
  "```",
  "alpha",
  "│ > ",
  "```",
  "",
].join("\n");

function makeConfig(): CockpitConfig {
  return {
    commandName: "command",
    hubVault: "/tmp/hub",
    projects: {
      brove:  { path: "/tmp/brove",  captainName: "brove-captain",  spokeVault: "/tmp/spokes/brove",  host: "local" },
      solder: { path: "/tmp/solder", captainName: "solder-captain", spokeVault: "/tmp/spokes/solder", host: "local" },
    },
    defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
    metrics: { enabled: false, path: "" },
  };
}

describe("parseStatusFile", () => {
  it("extracts frontmatter + excerpt", () => {
    const out = parseStatusFile(SAMPLE);
    expect(out).toEqual({
      project: "brove",
      state: "idle",
      lastChecked: "2026-05-05T12:00:00.000Z",
      captainWorkspace: "brove-captain",
      excerpt: "alpha\n│ > ",
    });
  });

  it("strips quotes around frontmatter values", () => {
    const text = SAMPLE.replace("captain_workspace: brove-captain", 'captain_workspace: "brove-captain"');
    expect(parseStatusFile(text)?.captainWorkspace).toBe("brove-captain");
  });

  it("returns null when the file has no frontmatter", () => {
    expect(parseStatusFile("# random\nno fm here\n")).toBeNull();
  });

  it("falls back to empty excerpt when no fenced block", () => {
    const text = [
      "---",
      "project: x",
      "auto_state: busy",
      'auto_last_checked: "2026-05-05T12:00:00.000Z"',
      "captain_workspace: x-captain",
      "---",
      "",
      "no excerpt here",
    ].join("\n");
    expect(parseStatusFile(text)?.excerpt).toBe("");
  });

  it("treats unknown auto_state as 'unknown'", () => {
    const text = SAMPLE.replace("auto_state: idle", "auto_state: weird-value");
    expect(parseStatusFile(text)?.state).toBe("unknown");
  });
});

describe("readAllStatuses", () => {
  it("returns one row per registered project", () => {
    const reads: string[] = [];
    const readFile = (p: string) => {
      reads.push(p);
      if (p.includes("brove"))  return SAMPLE;
      if (p.includes("solder")) return SAMPLE.replace("project: brove", "project: solder")
                                            .replace("auto_state: idle", "auto_state: busy")
                                            .replace("brove-captain", "solder-captain");
      throw new Error("not found");
    };

    const rows = readAllStatuses({ config: makeConfig(), readFile });

    expect(rows.map((r) => r.project)).toEqual(["brove", "solder"]);
    expect(rows[0].state).toBe("idle");
    expect(rows[1].state).toBe("busy");
    expect(reads).toEqual(["/tmp/spokes/brove/status.md", "/tmp/spokes/solder/status.md"]);
  });

  it("yields state='unknown' when status.md is missing", () => {
    const readFile = () => { throw new Error("ENOENT"); };
    const rows = readAllStatuses({ config: makeConfig(), readFile });
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe("unknown");
    expect(rows[0].lastChecked).toBe("");
  });

  it("yields state='unknown' when status.md has no parseable frontmatter", () => {
    const readFile = () => "# garbage\n";
    const rows = readAllStatuses({ config: makeConfig(), readFile });
    expect(rows[0].state).toBe("unknown");
  });

  it("preserves the project name from config even when the file uses a different one", () => {
    const readFile = () => SAMPLE; // file says project: brove for both reads
    const rows = readAllStatuses({ config: makeConfig(), readFile });
    expect(rows[0].project).toBe("brove");
    expect(rows[1].project).toBe("solder");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dashboard/__tests__/read-status.test.ts`
Expected: FAIL — module `../read-status.js` not found.

- [ ] **Step 3: Implement `src/dashboard/read-status.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import type { CockpitConfig } from "../config.js";
import { resolveHome } from "../config.js";

export type DashboardState = "idle" | "busy" | "blocked" | "errored" | "offline" | "unknown";

const KNOWN_STATES: ReadonlyArray<DashboardState> = [
  "idle", "busy", "blocked", "errored", "offline", "unknown",
];

export interface ProjectStatus {
  project: string;
  state: DashboardState;
  lastChecked: string;       // ISO-8601 string, "" if unknown
  captainWorkspace: string;  // "" if unknown
  excerpt: string;           // multi-line, possibly ""
}

export interface ReadStatusDeps {
  config: CockpitConfig;
  readFile?: (path: string) => string;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseStatusFile(text: string): ProjectStatus | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;

  const fm: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") { i++; break; }
    const m = lines[i].match(/^([a-z_]+):\s*(.*)$/i);
    if (m) fm[m[1]] = unquote(m[2]);
  }
  if (!fm.auto_state) return null;

  // Find the first fenced block after "## Last activity excerpt"
  let excerpt = "";
  const headerIdx = lines.findIndex((l, idx) => idx >= i && /##\s+Last activity excerpt/i.test(l));
  if (headerIdx >= 0) {
    const fenceStart = lines.findIndex((l, idx) => idx > headerIdx && l.trim() === "```");
    if (fenceStart >= 0) {
      const fenceEnd = lines.findIndex((l, idx) => idx > fenceStart && l.trim() === "```");
      if (fenceEnd > fenceStart) excerpt = lines.slice(fenceStart + 1, fenceEnd).join("\n");
    }
  }

  const rawState = (fm.auto_state || "unknown") as DashboardState;
  const state = KNOWN_STATES.includes(rawState) ? rawState : "unknown";

  return {
    project: fm.project ?? "",
    state,
    lastChecked: fm.auto_last_checked ?? "",
    captainWorkspace: fm.captain_workspace ?? "",
    excerpt,
  };
}

export function readAllStatuses(deps: ReadStatusDeps): ProjectStatus[] {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf-8"));
  const rows: ProjectStatus[] = [];
  for (const [name, project] of Object.entries(deps.config.projects)) {
    const statusPath = path.join(resolveHome(project.spokeVault), "status.md");
    let text = "";
    try { text = readFile(statusPath); } catch { /* missing — leave text empty */ }
    const parsed = text ? parseStatusFile(text) : null;
    rows.push(parsed
      ? { ...parsed, project: name }
      : { project: name, state: "unknown", lastChecked: "", captainWorkspace: project.captainName, excerpt: "" });
  }
  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dashboard/__tests__/read-status.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/read-status.ts src/dashboard/__tests__/read-status.test.ts
git commit -m "feat(dashboard): pure status reader + aggregator (#44)"
```

---

## Task 2: Renderer — pure ANSI grid (TDD)

**Files:**
- Create: `src/dashboard/render.ts`
- Create: `src/dashboard/__tests__/render.test.ts`

The renderer takes `ProjectStatus[]` plus a `now` timestamp and returns a string. It must be deterministic (no chalk auto-detection inside). Tests strip ANSI to check structure.

Columns: state-icon · project (≤16) · state (≤8) · age (e.g. `30s`, `2m`, `1h`, `stale`) · excerpt-first-line (truncated to fit terminal width or 80).

- [ ] **Step 1: Write failing tests**

Create `src/dashboard/__tests__/render.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { ProjectStatus } from "../read-status.js";
import { renderDashboard, formatAge } from "../render.js";

function strip(s: string): string {
  // strip ANSI escape sequences for assertion clarity
  return s.replace(/\[[0-9;]*m/g, "");
}

const NOW = "2026-05-05T12:00:30.000Z";

describe("formatAge", () => {
  it("returns seconds when <60s", () => {
    expect(formatAge("2026-05-05T12:00:00.000Z", "2026-05-05T12:00:30.000Z")).toBe("30s");
  });
  it("returns minutes when <60m", () => {
    expect(formatAge("2026-05-05T11:58:00.000Z", "2026-05-05T12:00:30.000Z")).toBe("2m");
  });
  it("returns hours when <24h", () => {
    expect(formatAge("2026-05-05T09:00:00.000Z", "2026-05-05T12:00:30.000Z")).toBe("3h");
  });
  it("returns 'stale' when age >24h", () => {
    expect(formatAge("2026-05-03T12:00:00.000Z", "2026-05-05T12:00:30.000Z")).toBe("stale");
  });
  it("returns '?' when lastChecked is empty", () => {
    expect(formatAge("", NOW)).toBe("?");
  });
});

describe("renderDashboard", () => {
  const sample: ProjectStatus[] = [
    { project: "brove",         state: "idle",    lastChecked: "2026-05-05T12:00:00.000Z", captainWorkspace: "brove-captain",   excerpt: "Welcome to Claude Code\n│ > " },
    { project: "solder",        state: "busy",    lastChecked: "2026-05-05T11:58:00.000Z", captainWorkspace: "solder-captain",  excerpt: "✻ Cogitating… (3s)" },
    { project: "scaffoldstark", state: "blocked", lastChecked: "2026-05-05T11:59:45.000Z", captainWorkspace: "scaffold-captain", excerpt: "waiting for input from user" },
    { project: "feedback",      state: "errored", lastChecked: "2026-05-05T11:59:30.000Z", captainWorkspace: "feedback-captain", excerpt: "✗ build failed: cannot bind port" },
    { project: "retired",       state: "offline", lastChecked: "2026-05-04T12:00:00.000Z", captainWorkspace: "retired-captain",  excerpt: "[process exited with code 0]" },
    { project: "ghost",         state: "unknown", lastChecked: "",                          captainWorkspace: "ghost-captain",    excerpt: "" },
  ];

  it("renders one row per project", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 100 }));
    for (const row of sample) expect(out).toContain(row.project);
  });

  it("includes the state label", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 100 }));
    expect(out).toMatch(/idle/);
    expect(out).toMatch(/busy/);
    expect(out).toMatch(/blocked/);
    expect(out).toMatch(/errored/);
    expect(out).toMatch(/offline/);
    expect(out).toMatch(/unknown/);
  });

  it("renders ages relative to now", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 100 }));
    expect(out).toContain("30s");      // brove
    expect(out).toContain("2m");       // solder
    expect(out).toContain("stale");    // retired
    expect(out).toContain("?");        // ghost
  });

  it("renders the first non-empty excerpt line per row", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 200 }));
    expect(out).toContain("Welcome to Claude Code");
    expect(out).toContain("Cogitating");
    expect(out).toContain("waiting for input from user");
  });

  it("truncates excerpt to fit width", () => {
    const long = [{ ...sample[0], excerpt: "x".repeat(500) }];
    const out = strip(renderDashboard(long, { now: NOW, width: 80 }));
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("includes a footer with the current time and refresh hint", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 100 }));
    expect(out).toContain("Refreshes every 10s");
  });

  it("handles the empty-projects case with a friendly message", () => {
    const out = strip(renderDashboard([], { now: NOW, width: 100 }));
    expect(out).toContain("No projects registered");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dashboard/__tests__/render.test.ts`
Expected: FAIL — module `../render.js` not found.

- [ ] **Step 3: Implement `src/dashboard/render.ts`**

```typescript
import chalk from "chalk";
import type { ProjectStatus, DashboardState } from "./read-status.js";

export interface RenderOptions {
  now: string;          // ISO-8601 string, used for age calc + footer
  width?: number;       // terminal width (defaults to process.stdout.columns or 100)
}

const ICON: Record<DashboardState, (s: string) => string> = {
  idle:    chalk.green,
  busy:    chalk.cyan,
  blocked: chalk.yellow,
  errored: chalk.red,
  offline: chalk.dim,
  unknown: chalk.gray,
};

const ICON_CHAR: Record<DashboardState, string> = {
  idle:    "●",
  busy:    "◐",
  blocked: "⏸",
  errored: "✗",
  offline: "○",
  unknown: "·",
};

export function formatAge(lastChecked: string, now: string): string {
  if (!lastChecked) return "?";
  const t = Date.parse(lastChecked);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return "?";
  const sec = Math.max(0, Math.floor((n - t) / 1000));
  if (sec < 60)        return `${sec}s`;
  if (sec < 60 * 60)   return `${Math.floor(sec / 60)}m`;
  if (sec < 60 * 60 * 24) return `${Math.floor(sec / 3600)}h`;
  return "stale";
}

function firstLine(s: string): string {
  for (const line of s.split(/\r?\n/)) {
    if (line.trim().length > 0) return line.trim();
  }
  return "";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}

export function renderDashboard(rows: ProjectStatus[], opts: RenderOptions): string {
  const width = opts.width ?? 100;
  const lines: string[] = [];

  lines.push("");
  lines.push("  " + chalk.bold("📊 Cockpit Dashboard") + "  " + chalk.dim(opts.now));
  lines.push("");

  if (rows.length === 0) {
    lines.push("  " + chalk.yellow("No projects registered. Add one with: cockpit projects add <name> <path>"));
    lines.push("");
    return lines.join("\n");
  }

  // Column widths — fixed for the left side, excerpt fills the remainder.
  const NAME_W  = 16;
  const STATE_W = 8;
  const AGE_W   = 6;
  const FIXED   = 2 /*indent*/ + 1 /*icon*/ + 1 + NAME_W + 1 + STATE_W + 1 + AGE_W + 3 /*│ */;
  const excerptW = Math.max(20, width - FIXED);

  for (const r of rows) {
    const icon = ICON[r.state](ICON_CHAR[r.state]);
    const name = chalk.cyan(pad(r.project, NAME_W));
    const state = ICON[r.state](pad(r.state, STATE_W));
    const age = pad(formatAge(r.lastChecked, opts.now), AGE_W);
    const excerpt = chalk.dim(truncate(firstLine(r.excerpt), excerptW));
    lines.push(`  ${icon} ${name} ${state} ${age} │ ${excerpt}`);
  }

  lines.push("");
  lines.push(chalk.dim("  Refreshes every 10s · Ctrl+C to exit"));
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dashboard/__tests__/render.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/render.ts src/dashboard/__tests__/render.test.ts
git commit -m "feat(dashboard): pure ANSI grid renderer (#44)"
```

---

## Task 3: Hub mirror — `sync-hub` writer (TDD)

**Files:**
- Create: `src/dashboard/sync-hub.ts`
- Create: `src/dashboard/__tests__/sync-hub.test.ts`

`syncHub({ config, statuses, writeFile, mkdir })` writes one mirror file per project to `{hubVault}/projects/<name>.md`. Each mirror file has the same frontmatter shape that the spoke `status.md` has, plus the excerpt block, so Dataview can index it. Skipped silently if `hubVault` is empty.

- [ ] **Step 1: Write failing tests**

Create `src/dashboard/__tests__/sync-hub.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import type { CockpitConfig } from "../../config.js";
import type { ProjectStatus } from "../read-status.js";
import { syncHub, buildMirrorMarkdown } from "../sync-hub.js";

function makeConfig(overrides: Partial<CockpitConfig> = {}): CockpitConfig {
  return {
    commandName: "command",
    hubVault: "/tmp/hub",
    projects: {
      brove:  { path: "/tmp/brove",  captainName: "brove-captain",  spokeVault: "/tmp/spokes/brove",  host: "local" },
      solder: { path: "/tmp/solder", captainName: "solder-captain", spokeVault: "/tmp/spokes/solder", host: "local" },
    },
    defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
    metrics: { enabled: false, path: "" },
    ...overrides,
  } as CockpitConfig;
}

const STATUSES: ProjectStatus[] = [
  { project: "brove",  state: "idle", lastChecked: "2026-05-05T12:00:00.000Z", captainWorkspace: "brove-captain",  excerpt: "alpha\n│ > " },
  { project: "solder", state: "busy", lastChecked: "2026-05-05T12:00:00.000Z", captainWorkspace: "solder-captain", excerpt: "✻ Cogitating" },
];

describe("buildMirrorMarkdown", () => {
  it("emits dataview-readable frontmatter + excerpt", () => {
    const out = buildMirrorMarkdown(STATUSES[0]);
    expect(out).toMatch(/^---$/m);
    expect(out).toContain("project: brove");
    expect(out).toContain("auto_state: idle");
    expect(out).toContain('auto_last_checked: "2026-05-05T12:00:00.000Z"');
    expect(out).toContain("captain_workspace: brove-captain");
    expect(out).toContain("## Last activity excerpt");
    expect(out).toMatch(/```\nalpha\n│ > \n```/);
  });

  it("emits frontmatter even when excerpt is empty", () => {
    const out = buildMirrorMarkdown({ ...STATUSES[0], excerpt: "" });
    expect(out).toContain("auto_state: idle");
    expect(out).toMatch(/```\n\n```/);
  });
});

describe("syncHub", () => {
  let writes: Array<{ path: string; content: string }>;
  let mkdirs: string[];

  beforeEach(() => {
    writes = [];
    mkdirs = [];
  });

  it("writes one mirror file per status row to {hubVault}/projects/<name>.md", () => {
    const result = syncHub({
      config: makeConfig(),
      statuses: STATUSES,
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: (p) => { mkdirs.push(p); },
    });

    expect(writes.map((w) => w.path)).toEqual([
      "/tmp/hub/projects/brove.md",
      "/tmp/hub/projects/solder.md",
    ]);
    expect(mkdirs).toContain("/tmp/hub/projects");
    expect(result).toEqual([
      { project: "brove",  hubPath: "/tmp/hub/projects/brove.md" },
      { project: "solder", hubPath: "/tmp/hub/projects/solder.md" },
    ]);
  });

  it("returns [] and writes nothing when hubVault is empty", () => {
    const result = syncHub({
      config: makeConfig({ hubVault: "" }),
      statuses: STATUSES,
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: (p) => { mkdirs.push(p); },
    });

    expect(result).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("expands ~ in hubVault", () => {
    const home = process.env.HOME ?? "/home";
    syncHub({
      config: makeConfig({ hubVault: "~/cockpit-hub" }),
      statuses: [STATUSES[0]],
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: (p) => { mkdirs.push(p); },
    });
    expect(writes[0].path).toBe(`${home}/cockpit-hub/projects/brove.md`);
  });

  it("skips status rows with state='unknown' (no data, don't churn the mirror)", () => {
    const result = syncHub({
      config: makeConfig(),
      statuses: [{ ...STATUSES[0], state: "unknown" }],
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: () => {},
    });
    expect(result).toEqual([]);
    expect(writes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dashboard/__tests__/sync-hub.test.ts`
Expected: FAIL — module `../sync-hub.js` not found.

- [ ] **Step 3: Implement `src/dashboard/sync-hub.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import type { CockpitConfig } from "../config.js";
import { resolveHome } from "../config.js";
import type { ProjectStatus } from "./read-status.js";

export interface SyncHubResult {
  project: string;
  hubPath: string;
}

export interface SyncHubDeps {
  config: CockpitConfig;
  statuses: ProjectStatus[];
  writeFile?: (path: string, content: string) => void;
  mkdir?: (dirPath: string) => void;
}

export function buildMirrorMarkdown(s: ProjectStatus): string {
  const fenced = "```";
  return [
    "---",
    `project: ${s.project}`,
    `auto_state: ${s.state}`,
    `auto_last_checked: "${s.lastChecked}"`,
    `captain_workspace: ${s.captainWorkspace}`,
    "---",
    "",
    `# ${s.project}`,
    "",
    "> Mirror of `{spokeVault}/status.md`. Updated by `cockpit dashboard sync-hub` (#44).",
    "",
    "## Last activity excerpt",
    "",
    fenced,
    s.excerpt,
    fenced,
    "",
  ].join("\n");
}

export function syncHub(deps: SyncHubDeps): SyncHubResult[] {
  if (!deps.config.hubVault) return [];

  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c));
  const mkdir = deps.mkdir ?? ((p) => fs.mkdirSync(p, { recursive: true }));

  const projectsDir = path.join(resolveHome(deps.config.hubVault), "projects");
  mkdir(projectsDir);

  const out: SyncHubResult[] = [];
  for (const s of deps.statuses) {
    if (s.state === "unknown") continue;
    const hubPath = path.join(projectsDir, `${s.project}.md`);
    try {
      writeFile(hubPath, buildMirrorMarkdown(s));
      out.push({ project: s.project, hubPath });
    } catch { /* best-effort */ }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dashboard/__tests__/sync-hub.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/sync-hub.ts src/dashboard/__tests__/sync-hub.test.ts
git commit -m "feat(dashboard): hub mirror writer (#44)"
```

---

## Task 4: Dashboard CLI — `--once`, `sync-hub`, `--pane` (TDD)

**Files:**
- Create: `src/commands/dashboard.ts`
- Create: `src/commands/__tests__/dashboard.test.ts`

The CLI is a `Command("dashboard")` with two flags and one subcommand:

- `cockpit dashboard --once` — reads statuses, prints renderer output, exits.
- `cockpit dashboard --pane` — opens a split pane in the current cmux workspace and sends a `while true; do clear; cockpit dashboard --once; sleep 10; done` loop into it. (No `watch` install dependency; portable bash.)
- `cockpit dashboard sync-hub [--json]` — calls `syncHub` and prints results.

The exported testable function is `runDashboardOnce({ config, statuses, render, write })` which writes rendered output to a stream-like `write`. The `--pane` and `sync-hub` paths get tested through the action layer with mocked runtime + IO.

- [ ] **Step 1: Write failing tests**

Create `src/commands/__tests__/dashboard.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const newPane = vi.hoisted(() => vi.fn());
const sendToPane = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

vi.mock("../../runtimes/index.js", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe: vi.fn(), list: vi.fn(), status: vi.fn(), spawn: vi.fn(),
    send: vi.fn(), sendKey: vi.fn(), readScreen: vi.fn(), stop: vi.fn(),
    newPane, closePane: vi.fn(), sendToPane, readPaneScreen: vi.fn(),
  }),
  RuntimeRegistry: class {
    constructor(private d: Record<string, unknown>) {}
    forProject() { return this.d.cmux; }
    global() { return this.d.cmux; }
    get(name: string) { return this.d[name]; }
    async probeAll() { return {}; }
  },
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../../config.js", () => ({
  loadConfig,
  resolveHome: (p: string) => p.replace(/^~/, process.env.HOME ?? ""),
}));

import { runDashboardOnce, runDashboardPane, runSyncHub } from "../dashboard.js";

const cfg = () => ({
  commandName: "command",
  hubVault: "/tmp/hub",
  projects: {
    brove: { path: "/tmp/brove", captainName: "brove-captain", spokeVault: "/tmp/spokes/brove", host: "local" },
  },
  defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
  metrics: { enabled: false, path: "" },
});

const SAMPLE = [
  "---",
  "project: brove",
  "auto_state: idle",
  'auto_last_checked: "2026-05-05T12:00:00.000Z"',
  "captain_workspace: brove-captain",
  "---",
  "",
  "## Last activity excerpt",
  "",
  "```",
  "│ > ",
  "```",
  "",
].join("\n");

describe("runDashboardOnce", () => {
  let writes: string[];
  beforeEach(() => {
    writes = [];
    loadConfig.mockReturnValue(cfg());
  });

  it("renders the grid for every registered project", () => {
    runDashboardOnce({
      readFile: () => SAMPLE,
      now: () => "2026-05-05T12:00:30.000Z",
      write: (s) => writes.push(s),
    });
    const out = writes.join("");
    expect(out).toContain("brove");
    expect(out).toContain("idle");
    expect(out).toContain("30s");
  });

  it("renders the empty-projects message when no projects are registered", () => {
    loadConfig.mockReturnValueOnce({ ...cfg(), projects: {} });
    runDashboardOnce({
      readFile: () => "",
      now: () => "2026-05-05T12:00:30.000Z",
      write: (s) => writes.push(s),
    });
    expect(writes.join("")).toContain("No projects registered");
  });
});

describe("runSyncHub", () => {
  let writes: Array<{ path: string; content: string }>;
  let mkdirs: string[];

  beforeEach(() => {
    writes = [];
    mkdirs = [];
    loadConfig.mockReturnValue(cfg());
  });

  it("writes a hub mirror per project", () => {
    const result = runSyncHub({
      readFile: () => SAMPLE,
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: (p) => { mkdirs.push(p); },
    });
    expect(result).toEqual([{ project: "brove", hubPath: "/tmp/hub/projects/brove.md" }]);
    expect(writes[0].path).toBe("/tmp/hub/projects/brove.md");
    expect(writes[0].content).toContain("auto_state: idle");
  });
});

describe("runDashboardPane", () => {
  beforeEach(() => {
    newPane.mockReset();
    sendToPane.mockReset();
    execSyncMock.mockReset();
    loadConfig.mockReturnValue(cfg());
    execSyncMock.mockReturnValue("workspace:42 something");
    newPane.mockResolvedValue({ workspaceId: "workspace:42", surfaceId: "surface:9" });
  });

  it("opens a split pane in the current cmux workspace", async () => {
    await runDashboardPane({});
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:42",
      direction: "right",
      title: expect.stringContaining("dashboard"),
    }));
  });

  it("sends a refreshing loop command into the new pane", async () => {
    await runDashboardPane({});
    const sent = sendToPane.mock.calls[0][1] as string;
    expect(sent).toContain("cockpit dashboard --once");
    expect(sent).toContain("sleep 10");
    expect(sent).toMatch(/while true/i);
  });

  it("respects --direction and --interval overrides", async () => {
    await runDashboardPane({ direction: "down", interval: 5 });
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({ direction: "down" }));
    expect(sendToPane.mock.calls[0][1]).toContain("sleep 5");
  });

  it("throws when not inside a cmux workspace", async () => {
    execSyncMock.mockReturnValueOnce("not a workspace");
    await expect(runDashboardPane({})).rejects.toThrow(/cmux workspace/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands/__tests__/dashboard.test.ts`
Expected: FAIL — module `../dashboard.js` not found.

- [ ] **Step 3: Implement `src/commands/dashboard.ts`**

```typescript
import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import { readAllStatuses } from "../dashboard/read-status.js";
import { renderDashboard } from "../dashboard/render.js";
import { syncHub, type SyncHubResult } from "../dashboard/sync-hub.js";
import type { PaneRef } from "../runtimes/types.js";

// TODO(runtime): current-workspace not yet abstracted by RuntimeDriver — direct cmux call retained,
// matching the existing pattern in src/commands/command.ts.
const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

function detectCurrentWorkspace(): string {
  const out = execSync(`"${CMUX_BIN}" current-workspace`, { encoding: "utf-8" }).trim();
  const match = out.match(/workspace:\d+/);
  if (!match) {
    throw new Error("Could not detect current cmux workspace. Run `cockpit dashboard --pane` from inside a cmux workspace.");
  }
  return match[0];
}

export interface DashboardOnceDeps {
  readFile?: (path: string) => string;
  now?: () => string;
  write?: (s: string) => void;
}

export function runDashboardOnce(deps: DashboardOnceDeps = {}): void {
  const config = loadConfig();
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf-8"));
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const write = deps.write ?? ((s) => process.stdout.write(s));

  const statuses = readAllStatuses({ config, readFile });
  const width = process.stdout.columns ?? 100;
  write(renderDashboard(statuses, { now, width }));
  write("\n");
}

export interface SyncHubCliDeps {
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  mkdir?: (path: string) => void;
}

export function runSyncHub(deps: SyncHubCliDeps = {}): SyncHubResult[] {
  const config = loadConfig();
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf-8"));
  const statuses = readAllStatuses({ config, readFile });
  return syncHub({ config, statuses, writeFile: deps.writeFile, mkdir: deps.mkdir });
}

export interface DashboardPaneInput {
  direction?: "right" | "left" | "up" | "down";
  interval?: number;
}

export async function runDashboardPane(input: DashboardPaneInput): Promise<PaneRef> {
  const config = loadConfig();
  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).global(config);
  const workspaceId = detectCurrentWorkspace();

  const interval = input.interval ?? 10;
  const direction = input.direction ?? "right";
  const title = "📊 dashboard";

  // Portable refresh loop — no `watch` install dependency.
  // FORCE_COLOR=1 makes chalk emit ANSI even when run through the loop.
  const loop = `clear; while true; do clear; FORCE_COLOR=1 cockpit dashboard --once; sleep ${interval}; done`;

  const pane = await runtime.newPane({ workspaceId, direction, title });
  await runtime.sendToPane(pane, loop);
  return pane;
}

export const dashboardCommand = new Command("dashboard")
  .description("Live status grid of all projects (auto-derived from spoke status.md)")
  .option("--once", "Print one snapshot and exit (used by --pane's refresh loop)")
  .option("--pane", "Open a refreshing sidebar pane in the current cmux workspace")
  .option("--direction <dir>", "Pane split direction (right|left|up|down)", "right")
  .option("--interval <seconds>", "Refresh interval for --pane", (v) => parseInt(v, 10), 10)
  .action(async (opts: { once?: boolean; pane?: boolean; direction: "right" | "left" | "up" | "down"; interval: number }) => {
    try {
      if (opts.pane) {
        const pane = await runDashboardPane({ direction: opts.direction, interval: opts.interval });
        console.log(chalk.green(`✔ Dashboard pane opened in ${pane.workspaceId} ${pane.surfaceId}`));
        return;
      }
      // Default behaviour: --once. (Bare `cockpit dashboard` prints once and exits.)
      runDashboardOnce();
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

dashboardCommand
  .command("sync-hub")
  .description("Mirror each spoke status.md into {hubVault}/projects/<name>.md for Obsidian Dataview")
  .option("--json", "Emit results as JSON")
  .action((opts: { json?: boolean }) => {
    const results = runSyncHub();
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log(chalk.dim("\n  No mirrors written (no projects with usable status.md, or hubVault unset).\n"));
      return;
    }
    console.log(chalk.bold("\n  📊 Hub mirror sync\n"));
    for (const r of results) {
      console.log(`  ${chalk.green("✔")} ${chalk.cyan(r.project.padEnd(16))} → ${chalk.dim(r.hubPath)}`);
    }
    console.log("");
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/commands/__tests__/dashboard.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/dashboard.ts src/commands/__tests__/dashboard.test.ts
git commit -m "feat(dashboard): cockpit dashboard CLI (--once, --pane, sync-hub) (#44)"
```

---

## Task 5: Wire `dashboardCommand` into the CLI root

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Register the new command**

In `src/index.ts`, add the import next to the others:

```typescript
import { dashboardCommand } from "./commands/dashboard.js";
```

And register it (place it next to `commandCommand` / `crewCommand`):

```typescript
program.addCommand(dashboardCommand);
```

- [ ] **Step 2: Build + smoke-test help**

Run: `npm run build && node dist/index.js dashboard --help`
Expected: prints "Live status grid of all projects" plus the `sync-hub` subcommand listing.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(dashboard): register dashboard command in CLI root (#44)"
```

---

## Task 6: Hub Dataview page — replace `obsidian/hub/dashboard.md`

**Files:**
- Modify: `obsidian/hub/dashboard.md`

The current file uses the *old* manual-write frontmatter (`captain_session`, `active_crew`, etc.). Replace it with a Dataview query keyed on the new auto-poller frontmatter that `sync-hub` mirrors.

- [ ] **Step 1: Overwrite the file**

Replace `obsidian/hub/dashboard.md` with:

````markdown
---
title: Cockpit Dashboard
---

# Cockpit Dashboard

Auto-derived state of every registered project. Mirrored from each spoke's `status.md` by `cockpit dashboard sync-hub` (#44), which the reactor runs every cycle alongside `cockpit reactor poll-status` (#43).

```dataview
TABLE WITHOUT ID
  file.link as "Project",
  auto_state as "State",
  captain_workspace as "Captain",
  auto_last_checked as "Last checked"
FROM "projects"
SORT auto_last_checked DESC
```

## States

| Icon | State | Meaning |
|------|-------|---------|
| ●    | idle    | Prompt visible, no spinner |
| ◐    | busy    | Spinner / "Brewing" / "Cogitating" / "Compiling" / similar |
| ⏸    | blocked | "blocked" / "waiting for input" / "needs input" |
| ✗    | errored | "✗" / "panic:" / "FATAL" / "Error:" |
| ○    | offline | Empty pane / "session ended" / "[process exited" |

## Refresh

- Reactor cycle (default 5 min) re-polls all captain panes and re-mirrors here.
- Run a one-shot refresh manually: `cockpit reactor poll-status && cockpit dashboard sync-hub`.
- For a live in-terminal view: `cockpit dashboard --pane` (sidebar pane in cmux, refreshes every 10s).
````

- [ ] **Step 2: Commit**

```bash
git add obsidian/hub/dashboard.md
git commit -m "docs(hub): rewrite dashboard.md as Dataview over auto_state mirror (#44)"
```

---

## Task 7: Idempotent `cockpit init` dashboard refresh

**Files:**
- Modify: `src/commands/init.ts`

`cockpit init` already copies the entire hub template on a fresh setup but **skips** existing hub vaults. To honour the issue's "idempotent" requirement (the dashboard page must arrive even when re-running init against an existing hub), add a small step that always overwrites `{hubVault}/dashboard.md` and ensures `{hubVault}/projects/` exists.

- [ ] **Step 1: Insert the idempotent refresh step**

In `src/commands/init.ts`, find the block that ends with the "Hub vault already exists / scaffolded / created empty" log lines (currently around the `// 2. Scaffold hub vault from template` block). Immediately after that block, add:

```typescript
    // 2b. Always refresh dashboard.md and ensure projects/ exists (idempotent — see #44)
    const hubDashboardSrc = path.join(pkgRoot, "obsidian", "hub", "dashboard.md");
    const hubDashboardDest = path.join(hubPath, "dashboard.md");
    if (fs.existsSync(hubDashboardSrc)) {
      fs.copyFileSync(hubDashboardSrc, hubDashboardDest);
      console.log(chalk.green(`  ✔ Dashboard page refreshed at ${hubDashboardDest}`));
    }
    const projectsDir = path.join(hubPath, "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
```

- [ ] **Step 2: Build + smoke-test**

Run: `npm run build && node dist/index.js init --hub /tmp/cockpit-init-test`
Expected: prints "Hub vault scaffolded" then "Dashboard page refreshed". Re-running it prints "Hub vault already exists" then **still** prints "Dashboard page refreshed" — proving idempotency.

Cleanup: `rm -rf /tmp/cockpit-init-test`.

- [ ] **Step 3: Commit**

```bash
git add src/commands/init.ts
git commit -m "feat(init): idempotently refresh hub dashboard.md + ensure projects/ (#44)"
```

---

## Task 8: Reactor cycle — call `sync-hub` after `poll-status`

**Files:**
- Modify: `scripts/reactor-cycle.sh`

`scripts/reactor-cycle.sh` already calls `cockpit reactor poll-status` (added in #43). Right after it, call `cockpit dashboard sync-hub` so the hub mirror always reflects the latest spoke state — the second consumer (Obsidian) gets the same freshness as the first.

- [ ] **Step 1: Insert the sync-hub step**

In `scripts/reactor-cycle.sh`, find the existing block:

```bash
# Step 1.5: Auto-status poll — read captain panes, classify, write status.md
echo "📡 Polling captain panes (auto-status)..."
if command -v cockpit >/dev/null 2>&1; then
  cockpit reactor poll-status 2>&1 | sed 's/^/   /' || echo "   ⚠️  Auto-status poll failed (continuing)"
else
  echo "   ⚠️  cockpit CLI not on PATH — skipping auto-status"
fi
```

Immediately after that block (still before the captain-status / event scan steps), add:

```bash
# Step 1.6: Hub mirror — sync each spoke status.md into {hubVault}/projects/ for Obsidian Dataview
echo "📋 Syncing dashboard hub mirror..."
if command -v cockpit >/dev/null 2>&1; then
  cockpit dashboard sync-hub 2>&1 | sed 's/^/   /' || echo "   ⚠️  Dashboard sync-hub failed (continuing)"
else
  echo "   ⚠️  cockpit CLI not on PATH — skipping dashboard sync-hub"
fi
```

- [ ] **Step 2: Smoke-test the script**

Run:
```bash
echo '{"engine":{"poll_interval":"5m","state_file":"/tmp/s.json","max_retries":2},"github":{"repos":{}},"reactions":{},"auto_status":{"enabled":false}}' > /tmp/empty-reactions.json
bash scripts/reactor-cycle.sh /tmp/empty-reactions.json
```
Expected: prints both `📡 Polling captain panes` and `📋 Syncing dashboard hub mirror` lines; the rest of the cycle exits cleanly because there are no GitHub events.

- [ ] **Step 3: Commit**

```bash
git add scripts/reactor-cycle.sh
git commit -m "feat(reactor): invoke dashboard sync-hub after poll-status (#44)"
```

---

## Task 9: README — document the dashboard

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a `### Dashboard` section under the Knowledge System / Status section**

In `README.md`, locate the `### Knowledge System` block (rewritten in #42 / #43). Right after the bullet that documents the auto-poller (`**Status (auto)** — every reactor cycle …`), append:

```markdown
- **Dashboard** — `cockpit dashboard --pane` opens a refreshing sidebar pane in cmux that lists every project's auto-derived state. `cockpit dashboard sync-hub` mirrors each spoke `status.md` into `{hubVault}/projects/` so the hub vault's `dashboard.md` Dataview query renders the same data inside Obsidian. The reactor cycle calls `sync-hub` after every `poll-status`.
```

- [ ] **Step 2: Add rows to the commands table**

Right after the `cockpit reactor poll-status` row (added in #43), append:

```markdown
| `cockpit dashboard [--once]` | Print a one-shot status grid for all projects to the terminal. |
| `cockpit dashboard --pane [--direction <dir>] [--interval <s>]` | Open a refreshing sidebar pane in the current cmux workspace. |
| `cockpit dashboard sync-hub [--json]` | Mirror spoke `status.md` files into `{hubVault}/projects/` for Obsidian Dataview. |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document cockpit dashboard (#44)"
```

---

## Task 10: Full-suite verification + PR

- [ ] **Step 1: Build clean**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass except the 2 pre-existing emoji-related `commandName` failures in `src/config.test.ts` (unrelated to #44).

- [ ] **Step 3: Re-link cockpit and smoke-test the full path**

```bash
npm link
cockpit dashboard --once                                          # one-shot grid
cockpit dashboard sync-hub --json | jq .                          # JSON shape
cockpit reactor poll-status && cockpit dashboard sync-hub         # full pipeline
ls "$(jq -r '.hubVault' ~/.config/cockpit/config.json | sed "s|^~|$HOME|")/projects" # mirror files exist
```

If you have a registered project + a captain workspace + you're sitting in a cmux session, also try the sidebar pane (it's the headline feature):

```bash
cockpit dashboard --pane
```

Expected: a new pane opens to the right titled `📊 dashboard`, refreshing every 10s with one row per project.

- [ ] **Step 4: Audit — no new direct cmux invocations outside the established sites**

```bash
git grep -nE '/Applications/cmux\.app/Contents/Resources/bin/cmux' -- 'src/' 'plugin/' 'orchestrator/' 'scripts/'
```
Expected: only the pre-existing hits in `src/runtimes/cmux.ts`, `src/commands/launch.ts`, `src/commands/command.ts`, **plus** one new hit in `src/commands/dashboard.ts` for the same `current-workspace` detection helper. No other new cmux calls in `src/dashboard/`.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin feature/dashboard
gh pr create --base develop --title "Dashboard — cmux sidebar pane + hub Dataview (#44)" --body "$(cat <<'EOF'
Closes #44 (under umbrella #40).

## Summary

A single live view of every project's auto-derived state, with two consumers reading the same data:

1. **`cockpit dashboard --pane`** — opens a refreshing sidebar pane in the current cmux workspace. Compact ANSI grid, one row per project (state icon, name, state, age, first excerpt line). Refreshes every 10s via a portable bash loop (no `watch` install dependency).
2. **`cockpit dashboard --once`** — prints one snapshot to stdout. The pane's loop calls this.
3. **Hub Obsidian Dataview page** — `obsidian/hub/dashboard.md` rewritten to query the new `auto_state` / `auto_last_checked` / `captain_workspace` frontmatter. `cockpit init` now refreshes this idempotently on every run.
4. **`cockpit dashboard sync-hub`** — mirrors each spoke `status.md` into `{hubVault}/projects/<name>.md` so Dataview can index it. Called from `scripts/reactor-cycle.sh` right after `cockpit reactor poll-status`, so the hub view's freshness matches the spoke view.

Pattern validated by tmux-agent-sidebar, opensessions (per spec decision #6).

## What's new

- `src/dashboard/read-status.ts` — pure `parseStatusFile` + `readAllStatuses` (handles missing/malformed files with `state: "unknown"`).
- `src/dashboard/render.ts` — pure ANSI grid renderer with `formatAge` ("30s", "2m", "3h", "stale", "?").
- `src/dashboard/sync-hub.ts` — pure-ish hub mirror writer (skips `unknown` rows, expands `~`, no-ops when `hubVault` is empty).
- `src/commands/dashboard.ts` — `cockpit dashboard {--once,--pane,sync-hub}` CLI.
- `obsidian/hub/dashboard.md` — Dataview query against the mirrored frontmatter.
- `src/commands/init.ts` — idempotent dashboard refresh + `projects/` dir guarantee.
- `scripts/reactor-cycle.sh` — calls `cockpit dashboard sync-hub` after `cockpit reactor poll-status`.

## Non-goals

- No web UI / Electron / separate window (per spec).
- No graphs / metrics / history — current state only.
- No real-time push — polling-based, freshness = reactor cadence.
- No new agent action required — the auto-poller (#43) is the only writer of source data.

## Test plan

- [x] Pure-layer unit tests: 9 for `read-status`, 7 for `render`, 6 for `sync-hub`, 7 for the CLI thunks.
- [x] Build + lint clean.
- [x] Manual smoke: `cockpit dashboard --once` prints the grid; `cockpit dashboard sync-hub --json` writes one mirror per registered project; `cockpit dashboard --pane` opens a refreshing sidebar in cmux (when run inside a cmux workspace).
- [x] Reactor cycle smoke: `bash scripts/reactor-cycle.sh /tmp/empty-reactions.json` prints both poll-status and sync-hub steps.
- [x] No new direct cmux binary calls outside `src/runtimes/cmux.ts` and the existing `current-workspace` sites.
EOF
)"
```

- [ ] **Step 6: Verify CI is green and request review** (or self-merge for solo).

---

## Self-Review Checklist

Before declaring this plan complete, verify:

1. **Spec coverage** — every checkbox in #44 is covered:
   - [x] **C1** — `cockpit dashboard --pane` opens a sidebar pane (Task 4).
   - [x] **C1** — Reads each registered project's `{spokeVault}/status.md` (Task 1).
   - [x] **C1** — Renders a compact table: project, state (icon + color), excerpt, age (Task 2).
   - [x] **C1** — Auto-refresh ~10s (Task 4 — portable while-loop, no `watch` install dep).
   - [x] **C1** — `cockpit dashboard --once` prints once and exits (Task 4).
   - [x] **C2** — Hub `dashboard.md` template uses Dataview against spoke `status.md` frontmatter (Task 6 + Task 3 mirror).
   - [x] **C2** — Document the Dataview query in README (Task 9).
   - [x] **C2** — `cockpit init` writes the dashboard page on first run (idempotent) (Task 7).

2. **No drive-by refactoring** — Karpathy principles: every changed line traces to a checkbox in #44. The auto-poller (#43) is **not** modified — `sync-hub` is a separate consumer that reads the same file. The four plugin slots are not touched. The runtime driver gains no new methods (uses existing `newPane` + `sendToPane` from #41).

3. **Pure machine, cross-agent** — the renderer and reader are agent-agnostic; they parse the same generic frontmatter the auto-poller writes. The `--pane` variant uses `cockpit runtime`'s pane methods; switching to a tmux runtime later requires zero changes here.

4. **All new code has tests** — `read-status.ts`, `render.ts`, `sync-hub.ts`, and `dashboard.ts` are fully covered by injected-dep unit tests. No filesystem touches in tests.

5. **Two consumers, one data source** — confirmed by reviewing the data flow: spoke `status.md` (written by #43) is read by both `runDashboardOnce` (CLI) and `runSyncHub` (mirror to hub). The mirror is a *projection* of the source, not a parallel source.

6. **Hard rules respected** — no edits to `.gitignore`, no edits to `.claude/`, no destructive operations. PR is opened against `develop`, not `main`.
