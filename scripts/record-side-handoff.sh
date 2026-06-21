#!/bin/bash
# Usage: record-side-handoff.sh <spoke-vault-path> <topic> <role> <summary>
# Writes a durable handoff record to {spokeVault}/side-handoffs/<topic-slug>.md
set -euo pipefail

VAULT="${1:?Usage: record-side-handoff.sh <vault-path> <topic> <role> <summary>}"
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
