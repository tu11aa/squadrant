# @squadrant/cli

**Purpose:** The `squadrant` bin entry, launchd daemon host, and full CLI command surface.

## Owns

- `src/index.ts` — bin entry (compiled by tsup to `dist/index.js`)
- `src/commands/` — 22 top-level CLI commands (crew, config, launch, effort, etc.)
- `src/control/squadrantd.ts` — daemon-host entry (compiled by tsup to `dist/squadrantd.js`)
- `src/control/crew-routing.ts` — cli-side control plane
- `src/lib/per-crew-settings.ts` — per-crew settings helper

## Depends on

All five sibling packages: `@squadrant/shared`, `@squadrant/core`, `@squadrant/agents`, `@squadrant/workspaces`, `@squadrant/web`.

## Does NOT belong here

Orchestration logic that should live in `@squadrant/core` or `@squadrant/agents` — see the deferred thin-wrapper refactor issue (#367). Commands should be thin: parse args → call package function → format output.

## Notes

- `@squadrant/cli` is the DAG apex: it may import any `@squadrant/*`; nothing imports it.
- `tsc -b` output is for typecheck/DAG enforcement only. The actual runtime bundles are produced by `tsup` at the root, which reads entry paths from this package.
- `dist/index.js` and `dist/squadrantd.js` live at the **repo root** `dist/`, not here.
