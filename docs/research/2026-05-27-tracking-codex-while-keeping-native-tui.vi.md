# Tracking Codex Mà Vẫn Giữ Native TUI — Cockpit Có Thể Có Cả Hai Không?

**Date:** 2026-05-27
**Tác giả:** Cockpit research (parent: develop)
**Câu hỏi:** PR #98 của cockpit chọn `codex app-server` (JSON-RPC có cấu trúc, cockpit tự render UI) thay vì wrap native `codex` TUI trong tmux pane (UI đẹp nhưng state extraction mong manh). User push back: *"Orca, Zed IDE, và notchi đều track được codex mà vẫn giữ native TUI — sao cockpit lại không?"*. Có một option thứ ba không?

---

## 0. Trilemma, phát biểu lại

Ba thuộc tính muốn có ở một codex integration:

1. **Full native `codex` TUI** hiển thị cho user (không cần một UI hạng hai phải cạnh tranh với nó).
2. **Structured activity tracking** mà daemon subscribe được (turn-started, turn-completed, awaiting-input, v.v.).
3. **Reliable across process churn** — daemon bounces, reattach, anti-#2576 (false "done"), gate primitive.

PR #98 chọn (2) + (3), bỏ (1). Issue #102 nhân đôi nỗ lực cho (1) bằng cách tự build TUI trên events của (2)+(3). User push-back: *notchi có cả ba, sao cockpit không?*

Câu trả lời: **cả ba reference systems đều làm được, nhưng mỗi cái trả một giá khác nhau — và mức giá lệch nhau cả một bậc.** Cockpit gần như chắc chắn có thể có cả ba, nhưng việc chọn *side-channel nào* mới là quyết định load-bearing, và đó không phải kênh notchi chọn.

---

## 1. notchi — mechanism thực sự là gì?

