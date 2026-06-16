# Debug side-session: cmux-0.64.16 double-startup + Enter→newline

**Date:** 2026-06-16
**Role:** debug side-session (scratch worktree `cockpit-dbg-cmux`, branch `crew/dbg-cmux`)
**Scope:** root-cause only — draft patch on scratch, no ship.
**Context:** cmux upgraded to 0.64.16; cockpit shipped v0.7.0 cmux-compat (verb migration, `CMUX_QUIET`, focus-neutral spawn, events-bridge, agent-hook run-state).

---

## BUG 1 — Double startup run — ROOT CAUSE PROVEN ✅

### Symptom
On captain/crew session start the startup-checklist prompt is submitted **twice**:
the agent answers + loads the skill, then the same prompt appears and runs again.

### Root cause
`deliverStartupPrompt` (`src/commands/launch.ts:212`) confirms a startup send by
re-reading the surface and re-sending **only while it still classifies "idle"**
(Phase 3). The classification comes from `classifyStartupSurface`
(`src/runtimes/cmux.ts:253`):

```
working  iff CC_WORKING_RE matches the live spinner
idle     iff CC_INITIALIZED_RE matches (⏵⏵ / "Ctx Used") and not working
loading  otherwise
```

`CC_WORKING_RE` keys on `↓ N tokens` / `esc to interrupt` / `shell still running` /
`· N shell` / `(Ns` timer. **The new CC (Opus 4.8) renders the early working phase
with NONE of these markers**:

| frame (live capture, 0.25s apart) | spinner line | CC_WORKING_RE | classify |
|---|---|---|---|
| g01–g11 (~0–2.75s) | `✽ Synthesizing…` (bare, no timer) | **no match** | **idle (BUG)** |
| g12–g14 (~3s) | `✽ Synthesizing… (2s · thinking with high effort)` | match (`(2s`) | working |
| g15–g30, g45–g60 | `⏺ Thinking about …:` (streaming, no spinner line) | **no match** | **idle (BUG)** |

`CC_INITIALIZED_RE` matches the persistent status block (`⏵⏵`, `Ctx Used`) which is
**always present post-splash**, so any working frame without a `CC_WORKING_RE`
marker falls through to **"idle"**.

`deliverStartupPrompt` checks at `settleMs = 2500ms` — which lands squarely in the
`g01–g11` "Synthesizing…" stretch → reads "idle" → concludes keystrokes were
dropped → **re-sends → double startup run.**

