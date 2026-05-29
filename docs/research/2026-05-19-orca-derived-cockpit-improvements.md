# Orca-Derived Cockpit Improvements — Roadmap

**Date:** 2026-05-19
**Source studies:** `docs/research/2026-05-19-orca-full-system-study.md` · `2026-05-19-orca-codex-wrapping-study.md` · `2026-05-19-cockpit-vs-orca-system-comparison.html`
**Status:** Bucket-1 in-spec; Bucket-2 filed as issues #89–#95 (2026-05-19).

This document is the single catalog of everything the orca study surfaced that applies to cockpit beyond the immediate interactive-codex feature, with disposition for each item.

---

## Bucket 1 — Folds into the interactive-codex spec

Approved 2026-05-19 by the user; will appear in the spec being written next. No separate issues — they live in the spec PR.

| # | Item | Disposition |
|---|---|---|
| 1 | `resumeRef`-on-every-transition (closes #86 properly) | Phase-2 cornerstone of the interactive-codex spec |
| 2 | Daemon "ready" = successful `initialize` handshake, not just child-spawned | Spec acceptance criterion (counters codex 0.129+ silent-degradation) |
| 3 | `normalizeProviderEvent(provider, raw) → CanonicalEvent` seam with `never`-guarded exhaustive switch, feeding `reduce()` | Spec architecture section |
| 4 | Decision-gate HITL primitive (block task → structured human question → resolution injected into next dispatch) | Spec — new first-class state `gate{pending|resolved|timeout}` |

---

## Bucket 2 — Cockpit-wide hardening (separate issues; applies to ALL providers)

Each item is a tracked GitHub issue (filed 2026-05-19). Bodies cite orca prior art with `file:line` and name the cockpit subsystem to touch.

### B2-1 · #89 · watchdog: key heartbeats by dispatch-id, not task-id (sling pattern, part 1)

**Why.** Cockpit's heartbeat is task-keyed (`TaskRecord.lastHeartbeat`, `heartbeatBudgetMs`). A late heartbeat from a dead retry can refresh the timer of a hung live one.
**Orca prior art.** `coordinator.ts:274-301` — heartbeats keyed by dispatch context, not task.
**Cockpit change.** Sub-record attempts on `TaskRecord` (`src/control/types.ts` + `store.ts`); watchdog reads attempt-level heartbeats. Pure reducer preserved.
**Acceptance.** Replaying an old attempt's heartbeat cannot mask a hung new dispatch; integration test added.
**Label.** `enhancement`

### B2-2 · #90 · watchdog: warn-don't-autofail on stale; surface to Captain (default policy)

**Why.** Killing a slow-but-correct worker costs more than letting a hung one hold a slot until a human notices.
**Orca prior art.** `coordinator.ts:227-241` — `warnStaleDispatches` deliberately only warns.
**Cockpit change.** Default policy = warn + surface to Captain (control-plane event + reactor notification); `stalled` stays non-terminal; hard-kill behind a flag.
**Acceptance.** Stalled headless task remains non-terminal; Captain receives a structured "task X needs attention" event; configurable hard-kill budget per project.
**Label.** `enhancement`

### B2-3 · #91 · control-plane: model dispatch attempts as sub-records (sling pattern, part 2)

**Why.** Retries currently dirty task state (failure markers persist; re-reading task state can confuse the latest attempt with the first one's error). Auditing is muddy.
**Orca prior art.** orca's "sling pattern" — dispatch contexts are separate rows from tasks; circuit-breaker (3 failures → context `circuit_broken`, task `failed`) lives on the context (`coordinator.ts:562-568`).
**Cockpit change.** `DispatchAttempt` sub-record: `attemptId, startedAt, pid, error, exitCode, lastHeartbeat, circuitBroken, resumeRef`. `TaskRecord.attempts: DispatchAttempt[]`. Reducer/store/watchdog operate on attempts.
**Acceptance.** Retries don't overwrite prior attempt history; circuit-breaker lives on attempt; reducer remains pure. Pairs with B2-1.
**Depends on.** #86 (`resumeRef` lives on the attempt). **Label.** `enhancement`

### B2-4 · #92 · cockpitd: add a wire PROTOCOL_VERSION constant and handshake

**Why.** No on-the-wire version means a future wire-shape change silently breaks in-flight clients during a rolling restart.
**Orca prior art.** `daemon/types.ts:6` — `PROTOCOL_VERSION = 7`, `PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [1..6]`. Daemons survive app updates.
**Cockpit change.** `PROTOCOL_VERSION` constant in `src/control/protocol.ts`; server includes it in replies (or a `hello` frame on connect); client refuses mismatched versions with a clear error.
**Acceptance.** A CLI predating a wire change refuses to talk to a newer daemon (and vice versa) with a clear error instead of misparsing.
**Related.** Prerequisite for #87 (protocol schema validation). **Label.** `enhancement`

### B2-5 · #93 · cockpitd: coalesce concurrent restarts (in-process Promise + filesystem lock)

**Why.** `ensureDaemon()` runs on every CLI invocation. The plist-diff mitigation closes most of the window; a race still exists if two diffs land between probe and act.
**Orca prior art.** `daemon/daemon-init.ts:40-46` — `restartInFlight` promise so two restart triggers can't both enter the teardown sequence.
**Cockpit change.** In `src/control/launchd.ts`, in-process `Promise` gate (first caller does the work, others await) + a daemon-side single-instance lock under `~/.config/cockpit/daemon.lock` (`flock` / `O_EXCL`) so concurrent CLI processes serialize.
**Acceptance.** Two simultaneous `cockpit` invocations during a daemon restart cannot both run `launchctl bootout/bootstrap`; one wins, others wait.
**Label.** `enhancement`

### B2-6 · #94 · protocol: keepalive framing on AF_UNIX so long dispatches don't trip idle timers

**Why.** A future interactive subscribe stream (or a slow dispatch confirmation) can trip default socket idle timers with no traffic.
**Orca prior art.** `runtime-rpc.ts` — `{"_keepalive":true}` frame every 10s past 10s idle; clients tolerate and discard.
**Cockpit change.** In `src/control/protocol.ts`, a `_keepalive` frame every 10s when idle; all consumers MUST discard. Pairs with #87 (keepalive becomes a known frame, not invalid).
**Acceptance.** A connection held open for 60s+ with no app traffic stays alive on both sides; consumers discard `_keepalive` silently.
**Related.** #87. Prerequisite for the interactive-codex streaming subscribe channel. **Label.** `enhancement`

### B2-7 · #95 · dispatch: pre-flight worktree git-drift check (skip-not-fail on stale base)

**Why.** A crew dispatched into a worktree whose base has drifted may waste a full dispatch reasoning against stale ground.
**Orca prior art.** `coordinator.ts:481-521` — drift check before dispatch; if >20 commits behind base, **skip, don't fail** (burning the breaker would convert recoverable→hard-fail).
**Cockpit change.** In `src/commands/crew-control.ts` `dispatch` (and daemon-side dispatch entry), compute drift when `cwd` is a git worktree; over a configurable threshold (default 20), return a structured `stale-base` deferral (not a failure) the Captain or decision-gate (Bucket 1 item 4) can resolve.
**Acceptance.** Dispatch into stale worktree doesn't burn a crew/turn; returns a non-failure deferral.
**Label.** `enhancement`

---

## Bucket 3 — Multi-provider expansion patterns (architecture notes; no issues today)

Not goals today, but the patterns are recorded so we use them when the moment arrives.

- **`TUI_AGENT_CONFIG`-style single-source-of-truth row per provider.** Orca onboards a new agent with one row + (optional) hook-service. Cockpit's runtime-driver slot should grow a similar single per-provider record: detect/launch commands, prompt-injection mode (`argv` / `flag-prompt*` / `stdin-after-start`), preflight-trust artifact, foot-gun catalogue. Today scattered across drivers; consolidate when the 4th interactive provider lands.
- **Per-provider foot-gun catalogue baked into the driver.** Examples worth pre-encoding: `codex --ephemeral`/copilot `--prompt` would kill a hosted TUI; argv prompt > Windows/SSH cmdline limits → use stdin; `node-pty` NAPI `ThreadSafeFunction`s must be disposed before kill (if cockpit ever pty-hosts); treat `resumeRef` as an opaque hashed token, never parsed (orca #1148 session-id-shape regression).
- **codex 0.129+ silent hook-drop / trust-hash precondition** — already encoded in Bucket-1 item 2 (handshake-ready). Memo the general lesson: codex silently degrades when config preconditions unmet; never treat silence as success.

---

## Bucket 4 — Independent validations (no work, confirm direction)

- **CLI as ignition.** Orca's CLI is a thin RPC client + app-launcher (`launchOrcaApp()`). Identical to cockpit's "CLI is an ignition key, not the brain." External validation; no change.
- **`CLAUDE.md` = `@AGENTS.md` one-liner.** Orca ships this exact pattern. Validates cockpit's multi-agent direction (`AGENTS.md` canonical, `CLAUDE.md` thin wrapper).
- **Portable `SKILL.md`.** Orca ships `skills/{orchestration,orca-cli,computer-use}/SKILL.md`. Same pattern cockpit already uses. Validation.

---

## Bucket 5 — Future-architecture notes (not goals today, reference for later)

- **Lightweight remote-relay pattern** (SCP'd daemon over SSH + framed JSON-RPC + grace-period PTY survival on a unix socket across disconnects, hosting the same hook pipeline remotely): orca `src/relay/`. Pattern of record for when "cockpit goes remote" becomes a goal.
- **WS + E2EE + pairing + device-registry** (orca's mobile companion): not cockpit's direction today — Obsidian hub-spoke covers reporting. Recorded for completeness.

---

## Where cockpit is genuinely ahead — do NOT regress

These are **not action items** — they are guardrails. Orca lacks them, the orca study reinforces them, future cockpit work must not weaken them.

1. **Pure `reduce(state, event)` + typed per-task JSON state + `TERMINAL_STATES`.** Orca's live-agent truth is an opaque xterm screen blob. Cockpit's auditable typed state is strictly better engineering for an orchestrator.
2. **Anti-false-done invariant as a stated principle.** Orca has the bug class (#1437 stuck-spinner, tui-idle null→idle hangs) and patches reactively. Cockpit elevates "turn-end is liveness, never completion" to an invariant. Do not weaken to match orca's pragmatic title-scraping.
3. **Non-invasive config footprint (`~/.config/cockpit`).** Orca writes into 8 third-party agent home dirs (`~/.claude .codex .copilot .cursor .factory .gemini .grok .hermes`). If cockpit ever adopts agent-hooks, copy orca's mitigations (filename-scoped matchers + hash-matched cleanup), not the blast radius.
4. **Self-improving subsystems** (learnings, LLM-wiki, self-heal-on-invoke). Zero orca analog. Keep investing.
5. **Orchestration as an LLM session, not hardcoded code.** Orca's coordinator literally cannot AI-decompose (`coordinator.ts:201-206` defers it). Cockpit's Command/Captain are already that phase. Real lead — don't regress.

---

## History

- 2026-05-19 — Drafted from full-system orca study; Bucket-1 approved for inclusion in the interactive-codex spec.
- 2026-05-19 — Bucket-2 filed as issues #89, #90, #91, #92, #93, #94, #95 (one issue per item, `enhancement` label, bodies verbatim with orca `file:line` evidence + named cockpit subsystem).

---

## Sources

- `docs/research/2026-05-19-orca-full-system-study.md` — the deep memo with file:line evidence (agent: a1aa048435c21bec1)
- `docs/research/2026-05-19-orca-full-system-study.html` — reviewable HTML
- `docs/research/2026-05-19-orca-codex-wrapping-study.md` / `.html` — codex-specific deep dive
- `docs/research/2026-05-19-cockpit-vs-orca-system-comparison.html` — system-level positioning
- Orca repo: `github.com/stablyai/orca` @ `03b88951` (shallow clone at `/tmp/orca-study`, ephemeral)
- Cockpit @ `develop 9e61220` (post PR #85, control-plane merged)
