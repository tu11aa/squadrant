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

**Source-fingerprint self-heal** (chosen over version-stamp, which misses
same-version changes, and over mtime-watermark, which is marginally less
robust under clock skew / file restores).

## Components

### 1. `mirrorDir(src, dest)` — mirroring sync helper

Replaces additive `copyDirRecursive` for managed dirs:

- Recursively copy files that are new or changed (size or mtime differs).
- **Prune:** delete dest entries (files and dirs) absent from src.
- `init` is refactored to call `mirrorDir`, so `init` and auto-sync share
  one code path (no behavioral divergence).

### 2. `ensureRuntimeSynced()` — self-heal gate

Called once at CLI entry (`src/index.ts`) before command dispatch.

- Resolve source root via existing `findPackageRoot()`.
- For each managed subtree (`plugin/`, `templates/`, `scripts/`):
  compute a fingerprint = hash over sorted `(relpath, size, mtimeMs)`.
- Read recorded fingerprints from `~/.config/cockpit/.sync-state.json`
  (`{ plugin, templates, scripts }`).
- For each subtree whose fingerprint differs (or is missing): run
  `mirrorDir` for that subtree, then rewrite that entry in the state file.
- On match: read + compare only, no writes, no output.
- On any error (source missing, FS error): write a one-line warning to
  stderr and continue — the command must still run.

### 3. State file — `~/.config/cockpit/.sync-state.json`

`{ "plugin": "<hash>", "templates": "<hash>", "scripts": "<hash>" }`.
Created/updated by `ensureRuntimeSynced`. Absent/corrupt → treated as
"all stale", triggering a full re-sync (self-correcting).

## Hard Boundary

The sync touches **only** `plugin/`, `templates/`, `scripts/`. It must
never write or prune `config.json`, `sessions.json`, `reactions.json`,
`spokes/`, `reactor-events/`, or any other `~/.config/cockpit` entry.
Pruning is scoped per managed subtree — never at the `~/.config/cockpit`
root.

## Data Flow

```
cockpit <cmd>
  -> ensureRuntimeSynced()
       -> for sub in [plugin, templates, scripts]:
            fp = fingerprint(source/sub)
            if fp != state[sub]:
                 mirrorDir(source/sub, runtime/sub)   # copy + prune
                 state[sub] = fp
       -> persist .sync-state.json (only if changed)
  -> dispatch command
```

## Error Handling

- Source root unresolvable / managed dir missing in source → warn, skip
  that subtree, continue command.
- FS error during mirror → warn with the path, leave runtime as-is for
  that subtree (last-known-good), continue command.
- Corrupt `.sync-state.json` → treat as empty, full re-sync.
- Never throw out of `ensureRuntimeSynced`; the CLI must remain usable.

## Testing

`mirrorDir`:
- copies a new file
- overwrites a changed file (size and mtime cases)
- **prunes a file deleted from src**
- **prunes a dir deleted from src**
- leaves an unmanaged sibling in dest untouched

`ensureRuntimeSynced`:
- no-op when fingerprints match (no FS writes, no output)
- syncs only the changed subtree on partial mismatch
- never touches user-state files (`config.json` etc.) even when present
  in the runtime dir
- missing source dir → warns, command proceeds
- corrupt/absent state file → full re-sync, then steady state

## Out of Scope (YAGNI)

- No config flags / `--no-sync` escape hatch unless a concrete need arises.
- No syncing of assets beyond the three managed dirs.
- No background watcher — the per-invocation check is sufficient and
  matches the "self-improving, prompted-at-key-moments" model.
