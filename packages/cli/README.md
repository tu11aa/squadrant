# @cockpit/cli

**Purpose:** The `cockpit` bin entry, launchd daemon host, and full CLI command surface.

## Owns

- `src/index.ts` — bin entry (compiled by tsup to `dist/index.js`)
- `src/commands/` — 29 CLI commands (captain, crew, config, launch, relay, etc.)
- `src/control/cockpitd.ts` — daemon-host entry (compiled by tsup to `dist/cockpitd.js`)
- `src/control/{crew-routing,relay-supervisor,relay-supervisor-loop,relay-log-broadcaster}.ts` — cli-side control plane
- `src/lib/per-crew-settings.ts` — per-crew settings helper

## Depends on

All five sibling packages: `@cockpit/shared`, `@cockpit/core`, `@cockpit/agents`, `@cockpit/workspaces`, `@cockpit/web`.

## Does NOT belong here

Orchestration logic that should live in `@cockpit/core` or `@cockpit/agents` — see the deferred thin-wrapper refactor issue (#367). Commands should be thin: parse args → call package function → format output.

## Notes

- `@cockpit/cli` is the DAG apex: it may import any `@cockpit/*`; nothing imports it.
- `tsc -b` output is for typecheck/DAG enforcement only. The actual runtime bundles are produced by `tsup` at the root, which reads entry paths from this package.
- `dist/index.js` and `dist/cockpitd.js` live at the **repo root** `dist/`, not here.
