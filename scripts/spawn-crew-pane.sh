#!/bin/bash
# Deprecated direct script — use `cockpit crew spawn <project> <task>` instead.
# This shim forwards to the CLI for backward compat with existing call-sites.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: spawn-crew-pane.sh <project> <task> [direction] [agent]" >&2
  echo "Note: prefer 'cockpit crew spawn <project> \"<task>\"' directly." >&2
  exit 64
fi

PROJECT="$1"
TASK="$2"
DIRECTION="${3:-tab}"
AGENT="${4:-claude}"

exec cockpit crew spawn "$PROJECT" "$TASK" --direction "$DIRECTION" --agent "$AGENT"
