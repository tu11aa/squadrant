# Telegram Per-Project Notification Gate — Design

**Date:** 2026-06-23
**Status:** Approved (design); pending spec review → implementation plan
**Scope:** `@squadrant/core` telegram subsystem + `@squadrant/cli` telegram command
**Relates to:** v0.10.0 Telegram stability (#321/#402/#403), composes with side-1 research on TG message buildup

## Problem

The daemon pushes every crew lifecycle event (done / blocked / idle) to that project's
Telegram topic via `pushLifecycle` → `deliverOutbound` (`packages/core/src/telegram/bridge.ts`).
This is **unconditional**: as soon as a project has activity, its topic fills with
notifications whether or not the user is paying attention to that project right now.

The user wants notifications to flow **only when they are engaged** with a project —
i.e. notifications are OFF by default and turn ON when the user either (a) sends a
message into that project's Telegram topic, or (b) flips them on explicitly.

## Goals

- Per-project mute gate in front of the **outbound lifecycle** path only.
- Default **muted** — fresh / never-toggled projects send nothing.
- **Auto-unmute** a project when the user messages into its topic.
- **Sticky** lifetime — once active, stays active until explicitly muted.
- Manual toggle from **both** Telegram (`/mute`, `/unmute`) and the **CLI**.

## Non-Goals (YAGNI)

- No global master switch (per-project only — confirmed with user).
- No timers / quiet-window auto-re-mute (sticky only).
- No `TelegramConfig` schema change / config migration.
- No change to command-reply delivery — replies to user commands always go through;
  only auto-pushed **lifecycle** events are gated.
- Cleanup of **existing** topic clutter (delete/coalesce/digest) is out of scope here —
  tracked separately by the side-1 research thread. The two features compose: this gate
  stops *new* clutter; that research handles *existing* clutter.

## Design

### 1. State

Per-project notification flag persisted in the existing `telegram-state.json`
(alongside `offset` + `topics`):

```jsonc
{
  "offset": 12345,
  "topics": { "squadrant::project": 7 },
  "notify": { "squadrant": true }   // present & true = ACTIVE; absent or false = MUTED
}
```

- **Absent key = muted** (the default). No backfill, no migration.
- `TelegramState` interface gains `notify: Record<string, boolean>`; `loadState`
  defaults it to `{}`; `saveState` persists it.
- New helpers in `state.ts`:
  - `isNotifyActive(stateRoot, project): boolean` — `state.notify[project] === true`.
  - `setNotify(stateRoot, project, active: boolean): void` — read-modify-write
    (mirrors `setTopic`).

### 2. The gate (outbound)

In `bridge.ts`, gate **before** any network call inside the outbound path:

```ts
function deliverOutbound(project, ev) {
  if (!isNotifyActive(stateRoot, project)) return;  // muted → drop, no topic creation
  // …existing lazy-topic-create + sendMessage…
}
```

Placing the check first means a muted project triggers **no** `createForumTopic`
and **no** `sendMessage` — nothing reaches the phone. `pushLifecycle` stays
fire-and-forget; the gate is a synchronous early-return.

### 3. Auto-unmute (inbound)

In `handleProjectTopic` (`bridge.ts`), when an inbound message lands in a project
topic, mark that project active **before** appending the captain message:

```ts
async function handleProjectTopic(text, threadId, fromId) {
  const resolved = findProjectByThread(stateRoot, threadId);
  if (!resolved) return;
  setNotify(stateRoot, resolved.project, true);   // ← engagement = unmute (sticky)
  // …existing ensureCaptainAlive (gated) + appendCaptainMessage…
}
```

- **Independent of `remoteControl`.** Auto-unmute fires for any inbound that passes
  the coarse chat allowlist (`cfg.chats.includes(chat.id)`), the same filter v1 already
  applies before appending a captain message. Rationale: receiving the user's message
  *is* the engagement signal; gating it behind `remoteControl` would leave the user
  messaging into a silent topic. This guarantees the user is never stuck muted — a
  message always reopens the channel.

### 4. Manual toggle — two surfaces

**Telegram** (`commands.ts` registry + `bridge.ts` routing):
- `/unmute` / `/mute` **inside a project topic** (message has a `message_thread_id`):
  resolve the project via `findProjectByThread`, toggle it.
- `/mute <project>` / `/unmute <project>` **from the General topic** (no thread id):
  explicit project argument.
- **Fail-closed** (confirmed with user): these are explicit commands and follow the
  existing command rule — they run only when `isControlEnabled(cfg)` **and**
  `isAuthorized(fromId, cfg)`. When unauthorized: `⛔ not authorized` (same as other
  commands). The user is still never stuck, because auto-unmute-on-message (§3) works
  without `remoteControl`.
- On success, reply with confirmation, e.g. `🔔 squadrant notifications ON` /
  `🔕 squadrant notifications OFF`.

> Routing note: `/mute` and `/unmute` are the first commands that are also valid
> **inside a project topic** (today the project topic only does captain.message +
> auto-launch). `handleProjectTopic` must recognize these two commands and route them
> to the toggle instead of appending them as a captain message. All other `/`-text in a
> project topic keeps current behavior (appended as captain.message). Keep this
> allowlist explicit and minimal.

**CLI** (`packages/cli/src/commands/telegram.ts`):
- `squadrant telegram notify <project> on|off` — set the flag (writes `telegram-state.json`
  under the resolved `stateRoot`).
- `squadrant telegram notify --status` (or `squadrant telegram notify` with no args) —
  list each known project's state (active / muted), derived from `state.notify` plus
  known topics.
- Works regardless of `remoteControl` — local operator escape hatch.

### 5. Sticky lifetime

No timers. Active persists until `/mute` or `notify off`. A daemon restart preserves
state (it's on disk in `telegram-state.json`).

## Behavior matrix

| remoteControl | User messages in topic | Telegram `/unmute` | CLI `notify on` |
|---|---|---|---|
| OFF (default) | ✅ unmutes (sticky) | ⛔ unauthorized | ✅ works |
| ON + allowlisted | ✅ unmutes | ✅ works | ✅ works |

Lifecycle delivery after gating:

| Project state | `pushLifecycle` result |
|---|---|
| muted (default / `/mute` / `notify off`) | dropped — no topic create, no send |
| active (messaged-in / `/unmute` / `notify on`) | delivered as today |

## Backward-compatibility note

This **changes v0.10 behavior**: previously every project sent all lifecycle events;
now a project is silent until engaged. This is the explicitly requested behavior
(muted-by-default). Documented in CHANGELOG as a behavior change, not a silent one.
Command replies and the General command channel are unaffected.

## Components touched

| File | Change |
|---|---|
| `packages/core/src/telegram/state.ts` | `notify` field + `isNotifyActive` / `setNotify` |
| `packages/core/src/telegram/bridge.ts` | gate in `deliverOutbound`; auto-unmute + `/mute`/`/unmute` routing in `handleProjectTopic`; General-topic toggle in `handleGeneral` |
| `packages/core/src/telegram/commands.ts` | parse `/mute` / `/unmute` (optional `<project>` arg) |
| `packages/cli/src/commands/telegram.ts` | `notify <project> on|off` + `notify --status` subcommand |
| tests | state defaults/round-trip; gate drops when muted; auto-unmute on inbound; fail-closed toggle; CLI subcommand |

## Testing strategy

- **state**: `notify` defaults to `{}`; `isNotifyActive` false when absent; `setNotify`
  round-trips through save/load.
- **gate**: muted project → `deliverOutbound` makes zero client calls; active project →
  sends as before.
- **auto-unmute**: inbound to a project topic flips `notify[project]` true and still
  appends the captain message; works with `remoteControl` OFF.
- **toggle (Telegram)**: `/unmute` in-topic and `/mute <project>` from General flip
  state when authorized; rejected `⛔ not authorized` when control off / not allowlisted;
  a `/mute` in a project topic is NOT appended as a captain message.
- **toggle (CLI)**: `notify on|off` writes state; `--status` lists states.

## Open questions

None remaining — all design decisions confirmed with the user
(per-project · muted-by-default · sticky · both surfaces · fail-closed Telegram toggle).
