# Cockpit Control-Plane — Design Spec

> **✅ Shipped** (PR #85, 2026-05-17). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-05-17 · **Status:** approved design, pre-implementation · **Repo:** claude-cockpit @ `develop`

**Inputs:** `docs/research/2026-05-17-cockpit-system-audit-and-orchestration-advice.md` (audit + advice), `docs/research/2026-05-16-idle-detection-and-inter-agent-orchestration.md` (idle-detection research).

## Problem

Cockpit has no always-running, cockpit-owned process. Every autonomous behavior depends on an agent remembering to act, observed via terminal scraping. Result: reactor/wiki/learnings never ran; status/dashboard froze; the captain↔crew loop has a working *dispatch* leg and **no working completion/collection leg**. Multi-provider is Claude-only in practice. This spec defines the foundational substrate that fixes the captain→crew loop reliably and provider-agnostically. It is **foundational only**; auto-recovery, auto-learn, and legacy re-pointing are explicitly deferred downstream specs.

## Goal

A captain (any provider) can dispatch many crew (Claude / opencode / codex strong; gemini best-effort) in either interactive or headless mode, and **always learn the true terminal state without scraping**, with hung crew detected deterministically.

## Locked Decisions (from brainstorming)

| # | Decision |
|---|---|
| Daemon model | **Cockpit-owned launchd daemon**, strictly nervous-system: socket + task-state store + heartbeat watchdog, **zero orchestration logic**. The agent stays the brain. |
| Observability | **Per-task mode.** Interactive is the habitual default; headless is the deliberate opt-in for delegated/long work. Headless surfaced as structured status, not a raw tab. |
| Providers | Claude (slice-1 reference, strong both paths), opencode (strong headless), codex (strong headless, best-effort interactive), gemini (best-effort, experimental stub). Tier = **(provider × mode)**, not per provider. |
| Reliability source | **State machine + heartbeat layer — mode-agnostic.** Headless ≠ one-shot: long/interactive work runs via persistent session + explicit `blocked`/reply. Mode = observability/steering choice, *not* the source of reliability. |
| Scope | **Foundational only.** Auto-recovery actions, auto-learn, legacy re-pointing, notifications = separate downstream specs. |
| Architecture | **Approach 3 (hybrid):** daemon owns headless children by PID; receives normalized hook events for interactive. |

## Architecture

```
            launchd  (KeepAlive, RunAtLoad, restart-on-crash)
                │ manages
                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  cockpitd — the daemon (pure nervous system)              │
   │  • AF_UNIX socket  ~/.config/cockpit/cockpit.sock (0600)  │
   │  • task-state store ~/.config/cockpit/state/<proj>/<id>.json
   │  • heartbeat watchdog loop (flag-only this spec)          │
   │  • NO orchestration logic — runs / watches / records      │
   └───────▲───────────────────────────▲──────────────────────┘
           │ socket (events + queries)  │ owns child PID
   ┌───────┴────────┐         ┌─────────┴─────────────────────┐
   │ Captain (agent)│ dispatch│ HEADLESS path                  │
   │  = the brain   ├────────▶│ daemon spawns & owns child:    │
   │ cockpit crew … │         │ claude -p / codex exec /       │
   └───────▲────────┘         │ opencode (serve|run)           │
           │ reads state      │ process-exit = done-signal     │
           │ (never scrapes)  └────────────────────────────────┘
           │                  ┌────────────────────────────────┐
           └──────────────────┤ INTERACTIVE path                │
                              │ crew in cmux tab + injected     │
                              │ normalized hook → POST socket   │
                              │ (Claude strong / codex best-eff)│
                              └────────────────────────────────┘
```

One sentence: a launchd-kept daemon owns a socket + JSON task-state store + heartbeat loop; the captain *decides and reads*, the daemon *runs/watches/records*, crew reach the daemon as headless children it owns by PID or interactive sessions that POST normalized hook events.

**Supersedes:** the Obsidian hub's status-tracking role. `status.md`/`dashboard.md` stop being authoritative; their rewrite (pure projection of the state store) **or deletion** is decided in the deferred legacy-re-pointing spec. The daemon depends on Obsidian for nothing.

### Components

| Component | Single responsibility | Depends on |
|---|---|---|
| `cockpitd` | Hosts socket, owns state store, runs watchdog, spawns/owns headless children | launchd, fs |
| Socket protocol | Newline-JSON request/response + event ingest over AF_UNIX | — |
| Task-state store | One JSON file per task = single source of truth (`state`, `mode`, `provider`, timestamps, `last_heartbeat`, `last_event`, `result_ref`) | fs |
| Heartbeat watchdog | Per-task liveness timer; silence → `stalled` (flag only) | state store |
| Headless launcher | Spawn `claude -p`/`codex exec`/`opencode`, own PID, exit→`done`/`failed` | provider CLIs |
| Interactive launcher | Launch crew in cmux tab via runtime driver + inject one normalized hook | runtime driver (cmux) |
| Provider adapters | Interactive-hook translation only (headless uniform) | per-provider hook surface |
| Captain CLI (`cockpit crew …`) | Thin socket client: `dispatch`/`status`/`reply`/`list`/`close` | socket |

Only per-provider surface = the interactive-hook adapter. Headless is uniform PID-ownership.

**Definitions / migration notes:**
- `result_ref` = a filesystem path (under `~/.config/cockpit/state/<proj>/`) to the task's captured output/artifact (headless stdout, or crew-written result file). The state file stores the *reference*, not the payload.
- **CORRECTION (PR #85 real-env finding):** the *actual* legacy `cockpit crew` surface is `spawn`/`send`/`read`/`close`/`list` (cmux-scrape), NOT `dispatch`/`status`/`reply` — this spec's original assumption was wrong, and naively swapping the registered command broke every live captain (captain-ops still invokes `spawn`). Resolution: the legacy `crewCommand` is **kept registered verbatim** (captains unbroken, no restart) and the control-plane verbs (`dispatch`/`status`/`tasks`/`reply`/`_hook`) are **attached onto the same `cockpit crew`** via `addControlPlaneCrewCommands` (control-plane listing is `tasks`, not `list`, to avoid colliding with the legacy `list`). Both code paths coexist — exactly the deferred-legacy state. `src/commands/crew.ts` + `src/reactor/auto-status.ts` are retired, and captain-ops migrated to the new verbs, by the **deferred legacy-re-pointing spec** (NOT in foundational scope).

## Event Vocabulary & Task State Machine

```
 submitted ──start──▶ working ───done────▶ done
                       │ ▲  │
          progress/    │ │  └──blocked──▶ blocked ──reply──▶ working
          heartbeat ───┘ │                   │
                         │  ◀───reply─────────┘
                         ├──fail / exit≠0──▶ failed
                         └──no heartbeat>T─▶ stalled ──heartbeat──▶ working
                                                 │
                                  (terminate; recovery = deferred) ──▶ failed
```

**States:** `submitted`, `working`, `blocked` (input-required), `done`, `failed`, `stalled` (watchdog-derived; distinct queryable state so the deferred recovery spec has a clean trigger).

**Normalized events (adapters → socket):**

| Event | Effect |
|---|---|
| `task.started {id,project,provider,mode,pid?}` | `submitted → working` |
| `task.progress {id,note?}` | liveness tick; stays `working` |
| `heartbeat {id}` | pure liveness; no state change |
| `task.blocked {id,reason,question}` | `working → blocked`; surfaced to captain |
| `task.done {id,result_ref}` | `→ done` |
| `task.failed {id,error,exit_code?}` | `→ failed` |

**Captain ↔ daemon queries:** `dispatch` → task_id · `status {id|project}` · `reply {id,message}` (delivers into persistent session, `blocked → working`) · `list {project?}` · `close {id}`.

**Anti-#2576 invariant (the load-bearing rule):**

> A turn-end hook (`Stop`) is **liveness, never completion.** `done`/`blocked` require an **explicit** signal. Headless: process-exit + parsed result (unambiguous — why it is "strong"). Interactive: the crew must emit `cockpit crew signal done|blocked` explicitly; a bare `Stop` with no signal = `progress` (turn ticked, still working), never `done`.

**Heartbeat/liveness:**
- Any inbound event updates `last_heartbeat`. Watchdog: `now − last_heartbeat > threshold` while `working` → `stalled`. Threshold configurable; long jobs declare a larger budget at `dispatch`.
- Headless has a second independent liveness signal: the daemon owns the PID. Process exit always yields terminal `done`/`failed` from exit code + result → headless structurally cannot get stuck in false-`working`. This is why codex/opencode headless = strong.
- Interactive liveness = hook ticks; crew dies in tab → ticks stop → `stalled`. Best-effort for thin-hook providers (codex interactive), acceptable because that path is watched.

**blocked→reply→working** is the long/interactive-headless mechanism: crew emits `task.blocked(question)` → daemon records + surfaces → captain `reply` → daemon delivers into the resumed session (`claude -p --resume` / opencode session id / codex session) → `working`. Structured turn-taking, explicit state, no scraping.

## Data-Flow Walkthroughs

**① Headless delegated (strong, e.g. codex):** dispatch → daemon `submitted`→spawns `codex exec --json`, owns pid, `working` → stdout activity updates heartbeat → exit 0 + JSON → parse, `result_ref`, `done` (exit≠0 → `failed` + stderr tail). Captain `status` reads result.

**② Interactive observable (Claude default):** dispatch → cmux tab + injected merged hook → each turn POSTs `task.progress` (watchable live) → crew explicitly runs `cockpit crew signal done` → `done`. Bare `Stop` w/o signal = `progress` only (anti-#2576).

**③ Long interactive-headless (blocked→reply→resume):** dispatch headless opencode w/ larger budget → `working` → crew `task.blocked{question}` → `blocked` surfaced → captain `reply` → delivered into same persistent session → `working` → … (each turn/SSE resets heartbeat) → `done`. Proof headless ≠ one-shot.

**④ Hang detection:** `working`, crew hangs, no events → watchdog `now−last_heartbeat>threshold` → `stalled` (reason+age) → captain `status` shows it (deterministic). Headless extra: pid exited but no terminal event → dead-pid detection → `failed` immediately. This spec = detect + surface only; auto-kill/reassign deferred (daemon already holds pid).

## Provider Adapters

```
HeadlessAdapter  (≈ declarative; daemon owns pid/exit/heartbeat uniformly)
  buildCommand(task, sessionId?) → argv
  parseResult(stdout, exitCode)  → {done, result_ref} | {failed, error}
  resumeArg(sessionId)           → argv-fragment

InteractiveHookAdapter  (only real per-provider logic)
  injectHook(launchSpec) → launchSpec'
  tier: "strong" | "best-effort"
  fallback?()  # best-effort adds transcript/pid liveness poll
```

| Provider | Headless | Interactive hook | Tier H / I | Slice-1 |
|---|---|---|---|---|
| claude | `claude -p --output-format json` `--resume` | merged idempotent settings.json hooks | strong / strong | both (reference) |
| opencode | `opencode serve` session API | plugin `session.idle` | strong / good | headless ✔, interactive light |
| codex | `codex exec --json` + session resume | thin hooks + transcript/pid poll | strong / best-effort | headless ✔, interactive best-effort ✔ |
| gemini | `gemini -p` (result parse — verify) | poll only | strong-ish / best-effort | headless stub, experimental |

Headless adapters are ~20-line declarative descriptors → opencode/codex reach "strong" almost for free. Imperative per-provider code only in interactive hook injection, isolated to the watched path.

## Daemon Lifecycle

- launchd `LaunchAgent` `com.cockpit.daemon.plist` (`KeepAlive`, `RunAtLoad`) → restart-on-crash. Socket `~/.config/cockpit/cockpit.sock` (0600); daemon unlinks+rebinds stale socket on start.
- **State store = durable truth; daemon memory-stateless** — can crash and rebuild from `state/`. On startup it **reconciles**: `working` task w/ recorded headless pid → alive ⇒ resume watching, dead ⇒ `failed` (never fabricate `done`); interactive task w/ vanished hook source ⇒ `stalled`.
- **Daemon down:** CLI `launchctl kickstart`s it; if unrecoverable, CLI **fails loudly — "control plane unavailable"** and does **not** fall back to scraping. Refusal-to-degrade *is* the reliability guarantee.
- **Daemon dies mid-task:** headless children orphan; restart reconciles via pid; child finished during outage → missed exit → conservative `failed`, never guessed `done`.
- Plist + socket-dir provisioning reuses the existing `ensureRuntimeSynced` self-heal pattern (PR #74).
- launchd = macOS (target env). Core depends on a `ProcessSupervisor` seam, not launchd directly — one impl now, clean door for systemd/other later. No speculative abstraction beyond the seam.

## Error Handling

| Failure | Behavior |
|---|---|
| Daemon down | CLI kickstart; unrecoverable → loud "control plane unavailable", never scrape-fallback |
| Stale/locked socket | daemon unlink+rebind; CLI short-backoff retry then fail loud |
| Headless crew crash | dead pid → `failed` + exit code + stderr tail |
| Interactive crew death | hook ticks stop → heartbeat → `stalled` |
| Crew hangs | watchdog `working → stalled` at threshold |
| Daemon crash mid-task | restart → reconcile from state store; missed exit → conservative `failed` |
| Headless result unparseable (exit 0) | `done` w/ raw stdout as `result_ref` + `parse_warning` — never lose work, flag it |
| cmux down | interactive only fails fast; **headless path unaffected** (structural decoupling) |
| Corrupt state file | per-task file → blast radius = that task (`failed`+quarantined), others fine |
| Reply to non-blocked / late event after terminal | rejected / idempotently ignored (terminal states absorbing) |

Property: headless work has **zero cmux dependency** — a cmux outage degrades observability, not delegated execution.

## Testing Strategy

- State machine: pure `(state,event)→state'`; table-driven incl. anti-#2576 + terminal idempotency. No daemon.
- Watchdog: injectable clock; threshold + reset assertions. Pure.
- Headless adapters: `parseResult` pure (fixture stdout/exit → outcome); `buildCommand`/`resumeArg` string assertions. No subprocess.
- Daemon integration: temp socket+state dir, fake-crew script emitting scripted events/exits; includes **kill-and-restart → assert reconciliation**.
- Interactive hook adapter: hook script + fake socket; Claude settings-merge idempotency (merge ×2 → one entry).
- CLI: mocked socket; assert framing + fail-loud path.
- Reuses existing vitest; one new fixture (temp-socket daemon harness).

## Scope Boundary

**IN:** daemon · socket · event vocabulary · state machine · task-state store · heartbeat *detection* · headless ownership (Claude/opencode/codex; gemini stub) · interactive hook (Claude strong, codex best-effort) · captain CLI · launchd lifecycle + crash reconciliation.

**OUT — separate downstream specs, each cheap because the bus then exists:**
1. Auto-recovery actions (kill/reassign/restart on `stalled`/`failed`) — detection-only here; pids already held.
2. Auto-learn — wiki/learnings subscribe to `task.done`/`failed`.
3. Legacy re-pointing — reactor/status/dashboard/notify off scraping; Obsidian-status delete-vs-projection decided there.
4. Blocked/stalled notifications — downstream notify consumes the same events.
5. gemini-full · aider · cursor · non-cmux runtime · non-macOS supervisor.

## Success Criterion

A captain can dispatch Claude/opencode/codex crew in either mode, always learn the true terminal state (`done`/`failed`/`blocked`/`stalled`) without scraping, and a hung crew is detected deterministically within the heartbeat threshold — **proven by the daemon integration test surviving a mid-task daemon restart.**
