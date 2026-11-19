# captain-ops reference: Spawning crew

_Read this before spawning a crew, sending a follow-up, inspecting or closing one, or choosing agent/model/effort. Part of the `captain-ops` skill; the trigger table is in `SKILL.md`._


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
4. Gives it your task as the first turn. The crew works on it and then **stays idle** waiting for follow-ups.
   - **Claude:** the task is the launch-time init prompt (a real user turn, not a peer message). The brief is stored with the task, never in the worktree: `squadrant crew tasks` shows `brief <seq>`, and `squadrant crew msg <project> <seq>` prints it in full. A short task goes inline; a `--task-file` brief (or anything over 1200 bytes) becomes a `Read <path>` pointer to the stored `brief.md`. Write long briefs to a file and pass `--task-file`.

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
squadrant crew msg <project> <seq>            # one mailbox entry in full (the pointer on a cut crew reply)
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
- Respect `maxCrew` — don't exceed the configured concurrent crew count. Held crews do not count toward the limit, and at the limit you must ask the operator rather than choosing a crew to close.
- **For complex multi-step tasks** (3+ steps, multiple files), tell the crew to use GSD inside the task prompt: *"This is a complex task. Use `/gsd:plan-phase` and `/gsd:execute-phase` for wave-based execution with fresh context per step."*
- **For simple tasks**, don't mention GSD — the crew will handle it directly.

> codex crews are fully interactive (parity with claude/opencode) — `send` reaches them for follow-up turns (verified live 2026-07-02). gemini currently still launches in print-mode (one-shot) rather than as an interactive session; `send` won't reach it yet.
