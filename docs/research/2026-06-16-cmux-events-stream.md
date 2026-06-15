# cmux native event stream — investigation (audit item B1)

**Date:** 2026-06-16 · **Branch:** `feat/cmux-events-stream` · **cmux:** 0.64.16 (96)

Goal: reduce cockpit's fragile screen-scraping by consuming cmux's native event
stream. **Additive & safe** — the events consumer runs alongside the existing
relay-proxy / pane-reader path, which stays as the fallback during migration.

## STEP 0 — does `cmux events` exist? YES.

`cmux events` streams **newline-delimited JSON** over the cmux Unix socket.

```
cmux events [--after <seq>] [--cursor-file <path>] [--name <event>]
            [--category <category>] [--reconnect] [--limit <n>]
            [--no-ack] [--no-heartbeat]
```

- `--reconnect` — reconnect forever, resume from last received seq (in-process).
- `--cursor-file <path>` — read the starting seq from a file, update it after
  each event. **Durable resume across daemon restarts.**
- `--after <seq>` — replay retained events after a sequence.
- `--category` / `--name` — server-side filters, repeatable.
- `--no-heartbeat` — suppress the 15s heartbeat frames.

### Frame shapes (live-captured)

**Ack** (first frame; suppress with `--no-ack`):
```json
{"type":"ack","protocol":"cmux-events","version":1,"boot_id":"…",
 "subscription_id":"…","heartbeat_interval_seconds":15,"replay_count":0,
 "resume":{"after_seq":null,"gap":false,"latest_seq":1434,"next_seq":1435,
           "oldest_seq":1,"requested_after_seq":1434},
 "filters":{"categories":[],"names":[]}}
```
`resume.gap:true` signals retained-buffer overflow (events were dropped).

**Event**:
```json
{"type":"event","protocol":"cmux-events","version":1,"seq":1435,
 "boot_id":"…","id":"…-1435","category":"agent",
 "name":"agent.hook.PreToolUse","occurred_at":"2026-06-15T17:02:17.362Z",
 "source":"claude","workspace_id":"2AED…","surface_id":null,"pane_id":null,
 "window_id":null,
 "payload":{ "_source":"claude","session_id":"claude-7ba3…","_ppid":70993,
   "cwd":"/Users/q3labsadmin/me/claude-cockpit",
   "hook_event_name":"PreToolUse","phase":"received|completed",
   "tool_name":"Bash","workspace_id":"2AED…", … }}
```

### Categories / names observed live

| category       | names                                                                  |
|----------------|------------------------------------------------------------------------|
| `agent`        | `agent.hook.PreToolUse`, `agent.hook.Stop`, `agent.hook.SubagentStop`  |
| `feed`         | `feed.item.received`, `feed.item.completed`                             |
| `notification` | `notification.created/requested/cleared/clear_requested`               |
| `sidebar`      | `sidebar.metadata.updated`                                              |

The `agent` category is what we want: it mirrors Claude Code hook events
(`PreToolUse`, `Stop`, `SubagentStop`, etc.) with `payload.cwd`,
`payload.session_id`, `payload._source` (agent kind), and `workspace_id`.

## Key architectural difference vs the opencode SSE bridge

`OpencodeSseBridge` subscribes **per-crew** to that crew's `opencode --port N`
HTTP server. `cmux events` is a **single global stream** for the whole cmux app,
carrying every agent's hook events. So the cmux bridge is **one** long-lived
subscription owned by the daemon, and each frame is **correlated** to a crew
TaskRecord rather than arriving pre-addressed.

### Correlation key: `payload.cwd` → `TaskRecord.cwd`

Interactive crews run in an **isolated worktree** whose path becomes the record's
`cwd` (`crew.ts` sets `cwd: spawnCwd`). Each worktree path is unique, so
`payload.cwd === rec.cwd` cleanly maps a hook event to its crew. We only consider
**non-terminal interactive** records, matching `_source` to the record provider.

Limitation (prototype): a `--shared` crew runs with `cwd === projRoot`, which
collides with the captain's cwd — those fall back to the existing scrape path.
This is acceptable: scrape remains the fallback by design.

## Mapping (minimal, idempotent)

| cmux event                         | ControlEvent emitted      | effect                         |
|------------------------------------|---------------------------|--------------------------------|
| `agent.hook.Stop` (main session)   | `task.turn.completed`     | working → awaiting-input       |
| `agent.hook.SubagentStop`          | *(ignored)*               | subagent end ≠ turn end        |

