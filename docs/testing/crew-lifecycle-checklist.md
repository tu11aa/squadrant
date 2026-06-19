# Crew State Lifecycle Test Checklist

**Purpose:** Validate that a crew transitions correctly through every lifecycle state **and**
that the captain is notified at each captain-relevant moment. Run this whenever you change
anything that touches crews: `cockpit crew` commands, the daemon (`cockpitd`),
the per-crew hooks, or the crew templates (`orchestrator/crew.*.md`).

**Subject:** A Claude crew is the reference. Repeat the same checklist for `codex` and `opencode`
crews as they reach parity (track each agent's pass/fail separately).

**Why captain-notification matters:** the whole point of the lifecycle is that a crew never gets
silently stuck. Every pause (question / permission / idle) and the finish must reach the captain.

---

## Pre-flight

- [ ] Daemon running — `cockpit` reports a live `cockpitd` (or it auto-starts on spawn)
- [ ] Captain notifications are delivered daemon-direct (no relay tab required — daemon calls cmux directly since #332/PR#373)
- [ ] Record `develop` HEAD so you can attribute any regression: `git rev-parse --short HEAD`
- [ ] No stale crews: `cockpit crew list cockpit` is clean

---

## Two Signal Mechanisms

The daemon receives crew state changes via **two distinct mechanisms**. Do not conflate them:

**TYPE 1 — Automatic turn-end / idle / liveness** (daemon *observes* the agent; no model action required):
| Agent | Mechanism | File ref | Reliability |
|-------|-----------|----------|-------------|
| claude | Stop hook → `cockpit crew _hook` → `task.turn.completed` | `src/control/interactive/claude.ts:198` | FLAKY — Stop hook may not fire (#187) |
| opencode | Embedded HTTP server SSE `session.idle` → daemon `OpencodeSseBridge` → `task.turn.completed` | `src/control/opencode/sse-bridge.ts` | Reliable |
| codex | app-server JSON-RPC `turn/completed` notification → `normalizeAppServerNotification` → `task.turn.completed` | `src/control/codex/normalize.ts:40-44` | Reliable, direct |

**TYPE 2 — Explicit terminal DONE / BLOCKED / FAILED** (the crew *decides*; the model runs `cockpit crew signal …`):
- **HARD INVARIANT** across all agents: NO automatic event maps to `task.done`. A turn ending ≠ the task being done (anti-#2576). "Done" is always explicit.
- **claude / opencode:** `cockpit crew signal done|blocked|failed` reads `COCKPIT_CREW_TASK_ID` from the shell env (set on their cmux shell launch).
- **codex:** the command needs `--task-id <id> --project <project>` (codex shares ONE app-server across threads; `startThread` has no env param, so no per-thread `COCKPIT_CREW_TASK_ID`). The codex crew template already injects these flags into its `developerInstructions` (PR #173). When driving a codex crew manually, pass `--task-id` / `--project` explicitly — do NOT use the bare claude-style command (it errors `COCKPIT_CREW_TASK_ID unset`).

---

## Checkpoints

Drive each from the **captain** side. "Captain signal" is what you must actually observe — a
notification reaching the captain session, not just the crew screen.

### 1. Interactive (working)
- **Action:** `cockpit crew spawn cockpit "<task>" --name lifecycle-test`
- **Expect:** crew boots a *live* session (not print-mode), accepts the first turn, does work,
  and replies. You can send follow-ups with `cockpit crew send` and get answers.
- **Captain signal:** crew tab is live; `cockpit crew read cockpit lifecycle-test` shows its reply.
- [ ] PASS

### 2. Question → captain answers
- **Action:** Tell the crew to ask the captain a genuine clarifying question via
  `cockpit crew signal blocked --question "<q>"`, then wait.
- **Expect:** crew blocks awaiting the answer.
- **Captain signal:** **CREW BLOCKED** (with the question) reaches the captain.
- **Resolve:** `cockpit crew send cockpit lifecycle-test "<answer>"` — crew unblocks and proceeds
  using the answer.
- [ ] PASS — blocked notification received **and** answer unblocked it
> **Codex note:** Signals via the crew's own `developerInstructions` (PR #173) which inject `--task-id <id> --project cockpit`. When driving codex manually, pass those flags explicitly — the bare `cockpit crew signal...` errors `COCKPIT_CREW_TASK_ID unset`. See §"Two Signal Mechanisms" above.

### 3. Permission gate → captain approves
- **Action:** Tell the crew to perform a **real privileged action** that the allowlist does NOT
  auto-approve, so it hits an actual permission prompt. Examples that gate under `acceptEdits`:
  writing a file **outside** the workspace (e.g. `touch /tmp/lifecycle-perm-$$.txt`), or a
  network/`git push` style command. (A bare `echo`/allowlisted command will NOT gate — must be
  side-effecting + outside the allowlist.)
- **Expect:** crew stops at the permission prompt.
- **Captain signal:** **CREW BLOCKED** (permission) reaches the captain within ~0–3s
  (Notification hook, event-driven — see #181).
- **Resolve:** `cockpit crew send cockpit lifecycle-test "1"` (or the approve option) — the
  gated action then completes.
- [ ] PASS — permission block received **and** approval let the action through

> Note: #2 and #3 both surface as CREW BLOCKED but via **different feeders** — #2 is an explicit
> `signal blocked`, #3 is the live Notification hook on a real prompt. Verify both paths.

### 4. Idle / thinking / stalled — three distinct signals (#354/PR#375)

> **Changed in #354/PR#375.** The old single wall-clock pulse that flipped any quiet crew to
> `awaiting-input` is replaced by three accurate, non-overlapping signals. The old false
> `CREW IDLE` on thinking crews is gone. Relay deletion (#332/PR#373) removed the
> `formatEntry` drop that was the root cause of the former GAP (#210).

- **Action:** Tell the crew to finish the current turn's work and **wait for the next turn
  without signaling done**. For full coverage, also exercise a long-thinking turn and (claude only)
  a hung tool call.

- **Three signals the daemon now emits — understand each:**

  **CREW IDLE (real turn-end)** — fires ONLY from the agent's Type 1 turn-end mechanism:
  - claude: Stop hook (flaky, #187) → `task.turn.completed` → `working → awaiting-input`
  - opencode: SSE `session.idle` → `OpencodeSseBridge` → `task.turn.completed` → `awaiting-input`
  - codex: app-server JSON-RPC `turn/completed` → `task.turn.completed` → `awaiting-input`
  The daemon task state is **non-terminal** (`awaiting-input`, NOT `done`). This is the only
  signal that advances the daemon out of `working`. Captain sees: **CREW IDLE**.

  **CREW QUIET (deep thinking)** — the crew is quiet past the heartbeat budget but
  **no tool is in flight** (`pendingTool` is unset). Daemon **keeps the task `working`**
  (NOT `awaiting-input`). A distinct **CREW QUIET** notification fires once per quiet episode.
  This replaces the old wall-clock→`awaiting-input` flip that mislabeled thinking crews as idle.

  **CREW STALLED (hung tool)** — a `PreToolUse` event (tool name in `pendingTool`) with
  no matching `PostToolUse` past `TOOL_STALL_BUDGET_MS` (10 minutes). Captain sees:
  **CREW STALLED({tool})** — a recoverable warn "still running {tool} ~{N}min — possibly hung".
  Auto-clears the instant `PostToolUse` arrives; reducer recovers `stalled → working`.
  **Degrades to QUIET-only for opencode/codex** — no `PreToolUse` feed → never stalled.

- **Captain signals to verify:**
  - Real turn-end → **CREW IDLE** in the captain mailbox; `cockpit crew list` shows `awaiting-input`.
  - Long-thinking turn (no tool) → **CREW QUIET** in captain mailbox; daemon stays `working`.
  - (claude only) Hung tool past 10min → **CREW STALLED({tool})** warn; auto-clears on PostToolUse.

> **Note on GAP (#210):** The former gap was the relay's `formatEntry` dropping `task.turn.completed`
> events before they reached the captain mailbox. The relay is deleted (#332/PR#373) and delivery is
> now daemon-direct, so this route is unblocked. CREW QUIET provides a positive captain signal
> (#354) for the case that previously had none. Verify #210 is closed by confirming captain
> notifications arrive on real turn-end.

- [ ] CREW IDLE received in captain mailbox on real turn-end; daemon → `awaiting-input`
- [ ] CREW QUIET received (not CREW IDLE) during a long-thinking turn; daemon stays `working`
- [ ] (claude only) CREW STALLED fires past 10 min on a hung tool; auto-clears on completion

### 5. Finish — pings captain (done)
- **Action:** Tell the crew to run `cockpit crew signal done --message "<one-line summary>"`.
  > **Codex note:** same `--task-id <id> --project cockpit` requirement as CP2; prefer the crew's self-signal via `developerInstructions`.
- **Expect:** crew transitions to terminal `done`.
- **Captain signal:** **CREW DONE** reaches the captain; daemon task state is terminal `done`.
- [ ] PASS — done notification received **and** state is terminal

### 6. Reopen after done — redo → done again
- **Action:** With the crew already terminal `done` (checkpoint 5), the captain reviews, finds a gap, and sends a new turn with redo instructions: `cockpit crew send cockpit <name> "<redo>"`.
- **Expect:** `cockpit crew send` detects the terminal task and fires `task.reopened` (#148) — the task returns to non-terminal `working`. The crew does the redo, then runs `cockpit crew signal done` again.
  > **Codex note:** same `--task-id` / `--project` requirement; the second `signal done` needs the same flags.
- **Captain signal:** crew responds to the new turn despite having been done; the second `signal done` fires **CREW DONE** again and the daemon ledger returns to terminal `done` (`lastEvent: task.done`).
- **Note:** a turn-end `Stop` hook may transiently set `lastEvent: task.progress`; the explicit `signal done` is what settles the ledger back to terminal `done`.
- [ ] PASS — done crew reopened on the new turn AND reported done a second time

---

## Teardown

- [ ] `cockpit crew close cockpit lifecycle-test`
- [ ] No orphan processes: `pgrep -fl vitest` (none) + no stray dev servers / node workers
- [ ] Daemon ledger shows the crew in terminal `done`

---

## Result log (fill in per run)

| Date | Agent | HEAD | 1 Interactive | 2 Question | 3 Permission | 4 Idle | 5 Finish | 6 Reopen | Notes |
|------|-------|------|---------------|------------|--------------|--------|----------|----------|-------|
| 2026-05-30 | claude | b0b8753 | PASS | PASS | PASS | GAP | PASS | PASS | checkpoint 4 = state OK but no captain idle ping (Stop hook liveness-only) |
| 2026-06-01 | codex  | fix/codex-sandbox-full-access | PASS | PASS | PASS | PASS | PASS | PASS | All pass after switching codex crews to `danger-full-access` (parity with unsandboxed claude/opencode). `signal` now reaches the daemon; reducer guard keeps `blocked` through the trailing app-server turn-end. CP3 via `--approval`. |
| 2026-06-01 | opencode | feat/opencode-idle-sse-bridge | PASS | PASS | DEFER | PASS | PASS | PASS | CP4 closed via SSE `session.idle` bridge (daemon auto-→awaiting-input, no signal). CP3 deferred (per-crew config auto-approves all tools). |
| 2026-06-03 | claude | ffc97f6 | PASS | PASS | DEFERRED (auto mode) | GAP (#210) | PASS | PASS | CP3 no longer gates — crews default to `--permission-mode auto` (#199). CP4 idle ping = #210. |
| 2026-06-03 | codex | ffc97f6 | PASS | PASS | DEFERRED (--approval) | GAP (#210) | PASS | PASS | Signals via `--task-id` (PR #173) self-injected in `developerInstructions`; verified live. Earlier 'fail' was a test error (bare signal w/o `--task-id`). |
| 2026-06-03 | opencode | ffc97f6 | PASS | PASS | DEFERRED (config) | GAP (#210) | PASS | PASS | All explicit signals + SSE turn-end work; CP4 ping blocked by #210. |
| 2026-06-19 | (all agents) | e06bc3a | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING — captain live run in progress; validates #354 three-state CP4 (QUIET/STALLED/IDLE) + #332 daemon-direct delivery (relay deleted) |

---

## Findings — 2026-05-30 (claude)

- **Checkpoints 1, 2, 3, 5 PASS.** Interactive multi-turn works; `signal blocked --question` surfaces as CREW BLOCKED and a captain `crew send` answer unblocks; a real permission prompt (write outside workspace) surfaces as CREW BLOCKED within ~0-3s and `crew send "1"` lets it through; `signal done` surfaces as CREW DONE and the daemon ledger goes terminal (`state: done`, `lastEvent: task.done`).
- **Checkpoint 4 (idle ping) = GAP.** The crew transitions to idle correctly and the daemon task stays non-terminal, but the captain receives NO idle/awaiting notification. By design the Stop hook is liveness-only (anti-#2576) — it feeds the watchdog, not the captain. The only captain-visible pings today are CREW BLOCKED (question/permission) and CREW DONE. If an explicit "idle / awaiting next turn" ping is wanted (distinct from done), it needs new wiring — e.g. a `cockpit crew signal idle` verb or a Stop-hook → captain notification (debounced so captain-driven turns don't spam).
- **Checkpoint 6 (reopen after done) = PASS.** First `signal done` → CREW DONE + ledger `done`. A captain `crew send` to the terminal crew fired `task.reopened` (#148) back to `working`; the crew redid the work and a second `signal done` fired CREW DONE again, ledger back to terminal `done`. Reopen→re-done works.

## Findings — 2026-06-01 (opencode)

- **CP1/CP2/CP5/CP6 PASS, CP4 CLOSED, CP3 DEFERRED.** Opencode crews run as a normal cmux TUI (no Seatbelt sandbox), so `cockpit crew signal done|blocked|failed` reaches the daemon — all four explicit-signal checkpoints pass exactly like claude. CP2 block→answer→unblock and CP6 reopen→re-done both verified live.
- **CP4 (idle) = CLOSED via SSE bridge.** Opencode interactive crews now launch as `opencode --port <N>`, binding an embedded HTTP server. The daemon's `OpencodeSseBridge` (`src/control/opencode/sse-bridge.ts`) subscribes to `127.0.0.1:<N>/event` and maps the documented `session.idle` event → `task.turn.completed` → `awaiting-input`. Verified live: the daemon auto-transitions `working → awaiting-input` on every turn-end **without** the crew shelling out to cockpit. This is the reliable turn-end signal claude's Stop hook never delivered (the reason the claude idle work was reverted). The bridge re-subscribes after a daemon bounce (port persisted on the TaskRecord) and self-stops when the crew's server closes.
- **Reducer guard added.** `task.turn.completed` from `blocked` is now a no-op (mirrors `task.progress`): a crew runs `signal blocked` mid-turn, then the turn ends and the bridge emits a trailing `session.idle`/`task.turn.completed` — that must NOT clobber the blocked state/question. Verified live: blocked + question survived the trailing turn-end for 45s; the trailing idle after `signal done` is absorbed by the terminal guard (state stays `done`).
- **CP3 (permission) = DEFERRED (by design).** The per-crew opencode config (`writePerCrewOpencodeConfig`) auto-approves all tools (`edit/bash/webfetch/external_directory:allow`), so opencode never hits a permission prompt. Closing CP3 would require gating risky tools + subscribing to the `permission.asked` event (already on the same `/event` bus) + routing captain approval back via `POST /session/{id}/permissions/{id}`. Tracked as a follow-up; the SSE bridge built here is the foundation.

## Findings — 2026-06-01 (codex) — FIXED via danger-full-access

- **Root cause (confirmed live).** Codex crews dispatched under `sandbox: "workspace-write"`. The daemon socket (`~/.config/cockpit/cockpit.sock`), cmux socket, and LaunchAgents plist all live outside the workspace, so Seatbelt denied the `connect()`/writes — `cockpit crew signal` could never reach the daemon (`touch ~/.config/cockpit/… → Operation not permitted`). Only app-server paths (CP1, CP3) worked; the explicit-signal lifecycle (CP2/5/6) was dead.
- **Why "surgical writable_roots" was abandoned.** Codex treats AF_UNIX-socket access as a permission *separate* from `writable_roots` — the app-server `SandboxWorkspaceWrite` struct (`{writable_roots, network_access, exclude_tmpdir_env_var, exclude_slash_tmp}`) has no socket field. `codex sandbox --allow-unix-socket <path>` works as a CLI flag, but its config-file path is gated behind the undocumented experimental `experimental_network.unix_sockets` feature; 9 `-c key=value` shapes were tested and none took effect via config. Plumbing it would be a research project against an unstable experimental surface.
- **Fix shipped: `sandbox: "danger-full-access"` for codex crews.** This is **parity, not regression** — claude and opencode crews already run with NO Seatbelt sandbox (real CLI in a cmux pane); codex was the only sandboxed agent. Full-access removes the FS jail so `cockpit crew signal` reaches the daemon. `approvalPolicy` is an independent axis, so CP3 still gates when `--approval` sets it to `untrusted`.
- **Reducer guard (also required).** Codex runs `signal blocked` mid-turn; the app-server then fires `TurnCompleted`. Without the guard (`task.turn.completed` from `blocked` = no-op, shared with the opencode SSE work) that trailing turn-end would flip `blocked → awaiting-input` and drop the question. Verified live: `blocked` + question survived; `signal done` stayed terminal.
- **Verified live (all 6 PASS).** CP2 `signal blocked` → CREW BLOCKED (mailbox) → answer unblocked; CP5 `signal done` → terminal `done` + CREW DONE; CP6 reopen → 2nd CREW DONE. CP1/CP3/CP4 unchanged (app-server). Codex reaches full parity.

## Findings — 2026-06-03 (all agents — methodology correction)

This run corrected the checklist methodology after the captain identified that the checklist conflated **two distinct signal mechanisms** (see §"Two Signal Mechanisms" above).

- **Deliverable checkpoints (1, 2, 5, 6) all PASS for all three agents.** Interactive boot, blocked→answer→unblock, explicit `signal done`, and reopen→re-done are fully functional on claude, codex, and opencode.
- **CP3 (permission) = DEFERRED-by-design for all agents.**
  - claude/codex: `--permission-mode auto` is now the default (#199); crews auto-approve all tools.
  - opencode: per-crew config auto-approves everything (no permission prompts surface).
  - *No regression.* If gated permission testing is needed, run with `--permission-mode default` (claude/codex) or reconfigure opencode's tool approval settings.
- **CP4 (idle) = GAP (#210) for ALL agents.** The daemon correctly transitions `working → awaiting-input` via each agent's Type 1 mechanism (opencode SSE reliable, codex reliable, claude Stop hook flaky). But the captain receives **zero** idle/awaiting notification because the relay's `formatEntry` drops `task.turn.completed` / `task.idle` events before they reach the captain mailbox. This is a single infrastructure fix tracked as #210. Do NOT mark CP4 PASS until the relay delivers the idle ping.
- **codex signal path verified intact.** PR #173's `--task-id` / `--project` injection in `developerInstructions` is working. The earlier apparent codex "failure" was a test error — a bare `cockpit crew signal done` (no `--task-id`) inside a codex crew, which correctly errors `COCKPIT_CREW_TASK_ID unset`. The crew's self-signal via its own instructions works.
- **Cross-reference issues:** #207 (relay as SPOF), #208 (captain polling defeats notification), #209 (cmux execFileSync hang), #210 (relay formatEntry drops idle events).
