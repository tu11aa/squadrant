# @cockpit/shared

**Purpose:** Leaf package — pure types, zero-dependency utilities, and config. Depended on by every other package; depends on none.

**Owns:** shared type definitions (control/projection/workspaces), `config.ts`, and side-effect-free helpers (cmux config/probe/bin, compat-manifest, config-drift/version, git-worktree, runtime-sync, canonical-source, vault-layout, daily-logs, resolve-text-input, tool-compat).

**Public interface:** everything re-exported from `src/index.ts` (import via `@cockpit/shared`).

**Depends on:** nothing internal (only npm deps + node built-ins).

**Doesn't belong here:** anything that imports from `core`, `agents`, `workspaces`, `web`, or `cli`; anything that spawns processes or owns daemon/CLI logic. If a util reaches into a domain package, it belongs in that domain, not here.
