---
name: side-session
description: Spawn and manage side-sessions (research/debug) — dedicated fresh-context tabs off the captain's daemon lifecycle. Use when you want to research a topic, discuss an idea, or debug without polluting captain context.
---

# Side-Sessions

A side-session is a dedicated tab with **fresh context** running the captain model (opus), loaded with a role-specific template. It runs **outside the crew/daemon lifecycle** — no `CREW IDLE/DONE` noise back to the primary captain. Its only upward signal is an explicit, user-confirmed structured handoff.

## Spawn a side-session

```bash
# Research a topic, discuss an idea, produce a spec or GH issue
cockpit side spawn <project> "<topic>" --role research

# Debug mode (Phase 2 — not yet available)
cockpit side spawn <project> "<topic>" --role debug
```

Options:
- `--name <name>` — custom tab name (default: auto `side-N`)
- `--direction <tab|right|down|left|up>` — placement (default: tab)
- `--agent <claude|opencode>` — agent to use (default: claude)
- `--topic-file <path>` — read topic from a file

## Manage side-sessions

```bash
cockpit side list <project>                               # see live side tabs
cockpit side send <project> <name> "<follow-up>"          # send a follow-up turn
cockpit side close <project> <name>                       # close when done
```

## Role: research

**Can:** Read code/docs, run read-only commands, create GH issues, write specs/plans.
**Cannot:** Edit source code, spawn crews, merge/ship changes.

The session works in fresh context and produces artifacts (specs, GH issues, analysis). When done, it asks the user to confirm before sending a structured handoff to the primary captain.

## Handoff workflow

```
1. Research session produces an artifact (spec, issue, analysis).
2. Session asks: "Notify the primary captain now? (y/n)"
3. On yes:
   - Writes durable record: {spokeVault}/side-handoffs/<topic>.md
   - Sends: cockpit runtime send <project> "🗒 Side handoff [research] — <topic> ..."
4. Primary captain receives handoff via relay.
5. Captain does NOT auto-spawn a crew — waits for user's go.
```

### Structured handoff format

```
🗒 Side handoff [research] — <topic>
Summary: <one-line summary>
Artifacts: <gh issue #NNN | spec: path/to/file.md | …>
Next: <recommended next action>
```

## Spawn by the primary captain

When the user asks you to start a side research session, spawn one:

```bash
cockpit side spawn <project> "<the research question or topic>" --role research
```

Note the session name from the output (e.g. `side-1`) and tell the user they can steer it with:

```bash
cockpit side send <project> side-1 "<follow-up>"
cockpit side close <project> side-1
```

When the session completes, its handoff will arrive via relay with the `🗒 Side handoff` prefix.

## Key invariant

`cockpit side spawn` does **NOT** create a daemon task record. There is no `CREW IDLE/DONE` event for side-sessions. The only signal path is the explicit `cockpit runtime send` the side-session sends on user confirmation.
