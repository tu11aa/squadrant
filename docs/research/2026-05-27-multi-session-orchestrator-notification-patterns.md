# Multi-Session Orchestrator Notification Patterns — Prior-Art Survey

**Date:** 2026-05-27
**Author:** Cockpit research (parent: develop)
**Purpose:** Survey how comparable multi-agent / multi-session systems solve the *crew-completion → captain-attention* problem before redesigning cockpit's daemon-relay-tab mechanism.

---

## 0. The Cockpit Problem, Stated Precisely

Cockpit runs a **captain** session (a Claude/Codex/etc. process inside a cmux pane) that coordinates **crew** sessions (more Claude/Codex/etc. processes in their own cmux panes). When a crew finishes, the captain needs to know — ideally as a *message that lands in the captain's input stream*, so the captain's next turn naturally picks it up.

Two failed approaches and one current workaround:
- **Naive shell-out** — daemon (or a hook) calls `cockpit runtime send <captain> "<msg>"`. cmux rejects this because the caller's PID is not in cmux's process-tree (cmux enforces a process-lineage check, not an env-var/socket-token check).
- **Daemon push events** — same problem: whatever process the daemon delegates to is not parented by cmux.
- **`notify-relay` tab inside the captain workspace** — daemon broadcasts events over its Unix socket; a long-lived "relay" terminal tab *inside* the captain's cmux workspace subscribes to that socket and forwards via the cmux send pathway, which works because the relay is itself a cmux-spawned child. This is correct but feels heavy: an extra tab per captain, a daemon-side fanout, and a per-runtime relay impl.

The interesting question is what *category* of mechanism prior art uses, and whether the relay-tab is an instance of a known good pattern or a workaround we should retire.

---

## 1. The Surveyed Systems (≥6 + background)

Each entry answers: captain↔crew analog · completion signal · signal landing · supervisor delivery · broker · process model · failure mode · abstraction surface.

### 1.1 OpenHands (formerly OpenDevin) — github.com/All-Hands-AI/OpenHands

