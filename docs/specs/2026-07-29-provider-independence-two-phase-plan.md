# Provider independence — 2-phase plan

**Status:** approved direction, not started
**Date:** 2026-07-29
**Owner:** captain (squadrant)

## Why this exists

Squadrant was built as a long-horizon orchestration layer: one captain coordinating
many crews, with learning, handoff, reporting and Telegram on top. Today the captain
role only runs on Claude Code. If Claude access goes away — budget exhaustion, or the
company dropping Claude entirely — **the whole project stops**, because the coordinator
itself cannot boot.

Two distinct pressures, deliberately kept separate:

1. **Cost** — the orchestrator burns more tokens than working manually. True, and now
   measured (below). Needs a frugal path, not a rewrite.
2. **Dependency** — one provider is a single point of failure for the entire product.
   Needs a real driver seam for the captain role, not just for crews.

Phase 1 addresses cost and gives an escape hatch. Phase 2 removes the dependency.

## Measured baseline (2026-07-29)

Measured from real Claude Code transcripts in
`~/.claude/projects/-Users-q3labsadmin-me-squadrant/*.jsonl`. Full breakdown:
[`2026-07-28-captain-context-budget.md`](2026-07-28-captain-context-budget.md).

| | Sessions | Turns | Total volume |
|---|---:|---:|---:|
| Captain (main repo) | 66 | 7,439 | 1,457M |
| Crews (103 worktrees) | 107 | 10,400 | 1,463M |

Findings that shaped this plan:

- **The captain costs as much as all 103 crews combined** (~50/50, ~53/47 cost-weighted).
  Crew *count* is not the main driver — the orchestrator itself is.
- **~95% of volume is cache read** (~1/10 the price of fresh input), so raw token
  totals overstate spend considerably.
- **~185k tokens are re-read on every captain turn.** Of that, **~52k is fixed boot
  prefix (28%)** and **~72% is accumulated conversation**. Proven by turn-2
  `cache_read` (51,900) matching turn-1 total (51,902) across all 3 sampled sessions.
- Boot prefix composition: skills listing **7.4k**, MEMORY.md **4.9k**, claude-mem
  observations **2.7k**, CLAUDE.md 1.3k, captain role template 0.7k, and a **~29k
  residual** (Claude Code base prompt + core tool schemas) that is not shrinkable.
- `AGENTS.md` is **confirmed not auto-loaded** by Claude Code — only `CLAUDE.md` and
  `MEMORY.md` are bundled. Not a cut target.

**Key consequence:** the boot prefix is re-read every turn, so trimming it saves on
*every turn of every session*. And a spurious lifecycle event (e.g. #594 CREW IDLE
flood) is not a one-off cost — it appends to history that is re-read for the rest of
the session. Junk turns compound.

## Phase 1 — short term

Ordered by leverage. Each item is independently shippable.

### 1.1 Stop the junk turns (#594 CREW IDLE flood)

Highest leverage and already the top user-facing annoyance. Two distinct bugs sharing
one root (activity-tracking bookkeeping):

- a crew waiting on a registered background Monitor is classified idle → CREW IDLE
  fires mid-turn
- a CREW IDLE arrives *after* `crew close` succeeded (event for a dead crew)

Related, same root: #542 (false CREW STALLED from stale `pendingTool`), #515
(Agent-tool subagent finished but report never delivered).

**Method: reproduce first.** #492 was closed once and the symptom returned — do not
reason from code alone. Use a throwaway test project, never a real one
(cf. the 2026-07-07 brove-mobile handoff loss).

### 1.2 Trim the boot prefix

Target ~12.3k of the ~52k prefix, saved on every turn:

- **Skills listing → on-demand (~7.4k).** All ~85 skill descriptions are dumped
  upfront every session, including ones a squadrant captain will never touch (resume,
  GCP, Solana). Mirror the existing deferred-tool pattern: list names, fetch the
  description when relevant. Keep a small always-loaded set (`captain-ops`,
  `karpathy-principles`).
- **MEMORY.md → trim/archive (~4.9k).** The auto-memory index has grown to 19.7KB.
  Archive older entries out of the always-loaded index.

**Explicitly kept:** claude-mem injection stays. It is small (2.7k) and it is the
memory the user wants. Not a cut target.

### 1.3 `squadrant tokens`

Package the measurement so the next decision is not guesswork. Attribute spend across
captain vs crews, boot vs accumulation, and per-component prefix cost. The analysis
script from 2026-07-29 already works and is the starting point.

### 1.4 Manual mode

The escape hatch: when Claude is unavailable or budget is nearly gone, boot a captain
on another provider.

- `squadrant launch <project> --agent <x> --model <y>` — explicit flags. Today the
  agent is config-only (`defaults.roles.captain.agent`), with no CLI override
  (`packages/cli/src/commands/launch.ts:89`).
