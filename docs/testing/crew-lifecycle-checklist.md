# Crew State Lifecycle Test Checklist

**Purpose:** Validate that a crew transitions correctly through every lifecycle state **and**
that the captain is notified at each captain-relevant moment. Run this whenever you change
anything that touches crews: `cockpit crew` commands, the daemon (`cockpitd`), the notify-relay,
the per-crew hooks, or the crew templates (`orchestrator/crew.*.md`).

**Subject:** A Claude crew is the reference. Repeat the same checklist for `codex` and `opencode`
crews as they reach parity (track each agent's pass/fail separately).

**Why captain-notification matters:** the whole point of the lifecycle is that a crew never gets
silently stuck. Every pause (question / permission / idle) and the finish must reach the captain.

---

## Pre-flight

- [ ] Daemon running — `cockpit` reports a live `cockpitd` (or it auto-starts on spawn)
- [ ] notify-relay running (in-cmux; required for prompt/block detection)
- [ ] Record `develop` HEAD so you can attribute any regression: `git rev-parse --short HEAD`
- [ ] No stale crews: `cockpit crew list cockpit` is clean

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

### 4. Idle — pings captain, NOT finished
- **Action:** Tell the crew to finish the current turn's work and **wait for the next turn
  without signaling done**.
- **Expect:** crew completes the turn and goes idle/awaiting. The Stop hook fires a
  `task.progress` **liveness** event (anti-#2576: bare turn-end ≠ done).
- **Captain signal:** captain is pinged that the crew is **idle/awaiting** — and the daemon task
  state is **non-terminal** (still `working`/awaiting, NOT `done`).
- **Verify state:** `cockpit crew list cockpit` shows the crew alive and non-terminal.
- [ ] PASS — idle ping received **and** state is not terminal

### 5. Finish — pings captain (done)
- **Action:** Tell the crew to run `cockpit crew signal done --message "<one-line summary>"`.
- **Expect:** crew transitions to terminal `done`.
- **Captain signal:** **CREW DONE** reaches the captain; daemon task state is terminal `done`.
- [ ] PASS — done notification received **and** state is terminal

### 6. Reopen after done — redo → done again
- **Action:** With the crew already terminal `done` (checkpoint 5), the captain reviews, finds a gap, and sends a new turn with redo instructions: `cockpit crew send cockpit <name> "<redo>"`.
- **Expect:** `cockpit crew send` detects the terminal task and fires `task.reopened` (#148) — the task returns to non-terminal `working`. The crew does the redo, then runs `cockpit crew signal done` again.
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
|      | codex  |     |               |            |              |        |          |          |       |
|      | opencode |   |               |            |              |        |          |          |       |

---

## Findings — 2026-05-30 (claude)

- **Checkpoints 1, 2, 3, 5 PASS.** Interactive multi-turn works; `signal blocked --question` surfaces as CREW BLOCKED and a captain `crew send` answer unblocks; a real permission prompt (write outside workspace) surfaces as CREW BLOCKED within ~0-3s and `crew send "1"` lets it through; `signal done` surfaces as CREW DONE and the daemon ledger goes terminal (`state: done`, `lastEvent: task.done`).
- **Checkpoint 4 (idle ping) = GAP.** The crew transitions to idle correctly and the daemon task stays non-terminal, but the captain receives NO idle/awaiting notification. By design the Stop hook is liveness-only (anti-#2576) — it feeds the watchdog, not the captain. The only captain-visible pings today are CREW BLOCKED (question/permission) and CREW DONE. If an explicit "idle / awaiting next turn" ping is wanted (distinct from done), it needs new wiring — e.g. a `cockpit crew signal idle` verb or a Stop-hook → captain notification (debounced so captain-driven turns don't spam).
- **Checkpoint 6 (reopen after done) = PASS.** First `signal done` → CREW DONE + ledger `done`. A captain `crew send` to the terminal crew fired `task.reopened` (#148) back to `working`; the crew redid the work and a second `signal done` fired CREW DONE again, ledger back to terminal `done`. Reopen→re-done works.
