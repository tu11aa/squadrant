# Side-Sessions Framework — Design Spec

**Date:** 2026-06-13
**Status:** Design (re-brainstormed from the narrower research-captain idea). Awaiting spec review → implementation plan.
**Issue:** _(to be filed)_
**Supersedes:** the earlier research-captain-only design (now one role within this framework).

## Problem

Side work — researching/discussing a new idea, or **debugging** — currently happens inside the **primary captain's** session. This bloats the captain's context and degrades its core job (orchestrating crews). Debugging is the worst offender: it's context-heavy and noisy, and it competes with incoming crew reports for the captain's attention. The user wants dedicated, fresh-context surfaces for this kind of work, kept off the primary captain.

## Solution summary

A **side-sessions framework**: spin up a dedicated tab with **fresh context**, running the **captain model (opus)**, loaded with a **role-specific** template. Driven by the user (or by the primary captain on request). Each side-session is deliberately **outside the crew/daemon lifecycle** — no daemon task record, no `CREW IDLE/DONE` noise back to the primary captain. Its only upward signal is an explicit, user-confirmed **structured handoff**. The primary captain stays focused on crew orchestration.

Two built-in roles to start: **research** and **debug**. More can be added in code later.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Generalization | A role-parameterized framework, not a single role. `cockpit side spawn --role <role>`. |
| 2 | Role set | **Fixed built-in** roles (research + debug now; more added in code). Not user-pluggable (yet). |
| 3 | Spawn paths | **Both**: CLI (`cockpit side …`) the user runs directly, and a skill (`cockpit:side-session`) so the primary captain can spawn one on request. |
| 4 | Lifecycle wiring | **Off** the crew/daemon lifecycle — no task record, no IDLE/DONE noise. |
| 5 | Report-back | **Offer + confirm**: on producing a result, the side-session asks "notify the primary captain now?"; sends only on yes. |
| 6 | Report-back payload | **Structured handoff** (role, topic, artifact refs, one-line summary) via `cockpit runtime send`, **plus** a durable record written to `{spokeVault}/side-handoffs/<topic>.md` (survives captain /compact). |
| 7 | Model | Captain model, via `defaults.roles.side.model` (default `opus`, overridable). |
| 8 | Naming | role-family `side`; CLI `cockpit side`; tab icon 🗒; skill `cockpit:side-session`. |

## Capability matrix (per role)

| Capability | research | debug |
|-----------|:--:|:--:|
| Discuss / read code & docs | ✅ | ✅ |
| Run code / tests / commands | read-oriented | ✅ (reproduce, run failing tests) |
| **Edit source** | ❌ | ✅ **scratch only** — isolated worktree/branch, for instrumentation + a failing test; never shipped |
| Spawn crews | ❌ | ❌ |
| Ship a fix / merge | ❌ | ❌ |
| Produced artifacts | GH issue, spec, plan | root-cause diagnosis + **optional draft patch** (scratch branch/patch) + optional issue |

The hard boundary for both: **a side-session never ships changes or orchestrates crews.** The primary captain owns all execution. Debug's scratch edits exist only to *pinpoint* the bug; the fix is handed back for a crew to implement cleanly.

## Architecture (generalizes the approved Approach A)

### Components
1. **Role templates** — `orchestrator/side.research.md`, `orchestrator/side.debug.md` (+ `.generic.md` variants for non-Claude parity). Each: role mandate, capability rules (from the matrix), the offer+confirm handoff protocol, and the structured handoff format. Debug template also invokes `superpowers:systematic-debugging` and is told to work in its scratch worktree.
   - **Debug intake (required first step):** before instrumenting, the debug role must gather bug context from the user — repro steps, **when/where the bug appears**, expected vs actual, recent changes. If the user already supplied this in the topic, confirm and proceed; otherwise ask for it. This is systematic-debugging Phase 1 (reproduce + gather evidence) and prevents guessing. Only after intake does it dig into the scratch worktree.
