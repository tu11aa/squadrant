#!/bin/bash
# reactor-cycle.sh — Run one full reaction cycle: poll → match → execute
# Usage: reactor-cycle.sh [reactions.json]
# This is what the reactor workspace calls on each poll interval.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REACTIONS_FILE="${1:-${HOME}/.config/cockpit/reactions.json}"
EVENTS_DIR="${HOME}/.config/cockpit/reactor-events"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")

mkdir -p "$EVENTS_DIR"

echo "━━━ Reactor Cycle: $(date '+%Y-%m-%d %H:%M:%S') ━━━"

# Step 1: Poll GitHub
echo "📡 Polling GitHub..."
EVENTS_FILE="${EVENTS_DIR}/events-${TIMESTAMP}.json"
if ! "$SCRIPTS_DIR/poll-github.sh" "$REACTIONS_FILE" > "$EVENTS_FILE" 2>/dev/null; then
  echo "⚠️  GitHub polling failed"
  rm -f "$EVENTS_FILE"
  exit 1
fi

EVENT_COUNT=$(python3 -c "import json; print(len(json.load(open('$EVENTS_FILE'))))" 2>/dev/null || echo "0")
echo "   Found ${EVENT_COUNT} events"

# Step 1.5: Auto-status poll — read captain panes, classify, write status.md
echo "📡 Polling captain panes (auto-status)..."
if command -v cockpit >/dev/null 2>&1; then
  cockpit reactor poll-status 2>&1 | sed 's/^/   /' || echo "   ⚠️  Auto-status poll failed (continuing)"
else
  echo "   ⚠️  cockpit CLI not on PATH — skipping auto-status"
fi

if [ "$EVENT_COUNT" = "0" ]; then
  echo "   No events to process"
  rm -f "$EVENTS_FILE"
  exit 0
fi

# Step 2: Poll captain status (internal events)
echo "📊 Checking captain status..."
CAPTAIN_EVENTS=$(python3 -c "
import json, os, glob
from datetime import datetime, timezone

config = json.load(open(os.path.expanduser('~/.config/cockpit/config.json')))
events = []
for name, proj in config.get('projects', {}).items():
    vault = proj.get('spokeVault', '')
    status_file = os.path.join(vault, 'status.md')
    if not os.path.exists(status_file):
        continue
    # Read frontmatter
    with open(status_file) as f:
        lines = f.readlines()
    in_fm = False
    fm = {}
    for line in lines:
        line = line.strip()
        if line == '---':
            if in_fm:
                break
            in_fm = True
            continue
        if in_fm and ':' in line:
            key, val = line.split(':', 1)
            fm[key.strip()] = val.strip().strip('\"')
    events.append({
        'type': 'captain-status',
        'project': name,
        'captain_session': fm.get('captain_session', 'inactive'),
        'last_updated': fm.get('last_updated', ''),
        'active_crew': int(fm.get('active_crew', 0)),
        'tasks_completed': int(fm.get('tasks_completed', 0)),
        'tasks_total': int(fm.get('tasks_total', 0)),
        'tasks_in_progress': int(fm.get('tasks_in_progress', 0)),
        'status_message': fm.get('last_status_message', '')
    })
print(json.dumps(events))
" 2>/dev/null || echo "[]")

# Merge captain status events into events file
python3 -c "
import json
with open('$EVENTS_FILE') as f:
    events = json.load(f)
captain_events = json.loads('''$CAPTAIN_EVENTS''')
events.extend(captain_events)
with open('$EVENTS_FILE', 'w') as f:
    json.dump(events, f, indent=2)
print(f'   Added {len(captain_events)} captain status events')
"

# Step 3: Match reactions
echo "🔍 Matching reactions..."
ACTIONS_FILE="${EVENTS_DIR}/actions-${TIMESTAMP}.json"
"$SCRIPTS_DIR/match-reactions.sh" "$EVENTS_FILE" "$REACTIONS_FILE" > "$ACTIONS_FILE"

ACTION_COUNT=$(python3 -c "import json; print(len(json.load(open('$ACTIONS_FILE'))))" 2>/dev/null || echo "0")
echo "   Matched ${ACTION_COUNT} actions"

if [ "$ACTION_COUNT" = "0" ]; then
  echo "   No actions to execute"
  rm -f "$EVENTS_FILE" "$ACTIONS_FILE"
  exit 0
fi

# Step 4: Execute each action
echo "⚡ Executing actions..."
python3 -c "
import json
actions = json.load(open('$ACTIONS_FILE'))
for i, action in enumerate(actions):
    path = '${EVENTS_DIR}/action-${TIMESTAMP}-' + str(i) + '.json'
    with open(path, 'w') as f:
        json.dump(action, f, indent=2)
    print(path)
" | while read -r ACTION_PATH; do
  echo "   → $(python3 -c "import json; a=json.load(open('$ACTION_PATH')); print(f\"{a['rule']}: {a['action']} → {a['project']} #{a.get('number','')}\")")"
  "$SCRIPTS_DIR/execute-reaction.sh" "$ACTION_PATH" 2>&1 | sed 's/^/     /'
  rm -f "$ACTION_PATH"
done

# Cleanup
rm -f "$EVENTS_FILE" "$ACTIONS_FILE"
echo "━━━ Cycle complete ━━━"
