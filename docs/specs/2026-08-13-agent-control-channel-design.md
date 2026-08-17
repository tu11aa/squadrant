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
| the real shape of `GET /api/permission/request` | trigger a permission prompt, read it |
| claude approve/deny of a `held` message (**never exercised**) | send a held message, approve it in the UI |

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
