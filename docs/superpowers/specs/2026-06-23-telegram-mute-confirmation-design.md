# Telegram Mute-Confirmation — Design

**Date:** 2026-06-23
**Status:** Approved (user confirmed the spec inline) — ready for planning
**Scope:** `@squadrant/cli` telegram `notify` command + a small shared helper
**Builds on:** notification gate (#406) + layered tiers (#407)

## Problem

Turning a notification dimension OFF via the **CLI** (`squadrant telegram notify <p> cap off`, `crew none`, `off`) writes config/state **silently**. On the phone, the topic simply goes quiet with no indication — the user can't tell whether it's muted or just idle. (TG-initiated `/notify` / `/mute` already reply, so the gap is CLI-origin changes.)

## Goal

When a `telegram notify` CLI change makes a project **quieter** (an off/down transition), send a **one-time confirmation** into that project's Telegram topic so the user always learns the topic was silenced — even though subsequent notifications are muted.

## Key decisions (confirmed with user)

1. **Trigger = off/down transitions only**, via the `squadrant telegram notify` CLI:
   - `active`: on → off (mute)
   - `cap`: on → off
   - `crew`: tier lowered (coverage shrinks) — rank `all(3) > alert_only(2) > done_only(1) > none(0)`; notify when `new < old`.
   - ON / louder transitions do **not** notify (self-evident — events resume). YAGNI.
2. **Bypass the gate.** The confirmation is a *meta* message about the mute, sent **directly** via `client.sendMessage` to the topic — NOT through `deliverOutbound` — so it lands even when the project is now muted / `cap=off`.
3. **Scope = the `telegram notify` CLI surface only.** The generic `squadrant config set telegram.notify.*` (global) path is **out of scope** (keeps the change surgical; that path is rarely used and would need to fan out to every topic).
4. **Only when a topic exists.** If the project has no `message_thread_id` yet (never delivered), skip — there was nothing being delivered to announce.
5. **Only on a real transition.** If the value is unchanged (already off / already that tier), send nothing.

## Behavior

`squadrant telegram notify <project> <change>`:
1. Resolve the project's effective notify **before** applying the change (`resolveNotify` over global + per-project, plus live `active` from state).
2. Apply the change (existing logic — write state or per-project config).
3. Resolve **after**.
4. If after is **quieter** than before on the changed dimension, AND the project has a topic, send a one-time confirmation to that topic.

### Confirmation copy (examples)

| Change | Message |
|---|---|
| `cap off` | `🔕 squadrant — captain messages muted here. Re-enable: squadrant telegram notify squadrant cap on` |
| `crew none` (was alert_only) | `🔕 squadrant — crew notifications off (was alert_only). Re-enable: squadrant telegram notify squadrant crew alert_only` |
| `crew done_only` (was all) | `🔇 squadrant — crew notifications reduced to done_only (was all).` |
| `off` (mute) | `🔕 squadrant — all notifications muted here. Unmute: squadrant telegram notify squadrant on` |

Best-effort: a send failure prints a warning but never fails the CLI command (the config/state change already succeeded).

## Components

| File | Change |
|---|---|
| `packages/shared/src/project-config.ts` | export a pure `crewRank(tier): number` + `isQuieter(before, after, dim)` helper (or inline in CLI) — pure, unit-tested |
| `packages/cli/src/commands/telegram.ts` | in the `notify` action: compute before/after resolved notify, detect off/down on the changed dimension, send a one-time confirmation to the project's topic (best-effort) when a topic exists |
| tests | `crewRank`/`isQuieter` table; CLI: off→sends, on→doesn't, no-topic→skips, unchanged→skips, send-failure→still succeeds |

## Non-goals (YAGNI)

- No announce on louder/ON transitions.
- No fan-out for global `config set` changes.
- No new config keys. No daemon changes (the CLI sends directly).
- No confirmation for TG-initiated `/notify` / `/mute` (they already reply).

## Testing

- **Pure:** `crewRank` ordering; `isQuieter` true for cap on→off, active on→off, crew all→none, false for off→on / same / louder.
- **CLI (with a fake TelegramClient):** `cap off` on a project with a topic → exactly one `sendMessage`; `cap on` → zero; project with no topic → zero; `cap off` when already off → zero; `sendMessage` throws → command still exits 0 and writes the change.
