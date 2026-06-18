# Step 7 — Group `@cockpit/cli` + delete the legacy `src/` layout (FINAL reorg step)

> **✅ Shipped** (PR #368, 2026-06-18). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-06-18
**Status:** Design — approved for planning
**Part of:** Monorepo reorganization initiative (step 7 of 7, FINAL) — see
[`2026-06-17-monorepo-reorg-design.md`](2026-06-17-monorepo-reorg-design.md)
**Predecessor:** Step 6 — `@cockpit/web` extracted (PR #366, develop `2ef8df5`).

## Context

After step 6, `packages/` holds `shared · core · agents · workspaces · web`, and `src/` holds
only the future **cli**: 29 command files, the bin entry `index.ts`, `lib/per-crew-settings.ts`,
the cli-side `control/` files (`cockpitd.ts`, `crew-routing.ts`, `relay-supervisor.ts`,
`relay-supervisor-loop.ts`, `relay-log-broadcaster.ts`), and a stray `config.test.ts`. Step 7
moves all of it into `packages/cli`, repoints the two tsup entries (output paths stay fixed),
and **deletes the legacy flat `src/` layout** — completing the six-package monorepo.

### Scope decision (approved)

The master spec bundled step 7 as *grouping* **+** a *thin-wrapper refactor* (push orchestration
logic out of `crew.ts` (804), `launch.ts` (446), `notify-relay.ts` (407) down into core/agents).
**This step does the mechanical grouping ONLY.** The thin-wrapper refactor rewrites the exact
lifecycle-critical files just stabilized (#360/#2/#3/#278) and is deferred to a **tracked GH
issue** for incremental, per-file work later. Rationale: the grouping is low-risk and mirrors
5a/5b/6; the refactor is behavior-sensitive and deserves its own spec + lifecycle re-testing.
This is a YAGNI/surgical-change call — finish the structure now, refactor deliberately later.

## Goal

`packages/cli` exists as a private workspace package containing all CLI surface (commands, bin
entry, daemon-host entry, cli-side control + lib). It may import from any package; **nothing in
any package imports from it** (verified: zero back-edges). The root stays the published
`claude-cockpit` package and build/publish orchestrator — `bin`, `files`, `dist/`, and
`tsup.config.ts` remain at root; only the tsup **entry source paths** change. The launchd plist
and the `dist/index.js` + `dist/cockpitd.js` output paths are **unchanged** (landmine #1 stays
disarmed). After this PR, `src/` no longer exists.

## Scope — what moves into `packages/cli/src/`

| Source (current) | → `packages/cli/src/` | Notes |
|---|---|---|
| `src/index.ts` | `index.ts` | bin entry (tsup `index` entry) |
| `src/commands/` (29 files + `__tests__/`) | `commands/` | straight move |
| `src/control/cockpitd.ts` | `control/cockpitd.ts` | daemon-host entry (tsup `cockpitd` entry) |
| `src/control/crew-routing.ts` | `control/crew-routing.ts` | cli-side (used by `crew.ts`) |
| `src/control/relay-supervisor.ts` | `control/relay-supervisor.ts` | cli-side (used by `launch.ts`) |
| `src/control/relay-supervisor-loop.ts` | `control/relay-supervisor-loop.ts` | cli-side (used by `relay.ts`) |
| `src/control/relay-log-broadcaster.ts` | `control/relay-log-broadcaster.ts` | cli-side (used by `relay.ts`) |
| `src/control/__tests__/` | `control/__tests__/` | travels with modules |
| `src/lib/per-crew-settings.ts` (+ `__tests__/`) | `lib/per-crew-settings.ts` | cli-only (imports `@cockpit/agents`) |

### Special case — `src/config.test.ts` → `packages/shared`

`src/config.test.ts` is a mislabeled orphan: it imports `getDefaultConfig`/`loadConfig`/`saveConfig`
from `@cockpit/shared` (the root `config.ts` already moved to shared in step 3). It belongs with
the other config tests in `packages/shared/src/lib/__tests__/config.test.ts`, **not** in cli.

## Dependency direction (verified by grep)

```
shared ◄── core ◄── {agents, workspaces, web} ◄── cli
```

`@cockpit/cli` is the apex: it imports `@cockpit/core`, `@cockpit/shared`, `@cockpit/agents`,
`@cockpit/workspaces`, `@cockpit/web` + npm deps + `node:`. **Zero packages import from cli**
(the back-edge gate — verified: no `packages/*/src/` import resolves into `src/`; the lone
`packages/core/src/launchd.ts:22` reference is a *compiled-output sibling lookup* of
`cockpitd.js` in `dist/`, not a source import — unaffected by the move).

## Build & publish topology (minimum-diff)

- **Root stays the published package** `claude-cockpit`: `bin: { cockpit: "./dist/index.js" }`,
  `files: [dist, plugin, scripts, templates]`, `tsup.config.ts`, root `tsconfig` solution file —
  all stay at root.
- **`packages/cli`** is a private workspace package with `package.json` (deps: the 5 sibling
  packages) + a composite `tsconfig.json` (project references to all five) + `README.md`. Its
  `tsc -b` output exists only for typecheck/DAG enforcement; it is **not** what runs.
- **tsup entries repoint to the new source** (output names unchanged):
  ```
  entry: {
    index:    "packages/cli/src/index.ts",            // -> dist/index.js   (bin)
    cockpitd: "packages/cli/src/control/cockpitd.ts",  // -> dist/cockpitd.js (launchd)
  }
  ```
- **Fix the `@cockpit/web` inline gap (in-scope cleanup):** `tsup.config.ts`'s
  `inlinePackagesPlugin` + `noExternal` currently inline only shared/core/agents/workspaces —
  **not web** (step 6 relied on default resolution). Since cli's commands import `@cockpit/web`,
  add `@cockpit/web` → `packages/web/dist/index.js` to the plugin and to `noExternal` so all five
  library packages are inlined consistently.
- **Root build script** gains `packages/cli` in the `tsc -b --force …` chain (last, as the apex).

## THE TRAP — runtime path lookups must NOT change

`index.ts` and `cockpitd.ts` compute `package.json`/source-root paths from `import.meta.url` /
`__dirname` / `SELF_PATH`. At **runtime these resolve against the bundled output in `dist/`**, not
the TypeScript source location — tsup inlines everything into `dist/index.js` + `dist/cockpitd.js`.
Because the **output paths are unchanged**, the existing path math stays correct:

- `index.ts`: `join(__dirname, "..", "package.json")` and `join(__dirname, "..")` — `__dirname` is
  `dist/` at runtime → `..` = repo root. **Leave as-is.**
- `cockpitd.ts:26`: `join(dirname(SELF_PATH), "..", "package.json")` — `SELF_PATH` is
  `dist/cockpitd.js` → `..` = repo root. **Leave as-is.** (This is exactly the #363 fix; changing
  `".."` to `"../.."` to "match the deeper source path" would REINTRODUCE the #363 ENOENT.)

The plan MUST flag these as do-not-touch. The `node dist/index.js config` + socket-safe daemon
boot gates verify they still resolve.

## Risks & watch-items

- **Daemon entry move is the heavy gate.** `cockpitd.ts` → `packages/cli/src/control/` while
  `dist/cockpitd.js` output and the launchd plist stay fixed. Validation must boot the rebuilt
  daemon on a **temp socket** (`rotationIntervalMs: 0`, `sweepMs: 0`) and confirm it binds +
  serves. NEVER run `node dist/cockpitd.js` against the real socket (#360 trap). Also assert
  `packages/core/src/launchd.ts` still resolves `cockpitd.js` as a dist sibling (its `launchd.test.ts`
  covers this — must stay green).
- **Path-lookup trap** (above) — the single most likely way to break this step.
- **`@cockpit/web` inline** — after adding it, re-verify the **tarball gate**: a clean isolated
  install must run `cockpit dashboard --once` (exercises the inlined web bundle), `cockpit --help`,
  and runtime-sync.
- **Minimum-diff** — straight `git mv`; do NOT split/refactor any command file (that's the
  deferred issue). Internal `./` imports survive (5a/5b/6 lesson).
- **`config.test.ts` move** — confirm it runs green under `packages/shared` (it already imports
  from `@cockpit/shared`, so no import edit needed beyond the path).

## Deferred work — tracked GH issue (filed as part of this step)

A GH issue captures the **thin-wrapper refactor** so the master-spec vision is not lost:

- Push orchestration logic out of command files into `core`/`agents`; commands become thin
  wrappers (parse args → call package function → format output).
- Headline splits: `crew.ts` (804) → naming · discovery · first-turn-delivery ·
  completion-protocol · spawn · lifecycle; `launch.ts` (446) → freshness(core) · readiness(workspaces)
  · agent-cmd · startup-delivery; `notify-relay.ts` (407) → relay-loop(core) · interactive-probe.
- Do it **incrementally, one file per PR**, each with full lifecycle re-test across
  claude/codex/opencode (these are the #278/#360/#2/#3 code paths).

## Validation gates (full battery; daemon-boot + tarball weighted)

1. **Boundary grep** — zero `packages/*/src/` imports into `src/`/cli (re-confirm post-move it's
   the apex). `packages/cli/src` may import any `@cockpit/*`.
2. **TS project-reference compile** (`tsc -b --force` shared→core→agents→workspaces→web→cli) +
   **tsup bundle**; both `dist/index.js` and `dist/cockpitd.js` emit.
3. **ESM gate** — `node dist/index.js --help`, `node dist/index.js config`, `node dist/index.js
   dashboard --once` all run (the NodeNext `.js` + path-lookup gate, not just `tsc`).
4. **Clean-room frozen-lockfile install.**
5. **Socket-safe daemon boot (HEAVY)** — boot the rebuilt `dist/cockpitd.js` via temp socket
   (`rotationIntervalMs: 0`, `sweepMs: 0`); assert bind + a `health`/`list` round-trip; tear down.
   Plus `launchd.test.ts` green (plist path unchanged).
6. **Full test suite** — pass bar = exactly the 3 `relay-proxy.test.ts` #353 failures, nothing
   new. `pnpm build` (tsc) THEN the suite — never vitest alone.
7. **Tarball gate (HEAVY)** — `pnpm pack` (capture absolute filename first), install isolated,
   run `cockpit --help` + `cockpit dashboard --once` (inlined web) + a runtime-sync op.
8. **Legacy layout deleted** — `src/` no longer exists; `git status` clean.

## PR shape & workflow

Single PR `crew/reorg-7-cli`, isolated worktree, one **claude/sonnet** crew using
`/gsd:plan-phase` + `/gsd:execute-phase`. Captain reviews with the full gate battery (daemon-boot
+ tarball weighted), squash-merges `--admin`, rebases any unpushed spec/plan docs onto the merge,
realigns develop, prunes worktree/branch. Rebuild live `dist/`. **This completes the monorepo
reorganization** (6 packages; legacy `src/` gone).

## Success criteria

- `packages/cli` exists with `package.json` + `README.md`; depends on the five sibling packages.
- `src/` no longer exists; all its modules live under `packages/cli/src/` (and `config.test.ts`
  under `packages/shared`).
- tsup entries point into `packages/cli/src`; `dist/index.js` + `dist/cockpitd.js` outputs and the
  launchd plist are unchanged; runtime path lookups untouched and still resolve.
- `@cockpit/web` inlined consistently in tsup with the other four packages.
- A GH issue tracks the deferred thin-wrapper refactor.
- All eight gates pass incl. daemon-boot + tarball; merge realigns develop with zero new failures.
- The six-package monorepo reorganization is **complete**.
