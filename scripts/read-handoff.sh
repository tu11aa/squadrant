#!/bin/bash
# Usage: read-handoff.sh <project|workspace-path|spoke-vault-path> [--keep]
# Deprecated shim (#1155): the reader now lives in the CLI. Prints the JSON from
# `squadrant handoff read <project> [--keep]` (handoff + freshness verdict +
# sessionsToRead). Only the basename of the first arg is used (#983).
set -euo pipefail

TARGET="${1:?Usage: read-handoff.sh <project-or-vault-path> [--keep]}"
shift
exec squadrant handoff read "$(basename "$TARGET")" "$@"
