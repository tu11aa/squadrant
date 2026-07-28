# Captain per-turn context budget

**Read-only analysis.** Data: 3 most recent captain transcripts in
`~/.claude/projects/-Users-q3labsadmin-me-squadrant/*.jsonl` by mtime
(`7b631cf9…` Jul 28, `a2534d64…` Jul 24, `d2000c3e…` Jul 24). All token
figures are **chars/4 approximations** unless pulled directly from a
transcript's `usage` block (those are exact, API-reported). Where a
component could not be located in the transcript at all, it's called out
explicitly rather than guessed.

## 1. Ranked table — composition of the first API call

Claude Code transcripts do **not** store the raw system prompt or tool JSON
schemas — only the first assistant `usage` block (exact) and a handful of
`attachment` records for hook/skill/MCP injections (their `content` is
recoverable). The very first call already shows `cache_read_input_tokens` >
0 (17,088–16,921 across all 3 sessions) because Claude Code's system
prompt + tool schemas are stable across sessions and hit the 1h prompt
cache from a prior process. Total first-call context = `input_tokens +
cache_creation_input_tokens + cache_read_input_tokens`.

| Session | First-call total (exact, API-reported) |
|---|---|
| 7b631cf9 (Jul 28) | 51,902 tok |
| a2534d64 (Jul 24) | 52,104 tok |
| d2000c3e (Jul 24) | 53,298 tok |

Component breakdown for 7b631cf9 (numbers consistent within ~5% across all
3 sessions — see §2 caveats):

| Component | Source | Est. tokens | % of first-call ctx (51,902) |
|---|---|---:|---:|
| Claude Code base system prompt + always-loaded tool schemas | **residual, not measurable from transcript** | ~29,196 | 56.3% |
| MEMORY.md (auto-memory index) | measured on disk | 4,930 | 9.5% |
| Available-skills listing (`skill_listing` attachment) | measured, transcript | 7,408 | 14.3% |
| AGENTS.md | measured on disk — **unconfirmed if Claude Code auto-loads it** | 3,515 | 6.8% |
| claude-mem injected observations + `using-superpowers` skill (`hook_additional_context`) | measured, transcript | 2,733 | 5.3% |
| CLAUDE.md | measured on disk | 1,260 | 2.4% |
| `--append-system-prompt-file` captain role template (`templates/captain.claude.md`) | measured on disk | 720 | 1.4% |
| Deferred-tool name list (86 names, schemas NOT loaded) | measured, transcript | 652 | 1.3% |
| Agent-type listing (`agent_listing_delta`) | measured, transcript | 636 | 1.2% |
| SessionStart hook system message | measured, transcript | 554 | 1.1% |
| MCP server instructions (gitnexus/context7/chrome deltas) | measured, transcript | 246 | 0.5% |
| Startup-checklist first user message | measured, transcript | 28 | 0.05% |
| Misc hook stdout (PATH export, cmux hook) | measured, transcript | 24 | 0.05% |

**The single largest identified line item is the skills listing (~7.4k
tokens), followed by MEMORY.md (~4.9k) and AGENTS.md (~3.5k).** The
"residual" row (56%) is everything the transcript cannot show directly:
Claude Code's own system prompt plus the JSON schemas for every
always-loaded (non-deferred) tool — Bash, Read, Edit, Write, Agent,
AskUserQuestion, Skill, Workflow, ToolSearch, ScheduleWakeup,
ReportFindings, and any MCP tools not covered by the deferred-tool
mechanism. This cannot be sized without live API request logging; it is
reported as a residual, not silently folded into another line.

## 2. Caveats on the estimate

- chars/4 is a rough proxy; real tokenization (especially for structured
  JSON tool schemas) runs denser than English prose, so the residual
  55–56% is likely a **lower bound**, not an upper bound.
- AGENTS.md's presence in context is inferred from file size only — it was
  never observed as a distinct transcript attachment (only CLAUDE.md +
  MEMORY.md are visibly bundled into the `claudeMd` system-reminder in
  this exact harness, per direct observation of this session's own
  system-reminder). Treat the AGENTS.md line as a candidate, not a
  confirmed cost.