- **Guard against the Anthropic default.** `ensureGlobalOpencodeConfig` writes
  `model: "anthropic/claude-sonnet-4-5"` (`per-crew-settings.ts:225`). An opencode
  captain on the default config dies in exactly the outage it exists to survive. Warn
  or refuse when the fallback resolves to an Anthropic model.
- **Boot brief, pre-rendered.** Today the captain gets one line ("run your startup
  checklist") and is trusted to execute 8 steps. A cheaper model is less reliable at
  that. Squadrant should assemble the brief itself: handoff, status, live crews, open
  PRs, relevant learnings — plus, when resuming, a **digest of the last Claude
  session**. Keep it short; length is a per-turn cost.
- **`squadrant mem`** — CLI over `~/.claude-mem/claude-mem.db` (plain SQLite), so any
  agent can query memory via bash. Preferred over per-agent MCP registration because it
  matches how the rest of the coordination surface already works.
- **Point projection at the captain role** — `squadrant projection emit --target
  opencode` already inlines instructions + skills into `AGENTS.md`. It has simply never
  been wired to the captain role.

**Both takeover modes are in scope**, and the digest is what makes the second one
viable:

| Mode | What it needs |
|---|---|
| Cold start | boot fresh, read handoff + status. Mostly assembling existing parts. |
| Warm takeover | read the dead Claude session's transcript. Feasible because sessions are plain JSONL — but 55MB/dir, 5.7MB/file, so it **must** go through a digest, never raw. |

## Phase 2 — long term

Goal: the captain role is genuinely driver-agnostic. opencode first, codex after.

### 2.1 Lift the lifecycle layer

The three layers, and only one is real work:

| Layer | State |
|---|---|
| Role prompt + playbook | ✅ projection emitter exists |
| Coordination surface (`crew spawn/send/close`, `diff`, git, `gh`) | ✅ all bash, already agent-agnostic |
| Lifecycle (interactive boot, readiness gate, turn-end, resume) | ❌ the work |

Half of the third row is already solved on the **crew** path and can be reused:
interactive TUI with `--port`, SSE `/event` bridge for turn-end, splash-marker gate
(`splashMarker: "Ask anything"`, the #499 fix). The captain role was never wired to any
of it — `buildAgentCmd`'s non-Claude branch still emits a one-shot `opencode run "…"`.

Concretely:
- interactive boot for the captain role (reuse the crew recipe)
- readiness gate per agent (`CC_INITIALIZED_RE` is Claude-specific;
  `packages/workspaces/src/runtimes/cmux.ts:324`)
- turn-end detection per agent (SSE for opencode)
- cross-day resume — opencode's equivalent of `claude -c`. **Unverified; needs a spike.**

### 2.2 What cannot be ported

State plainly rather than discover it late:

- **`UserPromptSubmit` hook** — Claude Code's authoritative first-turn confirmation,
  the fix that closed the whole first-turn-drop class (#471/#473). Other agents have no
  equivalent. For opencode the SSE `/event` stream can substitute, but that is a
  *different mechanism*, not a port — it must be re-validated against a real repro, not
  assumed.
- **`AskUserQuestion` modal** — no equivalent. Fallback is plain-text prompting.
- **Judgment quality** — the captain role is mostly decisions, not code. A cheaper
  model degrades coordination quality in ways token counts do not show.

### 2.3 Later

Codex. Then other harnesses (user mentioned "openharness" — scope deferred, not yet
specified). Explicitly out of scope until Phase 1 and 2.1 land.

## Decisions already made — do not re-litigate

1. **Cold start *and* warm takeover** are both in scope, warm via digest only.
2. **claude-mem stays injected.** It is the memory the user wants; it is small.
3. **`squadrant mem` CLI over per-agent MCP config** — matches the existing
   agent-agnostic coordination surface.
4. **Measure before cutting.** The 17k-vs-52k error in the first context report is
   exactly the failure mode to avoid.
5. **Reproduce before fixing #594.** It was closed once already and came back.
6. **"openharness" deferred** until the rest lands.

## Open questions

- Does opencode have a usable cross-day session resume? (blocks 2.1)
- Is SSE turn-end trustworthy enough to replace hook-based confirmation for captain
  turns? Needs a real repro, not a code read.
- How much context can the boot brief carry before it becomes the problem it solves?
  `squadrant tokens` (1.3) should answer this before the brief is designed (1.4).
- Does the "always spawn a crew, even for one line" rule need an escape hatch in
  frugal mode? Each crew re-derives repo context the captain already holds.

## Evidence

- [`2026-07-28-captain-context-budget.md`](2026-07-28-captain-context-budget.md) — per-component prefix breakdown, boot vs accumulation
- [`2026-04-24-multi-agent-direction.md`](2026-04-24-multi-agent-direction.md) — standing direction statement
- Issues: #594 (idle flood), #542, #515 (same bookkeeping root), #31 (projection layer)
