# Plugin/Extension System — Phase 2: Workspace Slot

> **✅ Shipped** (PR #20 (workspace seam, @cockpit/workspaces), 2026-04-21). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-04-21
**Status:** Draft — design only, implementation in next sprint
**Issue:** [#9](https://github.com/tu11aa/claude-cockpit/issues/9)
**Phase:** 2 of N (workspace slot after phase 1 runtime)
**Depends on:** Phase 1 (runtime slot) — merged as PR #20 at commit `6c1d6ea`

## Problem

Cockpit's vault storage is tightly coupled to Obsidian's filesystem layout. The `spokeVault` and `hubVault` paths are read directly via `fs.readFileSync`, `fs.writeFileSync`, `fs.readdirSync`, `fs.mkdirSync`, and `path.join` across 11 files and ~33 call-sites. Every command that reads daily logs, writes status, lists learnings, or renders the wiki hardcodes both the Obsidian vault filesystem layout AND the Node `fs` API.

Swapping Obsidian for Notion, plain-markdown-in-a-different-directory, or an S3-backed vault requires editing every one of those call-sites. There is no seam for a remote or API-driven backend.

## Goal

Abstract vault storage behind a `WorkspaceDriver` interface mirroring the existing `src/drivers/` (agent) and `src/runtimes/` (runtime) patterns. Obsidian remains the default and only shipped implementation. The abstraction:

- Moves filesystem `read/write/list/exists/mkdir` behind a driver boundary
- Replaces absolute-path call-sites with scope-relative calls (`workspace.read("daily-logs/2026-04-21.md")`)
- Unlocks future backends (Notion, S3, plain-md) without further refactoring

## Non-Goals

- **Additional slots** (tracker, notifier) — phase 3+ of #9.
- **External plugin loading** from `node_modules` — phase 4, deferred.
- **New workspace implementations** beyond Obsidian — each new provider is its own follow-up PR.
- **Domain-level abstraction** (e.g., `getDailyLog(date)`, `appendLearning(...)`) — this spec is filesystem-level only. Domain helpers continue to live in `src/lib/daily-logs.ts`, now built on top of the driver.
- **Strict typing of `WorkspaceScope`** — shipping loose (`Record<string, unknown>`) to match the phase 1 runtime pattern. Tightening is tracked as [#23](https://github.com/tu11aa/claude-cockpit/issues/23).
- **Migration of learnings/wiki bash scripts** (`wiki-ingest.sh`, `learnings-record.sh`) — bounded exception. Scripts operate on vault directories directly; they stay as-is in phase 2 and fold in when bash-side migration stabilizes.

## Architecture: Workspace Driver (mirrors Runtime Driver)

```
cockpit core
  └── src/workspaces/
        ├── types.ts         ← WorkspaceDriver interface + types
        ├── obsidian.ts      ← Obsidian (fs-backed) driver
        ├── registry.ts      ← WorkspaceRegistry — config-driven scope resolution
        ├── index.ts         ← re-exports
        └── __tests__/       ← unit tests + in-memory helper
```

Cockpit core and bash scripts never touch `fs` directly for vault data — always through a driver, exposed either as a TypeScript import (core code) or as `cockpit workspace <op>` CLI subcommands (bash scripts).

## 1. Workspace Driver Interface

```typescript
// src/workspaces/types.ts
export interface WorkspaceProbeResult {
  installed: boolean;           // provider dependencies present
  rootExists: boolean;          // the configured scope is reachable (dir exists, API auth works, etc.)
}

export interface WorkspaceScope {
  root?: string;                // obsidian: absolute filesystem root
  [key: string]: unknown;       // future providers attach their own fields (loose per #23)
}

export interface WorkspaceDriver {
  name: string;                 // "obsidian", "notion", ...

  probe(): Promise<WorkspaceProbeResult>;

  // All `path` arguments are scope-relative (e.g., "daily-logs/2026-04-21.md").
  // Forward-slash separators; the driver translates for its backend.
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;   // returns entry names only, not full paths
  mkdir(path: string): Promise<void>;     // always recursive
}

export type WorkspaceFactory = (scope: WorkspaceScope) => WorkspaceDriver;
```

### Contract notes

- **All operations are async.** Existing call-sites use sync `fs.*Sync`; migrating them is mechanical (`await driver.read(...)`).
- **Paths are scope-relative.** Callers never pass absolute paths or combine vault roots. The driver owns path resolution.
- **`list()` returns entry names only** — no leading path, no trailing slash. Mirrors `fs.readdirSync` semantics.
- **`mkdir()` is always recursive.** Non-recursive mkdir is never what cockpit wants — all current call-sites pass `{ recursive: true }`.
- **`probe()` returns two flags.** `installed` = the provider can run at all (filesystem driver always true; a future Notion driver returns false if `@notionhq/client` is missing). `rootExists` = this specific scope is reachable (dir exists / API auth valid).

## 2. Registry & Config

```typescript
// src/workspaces/registry.ts
export class WorkspaceRegistry {
  constructor(private factories: Record<string, WorkspaceFactory>) {}

  hub(config: CockpitConfig): WorkspaceDriver {
    const name = config.workspace ?? "obsidian";
    return this.get(name)({ root: resolveHome(config.hubVault) });
  }

  forProject(projectName: string, config: CockpitConfig): WorkspaceDriver {
    const proj = config.projects[projectName];
    if (!proj) throw new Error(`Project '${projectName}' not found`);
    const name = proj.workspace ?? config.workspace ?? "obsidian";
    return this.get(name)({ root: resolveHome(proj.spokeVault) });
  }

  get(name: string): WorkspaceFactory {
    const factory = this.factories[name];
    if (!factory) throw new Error(`Unknown workspace provider '${name}'`);
    return factory;
  }

  async probeAll(config: CockpitConfig): Promise<Record<string, WorkspaceProbeResult>> { /* ... */ }
}
```

Config additions (both optional, default `"obsidian"`; no migration required):

```jsonc
{
  "workspace": "obsidian",              // NEW — global default
  "hubVault": "~/cockpit-hub",          // EXISTING — becomes obsidian scope root
  "projects": {
    "brove": {
      "workspace": "obsidian",          // NEW — optional per-project override
      "spokeVault": "~/cockpit-hub/spokes/brove",  // EXISTING — obsidian scope root
      "path": "~/projects/brove",
      "captainName": "brove-captain",
      "host": "local"
    }
  }
}
```

When both `workspace` fields are absent, behavior is identical to today (obsidian, fs-backed). `cockpit doctor` gains a new check: probe each distinct workspace provider referenced in config and verify its scope (hub + every project's spoke root).

## 3. CLI Subcommand — Bridge to Bash

New command at `src/commands/workspace.ts`:

```
cockpit workspace read <target> <path>                 # prints content to stdout
cockpit workspace write <target> <path> <content>      # content = "-" reads from stdin
cockpit workspace list <target> <dir>                  # entry names, one per line
cockpit workspace exists <target> <path>               # exit 0 if exists, 1 if not
cockpit workspace mkdir <target> <path>                # recursive
```

`<target>` is one of:
- A project name — resolves to that project's spoke scope.
- `--hub` flag — resolves to the hub scope.

Process-spawn overhead per invocation (~100ms) is acceptable: the bash callers (`reactor-cycle.sh`, `read-status.sh`) already shell out for every operation; they don't run in hot loops.

## 4. Refactor Surface

| File | Current | After |
|------|---------|-------|
| `src/lib/daily-logs.ts` | `fs.readFileSync(path.join(spokeVault, "daily-logs", f))` | accepts `workspace: WorkspaceDriver` argument; uses `workspace.read(\`daily-logs/${f}\`)` |
| `src/commands/status.ts` | `fs.readdirSync(path.join(spokeVault, "crew"))` + `fs.readFileSync` per file | uses `workspace.list("crew")` + `workspace.read(...)` |
| `src/commands/standup.ts` | builds its own paths, calls daily-logs.ts | builds workspace via registry, passes to daily-logs helpers |
| `src/commands/retro.ts` | same as standup | same |
| `src/commands/init.ts` | `fs.mkdirSync` for hub + 7 spoke subdirs | `workspace.mkdir(subdir)` for each |
| `src/commands/launch.ts` | inline spoke-vault-ensure block (duplicated, 7 subdirs) | extracted helper `ensureSpokeLayout(workspace: WorkspaceDriver)` in `src/lib/vault-layout.ts` |
| `src/commands/doctor.ts` | `fs.existsSync(hubVault)`, `fs.existsSync(spokeVault)` | `hubDriver.probe()` and per-project `spokeDriver.probe()` |
| `src/commands/projects.ts` | spoke-vault init on add | `workspace.mkdir(...)` |
| `scripts/reactor-cycle.sh` | bash `cat`/read on hub vault paths | `cockpit workspace read --hub ...` |
| `scripts/read-status.sh` | bash `cat` on spoke status.md | `cockpit workspace read <project> status.md` |

All call-sites keep their file location — only their dependency changes.

## 5. Testing

Mirror `src/runtimes/__tests__/`:

- **Unit tests** for `ObsidianDriver` — mock `node:fs/promises`. Fixtures cover read/write round-trip, `list` returns names (not paths), `mkdir` is always recursive, `exists` boolean truth, scope-root prepending correctness.
- **Unit tests** for `WorkspaceRegistry` — project-override > global > default fallback chain (same pattern as `RuntimeRegistry`).
- **In-memory test driver** — `src/workspaces/__tests__/helpers/memory-driver.ts` — a `createMemoryDriver()` fixture backed by a `Map<string, string>`. Used by migrated call-sites (`daily-logs.ts`, `standup.ts`, etc.) to test business logic without fs mocks.
- **Integration smoke** — `cockpit workspace read <project> <path>` against a real spoke vault, gated behind `SKIP_INTEGRATION=1`.
- **Bash script regression** — smoke-test `reactor-cycle.sh` and `read-status.sh` paths against the in-memory driver via a mock `cockpit` binary that records calls.

## 6. Rollout

1. Land this spec and implementation plan.
2. Implement `src/workspaces/` with only `ObsidianDriver`.
3. Add `cockpit workspace` CLI subcommand.
4. Extract `ensureSpokeLayout` helper; migrate `init.ts`, `launch.ts`, `projects.ts`.
5. Migrate `daily-logs.ts` to take a driver argument; migrate standup/retro/status callers.
6. Migrate `doctor.ts` to probe workspace providers.
7. Migrate bash scripts.
8. Add config docs to README.
9. Ship as single PR.

## 7. Relationship to Other Work

- **Builds on:** Phase 1 runtime slot (PR #20). Same driver+registry+CLI pattern.
- **Unblocks:** future Notion driver (PR), plain-markdown driver (PR), remote backends.
- **Precedes:** phase 3 — tracker slot (GitHub → Linear/Jira abstraction).
- **Follow-up:** [#23](https://github.com/tu11aa/claude-cockpit/issues/23) — tighten `WorkspaceScope` to discriminated union once a second provider ships.
