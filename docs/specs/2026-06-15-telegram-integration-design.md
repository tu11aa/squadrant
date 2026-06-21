# Telegram Integration — Design Spec

> **POST-#332 NOTE:** This spec assumes the `notify-relay` transport, which was **deleted in #332**. Inbound/outbound messages now ride **daemon-direct cmux delivery**. Rebase the transport assumptions below onto daemon-direct before resuming implementation.

**Issue:** #65 — Telegram integration for remote cockpit control
**Date:** 2026-06-15
**Status:** Approved design → ready for implementation plan
**Target release:** v1.0.0 (bundled with the four pre-Telegram reliability fixes already on `develop`)

## Goal

Drive cockpit from a phone via Telegram:

- **Outbound** — push curated lifecycle events (crew done, captain blocked, crew idle) to Telegram.
- **Inbound** — reply from Telegram and have the message route to the right session.

Success criteria (from #65 acceptance):

1. Cockpit can push a message to the user on Telegram.
2. The user replies from Telegram and it routes to the correct session.

## Scope decisions (locked during brainstorm)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Direction | **Full two-way** (push + reply) | #65 acceptance requires both. |
| Transport reuse | **Reuse existing mailbox + cmux relay** | Proven path across the daemon→cmux lineage wall; just hardened (#240, #302). Avoids re-solving #249. |
| Listener location | **Inside the daemon**, opt-in + crash-contained | Daemon is always-up, is the event hub, knows every project/task, survives captain restarts. |
| Telegram structure | **Forum Topics**, one supergroup per project | `message_thread_id` is the routing key both directions; topic lifecycle mirrors tab lifecycle. |
| Inbound delivery | **Through the captain** (not direct-to-crew) | Reuses relay with zero new cmux proxy; matches the coordinator model. |
| Outbound granularity | **Curated mailbox messages only** (no token deltas) | Same `formatMessage` source of truth as the laptop; avoids phone spam. |
| Ingress | **getUpdates long-poll** (no webhook) | Works behind home NAT; no public URL. Webhook deferred → #310. |

### Explicit non-goals (deferred)

- Direct-to-crew injection / daemon↔surface direct contract → **#249** (backlog).
- Inline approve/deny buttons for BLOCKED events → **#309**.
- Webhook ingress → **#310**.
- Live token-delta streaming to the phone.

## Architecture

### Topology

```
┌─────────────────────────── cockpitd (daemon) ───────────────────────────┐
│  event hub + mailbox + state-machine + watchdog   (UNCHANGED)            │
│                                                                          │
│  ┌─ Telegram subsystem (NEW, opt-in, crash-contained) ──────────────┐   │
│  │   • outbound: reads mailbox messages → sendMessage(thread_id)     │   │
│  │   • inbound:  getUpdates long-poll → {chat_id, thread_id, text}   │   │
│  │   • topic registry: topic_id ↔ {project, task}                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
        ▲ outbound (best-effort)               │ inbound (via existing relay)
        │                                       ▼
   api.telegram.org                      captain surface (cmux)
```

### Components

1. **`telegram` NotifierDriver** — fills the existing `config.notifier` slot
   (`src/notifiers/`, interface `probe()` + `notify(message)`). Outbound only,
   matching the existing interface. Registered in the `NotifierRegistry`
   alongside `cmux`. The `notify(message)` call resolves the target topic from
   the current task context and calls `sendMessage`.

2. **Telegram inbound loop** — new daemon-resident subsystem. Runs a
   `getUpdates` long-poll loop. Parses each update into
   `{chat_id, message_thread_id, text, from}`. Enqueues an inbound command for
   the relay to deliver to the captain.

3. **Topic registry** — `topic_id ↔ {project, task}` map, persisted alongside
   the daemon's task state. The daemon already owns the task registry; this is
   an adjacent map. Used both directions:
   - outbound: task → `message_thread_id` (create topic on first event).
   - inbound: `message_thread_id` → `{project, task}`.

4. **Telegram API client** — thin wrapper over the Bot API HTTP endpoints used:
   `getUpdates`, `sendMessage`, `createForumTopic`, `closeForumTopic`,
   `getMe` (probe), and capture of `my_chat_member` (for `link`). No third-party
   SDK required; plain HTTPS calls.

The cmux notify-relay and the daemon core are **untouched** for outbound.
Telegram is a parallel consumer of the same mailbox messages.

### Topic mapping

```
cmux                          Telegram
────                          ────────
captain-workspace      →      supergroup  "🚀 <project>"
 ├─ captain tab        →       ├─ topic "⚓ captain"   (general topic)
 ├─ crew-1 tab         →       ├─ topic "🔧 crew-1"
 └─ crew-2 tab         →       └─ topic "🔧 crew-2"
```

Multiple projects = multiple supergroups (1:1 with the workspace model; allows
per-project mute/archive).

## Data flows

### Outbound (push to phone)

```
crew event → state-machine → mailbox entry {message, project, task}
                                   │
              ┌────────────────────┴────────────────────┐
              ▼ (existing)                                ▼ (NEW)
        cmux relay → laptop surface          telegram subsystem:
                                              1. resolve task → topic_id
                                              2. topic missing? createForumTopic, store mapping
                                              3. sendMessage(chat_id, thread_id, message)
                                              4. on failure: log + drop (best-effort)
```

- Reuses the daemon's curated `message` string verbatim (same granularity as the
  laptop relay). Entries the daemon chose not to surface (`message == null`) are
  skipped, exactly as the relay does.
- Topic auto-provisioning: first event for a task creates its topic; crew close
  posts the final result, then `closeForumTopic`.
- Best-effort: a failed Telegram send NEVER blocks or delays cmux relay delivery.

### Inbound (reply from phone)

```
user types in "🔧 crew-2" topic → Telegram
        │
        ▼ getUpdates long-poll (daemon)
  update: {chat_id, message_thread_id, text}
        │
   1. allowlist check: chat_id ∈ configured chats?  (else ignore + log)
   2. map (chat_id, thread_id) → {project, task}
   3. enqueue inbound command to mailbox/relay
        │
        ▼ existing relay (in captain's process tree)
  delivered to CAPTAIN surface:
     "📩 [from Telegram · crew-2] use lucia"
        │
        ▼ captain interprets & acts
  captain → cockpit crew send <project> crew-2 "use lucia"
```

- **Through the captain**, not direct-to-crew. The relay already delivers
  daemon→captain messages across the lineage wall; no new cmux proxy is built.
- The inbound text is delivered as a **message**, not executed as a shell
  command. The captain interprets it as a normal user turn under its existing
  permission mode.
- A reply in the captain topic is delivered to the captain plainly (no task tag).

## Setup & provisioning

One-time, manual:

1. Create a bot via BotFather → obtain the bot token.
2. Create a supergroup per project, **enable Topics**, add the bot as admin with
   *manage topics* permission.
3. Run `cockpit telegram link <project>` — the daemon captures the group's
   `chat_id` from the `my_chat_member` update Telegram emits when the bot is
   added, and binds it to the project.

After linking, the daemon creates topics automatically as crews spawn.

### Configuration

Stored in `~/.config/cockpit` config (JSON, per repo convention):

- `config.notifier = "telegram"` (or keep `cmux` and run Telegram in parallel —
  see Open question O1).
- Telegram block: bot token (secret, gitignored location), per-project
  `chat_id` bindings, and the `chat_id` allowlist.

The bot token must never be committed to the repo.

## Security

This is remote control of the user's machine; treated accordingly:

- **chat_id allowlist** — the daemon only acts on updates from explicitly-linked
  chats. Any other chat is ignored and logged. A stranger who discovers the bot
  cannot route into a session.
- **No shell passthrough** — inbound text becomes a captain *message*, never a
  raw shell command. The captain runs under its normal permission mode; never
  `--dangerously-skip-permissions`.
- **Token isolation** — a leaked token allows messaging the bot, but the
  allowlist still blocks routing into any session.

## Isolation & failure behavior

The Telegram subsystem is wrapped so nothing it does can throw into the daemon's
event loop, mailbox, state-machine, or watchdog. It is modeled as a `liveness`
component that may be `gone` without making the daemon `unhealthy`.

| Condition | Daemon core | Outbound TG | Inbound TG | Laptop relay |
|-----------|-------------|-------------|------------|--------------|
| No `telegram` config | normal | off | off | normal |
| Network down | normal | retries w/ backoff, drops | stalled, retries | normal |
| Telegram API error / bad token | normal | logs + drops | logs + retries | normal |
| Captain dead | normal | normal | queued, can't land | n/a |
| TG loop crashes | unaffected | restarts in-loop | restarts in-loop | normal |

## Testing strategy

- **Pure units** (no network): topic-registry mapping (both directions),
  inbound update parsing, allowlist enforcement, outbound message resolution
  (task → thread_id, skip on `message == null`), failure containment (a thrown
  send is caught and dropped).
- **Telegram API client**: tested against a mocked HTTP layer — assert correct
  endpoints/payloads for `sendMessage`, `createForumTopic`, `getUpdates`,
  `my_chat_member` capture. No live Telegram calls in CI.
- **Isolation guarantee**: a test that forces the TG loop to throw and asserts
  the daemon core (mailbox append, state-machine step, watchdog) is unaffected.
- **Inbound→captain routing**: assert an inbound update produces the correct
  relay-delivered captain message with the right `{project, task}` tag.
- Follows `superpowers:test-driven-development` and the Karpathy discipline
  (surgical, goal-driven, no speculative abstraction).

## Open questions (resolve during planning)

- **O1 — Outbound parallelism.** Should `config.notifier = "telegram"` *replace*
  the cmux notifier, or should Telegram run *in parallel* with cmux (laptop +
  phone both get pushes)? The isolation design assumes parallel is desirable
  (phone is additive, laptop unaffected). If the notifier slot is single-valued,
  we may need a small multi-notifier list rather than a single `notifier` field.
  Recommendation: parallel (additive), via a notifier list.
- **O2 — Inbound queue mechanism.** Reuse the existing mailbox for inbound
  commands, or a small dedicated inbound queue the relay drains? Prefer reusing
  existing relay delivery machinery; confirm the relay can carry a
  captain-directed message that originates from the daemon (not a task event).

## Out of scope (tracked elsewhere)

- #249 — daemon↔surface direct contract (non-cmux drivers).
- #309 — inline approve/deny buttons.
- #310 — webhook ingress.
