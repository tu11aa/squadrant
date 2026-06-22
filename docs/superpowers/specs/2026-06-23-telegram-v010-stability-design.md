# Telegram v0.10 Stability Slice — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorm) — ready for implementation plan
**Issues:** closes the squadrant-side of #403, the general-command facet of #402, and the user-id allowlist of #321
**Builds on:** #397 (Telegram two-way v1)
**Target release:** v0.10.0 (first npm release to include Telegram)

## Problem

Telegram v1 (#397) is live on `develop` but has two usability gaps that block a confident v0.10:

1. **Gap 1 — stranded messages.** Sending a task to a project topic does nothing if that project's captain is not already running. The inbound `captain.message` queues in the mailbox and waits for a *manual* `squadrant launch`. From the phone there is no way to launch, so the flow dead-ends.

2. **Gap 2 — no general control channel.** Everything is project-topic-scoped. There is no way to run `squadrant`-CLI-style operations (list projects, register a project, change config, launch a captain) from the phone when no project/captain is involved.

Both are remote-control surfaces, and today's allowlist is **chat-level** (any supergroup member). Shipping remote control on a chat-level gate is unsafe, so this slice also lands the **user-id allowlist (#321)**.

Out of scope: Wake-on-LAN / relay infra (operator's machine-side responsibility; documented in #403, not built here). Captain-level slash-commands inside project topics (rest of #402) are deferred.

## Routing model

The forum supergroup already has a **General topic** (messages there carry no `message_thread_id`) plus one topic per project (each carries a `thread_id`). Today `handleUpdate` requires a `thread_id`, so General-topic messages are silently dropped. New classification in `handleUpdate`:

| Inbound message | Routes to |
|---|---|
| Project topic (`thread_id` resolves to a project) | Existing `captain.message` flow **+ auto-launch if no captain alive** (Gap 1) |
| General topic (no `thread_id`), text starts with `/` | **General command registry**, executed by the daemon (Gap 2) |
| General topic, freeform (no `/`) | Reply with a short `use /help` hint — do not silently drop |

`thread_id` presence is the discriminator — no new config needed to designate the channel.

## Gap 1 — daemon auto-launch on project inbound

When a project-topic message resolves to a project but **no captain is alive**, the daemon boots one, then delivers.

- **Liveness check:** in-daemon, reuse the existing captain-liveness signal (`captainMissingStreak` / `stoppedProjects` in `daemon/delivery.ts`) rather than the CLI health round-trip. Captain considered alive when streak is 0 and not in `stoppedProjects`.
- **Boot-if-down:** spawn `squadrant launch <project>` via **async `execFile`** (never `execFileSync` on the daemon hot path — see learning `#2` event-loop starvation), then poll liveness with a bounded warmup (reuse the `group dispatch` warmup constants: ~120s timeout, ~1s poll). On warmup success, append the `captain.message`. On timeout, post a one-line failure to the topic and still leave the message queued.
- **Debounce:** while a project is mid-warmup, additional inbound messages for that project queue to the mailbox but do **not** spawn a second launch. A per-project "launching" guard set, cleared on warmup success/timeout.
- **Decoupling:** the bridge does not know about captain lifecycle. It receives an injected capability:
  ```ts
  ensureCaptainAlive?: (project: string) => Promise<"alive" | "launched" | "timeout">
  ```
  wired from the daemon host at bridge construction. Undefined ⇒ today's behavior (queue only).
- **Gating:** only acts when `remoteControl` is enabled AND `message.from.id` is allowlisted (see Security).

## Gap 2 — general command registry

Daemon-executed, curated commands. Each maps to a **validated action**, not a shell passthrough — no arbitrary `squadrant <args>`.

**v1 command set:**

| Command | Action |
|---|---|
| `/help` | List available commands |
| `/status` | Daemon + per-project summary (which captains are live, crew counts) |
| `/projects` | List registered projects (name → path, group) |
| `/crews <project>` | List live crews for a project (read-only) |
| `/launch <project>` | Boot a captain for a project |
| `/register <repo-url> [--group <g>]` | Register a project (non-interactive path only) |
| `/config get <key>` | Read a config value |
| `/config set <key> <value>` | Write a config value (allowlisted keys only — see below) |
| `/effort <max\|balance\|low>` | Read/set the crew tokenomics dial |
| `/spawn <project> <task>` | Spawn a crew (routes through normal crew routing) |

- **Execution:** each command resolves to a specific squadrant CLI invocation run via **async `execFile`** with an argv array (no string interpolation into a shell). The registry maps command → `{ argv builder, validator }`. Unknown command ⇒ `unknown command, try /help`.
- **`/config set` safety:** restrict to an explicit allowlist of writable keys (e.g. `defaults.effort`, per-project `acceptDelegations`). Reject anything that could exfiltrate or weaken security (never allow writing `telegram.botToken`, `telegram.users`, `telegram.chats` over Telegram). The exact writable-key list is finalized during implementation; default-deny.
- **`/register` non-interactive:** must use the CLI's flag-driven path, not the interactive wizard skill. If required flags are missing, reply with usage.
- **Output:** command result (stdout/stderr summary, capped length) posted back to the General topic via the existing telegram send path.
- **Gating:** only when `remoteControl` is enabled AND `message.from.id` is allowlisted.

## Security gate (#321) + opt-in

Extend `TelegramConfig` (`packages/shared/src/config.ts`):

```ts
interface TelegramConfig {
  botToken?: string;
  supergroupId: number;
  chats: number[];          // existing chat-level allowlist (retained)
  users?: number[];         // NEW: Telegram user-id allowlist
  remoteControl?: boolean;  // NEW: opt-in master switch, default false
  pollMs?: number;
}
```

- **Auth check in `handleUpdate`:** existing chat check is retained as a coarse filter. Both new surfaces (auto-launch, general commands) additionally require `message.from.id ∈ users[]`. If `users` is empty/undefined, the new surfaces are treated as disabled (fail closed) — do not fall back to chat-level for control actions.
- **`remoteControl` flag:** master opt-in. When false (default), neither auto-launch nor general commands act; v1 behavior (freeform task → live captain, lifecycle push-out) is unchanged. This keeps existing installs safe-by-default after upgrade.
- **Non-allowlisted sender** issuing a command / triggering auto-launch ⇒ ignore; optionally a single "not authorized" reply (no command echo).
- **Unchanged:** freeform task text to an already-live captain stays chat-level (low risk — only reaches a captain that an operator already started). Only the *new* control surfaces require user-id auth.
- **Setup wizard:** `telegram setup` should capture the operator's user-id and offer to enable `remoteControl` (implementation detail; keep token input masked as today).

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `TelegramConfig` (shared) | config shape: `users[]`, `remoteControl` | — |
| `handleUpdate` (core/telegram/bridge) | classify message → project / general / hint; enforce auth | config, auth helper, registry, ensureCaptainAlive |
| auth helper | `isAuthorized(from_id, cfg)` + `isControlEnabled(cfg)` | config |
| command registry (core/telegram) | map `/cmd args` → validated `execFile` argv; format result | CLI binary |
| `ensureCaptainAlive` (daemon host) | liveness check + boot-if-down + warmup + debounce | delivery state, `squadrant launch` |
| telegram send (existing) | post results/hints back to a topic | — |

Each is independently testable: registry parsing/validation with no network; auth helper as a pure function; `ensureCaptainAlive` with a stubbed launcher; routing in `handleUpdate` with fake updates.

## Testing

- **Unit:** message classification (project / general-slash / general-freeform); auth matrix (allowlisted vs not × remoteControl on/off — fail-closed); registry parse + argv-builder + unknown-command + `/config set` key allowlist (deny non-writable); usage errors for missing args.
- **Auto-launch:** stubbed launcher — alive ⇒ deliver immediately; dead ⇒ launch + warmup-success ⇒ deliver; warmup-timeout ⇒ failure reply + still-queued; debounce ⇒ one launch under burst.
- **No daemon-blocking:** assert command/launch execution uses async `execFile` (no `*Sync` on the poll path).
- **Regression:** full suite green; existing v1 flows (freeform → live captain, lifecycle push) unchanged when `remoteControl` is off.

## Rollout

1. Land behind `remoteControl: false` default ⇒ zero behavior change on upgrade.
2. `telegram setup` enhancement to capture user-id + enable remote control.
3. Docs: update Telegram docs + `#403` end-to-end flow note (WoL relay = operator infra).
4. Cut **v0.10.0** (minor — first npm release with Telegram) once green and dogfooded from the phone.

## Open implementation details (resolve during planning, not blocking)

- Exact writable-key allowlist for `/config set` (default-deny; start tiny: `defaults.effort`).
- Whether `/register` over Telegram needs the repo cloned locally first or accepts a GitHub URL + clones.
- Warmup constant reuse vs. a Telegram-specific (shorter) timeout for snappier phone UX.
