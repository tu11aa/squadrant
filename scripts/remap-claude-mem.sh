#!/usr/bin/env bash
#
# remap-claude-mem.sh — unify a claude-mem project slug after a repo rebrand.
#
# Usage:
#   scripts/remap-claude-mem.sh [--dry-run] [OLD_SLUG] [NEW_SLUG]
#   scripts/remap-claude-mem.sh --dry-run                 # preview, mutate nothing
#   scripts/remap-claude-mem.sh                           # claude-cockpit -> squadrant
#   scripts/remap-claude-mem.sh --dry-run cockpit-old squadrant
#
# WHAT IT DOES
#   Makes a claude-mem project's history follow a rebrand so that, when you work
#   in the renamed repo, the old project's memory surfaces under the new slug.
#
#   Default mapping (after the claude-cockpit -> squadrant rebrand):
#       claude-cockpit            -> squadrant          (the main project)
#       claude-cockpit/<worktree> -> squadrant/<worktree> (per-worktree subslugs)
#       cwd .../me/claude-cockpit -> .../me/squadrant    (pending_messages queue)
#
# APPROACH — native `merged_into_project`, NOT a destructive project rewrite
#   claude-mem already ships a "worktree adoption" mechanism that unifies slugs by
#   setting observations.merged_into_project / session_summaries.merged_into_project
#   to the target, and its read path resolves it everywhere:
#       - session-start injection (context-generator) queries SQLite directly with
#         `WHERE (o.project = ? OR o.merged_into_project = ?)`
#       - semantic search (chroma) filters `{$or:[{project},{merged_into_project}]}`
#   So pointing merged_into_project at the new slug surfaces the old rows under it.
#   This is the approach claude-mem itself supports — chosen over rewriting
#   `project` because it is additive, non-destructive, and reversible (the column
#   was NULL before; the .db backup restores the exact prior state).
#
#   Tables WITHOUT a merge column (sdk_sessions.project, pending_messages.cwd) are
#   session/queue metadata, not searchable memory, and are not vector-stored — for
#   those we rewrite the literal value (the only mechanism available, FTS-safe).
#
# FTS5 — no rebuild needed
#   observations_fts / session_summaries_fts / user_prompts_fts index only CONTENT
#   columns (title, narrative, text, ...), NOT project/merged_into_project. We
#   change no FTS-indexed column, and the AFTER UPDATE triggers re-sync FTS from
#   the (unchanged) content automatically. So FTS stays consistent with zero work.
#
# CHROMA (vector store) — intentionally NOT touched (see below)
#   claude-mem's chroma runs as an EMBEDDED persistent store
#   (`chroma-mcp --client-type persistent --data-dir ~/.claude-mem/chroma`), held
#   EXCLUSIVELY by the running claude-mem worker. There is no HTTP endpoint. The
#   only supported write path is the worker's own `chroma_update_documents`, which
#   is invoked exclusively during worktree adoption — there is NO claude-mem CLI
#   command to re-attribute existing docs, and a second process writing the
#   persistent store (or raw-editing chroma.sqlite3) risks corruption. We therefore
#   do NOT mutate chroma here.
#
#   Impact: the SQLite change above fully fixes the PRIMARY surface — the memory
#   injected at session start (which reads SQLite directly). The only gap is that
#   EXPLICIT semantic search (mem-search / smart_search MCP tools) will keep
#   attributing pre-rebrand observations to the OLD slug until their chroma
#   metadata is patched. Safest fallback for that, when it matters:
#       - new post-rebrand observations are searchable under the new slug already;
#       - to re-attribute the historical vectors, ask claude-mem upstream for a
#         re-sync/merge command, or stop the worker and run a one-off
#         chroma_update_documents pass — do NOT edit chroma.sqlite3 by hand.
#
# TESTING — never touches the live DB unless you point it there
#   Set CLAUDE_MEM_HOME to a temp dir containing a COPY of claude-mem.db to dry-run
#   and apply against the copy. Make a consistent snapshot copy with:
#       sqlite3 "file:$HOME/.claude-mem/claude-mem.db?immutable=1" \
#               "VACUUM INTO '/tmp/cm-test/claude-mem.db'"
#       CLAUDE_MEM_HOME=/tmp/cm-test scripts/remap-claude-mem.sh --dry-run
#
# WHEN TO RUN (live)
#   Run this ONCE, AFTER the repo cutover, while claude-mem is quiet. First confirm
#   the real new slug claude-mem assigns to the renamed repo (run any session in
#   .../me/squadrant and check `project` in a fresh observation), then run this with
#   that slug as NEW_SLUG. Idempotent: safe to re-run; a second run changes 0 rows.
#
set -euo pipefail