`src/commands/launch.ts` and the `CC_*` regexes are **unchanged since v0.6.2**
(`git log v0.6.2..HEAD`), so this is **cmux/CC render drift** — exactly audit
finding **A3** in `docs/reports/2026-06-15-cmux-compat-audit-0.62-0.64.md`, not a
cockpit-code regression. (Earlier incarnation: #292, mem obs 17216 "delivered 3x".)

### Evidence (reproduction)
Spawned a throwaway `claude` surface, sent a think-then-tool prompt via the exact
cockpit `send`+`send-key Enter` pattern, captured the surface every 0.25s from a
*different* surface, and ran the **verbatim** `classifyStartupSurface` against each
frame. Result above: the agent is misclassified "idle" for the majority of an
active working turn, including the `settleMs` window.

### Fix (applied — `src/commands/launch.ts` Phase 3, `deliverStartupPrompt`)
Confirm by whether the surface **changed**, not by re-matching the spinner.
Snapshot the screen just before the send; after `settleMs`, re-send **only if the
screen is byte-identical** to that baseline.

```ts
// Phase 1 keeps the last read as `preSend`.
await sleep(settleMs);
const after = await read();
if (after !== preSend) return;   // landed (transcript/spinner changed); no re-send
// identical → keystrokes dropped (#235) → loop & re-send (bounded by maxAttempts)
```

**Why not the input box:** box-emptiness can't distinguish a *landed+working*
captain (box empty) from a *#235 splash-drop* (box also empty — the prompt never
arrived). Change-detection separates them: a landed prompt **always** mutates the
surface (the submitted message echoes into the transcript and the turn begins),
while a dropped send leaves it identical. This is also what the sibling crew path
(`sendFirstTurnWhenReady`, #168) already does.

**Verified:**
- Hand-traced against all 8 existing `deliverStartupPrompt` tests — all map cleanly
  (landed = screen changes to WORKING; dropped = screen stays IDLE).
- Added regression test `does NOT re-send when the captain is thinking with an
  unrecognized spinner` using the real captured `✽ Synthesizing…` frame.
- `tsc --noEmit` clean; **full suite 1223/1223 pass** (15/15 in launch.test.ts).

> Note: the crew first-turn path (`sendFirstTurnWhenReady`, `src/commands/crew.ts:152`)
> uses a different but related confirmation (`isTurnAccepted` over a pre-send
> snapshot). It is **also vulnerable** to the same chrome drift if its
> `splashMarker`/acceptance heuristic keys on now-absent markers — worth the crew
> auditing it against the same captured frames. (The captain path is the one in
> the report; crew path not separately reproduced here.)

---

## BUG 2 — Enter→newline on crew DONE — NOT REPRODUCED ⚠️ (obvious causes ruled out)

### Symptom (as reported)
When a crew reports DONE, pressing Enter **sometimes** inserts a newline in the
captain input box instead of submitting.

### What was ruled out (with evidence)
1. **Message content newlines** — the DONE message (`formatMessage`,
   `daemon.ts:117`) is a single line (`CREW DONE [prov/name]: <first-line, ≤200ch>`),
   and `sanitizeForCmuxSend` (`cmux.ts:104`) collapses `\n\r\t` *and* literal
   `\n`. Delivered via `sendToSurface` → `cmux send` + separate `cmux send-key Enter`.
2. **Non-atomic `send` + `send-key Enter` race** — `cmux send` delivers a **raw
   character burst, no bracketed-paste wrapper, no trailing newline** (verified
   against a `cat -v` surface); `send-key Enter` is a separate CR ~100ms later.
   Driving a real CC surface: **15/15 clean submits** on an idle empty box
   (including 135-char messages, 0/0.3/0.8/1.5s gaps). Does **not** reproduce.
3. **Delivery while CC is working** — message is **queued** by CC ("Press up to
   edit queued messages"), not stranded as a newline.
4. **#302 buffer-liveness probe** (`backspace`+restore into a live draft) — the
   draft is preserved intact and the subsequent Enter submits. No corruption.

> Methodology caveat: an early "12/12 not submitted" reading was a **false
> positive** — it grepped the whole screen, and a *submitted* message also renders
> in the transcript with `❯`/`│`. Correct detection isolates the input box between
> the last two `─` HR lines (mirrors `parseDraftFromScreen`). After correction:
> 15/15 submit.

### Remaining hypotheses for the crew (need real-relay / concurrency repro)
The intermittency was not reproducible in an isolated harness. Most plausible
remaining vectors, in order:
- **Working↔idle transition race at delivery time** — crew-DONE often lands exactly
  as the captain's own turn ends; the `send` may land mid-transition (queued) and
  the `send-key Enter` after the box re-renders. Needs the real relay + a captain
  toggling state under load.
- **cmux socket pressure** — under concurrent socket clients the 0.64.16 socket can
  drop writes (see "Red herring" below); a dropped `send-key Enter` would leave the
  text unsubmitted. Could not be reproduced for a non-self surface in isolation.
- **Recommended next step:** instrument the relay's `sendToSurface` to log, per
  delivery: the pre-send box state, the message, and a post-send box read-back
  (submitted vs. still-present). This catches it in the wild where the timing
  actually occurs, instead of guessing the trigger.

---

## Red herring (documented so it doesn't mislead) — self-surface read = broken pipe
`cmux read-screen` of the surface you are *currently executing in* fails
deterministically with `Error: Failed to write to socket (Broken pipe, errno 32)`
(5/5 on self-surface; 5/5 OK on any other surface; ping/list/tree always OK).
This wrecked the first capture attempts. **Cockpit never reads its own surface**
(launch reads the captain from the launch process; the relay reads the captain
from the relay tab) — so this is an instrumentation artifact, **NOT** a production
cause of either bug. Capture live surfaces from a *different* surface only.

---

## Artifacts
- **Fix (applied):** `src/commands/launch.ts` Phase 3 change-detection +
  regression test in `src/commands/__tests__/launch.test.ts`, on branch
  `crew/dbg-cmux`. tsc clean, 1223/1223 tests pass.
- This report: `docs/reports/2026-06-16-dbg-cmux-double-startup-and-enter-newline.md`.
- Repro harness (ephemeral, /tmp/dbg): verbatim `classifyStartupSurface` /
  `parseDraftFromScreen` classifiers + captured CC turn frames.

## Still open for a crew (BUG 2)
BUG 2 (Enter→newline on crew DONE) is **not fixed** — not reproduced. Recommend
adding the relay `sendToSurface` delivery instrumentation described above to catch
it in the wild before attempting a fix.
