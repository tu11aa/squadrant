---
name: captain-ops
description: Captain playbook core — the trigger table (which reference file to read before each action) and the few rules that live only here. Read the reference file for an action before doing it; startup itself is in captain-startup.
---

# Captain Operations (core)

Hard rules live in your system prompt (the captain template). Reference files sit next to this SKILL.md; in a text projection (AGENTS.md and similar) they follow below as "Reference: <file>". Read the one a row names **before** the action.

## Trigger table (the one source)

| Before you… | Read first | Also |
|---|---|---|
| spawn a crew, send a follow-up, inspect or close a crew, pick agent / model / effort | `spawning.md` | `squadrant:add-pick-crew-rule` (routing rules), `squadrant:set-effort` (effort dial) |
| write a brief for a non-trivial task | `briefs.md` | `squadrant:prompt-master` |
| react to CREW IDLE / BLOCKED / QUIET / STALLED, or check crew status | `coordination.md` | |
| answer a crew question, open or resume a thread, relay an operator answer | `question-triage.md` | |
| review CREW REVIEW / DONE, approve, merge, close a finished crew, live-check a branch build | `review-gate.md` | `squadrant:karpathy-principles`, `squadrant:rules-ops` (grade rules), `squadrant:human-review-guide` (operator reviews by hand) |
| show the status board, answer a Telegram-originated task | `status-board.md` | |
| end the day, write the handoff or daily log, roll over, restart | `shutdown.md` | `squadrant:daily-log`, `squadrant:wiki-ops`, `squadrant:rollover` (`roll`), `squadrant:restart` (`rs`) |
| look up KB rules, record a learning, compile the wiki, load past learnings, capture a skill | `knowledge.md` | `squadrant:rules-ops`, `squadrant:wiki-ops` |
| touch a sibling project, or send a ping or dispatch | `cross-project.md` | |

## Rules that live only here

- **Never poll crew screens in a loop** (no `until`, no unbounded sleep). The daemon delivers crew events (idle / done / blocked) to your pane; wait for them. One on-demand `crew read` is fine.
- **Never `crew close` a crew in `review` state** (unpushed work is discarded), and never re-send the original task to a crew that looks finished: read its screen or diff first.
- **Never emit `task.done` yourself**; terminalize only through `squadrant crew approve`, after the operator's go-ahead.
- Crew lifecycle events reach your pane without any relay setup (daemon-direct cmux delivery, #332).
- Startup context beyond the contract is opt-in: claude-mem search for the project name, the latest file in `~/squadrant/workspace/{project}/artifacts/daily-logs/`, matching `{spokeVault}/learnings/`, and `{spokeVault}/skills/` and `{spokeVault}/wiki/` (see `knowledge.md`).