DRY_RUN=0
POS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,80p' "$0" | sed 's/^#//'; exit 0 ;;
    --*) echo "unknown flag: $arg" >&2; echo "usage: $0 [--dry-run] [OLD_SLUG] [NEW_SLUG]" >&2; exit 2 ;;
    *) POS+=("$arg") ;;
  esac
done

OLD_SLUG="${POS[0]:-claude-cockpit}"
NEW_SLUG="${POS[1]:-squadrant}"

# Slugs are interpolated into SQL; restrict to a safe charset (no quotes/slashes).
slug_ok() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]; }
slug_ok "$OLD_SLUG" || { echo "invalid OLD_SLUG: '$OLD_SLUG' (allowed: A-Za-z0-9._-)" >&2; exit 2; }
slug_ok "$NEW_SLUG" || { echo "invalid NEW_SLUG: '$NEW_SLUG' (allowed: A-Za-z0-9._-)" >&2; exit 2; }
[ "$OLD_SLUG" = "$NEW_SLUG" ] && { echo "OLD_SLUG and NEW_SLUG are identical — nothing to do." >&2; exit 2; }

CLAUDE_MEM_HOME="${CLAUDE_MEM_HOME:-$HOME/.claude-mem}"
DB="$CLAUDE_MEM_HOME/claude-mem.db"
# Repo working-copy paths recorded in pending_messages.cwd (overridable for tests).
OLD_CWD="${OLD_CWD:-$HOME/me/$OLD_SLUG}"
NEW_CWD="${NEW_CWD:-$HOME/me/$NEW_SLUG}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$DB.bak-rebrand-$TS"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '  · %s\n' "$*"; }

command -v sqlite3 >/dev/null || { echo "sqlite3 not found on PATH" >&2; exit 1; }
[ -f "$DB" ] || { echo "claude-mem DB not found: $DB" >&2; exit 1; }

# Read-only count helper (immutable open: never creates/locks WAL on the source).
roq() { sqlite3 "file:$DB?immutable=1" "$1"; }

printf '\033[1mclaude-mem slug remap%s\033[0m\n' "$([ "$DRY_RUN" -eq 1 ] && echo ' (DRY RUN — nothing will change)')"
note "db:       $DB"
note "old slug: $OLD_SLUG   (+ subslugs $OLD_SLUG/<worktree>)"
note "new slug: $NEW_SLUG"
note "cwd:      $OLD_CWD  ->  $NEW_CWD"

# ---- Per-table counts of rows that WOULD change (same predicates as the UPDATEs).
OBS_N=$(roq "SELECT COUNT(*) FROM observations WHERE (project='$OLD_SLUG' OR project LIKE '$OLD_SLUG/%' OR merged_into_project='$OLD_SLUG') AND (merged_into_project IS NULL OR merged_into_project<>'$NEW_SLUG');")
SUM_N=$(roq "SELECT COUNT(*) FROM session_summaries WHERE (project='$OLD_SLUG' OR project LIKE '$OLD_SLUG/%' OR merged_into_project='$OLD_SLUG') AND (merged_into_project IS NULL OR merged_into_project<>'$NEW_SLUG');")
SDK_N=$(roq "SELECT COUNT(*) FROM sdk_sessions WHERE project='$OLD_SLUG' OR project LIKE '$OLD_SLUG/%';")
PEND_N=$(roq "SELECT COUNT(*) FROM pending_messages WHERE cwd='$OLD_CWD' OR cwd LIKE '$OLD_CWD/%';")

OBS_TOTAL_BEFORE=$(roq "SELECT COUNT(*) FROM observations;")
RESOLVE_BEFORE=$(roq "SELECT COUNT(*) FROM observations WHERE project='$NEW_SLUG' OR merged_into_project='$NEW_SLUG';")