`Stop` is the high-value signal: it's exactly the "turn ended / crew idle" state
the pane-reader currently infers by scraping the screen. `task.turn.completed` is
**liveness, not completion** (anti-#2576): terminal state still comes from the
explicit `cockpit crew signal done`. The state-machine reducer already absorbs
duplicate/late `task.turn.completed`, so feeding it from BOTH the events bridge
and the existing path is harmless — the core property that makes this additive.

## Lifecycle

- Started once in the daemon boot IIFE (next to opencode re-subscribe).
- Durable resume via `--cursor-file <stateRoot>/cmux-events.seq` + `--reconnect`.
- Stopped in the daemon's returned `stop()` (kill the child).
- Gated behind `defaults.cmuxEventsBridge` (default **on**); set false to fall
  back to scrape-only.

## B4 check — does the stream carry agent run-state? YES, via agent hooks.

The audit asked whether the stream exposes claude/codex **working vs idle** so
cockpit could drop the read-screen spinner heuristics
(`classifyStartupSurface` / `CC_WORKING_RE`). There is **no dedicated
"agent.status" query method** (`cmux capabilities` has no agent run-state
method; the closest is `surface.report_shell_state`). But run-state **is**
derivable from the `agent` event category itself:

- `agent.hook.PreToolUse` / `UserPromptSubmit` → the agent is **working**.
- `agent.hook.Stop` → the agent is **idle** (turn ended).

So B4 is feasible **on top of this same stream**: a future PR could map
PreToolUse→working / Stop→idle to replace the spinner scrape entirely. This PR
already consumes `Stop`; extending to PreToolUse-as-working is the natural next
step. (Reporting only, per the task — not implemented here.)

## Surface lifecycle events — audit premise does NOT match cmux 0.64.16

The audit assumed the stream emits `surface.created/closed/selected` +
`workspace.selected` (for an event-driven crew-surface reaper — STEP 2 — and an
authoritative stale-ref prune — STEP 3). **Live verification contradicts this.**
Creating and then closing a workspace while subscribed with
`--category surface` produced only `surface.input_sent` / `surface.key_sent`
(keystroke echoes) — **no** `surface.created` / `surface.closed` /
`surface.selected` frame fired. There is also no `~/.cmuxterm/events.jsonl`
file; the stream is socket-based (`cmux events`).

**Implication:** an event-driven surface reaper / stale-ref prune cannot be built
on `surface.closed` in cmux 0.64.16 — that event does not exist. The
**agent-hook** approach this PR ships (`agent.hook.Stop` → turn-end / idle) is
the achievable B1 win. STEP 3's relay "Workspace not found" noise must be fixed
the polled way (a per-sweep workspace-list guard + prune-once log), independent
of the event stream — flagged to the captain as a separate follow-up, since it's
in the relay/probe path and not unblocked by any event here.

## Conclusion

`cmux events` exists, is stable JSON, exposes the **agent hook** surface we need
(idle via `Stop`, working via `PreToolUse` — enough for B1 and a future B4), and
resumes durably. It does **not** expose surface lifecycle events, so the
event-driven reaper/prune the audit hypothesized is not possible on this version.
Safe to prototype the agent-hook consumer alongside the scrape fallback — done.

## STEP 3 follow-up — relay stale-ref noise, fixed the polled way

Implemented in `feat/lifecycle-hardening`. The observed per-cycle noise was the
daemon sweep re-healing relay records for projects whose **captain workspace is
permanently gone** (live `cockpitd.log` showed `relay heal pact-network: captain
workspace not present` every cycle for `pact-network`/`oneplan`). Mechanism: a
failing/absent cmux lookup degrades gracefully in code, but cmux's CLI **stderr
is inherited** by the daemon (`execFileSync` default), so each retry also echoes
cmux's own `Error: not_found …` to our stderr.

Fix (polled, no surface events needed): `createRelayHealer` now returns
`"captain-absent"` when the captain workspace no longer resolves; the sweep
prunes that relay-health record (and its debounce) so the heal/log fires **once**
then goes quiet. A captain restart re-registers a fresh relay, so recovery is
unaffected. The crew-surface probe poll set was already pruned of terminal crews
(`cockpitd` evicts `inFlightProbes`/`probeResults` on terminal state, and
`proxiedSurfaceAlive` only enqueues non-terminal records), so no change there.

## C2 — agent hibernation: investigated, deferred (global-only, unsafe)

`cmux agent-hibernation --help` in 0.64.16 is `cmux agent-hibernation <on|off>`
— a **GLOBAL, app-wide** toggle with no per-session or per-workspace argument
("Configure idle and live-terminal limits from Settings"). Enabling it would
hibernate **every** agent/terminal session, including the **captain** and the
**notify-relay** — both must stay responsive to deliver notifications — which
would break orchestration. Idle trigger is configured globally (Settings/JSON),
not scopeable to crews.

**Decision: do NOT enable.** Wired a documented OFF flag
`defaults.cmuxAgentHibernation` (default `false`) in `src/config.ts` as a
decision record + forward hook for if/when cmux adds crew-only scoping. Because
it is global-only, the surface-liveness reaper needs no "hibernated = alive"
change in this PR (nothing is hibernated). Revisit if cmux exposes per-session
hibernation.
