# Draft-Clobber: Route Interrupts Through the Mailbox

**Status:** Approved (design) — not implemented
**Date:** 2026-07-09
**Author:** captain brainstorm (owner-approved)
**Issue:** #529
**Scope:** control plane — `squadrant ping`, `squadrant runtime send`, `squadrant runtime send-key`, `delivery-loop.ts`

## Problem

squadrant talks to agent panes by **simulating a keyboard**. There is no message API:

```ts
await cmux(["send", "--workspace", ws, "--surface", sf, sanitizeForCmuxSend(message)]);
await cmux(["send-key", "--workspace", ws, "--surface", sf, "Enter"]);
```
— `packages/workspaces/src/runtimes/cmux.ts:472-473`

So when a notice is injected while the user is mid-typing in a captain pane, the text
**appends to their draft** and the unconditional `Enter` **submits the whole thing**.

Reported symptom: on daemon restart the broadcast
`⚠️ Daemon restarted → v0.15.0 (control-plane bounced)…` landed in the captain's prompt and
submitted, swallowing the user's in-progress message.

## Root cause: the guard is welded to the retry loop

A screen-reading guard already exists — `CmuxDriver.sendToSurface`
(`packages/workspaces/src/runtimes/cmux.ts:593`):

| Condition | Action | Issue |
|---|---|---|
| `draft === null` (input box not visible) | `throw DeferDelivery(null)` (`:633`) | #268 |
| `hasModalOptionList(screen)` | `throw DeferDelivery(null)` (`:643`) | #484 |
| `draft === ""` | `deliver()` — the only write path (`:646`) | — |
| `draft` non-empty, no probe | `throw DeferDelivery(draft)` (`:650`) | #302 |
| probe mode | backspace ghost-probe (`:652-702`) | #258 |

The guard signals "wait" by **throwing**. Throwing only works if a caller **retries**.

**Exactly one caller in the repo catches `DeferDelivery`:** `CaptainDelivery.deliver`
(`packages/core/src/delivery/captain-delivery.ts:75`), driven by the daemon delivery-loop
(`packages/core/src/daemon/delivery-loop.ts:250`), which does **not** advance the mailbox
cursor — so the entry is retried on the next tick. `daemon-cmux.ts:34` merely re-throws.

Therefore:

- Callers **with** a retry loop (the daemon) may use the guard → safe.
- Callers **without** one (every CLI one-shot; the boot-time broadcast) cannot use the guard —
  catching `DeferDelivery` in a process that is about to exit accomplishes nothing. They are
  forced onto the raw path `CmuxDriver.send` (`cmux.ts:461-480`): send + unconditional `Enter`,
  zero screen reads.

**The mailbox is the only bridge between the two worlds.** It lets a no-retry caller borrow the
daemon's retry. This is why Telegram inbound (`telegram/bridge.ts:423` → `appendCaptainMessage`)
is safe and `ping` is not — not because anyone protected Telegram, but because it happened to go
through the mailbox.

Protection lives at the **call site**, not at the **chokepoint**. `CmuxDriver.send` is the
innocuous-looking default, so every new surface is unsafe by default. #258 / #302 / #484 each
patched one call site; they are symptoms of this layer.

## Three classes of traffic

| Class | Producer | Path today | Verdict |
|---|---|---|---|
| **Lifecycle** — `CREW DONE/IDLE/BLOCKED/STALLED` | daemon, `reduce.ts:157` | socket → mailbox → guard | ✅ already safe |
| **Inbound conversation** — Telegram, `ping`, `runtime send` | outside the daemon | Telegram: mailbox ✅ · ping / runtime send: **raw** 🔴 | fix |
| **System directives** — restart broadcast, effort change | daemon boot / CLI | **raw** 🔴 | PR #530 |

Both classes 2 and 3 are **interrupts**: they change captain behaviour and require action. An
`interrupt` / `passive` taxonomy was considered and **rejected** — the passive bucket has zero
members. Liveness transitions and config drift never touch the pane; they live in
`squadrantd.log` and the dashboard. Do not introduce the split without a real member.

The bug was never "too many interrupts". It is that **interrupts bypass the guard**.

## Design

CLI one-shots stop being typists and become **producers**. They enqueue; the daemon delivers.

```
CLI (ping / runtime send)
  ├─ requireDaemon()          NEW — socket dead → exit 1, nothing enqueued
  ├─ needRef()                unchanged — target workspace not running → exit 1
  └─ appendCaptainMessage()   enqueue, then exit
                                   ↓
daemon delivery-loop → CaptainDelivery → sendToSurface → [guard] → write only when box empty
                            ↑ DeferDelivery → retry next tick
```

Because enqueue happens **only when the daemon is alive**, entries drain within a tick or two.
The stale-skip rule (below) therefore never fires for them, and needs no change.

### Fail-fast vs best-effort

The distinction is **what the caller is for**, not what it touches.

