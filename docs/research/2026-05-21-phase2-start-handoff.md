# Phase 2 Start — Handoff

**Date:** 2026-05-21
**For:** the next Claude Code session that picks up cockpit interactive-codex Phase 2.
**State of develop:** `c58e732` — Phase 1 + spec/plan/research merged. Clean.

---

## TL;DR

Phase 1 of cockpit interactive-codex is **shipped and merged** (PRs #96 + #97). The codex `app-server` JSON-RPC protocol is empirically proven against real codex-cli 0.130.0. Phase 2 builds the daemon driver, streaming channel, and cmux-tab client that turn the protocol library into an actual `cockpit crew chat` surface — and closes the interactive-codex slice of #86 via `thread/resume` on bounce.

**Phase 2 ETA: ~2.5 hours subagent-driven.** 16 tasks. Plan is at `docs/plans/2026-05-20-cockpit-interactive-codex.md` Tasks 2.0–2.15.

---

## What's on develop

- **Spec:** `docs/specs/2026-05-20-cockpit-interactive-codex-design.md` — Approach 3, two-phase. Bucket-1 orca-derived items already folded in (`resumeRef`, handshake-ready, `normalizeProviderEvent`, decision-gate).
- **Plan:** `docs/plans/2026-05-20-cockpit-interactive-codex.md` — Tasks 2.0–2.15 with file paths + complete code per step.
- **Phase 1 implementation:**
  - `src/control/codex/app-server-client.ts` — typed JSON-RPC client.
  - `src/control/codex/protocol/v2/` — vendored types (regen via `npm run codex:gen-types`).
  - `src/commands/codex-chat-smoke.ts` — empirical gate command.
- **Research bundle:** `docs/research/2026-05-19-orca-*.{md,html}` + `2026-05-19-cockpit-vs-orca-system-comparison.html` + `2026-05-19-orca-derived-cockpit-improvements.{md,html}`.

## What's NOT done yet (= Phase 2 scope)

- `CodexInteractiveDriver` (`src/control/codex/driver.ts`) — owns one long-lived `codex app-server` child for the daemon.
- `DispatchAttempt` sub-record on `TaskRecord` — schema additions in `src/control/types.ts` + reducer in `src/control/state-machine.ts`.
- `normalizeAppServerNotification` (`src/control/codex/normalize.ts`) — `never`-guarded exhaustive switch.
- Streaming subscribe protocol on cockpitd socket (additive `AttachFrame` / `AttachInbound` in `src/control/protocol.ts`).
- `cockpit crew chat --provider codex` (`src/commands/crew-chat.ts`).
- `cockpit crew attach <taskId>` cmux-tab renderer (`src/commands/crew-attach.ts`).
- Gate primitive (`src/control/codex/gate.ts`) with 5s presence buffer.
- Captain visibility on `cockpit crew status` (gates) + `cockpit crew reply --gate <id>`.
- On-restart reattach in `cockpitd` (closes interactive slice of #86).
- §4.10 acceptance script (manual).

## Hard-won Phase 1 lessons (apply in Phase 2)

1. **Vendored types are canonical truth.** Never hand-write request/response shapes — read the relevant file in `src/control/codex/protocol/v2/`. Phase 1 hit two protocol-shape bugs that only the real-codex gate caught: `thread/start` returns `{thread:{id}}` not `{threadId}`; `turn/*` notifications carry `{threadId, turn:Turn}` so the turn id lives at `params.turn.id`. The `AppServerClient` already unwraps these for its public API — Phase 2 driver code should rely on that surface, not re-parse the wire shapes.
2. **Lifecycle pattern.** `AppServerClient` emits an internal `_clientClosed` event on child exit and mass-rejects pending RPCs (`src/control/codex/app-server-client.ts::_onClosed`). Any new long-lived listener (the driver, the streaming channel) should subscribe to `closed` and/or `_clientClosed` to bail cleanly. Don't reinvent timeout/cleanup primitives.
3. **`approvalPolicy: "untrusted"` is the smoke trigger.** Without it, codex's `workspace-write` sandbox silently fulfills file writes and no `serverRequest` surfaces. Phase 2's interactive driver will likely default to a policy that surfaces approvals via the cmux tab — see spec §4.4.
4. **Anti-#2576 invariant codified at normalizer.** `TurnCompleted → awaiting-input`, NEVER `done`. Bake this into `normalizeAppServerNotification` (Task 2.3) with a `never`-guarded switch so adding a new codex notification kind is a typecheck failure if unmapped.
5. **The smoke command stays as-is.** It's the gate. Don't rewrite it during Phase 2 — Phase 2's acceptance smoke (Task 2.14) is a separate end-to-end script.

## To start Phase 2 in a fresh session

Paste this prompt verbatim:

```
Continue cockpit interactive-codex Phase 2. Read these in order:
  1. docs/research/2026-05-21-phase2-start-handoff.md (this file)
  2. docs/specs/2026-05-20-cockpit-interactive-codex-design.md (the design)
  3. docs/plans/2026-05-20-cockpit-interactive-codex.md (Tasks 2.0–2.15)

Execute via superpowers:subagent-driven-development. Start at Task 2.0
(branch off develop into feature/codex-interactive-crew, verify green
baseline with `npm run lint && npm test -- --run`). Plan ETA ~2.5h.

If anything contradicts the plan, prefer the spec. If anything in the
spec is contradicted by the vendored types in src/control/codex/protocol/v2/,
prefer the types. Don't re-derive protocol shapes — use AppServerClient's
public API (Phase 1) for all codex JSON-RPC.

Anti-#2576 invariant is non-negotiable: TurnCompleted is liveness, never
completion. Bake it into normalizeAppServerNotification.

Honest scope: this PR closes the interactive-codex slice of #86 only;
headless slice remains open under #91's follow-up.
```

## Key references

| Resource | Path / URL |
|---|---|
| Spec | `docs/specs/2026-05-20-cockpit-interactive-codex-design.md` |
| Plan | `docs/plans/2026-05-20-cockpit-interactive-codex.md` |
| Phase 1 PR (merged) | https://github.com/tu11aa/claude-cockpit/pull/97 |
| Docs PR (merged) | https://github.com/tu11aa/claude-cockpit/pull/96 |
| Bucket-2 orca-derived issues | #89, #90, #91, #92, #93, #94, #95 |
| Closes (Phase 2) | #86 interactive slice only |
| Orca study (full system) | `docs/research/2026-05-19-orca-full-system-study.md` + `.html` |
| Project memory (this work) | `~/.claude/projects/-Users-q3labsadmin-me-claude-cockpit/memory/project_2026_05_19_orca_study_and_fork.md` |
| Gate evidence | `.codex-smoke-evidence.local` (gitignored; smoke output) |

## Phase 2 task list (from the plan)

- 2.0 branch + baseline
- 2.1 `DispatchAttempt` + `Gate` schema on `TaskRecord`
- 2.2 reducer writes `resumeRef` on every transition (anti-#2576 `awaiting-input` state lands here)
- 2.3 `normalizeAppServerNotification` with `never`-guarded switch
- 2.4 `CodexInteractiveDriver` (owns app-server child; removes obsolete `src/control/interactive/codex.ts`)
- 2.5 handshake-gated "ready" with timeout
- 2.6 streaming subscribe frames in `protocol.ts`
- 2.7 wire `launchInteractive` for codex in `cockpitd` + attach fan-out
- 2.8 `cockpit crew attach <taskId>` cmux-tab renderer
- 2.9 `cockpit crew chat --provider codex` ignition command
- 2.10 gate primitive (5s presence buffer)
- 2.11 captain visibility (`crew status` shows gates, `crew reply --gate`)
- 2.12 on-restart reattach via `thread/resume` (closes #86 interactive slice)
- 2.13 stalled = warn-don't-autofail (#90 slice)
- 2.14 §4.10 acceptance manual smoke
- 2.15 PR closeout

Branch: `feature/codex-interactive-crew` off develop.

---

*Written 2026-05-21 by the prior session that completed Phase 1. Auto-handoff: no human round-trip needed to start Phase 2 — just paste the prompt above into a fresh Claude Code session in this repo.*