- **Analog:** `AgentController` ⇄ `Runtime` (sandboxed exec env) and child agent delegates.
- **Signal:** Typed `Action`/`Observation` events. Crew posts an `Observation`; "done" is a specific terminal observation (e.g. `AgentFinishAction`).
- **Lands first:** In-process `EventStream` — a central pub/sub hub. Quoting OpenHands docs: *"The EventStream is a central hub for Events, where any component can publish Events, or listen for Events published by other components."* ([emergentmind](https://www.emergentmind.com/topics/openhands-agent-framework), [DeepWiki](https://deepwiki.com/OpenHands/OpenHands))
- **Supervisor delivery:** `AgentController` is a registered subscriber — *"The AgentController performs Event Stream Subscription, subscribing to `EventStreamSubscriber.AGENT_CONTROLLER` unless it's a delegate."*
- **Broker:** Yes — `EventStream` is the broker, persists events to disk for replay/history (PR #2709, *Refactoring: event stream based agent history*).
- **Process model:** Single Python process owns the controller + event stream; runtime executes in a sandboxed subprocess/container; events cross that boundary as serialized messages.
- **Failure mode:** Replayable — event log on disk means a restarted controller reconstructs state.
- **Abstraction:** Excellent. Subscribers see typed events; no IPC primitives leak.

### 1.2 AutoGen (Microsoft) — github.com/microsoft/autogen

- **Analog:** `GroupChatManager` ⇄ participant agents.
- **Signal:** Agents publish chat messages to topics; "turn done" = manager observes the latest message and decides next speaker (or a `GroupChatTermination` event for done-with-everything).
- **Lands first:** AutoGen Core's **agent runtime** — a pub/sub message bus with **topic-based routing**. Per the source: a *group topic* (broadcast), per-participant topics (direct), and an *output topic* (results channel).
- **Supervisor delivery:** Manager is a `SequentialRoutedAgent` subscribed to the group topic. Output collection: `_output_message_queue` until a `GroupChatTermination` event arrives.
- **Broker:** Yes — the `AgentRuntime` (in-process local, or distributed gRPC variant).
- **Process model:** Configurable. Default: all agents in one Python process. Distributed: agents on separate hosts behind a gRPC runtime.
- **Failure mode:** In-memory loss by default; distributed variant adds delivery guarantees.
- **Abstraction:** Strong. Agents only know `publish_message(topic, msg)` and subscriptions — never sockets.

### 1.3 crewAI — github.com/crewAIInc/crewAI

- **Analog:** `Crew` ⇄ `Task` ⇄ `Agent`.
- **Signal:** Plain Python function return. `task.execute_sync()` returns; `Crew.kickoff()` loops sequentially over tasks. Optional **`task_callback`** fires after each task; **`step_callback`** fires after each agent step. For the HTTP-API surface, equivalents are `taskWebhookUrl`/`stepWebhookUrl`/`crewWebhookUrl` ([CrewAI docs](https://docs.crewai.com/en/learn/sequential-process), [community thread](https://community.crewai.com/t/how-does-the-task-callback-parameter-work/389)).
- **Lands first:** Same Python stack frame (sync) or webhook receiver (API mode).
- **Supervisor delivery:** Loop continuation; callback invocation.
- **Broker:** None (in-process). Webhooks are the only out-of-process surface.
- **Process model:** Single Python process for the local SDK. Tasks are not subprocesses.
- **Failure mode:** Exceptions bubble; no built-in replay.
- **Abstraction:** Sync function semantics — simplest possible.

### 1.4 LangGraph (langchain-ai) — multi-agent supervisor pattern

- **Analog:** Supervisor node ⇄ worker nodes in a state graph.
- **Signal:** Workers return a **`Command`** object. Specifically `Command(goto=target, graph=Command.PARENT, update={...})` to hand control somewhere; `create_handoff_back_messages()` to return to supervisor with `__is_handoff_back` marker ([DeepWiki: Handoff Tools](https://deepwiki.com/langchain-ai/langgraph-supervisor-py/3.2-handoff-tools)).
- **Lands first:** The LangGraph runtime — interprets the `Command` and transitions the state graph.
- **Supervisor delivery:** Next graph step; supervisor's prompt rebuilt with appended messages.
- **Broker:** The graph runtime itself.
- **Process model:** Single Python process; node executions are awaited coroutines.
- **Failure mode:** Checkpointer persists graph state; resumable.
- **Abstraction:** Very clean — declarative graph, no IPC visible.

### 1.5 OpenAI Swarm — github.com/openai/swarm

- **Analog:** "Current agent" ⇄ "next agent" via handoff.
- **Signal:** A tool function returns an `Agent` (or `Result(agent=...)`). The run loop swaps to it. *"Swarm's `run()` function is analogous to `chat.completions.create()` — it takes `messages` and returns `messages` and saves no state between calls."*
- **Lands first:** Same Python stack; the loop sees the returned `Agent` and continues with it.
- **Supervisor delivery:** Function return — synchronous.
- **Broker:** None. Stateless.
- **Process model:** Single Python process, single linear loop.
- **Failure mode:** Caller's problem; no persistence.
- **Abstraction:** Minimal: a function returns the next worker.

### 1.6 Tmux-Orchestrator — github.com/Jedward23/Tmux-Orchestrator

This is the closest cousin to cockpit and the most instructive comparison.

- **Analog:** Orchestrator → Project Managers → Engineers, each as a separate tmux window running its own Claude instance.
- **Signal:** **Polled + self-scheduled.** No async push exists. A Claude instance schedules its own check-in via `schedule_with_note.sh 30 "Continue dashboard implementation"`. The orchestrator periodically reads pane content via `tmux capture-pane`.
- **Lands first:** Tmux's own pane scrollback (text). The "broker" is *the screen*.
- **Supervisor delivery:** Orchestrator polls + reads + interprets. To talk back: `send-claude-message.sh session:window "msg"`, which `tmux send-keys`'s the text into the target pane. This is the exact equivalent of cockpit's `cockpit runtime send` — and it works in tmux because tmux does **not** enforce a process-lineage check on the writer (anyone with socket perms can `send-keys`).
- **Broker:** None — tmux is both transport and storage.
- **Process model:** Multi-process; each Claude is a child of its tmux pane.
- **Failure mode:** Lost work is unbounded if the orchestrator never checks back. The self-scheduling pattern is the only safety net.
- **Abstraction:** Leaky — scripts that scrape and inject text. The prompt-engineering rules are the contract.

**Cockpit-relevant lesson:** Tmux-Orchestrator works because tmux's authorization model is "owner of the socket" — no lineage check. cmux's stricter check is what forces cockpit to host the sender inside cmux's tree. Tmux-Orchestrator also reveals the **cooperative-callback pattern** that Orca later formalized.

### 1.7 Claude Squad — github.com/smtg-ai/claude-squad

- **Analog:** N independent Claude instances, each in its own git worktree + tmux session.
- **Signal:** **None automatic.** Completion is human-detected via the TUI (preview/diff tabs, manual `c` checkout / `r` resume).
- **Lands first:** User's eyes.
- **Supervisor delivery:** User.
- **Broker:** None.
- **Process model:** Multi-process, isolated worktrees.
- **Failure mode:** Human in the loop.
- **Abstraction:** Deliberately *not* an orchestrator — explicitly says it leaves coordination to the human.

**Lesson:** A respected multi-Claude tool ducked the captain↔crew problem entirely. Cockpit's ambition (autonomous captain reacting to crew) is meaningfully harder than what Claude Squad attempts.

### 1.8 Orca (stablyai) — github.com/stablyai/orca (already studied)

- **Analog:** Coordinator + per-agent terminal panes (PTY-hosted).
- **Signal:** Two simultaneous channels, depending on agent:
  1. **Native hooks → loopback HTTP** (Claude Code & Codex 0.129+). Hooks `curl` a JSON payload to `http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/<agent>` with a bearer token. `Stop` event = turn done. See `src/main/codex/hook-service.ts:42-49` and `src/main/agent-hooks/server.ts`.
  2. **Cooperative CLI callback** for the autonomous coordinator: prompt preamble teaches the agent to call `orca task complete --body <summary>`, plus a 10-min stale-heartbeat watchdog (`src/main/runtime/orchestration/coordinator.ts:172,230,332-335`).
- **Lands first:** Orca's main Electron process (HTTP server + IPC). Persisted in `last-status.json` for restart survival.
- **Supervisor delivery:** IPC fanout to the renderer process / orchestration coordinator.
- **Broker:** The loopback HTTP server + on-disk status cache.
- **Process model:** Multi-process; each agent is its own `node-pty` child. Orca itself owns the broker.
- **Failure mode:** Replay from `last-status.json`; hook script re-reads `$ORCA_AGENT_HOOK_ENDPOINT` so it survives Orca restart on the *same* PTY.
- **Abstraction:** Excellent inside Orca; leaks through the hook config files in `~/.codex/hooks.json` and `~/.codex/config.toml`.

### 1.9 Codename Goose (Block) — github.com/block/goose

- **Analog:** Single agent + MCP **extensions** (tool servers).
- **Signal:** Standard MCP — JSON-RPC over stdio/SSE/streamable HTTP. *Not a multi-agent coordinator.* There's no inter-extension event bus; extensions are tool providers, not peer agents.
- **Lands first:** MCP client transport.
- **Process model:** Goose host + one subprocess per stdio extension.
- **Lesson for cockpit:** MCP is a *tool-call* protocol, not a peer-to-peer notification protocol. Modeling crew→captain as an MCP tool call would invert the right direction (captain pulls, never pushed).

### 1.10 Codex CLI app-server (OpenAI) — see `docs/research/2026-05-19-orca-codex-wrapping-study.md`

- **Analog:** Driver process ⇄ codex child via JSON-RPC over stdio.
- **Signal:** Notifications in the JSON-RPC stream (`turn.completed`, etc.), framed as newline-delimited JSON.
- **Lands first:** Driver's stdio reader.
- **Broker:** None — direct stdio.
- **Process model:** Parent owns the child via pipe.
- **Lesson:** Strong typed-event channel **but only between a parent and its own child**. Useless if the captain isn't the codex parent — which is exactly the cockpit constraint (cmux owns the codex/claude child, not cockpit's daemon).

### 1.11 Background — process-coordination prior art

| System | One-line lesson |
|---|---|
| **systemd `sd_notify`** | Single UDP-style datagram to `$NOTIFY_SOCKET` (Unix DGRAM). `READY=1`, `STATUS=…`, `WATCHDOG=1`. Auth via `SCM_CREDENTIALS`. No broker, no queue — fire-and-forget but reliable on localhost. ([sd_notify man](https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html)) |
| **D-Bus** | Mature pub/sub: signals broadcast; clients register interest; bus daemon fans out. Strong typing via introspection. Transport: Unix domain sockets. ([spec](https://dbus.freedesktop.org/doc/dbus-specification.html)) |
| **macOS XPC** | Modern client/server IPC with privilege separation; the recommended replacement for `NSDistributedNotificationCenter` (which can't carry user info). |
| **Erlang/OTP** | Supervisor `monitor`s worker process; worker death → `{'DOWN', Ref, ...}` lands in supervisor's *mailbox* (a queue per process). Mailbox is the broker; pattern-match dequeue. Gold-standard fault-tolerance semantics. |
| **OpenTelemetry collector** | `receiver → processor → exporter` pipeline; receivers are pluggable transports; same data can fan out to N exporters. Mirrors cockpit's "event from any runtime → many sinks (TUI, Telegram, push)" need. |

---

## 2. Comparison Table

| System | Process model | Signal mechanism | Delivery | Reliability | Abstraction | Cockpit-applicable insight |
|---|---|---|---|---|---|---|
| OpenHands | 1 host + sandbox subproc | Typed event in `EventStream` | Subscriber callback (push) | Disk-replayable | Strong (events) | Central in-process bus + on-disk log = best decoupling story |
| AutoGen | 1 proc (or gRPC) | Topic-pub/sub message | Topic subscriber | In-mem (local) / guaranteed (gRPC) | Strong | Topic routing scales to many-to-many |
| crewAI | 1 proc | Function return + callback | Loop continuation | None | Trivial | Don't over-engineer if you control the loop |
| LangGraph | 1 proc | `Command(goto=…)` value | Graph step | Checkpointed | Declarative | Express handoff as data, not IPC |
| OpenAI Swarm | 1 proc | Function returns `Agent` | Loop continuation | None | Trivial | Stateless transfer is enough when in-process |
| Tmux-Orchestrator | Multi-proc (tmux) | Scrape pane + `send-keys` | Poll + injected text | Lost if unread | Leaky | tmux allows external sender → no relay needed there |
| Claude Squad | Multi-proc (tmux) | None — human checks | Manual | N/A | N/A | Punted entirely |
| Orca | Multi-proc (PTY) | Native hooks → loopback HTTP | HTTP POST + IPC fanout | Disk-cached | Strong | **Hooks-as-source-of-truth + broker is the winning pattern** |
| Goose (MCP) | Multi-proc (MCP) | JSON-RPC tool call | Caller awaits | Per-call | Strong | Wrong direction for completion notify |
| Codex app-server | Parent + child | JSON-RPC notification | stdio read | Stream lifetime | Strong | Requires parent-of-child relationship |
| systemd sd_notify | Multi-proc | Unix DGRAM | Daemon recv | Localhost-reliable | Strong | Smallest viable IPC |
| D-Bus | Multi-proc | Signal broadcast | Bus fanout | Bus-mediated | Strong | Real-world pub/sub at OS level |
| Erlang/OTP | Multi-proc (BEAM) | `monitor` + mailbox | Mailbox dequeue | Queued | Gold | Per-supervisor mailbox = ideal mental model |
| OTel collector | Pluggable | Receiver → exporter pipeline | Push | Configurable | Strong | One event, many sinks (TUI/push/file) |

---

## 3. Recommendations for cockpit (ranked)

I'm ranking **3 patterns** by fit, given cockpit's hard constraints:
1. Multi-runtime (Claude Code, Codex, Gemini, Aider, opencode).
2. Multi-host runtime (cmux today; Orca, Zed, IntelliJ-MCP tomorrow).
3. The captain runs in a *real shell inside the runtime's pane* and consumes input from that runtime's input mechanism.
4. cmux enforces a process-lineage check: the writer to the captain's pane **must** be in cmux's process tree.

### Rank 1 — **Mailbox + injector pattern** (Erlang + Orca hybrid). Strongly recommended.

**Mechanism.** The cockpit daemon is the **broker** (Erlang's `gen_server` analog). Every captain has a **mailbox**: a queue on the daemon's side keyed by captain-id. Each runtime registers exactly **one injector** — a tiny long-lived process *inside that runtime's process tree* — whose only job is to dequeue from the captain's mailbox and call the runtime-specific "type into pane" API. The injector is the cockpit-side analog of the **`notify-relay` tab you already have**, but generalized and dignified as a first-class architectural element rather than an "extra terminal tab."

**Why this is the right rebranding of what you've built.**
- The relay-tab is not a workaround — it is the same pattern Erlang uses (the per-process mailbox needs a per-process dequeuer that runs *inside* that process's scheduler). cmux's lineage check is the equivalent of the BEAM scheduler boundary: only the right context can deliver. You were right to put a process inside cmux; you were wrong to feel bad about it.
- The mailbox semantics fix the failure mode the current design *doesn't* address well: if the captain is mid-turn, mid-shutdown, or briefly absent, events queue rather than vanish. (Today the relay tab forwards immediately; if the captain pane is busy, cmux send may swallow the input.)
- One injector per runtime, not per captain: a single `cockpit-injector` daemon process per cmux instance can serve every captain hosted there.

**Concrete sketch replacing the relay-tab.**
- Daemon exposes `MailboxAppend(captainId, event)` and `MailboxClaim(captainId, sinceCursor) → events`.
- Runtime driver implements `Injector(runtime, captainId)` — a small Go/Node/Python binary started by `cmux spawn` as a hidden helper process inside the captain's workspace. Long-poll `MailboxClaim`, then call the runtime's send mechanism. On startup the injector also drains any backlog accumulated while the captain was idle.
- Captain shutdown removes the mailbox; restart restores it from disk (Orca-style `last-status.json` analog).
- Tracker integration: the daemon's existing socket pub/sub becomes a *receiver* in OTel-collector parlance; the mailbox is a *processor*; the injector is the only *exporter* that has to satisfy cmux's lineage rule. Telegram, TUI, and push notifications continue to subscribe to the receiver directly — they don't go through the lineage-bound exporter.

**Handles cmux's lineage check:** Yes — the injector is spawned by cmux and lives inside its tree by definition. For Orca/Zed/IntelliJ-MCP, the same injector concept reincarnates as: an Orca pane hosting `cockpit-injector orca`; a Zed task; an IntelliJ background process. Each runtime driver owns its injector binary; the mailbox protocol is shared.

**Complexity tradeoff:** Mid. You already have most of this (daemon socket pub/sub + relay tab). The work is (a) adding a queue + cursor on the daemon side, (b) generalizing the relay into a `cockpit-injector` binary that any runtime can spawn, (c) shipping a per-runtime "start injector at workspace open" lifecycle hook.

### Rank 2 — **Hooks-into-loopback-broker** (Orca pattern, generalized).

**Mechanism.** Every supported agent CLI has *some* native completion hook (Claude Code: `Stop` hook; Codex 0.129+: `Stop` hook; Gemini: still TBD; Aider: `--message` mode returns; opencode: events). The hook `curl`s a loopback HTTP endpoint on the daemon. The daemon now has the authoritative "crew X is done" signal *from the agent itself*, not from process-watching or PTY-scraping.

**This solves a different problem** — it's about **detection**, not **delivery**. You still need pattern #1 (or #3) to *get the news into the captain's input*. But pairing #2 with #1 gives cockpit a complete loop:
- Detection: native hook → daemon (Orca-validated).
- Delivery: daemon mailbox → in-cmux injector (Rank 1).

**Handles cmux's lineage check:** Irrelevant for detection. Delivery still needs Rank 1.

**Why not rank it #1:** You implicitly already have detection (cmux's `read-screen` + your own heuristics). The acute pain is delivery, not detection. Adopt #2 incrementally as each runtime gains native hooks, but it doesn't supplant #1.

### Rank 3 — **Captain-side polling against the daemon socket** (the "do nothing in-cmux" option).

**Mechanism.** Drop the relay tab entirely. Teach the captain — via its system prompt / a skill — to **periodically run a CLI command** (`cockpit inbox`) inside its own loop, which reads from the daemon socket and returns new events as plain text. The captain has shell access; calling a CLI is well within its toolset.

**Why this is tempting.** Zero extra processes. Zero relay. The captain is the one with cmux-blessed input access (it *is* the cmux child), so by definition any text it generates lands in the right place. The "delivery" step becomes "captain prints what it reads." Polling cadence is captain-decided.

**Why it's #3, not #1.** It changes captain semantics from *reactive* to *proactive*. A captain that's mid-turn won't poll. A captain that's stuck in a tool call doesn't notice the crew finished. The whole point of push-notification was to make the captain wake up when crew lands; rank 3 quietly returns to polling, which we already rejected in the 2026-05-16 idle-detection research. Use only as a fallback for runtimes where injector-spawn isn't possible.

**Handles cmux's lineage check:** Trivially — there is no external sender.

**For Orca/Zed/IntelliJ-MCP:** Works in all of them. This is the universal-fallback path.

---

## 4. Synthesis: the proposed design

```
                 ┌──────────────────┐
   crew event ──▶│  daemon receiver │ (existing)
                 └────────┬─────────┘
                          │ fanout
            ┌─────────────┼─────────────────┐
            ▼             ▼                 ▼
        Telegram       TUI/push     ┌─────────────────┐
                                    │ per-captain     │
                                    │ mailbox (queue) │ (NEW)
                                    └────────┬────────┘
                                             │ long-poll
                                             ▼
                                  ┌─────────────────────┐
                                  │ cockpit-injector    │  ◀── spawned by cmux,
                                  │ (1 per runtime host)│      lives in cmux tree
                                  └────────┬────────────┘
                                           │ runtime.send()
                                           ▼
                                    captain's input
```

This is **the relay-tab pattern, renamed and dignified**: the relay becomes a first-class "injector" with a queue behind it. Add native-hook detection (Orca pattern, Rank 2) as runtimes support it. Keep CLI-poll (Rank 3) as the never-fails fallback the captain can always run.

### What this buys you vs. the current relay-tab

- **Buffering** — events don't vanish if the captain pane is briefly busy.
- **Restart survival** — mailbox is durable; injector restart drains backlog.
- **One concept, all runtimes** — Orca/Zed/IntelliJ get the same protocol; only the injector binary changes per runtime.
- **No new IPC primitives** — uses your existing daemon socket; the mailbox is just a map<captainId, []event> on the daemon plus a cursor.
- **Tracker stays decoupled** — receivers, processors (mailbox), exporters (injector) is the OTel-collector shape, which makes "send the same event to Telegram and the captain" a config concern rather than a code concern.

---

## Provider Coverage Audit — Claude / Codex / Opencode

The relay/notify pattern in section 3 assumes each runtime provider can hand cockpit a "crew finished" signal. Today claude-code emits this via `Stop` / `SessionEnd` hooks (PR #108) and codex emits it via app-server JSON-RPC notifications (PR #97/#98). Opencode interactive crews currently route through the legacy cmux-only spawn path (`src/commands/crew.ts:163`) — the daemon is unaware of them. This audit answers whether opencode can be wired into the same notify loop, and what shape that wiring should take.

### Findings — opencode (sst/opencode)

1. **Hook / lifecycle event system — YES, via the plugin system.** Opencode ships a first-class plugin framework. A plugin is a TypeScript module placed under `.opencode/plugin/*.ts` or wired through `opencode.json → plugins`. Plugins receive an async `event` callback and can also wrap tool execution with `tool.execute.before` / `tool.execute.after`. Documented event names include `session.idle` and tool-execution events; the DEV.to overview and the SDK page both reference these as the canonical extension surface ([dev.to "Does OpenCode Support Hooks?"](https://dev.to/einarcesar/does-opencode-support-hooks-a-complete-guide-to-extensibility-k3p), [OpenCode SDK docs](https://opencode.ai/docs/sdk/)). DeepWiki's session-lifecycle page confirms a `session_start` / `session_idle` / `session_end` taxonomy on the event bus but does not enumerate the exact wire names ([DeepWiki §2.1 session lifecycle](https://deepwiki.com/sst/opencode/2.1-session-lifecycle-and-state)). **Unable to confirm via public docs** whether `session.end` is a stable plugin-callable event or only an internal-bus event; the safe assumption is `session.idle` (the documented one) is the closest "turn done" analog for cockpit's purposes.

2. **App-server / streaming protocol — YES, but it's HTTP REST + SSE, not JSON-RPC.** `opencode serve` starts a headless HTTP server exposing an OpenAPI 3.1 spec; flags include `--port`, `--hostname`, `--mdns`, `--cors`, and `OPENCODE_SERVER_PASSWORD` for basic auth ([Server docs](https://opencode.ai/docs/server/)). Two SSE endpoints stream the event bus: `GET /event` (per-session/global bus; first message is `server.connected`, then bus events) and `GET /global/event`. This is a long-lived subscribe pattern; a daemon can keep one HTTP connection open and receive every bus event for the life of the server.

3. **MCP — opencode is an MCP *client*, not an MCP server exposing lifecycle events.** Opencode's MCP integration is for *adding tools to opencode*, not for letting outside processes subscribe to opencode events ([MCP docs](https://opencode.ai/docs/mcp-servers/)). The Goose lesson from §1.9 applies: MCP is the wrong direction for completion-notify.

4. **`opencode run --format json` — YES.** The `run` subcommand supports `--format json`, documented as "raw JSON events". Combined with `--session <id>` / `--continue` / `--fork`, this gives a headless invocation that streams structured events to stdout — usable from a non-cmux wrapper, though for the cockpit-interactive case the SSE bus is the better channel because it persists across multiple turns.

5. **Programmatic SDKs — YES.** Official `@opencode-ai/sdk` (TypeScript) wraps the HTTP + SSE surface in typed methods including `event.subscribe()` ([JS SDK DeepWiki](https://deepwiki.com/sst/opencode/7.1-javascripttypescript-sdk)). Community-maintained Go (`opencode-sdk-go`) and Python (`opencode-sdk-python`) SDKs are generated from the same OpenAPI spec. Also worth flagging: opencode implements the **Agent Client Protocol (ACP) over JSON-RPC** for editor integrations (Zed et al.), exposing events like `permission.asked` and `usage_update` ([DeepWiki ACP](https://deepwiki.com/sst/opencode/7.4-agent-client-protocol-(acp))); ACP is a *second* event surface alongside the HTTP/SSE bus, used when something on the IDE side needs to be the agent's loop driver.

6. **Resume semantics — YES.** Both `opencode run` and the TUI accept `--continue` (`-c`), `--session <id>` (`-s`), and `--fork`. Sessions are persisted (SQLite via Drizzle ORM per the lifecycle page); reattaching after a daemon bounce is supported, with the daemon recovering the session-id from its own state rather than from opencode itself.

### Comparison table

| Capability | Claude | Codex | Opencode | Notes |
|---|---|---|---|---|
| Hook system (file-configurable lifecycle events) | YES — `settings.json` Stop / SubagentStop / SessionEnd | NO native; Orca proves Codex 0.129+ adds `Stop` hooks but cockpit doesn't use them yet | YES — TS plugin in `.opencode/plugin/*.ts`; `event` callback + tool before/after; `session.idle` documented | Opencode plugin is code, not pure JSON, so harder to template than Claude's `settings.json` but more expressive |
| App-server / streaming protocol | NO (stdio CLI only) | YES — app-server, JSON-RPC over stdio | YES — `opencode serve` HTTP + SSE; ACP JSON-RPC also available | Opencode is the only one with a *socket-listening* server out of the box |
| MCP server interface (exposes events) | Claude is MCP client only | Codex is MCP client only | Opencode is MCP client only | None of the three lets cockpit subscribe via MCP |
| JSON output mode (headless) | YES — `claude -p --output-format=json` | YES — `codex exec --json` | YES — `opencode run --format json` | All three usable for one-shot non-interactive crews |
| Session resume | YES — `claude -c` / `--resume` | YES — `codex exec resume` | YES — `opencode run --session <id>` / `--continue` / `--fork` | All three persist sessions |
| Programmatic SDK | YES — `@anthropic-ai/claude-code` TS SDK | CLI only (no first-party SDK as of 0.130) | YES — `@opencode-ai/sdk` TS (official); Go & Python (community, generated) | Opencode has the richest SDK story |

### Verdict — does the relay/notify pattern work for opencode?

**Best path: SSE subscribe + a lightweight plugin emitter.** Opencode is the *easiest* of the three providers to wire into the daemon. The daemon can connect once to `http://127.0.0.1:<port>/event` per running `opencode serve` and receive `session.idle` and other bus events with zero per-crew configuration. This is structurally identical to the codex app-server path (long-lived stream, daemon subscribes), differing only in transport (HTTP+SSE vs. JSON-RPC-over-stdio). To make the "turn-done" semantic explicit (rather than inferring from `session.idle`), cockpit can ship a tiny `.opencode/plugin/cockpit-emit.ts` that calls back into the daemon's `task.progress` endpoint on whatever lifecycle hook is most stable — this is the *exact same* shape as the PR #108 claude-code hook, just expressed as a plugin instead of a `settings.json` entry. Net: opencode supports **both** of the prior patterns simultaneously, with the SSE path requiring zero crew-side config.

**Fallback: app-server-style SSE alone.** If the plugin emitter proves brittle (e.g. opencode plugin API changes between 0.x releases, which is plausible given the project's velocity), the daemon can rely purely on the documented SSE bus. `session.idle` is the canonical "agent finished its turn" signal per the public docs and is sufficient for the captain-attention use case. This is strictly the codex pattern, ported.

**Universal fallback: explicit `cockpit crew signal done`.** The crew template can always include an instruction to call `cockpit crew signal done` as the last action of any task — this is provider-agnostic and works today for opencode without any new wiring, at the cost of relying on the agent to remember to call it. This should remain in the opencode crew template as the belt-and-suspenders fallback even after auto-detection ships, mirroring the explicit-signal path that already exists for the claude path.

**Ranked by honest-fit-for-opencode:** (1) SSE subscribe with `session.idle` as the trigger — minimal moving parts, uses only documented public APIs, mirrors codex pattern. (2) Plugin emitter calling `task.progress` — most precise semantics, but ties cockpit to opencode's plugin API surface area. (3) Explicit `cockpit crew signal done` — always-works fallback, keep in template. **Recommendation: ship (1) first, add (2) only if `session.idle` proves too noisy or imprecise, keep (3) in the template always.**

**Does the section-3 architectural recommendation still hold across all three providers?** **Yes, unambiguously.** The "dignify the relay into a first-class injector with daemon-side mailbox" verdict is *strengthened* by opencode entering the mix. Today the daemon receives three radically different completion signal shapes: file-configured hooks (claude), parent-of-child JSON-RPC (codex), and long-lived HTTP+SSE (opencode). The mailbox-plus-injector design is the only one of the three section-3 ranks that absorbs all three transports cleanly: each runtime's driver translates its native event surface into `MailboxAppend(captainId, event)`, and the in-cmux injector remains the single lineage-blessed exporter. Without the mailbox abstraction, cockpit would need three parallel paths from detection-source straight to cmux send, each replicating its own buffering, retry, and lineage handling. The audit confirms detection is the easy part for all three providers; delivery into a process-lineage-restricted captain pane remains the hard part, and a per-captain mailbox is the right factoring of that responsibility.

---

## 5. Inaccessible / partially-accessible sources

- `github.com/All-Hands-AI/OpenHands/blob/main/openhands/events/stream.py` — repeatedly 404'd via WebFetch (likely renamed or moved in current main). Compensated with DeepWiki + the *Refactoring: event stream based agent history* PR #2709 + the OpenHands README structure.
- `github.com/crewAIInc/crewAI/blob/main/src/crewai/task.py` and `crew.py` — 404'd via WebFetch (path layout has changed; likely under `src/crewai/lib/`). Compensated with crewAI official docs + community threads documenting `task_callback`/`step_callback` semantics.
- `langchain-ai.github.io/langgraph/concepts/multi_agent/` — redirected to an empty page; used DeepWiki and the focused.io article instead.
- `freedesktop.org/sd_notify` — 403 on the canonical URL; used Baeldung + the gist + general systemd docs.
- Goose source — README is high-level; did not deep-read `crates/`. Confirmed only that Goose has no peer-agent event bus (MCP is tool-call, not pub/sub).
- Aider — confirmed no built-in multi-session model. Skipped detailed source dive.

No other systems on the request list were inaccessible.

---

## 6. References

- OpenHands — [README](https://github.com/All-Hands-AI/OpenHands), [DeepWiki Agent System](https://deepwiki.com/OpenHands/OpenHands/6-configuration-system), [EmergentMind summary](https://www.emergentmind.com/topics/openhands-agent-framework), PR #2709
- AutoGen — [microsoft/autogen](https://github.com/microsoft/autogen), `python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat.py`
- crewAI — [docs.crewai.com sequential process](https://docs.crewai.com/en/learn/sequential-process), [task_callback thread](https://community.crewai.com/t/how-does-the-task-callback-parameter-work/389)
- LangGraph — [DeepWiki handoff tools](https://deepwiki.com/langchain-ai/langgraph-supervisor-py/3.2-handoff-tools), [focused.io article](https://focused.io/lab/multi-agent-orchestration-in-langgraph-supervisor-vs-swarm-tradeoffs-and-architecture)
- OpenAI Swarm — [openai/swarm](https://github.com/openai/swarm)
- Tmux-Orchestrator — [Jedward23/Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator) (`send-claude-message.sh`, `schedule_with_note.sh`)
- Claude Squad — [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)
- Orca — [stablyai/orca](https://github.com/stablyai/orca); see `docs/research/2026-05-19-orca-codex-wrapping-study.md` (`src/main/codex/hook-service.ts`, `src/main/agent-hooks/server.ts`, `src/main/runtime/orchestration/coordinator.ts`)
- Goose — [block/goose](https://github.com/block/goose), [DeepWiki extension types](https://deepwiki.com/block/goose/5.3-extension-types-and-configuration)
- Codex CLI — internal study `docs/research/2026-05-19-orca-codex-wrapping-study.md`
- systemd `sd_notify` — [Baeldung](https://www.baeldung.com/linux/systemd-notify), [systemd Type=notify gist](https://gist.github.com/grawity/6e5980981dccf66f554bbebb8cd169fc)
- D-Bus — [Wikipedia](https://en.wikipedia.org/wiki/D-Bus), [spec](https://dbus.freedesktop.org/doc/dbus-specification.html)
- macOS XPC — [NSHipster IPC](https://nshipster.com/inter-process-communication/), [Karol Mazurek XPC](https://karol-mazurek.medium.com/xpc-programming-on-macos-7e1918573f6d)
- Erlang/OTP — [Erlang System Documentation](https://www.erlang.org/doc/system/design_principles.html), [Hamler OTP behaviours](https://www.emqx.com/en/blog/hamler-0-2-otp-behaviours-with-type-classes)
- OpenTelemetry collector — [Architecture docs](https://opentelemetry.io/docs/collector/architecture/)
- Prior cockpit research — `docs/research/2026-05-16-idle-detection-and-inter-agent-orchestration.md`, `docs/research/2026-05-19-orca-codex-wrapping-study.md`, `docs/research/2026-05-19-cockpit-vs-orca-system-comparison.html`