- The deferred-tool mechanism observed in this very session (86 tool names
  listed, schemas fetched on demand via `ToolSearch`) already keeps most
  MCP tool schemas (gitnexus, claude-mem, chrome, figma, context7) **out**
  of the always-loaded residual — so that 56% residual is smaller than a
  naive "all MCP servers loaded" estimate would suggest, but still opaque.

## 3. Cache-read growth within a session (first vs. median vs. last)

Unique-turn `cache_read_input_tokens` sequence per session (collapsing
consecutive identical values, which are retries of the same API call):

| Session | Turns (unique) | First | Median | Last | Compaction resets (>50% drop) |
|---|---:|---:|---:|---:|---:|
| 7b631cf9 (Jul 28, ~6h span) | 29 | 17,088 | 84,854 | 112,477 | 2 |
| a2534d64 (Jul 24) | 105 | 16,921 | 133,334 | 188,832 | 4 |
| d2000c3e (Jul 24) | 101 | 16,921 | 191,101 | 298,465 | 2 |

**This directly answers the "fixed boot vs. accumulated" question: boot
overhead is ~17k tokens — under 10% of the reported 185k average.** The
other 90%+ is accumulated conversation history that gets re-sent (and
cache-read) on every subsequent turn for as long as the session runs
without a compaction reset. Sessions that run long (100+ turns) push
median/last cache_read into the 130k–300k range, which is what pulls the
system-wide average up to ~185k. Compaction events (2–4 observed per
session) drop `cache_read_input_tokens` back down to the ~17k floor, but
only 2 of the 3 sessions show this reset near their end — most of a
session's lifetime is spent in the high-accumulation regime.

Sanity check: mean `cache_read_input_tokens` across all 553 assistant
calls in these 3 sessions = **139,319** (median 133,472) — same order of
magnitude as the reported 185.5k account-wide average; the gap is expected
since the account-wide figure includes longer-running sessions than these
3 (d2000c3e alone averages 175,437, closest to the reported figure).

## 4. Recommendations

**Highest-leverage, lowest-risk cut: the skills listing (~7.4k tok/turn,
14% of boot, and paid again on every single turn for the rest of the
session since it never leaves the cached prefix).** Unlike the 86
deferred MCP tools (already loaded on-demand via `ToolSearch`), all ~85
skill descriptions are dumped into the system-reminder up front every
session, whether or not that session ever touches them (career/resume
skills, GCP skills, Solana skills are all listed in a squadrant captain
session that will never use them). A deferred-skill-listing mechanism
mirroring the existing deferred-tool pattern (list names only, fetch full
description via a search call when relevant) would cut this to a small
fraction of 7.4k tokens for a typical captain session, and — because it's
part of the fixed prefix — the saving compounds on **every turn for the
life of the session**, not just at boot.

Other candidates, roughly ranked by savings-per-session-length:
1. **Skills listing → on-demand** (~7.4k/turn, compounds all session): highest value, matches an already-proven pattern in this harness.
2. **MEMORY.md → trim or summarize** (~4.9k/turn): the auto-memory index has grown to 19.7KB; consider archiving older entries out of the always-loaded index.
3. **AGENTS.md** (~3.5k/turn, *if* actually loaded — unconfirmed, see §2): worth confirming with Anthropic docs/support before treating as a cut target.
4. **claude-mem observations block** (part of the 2.7k `hook_additional_context`): already fairly small; low priority.
5. The 56% residual (base prompt + core tool schemas) is not shrinkable without changing which tools are always-loaded vs. deferred — Bash/Read/Edit/Write/Agent/Skill/Workflow are core-loop tools and poor candidates for deferral.

**Not measurable, flagged rather than estimated:** exact size of Claude
Code's own system prompt and the individual JSON schema cost per
always-loaded tool. Sizing these precisely would require intercepting the
literal API request body, which is outside what the transcript records.
