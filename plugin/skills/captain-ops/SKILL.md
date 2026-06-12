---
name: captain-ops
description: Complete captain playbook — session startup, crew spawning, status writing, group awareness, and learnings. Use this skill at session start and reference it throughout.
---

# Captain Operations

## Session Startup

1. Read `~/.config/cockpit/config.json` — match your current working directory. Note your `spokeVault`, `group`, `groupRole`, and `maxCrew` (default: 5).
2. **Check for handoff from previous session:**
```bash
~/.config/cockpit/scripts/read-handoff.sh "{spokeVaultPath}"
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
~/.config/cockpit/scripts/wiki-query.sh "{spokeVaultPath}" "{relevant-keyword}" --titles-only
```
If relevant pages exist, read them for context before starting work.
8. **Own your relay (#240):** Launch the notify-relay supervisor as a `run_in_background` process on session start:
   ```bash
   cockpit relay supervise <project> --as captain
   ```
   The supervisor handles boot-race retry in-process (3s backoff) and returns once the relay is booted; after that the relay runs on its own setInterval timers. Whole-process death (crash / SIGTERM / captain restart) is recovered by the `run_in_background` harness — when it reports the process exited, relaunch it with brief backoff.

   **Why this closes the tab-death gap:** Previously the relay ran in a separate cmux tab (`✉ notify-relay`) that could be killed independently, leaving the captain silently blind to crew events. Now it is a single PID inside the captain's process tree. The loop only retries the boot race (which is the most common exit of the relay); post-boot crashes are handled by the harness relaunch because the relay's own drain/probe intervals catch their errors internally and never throw out of the process.

   **Secondary seam:** The daemon healer (`createRelayHealer` in relay-healer.ts) remains the secondary recovery path (#207) — it tries to re-spawn the relay tab on sweep, but cmux lineage enforcement means it mostly logs from launchd. The primary recovery is the captain's `run_in_background` ownership.

9. (Opt-in) Status writes are not required on every event. Only run `~/.config/cockpit/scripts/write-status.sh` when you have a meaningful note worth recording (a blocker, a deliberate "starting work on X", etc.) — not on a schedule.

## Crew Setup

You do NOT create an Agent Team. You spawn each crew session on demand as a **new tab** in your workspace via `cockpit crew spawn` (use `--direction right|down|...` to split into a pane instead). The surface is a fresh CLI session with the crew template loaded as system prompt — disposable, restartable, runtime-agnostic.

You don't need to create or persist anything up front. Each `cockpit crew spawn` call creates a new surface.

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
cockpit crew spawn <project> "<task description>" \
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
cockpit crew send <project> <name> "<message>"
```

### Inspect & shutdown

```bash
cockpit crew list <project>                 # see all live crews for the project
cockpit crew tasks <project>                # compact task listing (use --json for verbose)
cockpit crew tasks <project> --state-only <id>  # fast state check (prints one word)
cockpit crew read <project> <name>          # read tail of a crew's screen (~40 lines)
cockpit crew read <project> <name> --full   # entire scrollback (may be large)
cockpit crew read <project> <name> --lines 100  # custom tail length
cockpit crew close <project> <name>         # shutdown the crew (closes its tab)
```

### Examples

Spawn a fresh crew (auto-named `crew-1`):
```bash
cockpit crew spawn brove "Add preinstall hook to package.json. Branch: feat/preinstall."
```

Named crew for a specific work track:
```bash
cockpit crew spawn brove "Refactor src/api/handlers.ts" --name api-refactor --agent codex
```

Send a follow-up turn:
```bash
cockpit crew send brove crew-1 "Also wire that into the install script"
```

Open as a side-by-side pane when you want live preview:
```bash
cockpit crew spawn brove "Fix typo in README" --direction right
```

### Rules

- **Reuse with `send` before spawning a new one.** Same task track, same crew. New track = new crew.
- **Close crews you're done with** (`cockpit crew close ...`) so they don't accumulate.
- Do NOT manually run `git worktree add`. The crew operates in the captain's checkout. If a task genuinely requires worktree isolation, ask the user.
- Do NOT edit source code yourself — always delegate to crew.
- Respect `maxCrew` — don't exceed the configured concurrent crew count.
- **For complex multi-step tasks** (3+ steps, multiple files), tell the crew to use GSD inside the task prompt: *"This is a complex task. Use `/gsd:plan-phase` and `/gsd:execute-phase` for wave-based execution with fresh context per step."*
- **For simple tasks**, don't mention GSD — the crew will handle it directly.

> Non-Claude agents (codex / gemini) currently still launch in print-mode (one-shot) rather than as interactive sessions; `send` won't reach them yet. Prefer Claude crews when you want multi-turn dialogue.

## Task Coordination

You don't have an Agent Team or `TaskCreate`/`TaskUpdate` tools — those were Claude-specific. Track crew progress by:
1. `cockpit crew read <project> <name>` — read tail of a crew's screen (default ~40 lines; `--full` for entire scrollback).
2. `cockpit crew tasks <project>` — compact task listing (one line per task); `--id <prefix>` to filter; `--state-only <id>` for single-word state.
3. `cockpit crew list <project>` — see all live crews and pick the right one.
4. Inspecting the crew tab visually in cmux when you want richer context (you have its surface ref from the spawn output).
5. Asking the user to check the dashboard if you need a cross-project view (see issue #44).

When a crew sends you a status message via `cockpit runtime send <project> "<message>"`, it lands in your captain pane. Acknowledge, then update your handoff if a meaningful decision was made.

## When Crew Finishes

After a crew task completes:

1. Review the work — read the diff, check the branch.
2. Merge their branch if appropriate.
3. Close the crew with `cockpit crew close <project> <name>` once the work track is done. (Or let the crew exit itself — the tab closes when the CLI ends.)
4. After closing a crew, VERIFY no orphaned processes remain — e.g. `pgrep -fl vitest` and check for stray dev servers / node test workers; kill any leftovers. Do NOT run the full test suite repeatedly or concurrently across worktrees (a single `vitest run` spawns a ~per-CPU worker pool that uses gigabytes; several at once exhaust RAM). Prefer one verification on the authoritative checkout.
5. Record learnings if any (see "Recording Learnings" below).
6. Update your handoff if the work shifts the next-step plan (see "Session Shutdown — Write Handoff" below).

Status writes (`write-status.sh`) are opt-in; you don't need to write status after every event.

## Session Shutdown (Opt-In Writes)

End-of-session writes are **opt-in**, not on a schedule. Only write what is meaningful:

1. **Daily log (opt-in):** if you accomplished something worth a daily log, use the `cockpit:daily-log` skill. Skip it if today was uneventful.
2. **Wiki promotion (opt-in):** if a learning crystallized into reusable knowledge, promote to a wiki page using `cockpit:wiki-ops`. Otherwise skip.
3. **Handoff (opt-in but recommended for in-flight work):** if work is mid-flight, write a handoff so tomorrow's session can resume:

```bash
~/.config/cockpit/scripts/write-handoff.sh "{spokeVaultPath}" '{
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
   cockpit runtime send --command "Captain {project} ending session — handoff written."
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

When a task genuinely belongs to a sibling project in the same group, use **`cockpit group dispatch <to-project> '<task>'`** instead of hand-writing a message. This records a tracked task on the sibling's project and auto-wakes its captain via the existing mailbox/relay.

### Rules

1. **Same-group only.** `group dispatch` rejects any target whose `group` field differs from yours. Cross-group dispatch is out of scope — use claude-mem / wiki queries for awareness.
2. **`acceptDelegations`.** If the sibling's project config has `acceptDelegations: false`, the command rejects with a clear error. The default is `true`.
3. **Boot-if-down.** If the sibling's captain workspace / notify-relay are not running, `group dispatch` boots them (`cockpit launch <project>`) and waits for warmup with a bounded poll (30s hard timeout). If warmup fails, the dispatch is rejected (task not recorded).

### Dispatch-and-yield (do NOT poll)

Once the task is recorded to the daemon, `group dispatch` **returns immediately**. The sibling's captain auto-accepts (because `acceptDelegations` is true) and spawns a crew. When the task settles — done, blocked, or failed — the daemon fans the outcome back to **your** mailbox automatically. Your relay wakes you up. **You never poll the sibling.**

HARD RULE: Do NOT add a polling loop after `group dispatch`. The report-back is event-driven; trust it.

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
cockpit group dispatch scaffold-stylus-docs "Document the new --format flag added in PR #42"
# → "✔ Dispatched to 'scaffold-stylus-docs' (task abc12345)"
# → (returns immediately; you are notified when settled)
```

## Recording Learnings

Recording learnings is **opt-in**. Record when something genuinely surprised you or a useful pattern emerged — not on a schedule.

Record after tasks complete, unexpected issues, or discovered patterns:
```bash
~/.config/cockpit/scripts/record-learning.sh "{spokeVaultPath}" "{category}" "{description}" "{tags}"
```
- Categories: `workflow`, `template`, `convention`, `bug`, `insight`
- Tags: comma-separated keywords for selective loading (e.g., `cairo,escrow,pvp`)

## Wiki Compilation

Wiki writes are **opt-in**. Compile knowledge when you have something worth recording — not on a schedule. Use the `cockpit:wiki-ops` skill for full instructions.

1. **After each task**: If you learned how something works, create/update a wiki page
2. **During session shutdown**: Review today's learnings — promote useful ones to wiki pages
3. **Before starting work**: Query the wiki for relevant context:
```bash
~/.config/cockpit/scripts/wiki-query.sh "{spokeVaultPath}" "{task-keywords}"
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
~/.config/cockpit/scripts/mark-learning-useful.sh "{learning-file-path}"
```

Learnings with `times_loaded > 5` and `times_useful: 0` are stale — ignore them.

## Capturing Skills (CAPTURED — from OpenSpace)

After a crew member completes a task that used a **novel or reusable pattern**, capture it as a skill:
```bash
~/.config/cockpit/scripts/capture-skill.sh "{spokeVaultPath}" "{skill-name}" "{one-line description}" "{full markdown body}"
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
~/.config/cockpit/scripts/fix-skill.sh "{spokeVaultPath}" "{skill-name}" "{corrected markdown body}"
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
