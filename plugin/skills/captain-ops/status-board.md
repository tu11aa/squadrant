# captain-ops reference: Status board

_Read this before showing the status board or replying to a Telegram-originated task. Part of the `captain-ops` skill; the trigger table is in `SKILL.md`._


## Status Board (show after substantive turns)

After a **substantive turn** — shipped a release, opened or merged a PR, filed an issue, spawned or closed crews, or moved multiple threads at once — end your reply with a tight scannable board. Skip it after trivial answers; the board is signal, not noise.

### When to show

| Show | Skip |
|------|------|
| Opened / merged / closed a PR | Answered a quick question |
| Tagged a release or published to npm | Read a file or ran a status check |
| Filed a GitHub issue | Forwarded a one-line follow-up to an existing crew |
| Spawned or closed crew(s) | Repeated state the user just asked for |
| Multiple threads moved in one turn | |

### Pull state fresh before writing

No memory, no approximation — run these first:

```bash
gh pr list --state open --json number,title,headRefName,isDraft   # open PRs
squadrant crew list <project>                                      # live crews
gh release list --limit 3                                         # recent tags
npm view squadrant version 2>/dev/null                            # published version
```

### Board format

```
Right now → <one sentence: what just happened and what it unblocks>

✅ Done         <completed item — note what it unblocks>
✅ Done         <another if multiple>

⏳ In progress  <crew-name> — <task + current state: idle|working|blocked>
⏳ In progress  <another crew if running>

▶️ Next         <immediate next action — specific, actionable>
▶️ Next         <secondary if clear>

👀 Watch        PR #N — <title> (draft | ready | needs review)
👀 Watch        <release or deploy or issue to monitor>
```

### Rules

- **Live data only.** Run the commands above; do not recall from memory. A stale board is worse than no board.
- **~20–35 lines total.** Omit rows with nothing to say — an empty ⏳ section is just noise.
- **One punchline.** The `Right now →` line is one sentence capturing the net state change.
- **Portable.** Uses `gh` and `squadrant` CLI — works for claude, codex, opencode, and gemini crews alike.

### Replying to Telegram-originated tasks

When a task arrived from Telegram (captain pane received a message prefixed `[from Telegram]` / a `captain.message` inbound), push your answer back to that project's topic after acting:

```bash
squadrant telegram send <project> "<answer + brief board>"
```

**When to push:** At meaningful moments — your answer, a key decision, done/blocked. Not every line; keep it concise to avoid flooding the phone.

**What to include:** One sentence of answer or status, then a condensed board (3–5 lines: what happened, what's next, any blocker). Example:

```
Shipped fix for #42 — merged to develop.
✅ crew/fix-42 done  ▶️ next: bump version
```

**Portable:** uses the CLI only — works from any agent session (claude, codex, opencode, gemini).
