---
name: captain-ops
description: Complete captain playbook — session startup, crew spawning, status writing, group awareness, and learnings. Use this skill at session start and reference it throughout.
---

# Captain Operations

## Session Startup

1. Read `~/.config/squadrant/config.json` — match your current working directory. Note your `spokeVault`, `group`, `groupRole`, and `maxCrew` (default: 5).
2. **Check for handoff from previous session:**
```bash
~/.config/squadrant/scripts/read-handoff.sh "{spokeVaultPath}"
```
If a handoff exists (`"exists"` is not false), read the context carefully:
- `currentState` — what was happening when the last session ended
- `openBranches` — branches with uncommitted/unmerged work
- `nextSteps` — what the previous session planned to do next
- `blockedItems` — unresolved blockers
- `decisions` — important decisions already made (don't re-decide)
The handoff file is auto-deleted after reading. Use this as your primary context source.
3. Search **claude-mem** (`mem-search` skill) for your project name to get additional continuity.
4. Check `{spokeVault}/daily-logs/` — read the most recent log if one exists.
5. Check `{spokeVault}/learnings/` — **selectively** load relevant learnings (see "Selective Loading" section below). Do NOT read all files — grep by task keywords and tags.
6. Check `{spokeVault}/skills/` — if any captured skills match your current task, load them for crew reference.
7. Check `{spokeVault}/wiki/` — query wiki for keywords related to your current task:
```bash
~/.config/squadrant/scripts/wiki-query.sh "{spokeVaultPath}" "{relevant-keyword}" --titles-only
```
If relevant pages exist, read them for context before starting work.
8. Crew lifecycle events (done / blocked / idle) are delivered to your captain pane automatically by the squadrant daemon via daemon-direct cmux delivery (#332). No relay setup required.

9. (Opt-in) Status writes are not required on every event. Only run `~/.config/squadrant/scripts/write-status.sh` when you have a meaningful note worth recording (a blocker, a deliberate "starting work on X", etc.) — not on a schedule.

## Crew Setup

You do NOT create an Agent Team. You spawn each crew session on demand as a **new tab** in your workspace via `squadrant crew spawn` (use `--direction right|down|...` to split into a pane instead). The surface is a fresh CLI session with the crew template loaded as system prompt — disposable, restartable, runtime-agnostic.

You don't need to create or persist anything up front. Each `squadrant crew spawn` call creates a new surface.

## Task Decomposition with Task Master

When you receive a **PRD, large feature request, or multi-step scope** from command, use **Task Master MCP** to decompose it before spawning crew.

### If a PRD file exists in the project:
```
mcp__task-master-ai__parse_prd(input: ".taskmaster/docs/prd.txt", projectRoot: "{projectPath}")
```
This generates `tasks.json` with structured tasks, dependencies, and complexity scores.

### Query tasks:
```
mcp__task-master-ai__get_tasks(projectRoot: "{projectPath}")           # List all tasks
mcp__task-master-ai__next_task(projectRoot: "{projectPath}")           # Get highest-priority unblocked task
mcp__task-master-ai__get_task(id: "1", projectRoot: "{projectPath}")   # Get specific task details
```

### Update task status as crew works:
```
mcp__task-master-ai__set_task_status(id: "1", status: "in-progress", projectRoot: "{projectPath}")
mcp__task-master-ai__set_task_status(id: "1", status: "done", projectRoot: "{projectPath}")
```

### Expand complex tasks into subtasks:
```
mcp__task-master-ai__expand_task(id: "1", projectRoot: "{projectPath}")
```

### Workflow:
1. Receive scope from command → **parse PRD** (or manually create tasks if no PRD file)
2. **get_tasks** to see the full dependency graph
3. **next_task** to find what's unblocked and highest priority
4. Spawn crew for that task
5. When crew finishes → **set_task_status** to "done" → **next_task** for the next one
6. Repeat until all tasks are done

**Note:** Task Master requires an AI provider API key (ANTHROPIC_API_KEY) for `parse_prd` and `expand_task`. If unavailable, create tasks manually using the project's task breakdown file (e.g., `pact-network-tasks.md`) and use Task Master only for status tracking.

## Spawning Crew

**You MUST spawn a crew session for ANY coding task** — even a one-line change. You are a coordinator. You plan, delegate, review, and merge. You do NOT write code yourself.

A crew is an **interactive Claude sub-session** running in a tab inside your workspace, named `crew-1`, `crew-2`, … (or a name you pick). It stays idle between turns waiting for your next message — same model as a Claude Agent Team subagent.

### Spawn a NEW crew

```bash
squadrant crew spawn <project> "<task description>" \
    [--name <name>] \
    [--direction tab|right|left|up|down] \
    [--agent claude|codex|gemini|opencode]
```

What it does:
1. Opens a new **tab** in the captain workspace (use `--direction right|left|up|down` to split into a pane instead).
2. Names the tab `🔧 <project>:<name>` — `--name` is optional; auto-picks the next free `crew-N`.
3. Boots an interactive Claude session (no `-p`) with `crew.<agent>.md` loaded as system prompt.
4. Sends your task as the first turn. The crew works on it and then **stays idle** waiting for follow-ups.

### Send a FOLLOW-UP to an existing crew

DO NOT spawn a new crew for every turn — that's how you get tab pollution. Use `send`:

```bash
squadrant crew send <project> <name> "<message>"
```

### Inspect & shutdown

```bash
squadrant crew list <project>                 # see all live crews for the project
squadrant crew tasks <project>                # compact task listing (use --json for verbose)
squadrant crew tasks <project> --state-only <id>  # fast state check (prints one word)
squadrant crew read <project> <name>          # read tail of a crew's screen (~40 lines)
squadrant crew read <project> <name> --full   # entire scrollback (may be large)
squadrant crew read <project> <name> --lines 100  # custom tail length
squadrant crew close <project> <name>         # shutdown the crew (closes its tab)
```

### Examples

Spawn a fresh crew (auto-named `crew-1`):
```bash
squadrant crew spawn brove "Add preinstall hook to package.json. Branch: feat/preinstall."
```

Named crew for a specific work track:
```bash
squadrant crew spawn brove "Refactor src/api/handlers.ts" --name api-refactor --agent codex
```

Send a follow-up turn:
```bash
squadrant crew send brove crew-1 "Also wire that into the install script"
```

Open as a side-by-side pane when you want live preview:
```bash
squadrant crew spawn brove "Fix typo in README" --direction right
```

### Leveled crew routing

When you spawn a crew without an explicit `--agent` or `--model`, squadrant automatically
consults the routing rules in `defaults.crewRouting.rules` (config.json) and picks the
right tier for the task:

| Tier | Matches | Routes to |
|------|---------|-----------|
| extreme | redesign, architect, rewrite, from scratch | claude/opus |
| hard | refactor, migrate, implement, feature | claude/sonnet |
| mobile | mobile, ios, swift, android, kotlin | codex |
| daily | typo, rename, bump, docs, lint | opencode |

The chosen route is printed as a dim one-liner before the spawn completes, e.g.:
```
routed: tier=hard → claude/sonnet (rule: "refactor|migrate|implement|feature|daemon|control-plane")
```

**Override at any time** — explicit flags always win over routing:
```bash
squadrant crew spawn brove "refactor auth" --agent codex     # forces codex despite "hard" tier
squadrant crew spawn brove "fix typo" --model opus           # forces opus despite "daily" tier
```

To add, edit, or remove routing rules: use the `squadrant:add-pick-crew-rule` skill.

### Effort mode

Before spawning a crew, read `defaults.effort` from `~/.config/squadrant/config.json` (run `squadrant effort` to check). Apply the following bias to your crew agent/model choice:

| Mode | Directive |
|------|-----------|
| **max** | Tokens are plentiful. Prefer claude/opus for crew spawns; don't downshift for cost. |
| **balance** | Normal. Use default crew routing rules unchanged. (Absent field = balance.) |
| **low** | Conserve tokens. Prefer opencode/sonnet for crews; reserve opus for work that genuinely needs it. |

**Effort is crew-only.** Captain, command, and side roles are unaffected — keep them at their configured model regardless of effort.

**Effort is the weakest signal.** An explicit `--agent` / `--model` on a spawn always wins. Effort only nudges your default choice when nothing more specific applies.

To change the effort dial: `squadrant effort <max|balance|low>` or use the `squadrant:set-effort` skill.

### Rules

- **Reuse with `send` before spawning a new one.** Same task track, same crew. New track = new crew.
- **Close crews you're done with** (`squadrant crew close ...`) so they don't accumulate.
- Crews run in **isolated worktrees by default** (parallel-safe, branch per crew). Pass `--shared` only for tiny/one-off tasks that don't need branch isolation. Never hand-run `git worktree add` — `squadrant crew spawn` handles it.
- Do NOT edit source code yourself — always delegate to crew.
- Respect `maxCrew` — don't exceed the configured concurrent crew count.
- **For complex multi-step tasks** (3+ steps, multiple files), tell the crew to use GSD inside the task prompt: *"This is a complex task. Use `/gsd:plan-phase` and `/gsd:execute-phase` for wave-based execution with fresh context per step."*
- **For simple tasks**, don't mention GSD — the crew will handle it directly.

> codex crews are fully interactive (parity with claude/opencode) — `send` reaches them for follow-up turns (verified live 2026-07-02). gemini currently still launches in print-mode (one-shot) rather than as an interactive session; `send` won't reach it yet.

## Task Coordination

**HARD RULE: Do NOT poll crew screens in a loop.** Crew lifecycle events (idle / done / blocked) are delivered to your captain pane automatically by the squadrant daemon — trust the daemon signal. Polling loops hang indefinitely, exhaust context, and mask real blockers.

You don't have an Agent Team or `TaskCreate`/`TaskUpdate` tools — those were Claude-specific. When you need crew status:
1. **Wait for the daemon to notify you.** When a crew finishes, signals blocked, or goes idle, the daemon delivers the event to your captain pane via daemon-direct cmux delivery. This is the primary mechanism — do not replace it with polling.
2. `squadrant crew read <project> <name>` — **on-demand spot-check only** (a single read when you have a specific reason, e.g. reviewing a finished diff). Never in a loop, never with `until`.
3. `squadrant crew tasks <project>` — **on-demand** compact task listing; `--id <prefix>` to filter; `--state-only <id>` for a single-word state check.
4. `squadrant crew list <project>` — see all live crews and pick the right one.
5. Inspecting the crew tab visually in cmux when you want richer context (you have its surface ref from the spawn output).
6. Asking the user to check the dashboard if you need a cross-project view (see issue #44).

If you ever need a bounded check (not a loop), use a fixed counter (≤ 3 attempts with a sleep between), or watch the mailbox seq — never an unbounded `until` loop.

### Handling CREW IDLE

CREW IDLE is **ambiguous** — the watchdog did not detect a heartbeat, which can happen when:
- **(a)** The crew finished but never ran `squadrant crew signal done` (issue #278 — common for claude/opencode before the completion-protocol fix).
- **(b)** The crew is genuinely waiting for the captain (asked a question or needs a decision).
- **(c)** The crew is still mid-task and the idle pulse was transient.

On CREW IDLE, do a **single on-demand spot-check** (allowed — not a polling loop), then classify:

| Spot-check shows | Captain action |
|-----------------|----------------|
| Completed work (PR opened, commits pushed, results reported) but no CREW DONE | Treat as the #278 case — review; if good, terminalize (`merge` + `crew close`). If not actually done, **re-task**: send the next instruction via `crew send` (the #148 re-open flow). |
| Crew asked a question or is waiting for a decision | Respond via `crew send`. Do NOT terminalize — it will signal done after the next turn. |
| Still mid-task / transient idle | Leave it; wait for the next daemon event. |

**Do not re-send the original task** if the crew appears to have completed it — that triggers a duplicate run. Read the crew screen or diff first, then decide: terminalize vs re-task vs leave.

This is the captain-side backstop: even if the completion-protocol imperative is skipped, the lifecycle still terminalizes because the captain classifies intent instead of letting the task strand at IDLE.

When a crew sends you a status message via `squadrant runtime send <project> "<message>"`, it lands in your captain pane. Acknowledge, then update your handoff if a meaningful decision was made.

## When Crew Finishes

After a crew task completes:

1. Review the work — read the diff, check the branch.
2. Merge their branch if appropriate.
3. Close the crew with `squadrant crew close <project> <name>` once the work track is done. (Or let the crew exit itself — the tab closes when the CLI ends.)
4. After closing a crew, VERIFY no orphaned processes remain — e.g. `pgrep -fl vitest` and check for stray dev servers / node test workers; kill any leftovers. Do NOT run the full test suite repeatedly or concurrently across worktrees (a single `vitest run` spawns a ~per-CPU worker pool that uses gigabytes; several at once exhaust RAM). Prefer one verification on the authoritative checkout.
5. Record learnings if any (see "Recording Learnings" below).
6. Update your handoff if the work shifts the next-step plan (see "Session Shutdown — Write Handoff" below).

Status writes (`write-status.sh`) are opt-in; you don't need to write status after every event.

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

## Session Shutdown (Opt-In Writes)

End-of-session writes are **opt-in**, not on a schedule. Only write what is meaningful:

1. **Daily log (opt-in):** if you accomplished something worth a daily log, use the `squadrant:daily-log` skill. Skip it if today was uneventful.
2. **Wiki promotion (opt-in):** if a learning crystallized into reusable knowledge, promote to a wiki page using `squadrant:wiki-ops`. Otherwise skip.
3. **Handoff (opt-in but recommended for in-flight work):** if work is mid-flight, write a handoff so tomorrow's session can resume:

```bash
~/.config/squadrant/scripts/write-handoff.sh "{spokeVaultPath}" '{
  "currentState": "Brief description of where things stand",
  "openBranches": ["feat/branch-name — what it contains"],
  "nextSteps": ["First thing to do tomorrow", "Second thing"],
  "blockedItems": ["Any unresolved blockers"],
  "decisions": ["Key decisions made this session that should not be revisited"],
  "activeTasks": "Summary of task progress (e.g., 3/7 done)"
}'
```

If everything is shipped and there is no in-flight work, you do not need to write a handoff.

4. (Optional) If a Command session is running and you want to notify it:
   ```bash
   squadrant runtime send --command "Captain {project} ending session — handoff written."
   ```
   Skip this entirely if no Command session is up — Command is on-demand now.

**The handoff is your gift to tomorrow's session.** Be specific. "Working on the API" is useless. "Backend routes for /providers and /providers/:id are done, /timeseries endpoint is next, PR #12 is open for review" is useful.

## Group Awareness

If your config has `group` / `groupRole`:
- Read full config to find sibling projects with the same `group`
- If your change might affect a sibling, **flag it to command** so it can notify the sibling's captain
- Use **claude-mem** to search for context from sibling projects
- `primary` role: your changes may need propagation to forks/dependents

## Cross-Project Delegation

Two commands reach **any registered project** — not just siblings in your group. Group membership is extra guarantees on top, not a requirement to reach a project at all.

- **`squadrant ping <project> "<msg>"`** — fire-and-forget. Delivers a message straight into the target's captain pane. No tracked task, no report-back. Use for a heads-up, FYI, or a question you don't need answered structurally.
- **`squadrant dispatch <project> "<task>"`** — tracked. Records a task on the target project, notifies its captain, and reports the outcome back to your mailbox when it settles. (`squadrant group dispatch` is a **deprecated alias** for this — same underlying machinery, keep using `squadrant dispatch` going forward.)

### Rules

1. **Unregistered project → clear error.** Both commands validate the project exists in config before doing anything.
2. **`acceptDelegations`.** If the target's project config has `acceptDelegations: false`, `dispatch` rejects with a clear error — this applies regardless of group. The default is `true`.
3. **Boot-if-down is a same-group guarantee.** If the target is in your group and its captain isn't running, `dispatch` boots it (`squadrant launch <project>`) and waits for warmup with a bounded poll (120s hard timeout). **Cross-group, dispatch does NOT auto-boot** a down captain — it fails fast with an error suggesting `ping` or starting it manually with `squadrant launch <project>`, then retry. Once a target captain is up, cross-group and same-group dispatch behave the same.

### Dispatch-and-yield (do NOT poll)

Once the task is recorded to the daemon, `dispatch` **returns immediately**. The target's captain auto-accepts (because `acceptDelegations` is true) and spawns a crew. When the task settles — done, blocked, or failed — the daemon fans the outcome back to **your** mailbox automatically. The daemon wakes you up. **You never poll the target.**

HARD RULE: Do NOT add a polling loop after `dispatch`. The report-back is event-driven; trust it.

### Report-back format

| Settlement | Message |
|------------|---------|
| done | `✅ Cross-project task → B: done — <task snippet>` |
| blocked | `⛔ Cross-project task → B: blocked — <question>` |
| failed | `⛔ Cross-project task → B: failed — <error>` |
| stalled | `⚠️ Cross-project task → B: stalled (no heartbeat)` |

### Example

```bash
# You are captain of "scaffold-stylus". Ask the docs sibling to update docs.
squadrant group dispatch scaffold-stylus-docs "Document the new --format flag added in PR #42"
# → "✔ Dispatched to 'scaffold-stylus-docs' (task abc12345)"
# → (returns immediately; you are notified when settled)
```

## Recording Learnings

Recording learnings is **opt-in**. Record when something genuinely surprised you or a useful pattern emerged — not on a schedule.

Record after tasks complete, unexpected issues, or discovered patterns:
```bash
~/.config/squadrant/scripts/record-learning.sh "{spokeVaultPath}" "{category}" "{description}" "{tags}"
```
- Categories: `workflow`, `template`, `convention`, `bug`, `insight`
- Tags: comma-separated keywords for selective loading (e.g., `cairo,escrow,pvp`)

## Wiki Compilation

Wiki writes are **opt-in**. Compile knowledge when you have something worth recording — not on a schedule. Use the `squadrant:wiki-ops` skill for full instructions.

1. **After each task**: If you learned how something works, create/update a wiki page
2. **During session shutdown**: Review today's learnings — promote useful ones to wiki pages
3. **Before starting work**: Query the wiki for relevant context:
```bash
~/.config/squadrant/scripts/wiki-query.sh "{spokeVaultPath}" "{task-keywords}"
```

**Learnings vs Wiki**: Learnings are raw observations (quick to record). Wiki pages are compiled, structured knowledge (worth maintaining). Promote a learning when it's been useful 2+ times or represents how a system works.

## Selective Loading (on session start)

Do NOT read all learnings. Instead, filter by relevance:
1. `grep -rl` your current task keywords in `{spokeVault}/learnings/` 
2. Also check for learnings tagged with your current branch name or feature area
3. Only read the matching files — skip the rest
4. For each learning you load, increment its `times_loaded` counter
5. If a learning actually helps your current work, run:
```bash
~/.config/squadrant/scripts/mark-learning-useful.sh "{learning-file-path}"
```

Learnings with `times_loaded > 5` and `times_useful: 0` are stale — ignore them.

## Capturing Skills (CAPTURED — from OpenSpace)

After a crew member completes a task that used a **novel or reusable pattern**, capture it as a skill:
```bash
~/.config/squadrant/scripts/capture-skill.sh "{spokeVaultPath}" "{skill-name}" "{one-line description}" "{full markdown body}"
```

**When to capture:**
- A task required a multi-step workflow that could apply to future tasks
- A crew member discovered a useful tool chain or command sequence
- A pattern emerged across 2+ similar tasks

**Don't capture** trivial one-off fixes or project-specific config.

Captured skills live in `{spokeVault}/skills/{name}/SKILL.md` and can be referenced by future crew members.

## Fixing Skills (FIX — from OpenSpace)

When a learning identifies that an existing skill's instructions are **wrong or outdated**:
```bash
~/.config/squadrant/scripts/fix-skill.sh "{spokeVaultPath}" "{skill-name}" "{corrected markdown body}"
```

This backs up the old version and writes the fix. Use when:
- A captured skill led to a failed task
- Instructions in a skill are now incorrect due to project changes
- A workaround in a skill is no longer needed

## Quality Tracking

Each learning and captured skill tracks:
- `times_loaded` — how often it was read into context
- `times_useful` — how often it actually helped (agent marks it)
- `times_used` / `times_successful` — for captured skills

Use these metrics to prune stale knowledge:
- Learning loaded 5+ times but never useful → skip it
- Skill used 3+ times but never successful → flag for FIX or removal
