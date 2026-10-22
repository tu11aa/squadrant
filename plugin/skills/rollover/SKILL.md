---
name: rollover
description: Captain context getting full — write the handoff and daily log, then have squadrant /compact this session and resume from the handoff. Use when the user types /squadrant:rollover (or /squadrant:roll) or asks to roll over / compact this captain. Claude captains only.
---

# rollover — handoff → daily log → auto /compact → continue

Run once; the operator walks away. Claude Code cannot compact itself, so the daemon types `/compact` into this pane after your turn ends, and the SessionStart hook hands your handoff back afterwards.

## Steps (in order)

1. **Write a specific handoff** with `~/.config/squadrant/scripts/write-handoff.sh "{project}" '{…}'` (fields in `captain-ops` → Session Shutdown). Be concrete: `currentState` says what is in flight and where; `nextSteps` is the first actions to take, with PR/issue/crew ids; `decisions` lists what must not be revisited. Do not run `read-handoff.sh` — it would archive the file.
2. **Write today's daily log** with the `squadrant:daily-log` skill.
3. **Queue the compact as your LAST action:**
   ```bash
   squadrant captain compact {project}
   ```
   Optional `--focus "<text>"` replaces the default ("Keep the active task, open PRs/crews and decisions; the full state is in the handoff"). It returns immediately.
4. **End the turn with one short line** (e.g. "Handoff + log written; compacting."). Do nothing else — a running turn delays the compact, and the daemon never types over a busy pane or an open prompt (it gives up after 10 min and logs it).

After the compact, the handoff arrives as session context with "continue from nextSteps" — resume from it without asking the operator. `/compact` is a local command that starts no turn, so once it finishes the daemon sends you one captain message ("Compact finished — continue from the handoff's nextSteps.") to start it. Only compacts squadrant queued get this; a `/compact` typed by hand does not.
