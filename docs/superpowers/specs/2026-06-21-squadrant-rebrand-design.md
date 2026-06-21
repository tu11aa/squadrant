# Squadrant Rebrand — Design Spec

**Status:** Approved for implementation (2026-06-21)
**Author:** captain (brainstorm with user)
**Scope:** Full rebrand of `claude-cockpit` → `squadrant`, including runtime paths, plus docs refresh and a 0.9.0 release.

## Why

The project began as a Claude-Code-only tool ("claude-cockpit"). Its mission grew into a **multi-agent orchestration layer** (Claude, Codex, opencode, Gemini). The `claude-` brand no longer fits. Rebrand to **Squadrant** — *the command grid where you orchestrate a squad of agents* — a unique, npm-available, GitHub-uncrowded name in the existing aviation/crew/captain metaphor family.

## Naming (locked)

| Layer | From | To |
|-------|------|-----|
| Product/brand | claude-cockpit | **Squadrant** |
| npm package | `claude-cockpit` | `squadrant` (unscoped) |
| GitHub repo | `tu11aa/claude-cockpit` | `tu11aa/squadrant` |
| CLI command | `cockpit` | `squadrant` (+ alias **`squad`**) |
| Internal packages | `@cockpit/*` | `@squadrant/*` |
| Daemon bundle | `dist/cockpitd.js` | `dist/squadrantd.js` |
| Runtime config dir | `~/.config/cockpit` | `~/.config/squadrant` |
| Daemon launchd label | `com.cockpit.daemon` | `com.squadrant.daemon` |
| Hub vault root | `~/cockpit-hub` | `~/squadrant-hub` |
| Skill namespace | `cockpit:*` | `squadrant:*` |
| Version | 0.8.2 | **0.9.0** |

## MUST-NOT-TOUCH (rename foot-guns)

- **`cmux`** — the terminal multiplexer; unrelated to the cockpit brand. Never rename.
- **`node_modules/`, `dist/`, `.worktrees/`** — build artifacts / deps; the rename happens in source, build regenerates dist.
- **Historical CHANGELOG entries** (≤ 0.8.2) — keep verbatim; they are a record. Add a new 0.9.0 entry only.
- **Captain/crew/launch/side vocabulary** — these aviation terms stay; they cohere with "squad".
- External issue references (#NNN) and dated doc filenames — leave as-is.

## Phased strategy (live system untouched until the final manual cutover)

### Phase 1 — Code rebrand on branch `rebrand/squadrant` (zero live impact)
Mechanical rename across the monorepo, in categories, building between each:
1. **Internal packages**: every `@cockpit/<pkg>` package.json `name`, every import specifier, tsconfig `paths`/references, tsup/build config → `@squadrant/<pkg>`.
2. **CLI**: root `package.json` `name` → `squadrant`, `bin` → `{ "squadrant": "./dist/index.js", "squad": "./dist/index.js" }`, version → `0.9.0`. Command program name + help text.
3. **Daemon bundle**: `cockpitd` → `squadrantd` (tsup entry, output `dist/squadrantd.js`, any path math referencing the bundle name).
4. **Runtime path/label constants** (the dangerous ones — change the source constants so a freshly built binary uses new paths): `~/.config/cockpit` → `~/.config/squadrant`; `com.cockpit.daemon` → `com.squadrant.daemon`; `~/cockpit-hub` → `~/squadrant-hub`. Captain name template `⚓ cockpit-captain` → `⚓ squadrant-captain` (and crew/side tab prefixes if branded).
5. **Skill namespace**: `cockpit:` → `squadrant:` in plugin manifest + any skill cross-references + templates that invoke skills.
6. **Brand strings**: "Cockpit"/"claude-cockpit" → "Squadrant" in user-facing strings, banners, the `doctor`/`init` output, plugin.json name/description.

Gate: `pnpm build` clean, `pnpm test` green, `node dist/index.js --help` shows `squadrant`, `node dist/squadrantd.js --help` OK.

### Phase 2 — Migration script (written in Phase 1, executed manually at cutover)
`scripts/migrate-to-squadrant.sh` — idempotent, with `--dry-run` and an automatic backup. Steps it performs:
1. `tar czf ~/squadrant-migration-backup-<ts>.tgz ~/.config/cockpit ~/cockpit-hub`
2. Stop captains, `launchctl bootout gui/$(id -u)/com.cockpit.daemon`
3. `mv ~/.config/cockpit ~/.config/squadrant`; `mv ~/cockpit-hub ~/squadrant-hub`
4. Rewrite `~/.config/squadrant/config.json`: every `cockpit-hub` path → `squadrant-hub`, `.config/cockpit` → `.config/squadrant`, `⚓ cockpit-captain` → `⚓ squadrant-captain`, captainName fields, any `/cockpit/` substrings. (jq-based, validated.)
5. Install `~/Library/LaunchAgents/com.squadrant.daemon.plist` → repo `dist/squadrantd.js`; remove old plist.
6. `pnpm build` + relink the `squadrant`/`squad` global bin.
7. `launchctl bootstrap gui/$(id -u) com.squadrant.daemon`; relaunch captains.
Prints a numbered checklist; the user runs it (it terminates the live captain session).

### Phase 3 — Remote rename + release
- Rename GitHub repo `tu11aa/claude-cockpit` → `tu11aa/squadrant` (auto-redirects old URLs); update local `git remote`.
- Update repository URLs in package.json (`repository`/`homepage`/`bugs`).
- Cut `release/v0.9.0` → PR base `main` → merge → release workflow tags `v0.9.0` and **publishes `squadrant` to npm** (NPM_TOKEN now set).

## Docs

Refresh every brand/command reference: README (install becomes `npm i -g squadrant`, commands become `squadrant …`/`squad …`), AGENTS.md/CLAUDE.md wrappers, architecture diagrams, package READMEs, all skills, ROADMAP. Add a top-of-README note and a CHANGELOG 0.9.0 entry documenting the rebrand. Keep historical specs/reports intact (they may keep "cockpit" in historical context; add a one-line "formerly claude-cockpit" note where it aids the reader).

## Risk & rollback

- **Backup tarball** before any live move; rollback = restore dirs + reload old plist.
- Phase 1/2/3-code all land while the **old daemon keeps running old dist** — nothing live breaks until the user runs the migration script.
- The cutover is **manual and user-run** because it terminates this captain session.
- Old npm name (`claude-cockpit`) was never ours; simply abandon it. Old GitHub URLs redirect.

## Success criteria

1. `pnpm build && pnpm test && node dist/index.js --help` green; help shows `squadrant`/`squad`, no `cockpit` brand in user-facing output.
2. No `@cockpit/*` left in source; no `cockpit` runtime-path/label constants left (cmux excluded).
3. Migration script dry-run produces a correct rewritten config without mutating anything.
4. 0.9.0 released and `npm i -g squadrant` installs a working `squadrant` CLI.
5. Docs contain no stale `cockpit` brand/command references (historical context excepted).
