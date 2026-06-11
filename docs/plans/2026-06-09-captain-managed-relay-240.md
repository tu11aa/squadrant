# Plan — Captain-managed relay (#240)

Branch: `feat/240-captain-managed-relay` (off `develop`)
Issue: #240 (replaces keeper #224). Design agreed in #240 body + captain comment 2026-06-09.

## Goal

Close the relay tab-death gap. The captain owns its notify-relay as a single
`run_in_background` process running an **in-process restart loop** (one PID,
testable), preserving `#186` semantics. Remove the separate `✉ notify-relay`
cmux tab spawned by `cockpit launch`. Keep the daemon-recovery seam untouched.

## Verifiable success criteria

1. `cockpit relay supervise <project> --as captain` exists, boots the relay,
   and on a boot-race failure retries with 3s backoff in **one process** (no
   per-failure process churn).
2. `cockpit launch` no longer spawns a `✉ notify-relay` tab / `#186` bash
   supervisor tab. No `ensureNotifyRelayTab` call remains in the launch path.
3. Captain templates + captain-ops skill document the ownership protocol:
   launch the supervisor as `run_in_background` on startup; relaunch with
   backoff when the harness reports the process exited.
4. `createRelayHealer` + sweep heal in `relay-healer.ts` are byte-identical
   (logic) to pre-change — only the already-committed doc comment differs.
5. `buildRelaySupervisorCommand` / `NOTIFY_RELAY_TAB_TITLE` remain exported
   (still used by the healer seam). `#186` builder tests still pass.
6. New unit tests cover the supervise loop; launch tests green.
7. Full `npm test` + `tsc` build clean.

## Pre-existing change (DONE)

- `src/control/relay-healer.ts` doc-only comment fix → committed first as
  `docs(relay): correct cmux-lineage comment in relay-healer (#224 follow-up)`
  (commit `93a33d3`). **Logic untouched.**

## Design

### In-process supervisor loop (the testable core)

`runNotifyRelay` resolves a stop-fn after its initial drain and then runs
forever on `setInterval` timers; it only *throws* during the boot race
(captain workspace not up yet → today's `process.exit(1)` in the bash loop).
So the in-process loop's job is the `#186` boot-race retry, in one PID instead
of churning a whole `cockpit notify-relay` process per failure:

```
runRelaySupervisor({ bootRelay, sleep, delayMs=3000, log, maxAttempts?, shouldContinue? }):
  attempt = 0
  while (shouldContinue?() ?? true):
    try:
      stop = await bootRelay()      // throws on boot race; resolves stop-fn on success
      log("relay booted (pid=…)")
      return stop                    // booted; process stays alive on relay's own timers
    catch e:
      attempt++
      if maxAttempts && attempt >= maxAttempts: throw/return  // test bound only
      log("relay boot failed (…), retrying in 3s")
      await sleep(delayMs)
```

- Pure/injected deps (`bootRelay`, `sleep`, `log`) → fully unit-testable with
  no cmux/daemon.
- Post-boot, whole-process death (crash / SIGTERM / captain restart) is
  recovered by the captain's `run_in_background` ownership (harness
  wake-on-exit → relaunch). The loop need not respawn post-boot because the
  relay's drain/probe intervals each catch their own errors and never throw out.
- This is the honest read of `#186 "restart on exit"` within one PID: the
  exit that actually recurs is the boot-race exit, and that is what the loop
  rides out. (Documented in code + template.)

### Placement

- New module `src/control/relay-supervisor-loop.ts` for `runRelaySupervisor`
  (keeps `relay-supervisor.ts` as the heavy-import-free pure-builders module the
  daemon healer imports — adding a `runNotifyRelay`-importing loop there would
  break that contract).
- New command file `src/commands/relay.ts`: `relay` parent command with a
  `supervise <project> --as <subscriber>` subcommand. Wires the real
  `runNotifyRelay` as `bootRelay` into `runRelaySupervisor` with `delayMs=3000`,
  infinite attempts, SIGTERM → graceful stop.
- Register `relayCommand` in `src/index.ts`.

## Tasks (TDD — test first each step)

1. **Supervisor loop (unit).**
   - Test `src/control/__tests__/relay-supervisor-loop.test.ts`:
     - retries boot N times with backoff then succeeds (fake `bootRelay` throws
       twice then resolves; fake `sleep` records calls) → 3 attempts, 2 sleeps
       of 3000ms, returns stop-fn.
     - returns immediately on first successful boot (0 sleeps).
     - `shouldContinue=()=>false` / `maxAttempts` bounds the loop (no infinite
       hang in tests).
   - Implement `src/control/relay-supervisor-loop.ts` to pass.

2. **`relay supervise` command.**
   - Test `src/commands/__tests__/relay.test.ts`: building the command wires a
     `bootRelay` that calls `runNotifyRelay` with the right opts (project,
     subscriber=captain, captainName from config, 3s delay). Assert structure
     via injected/exported helper (mirror `notify-relay` test style — validate
     the boot opts builder, not a live cmux run).
   - Implement `src/commands/relay.ts`; register in `src/index.ts`.

3. **Remove launch-time relay tab.**
   - `src/commands/launch.ts`: drop `ensureNotifyRelayTab`, the
     `notifyRelayProject` param threading, and both call sites
     (lines ~239, ~266, ~341). Keep the `buildRelaySupervisorCommand /
     NOTIFY_RELAY_TAB_TITLE` re-export (healer + tests depend on it).
   - Verify no launch test asserts the tab spawn (grep shows only `#186`
     builder tests, which stay valid). Update/remove only if one breaks.

4. **Captain template + skill docs.**
   - `orchestrator/captain.claude.md`: add an "Own your relay" startup step —
     on session start run `cockpit relay supervise <project> --as captain` via
     the Bash tool with `run_in_background: true`; when the harness reports the
     background process exited, relaunch it (with brief backoff).
   - `orchestrator/captain.generic.md`: same protocol, generic phrasing.
   - `plugin/skills/captain-ops/SKILL.md`: document the ownership protocol in
     the startup checklist (launch on start, relaunch-on-exit with backoff,
     why: closes the tab-death gap; daemon healer remains the secondary seam).

5. **Verify + report.**
   - `gitnexus_detect_changes` (or grep fallback if index stale) before commit.
   - Full `npm test` + `tsc`/build. Capture evidence.
   - Open PR `feat/240-captain-managed-relay` → `develop`. **Do NOT merge.**
   - Kill any vitest/dev processes. `cockpit crew signal done`.

## Out of scope (DO NOT TOUCH)

- `createRelayHealer` + sweep heal logic in `src/control/relay-healer.ts`.
- `buildRelaySupervisorCommand` / `NOTIFY_RELAY_TAB_TITLE` builders (kept for
  the healer seam).
- Daemon `#207` relay-register/heartbeat protocol.

## GSD note

`/gsd:plan-phase` errors without a `.planning/` roadmap (`run /gsd-new-project
first`). `new-project` scaffolds a full domain roadmap — overkill for one
bounded, already-designed issue (violates karpathy "simplicity first"). This
plan + per-task TDD delivers the same "fresh-context, verifiable steps"
intent without that overhead. Flagged to captain for the call.
