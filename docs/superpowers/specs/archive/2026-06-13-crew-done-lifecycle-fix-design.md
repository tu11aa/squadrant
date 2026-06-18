# Crew DONE Lifecycle Fix — Design Spec

> **✅ Shipped** (PR #281, 2026-06-13). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-06-13
**Issue:** #278 (lifecycle); relates to #279 (worktree), #148/#64 (done plumbing — healthy).
**Status:** Design approved (scope B, captain-side backstop). Awaiting implementation.

## Problem (proven live 2026-06-13)

Crew completion does not reliably emit `task.done` → no **CREW DONE**. Cross-agent lifecycle test:

| Agent | Emitted `done` unprompted |
|-------|:--:|
| claude | ❌ (finished + opened PR, never ran signal → watchdog IDLE) |
| opencode | ❌ (finished + committed, never ran signal → watchdog IDLE) |
| codex | ✅ (ran signal — concrete per-turn imperative with ids baked in) |

Two failure modes:
- **Mode 1 (mechanism):** `COCKPIT_CREW_TASK_ID` is injected only as a racy keystroke-inline env prefix; when it drops, the crew literally can't signal.
- **Mode 2 (discretion):** even with env present, emitting `done` depends on the model choosing to run a CLI command, which claude/opencode skip after reporting via text.

Codex avoids both because its developerInstructions are a concrete imperative — *"run EXACTLY `cockpit crew signal done --task-id <id> --project <proj> …`"* — ids baked in, at the point of action.

## Fix (scope B = crew-side win + captain-side backstop)

### Part 1 — Crew-side: concrete per-turn imperative (codex parity) for claude + opencode

Append a standard **completion-protocol** suffix to the first-turn text sent to claude and opencode crews (in `src/commands/crew.ts`, where the first turn is composed — claude ~L369, opencode ~L419). Built from the dispatched `rec.id` and project:

```
---
COMPLETION PROTOCOL (required): When this task is fully complete, your FINAL action
MUST be to run exactly:
  cockpit crew signal done --task-id <rec.id> --project <project> --message "<one-line summary>"
Run it as a discrete final step AFTER you report results. If you are blocked or need a
decision, instead run: cockpit crew signal blocked --task-id <rec.id> --project <project> --question "<q>"
```

- **Baking in `--task-id`/`--project`** makes the signal robust to the env race (kills Mode 1) AND puts a concrete imperative at the point of action (kills most of Mode 2).
- Keep the existing env injection and template wording (unchanged); this suffix is additive and is the load-bearing reliability lever.
- Mirror the same suffix for the `blocked` path so a waiting crew also terminalizes its intent explicitly.
- Codex already does this — no change to codex.

### Part 2 — Captain-side: IDLE reconciliation (behavioral, in `plugin/skills/captain-ops/SKILL.md`)

CREW IDLE is **ambiguous** — it can mean "finished but didn't signal" OR "genuinely waiting for the captain." Add a **"Handling CREW IDLE"** subsection instructing the captain to **classify** with a single on-demand spot-check (allowed — not polling), then act:

| What the spot-check shows | Captain action |
|---------------------------|----------------|
| Completed work (PR/commit opened + reported done) but no CREW DONE | Treat as the #278 case: review the work; if good, terminalize (merge + `crew close`). If not actually done, **re-task** it (the #148 reopen flow): tell it what's next. |
| Genuinely waiting for the captain (asked a question / needs a decision) | Respond — send the next instruction via `crew send`. Do NOT terminalize. |
| Still mid-task / transient idle | Leave it; wait for the next relay event. |

This is the backstop: even if Part 1's imperative is skipped, the lifecycle still terminalizes (or correctly continues) because the captain reconciles intent instead of letting the task silently strand at IDLE.

## Out of scope
- Daemon/hook-driven auto-done (Approach C) — rejected: risks conflating `done`≠`blocked`≠`awaiting-input` (anti-#2576).
- The #279 worktree-cwd fix — separate issue (pairs with this but not bundled).

## Testing
- Unit (`src/commands/__tests__/crew.test.ts`): assert the claude and opencode first-turn text includes the completion-protocol suffix with the correct `--task-id`/`--project` substituted; assert codex path unchanged.
- Manual lifecycle re-check: spawn a normal claude crew and an opencode crew (no explicit signal instruction beyond the new built-in suffix) → confirm CREW DONE now fires unprompted for both. Re-run the same 3-agent check from #278.

## Success criteria
- A normal claude/opencode crew that completes a task emits `task.done` → CREW DONE **without** the captain telling it to.
- The signal works even if the keystroke env injection dropped (ids are in the command).
- captain-ops documents how to classify and handle CREW IDLE (done vs waiting vs working).
