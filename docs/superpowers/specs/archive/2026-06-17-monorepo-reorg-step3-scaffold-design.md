# Design: Monorepo reorg — Step 3 (scaffold + extract `shared`)

> **✅ Shipped** (PR #356, 2026-06-17). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-06-17
**Status:** Design — approved in brainstorming; pending spec-review → writing-plans
**Parent spec:** `docs/superpowers/specs/2026-06-17-monorepo-reorg-design.md` (rollout step 3)

## Goal

Convert claude-cockpit from a single `tsc`-built package into a **pnpm workspaces monorepo**,
introduce a **tsup bundle** for both runnable entrypoints (CLI + daemon), and extract the leaf
**`@cockpit/shared`** package (pure types + zero-dep utilities + config). This proves the entire
build/publish pipeline on the safest package before any domain code (core/agents/web) moves, and
establishes the bundled entrypoints so the step-4 daemon move has no entrypoint surprises
(parent-spec landmine #1).

No behavior change. This is structure + build-tooling only.

## Decisions (locked in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Workspace manager | **pnpm workspaces** | User's stack default; fine for publish because sub-packages are private+bundled (no `workspace:*`-rewrite concern). |
| Bundler | **tsup** (esbuild wrapper) | Zero-config multi-entry + `.d.ts` + watch; less hand-rolled config than raw esbuild. |
| Bundle scope | **Both entrypoints now** — CLI (`src/index.ts`) and daemon (`src/control/cockpitd.ts`) | Establishes the full publish pipeline before the daemon physically moves in step 4. |
| `shared` contents | pure types + leaf utils + config | True leaf, zero internal deps — safest first extraction. |
| Transitional layout | **root-as-package** | Root `claude-cockpit` keeps `src/` (everything not yet extracted) + `bin`, depends on `@cockpit/shared`; later steps carve more out; `src/` deleted at step 7. Keeps each step a minimal diff. |
| Boundary enforcement | **TS project references** | Compiler refuses `shared`→root back-imports. |

## Why a bundler is required (not just dev-nicety)

Sub-packages are **private** (not published to npm). Local dev resolves `@cockpit/shared` via
pnpm's `node_modules` symlinks + project references — fine. But the published `claude-cockpit`
artifact cannot resolve a private package on an end-user's machine. The tsup bundle **inlines**
`@cockpit/shared` (and future packages) into self-contained `dist/index.js` (CLI) and
`dist/cockpitd.js` (daemon), so `npx claude-cockpit` and the launchd daemon keep working with no
runtime resolution. The bundle is fundamentally a **publish + daemon-entrypoint** concern.

## Architecture after step 3

```
claude-cockpit/                 (workspace root + transitional "everything-else" package)
  pnpm-workspace.yaml           packages: ['packages/*']
  package.json                  name: claude-cockpit, bin -> dist/index.js,
                                deps: @cockpit/shared (workspace:*), build: tsup
  tsup.config.ts                entry: src/index.ts, src/control/cockpitd.ts
  tsconfig.json                 references: [packages/shared]
  src/                          everything NOT yet extracted (commands/, control/,
                                dashboard/, runtimes/, drivers/, notifiers/, projection/,
                                workspaces/, index.ts, per-crew-settings.ts)
  packages/
    shared/
      package.json              name: @cockpit/shared, private: true, exports -> dist
      tsconfig.json             composite: true
      README.md
      src/                      config.ts, types (control/projection/workspaces),
                                ~13 leaf lib/ files
  dist/
    index.js                    bundled CLI (bin)
    cockpitd.js                 bundled daemon (launchd target)
```

### `@cockpit/shared` exact contents

- `config.ts` (from `src/config.ts`)
- `types/control.ts`, `types/projection.ts`, `types/workspaces.ts`
  (from `src/control/types.ts`, `src/projection/types.ts`, `src/workspaces/types.ts`)
- Leaf `lib/` modules: `cmux-autoconfig`, `cmux-bin`, `cmux-config`, `cmux-probe`,
  `compat-manifest`, `config-drift`, `config-version`, `git-worktree`, `resolve-text-input`,
  `runtime-sync`, `tool-compat`, plus `canonical-source`, `daily-logs`, `vault-layout`
  (the last three only coupled via the type modules above, which now live here → they become
  clean).

### Excluded from `shared` (migrates later)

- `src/lib/per-crew-settings.ts` — couples to `control/interactive/claude` *logic* (not types).
  Stays in root `src/lib/`; moves with `agents` in a later step.

### Import repointing

~22 sites import the three moved type modules (`control/types` ×16, `workspaces/types` ×5,
`projection/types` ×1) plus the leaf-lib consumers. All repoint to `@cockpit/shared` (bare
specifier — no `.js` extension needed across the package boundary, which also *reduces*
NodeNext friction).

## Build, dev, CI, release

- **Build:** `tsup` (root) bundles the two entrypoints, inlining `@cockpit/shared`. `packages/shared`
  builds its own `dist` (composite) for type-checking + dev symlink resolution.
- **Dev:** `tsup --watch`; pnpm workspace symlinks resolve `@cockpit/shared`.
- **Type-check:** `tsc -b` (project references) replaces `tsc --noEmit` for `lint`.
- **CI (`ci.yml`):** swap `npm ci` → `pnpm i --frozen-lockfile`; add `pnpm/action-setup`; keep
  build + test steps (now `pnpm build`, `pnpm test`).
- **Release (`release.yml`):** swap npm→pnpm install/build; confirm the npm publish step still
  authenticates (pnpm reads `NODE_AUTH_TOKEN`/`.npmrc` the same way). Published package = root
  only; bundled `dist/` ships; private `packages/*` are not separately published.
- **`.gitignore`/publish:** still no `files` allowlist needed — root publishes `dist/` + `templates/`
  + `plugin/` + `scripts/` as today; `packages/*/src` are dev-only and harmless if shipped, but
  prefer adding a `files` allowlist to ship only `dist/` + the runtime-synced dirs (optional tidy).

## Landmines & mitigations (step-3 specific)

1. **launchd daemon entrypoint** — currently `dist/control/cockpitd.js`; after tsup it's
   `dist/cockpitd.js`. `src/control/launchd.ts` plist generation MUST be updated to the new path,
   and any live installed plist regenerated on next `cockpit launch`. Verify the bundled daemon
   actually boots (`node dist/cockpitd.js` starts + serves the socket) before merge.
2. **`pkgRoot`-relative reads** — `canonical-source.ts`/`runtime-sync.ts` move into `@cockpit/shared`
   but still compute paths relative to the *package root*. After bundling, `import.meta.url`/`__dirname`
   resolves to the bundle location (`dist/`), not the repo root. The pkgRoot derivation must be
   re-verified against the bundled layout (it reads `templates/`, `plugin/`, `scripts/` relative to
   the published package root = where `dist/` sits). This is the highest-risk item — test
   `runtime-sync` end-to-end against a packed tarball (`npm pack` / `pnpm pack` then run).
3. **vitest + workspaces** — ensure vitest resolves `@cockpit/shared` (via the workspace symlink or a
   vitest alias). Add a root vitest config covering both root `src` and `packages/*` if needed.

## Success criteria

- `pnpm i` clean; `pnpm build` produces self-contained `dist/index.js` + `dist/cockpitd.js`.
- `node dist/index.js --help` prints usage; `node dist/cockpitd.js` boots the daemon + socket.
- `pnpm test` green (same pass set as before, minus the known pre-existing #353 relay-proxy flakes).
- `tsc -b` passes; `@cockpit/shared` cannot import from root `src/` (project-reference enforced).
- A packed tarball (`pnpm pack`) installs and runs `cockpit --help` + completes a `runtime-sync`
  (templates/plugin/scripts land in `~/.config/cockpit`) — proving pkgRoot reads survive bundling.
- `packages/shared/README.md` present (Purpose/Owns/Public interface/Depends on/Doesn't belong here).
- CI + release workflows run on pnpm and pass.

## Out of scope

- Moving `core`/`agents`/`workspaces`/`web` (steps 4–6).
- The `cockpitd.ts` internal split (step 4).
- `per-crew-settings.ts` extraction (later, with `agents`).
- Separately publishing any `@cockpit/*` package.
