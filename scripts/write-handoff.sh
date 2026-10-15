#!/bin/bash
# Usage: write-handoff.sh <project|workspace-path|spoke-vault-path> <json-content>
# Writes workspace/<project>/handoff.json for session continuity (#983: was
# <spokeVault>/handoff.json). Only the basename of the first arg is used, so
# captains still passing their old spoke path keep working.
# Captain calls this at session end to preserve context for tomorrow.
set -euo pipefail

TARGET="${1:?Usage: write-handoff.sh <project-or-vault-path> <json-content>}"
CONTENT="${2:?Provide JSON content as second argument}"
VAULT="${SQUADRANT_WORKSPACE_DIR:-$HOME/squadrant/workspace}/$(basename "$TARGET")"

mkdir -p "$VAULT"
HANDOFF_FILE="$VAULT/handoff.json"

# Validate JSON
if ! echo "$CONTENT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  echo "ERROR: Invalid JSON content" >&2
  exit 1
fi

# Write with timestamp wrapper
python3 -c "
import json, sys
from datetime import datetime, timezone
content = json.loads(sys.argv[1])
handoff = {
    'written_at': datetime.now(timezone.utc).isoformat(),
    'session': content
}
with open('$HANDOFF_FILE', 'w') as f:
    json.dump(handoff, f, indent=2)
print(f'Handoff written to $HANDOFF_FILE')
" "$CONTENT"
