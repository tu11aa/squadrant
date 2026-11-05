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

# Safety net: warn (never fail) when a "[thread <id>] ..." decision of the previous
# handoff is missing verbatim from the new content. The previous handoff is handoff.json,
# or (mid-session it is usually archived) the newest readable handoffs/*.json by mtime.
python3 -c "
import glob, json, os, sys
live, arch, new = sys.argv[1], sys.argv[2], sys.argv[3]
cands = [live] if os.path.isfile(live) else sorted(glob.glob(os.path.join(arch, '*.json')), key=os.path.getmtime, reverse=True)
old = None
for c in cands:
    try:
        old = json.load(open(c)).get('session', {}).get('decisions', [])
        break
    except Exception:
        continue
if not old:
    sys.exit(0)
lost = [d for d in old if isinstance(d, str) and d.startswith('[thread ') and json.dumps(d)[1:-1] not in new and d not in new]
if lost:
    print('WARNING: handoff rewrite drops %d [thread ...] decision(s) from the previous handoff:' % len(lost), file=sys.stderr)
    for d in lost:
        print('  - ' + d, file=sys.stderr)
" "$HANDOFF_FILE" "$VAULT/handoffs" "$CONTENT" || true

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
