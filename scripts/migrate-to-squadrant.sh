#!/usr/bin/env bash
#
# migrate-to-squadrant.sh — one-time live cutover from claude-cockpit → squadrant.
#
# Renames the runtime config dir, hub vault, daemon launchd label, and rewrites
# config.json to the new brand. Idempotent (safe to re-run) and supports
# --dry-run (prints every action and a concrete config-rewrite preview WITHOUT
# mutating anything).
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

OLD_CONFIG="$HOME/.config/cockpit"
NEW_CONFIG="$HOME/.config/squadrant"
OLD_HUB="$HOME/cockpit-hub"
NEW_HUB="$HOME/squadrant-hub"
OLD_LABEL="com.cockpit.daemon"
NEW_LABEL="com.squadrant.daemon"
OLD_PLIST="$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UID_NUM="$(id -u)"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME/squadrant-migration-backup-${TS}.tgz"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { printf '  $ %s\n' "$*"; [ "$DRY_RUN" -eq 1 ] || eval "$@"; }
note() { printf '  · %s\n' "$*"; }

# ---- config.json rewrite (pure, no claude-cockpit collisions: none of the
#      rules match inside "claude-cockpit", so the real repo path is untouched).
rewrite_config() {  # $1=src json  $2=mode (apply <dest> | preview)
  local src="$1" mode="$2" dest="${3:-}"
  SRC="$src" MODE="$mode" DEST="$dest" python3 - <<'PY'
import json, os, sys
src, mode, dest = os.environ["SRC"], os.environ["MODE"], os.environ["DEST"]
with open(src) as f:
    d = json.load(f)
RULES = [("cockpit-hub", "squadrant-hub"),
         (".config/cockpit", ".config/squadrant"),
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
note "repo:        $REPO_ROOT"
note "config:      $OLD_CONFIG  ->  $NEW_CONFIG"
note "hub:         $OLD_HUB  ->  $NEW_HUB"
note "daemon:      $OLD_LABEL  ->  $NEW_LABEL"

# Already migrated? (new dir present, old gone) — nothing to do.
if [ -d "$NEW_CONFIG" ] && [ ! -d "$OLD_CONFIG" ]; then
  step "Already migrated — $NEW_CONFIG exists and $OLD_CONFIG is gone. Nothing to do."
  exit 0
fi

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

step "3. Move config dir and hub vault"
if [ -d "$OLD_CONFIG" ] && [ ! -d "$NEW_CONFIG" ]; then run "mv '$OLD_CONFIG' '$NEW_CONFIG'"; else note "config move skipped (old absent or new exists)"; fi
if [ -d "$OLD_HUB" ] && [ ! -d "$NEW_HUB" ]; then run "mv '$OLD_HUB' '$NEW_HUB'"; else note "hub move skipped (old absent or new exists)"; fi

step "4. Rewrite config.json (cockpit-hub→squadrant-hub, .config/cockpit→.config/squadrant, ⚓ cockpit-captain→⚓ squadrant-captain, _cockpitVersion key)"
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

step "5. Remove old launchd plist (the rebuilt daemon installs com.squadrant.daemon.plist on first run)"
[ -f "$OLD_PLIST" ] && run "rm -f '$OLD_PLIST'" || note "old plist absent"

step "6. Build the rebranded binary + relink the global 'squadrant'/'squad' bin"
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
  Rollback (if needed):
    launchctl bootout gui/${UID_NUM}/${NEW_LABEL} 2>/dev/null || true
    rm -rf ${NEW_CONFIG} ${NEW_HUB}
    tar xzf ${BACKUP} -C ${HOME}
    # then reinstall the old plist + relink the old 'cockpit' bin
EOF
