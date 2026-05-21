# Cockpit Interactive Codex — Design

**Date:** 2026-05-20
**Status:** Approved design, pre-implementation. Brainstormed in-session 2026-05-19→20; supersedes the deferred interactive section of `docs/specs/2026-05-17-cockpit-control-plane-design.md` for `provider=codex`.
**Predecessors (read first):**
- `docs/research/2026-05-19-codex-interactive-handoff.md` — problem brief
- `docs/research/2026-05-19-orca-codex-wrapping-study.md` (+ `.html`) — codex-wrapping prior art
- `docs/research/2026-05-19-orca-full-system-study.md` (+ `.html`) — full-system orca study
- `docs/research/2026-05-19-orca-derived-cockpit-improvements.md` (+ `.html`) — Bucket-2 issues #89–#95
**Cross-refs:** closes the **interactive-codex slice** of #86; depends on / cooperates with #87, #91, #92, #94.

---

## 1 · Problem & non-goals

**Problem.** Cockpit's only live human↔agent surface today is Claude (a chat in a cmux tab). Codex is one-shot only (`codex exec --json`). The user wants live human↔codex with the same feel as a Claude crew tab, but **without** the unreliability that "drive a codex TUI by send-keys/read-screen" reintroduces (the pattern the control-plane was built to retire).

**Two paths exist, this spec commits to one.**

