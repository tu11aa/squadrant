# Multi-Session Orchestrator Notification Patterns — Nghiên cứu so sánh thiết kế

**Date:** 2026-05-27
**Tác giả:** Cockpit research (parent: develop)
**Mục đích:** Khảo sát cách các hệ multi-agent / multi-session tương đương giải quyết bài toán *crew hoàn thành → đánh thức captain*, trước khi thiết kế lại cơ chế daemon-relay-tab của cockpit.

---

## 0. Vấn đề của Cockpit, phát biểu chính xác

Cockpit chạy một session **captain** (một process Claude/Codex/v.v. nằm trong một cmux pane) làm nhiệm vụ điều phối các session **crew** (cũng là các process Claude/Codex/v.v., mỗi cái nằm trong cmux pane riêng). Khi một crew xong việc, captain cần biết — lý tưởng là dưới dạng một *message được đẩy thẳng vào input stream của captain*, để turn kế tiếp của captain nhận được nó một cách tự nhiên.

Hai cách tiếp cận thất bại và một workaround hiện tại:
- **Naive shell-out** — daemon (hoặc một hook) gọi `cockpit runtime send <captain> "<msg>"`. cmux từ chối vì PID của caller không nằm trong process-tree của cmux (cmux kiểm tra process-lineage chứ không phải env-var/socket-token).
- **Daemon push events** — cùng vấn đề: process nào mà daemon delegate sang đều không có parent là cmux.
- **`notify-relay` tab nằm trong captain workspace** — daemon broadcast events qua Unix socket của nó; một terminal tab "relay" sống dai *bên trong* cmux workspace của captain subscribe socket đó và forward qua đường cmux send, hoạt động được vì relay tự nó là một child do cmux spawn ra. Cách này đúng nhưng có vẻ nặng nề: thêm một tab cho mỗi captain, thêm fanout phía daemon, và một relay impl cho mỗi runtime.

Câu hỏi đáng hỏi là prior art dùng *category* mechanism nào, và liệu cái relay-tab kia là một instance của một pattern tốt đã biết hay là một workaround đáng vứt đi.

---

## 1. Các hệ thống được khảo sát (≥6 + background)

Mỗi mục trả lời: analog cho captain↔crew · completion signal · signal landing · supervisor delivery · broker · process model · failure mode · abstraction surface.

### 1.1 OpenHands (trước đây là OpenDevin) — github.com/All-Hands-AI/OpenHands