2. **CLI noun** — `cockpit side <verb>`, mirroring `crew`:
   - `cockpit side spawn <project> "<topic>" --role research|debug [--name] [--direction] [--agent]` — opens a dedicated tab `🗒 <project>:<name>`, boots an interactive session with the role template + side model, sends the topic as the first turn. **`--role` is REQUIRED** — error if omitted (no default; explicit mode).
   - `cockpit side send / list / close`.
   - **Does NOT** call the daemon dispatch path (no TaskRecord). Reuses shared tab/template/model plumbing extracted from `crew spawn`.
   - For `--role debug`, the spawn creates an isolated **scratch git worktree** (now safe post-#279) so instrumentation never touches the captain's checkout; pruned on close. Research needs no worktree.
3. **Skill** — `cockpit:side-session`: lets the primary captain spawn a side-session on request; documents both spawn paths, the role capabilities, and the handoff semantics.
4. **Report-back** — `cockpit runtime send <project>` (relay-delivered to the primary captain pane) + a durable `{spokeVault}/side-handoffs/<topic>.md` record. The side-session composes the handoff on user confirmation.
5. **Config** — `defaults.roles.side` (agent + model; default claude/opus).

### Why still off the daemon lifecycle
A side-session is user-driven, not an orchestrated task. Wiring it to the daemon would emit `CREW IDLE/DONE` to the primary captain — the exact context pollution we're removing. So `cockpit side` shares only the surface/template/model plumbing with `crew`, never the dispatch/lifecycle path.

## Data flow

```
USER ──side spawn --role debug──▶ 🗒 side-session (fresh ctx, opus, debug template, scratch worktree)
   ▲                                      │ systematic-debugging: reproduce, instrument, write failing test
   │  discuss / steer                     │ (scratch edits — never shipped)
   └──────────────────────────────────────┘
                                          │ root cause found -> diagnosis (+ optional draft patch)
                                          ▼
                            "Notify primary captain now? (y/n)"  ──no──▶ keep going
                                          │ yes
                                          ▼
       runtime send <structured handoff>  +  {spokeVault}/side-handoffs/<topic>.md
                                          │
                                          ▼
                 PRIMARY CAPTAIN pane (relay) — acknowledges, dispatches a crew to implement the fix
```

### Structured handoff format (example, debug)
```
🗒 Side handoff [debug] — <topic>
Root cause: <one line>
Artifacts: issue #284  |  draft patch: side-handoffs/<topic>.md (or scratch branch side/<topic>)
Next: <what a crew should implement>
```

## Boundaries & guardrails
- Both roles: never `cockpit crew spawn`, never merge/ship. Never `--dangerously-skip-permissions`.
- Debug's edits live ONLY in its scratch worktree/branch; closing the side-session prunes the scratch worktree (reuse the #279-fixed worktree plumbing + crew-close cleanup).
- Primary captain, on receiving a handoff: does NOT auto-spawn a crew — acknowledges and waits for the user's go (semi-automatic default).

## Testing
- Unit: `side spawn` builds the correct tab/template/model invocation per role and does NOT call the daemon dispatch path (assert no TaskRecord). `--role debug` creates a scratch worktree; `--role research` does not.
- Unit: handoff string composition + vault-record path.
- Manual: spawn each role, run a short session, confirm the handoff lands in the primary captain pane + the vault record is written, and that no `CREW IDLE/DONE` events fire for the side-session.

## Out of scope (this iteration)
- User-pluggable roles (fixed built-in for now).
- Side-sessions spawning crews or shipping fixes (explicitly excluded).
- Persisting side-session context across restarts beyond the handoff record (ephemeral per topic; reuse via `side send` while the tab lives).
- Non-Claude interactivity beyond what the agent already supports.

## Resolved (spec-review decisions)
1. `cockpit side spawn` **requires `--role`** — no default; error if omitted.
2. Debug scratch = **isolated git worktree** (pruned on close). Plus: the debug role performs a **bug-info intake first** (repro / when-it-appears / symptoms) before instrumenting — see Debug intake above.
3. **One shared side model**: `defaults.roles.side.model` (default `opus`) for all roles. Per-role models deferred.
