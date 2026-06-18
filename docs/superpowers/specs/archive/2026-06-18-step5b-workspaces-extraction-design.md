# Step 5b — Extract `@cockpit/workspaces` (the environment/surface seam)

> **✅ Shipped** (PR #361, 2026-06-18). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-06-18
**Status:** Design — approved for planning
**Part of:** Monorepo reorganization initiative (step 5 of 7) — see
[`2026-06-17-monorepo-reorg-design.md`](2026-06-17-monorepo-reorg-design.md)
**Predecessor:** Step 5a — `@cockpit/agents` extracted (PR #358, develop `91cb8bf`)

## Context

Step 5 extracts the two pluggable driver seams. 5a moved the **AI-driver seam** into
`@cockpit/agents`. 5b moves the **environment / surface seam** into `@cockpit/workspaces` —
the drivers for *where the agent runs and how the human is reached*, as opposed to *which AI*.

Unlike the agent seam (one family: `AgentDriver`), the environment seam is **three driver
families** plus the daemon↔surface bridge:

- **`RuntimeDriver`** (`src/runtimes/`) — the workspace surface where panes/agents spawn (cmux today → tmux/zed later).
- **`WorkspaceDriver`** (`src/workspaces/`) — the knowledge/vault surface (obsidian hub-and-spoke).
- **`NotifierDriver`** (`src/notifiers/`) — how notifications reach the user (cmux today).
- **daemon↔cmux bridge** (`src/control/cmux/`) — `daemon-cmux.ts` + `events-bridge.ts`.

All four are cmux/obsidian-coupled and depend only on interfaces already in
`@cockpit/shared` (`RuntimeDriver`, `WorkspaceDriver`) / local (`NotifierDriver`). Core
references only the *types* — verified: `@cockpit/core` imports zero concrete modules from
these four dirs.

## Why this is the riskier seam

This package owns the **live cmux delivery path**. With `daemonDirectCmux: true`, the daemon
delivers crew lifecycle events straight through the cmux runtime/notifier. A regression here
is not a compile error — it is silent notification loss. Validation therefore weights
**socket-safe daemon boot + a delivery smoke** more heavily than 5a did.

## Goal

`packages/workspaces` exists as a private workspace package containing the cmux runtime
driver, obsidian workspace driver, cmux notifier, and the daemon↔cmux bridge — behind
interfaces that already live in `@cockpit/shared`/`@cockpit/core`. **Zero changes to `core`
or `shared`.** The host (`cockpitd.ts`) and command files import concrete drivers from
`@cockpit/workspaces`. Adding a new surface (tmux/zed) later is a new folder in
`packages/workspaces` + one wiring line — no core change.

## Scope — what moves into `packages/workspaces/src/`

| Source (current) | Role | → `packages/workspaces/src/` |
|---|---|---|
| `src/runtimes/` (cmux, registry, index, types) | RuntimeDriver — cmux pane surface | `runtimes/` |
| `src/workspaces/` (obsidian, registry, index) | WorkspaceDriver — obsidian vault | `workspaces/` |
| `src/notifiers/` (cmux, registry, types, index) | NotifierDriver — cmux notifications | `notifiers/` |
| `src/control/cmux/` (daemon-cmux, events-bridge) | daemon↔cmux bridge | `cmux/` |

`__tests__` directories travel with their modules.

### Decisions (mirroring 5a, by symmetry)

- **Registries stay with the package.** `RuntimeRegistry`, `WorkspaceRegistry`,
  `NotifierRegistry` are generic selection logic (`Record<name, factory>`, pick-by-config),
  exactly as `@cockpit/agents` kept `CapabilityRegistry` / `ProjectionRegistry`. Core owns
  only interfaces, not registries.
- **Keep subdir names on the move** (minimum-diff). Internal `./` imports stay valid — the
  5a lesson (all cross-dir refs are within-dir, so a dir moved as a unit needs no import
  edits). `packages/workspaces/src/workspaces/` is mildly redundant but harmless; an optional
  rename to `vault/` is deferred to step 7.
- **`runtimes/types.ts` is a pure re-export of `@cockpit/shared`** — it travels as-is (or is
  dropped if no longer referenced; keep it for minimum-diff).
- **Single PR.** No in-root restructure phase — interfaces already live in shared/core; this
  is a straight package move like 5a.

### Stays put (becomes `cli`/`web` in steps 6–7)

`src/commands/*`, `src/lib/`, `src/dashboard/`, `src/index.ts`,
`src/control/{cockpitd.ts, crew-routing.ts, relay-*.ts}`. After 5b, `src/` holds only these.

## Dependencies & interface

**Dependency direction** (verified by grep):

```
shared ◄── core ◄── workspaces
              ▲
              └── agents      (sibling; no agents↔workspaces edge — verified both directions)
```

`@cockpit/workspaces` imports only `@cockpit/core`, `@cockpit/shared`, and `node:` builtins.
Zero edges to `@cockpit/agents` or to `cli` (commands/lib/cockpitd). Core imports zero
workspaces modules (only the `RuntimeDriver`/`WorkspaceDriver` *types* from shared).

**Public surface** — `@cockpit/workspaces` exports the concrete drivers + registries the
host/cli wire in:

- `createCmuxDriver` + `RuntimeRegistry`
- `createObsidianDriver` + `WorkspaceRegistry`
- cmux notifier factory + `NotifierRegistry`
- daemon↔cmux bridge factory (`daemon-cmux`, `events-bridge`) consumed by the host

**Wiring repoint** — ~18 consumer files in `src/commands/*` plus `src/control/cockpitd.ts`
change imports from relative (`../runtimes/…`, `../workspaces/…`, `../notifiers/…`,
`../control/cmux/…`) to `@cockpit/workspaces`. Mechanical, no logic change. Re-derive the
exact consumer set during planning with a fresh grep — the 2026-06-18 snapshot is:

```
src/control/cockpitd.ts
src/commands/{status,notify-relay,doctor,init,projection,standup,side,relay,retro,
              crew,notify,shutdown,dashboard,workspace,command,launch,runtime}.ts
```

## Risks & watch-items

- **Live cmux delivery path.** `control/cmux/daemon-cmux.ts` + `events-bridge.ts` are how the
  daemon talks to cmux under `daemonDirectCmux`. The crew must run a **delivery smoke** after
  the move (boot daemon on a temp socket, confirm a crew/lifecycle event projects to the
  surface), not just a compile.
- **Naming collision.** The package is `@cockpit/workspaces` and it contains a
  `workspaces/` subdir (obsidian). This is intentional and harmless; do not "fix" it by
  renaming during the move (that would expand the diff and break consumer deep-imports).
- **`runtimes/types.ts` re-export** — confirm it still re-exports from `@cockpit/shared`
  post-move; do not let it become a dangling relative import.
- **Notifier `NotifierDriver` interface** currently lives in `notifiers/types.ts` (local, not
  shared). It travels with the package. Promote to `@cockpit/shared` only if a consumer
  outside workspaces needs it (none today).

## Validation gates (5a battery + delivery weight)

1. **Boundary grep** (path-anchored) — `packages/workspaces/src` imports only relative,
   `@cockpit/core`, `@cockpit/shared`, `node:`. Zero `@cockpit/agents`, zero cli edges.
2. **TS project-reference compile** (shared → core → workspaces) + **tsup bundle**.
3. **Clean-room frozen-lockfile install.**
4. **Socket-safe daemon boot** — temp socket, `rotationIntervalMs: 0`; daemon binds + serves.
5. **Delivery smoke (NEW, heavier than 5a)** — with the rebuilt daemon, confirm a lifecycle
   event reaches the cmux surface (the `daemonDirectCmux` path the moved bridge owns).
6. **Full test suite** — pass bar = exactly 3 baseline `relay-proxy.test.ts` failures
   (#353), nothing new.
7. **Tarball gate** — pack (absolute path captured first), install isolated, CLI +
   runtime-sync functional.
8. **Build script** — `workspaces` prebuilt in root build script, wired as devDependency.

## PR shape & workflow

Single PR `crew/reorg-5b-workspaces`, isolated worktree, one **claude/sonnet** crew. Crew
uses `/gsd:plan-phase` + `/gsd:execute-phase`. Captain reviews with the gate battery above
(plus the delivery smoke), squash-merges `--admin`, then `git reset --hard origin/develop`.
Update memory + handoff; this **completes step 5** (next: step 6 — `web`).

## Success criteria

- `packages/workspaces` exists with `package.json` + `README.md`; depends on `@cockpit/core`
  + `@cockpit/shared` only.
- `src/runtimes/`, `src/workspaces/`, `src/notifiers/`, `src/control/cmux/` no longer exist
  at the old paths.
- After 5b, `src/` holds only `commands/`, `lib/`, `dashboard/`, `index.ts`,
  `control/{cockpitd,crew-routing,relay-*}` — the future cli/web.
- All eight gates pass, including the delivery smoke; merge realigns develop with zero new
  test failures.
- Step 5 (both driver seams) complete.
