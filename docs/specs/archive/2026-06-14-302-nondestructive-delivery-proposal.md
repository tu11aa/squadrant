# Issue #302 — Non-destructive, ghost-immune relay delivery (PHASE 1 proposal)

> **✅ Shipped** (PR #303, 2026-06-14). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Status:** IMPLEMENTED. Build + full suite green; live end-to-end verified.
**Branch (Phase 2):** `fix/302-nondestructive-delivery` off `develop`.

---

## Phase 2 results (implemented)

**Change (surgical):**
- `cmux.ts` — `DeferDelivery` now carries the observed `draft`; `sendToSurface`'s
  destructive `force` branch (backspace×N clear + **re-paste of screen-read draft**)
  is **deleted** and replaced by the buffer-liveness **probe** (`{ probe: true }`);
  added `readInputBoxRaw` (full multi-line box capture for the before/after diff).
- `notify-relay.ts` — tracks per-seq content stability; triggers the probe once
  content is byte-stable for `stableProbePolls` (default 3 ≈ 3s) **or** the
  300-defer backstop; `force`→`probe`. New `DEFAULT_STABLE_PROBE_POLLS`.
- `types.ts` / `config.ts` — `sendToSurface` opt `force`→`probe`; new
  `relay.stableProbePolls` config key.

**Probe rule:** read box; send ONE backspace; re-read. If `after === before.slice(0,-1)`
and non-empty → **real draft** → restore the one removed char, defer (never clobber,
never re-paste the full draft). Else (ghost dismissed/invariant, or now empty) → deliver.

**Stability/stall fix (reconciliation with the race that killed backspace in #258):**
the probe is *inherently race-safe* — its only delivering branch is "no real draft,"
and an actively-typing captain always presents a real draft → the probe hits the
restore-and-defer branch (a brief 1-char flicker at worst), never a clobber. The
stability gate additionally avoids even that flicker by only probing when content is
stable. So the 300-defer backstop is kept but is now harmless (it can no longer
clobber). **Worst-case failure mode is a stall, never materialization.**

**Verification:**
- `npm run build` (tsc) clean; `vitest run` full suite **1078/1078 green** (new: 6
  cmux probe tests + 1 reworked walk-away test + 3 relay stability tests).
- **STEP 0 live** (gate): backspace is buffer-aware — empty box invariant, real draft
  loses last char, #294 queue-ghost dismisses to empty.
- **Live end-to-end** against a real CC 2.1.x box via the *compiled* driver: real
  draft → DEFERRED (draft intact); empty → DELIVERED; ghost → DELIVERED with buffer
  confirmed empty (typing a char replaced the placeholder — **ghost not materialized**).
  Throwaway sessions torn down, no orphaned `claude`.

**Not run here (captain deploy-time):** the full crew-lifecycle checklist against
*live deployed* crews requires the globally-installed relay to be rebuilt from this
branch. Relevant checkpoints to re-confirm post-deploy: #258 preserve-draft, #268
overlay/null defer, #294 ghost fast-path, and the new #302 stall-free ghost delivery.

---

## STEP 0 — live verification (DONE, gate PASSED)

Bounded throwaway `claude --permission-mode plan` in a temp git dir, driven via `cmux
send-key`/`read-screen`, torn down clean (no orphaned `claude`). CC 2.1.x.

| Case | Before backspace | After ONE backspace | Signature |
|------|------------------|---------------------|-----------|
| Empty buffer | `❯ \xa0` | `❯ \xa0` (identical) | **invariant** |
| Real draft | `hello world` | `hello worl` | **clean last-char removal** |
| Real ghost (#294 queue placeholder) | `Press up to edit queued messages` | `❯ ` (empty); buffer confirmed empty — typing `X`→`X`, not appended | **dismissed to empty** |

**Refined rule (stronger than the original Case-A assumption):** a real draft is the ONLY thing
that yields the "last char removed, still non-empty" signature. Every ghost either stays invariant
or dismisses to empty — never that signature. So **protect only on the positive real-draft
signature; otherwise the buffer holds no preservable draft → deliver.** Even an exotic ghost misread
as real degrades to *defer* (we re-type only the one char we removed, then defer) — **never
materialization, never submission.** #302's headline harm is structurally impossible.

---

## 1. Why this subsystem churned 3× (#258) — documented so we don't regress

Source: PR #266 → #267 → #269, the line-600 test comment, and live findings.

| Attempt | Mechanism | Why abandoned (live-proven, not unit) |
|--------|-----------|---------------------------------------|
| #266 | **kill-ring**: `ctrl-u` / `ctrl+a`+`ctrl+k` to clear, restore after | **`ctrl-u`/`ctrl-k` are NO-OPs in Claude Code's input.** Proven live via `cmux send-key` (PR #267 body). Corroborated two more ways: (a) the regression test at `cmux.test.ts:600` asserts `ctrl-u` is never used "that key is a no-op against Claude Code's input box"; (b) strings of CC 0.80.0 bundle show `ctrl+u` bound to **half-page scroll** (`"ctrl+u/ctrl+d to scroll"`, `case"u":return"halfPage…"`), and `yank` exists **only in vi-mode** (`implement yank mode for vi`). CC's default input is **not** a readline line-editor. |
| (interim) | **backspace×N clear + restore** with a fixed idle-stability window | (a) backspace×N is **slow** (~600 ms for a long draft) so it **races live keystrokes**; (b) a fixed idle window **mis-fires for slow typists** (between-keystroke gaps exceed the window). (PR #267 body.) |
| #267 | **Approach B — deliver-only-when-empty (read-the-box idle-defer)** | **Chosen.** `sendToSurface` reads the box; any draft → throw `DeferDelivery`, relay retries next poll (never touches keystrokes); empty → deliver. Eliminates the clear/restore race entirely because the box is empty most of the time. #269 then scoped the parse to the live input box (between the two `───` HRs) and made the walk-away force-fallback configurable (`relay.maxDeferDeliveries`, default 300 ≈ 5 min). #268 added the 3rd state: `null` (HR boundaries absent = overlay/scroll) → always defer. |

**Invariants we must NOT regress:**
- **#258:** never clobber / never prematurely submit a real in-progress draft.
- **#268:** `null` (box not visible) → always defer; never keystroke into an unknown UI.
- **#294:** CC ghost/placeholder text must never be treated as a real draft to act on.

## 2. The current bug (#302) — exact mechanism

`src/runtimes/cmux.ts` `sendToSurface` **force branch** (lines ~379-388):

```
backspace × (draft.length + 2)        // clear
cmux send <crew msg> ; send-key Enter // deliver
cmux send <draft>                     // RESTORE  ← re-pastes screen-read text
```

The walk-away force fallback fires after `maxDefers` (300) consecutive defers. The force path
trusts that `draft` (read from `parseDraftFromScreen`) is **real user input worth restoring**,
and re-pastes it. When the "draft" is actually a CC **contextual autosuggest ghost** (arbitrary
text, e.g. "wait for both crews to finish"), the final `cmux send <draft>` **materializes the dim
ghost into a real, normal-coloured draft** — the user never typed it.

**Why #294's parse heuristics can't fix this:** CC renders an autosuggest ghost as arbitrary
plain text with no leading `▌` (cursor is drawn via ANSI, hex-proven in #294) and `cmux read-screen`
is plain-text only (no `--raw/--ansi/--cursor`). A ghost is **byte-identical** to a real draft.
**There is no content signal.** Pattern-matching ghosts (`^Press … to …`, leading-glyph) is
whack-a-mole and will never be complete.

## 3. Candidate mechanisms evaluated

**(a) Blind kill-ring (Ctrl-U cut → deliver → Ctrl-Y restore).** *Rejected.* The premise ("Ctrl-U
cuts only real input") is false for CC: Ctrl-U does not cut, it scrolls (§1). CC's input is not a
readline editor outside vi-mode, and there is no stable yank we can drive via `cmux send-key`.
Re-testing live would only re-confirm #267. **Dead on arrival.**

**(b) CC native message QUEUE** ("Press up to edit queued message(s)" — confirmed in the CC bundle).
*Rejected as the primary mechanism.* The queue only engages while CC is **Working/generating**; the
relay cannot force that state, and the common #302 case is CC **idle**. Worse, while Working a
captain's in-progress draft + our `send`+Enter still **merges into the queued entry** — it does not
sidestep the draft-merge problem. Useful only as a future optimization, not a fix.

**(c) Buffer-liveness probe (RECOMMENDED).** A new primitive that recovers kill-ring's *ghost-immunity
property* using only **backspace**, which CC **does** support. Key insight: **a ghost is not in the
real input buffer; backspace is buffer-aware.** So we distinguish ghost vs real draft by *effect on
the buffer*, not by *content* — exactly the signal #302 says is missing from the screen text.

## 4. RECOMMENDATION — Buffer-liveness probe (replace only the force branch)

Leave the hot path untouched (Approach B defer stays). Change **only** the force branch of
`sendToSurface`. On force:

1. Read screen → content `C`. If empty → deliver `MSG`+Enter (unchanged).
2. If `C` non-empty: send **one** `backspace`, re-read screen → `C'`.
   - **Case A — `C' == C` (buffer-invariant):** the box content is a **ghost / static UI**, not in
     the buffer (the backspace was a harmless no-op on an empty buffer). **Deliver `MSG`+Enter.**
     Typing `MSG` replaces the ghost render; Enter submits only `MSG`. **Ghost never materialized.**
   - **Case B — `C'` is `C` minus its last char:** a **real draft** is present. Re-type that one
     known char to restore it, then **defer** (throw `DeferDelivery`). We **never force-merge into a
     real draft** — the relay keeps the message queued; the captain submits/clears later and it
     lands. **Real draft preserved.**
   - **Case C/D — empty after one backspace, or a different non-empty string:** ambiguous edge
     (≤1-char content, or autosuggest re-render). Treat as real (restore + defer) — fail safe
     toward never-materialize. Bounded, rare.

**Crucially: the relay NEVER re-pastes the whole screen-read draft.** Removing that single
`cmux send <draft>` line is what makes ghost-materialization *structurally impossible* — ending the
whack-a-mole permanently. The probe is what keeps crew delivery flowing during a persistent ghost
**without** ever clobbering a real draft.

### Invariants preserved
- **#258:** Case B restores the draft char-for-char and defers — never submits/merges it. ✓
- **#268:** `null` path unchanged — still always defers. ✓
- **#294:** existing ghost heuristics in `parseDraftFromScreen` can stay as a cheap defer-noise
  pre-filter but are **no longer load-bearing**; the probe is the backstop, so an *unknown* ghost
  pattern is now safe (it just resolves to Case A and delivers). ✓
- **New #302 invariant:** the relay never types screen-read content into the box (no full-draft
  re-paste; Case B only re-types the single char *it itself* removed). ✓

### Risk / the ONE thing to verify live in Phase 2 (step 0)
The probe rests on: **CC's autosuggest ghost on an empty buffer is invariant under a no-op
backspace, and backspace on an empty buffer is a true no-op** (Case A holds; doesn't dismiss-to-empty
or re-render a different suggestion). #267 already proved backspace deletes only real chars; the
open question is the ghost's render reaction. **Phase 2 step 0 = a bounded live test** (throwaway
cmux surface + claude, send-key backspace against a displayed ghost vs a real draft, diff
read-screen, then tear down — no orphaned `claude`). If Case A fails, fallback = keep no-repaste +
treat force-with-content as "defer forever, log loudly" (never materialize; crew msg waits) —
strictly better than today but doesn't auto-deliver through a persistent ghost.

### Impact analysis (per CLAUDE.md)
`gitnexus_impact(sendToSurface, upstream)` → **LOW**, 0 static callers (invoked dynamically via the
`RuntimeDriver` cast at `notify-relay.ts:268`). Blast radius is the relay defer loop only, already
mapped. Change is surgical: the force branch of `sendToSurface` + its one test
(`cmux.test.ts:587` "saves draft, clears…restores", which encodes the behavior we're replacing).

## 5. Phase 2 plan (after approval)
0. Live-verify Case A (bounded, self-cleaning claude test).
1. TDD: rewrite `cmux.test.ts:587` to the probe contract (Case A delivers, no full-draft re-paste;
   Case B restores 1 char + `DeferDelivery`); add ghost-materialization regression (ghost content →
   force → asserts MSG submitted and ghost text NEVER re-sent).
2. Implement surgically in the force branch only (karpathy). `gitnexus_impact` before edit;
   `gitnexus_detect_changes` before commit.
3. `npm run build` (tsc gate) + `npm test` green; targeted cmux + notify-relay suites.
4. Crew-lifecycle checklist (`docs/testing/crew-lifecycle-checklist.md`): #258 preserve draft,
   #268 overlay/null defer, #294 ghost. Clean up orphaned vitest.
