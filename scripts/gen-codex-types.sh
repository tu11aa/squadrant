#!/usr/bin/env bash
# Regenerate the codex app-server protocol bindings.
# Requires codex-cli ≥0.130.0 on PATH.
# Output goes to vendor/ (outside src/) so tsc/tsup and GitNexus skip it.
set -euo pipefail
OUT="packages/agents/vendor/codex-protocol"
rm -rf "$OUT"
mkdir -p "$OUT"
codex app-server generate-ts --experimental --out "$OUT"
echo "Generated $OUT"