**Repo:** [`github.com/sk-ruban/notchi`](https://github.com/sk-ruban/notchi) · 894 stars · Swift macOS app · default branch `main` tại thời điểm audit (2026-05-27).

### 1.1 README tự tóm tắt

README phát biểu architecture trong một dòng:

> `Claude Code / Codex --> Hooks (shell scripts) --> Unix Socket --> Event Parser --> State Machine --> Animated Sprites`

Và:

> *"Notchi registers shell script hooks with Claude Code and Codex on launch. When either agent emits events (tool use, thinking, prompts, permission requests, compaction, session start/end), the hook script sends JSON payloads to a Unix socket."*

Tức là **notchi không parse rendered TUI**. Không snapshot terminal, không OSC-sniff, không parse stdout. Nó tap vào **first-class native hooks system của codex** — đúng kênh Orca dùng — rồi pipe các JSON event sang một Unix socket cục bộ.

### 1.2 Install path thực tế (`CodexHookInstaller.swift`)

`notchi/notchi/Services/CodexHookInstaller.swift` ghi ba thứ vào `~/.codex/`:

1. **Hook script** tại `~/.codex/hooks/notchi-codex-hook.sh` (mode `0o755`):
   ```swift
   // CodexHookInstaller.swift:43-62
   let bundled = Bundle.main.url(forResource: "notchi-codex-hook", withExtension: "sh")
   try bundledData.write(to: hookScriptURL, options: .atomic)
   try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hookScriptURL.path)
   ```

2. **`~/.codex/hooks.json`** với ba event registrations (`upsertHooksJSON`, dòng 69–95):
   ```swift
   let desiredHookEvents: [String: [[String: Any]]] = [
     "SessionStart":     [makeHookGroup(matcher: "startup|resume", command: command)],
     "UserPromptSubmit": [makeHookGroup(matcher: nil,              command: command)],
     "Stop":             [makeHookGroup(matcher: nil,              command: command, timeout: 30)],
   ]
   ```

3. **`~/.codex/config.toml`** với `codex_hooks = true` dưới `[features]` (`upsertFeatureFlag`, 118–145).

Notchi chỉ register **ba** trong số mười hook event của codex (`SessionStart`, `UserPromptSubmit`, `Stop`). Không cần `PreToolUse`/`PostToolUse`/`PermissionRequest`/… — UI chỉ cần idle/working/waiting transitions, ba là đủ.

### 1.3 Hook payload path (`notchi-codex-hook.sh`)

Script đã cài là một chương trình bash + inline Python. Các dòng quan trọng:

```bash
SOCKET_PATH="/tmp/notchi.sock"
[ -S "$SOCKET_PATH" ] || exit 0       # silent no-op nếu app không chạy
/usr/bin/python3 -c "
  input_data = json.load(sys.stdin)   # codex pipe hook JSON vào stdin
  ...
  output = { 'provider':'codex', 'session_id':..., 'event':hook_event,
             'status':status_map.get(hook_event,...), ... }
  sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
  sock.connect('$SOCKET_PATH'); sock.sendall(json.dumps(output).encode())
"
```

Nó cũng walk process-tree (`codex_process_context`) để gán event cho một PID `codex` cụ thể, và đánh dấu origin là `cli` (có tty) hay `desktop` (không tty).

### 1.4 Receiver (`SocketServer.swift`)

Listener Swift `AF_UNIX/SOCK_STREAM` tại `/tmp/notchi.sock`, `chmod 0600`, accept mỗi hook fire, decode `AgentHookEnvelope`, normalize qua `CodexProviderAdapter.normalize`, feed state machine. Envelope schema (`HookEvent.swift:876-933`) là superset đầy đủ (`tool`, `tool_input`, `permission_mode`, `transcript_path`, `codex_origin`, …) — parser của notchi sẵn sàng cho cả những event chưa register.

### 1.5 Reliability / latency story

- **Latency:** sub-millisecond local Unix socket; bash wrapper thêm ~30ms Python startup mỗi fire. Với idle/working transitions thì invisible.
- **Reliability:** hook script `exit 0` âm thầm nếu không có socket (`[ -S "$SOCKET_PATH" ] || exit 0`) — codex không bao giờ thấy hook failing, session của user không bao giờ bị ảnh hưởng bởi việc notchi đóng. `timeout: 30` trên `Stop` là per-hook timeout của codex để notchi treo cũng không stall codex.
- **Restart survival:** hook là filesystem state, không phải process state. Hook fire đúng dù notchi vừa restart hay chưa start bao giờ — như loopback HTTP của Orca.
- **TUI compatibility:** *codex chạy như plain interactive TUI*. Hook hoàn toàn out-of-band. Không đụng gì tới rendering, prompt composer, terminal của codex.

### 1.6 Net characterization

**notchi track codex bằng cách install entries vào `~/.codex/hooks.json` fire shell scripts forward JSON payload sang Unix socket. Không parse TUI gì cả.** Nó là một Orca strictly-better: cùng mechanism (codex native hooks), transport đơn giản hơn (Unix socket vs loopback HTTP + bearer), event set hẹp hơn (3 vs 6).

Đây là **đúng kênh** mà PR #98 có sẵn và đã không dùng. notchi không giải bài toán khác bằng mánh khác — nó dùng một kênh cockpit hiện chưa dùng.

---

## 2. Orca, xem lại

Prior research của cockpit ở [`docs/research/2026-05-19-orca-codex-wrapping-study.md`](2026-05-19-orca-codex-wrapping-study.md) kết luận rằng Orca approach bị reject vì state extraction *"fragile"*. **Kết luận đó cần xem lại trước evidence của notchi.**

Đọc lại Orca study so với source code:

- **Orca không screen-scrape state.** §2.2 của prior research: *"Orca does not infer turn state from PTY output. It installs managed entries into codex's own hooks system and listens for the events."* Mechanism là `src/main/codex/hook-service.ts:42-49` register 6 hook events, rồi `curl` sang loopback HTTP server.
- **Orca chỉ screen-scrape cho hai chuyện trivial:** (a) paste-timing và (b) một `/status` fallback mà chính nó cũng không tin (*"app-server can fail independently of the interactive CLI"*, `codex-fetcher.ts:440`).

**Verdict "fragile" trong study 2026-05-19 là về *driving codex qua TUI* (gõ vào, đọc ra). Path *tracking* mà Orca thực sự dùng là hook system — JSON có cấu trúc, robust ngang app-server's events.**

Đây là một category error trong cockpit research trước: write-up cũ trộn lẫn "wrap TUI" (fragile vì bidirectional terminal IO) với "track codex trong khi hiển thị TUI của nó" (không fragile, kênh là JSON hooks, không phải TUI). Cả Orca và notchi đều làm cái sau. Không cái nào làm cái trước.

---

## 3. Zed — một mechanism thứ ba hoàn toàn

Zed integrate codex qua [`github.com/zed-industries/codex-acp`](https://github.com/zed-industries/codex-acp). README nói: *"This tool implements an ACP adapter around the Codex CLI"*. Nhưng "wraps the Codex CLI" hóa ra là dùng từ sai — `codex-acp/Cargo.toml`:

```toml
codex-core        = { git = "https://github.com/openai/codex", tag = "rust-v0.133.0" }
codex-mcp-server  = { git = "https://github.com/openai/codex", tag = "rust-v0.133.0" }
codex-exec-server = { git = "https://github.com/openai/codex", tag = "rust-v0.133.0" }
```

Và từ `src/codex_agent.rs`:

```rust
use codex_core::{ ThreadManager, RolloutRecorder, config::Config, ... };
let thread_manager = ThreadManager::new(&config, auth_manager.clone(), ...);
let history = RolloutRecorder::get_rollout_history(&rollout_path).await...;
```

**Zed không spawn `codex` như subprocess.** Nó static-link `codex-core` như một Rust library inside `codex-acp` binary và chạy agent loop in-process. Zed render **UI của chính nó**, không phải codex TUI. Native codex TUI bị *thay thế*, không phải augmented.

Vậy Zed **không phải example của "native TUI + tracking"**; nó là example của "không có codex process, codex-core embedded as library, không TUI". Đây là một option thứ tư chỉ dành cho project chấp nhận hard build dependency vào `codex-core` (Rust, pinned version, vỡ mỗi lần upstream refactor). Với cockpit — Node/TypeScript daemon support Codex + Claude + Opencode + Aider — đây là non-starter. Nêu ra chỉ để loại nó khỏi sân chơi.

---

## 4. Bản thân codex expose những gì?

Đây là câu trả lời load-bearing. Có đúng bốn side-channel của codex state không yêu cầu parse TUI:

### 4.1 Hooks (kênh notchi + Orca dùng)

**Source:** `codex-rs/hooks/src/lib.rs`:

```rust
pub const HOOK_EVENT_NAMES: [&str; 10] = [
    "PreToolUse", "PermissionRequest", "PostToolUse",
    "PreCompact",  "PostCompact",
    "SessionStart", "UserPromptSubmit",
    "SubagentStart", "SubagentStop", "Stop",
];
```

**Registration:** `~/.codex/hooks.json`. Codex pipe JSON payload vào stdin của command; stderr/exit được observe.

**TUI vs exec:** Hooks crate được invoke từ session layer (`codex-rs/core/src/session/mod.rs` expose `hooks()` trên session, tạo giống hệt nhau cho TUI và exec). Bằng chứng cụ thể TUI đi qua nó: `codex-rs/tui/src/hooks_rpc.rs` và `codex-rs/tui/src/chatwidget/hooks.rs`. notchi và Orca cả hai chạy codex như interactive TUI thường và dựa vào hooks fire — empirically proven in production.

**Codex 0.129+ caveat:** codex âm thầm drop hooks không có matching `trusted_hash` trong `config.toml`. Cả notchi (`upsertFeatureFlag`) và Orca (`config-toml-trust.ts`) đều handle. Bất kỳ cockpit integration nào cũng phải.

**Kết luận:** **Đây là kênh.** Structured JSON, fire trong TUI mode, decoupled khỏi rendering, có timeout explicit, fail open, và là cái mọi tracker khác trong wild đều dùng.

### 4.2 Rollout JSONL (kênh Zed đọc after-the-fact)

**Source:** `RolloutRecorder` trong `codex-rs/core/src/rollout/`.

**Path:** `~/.codex/sessions/YYYY/MM/DD/rollout-{ISO_TIMESTAMP}-{UUID}.jsonl`. Verified live trên máy này:

```
~/.codex/sessions/2026/05/25/rollout-2026-05-25T10-35-03-019e5d33-...jsonl
```

**Format:** `RolloutLine` envelopes chứa `ResponseItem` / `EventMsg` / `SessionMeta` / `TurnContext` / `Compacted`. Dòng đầu của một session thật trên máy này:

```json
{"timestamp":"2026-05-25T03:39:05.138Z","type":"session_meta","payload":{
  "originator":"codex-tui",        // ← bằng chứng TUI ghi file này
  "cli_version":"0.133.0", ... }}
```

`originator: "codex-tui"` là evidence trực tiếp rằng rollout file được ghi *bởi TUI* — y hệt như exec, y hệt như app-server.

**Streaming?** DeepWiki: *"asynchronous persistence via a background RolloutWriterTask … near-real-time asynchronous recording."* Tail-style follower (e.g. `chokidar` + `tail -F` trên file mới nhất) sẽ thấy events trong tens of ms.

**Limitations:** Đây là replay data, không phải orchestration. Không có distinct `PermissionRequest` event; rollout thấy final approved/denied decision và tool call kết quả. **Strictly less rich hơn hooks** cho câu "codex đang chờ gì". Phù hợp làm secondary signal nhưng không phải primary tracker.

### 4.3 `codex app-server` JSON-RPC (kênh hiện tại của cockpit)

Cái PR #97/#98 ship. Full structured event surface, nhưng **yêu cầu chạy codex qua `codex app-server` chứ không phải interactive TUI**. TUI binary và app-server binary là *hai runtime mode khác nhau của cùng executable*; không thể có cả hai cho cùng session.

Đây là cost không tránh được của PR #98: chọn app-server nghĩa là *không có* native TUI để hiển thị, vì codex process đang chạy không ở TUI mode.

### 4.4 OSC titles / stdout / pty scraping

Cái PR #98 reject. Cả Orca và notchi *cũng* reject (trừ exception paste-timing của Orca). Không prior art nào dùng cho state tracking. Confirm lại reasoning của PR #98: đây là path fragile, nên tiếp tục tránh.

---

## 5. Synthesis — cockpit có thể có native codex TUI + structured tracking không?

### 5.1 Yes Path — "passthrough TUI + hook tap"

**Có.** Mechanism là *cái notchi dùng*, port sang daemon của cockpit. Cụ thể:

1. **Spawn codex như plain interactive TUI trong cmux pane**, đúng như Orca làm. User nhìn thấy real codex TUI và gõ trực tiếp. Bridge crew-attach renderer biến mất — không có gì để render, user đang nhìn chính codex.
2. **Lúc daemon startup, install (hoặc upgrade) entries trong `~/.codex/hooks.json`** trỏ tới một shim `cockpit-codex-hook` nhỏ. Shim bundle với cockpit, ghi một lần lúc boot, mode 0755, đọc JSON từ stdin như shim của notchi.
3. **Shim forward mỗi event sang Unix socket của cockpit daemon** (`~/.config/cockpit/cockpit.sock`) — cùng socket daemon đã dùng. Thêm frame type mới `hook-event` vào protocol.
4. **State machine sẵn có của daemon** consume các event này y hệt cách đang consume `app-server` notifications. `normalizeAppServerNotification` trong `src/control/codex/` trở thành một trong hai normalizer; `normalizeHookEvent` mới cover TUI path. Cả hai produce cùng shape `ControlEvent` — anti-#2576 invariant không đổi.
5. **Handle codex 0.129+ trust:** ghi matching `trusted_hash` + `codex_hooks = true` vào `~/.codex/config.toml` như notchi và Orca.
6. **Reattach across daemon bounce:** trivially better hơn app-server path. Codex *process* là cmux pane, owned bởi cmux, không phải daemon. Daemon restart không kill codex; hook shim re-resolve socket mỗi fire (là filename, không phải fd) và bắt đầu hit daemon mới ngay lập tức. Không có gì để "reattach" — tap là stateless.
7. **Gate primitive:** `PermissionRequest` hook fire. Shim forward. Daemon promote thành Gate như hiện tại. Resolution: human trả lời trong TUI trực tiếp (như Orca) và `PostToolUse`/`Stop` hook đóng gate. Hoặc nếu cockpit muốn programmatic answers, vẫn có gate-resolve verb, nhưng với một protocol gap nhỏ (không *force* được approval choice vào TUI mà không gõ vào nó — chính là cái fragile).

**Migration delta từ PR #98:**

| Component | Hôm nay (app-server) | Yes path (TUI + hooks) |
|---|---|---|
| codex spawn | `codex app-server` long-lived child do daemon own | `codex` trần trong cmux pane, do cmux own, daemon không own |
| Tracking channel | JSON-RPC qua stdio | hook shim → Unix socket |
| `crew-attach` UI | bordered renderer với chalk/Ink (theo #102) | không có gì — user thấy native TUI |
| Reattach | daemon → `thread/resume` sau bounce | không có gì — codex process sống qua daemon bounce |
| Initiator | daemon issue `turn/start` | user gõ vào TUI trực tiếp |
| `cockpit say` | daemon RPC vào cùng child | `cmux send` gõ vào pane (process-tree của cmux apply — xem notify-relay) |
| Gate primitive | first-class qua `ToolRequestUserInput` | observe qua `PermissionRequest` hook; không inject được answer trừ qua cmux send |

**Trade-off:** cockpit mất *programmatic* control của conversation (không `turn/start` qua RPC; phải gõ vào TUI qua cmux send). Đây chính là trade-off Orca lấy explicitly và gọi là acceptable.

### 5.2 No Path — điều gì sẽ giết idea này

Những thứ sẽ buộc cockpit ở lại với app-server:

- **Programmatic dispatch.** Nếu flow captain-spawns-crew yêu cầu *daemon* gửi initial prompt cho codex không cần human gõ, đó là territory của app-server. (Counter: cmux send works.)
- **Cross-restart conversation resume sống sót việc codex process chết.** Với hook approach, nếu codex tự crash, conversation mất (không `thread/resume` equivalent). Với app-server, daemon-owned codex relaunch được và `thread/resume`.
- **Programmatic approval answering.** Nếu cockpit muốn captain auto-approve một số class tool calls, app-server `ToolRequestUserInput` round-trip là cách duy nhất; hooks observe nhưng không decide.

Không cái nào *fatal*. Đều là capability deltas thật. PR #98 thật sự ambitious hơn notchi/Orca ở (5.1.5) và (5.1.7); câu hỏi là có đáng với UI cost không.

### 5.3 Hybrid Path — TUI để display, hooks VÀ app-server để tracking

Codex 0.133 support `codex app-server` và TUI như hai process *riêng biệt*. Không cấm chạy cả hai:

- Một **interactive TUI codex** trong cmux pane, để display + human input, có hooks tap.
- Một **app-server codex riêng** cho task *programmatic* (captain spawn headless crew, programmatic approvals, anti-#2576 strict event semantics).

Đây thực chất là design cockpit-today chia theo use case:
- *Interactive crew* (human gõ): TUI + hooks. Không bridge renderer. Issue #102 đóng bằng cách xóa.
- *Headless crew* (captain spawn codex với prompt, lấy result): app-server, như PR #98 hôm nay.

Split đi theo line scope PR #98 đã vẽ: PR #98 close "interactive-codex slice" của #86; "headless slice" để follow-up. Hybrid path là **dừng cố interactively-render qua app-server** (cái issue #102 framing) và chấp nhận rằng interactive == TUI + hooks, headless == app-server.

Cost: hai normalizer, hai integration test, hai version-skew matrix. Benefit: mỗi use case dùng đúng kênh phù hợp nhất.

---

## 6. Ranking và recommendation

| Path | Native TUI? | Structured tracking? | Daemon-bounce survival? | Programmatic dispatch? | Prior art? | Eng cost từ hôm nay |
|---|---|---|---|---|---|---|
| **Ở lại PR #98 + ship #102** | Không (cockpit render) | Có | Có | Có | Cockpit (một mình) | ~4-6h cho renderer #102 |
| **Yes path (TUI + hooks only)** | Có | Có (less rich hơn app-server) | Có (codex process không do daemon own) | Không (phải gõ qua cmux) | notchi, Orca | ~1-2 ngày, xóa hẳn #102 |
| **Hybrid (TUI+hooks cho interactive, app-server cho headless)** | Có (interactive) | Có (cả hai surface) | Có | Có (headless only) | Không — novel | ~2-3 ngày, xóa #102, thêm normalizer thứ 2 |
| Zed-style codex-core embed | Không | Có | n/a | Có | Zed | Tuần; sai ngôn ngữ; reject. |

**Recommendation: Hybrid Path.**

Reasoning, opinionated:

1. **Issue #102 nên đóng wontfix.** Build một codex TUI giả trên app-server events đúng là việc phần còn lại của ecosystem (notchi, Orca, Zed) đã quyết định không làm. Cockpit sẽ tốn renderer effort hàng năm và vẫn xấu hơn real codex TUI cách một `brew install codex`. Năng lượng phí.

2. **"Fragility" argument từ Orca research 2026-05-19 là misdiagnosed.** Đúng về TUI-as-driver. Sai về TUI-with-hook-side-channel. notchi chứng minh hook channel là production-stable ở scale (app 894-star ship cho hàng ngàn macOS notch users). Kết luận justify UI cost của PR #98 là over-broad.

3. **App-server foundation của PR #98 vẫn đúng cho headless.** Anti-#2576, daemon-bounce reattach qua `thread/resume`, programmatic gates — đây là capabilities thật mà hook channel không có, và quan trọng cho captain→crew dispatch. Đừng tear PR #98 ra; demote nó thành nửa-headless của split.

4. **Interactive trở thành thin shim.** `cockpit crew chat --provider codex` spawn codex TUI pane, install hooks lần đầu chạy, daemon listen. Không bridge renderer. Không #102. Không tranh với UI của codex. Pane *là* UI.

5. **Một real-world test trước khi commit:** prove hook latency + reliability story trên Unix socket của cockpit daemon với 30-phút interactive codex session under load (file edits, approvals, compaction). Nếu hook fire drop hoặc đến out-of-order under stress, Yes/Hybrid path thất bại và giữ PR #98. Cả notchi và Orca chạy config này in production, prior strongly in favor.

### 6.1 Có flip plan #102 không?

**Có — provided hook-channel reliability test pass.** Issue #102 tồn tại vì architecture của PR #98 buộc cockpit phải tự render codex. Hybrid Path xóa nhu cầu đó cho interactive case, là case duy nhất #102 quan tâm. #102 nên re-scope thành *"investigate TUI-passthrough + hook tap; nếu feasible, close #102 wontfix và file hybrid integration spec instead."*

### 6.2 Có flip decision PR #98 không?

**Không — PR #98 vẫn merged và shipping.** Hybrid Path giữ app-server cho headless, là chỗ nó irreplaceable. Flip là ở issue #102 (renderer parity goal), không phải PR #98 (app-server foundation). Orca research 2026-05-19 directionally đúng về app-server là answer cho *một trong hai* use case; chỉ framing nó như answer cho *cả hai*.

---

## 7. Open questions / next actions

1. **Spike: hook latency under load.** Viết shim cockpit-codex-hook 100-line, install vào `~/.codex/hooks.json` chống lại codex 0.133 cục bộ, chạy session thật, đo SessionStart→Stop event lag trên daemon socket. Target: p99 < 100ms.
2. **Verify hooks fire trong TUI với cmux `claude -c` resume semantics.** Codex 0.130 thêm thread-resume trong TUI; confirm hooks vẫn fire qua `codex --continue`/`codex resume`. notchi `SessionStart` matcher là `"startup|resume"` nên presumably handled, nhưng nên test.
3. **`config.toml` trust-hash automation.** Lift `upsertFeatureFlag` của notchi + `config-toml-trust.ts` của Orca vào first-run installer của cockpit; ngược lại hooks âm thầm drop trên 0.129+.
4. **Quyết định captain→crew dispatch story cho interactive case.** Hai option: (a) captain gõ prompt vào codex TUI pane qua cmux send (notify-relay pattern, đã built); (b) crew luôn được spawn bởi human gõ trong captain pane. (a) operationally giống captain→Claude flow hôm nay; (b) là UX downgrade. Recommend (a).
5. **File hybrid spec** như follow-up cho `docs/specs/2026-05-20-cockpit-interactive-codex-design.md`, scope đến interactive slice only, trước khi làm renderer work cho #102.

---

## 8. Sources

- [notchi (sk-ruban/notchi)](https://github.com/sk-ruban/notchi) — README, `CodexHookInstaller.swift`, `notchi-codex-hook.sh`, `SocketServer.swift`, `HookEvent.swift`, `CodexProviderAdapter.swift`
- Orca prior research: [`docs/research/2026-05-19-orca-codex-wrapping-study.md`](2026-05-19-orca-codex-wrapping-study.md)
- [Zed external agents docs](https://zed.dev/docs/ai/external-agents)
- [Zed codex-acp adapter](https://github.com/zed-industries/codex-acp) — `Cargo.toml`, `src/codex_agent.rs`
- [Zed blog: Codex is Live in Zed](https://zed.dev/blog/codex-is-live-in-zed)
- [openai/codex `codex-rs/hooks/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/lib.rs) — `HOOK_EVENT_NAMES`
- [openai/codex `codex-rs/tui/src/chatwidget/hooks.rs`](https://github.com/openai/codex) — chứng minh TUI invoke hooks
- [DeepWiki: codex rollout persistence and replay (§3.5.2)](https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay)
- Local evidence: `~/.codex/sessions/2026/05/25/rollout-*.jsonl` với `"originator":"codex-tui"`, `"cli_version":"0.133.0"`
- Cockpit context: PR #98, Issue #102, `src/commands/crew-attach.ts`
