# #339 — first-turn Enter inserts a newline instead of submitting — ROOT CAUSE PROVEN ✅

**Date:** 2026-06-26
**Branch:** `crew/fix-339`
**Method:** superpowers:systematic-debugging — live reproduction against a real Claude Code surface before any fix.

---

## Symptom

A crew first-turn (or captain Enter) intermittently leaves the full payload sitting
**unsubmitted** in the input box, prefixed `❯ [Pasted text #1][Pasted text #2][Pasted
text #3]…` — multiple pastes, **zero submits**, `Ctx Used 0.0%`. The turn never runs.
Reported several times a day. Prior triage (`2026-06-16-dbg-cmux-double-startup-and-enter-newline.md`)
could not reproduce it in isolation and ruled out: content newlines, the plain
send+Enter race (15/15 clean on short messages), working-state delivery, and the
#302 backspace probe.

## What the prior triage missed: the payload SIZE is the trigger

Short messages (captain DONE, ≤200 char) submit 15/15 — they never enter Claude
Code's **paste mode**. The first-turn *task* payload (`task + "\n\n" + completionProtocol`,
collapsed to one line by `sanitizeForCmuxSend`) is **thousands of characters**. That
is what triggers the bug. The differentiator is paste-mode, not content.

## Delivery path

`sendFirstTurnWhenReady` (`packages/workspaces/src/crew-pane.ts`) → `sendToPane`
(`packages/workspaces/src/runtimes/cmux.ts:431`):

```ts
await cmux(["send",     ..., sanitizeForCmuxSend(message)]);  // socket write #1: the text
await cmux(["send-key", ..., "Enter"]);                       // socket write #2: the CR
```

Two separate socket writes. On retry, `sendFirstTurnWhenReady` re-calls `sendToPane`
— i.e. it **re-pastes the entire task** and issues another Enter.

## Live experiments (real `claude --model sonnet` surface, driven via cmux CLI)

| # | Stimulus | Result |
|---|----------|--------|
| 1 | 3 298-char single-line payload, immediate `send`+`send-key Enter` | Rendered **inline**, **submitted** cleanly. No paste mode at this size. |
| 2 | 8 912-char payload, `send` only (no Enter) | Box shows `❯ … [Pasted text #2][Pasted text #3]…[Pasted text #9] …` — **paste-mode reproduced**. cmux/PTY chunks a big `send`; Claude Code coalesces the chunks into `[Pasted text #N]` placeholders. |
| 3 | After #2, wait ~2 s for the box to settle, **then** `send-key Enter` | **Submitted** (box emptied, turn started). A settled Enter always submits. |
| 4 | 8 912-char payload + trailing `\n` in **one** `cmux send` (CR coalesced into the paste burst) | **STRANDED.** Box not empty, not working; the CR landed as a literal newline *inside* the paste: `…[Pasted text\n  #82]…`. **Deterministic proof of the mechanism.** |
| 5 | On the stranded box from #4, re-issue **only** `send-key Enter` (no re-paste) | **Submitted** — the box emptied. Validates the fix: re-issue the CR, never re-paste. |
| 6 | Immediate `send`+`send-key Enter`, 8 912-char, ×10 trials, quiet machine | 9 submitted / 1 inconclusive / 0 stranded — the per-Enter race is **low-probability when unloaded** (matches "not reproducible in isolation"). |

## Root cause

The first-turn payload is large enough to put Claude Code into **paste mode**: cmux/PTY
delivers the big `send` as multiple chunks and Claude Code coalesces them into
`[Pasted text #N]` placeholders, keeping a short **paste-accumulation window** open.

`sendToPane` issues the submit CR as a *separate* socket write immediately after the
paste. When that CR is consumed by Claude Code **while the paste-accumulation window
is still open** — which happens when the two socket writes land in a single PTY read
under load, or when the CR simply arrives before the paste finishes rendering — Claude
Code treats the CR as a **literal newline appended to the pasted text**, not as a
submit. The payload is stranded (experiment #4 reproduces this exactly).

The current **retry makes it worse**: it re-calls `sendToPane`, **re-pasting the whole
task** (stacking another `[Pasted text]`) and racing another CR the same way. Once
stranding conditions hold across the ~1.5 s retry window, every attempt strands →
"3 pastes, 0 submits."

This explains every observation: short messages never strand (below paste threshold,
15/15), the large first-turn task strands under load, and all retries strand together.

## Fix (see PR)

Deliver the task and submit it as **two separated, confirmed** steps in the
claude/codex first-turn path (`sendFirstTurnWhenReady`):

1. **Paste only** (`pasteToPane`, no Enter).
2. **Settle** — poll the input box until its content is stable across two reads (the
   paste-accumulation window has closed).
3. **Submit** with a separate `sendKeyToPane(pane, "Enter")`.
4. **Confirm** via read-back: the input box is empty ⇒ submitted. If the box still
   holds the draft, re-issue **only the Enter** (re-settle first) — **never re-paste**
   (re-pasting is what stacks `[Pasted text]` placeholders). Bounded attempts.

The opencode splash path (#235, recently live-verified) is **left unchanged**. The
short shell-launch and crew-message `sendToPane` callers are **left unchanged** (they
are below the paste threshold and rely on the atomic send+Enter).
