# Design: Monorepo reorganization of claude-cockpit

> **✅ Shipped** (PR #352–368 (all 7 reorg steps), 2026-06-17). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-06-17
**Status:** Design — pending user spec-review, then writing-plans
**Author:** captain (cockpit) + user

## Goal

The current `src/` layout is flat and mixes concerns; agent-specific code is scattered
across three folders; there are three top-level code dirs (`src/`, `core/`, `orchestrator/`)
with confusing names. Reorganize the repo into a **workspaces monorepo** with clear,
one-way package boundaries, split oversized/mixed files by responsibility, and add a
short `README.md` to each package describing what it owns.

This serves cockpit's north-star — a reusable **multi-agent, multi-surface orchestration
layer**, not a single tangled CLI.

## Current state (the mess, with evidence)

- **Three top-level code dirs:** `src/`, `core/` (2 stale files, untouched since
  2026-03-30 — dead), `orchestrator/` (9 role-template `.md`s — *actively used* via
  `canonical-source.ts`/`runtime-sync.ts`, but misnamed: it is templates, not orchestration).
- **Agent code scattered across 3 places:** `src/drivers/` (agent metadata), `src/runtimes/`
  (session drivers, e.g. `cmux.ts`), `src/control/{codex,opencode,headless,interactive}/`
  (daemon-side integration). Touching "how Codex works" means editing 3+ folders.
- **`src/commands/`** — 28 flat files mixing crew / relay / lifecycle / diagnostics, with
  orchestration logic baked into the command files instead of thin wrappers.
- **`src/control/`** — 18 top-level files mixing daemon-core + delivery + 6 driver
  subpackages + relay (the 486-file `codex/protocol/v2` is vendored, excluded from all counts).
- **Oversized files:** `cockpitd.ts` 1008, `crew.ts` 804, `dashboard/web-render.ts` 737,
  `runtimes/cmux.ts` 532, `daemon.ts` 503, `launch.ts` 446, `notify-relay.ts` 407.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Scope | `src/` reorg **+ top-level cleanup** (remove `core/`, rename `orchestrator/`) |
| File splitting | **Thorough by-concern** (every file that mixes responsibilities), with an anti-over-fragmentation guardrail |
| Rollout | **Staged PRs per area**, each leaving build+tests green and the daemon runnable |
| Packaging model | **Monorepo workspaces**, but *internal* (private) packages + single published bin |

### Why internal packages + bundled bin (not full multi-publish monorepo)

For ~16k LOC and a solo maintainer, independently *versioning and publishing* each package
is more ceremony than payoff. Instead:

1. **Internal workspace packages** (`"private": true`) — real `package.json` boundaries,
   not separately published. Only the **root** publishes as `claude-cockpit`, so
   `npx claude-cockpit` is unchanged and there is no cross-package version dance.
2. **Bundle the published bin** (esbuild/tsup) instead of shipping the raw workspace graph.
   This sidesteps the NodeNext `.js`-extension pain *and* the daemon-entrypoint resolution
   problem in one move.
3. **TypeScript project references** so `core` literally cannot import `cli` — the
   architectural boundary is enforced by the compiler, not convention.

This keeps ~95% of the "clean reusable layers" benefit and leaves the door open to publishing
`@cockpit/core` later, without the parts of monorepos that waste solo-dev time.

## Target architecture

### Package topology

```
packages/
  shared/      types · config · pure utils          (no internal deps)
  core/        daemon / control plane + BOTH driver
               interfaces (Agent, Workspace)          → shared
  agents/      claude · codex · opencode · gemini      → core, shared
  workspaces/  cmux driver (then tmux · zed · …)        → core, shared
  web/         dashboard                                → core, shared
  cli/  (bin)  commands (grouped) · composition root    → all of the above
```

### Two pluggable driver seams (the core idea)

cockpit has **two** swap points, both defined as interfaces in `core` and implemented in
their own packages, wired together by the `cli` composition root at startup:

- **Agent drivers** — *which AI*: `claude` / `codex` / `opencode` / `gemini` (`packages/agents`)
- **Workspace drivers** — *which surface the agent runs in*: `cmux` today; `tmux` / `zed` /
  … later (`packages/workspaces`)

`core` never imports a concrete driver or the CLI. Adding `tmux` later = one new folder under
`packages/workspaces/` implementing the interface, **zero changes to core**. This also folds
in #31 (projection) and #333 (native hooks) as *driver-layer* concerns rather than core rewrites.

### Dependency direction (one-way DAG)

```
shared ◄── core ◄── agents ◄──┐
                ◄── workspaces ◄──┤
                ◄── web ◄──────────┤
                                   cli (bin)
```

Enforced by TS project references + (optionally) an eslint boundary rule.

### Module mapping (today → target)

| Today | Target package |
|---|---|
| `lib/`, `config.ts`, `control/types.ts` | `shared` |
| `control/` daemon (`cockpitd`→split, `daemon`, `mailbox`, `delivery`, `protocol`, `state-machine`, `liveness`, `watchdog`, `store`, `snapshot`, `launchd`, `relay-*`), `notifiers/`, `projection/` | `core` |
| `drivers/` + `runtimes/` (AI parts) + `control/{codex,opencode,headless,interactive}/` | `agents` |
| `control/cmux/` + `workspaces/` + `runtimes/cmux.ts` | `workspaces` |
| `dashboard/` | `web` |
| `commands/` (grouped) + `index.ts` | `cli` |

## File splits by concern

### Principle

- **One file = one concern.** ~300 LOC is a *smell signal to investigate*, not a hard cap.
- **CLI commands become thin wrappers** — parse args, call a function in
  `core`/`agents`/`workspaces`, format output. No orchestration logic in command files.
- **Pure logic separates from I/O** — so logic is unit-testable without spawning processes
  (extend the existing `daemon.ts` (core) vs `cockpitd.ts` (host) pattern everywhere).
- **Guardrail — do NOT over-fragment.** The goal is focused files, not 40-line
  single-function files everywhere. Splitting that increases navigation cost without
  improving clarity is a regression. When unsure, keep cohesive helpers together.

### Headline splits (and where the pieces land)

| Today | Split into | Lands in |
|---|---|---|
| `cockpitd.ts` (1008) | `server` · `attach` · `delivery` · `probes` · `drivers` · `gates`, with a thin ~150-LOC composition root building a `DaemonContext` | `core/daemon/` |
| `crew.ts` (804) | naming · discovery(find/list) · first-turn-delivery · completion-protocol · spawn · lifecycle(send/read/close/reap) · `crew` command | logic→`core`/`agents`, wiring→`cli` |
| `web-render.ts` (737) | format · components · sections/{overview,projects,daemon} · render(compose) | `web` |
| `cmux.ts` (532) | exec · parse · screen-classify · driver | `workspaces/cmux/` |
| `launch.ts` (446) | session-freshness · cmux-readiness · agent-cmd · startup-delivery · `launch` command | freshness→`core`, readiness→`workspaces`, wiring→`cli` |
| `notify-relay.ts` (407) | relay-loop · interactive-probe · `notify-relay` command | loop→`core`, wiring→`cli` |

`daemon.ts` (503, clean core, 5 imports) stays as-is — only the *host* file (`cockpitd.ts`)
is decomposed.

"Thorough by-concern" runs **within each area's PR**: when a crew migrates a package it splits
that package's mixed files by this same principle — not only the headline ones above.

## Top-level cleanup

- **Remove the stale top-level `core/`** — 2 stale files, unreferenced by `src/`. Confirm no
  runtime reads before deleting; relocate `settings.json`/`plugins.md` if anything still needs
  them. (Note: this is the legacy top-level `core/` dir — *not* the new `packages/core`, which
  is created fresh in step 4. They are unrelated; the name collision is incidental.)
- **Rename `orchestrator/` → `templates/`** — it holds role-prompt templates
  (`captain.claude.md`, `crew.*.md`, …). Update every `pkgRoot`-relative reader
  (`canonical-source.ts`, `runtime-sync.ts`, and their tests).

## The two landmines (why staged + design-doc-first)

1. **launchd daemon entrypoint.** The daemon runs `dist/control/cockpitd.js` directly;
   packaging relocates that path and its dependency graph. **Mitigation:** the bundled-bin
   approach makes the daemon entrypoint a single self-contained bundle; `launchd.ts` plist
   generation must be updated in lockstep, in the scaffold PR (step 3), before any module moves.
2. **`pkgRoot`-relative reads.** `canonical-source.ts`/`runtime-sync.ts` read `orchestrator/`
   (→`templates/`), `plugin/`, `scripts/` relative to the package root to sync role templates
   into `~/.config/cockpit`. Moving to packages relocates "the root." **Mitigation:** handle in
   the early top-level-cleanup PR (step 2) and re-verify after the scaffold lands.

## README-per-package convention

Each `packages/<name>/README.md`, ≈20–30 lines:

- **Purpose** — one line.
- **Owns** — what lives here.
- **Public interface** — what it exports for other packages.
- **Depends on** — which packages (the DAG, in prose).
- **Doesn't belong here** — the 1–2 things people will wrongly be tempted to add.

## Staged rollout

Each PR leaves the build green, tests green, the **daemon runnable**, and
`npx claude-cockpit` working. READMEs land with each package as it is created.

1. **Design doc** (this) — approve.
2. **Top-level cleanup** — remove stale `core/`, rename `orchestrator/`→`templates/`, update
   `pkgRoot` reads. *Small, independent — de-risks landmine #2 early.*
3. **Monorepo scaffold + extract `shared`** — workspaces config, TS project references,
   esbuild/tsup bundle for bin + daemon entrypoint, CI. *Proves the pipeline on the leaf
   package; fixes landmine #1.*
4. **Extract `core`** — includes the `cockpitd.ts` → `daemon/` split.
5. **Extract `agents` + `workspaces`** — the two driver seams behind their interfaces.
6. **Extract `web`** — dashboard.
7. **`cli` grouping + thin-wrapper refactor** — group the 28 commands, push orchestration
   logic down into core/agents, delete the legacy layout.

## Naming (resolved)

- Surface-driver package: **`packages/workspaces`** (matches existing `PaneRef`/"surface"
  vocabulary). Renameable later.
- AI-driver package: **`packages/agents`**.
- Role templates dir: **`templates/`** (was `orchestrator/`).

## Success criteria

- `packages/{shared,core,agents,workspaces,web,cli}` exist, each with a `README.md` and a
  `package.json`; `core` has no import path back into `cli`/`agents`/`workspaces`/`web`
  (verified by project references / build failure on violation).
- Adding a hypothetical new workspace driver (e.g. `tmux`) requires touching only
  `packages/workspaces` + one wiring line in `cli` — no `core` change.
- No source file meaningfully mixes unrelated concerns; headline files split as above; no
  gratuitous <50-LOC fragments.
- `core/` removed; `orchestrator/` renamed to `templates/` with all readers updated.
- After every staged PR: `npm test` green, daemon boots, `cockpit --help` and the live
  notification path work; published bin still resolves via `npx claude-cockpit`.

## Out of scope

- Independently *publishing* sub-packages to npm (kept internal/private for now).
- Reorganizing `docs/`, `scripts/`, `plugin/` internals (left as-is this round).
- Rewriting `daemon.ts` core logic (only the host file is decomposed).
- Any behavior change — this is a structure/encapsulation refactor; no feature work rides along.
