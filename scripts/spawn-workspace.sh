#!/bin/bash
# Usage: spawn-workspace.sh <name> <cwd> [role] [--fresh]
# role: "captain" | "crew" | "command" (default: "captain")
# --fresh: force a new session instead of resuming
set -euo pipefail

CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"
TEMPLATES_DIR="${HOME}/.config/cockpit/templates"
SESSIONS_FILE="${HOME}/.config/cockpit/sessions.json"
NAME="${1:?Usage: spawn-workspace.sh <name> <cwd> [role] [--fresh]}"
CWD="${2:?Usage: spawn-workspace.sh <name> <cwd> [role] [--fresh]}"
ROLE="${3:-captain}"
FORCE_FRESH="${4:-}"

TODAY=$(date +"%Y-%m-%d")
FRESH=false

# --- Session freshness check ---
if [ "$FORCE_FRESH" = "--fresh" ]; then
  FRESH=true
elif [ -f "$SESSIONS_FILE" ]; then
  # Check last launch date
  LAST_DATE=$(python3 -c "
import json, sys
try:
    data = json.load(open('$SESSIONS_FILE'))
    print(data.get('workspaces', {}).get('$NAME', {}).get('lastLaunched', ''))
except: print('')
" 2>/dev/null)

  if [ -z "$LAST_DATE" ]; then
    FRESH=true  # first launch
  elif [ "$LAST_DATE" != "$TODAY" ]; then
    FRESH=true  # new day
    echo "↻ new day — starting fresh session for $NAME"
  fi

  # Check template + skills hash
  if [ "$FRESH" = "false" ]; then
    ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.claude.md"
    [ ! -f "$ROLE_FILE" ] && ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.CLAUDE.md"
    CURRENT_HASH=$(cat "$ROLE_FILE" "${HOME}/.config/cockpit/plugin/skills"/*/SKILL.md 2>/dev/null | shasum -a 256 | cut -c1-16)
    STORED_HASH=$(python3 -c "
import json
try:
    data = json.load(open('$SESSIONS_FILE'))
    print(data.get('workspaces', {}).get('$NAME', {}).get('templateHash', ''))
except: print('')
" 2>/dev/null)
    if [ -n "$CURRENT_HASH" ] && [ "$CURRENT_HASH" != "$STORED_HASH" ]; then
      FRESH=true
      echo "↻ template instructions updated — starting fresh session for $NAME"
    fi
  fi
else
  FRESH=true  # no sessions file yet
fi

# --- Record session ---
ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.claude.md"
[ ! -f "$ROLE_FILE" ] && ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.CLAUDE.md"
CURRENT_HASH=$(cat "$ROLE_FILE" "${HOME}/.config/cockpit/plugin/skills"/*/SKILL.md 2>/dev/null | shasum -a 256 | cut -c1-16)
python3 -c "
import json, os
path = '$SESSIONS_FILE'
try:
    data = json.load(open(path))
except: data = {'workspaces': {}}
data.setdefault('workspaces', {})['$NAME'] = {'lastLaunched': '$TODAY', 'templateHash': '$CURRENT_HASH'}
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(data, open(path, 'w'), indent=2)
" 2>/dev/null

# Read permission mode from config
PERM_MODE=$(python3 -c "
import json
try:
    cfg = json.load(open('${HOME}/.config/cockpit/config.json'))
    role_key = '$ROLE' if '$ROLE' in ('captain', 'command') else 'captain'
    print(cfg.get('defaults', {}).get('permissions', {}).get(role_key, 'default'))
except: print('default')
" 2>/dev/null)

# Read agent and model from roles config (new format), fall back to old models config
AGENT=$(python3 -c "
import json
try:
    cfg = json.load(open('${HOME}/.config/cockpit/config.json'))
    roles = cfg.get('defaults', {}).get('roles', {})
    role_cfg = roles.get('$ROLE', {})
    print(role_cfg.get('agent', 'claude'))
except: print('claude')
" 2>/dev/null)

MODEL=$(python3 -c "
import json
try:
    cfg = json.load(open('${HOME}/.config/cockpit/config.json'))
    roles = cfg.get('defaults', {}).get('roles', {})
    role_cfg = roles.get('$ROLE', {})
    model = role_cfg.get('model', '')
    if not model:
        model = cfg.get('defaults', {}).get('models', {}).get('$ROLE', '')
    print(model)
except: print('')
" 2>/dev/null)

# --- Build agent command based on resolved agent ---
case "$AGENT" in
  claude)
    if [ "$FRESH" = "true" ]; then
      AGENT_CMD="claude"
    else
      AGENT_CMD="claude -c"
    fi

    if [ "$PERM_MODE" = "acceptEdits" ]; then
      AGENT_CMD="${AGENT_CMD} --permission-mode acceptEdits"
    elif [ "$PERM_MODE" = "auto" ]; then
      AGENT_CMD="${AGENT_CMD} --permission-mode auto"
    elif [ "$PERM_MODE" = "bypassPermissions" ]; then
      AGENT_CMD="${AGENT_CMD} --dangerously-skip-permissions"
    fi

    if [ -n "$MODEL" ]; then
      AGENT_CMD="${AGENT_CMD} --model ${MODEL}"
    fi

    ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.claude.md"
    [ ! -f "$ROLE_FILE" ] && ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.CLAUDE.md"
    if [ -f "$ROLE_FILE" ]; then
      AGENT_CMD="${AGENT_CMD} --append-system-prompt-file ${ROLE_FILE}"
    fi

    PLUGIN_DIR="${HOME}/.config/cockpit/plugin"
    if [ -d "$PLUGIN_DIR" ]; then
      AGENT_CMD="${AGENT_CMD} --plugin-dir ${PLUGIN_DIR}"
    fi
    ;;

  codex)
    ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.generic.md"
    AGENT_CMD="codex exec --json --full-auto"
    if [ -f "$ROLE_FILE" ]; then
      AGENT_CMD="${AGENT_CMD} -p \"Read instructions from ${ROLE_FILE} and begin.\""
    fi
    ;;

  gemini)
    ROLE_FILE="${TEMPLATES_DIR}/${ROLE}.generic.md"
    AGENT_CMD="gemini --yolo"
    if [ -f "$ROLE_FILE" ]; then
      AGENT_CMD="${AGENT_CMD} -p \"Read instructions from ${ROLE_FILE} and begin.\""
    fi
    ;;

  *)
    echo "ERROR: Unknown agent '${AGENT}' for role '${ROLE}'"
    exit 1
    ;;
