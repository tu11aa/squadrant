---
name: telegram
description: Set up and manage the squadrant↔Telegram integration — bot setup, remote control, command-menu registration, and per-project notification tuning (mute, crew tiers, cap). Use when the user asks about Telegram setup, "why don't commands work", registering the /command menu, or muting/tuning notifications.
---

# squadrant:telegram — Telegram Integration

Squadrant pushes crew lifecycle events to Telegram forum topics and accepts commands back from your phone.

## Setup

Run the wizard once (re-run at any time to reconfigure):

```bash
squadrant telegram setup
```

The wizard will:
1. Detect an existing bot token and reuse it (or prompt for a new one).
2. Wait for a message in your forum supergroup to detect the group id and your user-id.
3. Ask whether to enable **remote control** — say **yes** to capture your user-id and enable Gate 2 (command execution).

After setup, the bot's `/command` menu is registered automatically.

**Re-run setup if** `remoteControl` ended up OFF (you said no, or it was skipped). Use `--reset-token` to rotate the bot token.

## Two Gates

| Gate | What it checks | Controls |
|------|----------------|----------|
| Gate 1 — chats allowlist | `telegram.chats` contains the chat id | Inbound messages are processed |
| Gate 2 — remoteControl + user-id | `remoteControl: true` AND sender is in `telegram.users` | Commands execute |

"⛔ not authorized" means Gate 2 is closed — re-run setup and say yes to remote control.

Reference: [`docs/diagrams/2026-06-23-telegram-daemon-architecture.html`](../docs/diagrams/2026-06-23-telegram-daemon-architecture.html)

## Register the `/` Command Menu

Setup registers the menu automatically. To re-register on demand:

```bash
squadrant telegram register-commands
```

If the `/` autocomplete shows no commands in Telegram, run this command.

## Notifications

**Live toggle (ephemeral — resets on restart):**

```bash
squadrant telegram notify <project> on
squadrant telegram notify <project> off
```

**Persistent preferences (written to per-project config):**

```bash
squadrant telegram notify <project> crew <all|alert_only|done_only|none>
squadrant telegram notify <project> cap <on|off>
squadrant telegram notify --status
```

Crew notification tiers (cumulative — each includes all below):

| Tier | What fires |
|------|-----------|
| `all` | Every crew event (started, blocked, done, failed) |
| `alert_only` | Blocked + done + failed (default) |
| `done_only` | Done + failed only |
| `none` | No crew notifications |

`cap=off` silences captain push messages (`squadrant telegram send`) for the project.

**From Telegram** (Gate 2 required):

```
/notify crew done_only
/mute
/unmute
```

A mute confirmation is posted to the topic when you quiet a project.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "⛔ not authorized" | `remoteControl` is OFF or wrong user-id — re-run `squadrant telegram setup` and say yes |
| No `/` autocomplete menu | Run `squadrant telegram register-commands` |
| Topic went silent | `squadrant telegram notify --status`; check crew tier |
| Mute not reflected | Re-run `squadrant telegram notify <project> on` |
| `createForumTopic` 400 errors | Topic already exists in state — `squadrant telegram status` to inspect links |
