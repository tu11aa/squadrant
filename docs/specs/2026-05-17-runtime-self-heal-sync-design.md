# Runtime Self-Heal Sync — Design

**Date:** 2026-05-17
**Status:** Approved (design), pending implementation plan

## Problem

`cockpit init` deploys source `plugin/`, `templates/`, `scripts/` into
`~/.config/cockpit/` via `copyDirRecursive` — a **one-shot additive copy**.
The CLI then loads everything from `~/.config/cockpit/` at runtime
(`TEMPLATES_DIR = ~/.config/cockpit/templates`,
`pluginDir = ~/.config/cockpit/plugin`).

Two latent failures, both hit in production on 2026-05-17:

1. **No re-sync trigger.** Source changes (PRs #72/#73 added
   `plugin/.claude-plugin/plugin.json` and deleted `plugin/package.json`)
   never reached `~/.config/cockpit/plugin`. Captains launched with a
   stale plugin dir that had no manifest, so Claude Code loaded **zero**
   cockpit skills — `cockpit:captain-ops`, `plugin:captain-ops`, and
   `captain-ops` all failed.
2. **No prune.** `copyDirRecursive` only copies src→dest; it never
   removes dest entries deleted from src. Re-running `cockpit init` would
   have left the dead `package.json` behind, re-introducing the exact
   drift #73 removed.

A version-number check is **insufficient**: #72/#73 changed source
without bumping the project version (still `0.3.3`), and the dev machine
is npm-linked (`git pull + tsc`, no version bump). The trigger must be
source **content**, not version.

## Goal

When cockpit's source-managed assets change, the runtime copy in
`~/.config/cockpit/` self-heals automatically on the next `cockpit`
invocation — including deletions — without any command to remember and
without clobbering user/runtime state.

Success criteria:

- A source change to `plugin/`, `templates/`, or `scripts/` is reflected
  in `~/.config/cockpit/` before the next command runs, with no manual step.
- A file deleted from a managed source dir is removed from the runtime copy.
- User/runtime state (`config.json`, `sessions.json`, `reactions.json`,
  `spokes/`, `reactor-events/`) is never overwritten or pruned.
- Happy path (no source change) adds negligible latency and is silent.
- Sync failure degrades gracefully: warn, do not block the command.

## Approach

**Cacheless idempotent mirror.** Every `cockpit` invocation mirrors each
managed target (copy-if-different + prune). No fingerprint, no state file.

A fingerprint/state-file design was implemented and rejected during
development: a source-only fingerprint cache **can lie** — if the runtime
dest is incomplete or corrupted while source is unchanged, the cache
reports "synced" and the dest is never reconciled. That reintroduces the
silent-drift bug one level up. Observed in practice: a poisoned
`.sync-state.json` left `templates/` with 2 of 7 files and blocked
self-heal until the state file was manually deleted.

The managed dirs are tiny (dozens of small files); mirroring every run is
sub-10ms, needs no crypto, and **cannot be poisoned** because the dest is
always reconciled to source.

## Components

### 1. `copyIfDifferent(src, dest)` — idempotent file copy

- Copy `src` → `dest` only if `dest` is missing or its **bytes differ**
  (content comparison, not size+mtime — a same-size edit is always
  detected, and an unchanged file is never rewritten ⇒ no mtime churn).
- Returns whether a copy happened (drives `chmod`).

### 1b. `mirrorDir(src, dest)` — recursive mirror

Replaces additive `copyDirRecursive` for managed dirs:

- Recursively `copyIfDifferent` every file.
- **Prune:** delete dest entries (files and dirs) absent from src.
- Used for `mode: "tree"` targets (currently `plugin`).

### 1c. `mirrorFlat(src, dest, match, chmod?)` — filtered flat sync

For `mode: "flat"` targets where the runtime dir is a flat set of files
copied from a differently-named, possibly mixed source dir:

- `copyIfDifferent` only top-level files whose name matches `match`.
- **Prune:** remove `dest` files whose name is not in the matched set.
- Apply `chmod` to freshly copied files when specified (scripts → `0o755`).

