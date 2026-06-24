#!/usr/bin/env bash
#
# migrate-to-squadrant.sh — one-time live cutover from claude-cockpit → squadrant.
#
# Renames the runtime config dir, hub vault, this project's spoke vault, the
# repo folder, the local project key (projects.cockpit -> projects.squadrant),
# the daemon launchd label, Claude Code's per-project session/memory dirs, and
# rewrites config.json to the new brand.
# Idempotent (safe to re-run) and supports --dry-run (prints every action and a
# concrete config-rewrite preview WITHOUT mutating anything).
#
# The repo folder cannot mv itself while it is the running checkout, so Step 0
# guards that: if invoked from the old repo it prints the exact `mv` to run and
# exits. Re-run from the new path ($HOME/me/squadrant) to do the full cutover.
#
# This is run MANUALLY by the user at cutover — it terminates the live captain
# session and bounces the daemon. The old daemon keeps running old `dist` until
# this script runs, so nothing live breaks before then.
#
# Usage:
#   scripts/migrate-to-squadrant.sh --dry-run   # preview, mutate nothing
#   scripts/migrate-to-squadrant.sh             # perform the cutover
#
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "" ) ;;
  * ) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

# Claude Code munges a project's absolute path into its state-dir name by
# replacing every '/' and '.' with '-' (e.g. /Users/me/claude-cockpit ->
# -Users-me-claude-cockpit, and the inner /.worktrees/ -> --worktrees-).
munge_path() { local p="${1//\//-}"; printf '%s' "${p//./-}"; }

OLD_CONFIG="$HOME/.config/cockpit"
NEW_CONFIG="$HOME/.config/squadrant"
OLD_HUB="$HOME/cockpit-hub"
NEW_HUB="$HOME/squadrant-hub"
OLD_REPO="$HOME/me/claude-cockpit"
NEW_REPO="$HOME/me/squadrant"
# Spoke vault for THIS project, addressed after the hub move (step 3).
OLD_SPOKE="$NEW_HUB/spokes/cockpit"
NEW_SPOKE="$NEW_HUB/spokes/squadrant"
OLD_LABEL="com.cockpit.daemon"
NEW_LABEL="com.squadrant.daemon"
OLD_PLIST="$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"
# Claude Code's per-project state (session .jsonl transcripts + memory/ auto-memory)
# is keyed by the munged repo path, so the folder rename orphans it (the new path
# starts empty). Renaming the state dir prefix re-links it to the renamed repo.
CLAUDE_PROJECTS="$HOME/.claude/projects"
OLD_MUNGED="$(munge_path "$OLD_REPO")"
NEW_MUNGED="$(munge_path "$NEW_REPO")"
# MIGRATE_REPO_ROOT lets --dry-run simulate running from the renamed repo
# (to preview the full plan past the Step-0 guard); unset in real runs.
REPO_ROOT="${MIGRATE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
UID_NUM="$(id -u)"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME/squadrant-migration-backup-${TS}.tgz"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { printf '  $ %s\n' "$*"; [ "$DRY_RUN" -eq 1 ] || eval "$@"; }
note() { printf '  · %s\n' "$*"; }

