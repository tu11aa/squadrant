# Verdict: close #208 (watchdog idle backstop for interactive crews)

**Date:** 2026-06-05 · **Decided as part of:** the service-health layer (#207/#77).
**Outcome:** **CLOSE #208.** No new code required; the residual is already covered.

## What #208 was

The stall/idle watchdog never provided a working idle backstop for interactive
crews. Two root causes:

- **B1** — interactive crews carry a 24h `heartbeatBudgetMs`, so
  `evaluateStall` never fires the idle→`awaiting-input` transition within a real
  session.
- **B2** — even if it fired, the synthetic `task.idle` was dropped by the relay's
  old `formatEntry` (no case for `task.idle`), so the captain never saw it.

## Why it is now resolved

- **B2 — RESOLVED by #217.** The relay no longer formats; the daemon's
  `formatMessage` is the single source of truth and handles
  `awaiting-input → CREW IDLE` (`src/control/daemon.ts:97-98`). The relay's
  `deliverable()` delivers the daemon message verbatim. So a fired idle event is
  now delivered, not discarded.
- **B1 — superseded by #139 liveness reaping.** A *dead* interactive crew
  (surface/pane provably gone) is terminalized by the daemon sweep/reconcile
  surface-liveness reaper, not by a heartbeat timeout. The 24h budget stays
  untouched, so the #131/#133 false-stall fix for *legitimately-idle live* crews
  does not regress.

## The only residual, and why it needs no new surface

A *live* crew whose turn-end signal was missed (so it sits at `working` without a
prompt nudge). This is covered today by two independent, reliable mechanisms:

1. **Reliable per-agent turn-end signals** → `awaiting-input` → `CREW IDLE`:
   claude Stop hook (#133) and opencode SSE `session.idle` (#188). The watchdog
   was only ever meant to *backstop* these; they are now dependable.
2. **The in-cmux relay pane-probe** (`createInteractiveProbe`,
   `src/commands/notify-relay.ts`): scrapes quiet `working` panes and fires
   `CREW BLOCKED` for a crew parked at a permission prompt / trailing question —
   exactly the "turn ended but no signal" shape.

The new service-health layer additionally surfaces every non-terminal crew's
liveness (`cockpit status --detailed` / `doctor`), giving the captain a passive
view of any crew that has gone quiet.

## Why NOT add a daemon-side live-idle nudge

A second, shorter heartbeat budget gated on `surface=alive` would re-introduce
the exact false-stall the 24h budget was set to prevent (#131/#133): a
legitimately-idle live crew awaiting the captain would be nudged/false-stalled.
One threshold cannot serve both "don't false-stall" and "timely idle backstop,"
and the two mechanisms above already cover the residual. Not worth the regression
risk.

**Action on merge:** close #208 with a link to this verdict.
