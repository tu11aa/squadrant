---
name: side-session
description: Spawn and manage side-sessions (research/debug) — dedicated fresh-context tabs off the captain's daemon lifecycle. Use when you want to research a topic, discuss an idea, or debug without polluting captain context.
---

# Side-Sessions

A side-session is a dedicated tab with **fresh context** running the captain model (opus), loaded with a role-specific template. It runs **outside the crew/daemon lifecycle** — no `CREW IDLE/DONE` noise back to the primary captain. Its only upward signal is an explicit, user-confirmed structured handoff.

## Spawn a side-session

```bash
# Research a topic, discuss an idea, produce a spec or GH issue
squadrant side spawn <project> "<topic>" --role research

# Debug a bug in an isolated scratch worktree
squadrant side spawn <project> "<topic>" --role debug
```

Options:
- `--name <name>` — custom tab name (default: auto `side-N`)
- `--direction <tab|right|down|left|up>` — placement (default: tab)
- `--agent <claude|opencode>` — agent to use (default: claude)
- `--topic-file <path>` — read topic from a file

## Manage side-sessions

```bash
squadrant side list <project>                               # see live side tabs
squadrant side send <project> <name> "<follow-up>"          # send a follow-up turn
squadrant side close <project> <name>                       # close when done
```

## Role: research

**Can:** Read code/docs, run read-only commands, create GH issues, write specs/plans.
**Cannot:** Edit source code, spawn crews, merge/ship changes.

The session works in fresh context and produces artifacts (specs, GH issues, analysis). When done, it asks the user to confirm before sending a structured handoff to the primary captain.

## Role: debug

**Can:** Read code/docs, run code and tests, edit source — but **scratch only** in its isolated worktree (instrumentation, logging, a failing test to pinpoint the root cause).
**Cannot:** Edit source outside the scratch worktree, spawn crews, merge/ship changes.

The debug role creates an isolated scratch git worktree on spawn. Edits made there are never shipped — the draft patch lives on the scratch branch and is referenced in the handoff for a crew to implement cleanly. Close prunes the scratch worktree.

### Bug intake (required first step)

Before instrumenting, the debug session gathers from the user:
1. Repro steps
2. When/where the bug appears
3. Expected vs actual behavior
4. Recent changes that could be related

If the topic already contains all of this, it confirms and proceeds. Otherwise it asks.

## Handoff workflow

```
1. Side session produces a result (root cause / artifact).
2. Session asks: "Notify the primary captain now? (y/n)"
3. On yes:
   - Writes durable record: {spokeVault}/side-handoffs/<topic>.md
   - Sends: squadrant runtime send <project> "🗒 Side handoff [<role>] — <topic> ..."
4. Primary captain receives handoff delivered daemon-direct via cmux (#332).
5. Captain does NOT auto-spawn a crew — waits for user's go.
```

### Structured handoff format (research)

```
🗒 Side handoff [research] — <topic>
Summary: <one-line summary>
Artifacts: <gh issue #NNN | spec: path/to/file.md | …>
Next: <recommended next action>
```

### Structured handoff format (debug)

```
🗒 Side handoff [debug] — <topic>
Root cause: <one-line root cause>
Artifacts: <failing test path | instrumentation: <file> | draft patch: scratch branch crew/<name> | issue #NNN>
Next: <what a crew should implement to fix this>
```

## Spawn by the primary captain

When the user asks you to start a side session, spawn one:

```bash
# Research
squadrant side spawn <project> "<the research question or topic>" --role research

# Debug — creates a scratch worktree; pruned automatically on close
squadrant side spawn <project> "<the bug description>" --role debug
```

Note the session name from the output (e.g. `side-1`) and tell the user they can steer it with:

```bash
squadrant side send <project> side-1 "<follow-up>"
squadrant side close <project> side-1
```

When the session completes, its handoff is delivered daemon-direct via cmux (#332) with the `🗒 Side handoff` prefix.

## Key invariants

`squadrant side spawn` does **NOT** create a daemon task record. There is no `CREW IDLE/DONE` event for side-sessions. The only signal path is the explicit `squadrant runtime send` the side-session sends on user confirmation.

`squadrant side close` on a debug session automatically prunes its scratch worktree (the branch is preserved so the draft patch survives).
