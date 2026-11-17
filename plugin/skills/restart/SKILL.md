---
name: restart
description: Restart this captain into a fresh session (new system prompt, e.g. after operator style or profile edits) — write the handoff and daily log, then have squadrant close this workspace and launch a fresh captain that resumes from the handoff. Use when the user types /squadrant:restart (or /squadrant:rs) or asks to restart / relaunch this captain fresh. Claude captains only.
---

# restart — handoff → daily log → fresh relaunch

Run once; the operator walks away. A captain cannot relaunch itself (`launch --fresh` closes this workspace and would kill the command half-way), so `squadrant captain restart` starts a detached helper outside this workspace. After your turn ends and no prompt is open, it runs `squadrant launch {project} --fresh`; the fresh captain loads the handoff in its startup checklist.

**Restart vs rollover:** restart = new session, new system prompt (operator style, profile, template changes take effect). Rollover (`/squadrant:rollover`) = same session, compacted.

## Steps (in order)

1. **Write a specific handoff** with `~/.config/squadrant/scripts/write-handoff.sh "{project}" '{…}'`. Same rules as rollover (`captain-ops` → Session Shutdown): read the current handoff first, drop verified-done items, merge duplicates, keep all open items and every decision including `[thread …]` lines. Be concrete: `currentState` says what is in flight and where; `nextSteps` is the first actions to take, with PR/issue/crew ids; `decisions` lists what must not be revisited. Do not run `read-handoff.sh`: it would archive the file before the fresh session reads it.
2. **Write today's daily log** with the `squadrant:daily-log` skill.
3. **Queue the restart as your LAST action:**
   ```bash
   squadrant captain restart {project} --focus
   ```
   Drop `--focus` when the operator is not watching this workspace (it switches cmux to the new captain once it is up). It returns immediately and prints the helper's log path. A second request while one is pending is refused with a "already pending" line, which is fine.
4. **End the turn with one short line** in the operator's language (e.g. that the handoff and log are written and the captain is restarting). Do nothing else: a running turn or an open prompt delays the restart, and the helper gives up after 10 min (it then tells you and the operator, and nothing is restarted).

Crews keep running across the restart; the fresh captain sees them through `squadrant crew list` and the handoff.
