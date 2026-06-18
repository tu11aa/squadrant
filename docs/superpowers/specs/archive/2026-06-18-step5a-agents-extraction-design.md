# Step 5a — Extract `@cockpit/agents` (the AI-driver seam)

> **✅ Shipped** (PR #358, 2026-06-18). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-06-18
**Status:** Design — approved for planning
**Part of:** Monorepo reorganization initiative (step 5 of 7) — see
[`2026-06-17-monorepo-reorg-design.md`](2026-06-17-monorepo-reorg-design.md)
**Predecessors:** #352 (top-level cleanup), #355 (pnpm + tsup + `@cockpit/shared`),
#356 (cockpitd → host + `daemon/*`), #357 (`@cockpit/core` extracted)

## Context

The monorepo reorg has extracted `@cockpit/shared` and `@cockpit/core` and split the
daemon host. Step 5 extracts the **two pluggable driver seams** that are the core idea of
the whole reorg:

- **`packages/agents`** — *which AI*: claude / codex / opencode / gemini
- **`packages/workspaces`** — *which surface*: cmux (then tmux / zed / …)

Per decision, step 5 is sequenced **5a agents first, then 5b workspaces** (agents has the
lower blast radius — AI drivers, no live-daemon surface delivery path). This spec covers
**5a only**. Step 5b (workspaces) gets its own brainstorm once 5a lands, because its exact
shape — especially the `runtimes/` split — is better informed after 5a.

The interfaces both seams implement (`AgentDriver`, `OpencodeBridge`, `CmuxEventsBridge`,
`DaemonSurfaceDriver`) **already live in core** (`interfaces.ts`). 5a is therefore a
package *move* of the concrete agent-driver implementations behind interfaces that already
exist — not new abstraction work.

## Goal

`packages/agents` exists as a private workspace package containing every AI-agent-specific
driver, control, and projection module. The host (`cockpitd.ts`) and command files import
the concrete drivers from `@cockpit/agents` instead of relative paths. **Zero changes to
`core`.** Adding a new AI agent later means a new file in `packages/agents` plus one wiring
line — no core edit.

## Scope — what moves into `packages/agents/src/`

| Source (current) | Role | → `packages/agents/src/` |
|---|---|---|
| `src/drivers/` (claude, codex, gemini, opencode, registry, types, index) | **AgentDriver** — which AI, builds the command line | `drivers/` |
| `src/control/codex/` (app-server-client, protocol/, driver, normalize, config) | Codex interactive control (app-server JSON-RPC) | `codex/` |
| `src/control/opencode/` (sse-bridge) | Opencode SSE lifecycle bridge | `opencode/` |
| `src/control/interactive/` (claude, pane-classifier, registry, types) | Interactive agent control | `interactive/` |
| `src/control/headless/` (claude, codex, opencode, registry, types) | Headless agent launchers | `headless/` |
| `src/control/headless-launcher.ts` | Headless spawn orchestration | `headless-launcher.ts` |
| `src/projection/` (codex, opencode, gemini, cursor emitters + registry, marker, index) | Project agent state → external formats | `projection/` |

`__tests__` directories travel with their modules.

### Explicitly deferred to 5b (workspaces)

- `src/runtimes/` — `RuntimeDriver`/`RuntimeRegistry` is **surface** orchestration (spawning
  panes), not AI. `runtimes/cmux.ts` is mapped to workspaces by the master spec (line 105).
  The master spec's "runtimes (AI parts) → agents" phrasing (line 104) is loose: there are
  no AI parts in `runtimes/`. `runtimes/registry.ts` (generic RuntimeDriver selection) goes
  to core-or-workspaces; `runtimes/types.ts` is already in `@cockpit/shared`;
  `runtimes/index.ts` is a barrel that becomes host/cli wiring. All of this is a **5b**
  decision, not 5a.
- `src/control/cmux/` (daemon-cmux, events-bridge), `src/workspaces/`, `src/notifiers/cmux.ts`.

### Stays put (not part of step 5)

- `src/control/cockpitd.ts` — host / bin / launchd entry. **Filename never moves** across any
  reorg step (landmine #1 stays dormant: `dist/cockpitd.js` + plist + tsup entry are fixed).
- `src/control/crew-routing.ts`, `src/control/relay-*.ts`.
- All `src/commands/*` — these become the `cli` package in step 7.

## Dependencies & interface

**Dependency direction** (matches master-spec graph, verified by grep):

```
shared ◄── core ◄── agents
```

`@cockpit/agents` imports only `@cockpit/core`, `@cockpit/shared`, and `node:` builtins.
**Zero edges to workspaces** — verified: none of the 5a-candidate dirs import any
cmux / workspaces / notifiers module. TypeScript project references enforce the boundary at
compile time; the boundary-grep gate (from 4b) is the runtime backstop.

**Public surface** — `@cockpit/agents` exports the concrete drivers + factories that the
host/cli wire into the registries that already live in core:

- AgentDriver implementations + agent registry factory (claude / codex / gemini / opencode)
- Interactive + headless control factories (codex app-server client, opencode SSE bridge,
  interactive + headless registries)
- ProjectionRegistry emitter factories (codex / opencode / gemini / cursor)

The interfaces (`AgentDriver`, `OpencodeBridge`, etc.) already live in core's
`interfaces.ts`. Agents *implements* them; nothing new is added to core.

**Wiring repoint** — the consumer files change their imports from relative
(`../drivers/…`, `../control/{codex,opencode,interactive,headless}/…`,
`../control/headless-launcher.js`, `../projection/…`) to `@cockpit/agents`. Mechanical, no
logic change. Known consumers:

```
src/control/cockpitd.ts
src/commands/notify-relay.ts
src/commands/crew.ts
src/commands/crew-control.ts
src/commands/launch.ts
src/commands/side.ts
src/commands/command.ts
src/commands/doctor.ts
src/commands/projection.ts
src/commands/codex-chat-smoke.ts
src/lib/per-crew-settings.ts
```

(Re-derive the exact consumer set during planning with a fresh grep — the list above is the
2026-06-18 snapshot.)

## Risks & watch-items

- **`control/interactive/pane-classifier.ts`** classifies cmux pane content. Verified it
  imports no cmux module today (uses `PaneRef` from `@cockpit/shared`). The crew must
  re-confirm post-move; if a hidden edge surfaces, **relocate the offending type to shared**
  (the 4b pattern) — do not invert the dependency.
- **`projection/marker.ts`** is a pure text helper used only by the emitters. It travels
  with `projection/` into agents. Promote to `@cockpit/shared` only if a consumer outside
  agents appears.
- **`headless-launcher.ts`** spawns processes — re-confirm it pulls config/types from
  `@cockpit/shared`/`@cockpit/core`, not from a workspaces module.
- **Single-PR step.** Unlike step 4 (split 4a restructure-in-root / 4b package move), agents
  has no in-root restructure phase — it is a straight package move behind interfaces that
  already exist. Lower risk than step 4; no 5a-i / 5a-ii split needed.

## Validation gates (same battery as 4a/4b)

1. **Boundary grep** — `packages/agents/src` imports only relative paths, `@cockpit/core`,
   `@cockpit/shared`, `node:`. Zero cmux/workspaces/notifiers. (Use a path-anchored regex —
   the 4b false positive came from matching the `interactive` substring in a filename.)
2. **TS project-reference compile** (shared → core → agents) + **tsup bundle** produces ESM
   output.
3. **Clean-room frozen-lockfile install** (`pnpm install --frozen-lockfile`).
4. **Socket-safe daemon boot** — override socket path with a temp value, `rotationIntervalMs: 0`;
   confirm the daemon binds and serves.
5. **Full test suite** — pass bar = **exactly 3 baseline relay-proxy failures (#353)**,
   nothing new. Any other failure blocks the merge.
6. **Tarball gate** — `pnpm pack` (capture absolute path *before* any `cd`), install in an
   isolated dir, confirm CLI + runtime-sync functional.
7. **Build script** — new `agents` package is prebuilt in the root build script and wired as
   a devDependency where consumed.

## PR shape & workflow

- Single PR on branch `crew/reorg-5a-agents`, isolated worktree, one **claude/sonnet** crew.
- Crew uses `/gsd:plan-phase` + `/gsd:execute-phase` if the move benefits from wave-based
  execution (multi-dir move + ~11 import repoints qualifies).
- Captain reviews with the full gate battery above, squash-merges with `--admin`, then
  `git reset --hard origin/develop` to realign local.
- Update project memory (`project_2026_06_17_monorepo_reorg_initiative.md`) + MEMORY.md;
  write handoff; queue 5b (workspaces) brainstorm.

## Success criteria

- `packages/agents` exists with `package.json` + `README.md`; depends on `@cockpit/core` +
  `@cockpit/shared` only.
- `src/drivers/`, `src/control/{codex,opencode,interactive,headless}/`,
  `src/control/headless-launcher.ts`, `src/projection/` no longer exist at the old paths;
  their content lives in `packages/agents/src`.
- Adding a hypothetical new AI agent touches only `packages/agents` + one wiring line — no
  core edit. (Demonstrated by the structure, not necessarily exercised.)
- All seven validation gates pass; merge realigns develop with zero new test failures.
