#!/bin/bash
# Usage: record-side-handoff.sh <project|workspace-path|spoke-vault-path> <topic> <role> <summary>
# Writes a durable handoff record to workspace/<project>/side-handoffs/<topic-slug>.md
# (#983: was {spokeVault}/side-handoffs/). Only the basename of the first arg is used.
set -euo pipefail

TARGET="${1:?Usage: record-side-handoff.sh <project-or-vault-path> <topic> <role> <summary>}"
VAULT="${SQUADRANT_WORKSPACE_DIR:-$HOME/squadrant/workspace}/$(basename "$TARGET")"
TOPIC="${2:?}"
ROLE="${3:?}"
SUMMARY="${4:?}"
DATE=$(date +"%Y-%m-%d")
SLUG=$(echo "$TOPIC" | head -c 60 | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g')
FILENAME="${VAULT}/side-handoffs/${SLUG}.md"

mkdir -p "${VAULT}/side-handoffs"

cat > "$FILENAME" << EOF
---
type: side-handoff
role: ${ROLE}
date: ${DATE}
topic: ${TOPIC}
---

## Summary
${SUMMARY}

## Full handoff

(Appended by side-session — see squadrant relay for the captain's copy.)
EOF

echo "Recorded side handoff: $FILENAME"