- **Iterative codex (already works, no build).** Multi-step codex work — spec → implement → review → iterate — works today via control-plane chained one-shot dispatch. Proven in prod (oneplan / PR #52). If the user's underlying need was "codex iterates with review loops," it is already satisfied.
- **Live human↔codex (this spec).** A person watching/poking a codex session like a Claude crew tab. Codex's only *native* live surface is its full-screen TUI; scraping that TUI is rejected (orca's #1437 / null→idle bugs are field evidence the pattern fails).

**The mechanism this spec uses.** The `codex app-server` JSON-RPC protocol — codex's documented, production-grade protocol (the same one OpenAI's VSCode ChatGPT extension uses for live human↔codex chat; orca's `codex-fetcher.ts:88–261` is a working reference client we mine). Provides real `TurnStarted/Completed` notifications, `AgentMessageDelta` streaming, native `ToolRequestUserInput`/approval requests, and `thread/start|resume|read|inject_items` lifecycle — i.e. a true protocol, not a screen.

**Non-goals (YAGNI — explicitly out):**
- Other providers' interactive mode. `provider≠codex, mode=interactive` continues to fail loud (red-team #4 stands).
- App-server transports beyond `stdio://`. `unix://` and `ws://` deferred.
- `codex realtime/*` (audio), `thread/fork`, `marketplace/*`, `plugin/*` methods. Wrap ~10 methods, ignore the other ~90.
- A captain-mediated codex variant (you talk to captain, captain talks to codex). Rejected during brainstorm — the user wants the direct cmux-tab surface.
- TUI scraping. Permanently rejected; not a fallback.
- A general cockpit-wide decision-gate primitive across all providers/roles. This spec implements the interactive-codex HITL slice only; broader rollout is a follow-up.
- Closing the **headless slice** of #86. Headless orphan-on-restart remains open; addressed when headless adapters adopt the same `resumeRef` discipline (tracked in #91 follow-ups).

---

## 2 · Approach (Approach 3, two-phase)

**Phase 1 — `feature/codex-app-server-client`.** A standalone, TDD'd, typed JSON-RPC client lib for the codex app-server protocol + a smoke command that proves it works. No daemon, no TaskRecord, no cmux client. **Phase 1 is the empirical go/no-go gate** ("make sure codex can work" before daemon surgery). Mergeable on its own; if Phase 2 stalls it remains a usable direct-client interim.

**Phase 2 — `feature/codex-interactive-crew`.** Wires the proven lib into `cockpitd` as the interactive driver; adds a streaming subscribe channel to the daemon socket; ships the cmux-tab client.

**Boundary.** The lib speaks app-server JSON-RPC. The daemon never hand-rolls protocol. The cmux client never speaks app-server — it speaks cockpit's daemon protocol. Three layers, one direction.

---

## 3 · Phase 1 — `codexAppServerClient`

### 3.1 Transport

Spawn `codex app-server` as a child (default `--listen stdio://`). Frame JSON-RPC over its stdin/stdout, **newline-delimited** (one JSON object per line). Defensive parser: ignore non-JSON lines (orca evidence: `codex-fetcher.ts:160–164, 219–221`), route by `id`/`method`:

- Messages with `id` + `result|error` → match against a pending-request map → resolve.
- Messages with no `id` → notifications → fan out to the typed event emitter.

### 3.2 Mandatory handshake — enforced

Per orca `codex-fetcher.ts:142–146` ("skipping the notification causes 'Not initialized' errors"):

1. Send `initialize` (request, params: `{clientInfo:{name:"cockpit",version}}`).
2. Await response.
3. Send `initialized` notification (no `id`).
4. Only then permit any other method.

The client refuses (throws synchronously) if a non-handshake method is called before step 3 completes. Smoke test asserts the "Not initialized" path cannot occur.

### 3.3 Types — vendored, not hand-written

`codex app-server generate-ts --experimental --out src/control/codex/protocol/` writes the TS bindings. Vendored into the repo; regenerable via an npm script (`npm run codex:gen-types`) and a one-line comment at the top of the generated dir saying "regenerated from codex-cli ≥0.130.0; do not edit by hand." All method calls + notifications import from these types — never re-declare shapes.

### 3.4 Public API

The smallest surface that satisfies Phase 2's needs:

- `initialize(clientInfo) → InitializeResponse` (handshake step 1+3, internal `initialized` notification sent automatically)
- `startThread({cwd, model?, sandbox?, approvalPolicy?}) → {threadId}`
- `resumeThread({threadId, cwd?}) → ThreadResumeResponse` (built in Phase 1, used in Phase 2 / #86)
- `readThread({threadId, lastN?}) → items` (for cmux tab replay after reconnect)
- `sendTurn(threadId, text) → Promise<TurnResult>` — resolves on `TurnCompletedNotification` for that turn; streams via events meanwhile
- `steerTurn(threadId, text) / interruptTurn(threadId)` — mid-turn interject / stop
- `injectItems(threadId, items)` — between-turn injection
- `respondToServerRequest(requestId, payload)` — answer a `ToolRequestUserInput` / approval request
- Events on the emitter: `agentMessageDelta`, `reasoningTextDelta`, `turnStarted`, `turnCompleted`, `itemStarted`, `itemCompleted`, `userInputRequested`, `approvalRequested(*)`, `error`, `closed`

(*) covers `CommandExecutionRequestApproval`, `ApplyPatchApproval`, `FileChangeRequestApproval`, `ExecCommandApproval`, `PermissionsRequestApproval` — surfaced as one `approvalRequested` event with a discriminator on the inner type.

### 3.5 Smoke command — the proof gate

`cockpit codex-chat-smoke [--cwd .] [--model M]`:

1. Spawn `codex app-server`; run handshake; assert success.
2. `startThread({cwd})`.
3. **`sendTurn("Reply with exactly: PING-OK")`** — assert streamed text contains `PING-OK`; assert `TurnCompleted` fires.
4. **`sendTurn("Now reply with: PONG-OK")`** — assert `PONG-OK`; proves multi-turn context.
5. **Approval round-trip** (the orca-zero-prior-art surface — must pass for Phase 1 to merge): a turn that triggers a tool needing approval (e.g. asks codex to write a file in a workspace-write sandbox under a path that requires approval); on `approvalRequested`, respond via `respondToServerRequest`; assert `TurnCompleted` after the resolution.

Exit 0 on all asserts; non-zero with the full transcript on any failure.

### 3.6 Phase 1 acceptance

- All five smoke assertions pass against real `codex-cli ≥0.130.0` on the developer's machine.
- The client refuses a pre-handshake method call (unit-tested).
- The defensive parser ignores non-JSON lines (unit-tested).
- No daemon code touched.

If the approval round-trip fails, **stop**. The fork's residual risk has landed; revisit (`Path Y` becomes the considered fallback at this point — cheap to switch because Phase 2 hasn't started).

---

## 4 · Phase 2 — daemon interactive driver, streaming channel, cmux client

### 4.1 App-server child lifecycle

The daemon owns **one** long-lived `codex app-server` child (spawned on first interactive codex dispatch, kept warm, PID tracked like headless children). One server hosts many threads. If it dies, the daemon respawns and `resumeThread`s every live interactive codex attempt (see §5).

### 4.2 New verb

`cockpit crew chat --provider codex --project <name> [--cwd <dir>] [--model <m>]`:

- Creates a TaskRecord with `mode: "interactive"` — finally implementing the deferred mode, flipping red-team #4's fail-loud for `provider=codex` only.
- Daemon (driver): `initialize` (once per app-server) → `startThread({cwd, model, sandbox:"workspace-write"})` → store `threadId` as the attempt's `resumeRef` on the TaskRecord.
- Then execs the cmux-tab client below, attached to that task.

### 4.3 TaskRecord shape — schema for #91 lands here

Add a `DispatchAttempt` sub-record to `TaskRecord` (in `src/control/types.ts`). Written by the reducer on every transition:

```
DispatchAttempt = {
  attemptId: string
  startedAt: number
  pid?: number
  resumeRef?: string        // opaque, hashed-treated, NEVER parsed (orca #1148 lesson)
  lastHeartbeatAt: number
  error?: string
  exitCode?: number
  circuitBroken?: boolean
}
TaskRecord.attempts: DispatchAttempt[]   // append-only; current attempt = last()
```

This is the schema #91 will roll out across all providers; this spec ships the *schema* and uses it for codex interactive only. The reducer remains pure; the existing per-task top-level fields become derived from `attempts.at(-1)`.

### 4.4 Daemon "ready" — flipped definition

A chat task is not `working` when the codex child has spawned. It is `working` only after:

1. `codex app-server` child up.
2. `initialize` request acked.
3. `initialized` notification sent.
4. `thread/start` returned a `threadId`.

If any step fails or times out (default 10s), the task transitions to `failed` with a clear error. This counters codex 0.129+'s silent-degradation pattern (orca `config-toml-trust.ts:14,20`).

### 4.5 Streaming subscribe channel — the one new protocol surface

The cockpitd socket today is request/response. Live chat needs server→client push. Add **one** framed verb to `src/control/protocol.ts`:

- Client → daemon: `{"op":"attach","taskId":"..."}` opens a long-lived subscription.
- Daemon → client (newline-delimited JSON frames): `{"type":"delta",text}`, `{"type":"turn-started"}`, `{"type":"turn-completed"}`, `{"type":"input-requested",question,requestId}`, `{"type":"approval-requested",kind,detail,requestId}`, `{"type":"gate-promoted",gateId}`, `{"type":"reattached"}`, `{"type":"closed",reason}`.
- Client → daemon (further frames on the same connection): `{"op":"say",text}` → `sendTurn`; `{"op":"steer",text}` → `steerTurn`; `{"op":"interrupt"}`; `{"op":"answer",requestId,payload}` → `respondToServerRequest`.

Additive — existing request/response verbs untouched. Schema-validated (cooperates with #87). The channel uses #94's keepalive framing once that lands (until then, an inline `{"_keepalive":true}` every 10s past idle; clients discard).

### 4.6 cmux-tab client

A new subcommand: `cockpit crew attach <taskId>`. The cmux tab opened by `cockpit crew chat` runs this command in the tab. It connects to the cockpitd socket, sends `attach`, renders streamed deltas as they arrive, readline for input → `say`/`steer`. Renders `input-requested` / `approval-requested` as a clear prompt block. The client is **not** an app-server client; it is **not** codex's TUI. It is a renderer over the cockpit daemon.

Flow: `cockpit crew chat ...` (1) creates the TaskRecord + drives the daemon to `startThread`, then (2) opens a cmux tab whose command is `cockpit crew attach <taskId>`. The two halves are decoupled — `attach` can be called by hand on any existing interactive task, which is also the reconnect path after a daemon bounce (§5).

### 4.7 `normalizeProviderEvent` seam

In `src/control/codex/driver.ts`, a typed function:

```
normalizeAppServerNotification(n: ServerNotification): CanonicalEvent
```

Implemented with an exhaustive `switch` on the notification union from the vendored types. **`never`-guarded**: if codex adds a new notification kind and we regenerate types, the build fails until the new kind is mapped. Canonical mapping (anti-#2576 invariant baked in):

- `TurnStartedNotification` → `working` (state)
- `TurnCompletedNotification` → **`awaiting-input` (liveness, NOT `done`)** — this is the exact #2576 trap; refused here, codified.
- `AgentMessageDeltaNotification` / `ReasoningTextDeltaNotification` / `CommandExecOutputDeltaNotification` → heartbeat (no state change)
- `ToolRequestUserInputParams` (server request) → `blocked` (with `question` set)
- Any `*ApprovalParams` (server request) → `blocked` (with `kind`+`detail`)
- `ErrorNotification` → no state change; surfaced as a tab frame; sticky errors raise a follow-up state via the existing watchdog
- `ContextCompactedNotification`, `ThreadTokenUsageUpdatedNotification`, model/reasoning meta → status-line only

`done` is reached only when the human/captain explicitly closes the chat (`thread/archive` + task close).

Streaming-frame mapping (what §4.5's frames are emitted from): `agentMessageDelta`/`reasoningTextDelta`/`commandExecOutputDelta` → `{"type":"delta",text}`; canonical `working`→`turn-started`; canonical `awaiting-input`→`turn-completed`; canonical `blocked` (input) → `input-requested`; canonical `blocked` (approval) → `approval-requested`; gate promotion (§4.9) → `gate-promoted`; reattach (§5) → `reattached`; task close → `closed`.

### 4.8 State machine — anti-#2576 explicit

- `submitted` → handshake/`thread/start` → `working`
- `working` --[`TurnCompleted`]--> `awaiting-input` --[next `say`/`turn/start`]--> `working`
- `working|awaiting-input` --[`ToolRequestUserInput` / `*Approval`]--> `blocked` --[`answer` or gate-resolve]--> `working`
- Any state --[explicit close]--> `done`
- Stall (no notification ≥ `heartbeatBudgetMs`) → `stalled` (warn + surface to Captain per #90; never auto-`failed`)
- Driver error (handshake fail, app-server crash with no resume possible) → `failed`

`done` is terminal. `stalled` is recoverable. `failed` is terminal. (TERMINAL_STATES stays the same.)

### 4.9 Decision-gate — the HITL slice

When `blocked` lands and **no client has been attached to the task for ≥5 seconds** (the human stepped away, never attached, or the tab is mid-reconnect), the daemon promotes the pending request to a `gate`. The 5s buffer avoids racing with a momentary disconnect. Once a client (re)attaches, the daemon emits `gate-promoted` so the tab can offer to take over the answer if the gate is still `pending`.

Gate schema:

```
Gate = {
  gateId: string
  taskId: string
  kind: "input" | "approval"
  question: string | { kind, detail }
  state: "pending" | "resolved" | "timeout"
  createdAt: number
  resolvedBy?: string
  resolution?: unknown
}
```

The Captain sees gates via `cockpit crew status` (which gains a `gates` field) and resolves them via `cockpit crew reply --gate <gateId> ...`. The driver translates a `gate-resolve` into `respondToServerRequest` against the saved `requestId`. Gates have a configurable timeout (default 30 min) → `timeout` state surfaces to Captain.

A gate is the cockpit-wide primitive's interactive-codex slice. The schema/states are usable as-is when expanded to other providers/roles; that broader rollout is a separate spec.

### 4.10 Phase 2 acceptance

- `cockpit crew chat --provider codex --project X --cwd <worktree>` opens a real codex chat in a cmux tab; the tab streams codex output token-by-token; the user can type a follow-up; codex responds; the user can `Ctrl-C` to `interrupt` mid-turn.
- A codex `approvalRequested` surfaces in the tab; answering it in-tab continues the turn; ignoring it for 5+ seconds promotes to a gate visible in `cockpit crew status` and resolvable from the Captain.
- Killing `cockpitd` mid-chat and restarting it: the cmux tab reconnects (auto-backoff), the daemon `resumeThread`s, the tab shows a `reattached` frame followed by a `thread/read` tail; the next `say` lands on the same thread. **The interactive-codex slice of #86 is closed.**
- `provider≠codex, mode=interactive` continues to fail loud (no behavioral change for other providers).
- A `normalizeAppServerNotification` exhaustiveness gap fails the build (TS verified).

---

## 5 · Resilience — `resumeRef` as the cornerstone

Daemon-bounce survival is defined entirely by `resumeRef`, not by any codex-specific feature:

**App-server child dies.** Daemon respawns it; iterates `attempts` with non-terminal state + non-empty `resumeRef`; calls driver's `reattach(resumeRef)`, which for codex interactive is `thread/resume{threadId, cwd}`. Then a `thread/read` tail replays to any attached cmux client. The app-server's own thread state is durable across this.

**Daemon process bounces** (the launchd `kickstart` case). Cmux client's `attach` connection drops. Client auto-reconnects with backoff and re-`attach`es by `taskId`. Daemon (post-restart) re-`reattach`s the attempts; replays via `thread/read`. The TaskRecord on disk is the durable handle across the bounce. Once #93 (restart coalescing) lands, the bounce window narrows further.

**Honest scope.** This design closes the **interactive-codex slice** of #86. The *headless* slice (a `codex exec` / `claude -p` / `opencode run` mid-flight when the daemon bounces) is NOT closed here. The `DispatchAttempt.resumeRef` field is reusable by those adapters — when they each grow a `reattach(resumeRef)` driver method (`codex exec resume <rolloutId>`, `claude --resume <id>`, etc.), they inherit the same resilience. That cross-provider rollout is part of #91's follow-up.

---

## 6 · Orca-derived hardening (Bucket-1, embedded above)

For traceability, the four Bucket-1 items from `docs/research/2026-05-19-orca-derived-cockpit-improvements.md` and where each lives:

| Bucket-1 item | Section | Notes |
|---|---|---|
| `resumeRef`-on-every-transition (closes #86 interactive slice) | §4.3, §5 | Schema added to `DispatchAttempt`; reducer writes it on every transition |
| Daemon "ready" = successful `initialize` handshake | §4.4 | Explicit gate before `working` |
| `normalizeProviderEvent` seam with `never`-guarded switch | §4.7 | Codex-only today; future-provider expansion = add a case, fail at typecheck if you don't |
| Decision-gate HITL primitive | §4.9 | Interactive-codex slice; cockpit-wide rollout separate |

The Bucket-2 issues (#89–#95) are *not* in this spec — they ship on their own cadence and apply across providers. This spec depends on / cooperates with them but does not require their completion to merge.

---

## 7 · Cross-references & follow-ups

- **Closes** the interactive-codex slice of **#86** (orphan-on-restart). Headless slice remains open.
- **Cooperates with** **#87** (protocol schema validation — the new streaming verb is schema-validated in the same change), **#92** (`PROTOCOL_VERSION` — bumped when this verb lands), **#94** (keepalive framing — used by the streaming channel).
- **Sets up** **#91** (dispatch-attempt sub-records — schema introduced here, rolled across other providers later) and **#90** (warn-don't-autofail — already used in §4.8's `stalled`).
- **Does not block** **#89**, **#93**, **#95** — but each compounds well with this spec.
- **Follow-up spec:** cockpit-wide decision-gate primitive across all providers/roles (extracting §4.9 to a generic).
- **Follow-up spec:** headless `resumeRef` rollout for `claude -p` / `codex exec` / `opencode run`, closing the headless slice of #86.

---

## 8 · Implementation phasing summary

| Phase | Branch | What ships | Mergeable on its own? |
|---|---|---|---|
| 1 | `feature/codex-app-server-client` | `codexAppServerClient` lib + vendored types + `codex-chat-smoke` command incl. approval round-trip | Yes. Phase 1 PASS = empirical go-no-go for Phase 2. |
| 2 | `feature/codex-interactive-crew` | Daemon driver, streaming subscribe channel, cmux client, `DispatchAttempt` schema, `normalizeProviderEvent`, decision-gates, resilience wiring | Yes. Requires Phase 1 merged. |
