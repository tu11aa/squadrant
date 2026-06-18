# Cockpit Thin Redirect — Design

> **✅ Shipped** (sub-issues #41–45 (PRs #46–50), 2026-05-05). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-05-05
**Status:** Draft — design only, sub-issue plans to follow
**Umbrella issue:** [#40](https://github.com/tu11aa/claude-cockpit/issues/40)
**Sub-issues:** [#41](https://github.com/tu11aa/claude-cockpit/issues/41) (D), [#42](https://github.com/tu11aa/claude-cockpit/issues/42) (A+E+F), [#43](https://github.com/tu11aa/claude-cockpit/issues/43) (B), [#44](https://github.com/tu11aa/claude-cockpit/issues/44) (C), [#45](https://github.com/tu11aa/claude-cockpit/issues/45) (G)

## Problem

Cockpit's current shape carries weight that doesn't pay off in practice:

- **Obsidian vault as inter-agent comm channel** — agents (Claude, Codex, Gemini) don't reliably write to it. The discipline is unenforceable across providers.
- **Persistent Command session** — used only for spawning captains, which the CLI already does. Burns an LLM seat for one CLI-shaped task.
- **Captain ceremony** — "write status after every event" / "write daily log" rules fail in practice. Captain templates instruct it; captain doesn't comply.
- **Claude Agent Teams crew-spawn** — locks crew to Claude Code. Blocks the multi-agent direction (Codex/Gemini/Cursor/Aider).
- **General weight** — for a personal tool, every helper module that needs maintenance is a tax.

## Direction

Cockpit becomes a **thin multi-agent orchestration layer**. The orchestrator is *disposable*; state lives in cmux pane buffers + git. Agents are not depended on for the liveness signal — machines observe and report. The Claude-only surface area is gone; a fresh CLI session in a split pane is the universal crew primitive.

## Decisions

These were locked in during the 2026-05-05 brainstorming session.

### 1. Captain — persistent per-project, but disposable

Captain stays as the per-project orchestrator. State does **not** live in captain's session. State lives in:
- cmux pane buffers (interactive history, screen output)
- the project's git working tree + worktrees
- `{spokeVault}/handoffs/` (deliberate persistence, opt-in)
- `{spokeVault}/status.md` (auto-derived, see decision #5)

Compact, crash, or relaunch is free. Re-spawn the captain via `cockpit launch <project>`; it re-acquires context from the system prompt + handoff.

### 2. Crew = fresh CLI session in a split pane

Crew is no longer a Claude Agent Team member. Captain spawns crew by:

```bash
cockpit runtime new-pane --workspace <captain> --direction right
cockpit runtime send --workspace <captain> --surface <new> '<agent-cli> <flags> "<inline crew prompt>"'
```

`<agent-cli>` is whatever the user picked: `claude`, `codex`, `gemini`, `cursor`, `aider`. The inline prompt **is** the handoff payload (validated against OpenAI Swarm's handoff-as-function-return pattern).

No `TeamCreate`, no `Agent` tool calls in role templates. This change is implemented by [#41](https://github.com/tu11aa/claude-cockpit/issues/41).

### 3. Command — optional, on-demand

`cockpit launch --all` no longer spawns a Command session. Bare `cockpit launch` no longer defaults to Command. `command.claude.md` and `command-ops` skill stay in the repo but are only invoked by:

```bash
cockpit command [--task briefing|learnings-review|wiki-aggregate]
```

This spawns a one-shot session in a split pane with a baked-in prompt for the task, lives until done, closes. Same primitive as crew-spawn. Implemented by [#42](https://github.com/tu11aa/claude-cockpit/issues/42).

### 4. Vault — consumer of auto-derived status, not write target

Obsidian vault stays. But its role flips: the vault is **read by the dashboard**, not **written by agents on every event**.

Agents still write the vault, but only when they have *meaningful* content to add (handoff entries, learnings worth recording, wiki pages they compiled). The "after every significant event" rule is removed. Implemented by [#42](https://github.com/tu11aa/claude-cockpit/issues/42).

### 5. Auto-status poller — pure machine, no agent action

A reactor reaction polls each captain's cmux pane every N minutes, classifies state from the last ~50 lines:

| Heuristic | State |
|---|---|
| prompt visible, no spinner | `idle` |
| spinner / "Brewing" / "Cogitated" / similar | `busy` |
| "blocked" / "error" / "✗" | `blocked` / `errored` |
| empty / process-not-running | `offline` |

Writes `{spokeVault}/status.md` with state, timestamp, last activity excerpt. Captain does nothing. Pattern validated by jmux, tmux-orchestrator, tmux-mcp. Implemented by [#43](https://github.com/tu11aa/claude-cockpit/issues/43).

### 6. Dashboard — sidebar pane + Obsidian Dataview, same data

Two consumers of the auto-derived status:

- **`cockpit dashboard --pane`** — opens a refreshing sidebar pane in cmux showing a compact text grid of all projects (name, state icon, last activity, age). No web UI, no Electron. Pattern from tmux-agent-sidebar, opensessions.
- **Hub Obsidian Dataview page** — `dashboard.md` in the hub vault, written by `cockpit init`, that aggregates spoke `status.md` frontmatter via Dataview query.

Both consume the same files. User picks whichever surface is in front of them. Implemented by [#44](https://github.com/tu11aa/claude-cockpit/issues/44).

### 7. Cross-runtime communication — `cockpit runtime send` only

There is no truly runtime-independent way to inject text into a running TUI session — the multiplexer's send mechanism is the only path. Cockpit's runtime driver abstraction (`cockpit runtime send`) already encapsulates this. Scripts and skills must call only `cockpit runtime send`, never `cmux send` directly. Switching to a future tmux runtime = adding one driver file in `src/runtimes/`, no other call-site changes.

Enforcement: lint rule + `git grep` audit during PR review.

### 8. Compact-amnesia — not a real problem

Hypothesis tested live 2026-05-05: spawned a captain with `--append-system-prompt-file orchestrator/captain.claude.md`, ran `/compact` (5% → 0% context), captain recalled role + project + all 4 hard rules verbatim. Conclusion: when role is loaded as system prompt (which `cockpit launch` already does), it survives compact natively. Anthropic's compact summarizes conversation history but preserves system prompt.

What users feel as "amnesia" is **work-context loss** — captain forgets what crew it spawned, what decisions it made, mid-task state. That's already covered by handoff files + auto-status.md.

Single doc-line change to `captain.claude.md`: *"If you feel disoriented after `/compact`, re-read your handoff (`{spokeVault}/handoffs/`) and current `status.md` to restore work context. Role itself survives compact via `--append-system-prompt-file`."* Implemented by [#42](https://github.com/tu11aa/claude-cockpit/issues/42).

## Architecture (resulting shape)

```
USER
 └── cmux workspace (per project, persistent)
       ├── pane 0 — Captain (persistent, disposable)
       │     └── reads system prompt from --append-system-prompt-file
       │     └── reads {spokeVault}/handoffs/ on disorient
       │
       ├── pane 1..N — Crew (fresh agent CLI session per task, split pane)
       │     └── inline prompt at spawn = handoff payload
       │     └── reports back via cockpit runtime send
       │
       └── (optional) sidebar — cockpit dashboard --pane

REACTOR (background, always-on, single workspace)
 ├── auto-status poller — reads each captain's pane, writes {spokeVault}/status.md
 ├── existing GitHub event reactions
 └── existing CI auto-fix reactions

VAULT (read-mostly)
 ├── hub: dashboard.md (Dataview), aggregated wiki, daily logs (opt-in)
 └── spoke: status.md (auto), handoffs/, learnings/, wiki/ (all opt-in)

ON-DEMAND
 └── cockpit command [--task ...] — one-shot session in a split pane for cross-project LLM work
```

## Non-goals

- **No persistent Command session.** Removed from `--all` and from the daily flow.
- **No web dashboard.** Sidebar pane + Obsidian view is sufficient; web UI is the heavy helper to avoid.
- **No agent-discipline enforcement.** Hooks were considered (forcing agents to write status); rejected because Claude-only and nag-prone.
- **No file-based message bus** between agents. `cockpit runtime send` is the only sanctioned cross-session delivery primitive.
- **No reverse projection** (reading agent-specific configs back into AGENTS.md). Out of scope.
- **No role identity for non-Claude agents** (captain/crew as first-class in Codex CLI, etc.) — deferred to existing issue [#35](https://github.com/tu11aa/claude-cockpit/issues/35).
- **No MCP message bus** — uneven cross-agent support, fights the "thin, works everywhere" goal.

## Research validation (2026-05-05)

Confirmed by survey of peer multi-agent / multi-CLI orchestrators:

**Patterns to steal (used in this design):**
1. Tmux pane polling for inferred status (jmux, tmux-orchestrator, tmux-mcp) → decision #5
2. Sidebar pane as dashboard, not web UI (tmux-agent-sidebar, opensessions) → decision #6
3. Handoff = next prompt (OpenAI Swarm) → decision #2
4. Hooks where available, polling everywhere else → decision #5

**Patterns avoided:**
1. CrewAI hierarchical mode — manager-LLM doubling work-LLM (~30-50% extra tokens)
2. claude-flow / RuFlo web dashboard — multiple GitHub bugs about dashboard-vs-reality drift
3. Vault-as-write-target — confirmed unreliable across agents (matches our experience)

**Key insight:** the orchestrator should crash freely; state lives in panes + git. The helper is disposable. This shapes decision #1 (Captain disposable) and decision #8 (compact is a non-problem).

## Risks

| Risk | Mitigation |
|---|---|
| State classifier misclassifies pane content | False positives are fine — it's a hint, not truth. Heuristic kept simple and tunable. |
| Auto-poller misses a captain that's running but the workspace has drifted name | Already handled by existing freshness gate + sessions.json |
| User wants Command back as always-on | `cockpit command` can be aliased to a launch wrapper if missed; keep the template + skill so a future toggle is one config field |
| Generic templates break for some non-Claude agent | [#45](https://github.com/tu11aa/claude-cockpit/issues/45) tests each agent end-to-end before declaring multi-agent parity done |

## Rollout

Sub-issues land as separate PRs off `develop`. Each ~1-3 days half-time. Total redirect ≈ 2 weeks.

1. **[#41](https://github.com/tu11aa/claude-cockpit/issues/41) (D) Crew spawn refactor** — first, because it's the headline pattern shift; everything else assumes the new spawn primitive
2. **[#42](https://github.com/tu11aa/claude-cockpit/issues/42) (A+E+F) Slim Command + vault cleanup + compact doc line** — bundled doc/template cleanup
3. **[#43](https://github.com/tu11aa/claude-cockpit/issues/43) (B) Auto-status poller** — reactor reaction
4. **[#44](https://github.com/tu11aa/claude-cockpit/issues/44) (C) Dashboard** — depends on #43
5. **[#45](https://github.com/tu11aa/claude-cockpit/issues/45) (G) Multi-agent template parity** — depends on #41

After all five land: cut a v0.3.0 release that ships the redirect.

## Relationship to existing work

- **Builds on** plugin phases 1-4 (runtime/workspace/tracker/notifier drivers) and projection (#36) — uses the existing abstractions; adds no new ones.
- **Closes the multi-agent direction** — projection gave non-Claude agents the instructions; this redirect gives them a working captain/crew model.
- **Does not block** [#34](https://github.com/tu11aa/claude-cockpit/issues/34) (MCP sync), [#35](https://github.com/tu11aa/claude-cockpit/issues/35) (role identity), [#30](https://github.com/tu11aa/claude-cockpit/issues/30) (external plugin loading) — all remain independent follow-ups.