esac

# --- Handle existing workspace ---
# Find existing workspace via runtime abstraction
EXISTING_JSON=$(cockpit runtime list --json 2>/dev/null || echo "[]")
EXISTING_ID=$(echo "$EXISTING_JSON" | python3 -c "
import json,sys
try:
    for w in json.load(sys.stdin):
        if w.get('name') == '$NAME':
            print(w['id']); break
except: pass
")

if [ -n "$EXISTING_ID" ] && [ "$FRESH" = "true" ]; then
  echo "Closing stale workspace: $NAME"
  # select-workspace has no runtime abstraction yet — keeping direct cmux call here
  "$CMUX" close-workspace --workspace "$EXISTING_ID" 2>/dev/null || true
  EXISTING_ID=""
fi

if [ -n "$EXISTING_ID" ]; then
  echo "Workspace '$NAME' already exists — switching to it"
  # select-workspace has no runtime abstraction yet — keeping direct cmux call here
  "$CMUX" select-workspace --workspace "$EXISTING_ID" 2>&1
  exit 0
fi

# --- Spawn new workspace ---
CURRENT=$("$CMUX" current-workspace 2>&1 | awk '{print $1}')
NEW_UUID=$("$CMUX" new-workspace --command "$AGENT_CMD" --cwd "$CWD" 2>&1 | awk '{print $2}')
"$CMUX" rename-workspace --workspace "$NEW_UUID" "$NAME" 2>&1
if [ "$ROLE" = "command" ] || [ "$ROLE" = "captain" ]; then
  "$CMUX" workspace-action --workspace "$NEW_UUID" --action pin 2>/dev/null || true
fi
# Send initial prompt to trigger startup checklist (Claude agents only)
if [ "$AGENT" = "claude" ]; then
  if [ "$ROLE" = "captain" ]; then
    (sleep 3 && "$CMUX" send --workspace "$NEW_UUID" "Run your startup checklist: use the cockpit:captain-ops skill, complete all startup steps, then report ready." 2>/dev/null) &
  elif [ "$ROLE" = "command" ]; then
    (sleep 3 && "$CMUX" send --workspace "$NEW_UUID" "Run your startup checklist: use the cockpit:command-ops skill, complete your daily briefing, then report ready." 2>/dev/null) &
  fi
fi

"$CMUX" select-workspace --workspace "$CURRENT" 2>&1
echo "Spawned workspace: $NAME at $CWD (role: $ROLE, agent: $AGENT, fresh: $FRESH)"
