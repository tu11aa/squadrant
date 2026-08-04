#!/bin/bash
# Usage: read-handoff.sh <spoke-vault-path> [--keep]
# Reads and prints handoff.json, then archives it to handoffs/<date>.json
# (unless --keep). Captain calls this on session startup to load previous
# context.
set -euo pipefail

VAULT="${1:?Usage: read-handoff.sh <vault-path> [--keep]}"
KEEP="${2:-}"
HANDOFF_FILE="$VAULT/handoff.json"

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
