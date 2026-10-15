#!/bin/bash
# Usage: read-handoff.sh <project|workspace-path|spoke-vault-path> [--keep]
# Reads and prints workspace/<project>/handoff.json, then archives it to
# workspace/<project>/handoffs/<date>.json (unless --keep). Captain calls this
# on session startup to load previous context. Only the basename of the first
# arg is used (#983).
set -euo pipefail

TARGET="${1:?Usage: read-handoff.sh <project-or-vault-path> [--keep]}"
KEEP="${2:-}"
PROJECT="$(basename "$TARGET")"
VAULT="${SQUADRANT_WORKSPACE_DIR:-$HOME/squadrant/workspace}/$PROJECT"
HANDOFF_FILE="$VAULT/handoff.json"

# #983 dual-read (one version): a handoff written before the move still sits
# in the old spoke vault — the path passed in, or the default hub location.
if [ ! -f "$HANDOFF_FILE" ]; then
  for LEGACY in "$TARGET" "$HOME/squadrant-hub/spokes/$PROJECT"; do
    case "$LEGACY" in */*) ;; *) continue ;; esac
    if [ -f "$LEGACY/handoff.json" ]; then
      HANDOFF_FILE="$LEGACY/handoff.json"
      break
    fi
  done
fi

if [ ! -f "$HANDOFF_FILE" ]; then
  echo '{"exists": false}'
  exit 0
fi

# Print the handoff content
cat "$HANDOFF_FILE"

# Archive (don't delete) unless --keep flag. Multi-session days are the norm
# (compacts, relaunches), so a same-day archive must never be clobbered by a
# later read on the same day — uniquify with -2, -3, ... instead of overwriting.
if [ "$KEEP" != "--keep" ]; then
  ARCHIVE_DIR="$VAULT/handoffs"
  mkdir -p "$ARCHIVE_DIR"
  DATE=$(date -u +%Y-%m-%d)
  DEST="$ARCHIVE_DIR/$DATE.json"
  N=2
  while [ -e "$DEST" ]; do
    DEST="$ARCHIVE_DIR/$DATE-$N.json"
    N=$((N + 1))
  done
  mv "$HANDOFF_FILE" "$DEST"
fi
