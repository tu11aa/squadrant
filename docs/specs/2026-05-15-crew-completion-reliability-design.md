# Crew Completion Reliability — Design (#64)

- **Date:** 2026-05-15
- **Status:** Approved (design); implementation pending
- **Issue:** #64 (blocker). Siblings: #18 (command→captain send-submit), #19 (captain→command post-compact drift).
- **Unblocks:** #65 (Telegram remote control Phase 1) — the push path depends on this.

## Problem

Two recurring failures make crew completion invisible:

1. **Crew doesn't report when done** — finishes its task but never pings the captain.
2. **Captain doesn't poll crew jobs** — even when a crew is done or blocked, the captain
   doesn't reliably check, so the result is never collected and the crew is never unblocked.

Net: the task completes (or stalls) silently, the captain pane never reflects it, the
reactor never sees a transition, **no notification fires, the user misses it.** This
blocks Telegram remote control (#65), whose push path is reactor → classify captain
pane → `notify()` → phone — a chain that only works if state reflects reality.

## Root-cause reframe (from research)

cmux's own "session done" notification is **Claude Code's `Stop` hook** (cmux ships a
wrapper `claude` that injects `Stop`/`Notification` hooks and renders them as its
notification + status pill). notchi does the same. The lesson: do **not** screen-scrape
crew state (fragile: UI drift, prompt/output ambiguity, false-idle during silent tool
calls — this is the failing status quo). Instead make the crew **emit** a deterministic
signal via a hook cockpit owns.

Claude hooks are precise: `Stop` = turn done (immediate); `Notification` = blocked
(permission_prompt / idle_prompt ~60s); `SubagentStop` = subagent done. A plugin's
`hooks/hooks.json` is active **only** for plugin-loaded sessions, and cockpit already
launches crews with `--plugin-dir ~/.config/cockpit/plugin` — so the hook is
**crew-scoped with zero global-config pollution** (unlike notchi, which mutates
`~/.claude/settings.json`).

## Approach (chosen: A)

**A — cockpit-owned crew signal → sentinel → reactor backstop.** Approved.

Rejected: **B** (poll cmux `list-notifications` by `surface_id`) — hard-couples to the
cmux runtime, breaks the multi-agent abstraction, wrapper-injection into
cockpit-spawned crews unverified, poll-only; kept only as an optional cross-check.
**C** (better screen-scraping) — the fragile status quo; demoted to last-resort
fallback so detection degrades instead of going silent.

## Architecture — three layers

| Layer | Agent-specific | Responsibility |
|---|---|---|
| **1. Detection adapter** | Yes (thin) | Learn "turn ended / blocked" for this agent, write a sentinel |
| **2. Sentinel** | No | cockpit-owned normalized state files |
| **3. Reactor backstop** | No | Read sentinels each cycle → push / nudge captain / escalate |

Layers 2–3 are 100% agent-agnostic and constitute the actual #64 fix. Only layer 1
varies per agent and maps onto the existing `AgentDriver` abstraction.

### Layer 1 — detection adapters

Add a crew-completion-signal capability to `AgentDriver` (same pattern as
`buildCommand`): each driver declares how its agent emits turn-done/blocked and how
cockpit wires it at crew spawn.

| Agent | Adapter mechanism | Ship phase |
|---|---|---|
| **Claude Code** | plugin `~/.config/cockpit/plugin/hooks/hooks.json` registering `Stop`, `Notification`, `SubagentStop` → `cockpit crew-signal` | **Now** (reference impl) |
| Codex CLI | `notify` program in `~/.codex/config.toml` (structured `agent-turn-complete` JSON) → `cockpit crew-signal` | Follow-up |
| Gemini CLI | hooks (`AfterAgent` / `SessionEnd`) → `cockpit crew-signal` | Follow-up |
| Aider | `--notifications-command 'cockpit crew-signal …'` spawn flag | Follow-up |
| opencode | no native hook → degrade to print-mode process-exit / scrape | Documented limitation |
| Any, print/non-interactive | process exit + exit code (universal) | Free |

Follow-up adapters require **zero changes to layers 2–3**. Tracked by **#68**.

**Crew identity injection:** at crew spawn, cockpit exports `COCKPIT_PROJECT`,
`COCKPIT_CREW`, `COCKPIT_STATE_DIR` into the crew process environment so the signal
handler identifies the crew without cwd/transcript guessing. Agent-agnostic.

**Claude adapter specifics:** `~/.config/cockpit/plugin/hooks/hooks.json` registers a
`cockpit crew-signal` command for `Stop`, `SubagentStop`, `Notification`. The handler:
- reads hook JSON from stdin + `$COCKPIT_PROJECT/$COCKPIT_CREW`;
- early-exits as a cheap no-op if `$COCKPIT_STATE_DIR` is absent (notchi's
  `[ -S socket ] || exit 0` pattern — never burdens non-cockpit Claude sessions);
- `Stop`/`SubagentStop` → write `<state>/<project>/<crew>.done`;
- `Notification` (permission_prompt / idle_prompt) → write
  `<state>/<project>/<crew>.blocked`;
- each sentinel carries: timestamp, event, `session_id`, and a short last-message
  excerpt from `transcript_path`;
- additionally best-effort `cockpit runtime send <project> "✅ crew <crew> done: …"`
  so the live captain path still works when the captain is healthy.

### Layer 2 — sentinel schema

Directory: `~/.config/cockpit/state/<project>/<crew>.<state>` where `<state>` ∈
`done | blocked`. JSON body: `{ project, crew, state, event, session_id, ts, excerpt }`.
Single normalized schema for every agent. Lifecycle: written by the adapter; consumed
and cleared once the reactor has processed it AND the crew receives a new task;
processed-set tracked (mirrors `reactor-state.json`'s GitHub-event dedupe) so a stale
sentinel never re-fires.

### Layer 3 — reactor backstop

Extend `src/reactor/auto-status.ts` (today: reads captain pane only) so each cycle
also scans `~/.config/cockpit/state/<project>/*` sentinels. A fresh sentinel:
- contributes `crew-done` / `crew-blocked` to the project's classified status →
  becomes a real transition the reactor can react to (notification / Telegram push);
- triggers a captain nudge: `cockpit runtime send <project> "crew <crew> is
  done/blocked — collect/unblock it"`;
- if the captain is unresponsive past a threshold (already classifiable via existing
  status logic; ties to #19), **escalate to command / notifier** so it never dies in
  a compacted captain.

This places the backstop in the **always-on reactor**, not the failure-prone captain.
It fixes #64 independently of (a) the crew agent self-reporting and (b) the captain
polling — both of which remain best-effort fast-paths, not the guarantee.

## Relation to siblings

- **#18** (command→captain send doesn't press Enter): the adapter's best-effort
  `cockpit runtime send` and the reactor's captain-nudge both go through the
  `runtime.send` driver path, which already does `cmux send` + `send-key Enter`
  (`src/runtimes/cmux.ts`). Verify in implementation; if the asymmetry in #18
  affects this path, fix there.
- **#19** (captain forgets after compact): not solved here, but **neutralized** —
  the reactor backstop means a compacted/forgetful captain no longer causes a
  silent miss; the always-on reactor catches it and escalates.

## Security / safety

- Hook is crew-scoped via plugin-dir; no global `~/.claude/settings.json` mutation.
- Handler is a strict no-op outside cockpit (state-dir gate) — safe on the user's
  normal Claude sessions even though the plugin dir exists.
- No new network surface; sentinels are local files under `~/.config/cockpit`.
- No arbitrary execution: the hook runs one fixed `cockpit crew-signal` subcommand.

## Testing

- **Unit**: `crew-signal` handler — event → correct sentinel; state-dir-absent
  no-op; identity from env; excerpt extraction from a fixture transcript.
- **Unit**: reactor sentinel scan — fresh `.done`/`.blocked` → correct classified
  transition; processed-set prevents re-fire; stale sentinel ignored.
- **Integration**: fake crew writes a `.done` sentinel → assert reactor cycle emits
  a `done` transition for that project (the exact signal #65's push depends on),
  with **no** captain involvement (proves the backstop).
- **Integration**: captain unresponsive + crew `.blocked` → assert escalation to
  notifier path.
- **Manual**: spawn a real Claude crew, let it finish a turn, assert
  `.done` sentinel appears and the reactor would notify — even with the captain
  idle/compacted.

## Explicitly NOT in scope (YAGNI)

No non-Claude detection adapters (separate follow-up; contract defined here, not
implemented) · no push event API into cmux · no change to the captain↔command
protocol beyond the reactor escalation already described · no screen-scrape rewrite
(scrape stays only as the last-resort fallback tier) · solving #19's
post-compact re-hydration (only neutralizing its impact here).

## Acceptance criteria

- A Claude crew finishing a turn produces a `<project>/<crew>.done` sentinel within
  one turn, **without the crew agent running any explicit report command**.
- A Claude crew hitting a permission/idle prompt produces a `.blocked` sentinel.
- The reactor, reading only sentinels, emits a `done`/`blocked` transition for the
  project within one cycle **with the captain absent or idle** (backstop proven).
- The crew hook is a verified no-op for a normal (non-cockpit) Claude session.
- `AgentDriver` carries the documented crew-signal contract; generalization
  follow-up #68 exists for Codex/Gemini/Aider adapters.
- No regression to captain→command (#19) or send-submit (#18) paths.
