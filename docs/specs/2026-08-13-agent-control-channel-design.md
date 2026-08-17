# Agent Control Channel — native agent APIs as ground truth

**Issue:** #667 (P1) · **Date:** 2026-08-13 · **Status:** DRAFT — awaiting operator review

**Scope, fixed by the operator on 2026-08-13: `claude` and `opencode` only.** Both have a
native control API that has been exercised live. `pi`, `gemini`, and ACP are surveyed in
[Appendix A](#appendix-a--agents-out-of-scope) and deliberately left out.

**Visual companion:** [`docs/diagrams/2026-08-13-agent-control-channel.html`](../diagrams/2026-08-13-agent-control-channel.html)

---

## Problem

Squadrant answers two questions about every crew by reading terminal pixels:

1. *Is this agent idle or busy?* — glyph matching, `LivenessRegistry`, a pid floor.
2. *Did my message actually get submitted?* — `confirmedSendToPane`: paste → settle → Enter →
   re-read the screen and infer from whether an input box emptied.

Both are inference. Inference is wrong sometimes, and it is wrong **silently**, which is
worse: the system reports a confident answer that no one can distinguish from a true one.

The shipped bug tail from this one class: #447, #455, #466, #484, #492, #516, #566, #590,
and the still-open #514/#657.

### Five false signals in a single session — 2026-08-13

Not a historical argument. This is one captain session on the day this spec was written:

| Signal | Claimed | Ground truth | Status |
|---|---|---|---|
| `crew send` → "not delivered" | message dropped | delivered, visible with a `QUEUED` marker | #657 open |
| `CREW IDLE` | turn ended | crew was mid-tool-call running `git add` | #492 class |
| `CREW STALLED` | "running Bash ~10min" | **no such process existed** | unfiled |
| `heal status` | "✔ all components healthy" | daemon booted out, zero processes | #671, fixed |
| local test run | green | green only because the machine had a live daemon | author error |

Acting on any one of the first three would have caused harm: a duplicate message, a
duplicate run, or killing live work. Three of the five are screen-scraping or heartbeat
inference. That is the class this spec removes.

A second cost is invisible until you look for it: **squadrant cannot tell "blocked for
direction" from "blocked asking permission"**. They demand opposite responses. Today both
are guesses from pane content, which is why the #484/#590 class was possible at all.

---

## What changed

The premise of #667 as filed was *"Claude Code shipped cross-session messaging; it is
Claude-only, so build it behind a driver seam or it repeats the v0.13.3 mistake."*

That premise is now wrong in the operator's favour. **Both in-scope agents expose a native
control API.** opencode's is richer than Claude's.

| Capability | claude 2.1.226 (UDS) | opencode 1.18.18 (HTTP) |
|---|---|---|
| Send a prompt into a live session | write one NDJSON line, **no ACK** | `POST /session/{id}/prompt_async` → **204**, unknown id → **404** |
| Paste + submit equivalent | — | `POST /tui/append-prompt` → 200, `POST /tui/submit-prompt` → 200 |
| Liveness | `status: idle\|busy\|shell\|waiting` in a registry file | `GET /api/session/active`, `GET /api/session/{id}/event` (SSE) |
| Knows it is stuck on an approval | `waitingFor: "permission prompt"` — read only | `GET /api/permission/request` |
| **Answer that approval remotely** | ❌ | `POST /api/session/{id}/permission/{reqId}/reply` |
| **Structured questions from the agent** | ❌ | `GET /api/question/request` + `/reply`, `/reject` |
| Interrupt a running turn | ❌ | `POST /session/{id}/interrupt`, `/abort` |

### Evidence, and how strong each piece is

**opencode — verified live, 2026-08-13.** A throwaway TUI was spawned in `/tmp/oc-lab` the
same way squadrant spawns crews (`opencode --port <n>`), driven purely over HTTP, and the
transcript was read back:

```
POST /tui/append-prompt {"text":"Reply with exactly: PROBE-OK. Nothing else."} → 200 true
POST /tui/submit-prompt                                                        → 200 true
POST /session/{id}/prompt_async {"parts":[{"type":"text","text":"…ASYNC-OK"}]}  → 204
POST /session/ses_doesnotexist/prompt_async  → 404 {"name":"NotFoundError", …}

transcript: [user] Reply with exactly: PROBE-OK …  → [assistant] PROBE-OK
            [user] Reply with exactly: ASYNC-OK    → [assistant] ASYNC-OK
```

No paste, no settle loop, no Enter keystroke, no `parseDraftFromScreen`. The entire
`confirmedSendToPane` hardening stack was bypassed. **The 404 is the important line** — a
dead session is reported as dead instead of guessed at.

**claude — verified live, 2026-08-08.** Full writeup in
`squadrant-hub/spokes/squadrant/findings/2026-08-08-cc-peer-messaging-protocol.md`. A plain
Node process with no `SendMessage` tool, outside the target's process tree, posted one NDJSON
line and the text arrived as a real user turn. Claims there are individually marked
`[verified]` (seen on the wire) or `[source]` (read in the shipped bundle, not executed).

**A test's status code is not evidence.** `200 true` proved only that an HTTP handler
accepted bytes; the transcript proved the turn ran. This distinction is load-bearing
throughout — see [§5](#5-testing-and-rollout).

---

## Design

Four existing seams absorb this work. **No new tower.**

| Seam | Where | Status |
|---|---|---|
| `AgentCapability` union | `packages/agents/src/drivers/types.ts:1` | exists; `probe()` already returns `capabilities[]` |
| `LifecycleSource` port | `packages/core/src/lifecycle-source.ts:69` | exists **and is wired** — 3 live sources |
| `sendToPane` injection | `packages/cli/src/commands/crew.ts:70` | exists |
| `CaptainDelivery` | `packages/core/src/daemon/delivery-loop.ts` | exists (#332) |

> The header comment in `lifecycle-source.ts` still says *"remains unwired until Phase 1"*.
> That is **stale**. `cmux-store-source`, `native-hook-source`, and `codex-app-server-source`
> are registered via `ctx.lifecycleSources` and health-aggregated at `daemon/start.ts:153`.
> Fix the comment as part of this work.

### 1. The seam: a `ControlChannel` port

`AgentDriver` is a **launch-time** interface (`probe` / `buildCommand` / `parseOutput` /
`stop`). It has no place for runtime control. Add one port, following exactly the shape
`LifecycleSource` already established, and respecting the one-way package DAG
(`shared ◄ core ◄ {agents, workspaces, web} ◄ cli` — core may not import agents):

```
packages/core/src/control-channel.ts           ← port (new)
packages/agents/src/claude/peer-channel.ts     ← UDS impl (new)
packages/agents/src/opencode/http-channel.ts   ← HTTP impl (new, beside sse-bridge.ts)
                 → registered via ctx.controlChannels, mirroring ctx.lifecycleSources
```

**Delivery result is a union, never a boolean.** This is `confirmedSendToPane`'s original
sin: it collapses a five-branch reality into true/false, and the collapse is where the false
negatives come from.

```ts
export type DeliveryOutcome =
  | { status: "accepted";    via: ChannelName }              // agent acknowledged receipt
  | { status: "queued";      via: ChannelName }              // accepted; agent mid-turn
  | { status: "held";        via: ChannelName; reason: string } // awaiting operator approval
  | { status: "gone" }                                        // session dead → caller falls back
  | { status: "unsupported" };                                // no channel → caller falls back
```

`gone` and `unsupported` are the **only** two paths back to the pane, and both must log why.
A silent fallback reintroduces exactly the ambiguity this removes.

**Capabilities are tiered, not reduced to their intersection.** Designing to the common
denominator would discard opencode's most valuable endpoints — including the one that finally
separates "blocked for direction" from "blocked on permission".

| Tier | Contents | claude | opencode |
|---|---|---|---|
| T0 send | `send()` | ✅ | ✅ |
| T1 observe | liveness via `LifecycleSource` | ✅ | ✅ |
| T2 interact | approvals, questions, interrupt | ❌ | ✅ |

T2 members are optional methods on the port. An agent that lacks them simply does not
implement them — that is what a capability seam is for.

New `AgentCapability` members: `control_send`, `control_observe`, `control_interact`.

### 2. Delivery

Squadrant has two send paths, and each channel covers exactly one:

| Path | Today | Receiver | Channel |
|---|---|---|---|
| `crew send` → crew | `confirmedSendToPane` @ `crew.ts:70` | crew (usually opencode) | opencode HTTP |
| daemon → captain (#332) | `CaptainDelivery` | captain (**always claude**) | claude UDS |

**Addressing is predetermined on both sides — no discovery, no race.**

- **claude:** launch captains with `--messaging-socket-path /tmp/cc-socks/squadrant-<taskId>.sock`
  and `CLAUDE_CODE_HARBOR_KITE=1`. The daemon knows the address *before the process
  registers*. This also **dissolves the naming blocker** recorded in the issue's first spike
  comment (`squadrant-e8` vs `squadrant-3d`, both cwd-derived, colliding outright under
  `--shared`): squadrant no longer cares what Claude names a session, because it addresses a
  path it chose. Passing `--name squadrant-captain-<project>` remains worthwhile for a
  human-readable `ListAgents`, but it is a convenience, **not** a prerequisite. This
  supersedes the issue's original conclusion.
- **opencode:** `rec.serverPort` is already persisted on the TaskRecord (crews already launch
  as `opencode --port <n>`, `drivers/opencode.ts:29`). Resolve the session id once on first
  contact and cache it beside the port.

**Use `prompt_async`, not `/tui/*`.** Both are verified working. `/tui/append-prompt` targets
whichever session the TUI currently has focused — under operator takeover (#649) the operator
may have switched sessions, and the message would land in the wrong one with nothing to
indicate it. `prompt_async` is addressed by session id and returns `404` when that id is
wrong. **Prefer the failure mode that is detectable.** Keep `/tui/*` as a second fallback,
one rung above the pane.

**The two channels differ in confirmation strength, and the code must say so.**

opencode's `204` means the server accepted and queued into a named session. Claude's accept
path is **silent** — verified: a delivered message produced no receipt after 20 s. Only
`held` generates one. So Claude's guarantee is precisely:

> a process was listening at this path and accepted one line of bytes

Far stronger than reading a terminal, but **not** "the agent read it".

**Therefore: use T1 to confirm T0.** Claude's registry flips `idle → busy` when an injected
message starts a turn. After sending, watch `status` for a few seconds; a flip is genuine
end-to-end confirmation with no screen contact. No flip within the window records
`accepted-unconfirmed` — and **does not** trigger an automatic resend.

**Retry policy — the most dangerous corner, and the answer is counterintuitive.**

Claude silently drops byte-identical messages from the same sender inside a **30 s** window
(`dedupWindowMs: 30000`, `bucketCapacity: 30`, `refillPerSecond: 0.5`). A naive retry would
manufacture *exactly* the false negative this project exists to eliminate.

But once there is a real ACK, most retries lose their reason to exist — squadrant retries
today only because it cannot tell whether a message arrived.

- `accepted` / `queued` / `held` → **never retry**. Surface `held` to the operator.
- Retry **only** on transport error (`ECONNREFUSED`, timeout), and the body **must** vary —
  carry an attempt counter in the `<cross-session-message>` wrapper.
- `gone` / `unsupported` → fall back to the pane **once**, logged, never looping.

**Security work that ships with this, not after it.** opencode prints
`OPENCODE_SERVER_PASSWORD is not set; server is unsecured` on startup, and its spec defines
`401`. Squadrant **already** launches crews with an open port on `127.0.0.1`, so any local
process can drive a crew today — this predates the spec and is not introduced by it. The
daemon should generate a password at spawn and hold it on the TaskRecord, in the spirit of
#668.

### 3. Liveness

Two sources — one new, one relocated:

```
ClaudePeerRegistrySource   (new)       reads ~/.claude/sessions/<pid>.json
OpencodeControlSource      (relocated) wraps the existing sse-bridge.ts
```

`OpencodeSseBridge` is production-wired (`daemon/start.ts:78`, `:189`) but is **not** a
`LifecycleSource`. It therefore bypasses `reduceLifecycle` and the per-source health board —
opencode signals never receive the `agent > scan` precedence rules. Relocating it is required
by the 4-state model, not a drive-by refactor.

| Observable truth | claude registry | opencode | `LifecycleState` |
|---|---|---|---|
| running a turn | `busy` | present in `/session/active` | `running` |
| turn finished, awaiting input | `idle` | `session.idle` event | `idle` |
| **stuck on a permission prompt** | `waiting` + `waitingFor` | `GET /api/permission/request` | **`needsInput`** |
| running a shell | `shell` | — | `running` |
| unreadable / `sdk-cli` has no field | absent | server unreachable | `unknown` |

The bold row is the whole point. Both agents **state it outright**; squadrant guesses today.

#### The trap: `origin` is about trust, not transport

`reduceLifecycle` (`lifecycle-source.ts:109`) enforces: **a `"scan"` signal may never assert
`needsInput`.** That rule is correct and has prevented real bugs.

Claude's registry is a file squadrant must **poll**. Read naively, polling looks like a
"scan" — and rule 2 would then **silently discard `waitingFor: "permission prompt"`**, the
single most valuable signal in this entire design, the one with no observable signature from
outside a terminal.

`origin` describes how much the **source** is trusted, not the transport used to fetch it.
The registry is the agent's own self-report; squadrant merely happens to read it by polling.
It is `origin: "agent"`.

Three guards are mandatory; omitting any one manufactures a new class of false signal:

1. **`kill(pid, 0)`** — a crashed session's last status is frozen and **looks fresh forever**.
   This is precisely the mechanism behind today's phantom `CREW STALLED`, merely relocated.
2. **`statusUpdatedAt`** — stale data must not overwrite a newer state.
3. **Absence ≠ idle.** `entrypoint: "sdk-cli"` sessions carry no `status` field at all; map to
   `unknown`. Mapping to `idle` announces "ready for work" about a session squadrant does not
   understand.

#### Measured against today's five false signals

| Today | Fixed by |
|---|---|
| `CREW IDLE` during a live tool call | §3 — `busy` is self-reported, not inferred |
| `CREW STALLED` with no process | §3 — `kill(pid, 0)` |
| `crew send` false "not delivered" | §2, not §3 |
| `heal status` false green | already fixed (#671) |
| environment-dependent local test | §5 |

This spec deliberately **does not** promise to retire the v0.15.0 `LivenessRegistry` or pid
floor. The new sources run alongside them first; removal is a later decision made on data.
Retiring early is the fastest way to replace one layer of false signals with another.

### 4. Chat

`squadrant ping` prints `✔ Pinged`, which means "sent into the void" (#551). #552 asks for a
cross-captain channel. With §1 in place this is mostly a CLI surface over `send()` — captains
**are** Claude sessions, already registered and already addressable.

Ranked by real value to the operator:

1. **Telegram → captain gains real receipts.** Today phone messages reach the captain through
   the pane — inside the very inference layer being removed. Over UDS, `squadrant telegram`
   can distinguish *arrived* from *held for approval* instead of reporting silence.
2. **`ping` becomes honest** — same outcome union as §2. A `gone` result is evidence the
   captain is dead, replacing a screen read.
3. **captain ↔ captain** — matches the group-awareness goal and revives the experimental
   cross-project delegation from v0.6.0, this time with receipts.

**Inbound security must be addressed here, and it is more serious than the opencode port.**

Per the verified inbound gate: crews and captains run `--permission-mode auto`, which
classifies as **prompting**; an unattested external sender therefore walks the gate to
**accept**. Any local process that finds the socket can inject a user turn into a captain —
and a captain can spawn crews, merge PRs, and run commands. **This is already true today**,
because captains self-register whether or not squadrant knows about it.

Three items ship with this section:

- set `crossSessionInbound` **explicitly** rather than relying on a default squadrant did not
  choose;
- audit permissions on `/tmp/cc-socks/` and on squadrant's own socket — receipts are only sent
  within the same directory namespace, making that directory the trust boundary;
- the daemon must **never** attest `from-mode="bypass"` — verified to hold *every* message.

**Boundary, held firmly: chat is prose for humans, not a transport.** The channel is plain
text only. Squadrant already has a typed control plane over the daemon's own socket. Routing
structured commands through chat would create a second, ungoverned control plane. Single hop
only; no relaying.

### 5. Testing and rollout

On 2026-08-13 the captain reported "independent gate, 2486/2486 passing" and **the conclusion
was wrong** — the suite was green because that machine had a live daemon; CI did not. This
section exists so that error does not recur at scale.

**Three rules, each paid for by a real incident:**

1. **No test may depend on ambient state.** Anything touching a socket or port injects its
   transport, exactly as `heal.ts` now accepts `isDaemonAlive`. A test that reaches a real
   socket is a test that lies on CI.
2. **A live smoke run is the gate, not the test count.** Send for real, then **read the
   transcript**. `200 true` is not evidence; `[assistant] PROBE-OK` is.
3. **Smoke runs on a throwaway TEST project, never a real one.** Crews must not boot a daemon
   against `~/.config/squadrant` — one did exactly that on 2026-08-13 and **seized the
   production socket**. Two guards now exist: `SQUADRANT_CONFIG` is honoured (#668) so real
   isolation is possible, and `isMonorepoCheckout` refuses to bind the production socket from
   a checkout.

**Rollout is a three-position flag, per agent**, living in `~/.config/squadrant/config.json`
under `defaults.controlChannel` (per-project override via `projects/<name>.json`, using the
existing deep-merge layering):

```json
{ "defaults": { "controlChannel": { "claude": "off", "opencode": "shadow" } } }
```

```
off     unchanged behaviour
shadow  new channel runs ALONGSIDE the pane path; logs only what each concluded
        and where they DISAGREED. The pane still decides behaviour.
on      new channel leads; pane becomes the fallback
```

An unset agent defaults to `off`. The flag is read per send, so flipping it needs no restart.

Shadow mode is not caution for its own sake: **a false-signal fix cannot be proven without
observing the signal being false.** That is the standing caveat on #671 — `heal status` is
green today, and that is true, but it does not exercise the false-green branch. Shadow mode
converts the claim into data: every instance where the pane says "not delivered" and HTTP
says `204` is countable evidence for #514/#657.

It also yields something squadrant has never had: **the real error rate of the
screen-scraping layer.** Five false signals in one session is an anecdote, not a measurement.

**Probe for capability; never compare versions.** The honest check is *"does `connect()`
succeed at the expected path/port"*. Claude advertises `peerProtocol: 1` / `msgV: 1`; opencode
is mid-migration from `/session/*` to `/api/session/*`. Neither is a promised-stable contract.
**Upgrading either agent requires re-running the smoke suite** — add this to
`docs/testing/crew-lifecycle-checklist.md`.

**Three unknowns are closed by smoke, not by guessing in this spec:**

| Unknown | How it is closed |
|---|---|
| opencode behaviour when the crew is **mid-turn** (queue or reject?) | **CLOSED (2026-08-17):** Queues. `prompt_async` during a turn returns `204`, and the agent processes it after the turn finishes. |
| the real shape of `GET /api/permission/request` | **CLOSED, negatively (2026-08-17):** the endpoint exists and matches its documented schema, but it is fed by a v2 execution path that fails to run any tool in v1.18.18. squadrant must keep using the legacy `GET /permission` / `POST /session/{id}/permissions/{id}` pair, which are live-verified working. |
| claude approve/deny of a `held` message (**never exercised**) | **CLOSED (2026-08-17):** approve and deny both exercised end-to-end against a live Claude Code 2.1.233 session; see below. |

### Smoke Test: opencode mid-turn behavior (2026-08-17)

**Goal:** Determine if opencode rejects or queues `prompt_async` messages while the agent is busy running a tool.

**Setup:**
- Agent: `opencode` v1.18.18
- Delivery via: squadrant CLI with config `defaults.controlChannel.opencode = "on"` (using `prompt_async` via HTTP channel).

**Execution:**
1. Spawned a crew and commanded it to sleep for a minute: `squadrant crew spawn smoke-test "Just wait for a minute." --agent opencode`
2. While the crew was sleeping (mid-turn), fired `squadrant crew send smoke-test crew-1 "This is a mid-turn async message."`
3. Result: CLI reported `crew send crew-1: accepted via opencode-http` (because HTTP returned 204).
4. After `sleep 60` completed, the transcript showed the agent immediately received "This is a mid-turn async message." and responded.

**Conclusion:** opencode safely queues `prompt_async` messages during a turn. Squadrant can confidently treat a `204` as a successful delivery (mapped to `accepted` or `queued`) without needing to back off or duplicate the send.

### Smoke Test: opencode `GET /api/permission/request` (2026-08-17)

**Goal:** Record the real shape of `GET /api/permission/request` — status code and body both with
and without a pending permission, and for a dead/unknown session — plus exercise
`POST /api/session/{id}/permission/{reqId}/reply`, per the open-unknowns row this spec's table
pointed at.

**Setup:**
- Agent: `opencode` v1.18.18, throwaway server: `opencode serve --port 0 --hostname 127.0.0.1`
  in `/tmp/cc-probe-667/opencode-cwd`, `OPENCODE_CONFIG` pointed at a per-crew config replicating
  `writePerCrewOpencodeConfig({ gateBash: true })` (`packages/cli/src/lib/per-crew-settings.ts`) —
  i.e. `permission.bash: "ask"`, everything else `"allow"`. No `OPENCODE_SERVER_PASSWORD` set
  (matches the already-established "server is unsecured" finding).
- Session created via `POST /session` (legacy), model `google/gemini-3.1-pro-preview` (the
  authenticated provider available in this environment).
- Registered nowhere in squadrant — pure HTTP against the throwaway server. No `squadrant projects
  add` was needed for this half of the probe since it never touched a crew/captain.

**Finding 1 — the endpoint exists, is not deprecated, and matches its documented schema:**

`GET /doc` (the server's own OpenAPI 3.1 document) confirms **two parallel permission systems**
live side by side in v1.18.18:

| | legacy | v2 |
|---|---|---|
| List pending | `GET /permission` | `GET /api/permission/request` |
| Reply | `POST /session/{id}/permissions/{permissionID}` — **`"deprecated": true`** in the OpenAPI doc | `POST /api/session/{id}/permission/{requestID}/reply` |

This confirms the spec's own note (§ "Probe for capability; never compare versions") that opencode
is mid-migration — both halves are live in the same binary, and the OpenAPI doc itself flags which
one is being phased out. **squadrant's merged code (`packages/agents/src/opencode/sse-bridge.ts`)
uses the deprecated legacy endpoint,** not the one this spec's open-unknowns table named.

**Finding 2 — nothing pending, live response:**

```
$ curl -s -w '\nHTTP:%{http_code}\n' http://127.0.0.1:4096/api/permission/request
{"location":{"directory":"/private/tmp/cc-probe-667/opencode-cwd","project":{"id":"global","directory":"/"}},"data":[]}
HTTP:200
```

Always `200`, never `404`, even with zero sessions or zero pending requests. `location` is
auto-derived from the server's own cwd (the request needs no query params to get a sensible
default). `data` is always an array — empty when nothing is pending. Schema (from `/doc`):
`{ location: LocationInfo, data: PermissionV2Request[] }`, `PermissionV2Request` = `{ id, sessionID,
action, resources, save?, metadata?, source? }` (`id`/`sessionID` pattern-anchored `^per`/`^ses`).

**Finding 3 — a real pending permission does NOT appear in `/api/permission/request`:**

Prompted the session (`POST /session/{id}/message`, the **legacy** send path — the same one
squadrant's `http-channel.ts`/`sse-bridge.ts` actually drive) to run `echo probe667-marker`. Server
log confirms the gate fired:

```
evaluated permission=bash pattern="echo probe667-marker" action.permission=bash action.action=ask action.pattern=*
asking id=per_00f14a00e001UMArfQYwOHPJjf permission=bash patterns="[\"echo probe667-marker\"]"
```

While that request was genuinely pending (the `POST /session/{id}/message` call was blocked on it),
polled both endpoints:

```
$ curl -s http://127.0.0.1:4096/permission
[{"id":"per_00f14a00e001UMArfQYwOHPJjf","sessionID":"ses_ff0eb93a9ffeknKx13ud7V4sC9","permission":"bash","patterns":["echo probe667-marker"],"metadata":{"command":"echo probe667-marker"},"always":["echo *"],"tool":{"messageID":"msg_00f148eac001MpuAeh1dVO5igK","callID":"0FoDCySVwpXz0y8h"}}]

$ curl -s http://127.0.0.1:4096/api/permission/request
{"location":{"directory":"/private/tmp/cc-probe-667/opencode-cwd","project":{"id":"global","directory":"/"}},"data":[]}
```

**The legacy endpoint shows the pending permission with full detail. The v2 endpoint this spec
named shows nothing — `data: []` — for the exact same live pending request.**

**Finding 4 — root cause: the v2 execution path cannot complete a turn in this build.**

Hypothesis: the two permission stores are fed by two different execution engines, and only the
legacy one (driven by `POST /session/{id}/message`) is wired to the real bash-tool gate. Tested
directly: created a prompt via the v2 send path, `POST /api/session/{id}/prompt`, which returns
`200` immediately (`{"data":{"admittedSeq":…,"delivery":"steer",…}}`, async-admitted). Polled both
permission endpoints for 20s — nothing pending anywhere. Server log explains why:

```
ERROR message="Failed to drain Session" cause="SessionRunnerModel.ModelUnavailableError: Model unavailable: google/gemini-3.1-pro-preview
    at SessionRunner.runTurn ...
```

Set the model explicitly first via `POST /api/session/{id}/model` (204), retried — same error.
Retried again against a second, unrelated provider (`deepseek/deepseek-chat`) — **same error,
same stack**, ruling out a model-specific credential issue:

```
ERROR message="Failed to drain Session" cause="SessionRunnerModel.ModelUnavailableError: Model unavailable: deepseek/deepseek-chat
```

**Conclusion: `SessionRunner` (the v2 engine behind `/api/session/{id}/prompt`, and therefore
behind `/api/permission/request`) cannot complete a turn against any tested provider in opencode
v1.18.18 — it errors before it can ever reach a tool call, so it can never populate a permission
request.** This is not a permission-API bug per se; it is the v2 session runner being broken (or at
minimum, provider-incompatible) in this version, which happens to make the endpoint this spec named
permanently empty in practice. Whether this is fixed in a later opencode release is unknown —
re-verify on upgrade per the standing "re-run the smoke suite" rule.

**Finding 5 — dead/unknown session and request-id shapes, both endpoints:**

```
# v2: reply against a session that never existed
$ curl -s -w '\nHTTP:%{http_code}\n' -X POST http://127.0.0.1:4096/api/session/ses_deadbeefdeadbeefdeadbeef/permission/per_deadbeefdeadbeefdeadbeef/reply -d '{"reply":"once"}'
{"_tag":"SessionNotFoundError","sessionID":"ses_deadbeefdeadbeefdeadbeef","message":"Session not found: ses_deadbeefdeadbeefdeadbeef"}
HTTP:404

# v2: reply against a real (now-resolved) session/request — the request no longer exists
$ curl -s -w '\nHTTP:%{http_code}\n' -X POST http://127.0.0.1:4096/api/session/ses_ff0eb93a9ffeknKx13ud7V4sC9/permission/per_00f14a00e001UMArfQYwOHPJjf/reply -d '{"reply":"once"}'
{"_tag":"PermissionNotFoundError","requestID":"per_00f14a00e001UMArfQYwOHPJjf","message":"Permission request not found: per_00f14a00e001UMArfQYwOHPJjf"}
HTTP:404

# legacy: reply against a session that never existed
$ curl -s -w '\nHTTP:%{http_code}\n' -X POST http://127.0.0.1:4096/session/ses_deadbeefdeadbeefdeadbeef/permissions/per_deadbeefdeadbeefdeadbeef -d '{"response":"once"}'
{"name":"NotFoundError","data":{"message":"Session not found: ses_deadbeefdeadbeefdeadbeef"}}
HTTP:404

# legacy: approve a genuinely pending request (unblocks the earlier POST /session/{id}/message call)
$ curl -s -w '\nHTTP:%{http_code}\n' -X POST http://127.0.0.1:4096/session/ses_ff0eb93a9ffeknKx13ud7V4sC9/permissions/per_00f14a00e001UMArfQYwOHPJjf -d '{"response":"once"}'
true
HTTP:200
```

Approving via the legacy endpoint released the blocked turn; the transcript then showed
`echo probe667-marker` executed and its output returned to the model.

**Bottom line for #667:** the spec's open-unknowns table pointed at the wrong (but real, live,
schema-matching) endpoint pair. `GET /api/permission/request` /
`POST /api/session/{id}/permission/{reqId}/reply` exist, are well-formed, and 404 sensibly on
unknown sessions/requests — but they are currently unreachable from a live bash-permission gate in
v1.18.18 because their backing v2 `SessionRunner` cannot complete a turn at all. The legacy pair
(`GET /permission`, `POST /session/{id}/permissions/{permissionID}`, `"deprecated": true` in `/doc`
but functionally the only one that works) is what squadrant's merged slice-2 code already uses, and
this smoke confirms that choice was correct. No code change is needed from this finding alone; it
is a documentation correction plus a flag to re-check `/api/permission/request` on opencode
upgrades in case the v2 runner is fixed upstream.

### Smoke Test: claude approve/deny of a HELD peer message (2026-08-17)

**Goal:** Exercise the never-before-observed approve and deny paths for a `held` cross-session
message (`squadrant-hub/spokes/squadrant/findings/2026-08-08-cc-peer-messaging-protocol.md`, §7,
first bullet: "Approve/deny of a held message was not exercised"). Determine what causes a hold,
what each resolution looks like, and whether either yields a receipt.

**Setup:**
- Agent: Claude Code **2.1.233** (the 2026-08-08 spike was against 2.1.226 — a live version bump,
  handled per the standing "capability probe, never a version comparison" rule).
- Throwaway receiver sessions spawned under a pty (`pty.fork()`), one per trial, each in its own
  `/tmp/cc-probe-667/cc-lab-{a,b,c,d}` cwd:
  `claude --model haiku --permission-mode auto --messaging-socket-path /tmp/cc-probe-667/cc-socks/probe-{x}.sock`,
  with `CLAUDE_CODE_HARBOR_KITE=1`.
- An external Node "daemon" (adapted from the 2026-08-08 spike's `snippets.js` `daemon` command)
  binds its own inbox socket in the same directory, attests `from-mode="bypass"` (the receiver is
  `--permission-mode auto`, i.e. `prompting` class — attesting the mismatched mode is what the
  spike identified as the hold trigger), and listens for receipts.

**⚠️ Environmental trap found before the real probe could even start:** the first throwaway
session registered its `.sock` and its inbox `.key` file under `~/.claude/sessions/`, but **never
wrote its `<pid>.json` registry entry**, and its transcript banner read "Transcript saving is off
— inherited `CLAUDE_CODE_CHILD_SESSION` marker." Cause: this probe itself runs *inside* a Claude
Code crew session, and `nohup ... &` from that shell inherits the parent's own
`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, etc. — the throwaway session came up believing it was a
**child of the probing session**, not an independent process, and skipped its own registration.
Fix: spawn with a sanitized environment — `env -i HOME=... PATH=... TERM=... CLAUDE_CODE_HARBOR_KITE=1 claude ...`
— after which registration worked normally. **This matters beyond the probe:** squadrant's own
daemon spawns crews from inside its own Node process, not a Claude Code session, so it is not
directly exposed — but any code path that shells out to `claude` *from within* another Claude Code
session (crew-spawns-crew, a hook, a plugin) will hit exactly this silently-broken registration
unless it explicitly clears the inherited `CLAUDE_CODE_*` env first.

**Finding 1 — what triggers `held`, reconfirmed on 2.1.233:**

Posting a message with `from-mode="bypass"` to a `--permission-mode auto` receiver (class
`prompting`) mismatches the permission-parity gate and holds, exactly as the 2026-08-08 spike
found on 2.1.226:

```
09:52:40.429  RECEIPT {"type":"control","action":"peer_message_status","status":"held",
  "reason":"Your message is held for the recipient user's approval before it reaches their Claude session (permission-mode parity).",
  "from":"uds:/tmp/cc-probe-667/cc-socks/probe-c.sock","orig_msg_id":"9583f890-…","msgV":1,"msg_id":"e5d5fc48-…"}
```

The receiver's registry entry (`~/.claude/sessions/<pid>.json`) flips in lockstep:
`status: "waiting", waitingFor: "permission prompt"` — confirming the 2026-08-08 finding that this
is the only externally-observable signature of "blocked on an approval prompt."

**Finding 2 — the live UI, never described before:**

The receiving session's transcript gets a `type: "system", subtype: "informational"` notice, and
the TUI renders an interactive two-item list:

```
Held message from another session
Another Claude session sent a message:
from uds:/tmp/cc-probe-667/cc-socks/probe-daemon-a.sock [verified pid 68495] (peer claims name: probe667-daemon)
The sending session's permission mode class doesn't match this session's, so it wasn't delivered automatically.
  Message body (this is what will be delivered):
  «This is a HELD-probe message for #667 unknown (c). Please just acknowledge if you see this.»
❯ Deny — drop it and tell the sender it was declined
  Deliver this message to Claude
```

The sender's pid is independently verified (`[verified pid 68495]`) — the receiver isn't trusting
the `from-name` attestation alone, it cross-checked `LOCAL_PEERCRED` against the claimed socket.
**Default selection (no navigation) is `Deny`** — the fail-safe choice, consistent with §3's
"hold" being a fail-closed branch.

**Finding 3 — the confirm key is *not* plain `\r`/`\n`/Space/Tab/a digit:**

This cost most of the probe's time. Standard `\r`, `\n`, Space, Tab+`\r`, `y`, and digit `2` were
all sent (individually and combined with the arrow-down navigation) against two separate live
sessions — none of them resolved the prompt; the registry stayed `waiting` and no receipt arrived,
even though the arrow keys visibly moved the `❯` cursor (proof stdin *was* reaching the TUI in raw
mode). What **did** work, on the first try once found: the **Kitty keyboard protocol CSI-u
encoding for Return, `\x1b[13u`**. The TUI enables SGR extended mouse-tracking modes
(`\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h`) around this same prompt, which was the tell that
it expects a more modern terminal input protocol than a bare `\r`. **Anything that automates this
prompt — a test harness, a future squadrant driver, an operator's own tmux/screen wrapper — must
send `\x1b[13u`, not a plain carriage return, or the confirm silently does nothing.**

**Finding 4 — deny, exercised and receipted:**

Sent `held`, then immediately `\x1b[13u` with **no** navigation (confirming the default `Deny`):

```
09:51:10.343  RECEIPT {"type":"control","action":"peer_message_status","status":"denied",
  "reason":"The recipient user declined your message; it was not delivered to their Claude session.",
  "from":"uds:/tmp/cc-probe-667/cc-socks/probe-b.sock","orig_msg_id":"79b0a6e8-…","msgV":1,"msg_id":"17c2b111-…"}
```

Registry: `waiting` → `idle`. Receiver's transcript (`ddc93f73…`/`fcb79b07…` sessions confirmed the
same on repeat): only the `system`/`informational` hold notice is present — **no `type:"user"`
turn is ever added for a denied message.**

**Finding 5 — approve, exercised and receipted:**

Sent `held`, then `\x1b[B` (down-arrow, to select "Deliver this message to Claude") followed by
`\x1b[13u`, sent as two separate writes with the highlighted state verified in between (a combined
single write raced and fell back to the default `Deny` in two earlier trials — send them as
discrete steps):

```
09:53:48.578  RECEIPT {"type":"control","action":"peer_message_status","status":"delivered",
  "reason":"Your previously-held message was approved and released to the recipient's Claude session.",
  "from":"uds:/tmp/cc-probe-667/cc-socks/probe-d.sock","orig_msg_id":"2c08e513-…","msgV":1,"msg_id":"c16914d6-…"}
```

Registry: `waiting` → `idle`. The receiver's transcript JSONL (`ddc93f73-04ec-477a-9b59-4af245a99a86`)
shows the full chain: the `system`/`informational` hold notice, a `queue-operation`/`enqueue` entry
for the cross-session content, and then a genuine `type:"user"` message —
`"Another Claude session sent a message:\n<cross-session-message from=\"uds:…\" …>"` — landing in
the transcript exactly as an ordinary accepted peer message would, confirming §4's "delivered after
hold" row (previously `[source]`-only) is real.

**Bottom line for #667:** both outcomes in the open-unknowns row are now `[verified]`, not
`[source]`. `held`, `denied`, and `delivered`-after-hold all produce a `peer_message_status`
receipt when the poster is addressable — `held` was already known; `denied` and `delivered` are new
confirmations. No human/UI-click blocker turned out to be necessary — the actual blocker was purely
mechanical (the correct confirm-key encoding), and it is now documented. Two follow-ups worth
filing separately: (1) the `CLAUDE_CODE_*` env-leak-breaks-registration trap above, for anyone
building tooling that shells out to `claude` from inside a Claude Code session; (2) if squadrant
ever needs to *automate* resolving a held message (not just observe it), the driver must send
`\x1b[13u`, and should not assume a bare `\r` works.

---

## Delivery slices

This is too large for one change. It ships as four independent, individually revertable
slices — each one useful on its own, each landing behind `off` by default.

| # | Slice | Contents | Depends on |
|---|---|---|---|
| 1 | **Liveness** | `ClaudePeerRegistrySource` + relocate `OpencodeSseBridge` onto the port; stale comment fix | — |
| 2 | **Port + opencode delivery** | `ControlChannel`, `DeliveryOutcome`, `http-channel.ts`, shadow flag | — |
| 3 | **claude delivery** | `peer-channel.ts`, `--messaging-socket-path` at captain spawn, T1-confirms-T0 | 1, 2 |
| 4 | **Chat + security** | `ping`/chat surface, Telegram receipts, `crossSessionInbound`, opencode server password | 3 |

Slice 1 is read-only and changes no behaviour — it is the safest possible starting point and
immediately improves #567. Slices 1 and 2 are independent and can run in parallel crews.

If slices 2 and 3 both slip, slice 1 alone still removes two of today's five false signals.

## Non-goals

- Retiring `confirmedSendToPane`. It stays as the fallback for `gone` / `unsupported`.
- Retiring the v0.15.0 liveness floor. Later, on data.
- A typed protocol over the chat channel (§4).
- Multi-hop relaying between sessions.
- `pi`, `gemini`, ACP, and any other agent (Appendix A).
- #514/#657 remain separately tracked. This spec should make them measurable and then fix the
  opencode half; nothing here closes them by assertion.

## Risks

| Risk | Mitigation |
|---|---|
| Neither wire format is a promised-stable public contract | capability probe + pane fallback + re-smoke on agent upgrade |
| Claude's 30 s dedup silently drops identical retries | never retry on accept; vary the body on transport-error retry |
| Claude's silent accept path is weaker than it looks | confirm via the T1 status flip; record `accepted-unconfirmed` honestly |
| Polled registry misread as `origin: "scan"` | explicit decision in §3 — it is `"agent"`, with three guards |
| opencode's port is unauthenticated | generate a server password at spawn (§2) |
| A local process can inject turns into a captain | explicit `crossSessionInbound` + socket-directory permission audit (§4) |
| Designing to the intersection of two agents | capability tiers (§1); T2 is opencode-only by design |

## Open questions for the operator

1. Ship the two security items (opencode server password, `crossSessionInbound` + socket
   permissions) inside this work, or split them into their own issue so they can land sooner?
2. How long should shadow mode run before cutting over — a fixed number of days, or until a
   disagreement count is reached?

## References

- Issue #667, including both spike comments
- `squadrant-hub/spokes/squadrant/findings/2026-08-08-cc-peer-messaging-protocol.md` (plus
  `.vi`, the architecture explainer, the swimlane, and runnable snippets)
- `docs/specs/2026-06-26-lifecycle-source-port-design.md` (#333)
- `docs/specs/2026-07-07-captain-liveness-redesign.md`
- Related: #514, #551, #552, #567, #618, #657, #671

---

## Appendix A — agents out of scope

Surveyed on 2026-08-13 and excluded by the operator, recorded so the survey is not repeated.

**The real axis is topology, not API availability.**

| Agent | Control channel | Topology | Fits a cmux pane? |
|---|---|---|---|
| opencode | HTTP + SSE on a port | daemon **connects in** | ✅ in scope |
| claude | UDS socket | daemon **connects in** | ✅ in scope |
| codex | app-server JSON-RPC / websocket, plus new `remote-control` | daemon **connects in** | ✅ client exists (PR #97); out of scope here |
| gemini | `--acp` (stdio) | **spawner owns the pipe** | ⚠️ conflicts |
| pi | `pi --mode rpc` (stdio) | **spawner owns the pipe** | ⚠️ conflicts |

`pi` and `gemini` are excluded **not for lacking an API** but because stdin/stdout has exactly
one owner. A cmux pane holds the TTY, so the daemon cannot also drive it — unless the agent
runs headless with no pane, which forfeits operator takeover (#649).

Two ideas worth stealing from Pi's RPC design if this port is ever revisited:

- **`streamingBehavior: "steer" | "followUp"`** — a first-class answer to "the agent is busy
  mid-turn", and Pi **returns an error** if the caller does not specify one. It refuses to
  guess. `confirmedSendToPane` does the opposite.
- Pi's docs warn that Node's `readline` is not protocol-compliant because it also splits on
  `U+2028`/`U+2029`. That is the same family as squadrant's own #499 (an opencode first-turn
  drop caused by a `…` U+2026 glyph mismatch): invisible Unicode breaking framing.

ACP (Agent Client Protocol) is spreading — `opencode acp`, `gemini --acp`, and both Kimi Code
and Mistral Vibe have adopted it. **Whether one client can actually drive several ACP agents
is unverified.** If squadrant ever expands past two agents, verify that first; it decides
whether the seam needs two branches or N.
