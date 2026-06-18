# Step 6 — Extract `@cockpit/web` (the dashboard / observability surface)

> **✅ Shipped** (PR #366, 2026-06-18). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-06-18
**Status:** Design — approved for planning
**Part of:** Monorepo reorganization initiative (step 6 of 7) — see
[`2026-06-17-monorepo-reorg-design.md`](2026-06-17-monorepo-reorg-design.md)
**Predecessor:** Step 5b — `@cockpit/workspaces` extracted (PR #361, develop `63142e3`),
which completed step 5 (both driver seams).

## Context

After step 5, `packages/` holds `shared · core · agents · workspaces`, and `src/` holds the
future **cli** (`commands/`, `lib/`, `index.ts`, `control/{cockpitd,crew-routing,relay-*}`)
plus the future **web** (`dashboard/`). Step 6 carves `src/dashboard/` out into
`@cockpit/web` — the read-only observability surface (terminal dashboard, hub sync, and the
HTTP+SSE web server with its probe/health rendering). Step 7 then groups the cli and deletes
the legacy layout.

`dashboard/` is a **leaf consumer**, not a driver seam. Unlike `agents`/`workspaces` (which
the daemon wires in), nothing in `core` or the daemon depends on `web`. It reads daemon state
and renders it. This makes step 6 lower-risk than step 5 — there is no live delivery path to
regress — but it has **three outbound edges into `src/commands/`** that must be resolved so
`web` depends only on `core` + `shared`.

## Goal

`packages/web` exists as a private workspace package containing the terminal dashboard
renderer, hub-sync, external/config probes, snapshot merge, and the HTTP+SSE web server +
web-renderer. It imports **only** `@cockpit/core`, `@cockpit/shared`, `node:` builtins, and
`chalk`. The CLI command `src/commands/dashboard.ts` (future cli) imports the dashboard's
public functions from `@cockpit/web` and injects the daemon-call dependency.

## Scope — what moves into `packages/web/src/`

| Source (current) | Role | → `packages/web/src/` |
|---|---|---|
| `src/dashboard/probes.ts` | external (tier-3) + config (tier-4) probes | `probes.ts` |
| `src/dashboard/read-status.ts` | per-project status reader (daemon `list` query) | `read-status.ts` |
| `src/dashboard/render.ts` | terminal dashboard renderer (chalk) | `render.ts` |
| `src/dashboard/snapshot-merge.ts` | merge daemon snapshot + external probes | `snapshot-merge.ts` |
| `src/dashboard/sync-hub.ts` | write status files into the obsidian hub | `sync-hub.ts` |
| `src/dashboard/web-render.ts` | HTML/SSE renderer (42 KB, pure string build) | `web-render.ts` |
| `src/dashboard/web-server.ts` | HTTP + SSE server | `web-server.ts` |
| `src/dashboard/__tests__/` | unit tests | `__tests__/` |

`__tests__` travels with the modules. After the move, `src/dashboard/` no longer exists.

## The three blocking edges and their resolution

The boundary grep found exactly three outbound edges from `dashboard/` into `src/commands/`.
All other dashboard imports are already package-safe (`@cockpit/shared`, `@cockpit/core`
types, `node:`, `chalk`, and internal `./` imports). Resolution — **Inject + relocate**:

### Edge 1 — `read-status.ts:3` → `../commands/crew-control.js` `cockpitdCall` → **INJECT**

`cockpitdCall(req)` is a daemon-client wrapper: it calls core's `sendRequest`, and on failure
runs `ensureDaemon()` + bounded retry (daemon-boot logic). `readAllStatuses` uses it once
(`read-status.ts:48`) to issue `{ kind: "list", project }`.

**Resolution:** make the daemon call an injected dependency, exactly mirroring the dashboard's
existing `defaultProbeRunners` DI pattern (probes already inject their I/O).

- `read-status.ts` defines `type CockpitdCall = (req: unknown) => Promise<unknown>` and
  `readAllStatuses` takes it via options: `readAllStatuses({ config, call }: { config: CockpitConfig; call: CockpitdCall })`.
- The CLI command `src/commands/dashboard.ts` imports `cockpitdCall` from
  `./crew-control.js` (it is already in cli) and passes it: `readAllStatuses({ config, call: cockpitdCall })`.
- `web` never imports daemon-boot logic; it just reads. If the daemon is down, the injected
  call throws and the dashboard reports it — no behavior change for the real CLI path, which
  still injects the retry-capable `cockpitdCall`.
- Tests that call `readAllStatuses` pass a stub `call`.

> The other four `cockpitdCall` consumers (`notify-relay`, `crew-control`, `crew`,
> `shutdown`) are all cli-side and keep importing it from `crew-control.ts` — intra-cli
> imports are allowed. Only the `web` edge is broken, via injection.

### Edge 2 — `web-render.ts:17` → `../commands/heal.js` `healCmdFor` → **RELOCATE to core**

`healCmdFor(c: ComponentHealth): string | null` is a **pure** function (no I/O) that returns a
remediation CLI string for a degraded component. It operates on `ComponentHealth`, a type that
already lives in `packages/core/src/liveness.ts`.

**Resolution:** move `healCmdFor` into `packages/core/src/liveness.ts` (next to
`ComponentHealth`), export it from `@cockpit/core`. `web-render.ts` imports it from
`@cockpit/core`; `src/commands/heal.ts` imports it from `@cockpit/core` (it currently defines
it). This is a cohesion improvement — a `ComponentHealth`-shaped helper belongs with
`ComponentHealth`.

### Edge 3 — `web-render.ts:18` → `../commands/health-view.js` `ageText` → **RELOCATE to core**

`ageText(lastSeenMs: number | null, now: number): string` is a **pure** relative-time
formatter (no chalk, no I/O — chalk in `health-view.ts` is only used by `printServiceHealth`,
which stays in cli).

**Resolution:** move `ageText` into `packages/core/src/liveness.ts`, export from
`@cockpit/core`. Consumers — `web-render.ts` and `src/commands/health-view.ts` — import it
from `@cockpit/core`. (`health-view.ts` keeps `queryHealth`/`printServiceHealth` in cli;
only the pure `ageText` relocates.)

### Core change is small and one-directional

Relocating two pure functions into `liveness.ts` and re-exporting them is the only `core`
edit. It does not touch any daemon hot path, introduces no new dependency in core (both
functions use only language built-ins + the `ComponentHealth` type already there), and the
`tsc -b` project-reference graph still enforces `core ↛ {web, cli}`.

## Dependencies & interface

**Dependency direction** (verified by grep):

```
shared ◄── core ◄── web
              ▲
              ├── agents       (sibling; no agents↔web edge)
              └── workspaces   (sibling; no workspaces↔web edge)

web ◄── cli (src/commands/dashboard.ts)
```

`@cockpit/web` imports only `@cockpit/core`, `@cockpit/shared`, `node:` builtins, and `chalk`.
Zero edges to `@cockpit/agents`, `@cockpit/workspaces`, or cli (`commands/`, `lib/`,
`control/`). Core imports zero web modules.

**Public surface** — `@cockpit/web` exports what the CLI command wires in:

- `readAllStatuses` (+ its `CockpitdCall` type) and `DashboardState`/`ProjectStatus` types
- `renderDashboard`
- `syncHub` (+ `SyncHubResult`)
- `startWebServer`
- `defaultProbeRunners` (+ probe types if consumed)

**Wiring repoint** — the consumers that change imports from relative to `@cockpit/web`:

```
src/commands/dashboard.ts            # 5 imports: ../dashboard/{read-status,render,sync-hub,web-server,probes}
src/commands/__tests__/dashboard.test.ts   # if it deep-imports dashboard
```

Plus the two relocations' repoints inside cli:
```
src/commands/heal.ts          # healCmdFor: local def → import from @cockpit/core
src/commands/health-view.ts   # ageText: local def → import from @cockpit/core
```
`src/index.ts` is unchanged (it imports `dashboardCommand` from `./commands/dashboard`, not
from `dashboard/`).

Re-derive the exact consumer set with a fresh grep during planning — the snapshot above is
2026-06-18.

## Risks & watch-items

- **No live-delivery path.** Unlike 5b, `web` is read-only; a regression is a render bug, not
  silent notification loss. The heavy gate here is the **web-server smoke** (boot the server on
  a temp port against a temp-socket daemon, confirm it serves HTML + an SSE frame), not a
  delivery smoke.
- **Injection must not change CLI behavior.** The real `cockpitdCall` (with `ensureDaemon` +
  retry) must still be what `src/commands/dashboard.ts` injects, so the live dashboard keeps
  its daemon-boot resilience. Verify the injected path, not just the stubbed test path.
- **`web-render.ts` is 42 KB.** It is pure string rendering; do not refactor it during the
  move (minimum-diff, 5a/5b discipline). Only its two import lines change.
- **Relocated pure functions** — confirm `healCmdFor`/`ageText` behavior is byte-identical
  after the move (the existing dashboard `web-render` tests + any heal/health-view tests are
  the guard). Do not "improve" them.
- **`read-status.ts` test** — it must now construct `readAllStatuses` with an injected `call`
  stub; update the existing test to pass one rather than mocking the module.

## Validation gates (5b battery, web-server smoke replaces delivery smoke)

1. **Boundary grep** (path-anchored) — `packages/web/src` imports only relative,
   `@cockpit/core`, `@cockpit/shared`, `node:`, `chalk`. Zero `@cockpit/agents`,
   `@cockpit/workspaces`, zero cli edges (`../commands`, `../lib`, `../control`).
2. **TS project-reference compile** (shared → core → web) + **tsup bundle**. `node dist/index.js --help`
   runs (the ESM/NodeNext `.js`-extension gate — not just `tsc`).
3. **Clean-room frozen-lockfile install.**
4. **Socket-safe daemon boot** — temp socket, `rotationIntervalMs: 0`, `sweepMs: 0`; daemon
   binds + serves. NEVER run `node dist/cockpitd.js` against the real socket (#360 trap).
5. **Web-server smoke (NEW, replaces 5b delivery smoke)** — boot `startWebServer` on a temp
   port pointed at a temp-socket daemon; assert it returns HTML on `/` and emits at least one
   SSE frame on the events endpoint, then tear down. Confirms the moved web-server + probes +
   injection path works end-to-end.
6. **Full test suite** — pass bar = exactly the 3 baseline `relay-proxy.test.ts` failures
   (#353), nothing new. Run via `pnpm build` (tsc) **then** the suite; do not trust vitest
   alone (typecheck gap lesson from #362).
7. **Tarball gate** — `pnpm pack` (capture the printed filename as an absolute path *before*
   cd-ing), install isolated, CLI + `cockpit dashboard --once` + runtime-sync functional.
8. **Build script** — `web` prebuilt in the root build script
   (`tsc -b --force packages/shared packages/core … packages/web`) and wired as a
   **devDependency** (bundled by tsup, not a runtime dep — publish-safety).

## PR shape & workflow

Single PR `crew/reorg-6-web`, isolated worktree, one **claude/sonnet** crew. Crew uses
`/gsd:plan-phase` + `/gsd:execute-phase`. Captain reviews with the full gate battery (incl.
the web-server smoke), squash-merges `--admin`, then `git reset --hard origin/develop` and
prunes the worktree/branch. Update memory + handoff. After step 6, only step 7 remains (cli
grouping + delete legacy layout).

## Success criteria

- `packages/web` exists with `package.json` + `README.md`; depends on `@cockpit/core` +
  `@cockpit/shared` only.
- `src/dashboard/` no longer exists; its modules live under `packages/web/src/`.
- The three blocking edges are resolved: `cockpitdCall` injected into `readAllStatuses`;
  `healCmdFor` + `ageText` relocated to `@cockpit/core` (and `heal.ts`/`health-view.ts`
  repointed to import them from core).
- After step 6, `src/` holds only `commands/`, `lib/`, `index.ts`,
  `control/{cockpitd,crew-routing,relay-*}` — the future cli (step 7).
- All eight gates pass, including the web-server smoke; merge realigns develop with zero new
  test failures.