# ---- config.json rewrite (pure). Rules are scoped so only THIS project's
#      brand strings change: "me/claude-cockpit" + "spokes/cockpit" are unique
#      to the cockpit project, so the other 20+ projects' paths are untouched.
rewrite_config() {  # $1=src json  $2=mode (apply <dest> | preview)
  local src="$1" mode="$2" dest="${3:-}"
  SRC="$src" MODE="$mode" DEST="$dest" python3 - <<'PY'
import json, os, sys
src, mode, dest = os.environ["SRC"], os.environ["MODE"], os.environ["DEST"]
with open(src) as f:
    d = json.load(f)
RULES = [("cockpit-hub", "squadrant-hub"),
         (".config/cockpit", ".config/squadrant"),
         ("me/claude-cockpit", "me/squadrant"),
         ("spokes/cockpit", "spokes/squadrant"),
         ("⚓ cockpit-captain", "⚓ squadrant-captain")]
changes = []
def fix(s):
    out = s
    for a, b in RULES:
        out = out.replace(a, b)
    if out != s:
        changes.append((s, out))
    return out
def walk(o):
    if isinstance(o, dict):
        return {k: walk(v) for k, v in o.items()}
    if isinstance(o, list):
        return [walk(v) for v in o]
    if isinstance(o, str):
        return fix(o)
    return o
d = walk(d)
# Rename the project key projects.cockpit -> projects.squadrant (preserve order).
if isinstance(d.get("projects"), dict) and "cockpit" in d["projects"]:
    d["projects"] = {("squadrant" if k == "cockpit" else k): v
                     for k, v in d["projects"].items()}
    changes.append(("key:projects.cockpit", "key:projects.squadrant"))
if "_cockpitVersion" in d:
    d["_squadrantVersion"] = d.pop("_cockpitVersion")
    changes.append(("key:_cockpitVersion", "key:_squadrantVersion"))
if mode == "preview":
    print(f"  rewrites that WOULD apply to {src} ({len(changes)}):")
    for a, b in changes:
        print(f"    - {a!r}\n    + {b!r}")
else:
    with open(dest, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    print(f"  rewrote {dest} ({len(changes)} value/key changes)")
PY
}

printf '\033[1mSquadrant migration%s\033[0m\n' "$([ "$DRY_RUN" -eq 1 ] && echo ' (DRY RUN — nothing will change)')"
note "repo:        $OLD_REPO  ->  $NEW_REPO"
note "config:      $OLD_CONFIG  ->  $NEW_CONFIG"
note "hub:         $OLD_HUB  ->  $NEW_HUB"
note "spoke:       $OLD_SPOKE  ->  $NEW_SPOKE"
note "project key: projects.cockpit  ->  projects.squadrant"
note "sessions:    $CLAUDE_PROJECTS/$OLD_MUNGED*  ->  $NEW_MUNGED*"
note "daemon:      $OLD_LABEL  ->  $NEW_LABEL"
note "running from: $REPO_ROOT"

# Already migrated? (new dir present, old gone) — nothing to do.
if [ -d "$NEW_CONFIG" ] && [ ! -d "$OLD_CONFIG" ]; then
  step "Already migrated — $NEW_CONFIG exists and $OLD_CONFIG is gone. Nothing to do."
  exit 0
fi

# ---- Step 0: the repo folder must already live at its new name. The script
#      cannot mv its own running checkout, so if we are not in $NEW_REPO we
#      print the exact move + re-run command and stop here.
step "0. Repo folder rename (must run from the NEW path)"
if [ "$REPO_ROOT" != "$NEW_REPO" ]; then
  note "running from: $REPO_ROOT"
  note "expected:     $NEW_REPO"
  cat <<EOF

  The repo folder still needs to be renamed, and this script cannot move its own
  running checkout. Do it manually, then re-run from the new location:

    # 1. close captains (cmux) so nothing holds the old path open
    # 2. move the repo folder:
    mv '$OLD_REPO' '$NEW_REPO'
    # 3. re-run this script from the renamed repo:
    bash '$NEW_REPO/scripts/migrate-to-squadrant.sh'$([ "$DRY_RUN" -eq 1 ] && echo ' --dry-run')

  (The daemon plist and the global npm link both point at the repo dir; moving it
   first lets steps 6-7 relink and bootstrap from the new location.)
EOF
  exit 0
fi
note "running from $NEW_REPO ✓"

step "1. Backup ~/.config/cockpit and ~/cockpit-hub"
# Archive with paths RELATIVE to $HOME so rollback is `tar xzf <backup> -C $HOME`.
BACKUP_RELS=()
[ -d "$OLD_CONFIG" ] && BACKUP_RELS+=(".config/cockpit")
[ -d "$OLD_HUB" ] && BACKUP_RELS+=("cockpit-hub")
if [ "${#BACKUP_RELS[@]}" -gt 0 ]; then
  run "tar czf '$BACKUP' -C '$HOME' ${BACKUP_RELS[*]}"
  note "backup -> $BACKUP   (rollback: tar xzf '$BACKUP' -C '$HOME' + reload old plist)"
else
  note "no source dirs to back up (fresh machine?)"
fi

step "2. Stop captains + bootout the old daemon"
note "Captains are cmux workspaces — close them in cmux, or let the relaunch below recreate them."
run "launchctl bootout gui/${UID_NUM}/${OLD_LABEL} 2>/dev/null || true"

step "3. Move config dir, hub vault, and this project's spoke vault"
if [ -d "$OLD_CONFIG" ] && [ ! -d "$NEW_CONFIG" ]; then run "mv '$OLD_CONFIG' '$NEW_CONFIG'"; else note "config move skipped (old absent or new exists)"; fi
if [ -d "$OLD_HUB" ] && [ ! -d "$NEW_HUB" ]; then run "mv '$OLD_HUB' '$NEW_HUB'"; else note "hub move skipped (old absent or new exists)"; fi
# Spoke lives under the hub; source check covers both pre- and post-hub-move location.
if { [ -d "$OLD_SPOKE" ] || [ -d "$OLD_HUB/spokes/cockpit" ]; } && [ ! -d "$NEW_SPOKE" ]; then run "mv '$OLD_SPOKE' '$NEW_SPOKE'"; else note "spoke move skipped (source absent or target exists)"; fi

step "4. Rewrite config.json (cockpit-hub→squadrant-hub, .config/cockpit→.config/squadrant, me/claude-cockpit→me/squadrant, spokes/cockpit→spokes/squadrant, ⚓ cockpit-captain→⚓ squadrant-captain, projects.cockpit→projects.squadrant key, _cockpitVersion key)"
if [ "$DRY_RUN" -eq 1 ]; then
  CFG_SRC="$OLD_CONFIG/config.json"; [ -f "$CFG_SRC" ] || CFG_SRC="$NEW_CONFIG/config.json"
  if [ -f "$CFG_SRC" ]; then rewrite_config "$CFG_SRC" preview; else note "no config.json found to preview"; fi
else
  CFG="$NEW_CONFIG/config.json"
  if [ -f "$CFG" ]; then
    cp "$CFG" "${CFG}.pre-squadrant.bak"
    rewrite_config "$CFG" apply "$CFG"
    python3 -c "import json;json.load(open('$CFG'))" && note "config.json valid JSON"
  else
    note "no config.json found at $CFG — skipping rewrite"
  fi
fi

step "4.5 Preserve Claude Code session history + auto-memory (rename per-project state dirs)"
# The main project dir ($OLD_MUNGED) holds the session .jsonl transcripts and the
# memory/ subdir; its worktree dirs ($OLD_MUNGED--worktrees-*) share the prefix and
# are orphaned by the SAME folder rename. Swap the prefix on each so the renamed
# repo finds them. Pure rename — no data is copied or deleted (idempotent: skips
# any dir whose new-name target already exists).
if [ -d "$CLAUDE_PROJECTS" ] && [ -n "$OLD_MUNGED" ]; then
  main_dir="$CLAUDE_PROJECTS/$OLD_MUNGED"
  if [ -d "$main_dir" ]; then
    sessions="$(find "$main_dir" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
    mem="$([ -d "$main_dir/memory" ] && find "$main_dir/memory" -type f 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
    note "main project dir: $sessions session transcript(s), $mem auto-memory file(s) to preserve"
  fi
  migrated=0; skipped=0
  shopt -s nullglob
  for src in "$CLAUDE_PROJECTS/$OLD_MUNGED" "$CLAUDE_PROJECTS/$OLD_MUNGED-"*; do
    [ -d "$src" ] || continue
    base="$(basename "$src")"
    dest="$CLAUDE_PROJECTS/${NEW_MUNGED}${base#"$OLD_MUNGED"}"
    if [ -e "$dest" ]; then note "skip (target exists): $base"; skipped=$((skipped + 1)); continue; fi
    run "mv '$src' '$dest'"
    migrated=$((migrated + 1))
  done
  shopt -u nullglob
  note "$([ "$DRY_RUN" -eq 1 ] && echo 'would migrate' || echo 'migrated') $migrated state dir(s) (main + worktrees); skipped $skipped"
else
  note "no $CLAUDE_PROJECTS dir — skipping session/memory preservation"
fi

step "4.6 Rewrite stale 'cockpit' tokens in Claude Code settings files (this repo, global ~/.claude, AND every registered project)"
# Settings files written on disk BEFORE the rebrand still invoke the removed
# `cockpit` binary — every Stop/PostToolUse hook fails "cockpit: command not
# found" — and reference old ~/.config/cockpit script paths and the cockpit-hub
# vault in permission allowlists. Rewrite three exact tokens in place:
#   cockpit crew _hook -> squadrant crew _hook   (the failing hook command)
#   .config/cockpit    -> .config/squadrant      (write-status/read-handoff paths)
#   cockpit-hub        -> squadrant-hub          (spoke-vault Read allowlist)
# Token-scoped (NOT a blanket cockpit->squadrant) so unrelated patterns like
# Bash(cockpit:*) are left untouched. Idempotent (a second run matches nothing).
# Earlier versions swept only this repo + global ~/.claude and ORPHANED every
# registered project, so the per-project files are read from config.json here.
CFG_FOR_HOOKS="$NEW_CONFIG/config.json"; [ -f "$CFG_FOR_HOOKS" ] || CFG_FOR_HOOKS="$OLD_CONFIG/config.json"
DRY_RUN="$DRY_RUN" NEW_REPO="$NEW_REPO" HOME_DIR="$HOME" CFG="$CFG_FOR_HOOKS" python3 - <<'PY'
import json, os
dry = os.environ["DRY_RUN"] == "1"
repo, home, cfg = os.environ["NEW_REPO"], os.environ["HOME_DIR"], os.environ["CFG"]
SUBS = [("cockpit crew _hook", "squadrant crew _hook"),
        (".config/cockpit", ".config/squadrant"),
        ("cockpit-hub", "squadrant-hub")]
files = [f"{repo}/.claude/settings.json", f"{repo}/.claude/settings.local.json",
         f"{home}/.claude/settings.json", f"{home}/.claude/settings.local.json"]
if os.path.isfile(cfg):
    try:
        for p in json.load(open(cfg)).get("projects", {}).values():
            path = p.get("path") if isinstance(p, dict) else None
            if path:
                files.append(os.path.join(path, ".claude", "settings.json"))
                files.append(os.path.join(path, ".claude", "settings.local.json"))
    except (ValueError, OSError) as e:
        print(f"  · could not read registered projects from {cfg}: {e}")
fixed = 0
for f in files:
    if not os.path.isfile(f):
        continue
    text = open(f, encoding="utf-8").read()
    if "cockpit" not in text:
        continue
    new = text
    for a, b in SUBS:
        new = new.replace(a, b)
    if new == text:
        continue
    print(f"  $ {'would rewrite' if dry else 'rewrite'} {f}")
    if not dry:
        json.loads(new)  # guard: only write back valid JSON
        open(f, "w", encoding="utf-8").write(new)
    fixed += 1
print(f"  · {'would rewrite' if dry else 'rewrote'} cockpit tokens in {fixed} settings file(s)")
PY

step "5. Remove old launchd plist (the rebuilt daemon installs com.squadrant.daemon.plist on first run)"
[ -f "$OLD_PLIST" ] && run "rm -f '$OLD_PLIST'" || note "old plist absent"

step "6. Build the rebranded binary + relink the global 'squadrant'/'squad' bin"
# Reinstall FIRST: the repo-folder rename (Step 0) leaves pnpm's workspace symlinks
# pointing at the old @cockpit/* package dirs, so a build before `install` aborts
# with hundreds of unresolved-import errors. `install` regenerates the links for
# the @squadrant/* packages at their new path; only then can the build resolve them.
run "pnpm -C '$REPO_ROOT' install"
run "pnpm -C '$REPO_ROOT' build"
run "pnpm -C '$REPO_ROOT' link --global"
note "removes the old global 'cockpit' bin; 'squadrant' and 'squad' now resolve to $REPO_ROOT/dist/index.js"

step "7. Bootstrap the new daemon"
note "Any 'squadrant' invocation triggers ensureDaemon, which writes com.squadrant.daemon.plist and bootstraps it."
run "node '$REPO_ROOT/dist/index.js' --version"

step "Done"
cat <<EOF
  Checklist:
    1. Verify daemon:   launchctl print gui/${UID_NUM}/${NEW_LABEL} | head
    2. Verify CLI:      squadrant --version   (expect 0.9.0)   and   squad --help
    3. Relaunch captains:  squadrant launch <project>   (recreates the ⚓ squadrant-captain workspaces)
    4. Tail the log:    tail -f ${NEW_CONFIG}/squadrantd.log
    5. Verify sessions: ls ${CLAUDE_PROJECTS}/${NEW_MUNGED}/   (your history + memory/ should be here)
  Rollback (if needed):
    launchctl bootout gui/${UID_NUM}/${NEW_LABEL} 2>/dev/null || true
    rm -rf ${NEW_CONFIG} ${NEW_HUB}
    tar xzf ${BACKUP} -C ${HOME}
    mv ${NEW_REPO} ${OLD_REPO}    # move the repo folder back
    # session/memory dirs are pure renames — move them back by prefix:
    for d in ${CLAUDE_PROJECTS}/${NEW_MUNGED} ${CLAUDE_PROJECTS}/${NEW_MUNGED}-*; do
      [ -d "\$d" ] && mv "\$d" "${CLAUDE_PROJECTS}/${OLD_MUNGED}\${d#${CLAUDE_PROJECTS}/${NEW_MUNGED}}"
    done
    # then reinstall the old plist + relink the old 'cockpit' bin
EOF