step "Rows that would change"
note "observations.merged_into_project -> $NEW_SLUG : $OBS_N"
note "session_summaries.merged_into_project -> $NEW_SLUG : $SUM_N"
note "sdk_sessions.project rewrite : $SDK_N"
note "pending_messages.cwd rewrite : $PEND_N"
note "(observations resolvable under '$NEW_SLUG' now: $RESOLVE_BEFORE of $OBS_TOTAL_BEFORE total)"

if [ "$((OBS_N + SUM_N + SDK_N + PEND_N))" -eq 0 ]; then
  step "Nothing to remap — already unified under '$NEW_SLUG' (idempotent no-op)."
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  step "Dry run complete — no changes written."
  exit 0
fi

# ---- Backup is mandatory. Refuse to proceed if it fails. (Chroma is not touched,
#      so only the .db is backed up — see header.)
step "Backup claude-mem.db (required)"
cp "$DB" "$BACKUP" || { echo "backup failed — aborting, nothing changed" >&2; exit 1; }
note "backup -> $BACKUP   (rollback: cp '$BACKUP' '$DB')"

# ---- Apply, single transaction. busy_timeout tolerates a briefly-active worker;
#      still, run this while claude-mem is quiet (see header).
step "Apply remap (single transaction)"
sqlite3 "$DB" <<SQL
.timeout 10000
BEGIN IMMEDIATE;

UPDATE observations
   SET merged_into_project='$NEW_SLUG'
 WHERE (project='$OLD_SLUG' OR project LIKE '$OLD_SLUG/%' OR merged_into_project='$OLD_SLUG')
   AND (merged_into_project IS NULL OR merged_into_project<>'$NEW_SLUG');

UPDATE session_summaries
   SET merged_into_project='$NEW_SLUG'
 WHERE (project='$OLD_SLUG' OR project LIKE '$OLD_SLUG/%' OR merged_into_project='$OLD_SLUG')
   AND (merged_into_project IS NULL OR merged_into_project<>'$NEW_SLUG');

-- sdk_sessions has no merge column: rewrite the literal project (main + subslugs).
UPDATE sdk_sessions SET project='$NEW_SLUG' WHERE project='$OLD_SLUG';
UPDATE sdk_sessions
   SET project='$NEW_SLUG' || substr(project, length('$OLD_SLUG') + 1)
 WHERE project LIKE '$OLD_SLUG/%';

-- pending_messages queue: re-point the repo working-copy path.
UPDATE pending_messages
   SET cwd='$NEW_CWD' || substr(cwd, length('$OLD_CWD') + 1)
 WHERE cwd='$OLD_CWD' OR cwd LIKE '$OLD_CWD/%';

COMMIT;
SQL
note "transaction committed"

# ---- Verify: history now resolves under the new slug and nothing was lost.
step "Verify"
OBS_TOTAL_AFTER=$(roq "SELECT COUNT(*) FROM observations;")
RESOLVE_AFTER=$(roq "SELECT COUNT(*) FROM observations WHERE project='$NEW_SLUG' OR merged_into_project='$NEW_SLUG';")
OLD_LEFT=$(roq "SELECT COUNT(*) FROM sdk_sessions WHERE project='$OLD_SLUG' OR project LIKE '$OLD_SLUG/%';")

note "observations total: $OBS_TOTAL_BEFORE -> $OBS_TOTAL_AFTER"
note "observations resolvable under '$NEW_SLUG': $RESOLVE_BEFORE -> $RESOLVE_AFTER"
note "sdk_sessions still on old slug: $OLD_LEFT (expect 0)"

if [ "$OBS_TOTAL_AFTER" -ne "$OBS_TOTAL_BEFORE" ]; then
  echo "FATAL: observation count changed ($OBS_TOTAL_BEFORE -> $OBS_TOTAL_AFTER) — DATA LOSS. Restore: cp '$BACKUP' '$DB'" >&2
  exit 1
fi
if [ "$OLD_LEFT" -ne 0 ]; then
  echo "WARN: $OLD_LEFT sdk_sessions still on old slug (unexpected)." >&2
fi

step "Done — '$OLD_SLUG' history now resolves under '$NEW_SLUG'."
note "Re-run is a safe no-op. Chroma semantic search re-attribution: see header (intentionally not modified)."
