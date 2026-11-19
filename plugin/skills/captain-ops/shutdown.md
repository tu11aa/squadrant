# captain-ops reference: Session shutdown and rollover

_Read this before ending a session, writing the handoff or daily log, rolling over, or restarting. Part of the `captain-ops` skill; the trigger table is in `SKILL.md`._


## Session Shutdown (Opt-In Writes)

End-of-session writes are **opt-in**, not on a schedule. Only write what is meaningful:

1. **Daily log (opt-in):** if you accomplished something worth a daily log, use the `squadrant:daily-log` skill. Skip it if today was uneventful.
2. **Wiki promotion (opt-in):** if a learning crystallized into reusable knowledge, promote to a wiki page using `squadrant:wiki-ops`. Otherwise skip.
3. **Profile corrections (#982):** note any lasting correction or preference the operator gave this session ("don't do X", "always Y") that is true in every project and not recorded yet: `squadrant profile add --kind correction --apply --file -` (or `--kind preference --apply` for an explicit "save to my profile"). Echo the printed summary line so the operator can fix the wording. Project- or company-specific items go to that KB's rules instead. If the session-start block showed `Profile: N items pending review`, offer `squadrant profile review`: show every summary, then keep/drop by id.
4. **Handoff (opt-in but recommended for in-flight work):** if work is mid-flight, write a handoff so tomorrow's session can resume:

```bash
~/.config/squadrant/scripts/write-handoff.sh "{project}" '{
  "currentState": "Brief description of where things stand",
  "openBranches": ["feat/branch-name — what it contains"],
  "nextSteps": ["First thing to do tomorrow", "Second thing"],
  "blockedItems": ["Any unresolved blockers"],
  "decisions": ["Key decisions made this session that should not be revisited"],
  "activeTasks": "Summary of task progress (e.g., 3/7 done)"
}'
```

`write-handoff.sh` warns on stderr when a `[thread <id>] …` decision from the previous handoff is missing from the new content (it still writes).

If everything is shipped and there is no in-flight work, you do not need to write a handoff.

**Every handoff write consolidates (rollover and end of day alike).** `write-handoff.sh` replaces the whole file, so never just append. First read `handoff.json` if it exists, otherwise the newest file in `handoffs/` by mtime (`cat` or Read; never `read-handoff.sh`, it archives the file), then:
- Drop items that are done. Verify each against git, PRs and issues (`git log`, `gh pr view`, `gh issue view`); never guess. Keep anything you cannot verify.
- Merge duplicates and restate overlapping items once.
- Keep EVERY still-open item (`openBranches`, `nextSteps`, `blockedItems`) and EVERY decision in `decisions`, including all `[thread <id>] …` lines verbatim.

### Rollover (context getting full, Claude captains)

`/squadrant:rollover` (alias `/squadrant:roll`) does the three manual steps in one go: handoff + daily log → `squadrant captain compact {project}` (the daemon types `/compact` once your turn ends and the input box is clear) → after the compact, the SessionStart hook injects your latest handoff and you continue from `nextSteps`. The same re-injection happens for a `/compact` the operator types by hand.

**Restart vs rollover.** Rollover keeps the same session (compacted), so the system prompt does not change. `/squadrant:restart` (alias `/squadrant:rs`) replaces the session: handoff + daily log → `squadrant captain restart {project}` as the last action → a detached helper waits for your turn to end, closes this workspace and runs `launch {project} --fresh`; the new captain reads the handoff in its startup checklist. Use it when the operator changed your style, profile or template, or wants a clean session. Never run `launch {project} --fresh` from your own pane: it closes your workspace and dies half-way.

5. (Optional) If a Command session is running and you want to notify it:
   ```bash
   squadrant runtime send --command "Captain {project} ending session — handoff written."
   ```
   Skip this entirely if no Command session is up — Command is on-demand now.

**The handoff is your gift to tomorrow's session.** Be specific. "Working on the API" is useless. "Backend routes for /providers and /providers/:id are done, /timeseries endpoint is next, PR #12 is open for review" is useful.

#### When you see a rollover suggestion (#1015)

A line like `Context 182k ≥ 150k at a boundary (crew done). Good moment: write the handoff, then /squadrant:rollover.` is a **suggestion**, not an order and not automatic: squadrant never compacts you. It fires at a boundary (a crew finished, was closed, or its question was answered) when nothing is waiting on you.

- If you are between turns with no half-made decision, finish the state update for that boundary (ledger, handoff), then run `/squadrant:rollover`.
- If a decision is half-made or the operator is mid-thread, finish it first or record it as "unanswered, owner = captain" in the handoff. You can ignore the line; it will not repeat until context grows another 50k.
- A line starting `⚠ Context … ≥ hard limit` is the loud one (repeats every +100k). Roll over at the next safe point.
- `squadrant crew list` / `crew tasks` show each crew's `ctx`. When `crew send` prints `crew X at 210k; consider a fresh crew…`, prefer a fresh crew with a brief for a new track instead of reusing it.
- **Reusing a crew for a follow-up turn:** compact it first with `squadrant crew compact {project} <crew> [--keep "<what to keep>"]`. The daemon types `/compact` once the crew is idle; a `crew send` issued meanwhile waits and lands after the compact. Only on a captain or operator decision, never automatically. Refused for a crew under operator takeover and for codex/gemini crews (use a fresh crew there). `crew send` takes no `/compact` text: it arrives as a message and never runs the slash command.