| Command | Primary job | Notification | Daemon down |
|---|---|---|---|
| `ping` | *is* delivering a message | — | `exit 1`, nothing enqueued |
| `runtime send` | *is* delivering a message | — | `exit 1`, nothing enqueued |
| `effort` | write config | incidental | write config, `exit 0` — notice may be dropped |
| restart broadcast | — | — | cannot happen — runs *inside* the daemon at boot |

`effort` is already best-effort: `commands/effort.ts:115-117` catches and prints
`(no running captain detected — change applies on next launch)`. Preserve that. `requireDaemon()`
applies **only** to `ping` and `runtime send`.

`appendCaptainMessage` writes a local file, so `effort` enqueues whether or not the daemon is up.
If the daemon is down and later boots past the stale window, the effort notice is dropped. That is
**accepted**: the config write — the command's actual job — already succeeded, and the next captain
launch reads the new value anyway. Do **not** add `requireDaemon()` to `effort` to "fix" this; doing
so would fail a command that did its job.

There must be no path where a message is silently discarded while the caller believes it was sent.

### `--command` requires a delivery-loop change

`runtime send --command` targets the **command workspace**. The drain loop iterates:

```ts
const allProjects = [...new Set([
  ...Object.keys(cfg.projects ?? {}),
  ...Object.keys(injectedSurfaces),
  ...store.listAll().map((t) => t.project),
])];
```
— `packages/core/src/daemon/delivery-loop.ts:201-206`

`cfg.commandName` (default `"🏛️ command"`) is **not a project**, so an entry enqueued under that
name is never read. Line 209 compounds it:
`const captainTitle = projCfg?.captainName ?? \`${project}-captain\`` — the wrong surface title
for the command workspace.

Routing the notifier through the mailbox without fixing this would **lose the message permanently**.
`delivery-loop.ts` must therefore be **in scope**, contrary to the constraint imposed on the first
crew attempt (see Rejected Alternatives).

### `source` widening

`appendCaptainMessage` takes `source: "telegram" | "daemon"` (`packages/core/src/mailbox.ts:154`).
`ping` and `runtime send` are typed by a human or an agent, not by the daemon. Add `"cli"` —
one line. Do **not** reuse `"daemon"`: nothing reads `payload.source` today, but a mislabelled
record is a lie that will be believed the moment someone writes the first reader.

## Per-surface change table

| # | Surface | file:line | Change |
|---|---|---|---|
| 1 | `runtime send-key` | `packages/cli/src/commands/runtime.ts:105-122` | **Delete the command.** |
| 2 | `ping` | `packages/cli/src/commands/ping.ts:17` | `requireDaemon()` + `appendCaptainMessage(source:"cli")` |
| 3 | `runtime send` | `packages/cli/src/commands/runtime.ts:97` | same; `--command` → `project = cfg.commandName` |
| 4 | drain loop | `packages/core/src/daemon/delivery-loop.ts:201-209` | include `cfg.commandName` in `allProjects`; use it verbatim as the surface title |
| 5 | `mailbox.ts` | `packages/core/src/mailbox.ts:154` | widen `source` to `"telegram" \| "daemon" \| "cli"` |
| 6 | `notifiers/cmux.ts` | `:32` | **no change** — shells out to `runtime send --command`, fixed transitively |
| 7 | restart + effort broadcasts | — | **no change** — PR #530 already routes them via `appendCaptainMessage` |

## Migration: deleting `runtime send-key`

`squadrant runtime send-key` has **zero callers**. Verified across source, `plugin/skills/`,
`templates/`, `~/.config/squadrant/scripts/`, and shell history. It is registered
(`packages/cli/src/index.ts`) and defined (`runtime.ts:105`) and never invoked.

The escape hatch people actually use is the cmux binary directly:

```
/Applications/cmux.app/Contents/Resources/bin/cmux send-key --workspace "workspace:N" Enter
```
— `plugin/skills/command-ops/SKILL.md:73`

`squadrant` is published to npm, so removing a public CLI verb is a **breaking change**. The owner
approved deletion without a deprecation cycle. Record it under **BREAKING** in `CHANGELOG.md`,
naming the cmux-binary replacement.

Delete rather than guard: a keypress cannot be queued sensibly. The guard only releases when the
input box is **empty** — which is precisely when a deferred `Enter` is meaningless. A key's meaning
is bound to the screen state at the instant it is pressed; deferring it changes what it does. That
is the whole argument against the rejected alternative below.

## Non-goals (explicitly out of scope)

- **`sendRaw` / inverting the chokepoint default.** Making `CmuxDriver.send` draft-aware and
  exposing a loudly-named raw variant is the right long-term shape, but it changes the semantics of
  a function with six call sites. Deferred to its own issue.
- **`launch-workspace.ts:74`** — raw `runtime.send` into a *booting* captain, already gated by its
  own `idle/working` classify. Left alone.
- **Raw-but-benign `sendToPane` callers** — `crew-spawn.ts:189,358,412,447`, `side-session.ts:158,190`,
  `dashboard.ts:77`, `command.ts:80`. They target freshly created empty panes. Safe by construction,
  not by guard. Unchanged, but note the assumption is unenforced.
- **The stale-skip rule** (`delivery-loop.ts:239`). Unchanged. Fail-fast means new entries are only
  written when the daemon is alive, so they drain long before the 5-minute window.
