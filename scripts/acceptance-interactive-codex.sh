#!/usr/bin/env bash
# Manual acceptance walk-through for spec §4.10 (cockpit interactive codex).
# Run from the repo root after `npm run build`. Drives the full end-to-end
# flow including a daemon-bounce reattach.
set -euo pipefail

PROJECT="${PROJECT:-SMOKE}"
CWD="${CWD:-$(mktemp -d -t cockpit-iv-codex-XXXXXX)}"

echo "=== cockpit interactive-codex acceptance (spec §4.10) ==="
echo "Project: $PROJECT   cwd: $CWD"
echo

echo "=== 1. fresh build + relink ==="
npm run build
echo "    build OK"
echo

echo "=== 2. open a chat ==="
echo "    cockpit crew chat --provider codex --project $PROJECT --cwd $CWD"
echo
echo "Manually, in the opened cmux workspace tab:"
echo "  a. type: please write the string ACCEPT-OK to a file named demo.txt in the cwd"
echo "  b. when the [approval] prompt appears, answer with: approve"
echo "  c. wait for [done — type a follow-up or Ctrl-C], then type: thanks"
echo "  d. observe a second [done] line"
echo "  e. type: please run \"ls\" in this directory"
echo "  f. press Ctrl-C mid-turn to verify SIGINT → turn/interrupt round-trips"
echo
echo "Verify in the host shell:"
echo "  cockpit crew status $PROJECT <task-id>     # state is 'awaiting-input' (NOT 'done') after each turn"
echo "  cat $CWD/demo.txt                          # contains ACCEPT-OK"
echo

echo "=== 3. simulate daemon bounce in another shell ==="
echo "    launchctl kickstart -kp gui/\$(id -u)/com.cockpit.daemon"
echo
echo "Then check the cmux tab: expect a '(attached)' line within a few seconds"
echo "and that the next 'say' continues on the SAME thread (codex remembers the"
echo "earlier file write and 'thanks' exchange). This proves spec §5 / closes the"
echo "interactive-codex slice of #86."
echo

echo "=== 4. gate promotion (HITL slice, spec §4.9) ==="
echo "Open a new chat with --provider codex; ask codex to write a file in a path"
echo "that needs approval, then IMMEDIATELY close the cmux tab without answering."
echo "Wait 6 seconds, then run:"
echo "    cockpit crew status $PROJECT <task-id>"
echo "Expect 'gates' array containing one pending gate."
echo "Resolve from the Captain:"
echo "    cockpit crew reply $PROJECT <task-id> approve --gate <gateId>"
echo "Re-attach to verify the turn completes:"
echo "    cockpit crew attach <task-id>"
echo

echo "=== done — capture output to /tmp/iv-codex-acceptance.txt for the PR ==="
