# Telegram Tap-First Command UX — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorming) — ready for planning (slice 1 first)
**Scope:** `@squadrant/core` telegram (client + bridge) + `@squadrant/cli` registry
**Builds on:** command channel (#402), notify tiers (#406/#407), @botname strip (#413), bare-/notify usage (#415), inline-buttons (#309)

## Problem

Telegram **auto-sends a command the moment it's tapped from the `/` menu** (bare, with `@botname` in groups). So every command that needs arguments (`/crews <p>`, `/launch <p>`, `/effort <mode>`, `/notify crew <tier>`, `/spawn <p> <task>`) is unusable by tapping — it sends the useless bare form. Only no-arg commands (`/status`, `/projects`, `/help`) work one-tap today.

## Goal

A **tap-first** UX: tapping a parameterized command replies with **inline buttons** (or a guided reply flow) so the user completes it with taps, never by remembering argument syntax.

## Interaction model (chosen: per-command panels)

Each command opens its **own** panel directly — reuses the existing `/` autocomplete, no nested-menu navigation state. No top-level `/menu` hub.

## Per-command treatment

| Command | Behavior |
|---|---|
| `/status` `/projects` `/help` | unchanged — one tap → text reply. `/help` lists what each panel does. |
| `/notify` (project topic) | **panel:** `[Captain: ON/OFF]` toggle · `[Crew: off · alerts · all]` pick-one row (current marked) · `[🔕 Mute topic]`↔`[🔔 Unmute]` toggle |
| `/effort` | **panel:** `[max] [balance] [low]` (global; current marked) |
| `/crews` `/launch` `/mute` `/unmute` (General topic) | **project-picker:** one button per registered project → tap runs it for that project |
| `/mute` `/unmute` (inside a project topic) | act on that topic directly — no picker (existing behavior) |
| `/spawn` | **guided flow:** project-picker → bot ForceReply "Reply with the task for `<p>`…" → user types task → crew spawns |
| `/config set` | **typed-only escape hatch** — removed from the menu/buttons (rare, footgun by phone) |

## Architecture

### Shared button infrastructure (slice 1)
- **`client.ts`:** `sendMessage` gains an optional `replyMarkup` param (inline keyboard or ForceReply); add `answerCallbackQuery(id, text?)` and `editMessageReplyMarkup(chatId, messageId, replyMarkup)`.
- **`bridge.ts`:** the poll loop already iterates updates; extend `handleUpdate` to branch on `u.callback_query` (today only `u.message`). A callback handler:
  1. **Gate** on the tapper (`callback_query.from.id`) — `isControlEnabled(cfg) && isAuthorized(fromId, cfg)`; else `answerCallbackQuery("⛔ not authorized")` and stop.
  2. **Route** by `callback_data` prefix.
  3. **Apply** the change (reuse existing `setNotify`/`saveProjectOverride`/effort write/etc.).
  4. **`answerCallbackQuery`** with a short toast (`✅ crew = alerts`).
  5. **Edit** the panel's keyboard to re-mark current state — **only if it changed** (guard "message is not modified").
- **`callback_data` scheme:** compact, prefix-routed, ≤64 bytes. Project derived from the message's topic thread where possible (notify); encoded inline for General-topic pickers (`cr:<project>`, `lc:<project>`, etc. — project names are <25 chars here).
  - notify: `n:cap:on` `n:cap:off` `n:crew:none|done_only|alert_only|all` `n:active:on|off`
  - effort: `e:max|balance|low`
  - pickers: `cr:<p>` (crews) `lc:<p>` (launch) `mu:<p>` (mute) `um:<p>` (unmute)
- **Panel builders** are pure functions: `(currentState) → InlineKeyboard`, unit-tested independent of I/O.

### Guided spawn (slice 2)
- `/spawn` → project-picker (`sp:<p>`). On tap → bot sends a **ForceReply** message "Reply with the task for `<p>`…" carrying a recognizable marker.
- **Pending-context tracking:** the user's reply is a `message` whose `reply_to_message` is the bot's ForceReply prompt. The bridge recognizes it (prompt text marker, or a small pending-spawn map in `telegram-state.json` keyed by prompt message id) and routes the reply to `crew spawn <p> "<task>"` instead of `captain.message`.
- Gate the reply on the same allowlist. One pending spawn per topic is sufficient.

## Pitfall guards (from Telegram experience — bake into both slices)
- **Always `answerCallbackQuery`** within the callback (even no-op) — otherwise the button spinner hangs ~15s.
- **Guard "message is not modified"** — only `editMessageReplyMarkup` when the rendered keyboard actually differs.
- **Gate on the tapper, never the panel** — anyone in the group can tap a panel someone else opened.
- **Render state fresh on every callback** — derive project from the thread, read current notify/effort live; stale panels still behave.
- **No webhook** — `callback_query` arrives through the same `getUpdates` long-poll (default update set). Fits the existing architecture.

## Components touched
| File | Slice | Change |
|---|---|---|
| `packages/core/src/telegram/client.ts` | 1 | `replyMarkup` on sendMessage; `answerCallbackQuery`; `editMessageReplyMarkup` |
| `packages/core/src/telegram/panels.ts` (new) | 1 | pure panel/keyboard builders + `callback_data` parse/format |
| `packages/core/src/telegram/bridge.ts` | 1 | `callback_query` handling; `/effort` + picker panels on command; `/notify` replies the panel |
| `packages/core/src/telegram/commands.ts` | 1 | drop `config set` from the menu surface (keep typed handler); `/spawn` picker entry |
| `packages/core/src/telegram/bot-commands.ts` | 1 | menu list reflects panels (add `effort`, `spawn`; drop `config`) |
| `packages/core/src/telegram/state.ts` | 2 | optional pending-spawn map |
| `packages/core/src/telegram/bridge.ts` | 2 | ForceReply spawn prompt + reply routing |

## Testing
- **Pure (most coverage):** panel builders render the right keyboard for a given state (current marked); `callback_data` round-trips parse/format; the gate predicate.
- **Bridge:** a `callback_query` from an allowlisted user applies the change + answers + edits once; from a non-allowlisted user → `⛔ not authorized`, no apply; an unchanged tap answers but does NOT edit (no-modified guard); `/effort` and `/crews` taps reply the right panel.
- **Slice 2:** ForceReply reply routes to spawn (not captain.message); non-reply messages unaffected.

## Non-goals (YAGNI)
- No top-level `/menu` hub (per-command panels only).
- No buttons for `/config set` (typed escape hatch).
- No per-crew or multi-step nested menus beyond spawn's single ForceReply.
- No webhook / push transport — long-polling stays.

## Open decisions
None — interaction model (per-command), free-text split (`/spawn` guided, `/config set` typed), and slice boundaries all confirmed with the user.