### 1d. Managed-target descriptors

The source→runtime mapping is **not** same-name full-tree (discovered
during implementation from `init.ts`):

```ts
MANAGED_TARGETS = [
  { name: "plugin",    srcRel: "plugin",       mode: "tree" },
  { name: "scripts",   srcRel: "scripts",      mode: "flat",
    match: /\.sh$/,                              chmod: 0o755 },
  { name: "templates", srcRel: "orchestrator", mode: "flat",
    match: /\.(claude\.md|generic\.md|CLAUDE\.md)$/ },
]
```

`name` = runtime dir under `~/.config/cockpit/`. `srcRel` = source dir
relative to package root. Note `templates` ← `orchestrator/`.

### 2. `ensureRuntimeSynced()` — self-heal gate

Called once at CLI entry (`src/index.ts`) before command dispatch, and
reused by `cockpit init` (one code path; no divergence).

- Resolve source root via package root (the dir containing the installed
  `package.json`).
- For each `MANAGED_TARGETS` entry: if its source dir exists, run
  `mirrorDir` (tree) or `mirrorFlat` (flat). Unconditional — idempotent
  copy-if-different makes the no-change case cheap and silent.
- No fingerprint, no state file, no skip logic — the dest is always
  reconciled, so nothing can claim "synced" while it is not.
- On any per-target error (source missing, FS error): write a one-line
  warning to stderr and continue — the command must still run. Never
  throws.

### 3. No state file

Deliberately none. The earlier `.sync-state.json` cache was removed
because it could report "synced" over an incomplete dest. Any leftover
`.sync-state.json` from the old design is inert (never read or written)
and safe to delete.

## Hard Boundary

The sync touches **only** the runtime dirs named in `MANAGED_TARGETS`
(`plugin/`, `scripts/`, `templates/`). It must never write or prune
`config.json`, `sessions.json`, `reactions.json`, `spokes/`,
`reactor-events/`, or any other `~/.config/cockpit` entry. Pruning is
scoped per managed target — never at the `~/.config/cockpit` root. The
user's hub vault (scaffolded by `init`) is **not** a managed target and
is never pruned.

## Data Flow

```
cockpit <cmd>
  -> ensureRuntimeSynced()
       -> for t in MANAGED_TARGETS:                 # plugin, scripts, templates
            if exists(sourceRoot/t.srcRel):
                 t.mode == "tree"  ? mirrorDir(srcDir, runtime/t.name)
                 t.mode == "flat"  ? mirrorFlat(srcDir, runtime/t.name, t.match, t.chmod)
  -> dispatch command
```

## Error Handling

- Managed source dir missing → skip that target, continue command.
- FS error during mirror → warn with the target name, leave runtime as-is
  for that target (last-known-good), continue command.
- Never throw out of `ensureRuntimeSynced`; the CLI must remain usable.

## Testing

`mirrorDir` (tree targets):
- copies a new file
- overwrites a changed file
- **prunes a file deleted from src**
- **prunes a dir deleted from src**
- mirrors nested dirs including dotfiles (`.claude-plugin/`)
- **idempotent** — an unchanged file is not rewritten (no mtime churn)

`mirrorFlat` (flat filtered targets):
- copies only files matching `match`, ignores non-matching
- **prunes a dest file no longer in the matched set**
- applies `chmod` to copied files when specified
- **idempotent** — an unchanged matched file is not rewritten

`ensureRuntimeSynced`:
- syncs all managed targets (filtering + chmod per descriptor)
- idempotent: unchanged source ⇒ no runtime files rewritten
- **self-heals an incomplete dest even when source is unchanged**
  (the core property — proves no cache can lie)
- writes no `.sync-state.json`
- never touches user-state files (`config.json` etc.) even when present
  in the runtime dir
- missing source dir → command proceeds (no throw)

## Out of Scope (YAGNI)

- No config flags / `--no-sync` escape hatch unless a concrete need arises.
- No syncing of assets beyond the three managed dirs.
- No background watcher — the per-invocation check is sufficient and
  matches the "self-improving, prompted-at-key-moments" model.