- **`confirmedSendToPane`** (`crew-pane.ts:135`) — protects against paste-strand (#339); guarantees
  the *crew's* payload is submitted. It does **not** check for a human draft, and it targets crew
  panes. Different protection, different subject. Do not conflate. The name is a trap: `confirmed`
  reads as "safe for the user" and is not.

## Known adjacent bug (file separately)

Telegram inbound is also `kind: "captain.message"`, which is **not** in `TERMINAL_KINDS`
(`delivery-loop.ts:20`). Any `captain.message` that is enqueued but **not yet delivered** when the
daemon restarts more than `STALE_THRESHOLD_MS` (5 min, `interactive-probe.ts:7`) later is silently
acked and dropped — `delivery-loop.ts:239-246` advances the cursor past it.

Reachable two ways, both ordinary:

1. The captain has a draft, so delivery defers (#302) — then the daemon restarts.
2. The captain workspace is **closed**, so `delivery-loop.ts:224` (`if (!surface) continue;`) never
   reads the cursor at all. Messages queue for as long as the workspace is shut. Reopen it and
   restart the daemon, and the whole backlog is discarded.

Note the bridge runs **inside** the daemon (`squadrantd.ts:68`), so a message cannot be enqueued
while the daemon is down — there is no consumer. The trigger is an *undelivered* message surviving a
restart, not one *sent* during an outage.

Pre-existing, outside #529. Owner elected to file separately and fix later.

## Why it fired when it did

The restart broadcast is gated on a signature of `version::buildMtimeMs`
(`daemon-restart-broadcast.ts:26-39`). A local `npm run build` moves `dist`'s mtime → the signature
changes → the next daemon boot broadcasts to every live captain, raw, with `Enter`.

**Every dev rebuild followed by a daemon restart clobbers every captain's draft.** Not bad luck.

## Tests

Each surface, unit level, with a fake driver:

- **`ping`** — asserts **zero** `driver.send` / `driver.sendKey` calls, and exactly **one**
  mailbox entry with `source: "cli"`.
- **`runtime send`** — same.
- **`runtime send --command`** — enqueues under `cfg.commandName`.
- **Daemon down** — `ping` and `runtime send` exit non-zero **and** enqueue **nothing**. Assert both;
  the exit code alone would pass against a version that enqueued first and then threw.
- **`effort` with daemon down** — writes config and exits **zero**. Guards the best-effort contract
  against an over-eager `requireDaemon()`. Do not assert on enqueue here: the mailbox write is a
  local file append and succeeds regardless of daemon state.
- **`delivery-loop`** — an entry under `cfg.commandName` is drained and delivered. *This test must
  fail against current `develop`* — that failure is the evidence the gap is real. A test that passes
  before the fix proves nothing.
- **`send-key`** — the command is no longer registered on the CLI program.

Assert on **call counts**, not just mailbox contents. The point is that nothing keystrokes the pane.

## Rejected alternatives

**Mailbox `captain.send-key` kind** (crew attempt, preserved at `.scratch/p2-rejected-154601.patch`).
Added a `captain.send-key` mailbox kind, `sendKeyToSurface`, and a `keyOnly` parameter threaded
through `sendToSurface`. Rejected because:

1. It built a queueing mechanism for a command with zero callers that is being deleted.
2. Deferring a keypress is semantically wrong (see Migration, above).
3. `sendToSurface(surface, "", { keyOnly })` — a text-send function repurposed to send keys with an
   empty payload — muddies the contract.
4. `sendKeyToSurface?` was declared **optional** on the driver interface: a driver that forgets to
   implement it falls back silently.

The attempt was, however, **right about `delivery-loop`**: it independently discovered that the
command workspace is not drained and patched `cfg.commandName` in. The captain's "do not touch
delivery-loop" constraint was wrong, and the crew was penalised for obeying the problem rather than
the instruction. That constraint is lifted in this spec (change #4).

**Two physical channels** (system log vs conversation). Rejected: the mailbox *is* the channel; what
was missing was a classification, and the classification turned out to have an empty bucket. Two
channels means two cursors, two drains, two failure modes, for the same result.

**Routing `ping` through the daemon socket** (like `dispatch`). Considered, to make `ping` visible
in `squadrantd.log` — it currently bypasses the daemon entirely and leaves no trace. Rejected:
`delivery-loop` **already logs every delivered entry** (`delivery seq=… kind=… outcome=delivered`),
so the mailbox route provides the same visibility without a new socket verb.

## Open questions

1. Should `requireDaemon()` live in `packages/cli/src/lib/` or reuse an existing socket helper?
   `group-dispatch.ts:35` already probes daemon health via `sendRequest(sockPath, { kind: "health" })`.
   Prefer reuse over a new probe.
2. Exact wording and exit code for the daemon-down error. Suggested: `exit 1`,
   `daemon not running — message NOT delivered. Start it with 'squadrant launch <project>'.`
3. Does anything outside this repo depend on `squadrant runtime send-key`? Assumed no; a wider search
   before the release would cost little.