- **Analog:** `AgentController` ⇄ `Runtime` (sandboxed exec env) và các child agent delegate.
- **Signal:** Typed `Action`/`Observation` events. Crew post một `Observation`; "done" là một terminal observation cụ thể (ví dụ `AgentFinishAction`).
- **Lands first:** In-process `EventStream` — một central pub/sub hub. Trích docs OpenHands: *"The EventStream is a central hub for Events, where any component can publish Events, or listen for Events published by other components."* ([emergentmind](https://www.emergentmind.com/topics/openhands-agent-framework), [DeepWiki](https://deepwiki.com/OpenHands/OpenHands))
- **Supervisor delivery:** `AgentController` là một subscriber đã đăng ký — *"The AgentController performs Event Stream Subscription, subscribing to `EventStreamSubscriber.AGENT_CONTROLLER` unless it's a delegate."*
- **Broker:** Có — `EventStream` chính là broker, persist events xuống đĩa để replay/history (PR #2709, *Refactoring: event stream based agent history*).
- **Process model:** Một Python process duy nhất sở hữu controller + event stream; runtime chạy trong một sandboxed subprocess/container; events vượt qua boundary đó dưới dạng serialized messages.
- **Failure mode:** Replayable — event log trên đĩa nghĩa là controller restart sẽ reconstruct được state.
- **Abstraction:** Excellent. Subscribers chỉ thấy typed events; không có IPC primitive nào lộ ra.

### 1.2 AutoGen (Microsoft) — github.com/microsoft/autogen

- **Analog:** `GroupChatManager` ⇄ participant agents.
- **Signal:** Agents publish chat messages lên topics; "turn done" = manager quan sát message mới nhất rồi quyết next speaker (hoặc một `GroupChatTermination` event nghĩa là done-with-everything).
- **Lands first:** **Agent runtime** của AutoGen Core — một pub/sub message bus với **topic-based routing**. Theo source: một *group topic* (broadcast), per-participant topics (direct), và một *output topic* (results channel).
- **Supervisor delivery:** Manager là một `SequentialRoutedAgent` đã subscribe group topic. Output collection: `_output_message_queue` cho đến khi nhận được `GroupChatTermination` event.
- **Broker:** Có — `AgentRuntime` (in-process local, hoặc distributed gRPC variant).
- **Process model:** Configurable. Default: tất cả agents trong một Python process. Distributed: agents trên các host khác nhau sau một gRPC runtime.
- **Failure mode:** Mất in-memory theo default; distributed variant thêm delivery guarantees.
- **Abstraction:** Mạnh. Agents chỉ biết `publish_message(topic, msg)` và subscriptions — không bao giờ thấy sockets.

### 1.3 crewAI — github.com/crewAIInc/crewAI

- **Analog:** `Crew` ⇄ `Task` ⇄ `Agent`.
- **Signal:** Plain Python function return. `task.execute_sync()` return; `Crew.kickoff()` loop tuần tự qua các tasks. Có optional **`task_callback`** fire sau mỗi task; **`step_callback`** fire sau mỗi agent step. Ở mặt HTTP-API, tương đương là `taskWebhookUrl`/`stepWebhookUrl`/`crewWebhookUrl` ([CrewAI docs](https://docs.crewai.com/en/learn/sequential-process), [community thread](https://community.crewai.com/t/how-does-the-task-callback-parameter-work/389)).
- **Lands first:** Cùng Python stack frame (sync) hoặc webhook receiver (API mode).
- **Supervisor delivery:** Loop tiếp tục; callback được gọi.
- **Broker:** Không (in-process). Webhooks là surface duy nhất ra ngoài process.
- **Process model:** Một Python process cho local SDK. Tasks không phải subprocesses.
- **Failure mode:** Exceptions bubble lên; không có built-in replay.
- **Abstraction:** Sync function semantics — đơn giản nhất có thể.

### 1.4 LangGraph (langchain-ai) — multi-agent supervisor pattern

- **Analog:** Supervisor node ⇄ worker nodes trong một state graph.
- **Signal:** Workers return một object **`Command`**. Cụ thể `Command(goto=target, graph=Command.PARENT, update={...})` để chuyển control sang đâu đó; `create_handoff_back_messages()` để quay về supervisor với marker `__is_handoff_back` ([DeepWiki: Handoff Tools](https://deepwiki.com/langchain-ai/langgraph-supervisor-py/3.2-handoff-tools)).
- **Lands first:** LangGraph runtime — diễn giải `Command` rồi transition state graph.
- **Supervisor delivery:** Graph step kế tiếp; prompt của supervisor được rebuild kèm messages bổ sung.
- **Broker:** Chính bản thân graph runtime.
- **Process model:** Một Python process; node executions là các awaited coroutines.
- **Failure mode:** Checkpointer persist graph state; resumable.
- **Abstraction:** Rất sạch — declarative graph, không thấy IPC.

### 1.5 OpenAI Swarm — github.com/openai/swarm

- **Analog:** "Current agent" ⇄ "next agent" thông qua handoff.
- **Signal:** Một tool function return về một `Agent` (hoặc `Result(agent=...)`). Run loop swap sang nó. *"Swarm's `run()` function is analogous to `chat.completions.create()` — it takes `messages` and returns `messages` and saves no state between calls."*
- **Lands first:** Cùng Python stack; loop thấy `Agent` được return rồi tiếp tục với nó.
- **Supervisor delivery:** Function return — synchronous.
- **Broker:** Không. Stateless.
- **Process model:** Một Python process, một linear loop.
- **Failure mode:** Caller tự lo; không có persistence.
- **Abstraction:** Tối giản: một function return ra worker kế tiếp.

### 1.6 Tmux-Orchestrator — github.com/Jedward23/Tmux-Orchestrator

Đây là họ hàng gần cockpit nhất và là cuộc so sánh dạy được nhiều nhất.

- **Analog:** Orchestrator → Project Managers → Engineers, mỗi cái là một tmux window riêng chạy Claude instance của nó.
- **Signal:** **Polled + self-scheduled.** Không có async push nào cả. Một Claude instance tự schedule check-in cho mình bằng `schedule_with_note.sh 30 "Continue dashboard implementation"`. Orchestrator định kỳ đọc nội dung pane qua `tmux capture-pane`.
- **Lands first:** Chính scrollback của pane tmux (text). "Broker" là *cái màn hình*.
- **Supervisor delivery:** Orchestrator poll + đọc + interpret. Để nói ngược lại: `send-claude-message.sh session:window "msg"`, mà cái này `tmux send-keys` text vào pane đích. Đây đúng là tương đương của `cockpit runtime send` — và nó chạy được trên tmux vì tmux **không** enforce process-lineage check cho writer (ai có socket perms cũng có thể `send-keys`).
- **Broker:** Không — tmux vừa là transport vừa là storage.
- **Process model:** Multi-process; mỗi Claude là child của tmux pane của nó.
- **Failure mode:** Mất việc không giới hạn nếu orchestrator không check lại. Pattern self-scheduling là cái phao duy nhất.
- **Abstraction:** Leaky — scripts scrape rồi inject text. Prompt-engineering rules đóng vai trò contract.

**Bài học cho cockpit:** Tmux-Orchestrator chạy được vì authorization model của tmux là "owner of the socket" — không có lineage check. Check nghiêm của cmux mới là cái buộc cockpit phải host sender bên trong cmux's tree. Tmux-Orchestrator còn cho thấy **cooperative-callback pattern** mà Orca sau này formalize.

### 1.7 Claude Squad — github.com/smtg-ai/claude-squad

- **Analog:** N Claude instances độc lập, mỗi cái trong git worktree + tmux session riêng.
- **Signal:** **Không có gì tự động.** Completion được human phát hiện qua TUI (preview/diff tabs, manual `c` checkout / `r` resume).
- **Lands first:** Mắt người dùng.
- **Supervisor delivery:** User.
- **Broker:** Không.
- **Process model:** Multi-process, isolated worktrees.
- **Failure mode:** Human-in-the-loop.
- **Abstraction:** Cố ý *không* phải một orchestrator — nói rõ là để coordination cho con người.

**Bài học:** Một tool multi-Claude được nể trọng đã né hoàn toàn bài toán captain↔crew. Tham vọng của cockpit (captain autonomous react theo crew) khó hơn đáng kể so với cái Claude Squad cố làm.

### 1.8 Orca (stablyai) — github.com/stablyai/orca (đã nghiên cứu rồi)

- **Analog:** Coordinator + per-agent terminal panes (PTY-hosted).
- **Signal:** Hai channel song song, tùy theo agent:
  1. **Native hooks → loopback HTTP** (Claude Code & Codex 0.129+). Hooks `curl` một JSON payload tới `http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/<agent>` kèm bearer token. `Stop` event = turn done. Xem `src/main/codex/hook-service.ts:42-49` và `src/main/agent-hooks/server.ts`.
  2. **Cooperative CLI callback** cho autonomous coordinator: prompt preamble dạy agent gọi `orca task complete --body <summary>`, cộng với 10-min stale-heartbeat watchdog (`src/main/runtime/orchestration/coordinator.ts:172,230,332-335`).
- **Lands first:** Main Electron process của Orca (HTTP server + IPC). Persist trong `last-status.json` để sống sót qua restart.
- **Supervisor delivery:** IPC fanout sang renderer process / orchestration coordinator.
- **Broker:** Loopback HTTP server + on-disk status cache.
- **Process model:** Multi-process; mỗi agent là một `node-pty` child riêng. Orca tự sở hữu broker.
- **Failure mode:** Replay từ `last-status.json`; hook script re-read `$ORCA_AGENT_HOOK_ENDPOINT` nên sống sót qua Orca restart trên *cùng* PTY.
- **Abstraction:** Excellent bên trong Orca; leak ra qua hook config files trong `~/.codex/hooks.json` và `~/.codex/config.toml`.

### 1.9 Codename Goose (Block) — github.com/block/goose

- **Analog:** Một agent + MCP **extensions** (tool servers).
- **Signal:** Standard MCP — JSON-RPC over stdio/SSE/streamable HTTP. *Không phải multi-agent coordinator.* Không có inter-extension event bus; extensions là tool providers, không phải peer agents.
- **Lands first:** MCP client transport.
- **Process model:** Goose host + một subprocess cho mỗi stdio extension.
- **Bài học cho cockpit:** MCP là protocol *tool-call*, không phải protocol peer-to-peer notification. Mô hình hoá crew→captain thành một MCP tool call sẽ đảo chiều đúng (captain pull, không bao giờ được push).

### 1.10 Codex CLI app-server (OpenAI) — xem `docs/research/2026-05-19-orca-codex-wrapping-study.md`

- **Analog:** Driver process ⇄ codex child qua JSON-RPC over stdio.
- **Signal:** Notifications trong JSON-RPC stream (`turn.completed`, v.v.), framed dưới dạng newline-delimited JSON.
- **Lands first:** Driver's stdio reader.
- **Broker:** Không — stdio trực tiếp.
- **Process model:** Parent sở hữu child qua pipe.
- **Bài học:** Channel typed-event mạnh **nhưng chỉ giữa parent và child của chính nó**. Vô dụng nếu captain không phải parent của codex — mà đây đúng là constraint của cockpit (cmux sở hữu codex/claude child, không phải daemon của cockpit).

### 1.11 Background — prior art về process-coordination

| System | One-line lesson |
|---|---|
| **systemd `sd_notify`** | Một datagram dạng UDP gửi tới `$NOTIFY_SOCKET` (Unix DGRAM). `READY=1`, `STATUS=…`, `WATCHDOG=1`. Auth qua `SCM_CREDENTIALS`. Không broker, không queue — fire-and-forget nhưng reliable trên localhost. ([sd_notify man](https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html)) |
| **D-Bus** | Pub/sub trưởng thành: signals broadcast; clients đăng ký interest; bus daemon fan out. Typing mạnh qua introspection. Transport: Unix domain sockets. ([spec](https://dbus.freedesktop.org/doc/dbus-specification.html)) |
| **macOS XPC** | Client/server IPC hiện đại với privilege separation; được khuyến nghị thay cho `NSDistributedNotificationCenter` (cái này không mang được user info). |
| **Erlang/OTP** | Supervisor `monitor` worker process; worker chết → `{'DOWN', Ref, ...}` rơi vào *mailbox* của supervisor (một queue cho mỗi process). Mailbox chính là broker; pattern-match dequeue. Fault-tolerance gold-standard. |
| **OpenTelemetry collector** | Pipeline `receiver → processor → exporter`; receivers là pluggable transports; cùng một data có thể fan out tới N exporters. Đúng nhu cầu "event từ bất kỳ runtime → nhiều sinks (TUI, Telegram, push)" của cockpit. |

---

## 2. Bảng so sánh

| System | Process model | Signal mechanism | Delivery | Reliability | Abstraction | Cockpit-applicable insight |
|---|---|---|---|---|---|---|
| OpenHands | 1 host + sandbox subproc | Typed event trong `EventStream` | Subscriber callback (push) | Disk-replayable | Strong (events) | In-process bus + on-disk log = câu chuyện decoupling tốt nhất |
| AutoGen | 1 proc (hoặc gRPC) | Topic-pub/sub message | Topic subscriber | In-mem (local) / guaranteed (gRPC) | Strong | Topic routing scale tốt cho many-to-many |
| crewAI | 1 proc | Function return + callback | Loop tiếp tục | None | Trivial | Đừng over-engineer nếu bạn nắm cả loop |
| LangGraph | 1 proc | Value `Command(goto=…)` | Graph step | Checkpointed | Declarative | Diễn đạt handoff là data, không phải IPC |
| OpenAI Swarm | 1 proc | Function return `Agent` | Loop tiếp tục | None | Trivial | Stateless transfer là đủ khi in-process |
| Tmux-Orchestrator | Multi-proc (tmux) | Scrape pane + `send-keys` | Poll + injected text | Mất nếu không đọc | Leaky | tmux cho external sender → không cần relay ở đó |
| Claude Squad | Multi-proc (tmux) | Không — human check | Manual | N/A | N/A | Né hoàn toàn |
| Orca | Multi-proc (PTY) | Native hooks → loopback HTTP | HTTP POST + IPC fanout | Disk-cached | Strong | **Hooks-as-source-of-truth + broker chính là pattern thắng** |
| Goose (MCP) | Multi-proc (MCP) | JSON-RPC tool call | Caller await | Per-call | Strong | Sai chiều cho completion notify |
| Codex app-server | Parent + child | JSON-RPC notification | stdio read | Stream lifetime | Strong | Yêu cầu parent-of-child relationship |
| systemd sd_notify | Multi-proc | Unix DGRAM | Daemon recv | Localhost-reliable | Strong | IPC nhỏ gọn nhất khả thi |
| D-Bus | Multi-proc | Signal broadcast | Bus fanout | Bus-mediated | Strong | Pub/sub thực tế ở mức OS |
| Erlang/OTP | Multi-proc (BEAM) | `monitor` + mailbox | Mailbox dequeue | Queued | Gold | Mailbox per supervisor = mental model lý tưởng |
| OTel collector | Pluggable | Pipeline receiver → exporter | Push | Configurable | Strong | Một event, nhiều sinks (TUI/push/file) |

---

## 3. Khuyến nghị cho cockpit (xếp hạng)

Tôi xếp hạng **3 pattern** theo độ phù hợp, xét tới các ràng buộc cứng của cockpit:
1. Multi-runtime (Claude Code, Codex, Gemini, Aider, opencode).
2. Multi-host runtime (cmux hiện tại; Orca, Zed, IntelliJ-MCP trong tương lai).
3. Captain chạy trong một *real shell bên trong pane của runtime* và tiêu thụ input từ chính cơ chế input của runtime đó.
4. cmux enforce process-lineage check: writer ghi vào pane của captain **bắt buộc** phải nằm trong process tree của cmux.

### Hạng 1 — **Mailbox + injector pattern** (lai Erlang + Orca). Khuyến nghị mạnh.

**Mechanism.** Daemon của cockpit là **broker** (tương đương `gen_server` của Erlang). Mỗi captain có một **mailbox**: một queue ở phía daemon, key là captain-id. Mỗi runtime đăng ký đúng **một injector** — một process tí hon sống dai *bên trong process tree của runtime đó* — nhiệm vụ duy nhất là dequeue từ mailbox của captain và gọi API "type into pane" riêng của runtime. Injector chính là analog cockpit-side của **`notify-relay` tab bạn đã có**, nhưng được tổng quát hoá và được "phong tước" thành một first-class architectural element thay vì "một terminal tab thừa".

**Tại sao đây là cách rebrand đúng cho cái bạn đã xây.**
- Relay-tab không phải workaround — nó chính là pattern Erlang dùng (per-process mailbox cần một per-process dequeuer chạy *bên trong* scheduler của process đó). Lineage check của cmux tương đương với BEAM scheduler boundary: chỉ context đúng mới deliver được. Bạn đúng khi đặt một process bên trong cmux; bạn sai khi cảm thấy ngại về điều đó.
- Mailbox semantics fix luôn cái failure mode mà thiết kế hiện tại *không* xử lý tốt: nếu captain đang giữa turn, đang shutdown, hoặc tạm vắng một lúc, events sẽ queue lại thay vì bay mất. (Hiện tại relay tab forward ngay; nếu captain pane đang bận, cmux send có thể nuốt input.)
- Một injector cho mỗi runtime, không phải mỗi captain: một daemon process `cockpit-injector` duy nhất cho mỗi cmux instance có thể phục vụ mọi captain host ở đó.

**Sketch cụ thể thay cho relay-tab.**
- Daemon expose `MailboxAppend(captainId, event)` và `MailboxClaim(captainId, sinceCursor) → events`.
- Runtime driver implement `Injector(runtime, captainId)` — một binary Go/Node/Python nhỏ được `cmux spawn` khởi động làm hidden helper process bên trong workspace của captain. Long-poll `MailboxClaim`, rồi gọi cơ chế send của runtime. Khi khởi động, injector cũng drain backlog đã tích lũy lúc captain idle.
- Captain shutdown thì remove mailbox; restart thì restore từ đĩa (analog của `last-status.json` kiểu Orca).
- Tracker integration: socket pub/sub hiện có của daemon trở thành *receiver* theo từ vựng OTel-collector; mailbox là *processor*; injector là *exporter* duy nhất phải thoả lineage rule của cmux. Telegram, TUI, và push notifications vẫn subscribe trực tiếp vào receiver — chúng không đi qua exporter bị ràng buộc lineage.

**Xử lý lineage check của cmux:** Có — injector được cmux spawn nên theo định nghĩa là sống trong tree của nó. Với Orca/Zed/IntelliJ-MCP, cùng concept injector tái sinh thành: một Orca pane host `cockpit-injector orca`; một Zed task; một IntelliJ background process. Mỗi runtime driver sở hữu injector binary của mình; mailbox protocol thì dùng chung.

**Tradeoff về complexity:** Vừa phải. Bạn đã có hầu hết rồi (daemon socket pub/sub + relay tab). Việc cần làm là (a) thêm queue + cursor phía daemon, (b) tổng quát hoá relay thành một binary `cockpit-injector` mà bất kỳ runtime nào cũng spawn được, (c) ship lifecycle hook "start injector khi mở workspace" cho từng runtime.

### Hạng 2 — **Hooks-into-loopback-broker** (Orca pattern, tổng quát hoá).

**Mechanism.** Mỗi agent CLI được support đều có *kiểu nào đó* completion hook native (Claude Code: `Stop` hook; Codex 0.129+: `Stop` hook; Gemini: vẫn TBD; Aider: chế độ `--message` return; opencode: events). Hook `curl` một loopback HTTP endpoint trên daemon. Daemon giờ có signal "crew X xong" có thẩm quyền *từ chính agent*, không phải từ process-watching hay PTY-scraping.

**Cái này giải bài toán khác** — nó là về **detection**, không phải **delivery**. Bạn vẫn cần pattern #1 (hoặc #3) để *đưa tin vào input của captain*. Nhưng ghép #2 với #1 thì cockpit có vòng lặp hoàn chỉnh:
- Detection: native hook → daemon (đã được Orca validate).
- Delivery: daemon mailbox → in-cmux injector (Hạng 1).

**Xử lý lineage check của cmux:** Không liên quan đối với detection. Delivery vẫn cần Hạng 1.

**Tại sao không xếp #1:** Bạn đã ngầm có detection rồi (cmux `read-screen` + heuristics của bạn). Nỗi đau cấp tính là delivery, không phải detection. Adopt #2 dần khi mỗi runtime có native hook, nhưng nó không thay được #1.

### Hạng 3 — **Captain-side polling vào daemon socket** (option "không làm gì in-cmux").

**Mechanism.** Bỏ luôn relay tab. Dạy captain — qua system prompt / một skill — **định kỳ chạy một CLI command** (`cockpit inbox`) trong loop của chính nó, đọc từ daemon socket và return new events dưới dạng plain text. Captain có shell access; gọi một CLI là hoàn toàn nằm trong toolset của nó.

**Tại sao hấp dẫn.** Zero extra processes. Zero relay. Captain là kẻ duy nhất có quyền input được cmux chúc phúc (nó *chính là* cmux child), nên theo định nghĩa, bất kỳ text nào nó sinh ra cũng rơi đúng chỗ. Bước "delivery" trở thành "captain in ra cái nó đọc được." Cadence polling do captain tự quyết.

**Tại sao là #3, không phải #1.** Nó đổi captain semantics từ *reactive* thành *proactive*. Captain đang giữa turn sẽ không poll. Captain đang kẹt trong một tool call sẽ không thấy crew xong. Mục tiêu của push-notification ban đầu là làm captain thức dậy khi crew hoàn thành; hạng 3 lặng lẽ quay về polling, mà cái này nghiên cứu idle-detection 2026-05-16 đã loại rồi. Chỉ dùng làm fallback cho runtime nào không spawn được injector.

**Xử lý lineage check của cmux:** Trivially — không có external sender.

**Cho Orca/Zed/IntelliJ-MCP:** Chạy được trong cả ba. Đây là universal-fallback path.

---

## 4. Tổng hợp: thiết kế đề xuất

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

Đây là **relay-tab pattern, đổi tên và phong tước**: relay trở thành "injector" first-class với một queue đằng sau. Thêm native-hook detection (Orca pattern, Hạng 2) khi runtime support. Giữ CLI-poll (Hạng 3) làm fallback không-bao-giờ-fail mà captain luôn có thể chạy.

### Cái này mua được gì so với relay-tab hiện tại

- **Buffering** — events không bay mất nếu captain pane bận tạm thời.
- **Restart survival** — mailbox là durable; injector restart sẽ drain backlog.
- **Một concept, mọi runtime** — Orca/Zed/IntelliJ dùng cùng protocol; chỉ injector binary đổi theo runtime.
- **Không thêm IPC primitive mới** — dùng lại daemon socket có sẵn; mailbox chỉ là một map<captainId, []event> trên daemon cộng với một cursor.
- **Tracker vẫn decoupled** — receivers, processors (mailbox), exporters (injector) là shape OTel-collector, biến "gửi cùng event tới Telegram và captain" thành chuyện cấu hình chứ không phải chuyện code.

---

## Provider Coverage Audit — Claude / Codex / Opencode

Pattern relay/notify ở section 3 giả định mỗi runtime provider có thể đẩy cho cockpit một signal "crew finished". Hôm nay claude-code emit signal này qua `Stop` / `SessionEnd` hooks (PR #108) và codex emit qua app-server JSON-RPC notifications (PR #97/#98). Opencode interactive crews hiện vẫn đi theo đường legacy cmux-only spawn (`src/commands/crew.ts:163`) — daemon hoàn toàn không biết chúng tồn tại. Phần audit này trả lời câu hỏi liệu opencode có thể được wire vào cùng notify loop không, và shape của wiring đó nên thế nào.

### Findings — opencode (sst/opencode)

1. **Hook / lifecycle event system — CÓ, qua plugin system.** Opencode ship một plugin framework first-class. Một plugin là một TypeScript module đặt dưới `.opencode/plugin/*.ts` hoặc khai báo qua `opencode.json → plugins`. Plugin nhận một async `event` callback và còn có thể wrap tool execution với `tool.execute.before` / `tool.execute.after`. Event names được tài liệu hoá bao gồm `session.idle` và tool-execution events; bài DEV.to overview và trang SDK đều nhắc đến chúng như extension surface chính ([dev.to "Does OpenCode Support Hooks?"](https://dev.to/einarcesar/does-opencode-support-hooks-a-complete-guide-to-extensibility-k3p), [OpenCode SDK docs](https://opencode.ai/docs/sdk/)). DeepWiki page về session-lifecycle confirm có taxonomy `session_start` / `session_idle` / `session_end` trên event bus nhưng không liệt kê wire names chính xác ([DeepWiki §2.1 session lifecycle](https://deepwiki.com/sst/opencode/2.1-session-lifecycle-and-state)). **Unable to confirm via public docs** liệu `session.end` có phải là một stable plugin-callable event hay chỉ là internal-bus event; assumption an toàn là `session.idle` (cái được tài liệu hoá) là analog "turn done" gần nhất cho mục đích của cockpit.

2. **App-server / streaming protocol — CÓ, nhưng là HTTP REST + SSE, không phải JSON-RPC.** `opencode serve` khởi một headless HTTP server expose một OpenAPI 3.1 spec; flags gồm `--port`, `--hostname`, `--mdns`, `--cors`, và `OPENCODE_SERVER_PASSWORD` cho basic auth ([Server docs](https://opencode.ai/docs/server/)). Hai SSE endpoints stream event bus: `GET /event` (per-session / global bus; message đầu là `server.connected`, rồi đến bus events) và `GET /global/event`. Đây là pattern subscribe sống dai; daemon có thể giữ một HTTP connection mở và nhận mọi bus event suốt vòng đời server.

3. **MCP — opencode là MCP *client*, không phải MCP server expose lifecycle events.** MCP integration của opencode là để *thêm tool vào opencode*, không phải để cho process bên ngoài subscribe vào opencode events ([MCP docs](https://opencode.ai/docs/mcp-servers/)). Bài học từ Goose ở §1.9 áp dụng tại đây: MCP là sai hướng cho completion-notify.

4. **`opencode run --format json` — CÓ.** Subcommand `run` hỗ trợ `--format json`, được tài liệu hoá là "raw JSON events". Kết hợp với `--session <id>` / `--continue` / `--fork`, nó cho ra một headless invocation stream structured events ra stdout — dùng được từ non-cmux wrapper, dù với case cockpit-interactive thì SSE bus là channel tốt hơn vì nó persist qua nhiều turn.

5. **Programmatic SDKs — CÓ.** SDK chính thức `@opencode-ai/sdk` (TypeScript) wrap HTTP + SSE surface vào typed methods bao gồm `event.subscribe()` ([JS SDK DeepWiki](https://deepwiki.com/sst/opencode/7.1-javascripttypescript-sdk)). Community-maintained Go (`opencode-sdk-go`) và Python (`opencode-sdk-python`) SDKs được generate từ cùng OpenAPI spec. Một điểm đáng note: opencode còn implement **Agent Client Protocol (ACP) qua JSON-RPC** cho editor integrations (Zed và bạn bè), expose events như `permission.asked` và `usage_update` ([DeepWiki ACP](https://deepwiki.com/sst/opencode/7.4-agent-client-protocol-(acp))); ACP là event surface *thứ hai* song song với HTTP/SSE bus, dùng khi phía IDE cần là loop driver của agent.

6. **Resume semantics — CÓ.** Cả `opencode run` lẫn TUI đều nhận `--continue` (`-c`), `--session <id>` (`-s`), và `--fork`. Sessions được persist (SQLite qua Drizzle ORM theo lifecycle page); reattach sau khi daemon bounce là support được, với daemon recover session-id từ state của chính nó chứ không phải từ opencode.

### Bảng so sánh

| Capability | Claude | Codex | Opencode | Notes |
|---|---|---|---|---|
| Hook system (lifecycle events file-configurable) | CÓ — `settings.json` Stop / SubagentStop / SessionEnd | KHÔNG có native; Orca chứng minh Codex 0.129+ có `Stop` hooks nhưng cockpit chưa dùng | CÓ — TS plugin trong `.opencode/plugin/*.ts`; `event` callback + tool before/after; `session.idle` documented | Opencode plugin là code chứ không phải pure JSON, nên khó template hơn `settings.json` của Claude nhưng expressive hơn |
| App-server / streaming protocol | KHÔNG (stdio CLI only) | CÓ — app-server, JSON-RPC qua stdio | CÓ — `opencode serve` HTTP + SSE; ACP JSON-RPC cũng có sẵn | Opencode là cái duy nhất có *socket-listening* server ngay từ đầu |
| MCP server interface (expose events) | Claude chỉ là MCP client | Codex chỉ là MCP client | Opencode chỉ là MCP client | Không cái nào cho cockpit subscribe qua MCP |
| JSON output mode (headless) | CÓ — `claude -p --output-format=json` | CÓ — `codex exec --json` | CÓ — `opencode run --format json` | Cả ba dùng được cho one-shot non-interactive crews |
| Session resume | CÓ — `claude -c` / `--resume` | CÓ — `codex exec resume` | CÓ — `opencode run --session <id>` / `--continue` / `--fork` | Cả ba đều persist session |
| Programmatic SDK | CÓ — `@anthropic-ai/claude-code` TS SDK | CLI only (chưa có first-party SDK tính đến 0.130) | CÓ — `@opencode-ai/sdk` TS (chính thức); Go & Python (community, generated) | Opencode có story SDK phong phú nhất |

### Verdict — pattern relay/notify có chạy được cho opencode không?

**Best path: SSE subscribe + một plugin emitter nhẹ.** Opencode là cái *dễ wire* nhất trong ba provider để gắn vào daemon. Daemon có thể connect một lần tới `http://127.0.0.1:<port>/event` cho mỗi `opencode serve` đang chạy và nhận `session.idle` cùng các bus events khác với zero per-crew configuration. Cấu trúc này identical với codex app-server path (long-lived stream, daemon subscribe), khác duy nhất ở transport (HTTP+SSE vs. JSON-RPC-over-stdio). Để làm semantic "turn-done" thành explicit (thay vì infer từ `session.idle`), cockpit có thể ship một plugin nhỏ `.opencode/plugin/cockpit-emit.ts` gọi ngược về daemon's `task.progress` endpoint trên hook lifecycle nào ổn định nhất — đây là *đúng cùng* shape với claude-code hook trong PR #108, chỉ là express dưới dạng plugin thay vì entry trong `settings.json`. Net: opencode support **cả hai** pattern trước đó cùng lúc, với SSE path đòi hỏi zero crew-side config.

**Fallback: app-server-style SSE riêng.** Nếu plugin emitter chứng tỏ brittle (ví dụ opencode plugin API đổi giữa các bản 0.x — khá khả thi vì velocity của project), daemon có thể dựa thuần vào documented SSE bus. `session.idle` là canonical signal "agent finished its turn" theo public docs và đủ cho use case captain-attention. Đây strictly là codex pattern, port qua.

**Universal fallback: explicit `cockpit crew signal done`.** Crew template luôn có thể bao gồm chỉ thị gọi `cockpit crew signal done` như action cuối của mọi task — provider-agnostic, hôm nay đã chạy được cho opencode mà không cần wiring mới nào, đổi lại phải dựa vào việc agent nhớ gọi. Cái này nên giữ lại trong opencode crew template như belt-and-suspenders fallback ngay cả sau khi auto-detection ship, mirror đường explicit-signal đã tồn tại cho claude.

**Ranked by honest-fit-for-opencode:** (1) SSE subscribe với `session.idle` làm trigger — ít moving parts nhất, chỉ dùng documented public APIs, mirror codex pattern. (2) Plugin emitter gọi `task.progress` — semantic chính xác nhất, nhưng buộc cockpit vào plugin API surface của opencode. (3) Explicit `cockpit crew signal done` — fallback luôn-chạy, giữ trong template. **Recommendation: ship (1) trước, thêm (2) nếu `session.idle` quá noisy hoặc không đủ chính xác, giữ (3) trong template luôn.**

**Recommendation kiến trúc ở section 3 có còn đứng vững khi xét cả ba provider?** **Có, không có gì để bàn cãi.** Verdict "dignify cái relay thành first-class injector với daemon-side mailbox" *được củng cố* khi opencode bước vào bức tranh. Hôm nay daemon nhận ba shape completion signal khác nhau hoàn toàn: file-configured hooks (claude), parent-of-child JSON-RPC (codex), và long-lived HTTP+SSE (opencode). Design mailbox-plus-injector là cái duy nhất trong ba rank ở section 3 hấp thụ được cả ba transport một cách sạch sẽ: driver của mỗi runtime dịch event surface native của nó thành `MailboxAppend(captainId, event)`, còn in-cmux injector vẫn là exporter duy nhất được lineage-blessed. Không có abstraction mailbox, cockpit sẽ phải có ba đường song song từ detection-source thẳng tới cmux send, mỗi đường replicate riêng buffering, retry, và lineage handling. Audit này confirm detection là phần dễ với cả ba provider; delivery vào captain pane bị restrict bởi process-lineage vẫn là phần khó, và mailbox per-captain là cách factor đúng cho responsibility đó.

---

## 5. Nguồn không truy cập được / chỉ truy cập được một phần

- `github.com/All-Hands-AI/OpenHands/blob/main/openhands/events/stream.py` — 404 liên tục qua WebFetch (có khả năng đã đổi tên hoặc dời chỗ trong main hiện tại). Bù lại bằng DeepWiki + PR #2709 *Refactoring: event stream based agent history* + cấu trúc README của OpenHands.
- `github.com/crewAIInc/crewAI/blob/main/src/crewai/task.py` và `crew.py` — 404 qua WebFetch (path layout đã đổi; có khả năng nằm dưới `src/crewai/lib/`). Bù bằng docs chính thức của crewAI + community threads tài liệu hoá semantics `task_callback`/`step_callback`.
- `langchain-ai.github.io/langgraph/concepts/multi_agent/` — redirect về trang trống; dùng DeepWiki và bài focused.io thay thế.
- `freedesktop.org/sd_notify` — 403 ở URL canonical; dùng Baeldung + gist + systemd docs chung.
- Goose source — README ở mức cao; chưa đọc sâu `crates/`. Chỉ confirm rằng Goose không có peer-agent event bus (MCP là tool-call, không phải pub/sub).
- Aider — confirm không có multi-session model built-in. Bỏ qua bước đào sâu source.

Không còn hệ thống nào khác trong request list bị inaccessible.

---

## 6. Tài liệu tham khảo

- OpenHands — [README](https://github.com/All-Hands-AI/OpenHands), [DeepWiki Agent System](https://deepwiki.com/OpenHands/OpenHands/6-configuration-system), [EmergentMind summary](https://www.emergentmind.com/topics/openhands-agent-framework), PR #2709
- AutoGen — [microsoft/autogen](https://github.com/microsoft/autogen), `python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat.py`
- crewAI — [docs.crewai.com sequential process](https://docs.crewai.com/en/learn/sequential-process), [task_callback thread](https://community.crewai.com/t/how-does-the-task-callback-parameter-work/389)
- LangGraph — [DeepWiki handoff tools](https://deepwiki.com/langchain-ai/langgraph-supervisor-py/3.2-handoff-tools), [focused.io article](https://focused.io/lab/multi-agent-orchestration-in-langgraph-supervisor-vs-swarm-tradeoffs-and-architecture)
- OpenAI Swarm — [openai/swarm](https://github.com/openai/swarm)
- Tmux-Orchestrator — [Jedward23/Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator) (`send-claude-message.sh`, `schedule_with_note.sh`)
- Claude Squad — [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)
- Orca — [stablyai/orca](https://github.com/stablyai/orca); xem `docs/research/2026-05-19-orca-codex-wrapping-study.md` (`src/main/codex/hook-service.ts`, `src/main/agent-hooks/server.ts`, `src/main/runtime/orchestration/coordinator.ts`)
- Goose — [block/goose](https://github.com/block/goose), [DeepWiki extension types](https://deepwiki.com/block/goose/5.3-extension-types-and-configuration)
- Codex CLI — internal study `docs/research/2026-05-19-orca-codex-wrapping-study.md`
- systemd `sd_notify` — [Baeldung](https://www.baeldung.com/linux/systemd-notify), [systemd Type=notify gist](https://gist.github.com/grawity/6e5980981dccf66f554bbebb8cd169fc)
- D-Bus — [Wikipedia](https://en.wikipedia.org/wiki/D-Bus), [spec](https://dbus.freedesktop.org/doc/dbus-specification.html)
- macOS XPC — [NSHipster IPC](https://nshipster.com/inter-process-communication/), [Karol Mazurek XPC](https://karol-mazurek.medium.com/xpc-programming-on-macos-7e1918573f6d)
- Erlang/OTP — [Erlang System Documentation](https://www.erlang.org/doc/system/design_principles.html), [Hamler OTP behaviours](https://www.emqx.com/en/blog/hamler-0-2-otp-behaviours-with-type-classes)
- OpenTelemetry collector — [Architecture docs](https://opentelemetry.io/docs/collector/architecture/)
- Nghiên cứu cockpit trước — `docs/research/2026-05-16-idle-detection-and-inter-agent-orchestration.md`, `docs/research/2026-05-19-orca-codex-wrapping-study.md`, `docs/research/2026-05-19-cockpit-vs-orca-system-comparison.html`
