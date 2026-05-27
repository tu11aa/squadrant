# Tracking Codex While Keeping the Native TUI — Can Cockpit Have Both?

**Date:** 2026-05-27
**Author:** Cockpit research (parent: develop)
**Question this answers:** PR #98 of cockpit chose `codex app-server` (structured JSON-RPC, we render UI ourselves) over wrapping the native `codex` TUI in a tmux pane (great UI, fragile state extraction). The user pushes back: *"Orca, Zed IDE, and notchi all manage to track what codex is doing while keeping the native TUI — why can't cockpit?"*. Is there a third option?

---

## 0. The trilemma, restated

Three properties we want from a codex integration:

1. **Full native `codex` TUI** rendered for the user (no second-class UI to compete with it).
2. **Structured activity tracking** the daemon can subscribe to (turn-started, turn-completed, awaiting-input, etc).
3. **Reliable across process churn** — daemon bounces, reattach, anti-#2576 (false "done"), gate primitive.

PR #98 picked (2) + (3) by giving up (1). Issue #102 doubles down on (1) by building our own TUI on top of (2)+(3)'s events. The user's push-back is: *notchi gets all three, why not cockpit?*

The answer turns out to be: **all three reference systems do it, but they each pay a different price — and the price varies by an order of magnitude.** Cockpit can almost certainly have all three, but choosing *which side-channel* is the load-bearing decision, and it's not the same one notchi picked.

---

## 1. notchi — what's the actual mechanism?

**Repo:** [`github.com/sk-ruban/notchi`](https://github.com/sk-ruban/notchi) · 894 stars · Swift macOS app · default branch `main` at audit time (2026-05-27).

### 1.1 README's own summary

The README states the architecture in one line:

> `Claude Code / Codex --> Hooks (shell scripts) --> Unix Socket --> Event Parser --> State Machine --> Animated Sprites`

And:

> *"Notchi registers shell script hooks with Claude Code and Codex on launch. When either agent emits events (tool use, thinking, prompts, permission requests, compaction, session start/end), the hook script sends JSON payloads to a Unix socket."*

So **notchi does not parse the rendered TUI**. It does not snapshot the terminal, does not OSC-sniff, does not parse stdout. It taps codex's **first-class native hooks system** — the same one Orca uses — and pipes the JSON events to a local Unix socket.

### 1.2 The actual install path (`CodexHookInstaller.swift`)

`notchi/notchi/Services/CodexHookInstaller.swift` writes three things into `~/.codex/`:

1. **Hook script** at `~/.codex/hooks/notchi-codex-hook.sh` (mode `0o755`):
   ```swift
   // CodexHookInstaller.swift:43-62
   let bundled = Bundle.main.url(forResource: "notchi-codex-hook", withExtension: "sh")
   let bundledData = try Data(contentsOf: bundled)
   try bundledData.write(to: hookScriptURL, options: .atomic)
   try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hookScriptURL.path)
   ```

2. **`~/.codex/hooks.json`** with three event registrations (`upsertHooksJSON`, lines 69–95):
   ```swift
   let desiredHookEvents: [String: [[String: Any]]] = [
     "SessionStart":     [makeHookGroup(matcher: "startup|resume", command: command)],
     "UserPromptSubmit": [makeHookGroup(matcher: nil,              command: command)],
     "Stop":             [makeHookGroup(matcher: nil,              command: command, timeout: 30)],
   ]
   ```

3. **`~/.codex/config.toml`** with `codex_hooks = true` under `[features]` (`upsertFeatureFlag`, lines 118–145).

Notchi registers **only three** of codex's ten hook events (`SessionStart`, `UserPromptSubmit`, `Stop`). It doesn't bother with `PreToolUse`/`PostToolUse`/`PermissionRequest`/`PreCompact`/etc — the UI just needs idle/working/waiting transitions, so three is enough.

### 1.3 The hook payload path (`notchi-codex-hook.sh`)

The installed script is a bash + inline Python program. The relevant lines:

```bash
# notchi/notchi/Resources/notchi-codex-hook.sh
SOCKET_PATH="/tmp/notchi.sock"
[ -S "$SOCKET_PATH" ] || exit 0       # silent no-op if app not running
/usr/bin/python3 -c "
  input_data = json.load(sys.stdin)   # codex pipes hook JSON to stdin
  ...
  output = {
    'provider': 'codex',
    'session_id': input_data.get('session_id', ''),
    'transcript_path': input_data.get('transcript_path'),
    'event': hook_event,
    'status': status_map.get(hook_event, ...),   # SessionStart→waiting_for_input, UserPromptSubmit→processing, Stop→waiting_for_input
    ...
  }
  sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
  sock.connect('$SOCKET_PATH')
  sock.sendall(json.dumps(output).encode())
"
```

It also walks the process tree (`codex_process_context`) to attribute the event to a specific `codex` PID and to mark whether the origin is `cli` (has a tty) or `desktop` (no tty).

### 1.4 The receiver (`SocketServer.swift`)

A Swift `AF_UNIX/SOCK_STREAM` listener at `/tmp/notchi.sock` with `chmod 0600`, accepts each hook fire, decodes the `AgentHookEnvelope`, normalizes via `CodexProviderAdapter.normalize`, and feeds the state machine. The envelope schema (`HookEvent.swift:876-933`) is the full superset (`tool`, `tool_input`, `permission_mode`, `transcript_path`, `codex_origin`, …) — notchi's parser is ready for the events it doesn't currently register, hint that the architecture is designed to be expanded.

### 1.5 Reliability / latency story

- **Latency:** sub-millisecond local Unix socket; the bash wrapper adds ~30ms of Python startup per fire. For idle/working transitions this is invisible.
- **Reliability:** the hook script `exit 0`s silently if the socket isn't there (`[ -S "$SOCKET_PATH" ] || exit 0`) — codex never sees a failing hook, so the user's session is never affected by notchi being closed. The `timeout: 30` on `Stop` (line 81 of `CodexHookInstaller.swift`) is codex's own per-hook timeout, used so a hung notchi cannot stall codex.
- **Restart survival:** the hook is filesystem state, not process state. Hooks fire correctly whether notchi was running yesterday, restarted just now, or never started — same as Orca's loopback HTTP design (`hook-service.ts:104-112` in Orca).
- **TUI compatibility:** *codex runs as its plain interactive TUI*. The hook is purely out-of-band. Nothing about codex's rendering, prompt composer, or terminal is touched.

### 1.6 Net characterization

**notchi tracks codex by installing entries into `~/.codex/hooks.json` that fire shell scripts which forward the JSON payload to a Unix socket. It does not parse the TUI at all.** It is a strictly-better Orca: same mechanism (codex native hooks), simpler transport (Unix socket vs loopback HTTP + bearer token), narrower event set (3 vs 6 events).

This is the *exact same channel* PR #98 had available and chose not to use. Notchi is not solving a different problem with a clever trick — it is using a channel cockpit currently does not.

---

## 2. Orca, revisited

Cockpit's prior research at [`docs/research/2026-05-19-orca-codex-wrapping-study.md`](2026-05-19-orca-codex-wrapping-study.md) concluded that Orca's approach was rejected because state extraction was *"fragile"*. **That conclusion needs revising in light of notchi's evidence.**

Re-reading the Orca study against the source code:

- **Orca does not screen-scrape state.** §2.2 of the prior research: *"Orca does not infer turn state from PTY output. It installs managed entries into codex's own hooks system and listens for the events."* The mechanism is `src/main/codex/hook-service.ts:42-49` registering the six hook events, then `curl`ing them to a loopback HTTP server on `127.0.0.1:${ORCA_AGENT_HOOK_PORT}` with a bearer token.
- **Orca only screen-scrapes for two trivial things:** (a) paste-timing (waiting for the `›` composer prompt before bracketed-paste of a draft, `agent-paste-draft.ts`), and (b) a fallback rate-limit `/status` read it openly distrusts ("app-server can fail independently of the interactive CLI", `codex-fetcher.ts:440`).

**The "fragile" verdict in the 2026-05-19 study was about *driving codex through the TUI* (typing into it, reading from it). The *tracking* path Orca actually uses is the hook system, which is structured JSON, identical in robustness to app-server's events.**

This was a category error in the cockpit research: the prior write-up conflated "wrapping the TUI" (fragile because of bidirectional terminal IO) with "tracking codex while showing its TUI" (not fragile, because the channel is JSON hooks, not the TUI). Both Orca and notchi do the latter. Neither does the former.

---

## 3. Zed — a third mechanism entirely

Zed integrates codex via [`github.com/zed-industries/codex-acp`](https://github.com/zed-industries/codex-acp) ([blog post](https://zed.dev/blog/codex-is-live-in-zed), [external-agents doc](https://zed.dev/docs/ai/external-agents)). The README states: *"This tool implements an ACP adapter around the Codex CLI"*. But "wraps the Codex CLI" turns out to be a misnomer — `codex-acp/Cargo.toml` reveals:

```toml
codex-core         = { git = "https://github.com/openai/codex", tag = "rust-v0.133.0" }
codex-mcp-server   = { git = "https://github.com/openai/codex", tag = "rust-v0.133.0" }
codex-exec-server  = { git = "https://github.com/openai/codex", tag = "rust-v0.133.0" }
codex-protocol     = { git = "https://github.com/openai/codex", tag = "rust-v0.133.0" }
codex-login        = { git = "https://github.com/openai/codex", tag = "rust-v0.133.0" }
```

And from `src/codex_agent.rs`:

```rust
use codex_core::{
    NewThread, RolloutRecorder, SortDirection, StateDbHandle, ThreadManager, ...,
    config::Config, find_thread_path_by_id_str, init_state_db,
    resolve_installation_id, thread_store_from_config,
};

let thread_manager = ThreadManager::new(&config, auth_manager.clone(), SessionSource::Unknown, ...);
let history = RolloutRecorder::get_rollout_history(&rollout_path).await...;
```

**Zed does not spawn `codex` as a subprocess at all.** It statically links `codex-core` as a Rust library inside its `codex-acp` binary and runs the agent loop in-process. The Zed blog post confirms a related architectural detail: *"the Codex agent runs terminal commands in its own process, and then streams output bytes from that terminal process to the client"* — i.e. Zed treats codex's *tool calls* as the unit it brokers, not the codex process itself.

Zed renders **its own UI**, not codex's TUI. The native codex TUI is *replaced*, not augmented. Zed users who want the native TUI don't use Zed — they run `codex` in a terminal. So Zed is **not actually an example of "native TUI + tracking"**; it's an example of "no codex process at all, codex-core embedded as a library, no TUI involved."

This is a fourth architectural option that's only available to projects willing to take a hard build dependency on `codex-core` (Rust, pinned version, broken on every upstream refactor). For cockpit — a Node/TypeScript daemon supporting Codex *and* Claude *and* Opencode *and* Aider — this is a non-starter. It's mentioned here only to clear it from the field.

---

## 4. What does codex itself expose?

This is the load-bearing answer. There are exactly four side-channels of codex state that don't require parsing the TUI:

### 4.1 Hooks (the channel notchi + Orca use)

**Source:** `codex-rs/hooks/src/lib.rs`. The full list:

```rust
pub const HOOK_EVENT_NAMES: [&str; 10] = [
    "PreToolUse", "PermissionRequest", "PostToolUse",
    "PreCompact",  "PostCompact",
    "SessionStart", "UserPromptSubmit",
    "SubagentStart", "SubagentStop",
    "Stop",
];
```

**Registration:** `~/.codex/hooks.json` with per-event entries pointing to a command. Codex pipes a JSON payload to that command's stdin; stderr/exit are observed.

**TUI vs exec:** The hooks crate is *invoked from the session layer* (`codex-rs/core/src/session/mod.rs` exposes `hooks()` on the session, which is created identically for TUI and exec runs). Concrete evidence the TUI path goes through it: `codex-rs/tui/src/hooks_rpc.rs` (`fetch_hooks_list`, `HookTrustUpdate`) and `codex-rs/tui/src/chatwidget/hooks.rs` (the TUI's own hooks browser view). Notchi and Orca both run codex as the regular interactive TUI and rely on the hooks firing — this is empirically proven in production.

**Codex 0.129+ caveat (also documented in cockpit's prior Orca research):** Codex silently drops hooks that don't have a matching `trusted_hash` entry in `config.toml`. Both notchi (`upsertFeatureFlag` for `codex_hooks = true`) and Orca (`config-toml-trust.ts`) handle this. Any cockpit integration must too.

**Conclusion:** **This is the channel.** It is structured JSON, fires in TUI mode, is decoupled from rendering, has explicit timeouts, fails open, and is what every other tracker in the wild uses.

### 4.2 Rollout JSONL (the channel Zed reads after-the-fact)

**Source:** [`codex-rs/core/src/rollout/`](https://github.com/openai/codex) `RolloutRecorder`. Documented at [DeepWiki §3.5.2](https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay).

**Path:** `~/.codex/sessions/YYYY/MM/DD/rollout-{ISO_TIMESTAMP}-{UUID}.jsonl`. Verified live on this machine:

```
~/.codex/sessions/2026/05/25/rollout-2026-05-25T10-35-03-019e5d33-...jsonl
```

**Format:** `RolloutLine` envelopes containing `ResponseItem` / `EventMsg` / `SessionMeta` / `TurnContext` / `Compacted` items. First line of a real session on this machine:

```json
{"timestamp":"2026-05-25T03:39:05.138Z","type":"session_meta","payload":{
  "id":"019e5d33-4ca6-7b31-9005-6e15664ae943",
  "cwd":"/Users/q3labsadmin/me/LumiLabs/OnePlanApp",
  "originator":"codex-tui",           // ← proves TUI writes this
  "cli_version":"0.133.0",
  ...
}}
```

`originator: "codex-tui"` is direct evidence that the rollout file is written *by the TUI* — same as exec, same as app-server.

**Streaming?** DeepWiki: *"asynchronous persistence via a background RolloutWriterTask … near-real-time asynchronous recording."* So a tail-style follower (e.g. `chokidar` or `fs.watch` on the per-day directory + `tail -F` semantics on the latest file) would see events within tens of ms of them happening.

**Limitations:** This is replay data, not orchestration. There's no `PermissionRequest` distinct event; the rollout sees the final approved/denied decision and the resulting tool call. It is **strictly less rich than hooks** for "what is codex *currently* waiting on." Suitable as a *secondary* signal (e.g. "the last user-visible turn ended N seconds ago, daemon must have missed the Stop hook") but not as a primary tracker.

### 4.3 `codex app-server` JSON-RPC (cockpit's current channel)

This is what PR #97/#98 ship. Full structured event surface, but **requires running codex via `codex app-server` rather than as the interactive TUI**. The TUI binary and the app-server binary are *different runtime modes of the same executable*; you cannot have both simultaneously for the same session.

This is the irreducible cost of PR #98: choosing app-server means there *is* no native TUI to display, because the codex process running is not in TUI mode.

### 4.4 OSC titles / stdout / pty scraping

The thing PR #98 rejected. Both Orca and notchi *also* reject it (modulo Orca's paste-timing exception). No prior art uses it for state tracking. Confirming the original PR #98 reasoning: this is the fragile path and we should keep avoiding it.

---

## 5. Synthesis — can cockpit have native codex TUI + structured tracking?

### 5.1 The Yes Path — "passthrough TUI + hook tap"

**Yes.** The mechanism is *the same one notchi uses*, ported into cockpit's daemon. Concretely:

1. **Spawn codex as its plain interactive TUI inside a cmux pane**, exactly as Orca does (`codex` with no subcommand, in a pty), exactly as a user running `codex` interactively does today. The user sees the real codex TUI and types into it directly. The bridge crew-attach renderer goes away — there's nothing to render, the user is looking at codex itself.
2. **At daemon startup, install (or upgrade) `~/.codex/hooks.json` entries** that point to a small `cockpit-codex-hook` shim. The shim is bundled with cockpit, written once at daemon boot, mode 0755, and reads JSON from stdin like notchi's does.
3. **The shim forwards each event to the cockpit daemon's Unix socket** (`~/.config/cockpit/cockpit.sock`) — same socket the daemon already uses. Add a new frame type `hook-event` to the protocol.
4. **The daemon's existing state machine** consumes these events the same way it currently consumes `app-server` notifications. The `normalizeAppServerNotification` in `src/control/codex/` becomes one of two normalizers; a new `normalizeHookEvent` covers the TUI path. Both produce the same `ControlEvent` shape — anti-#2576 invariant unchanged.
5. **Handle codex 0.129+ trust:** write the matching `trusted_hash` + `codex_hooks = true` into `~/.codex/config.toml` like notchi and Orca do.
6. **Reattach across daemon bounce:** trivially better than the app-server path. The codex *process* is the cmux pane, owned by cmux, not by the daemon. A daemon restart doesn't kill codex; the hook shim re-resolves the socket on each fire (it's a filename, not a fd) and starts hitting the new daemon immediately. There's nothing to "reattach" — the tap is stateless.
7. **Gate primitive:** `PermissionRequest` hook fires. The shim forwards it. The daemon promotes it to a Gate just like today. Resolution: the human answers in the TUI directly (same as Orca — `hook-service.ts:39-41` comment) and the `PostToolUse`/`Stop` hook closes the gate. Or, if cockpit wants programmatic answers, we still have the gate-resolve verb, but with a small protocol gap (we can't *force* an approval choice into the TUI without typing into it, which is the fragile thing).

**Migration delta from PR #98:**

| Component | Today (app-server) | Yes path (TUI + hooks) |
|---|---|---|
| codex spawn | `codex app-server` long-lived child owned by daemon | bare `codex` in cmux pane, owned by cmux, daemon does not own it |
| Tracking channel | JSON-RPC over stdio | hook shim → Unix socket |
| `crew-attach` UI | bordered renderer with chalk/Ink (per #102) | nothing — user sees native TUI |
| Reattach | daemon → `thread/resume` after bounce | nothing — codex process survives daemon bounce |
| Initiator | daemon issues `turn/start` | user types in TUI directly |
| `cockpit say` | daemon RPC into the same child | `cmux send` to type into the pane (cmux process-tree rules apply — see existing notify-relay design) |
| Gate primitive | first-class via `ToolRequestUserInput` | observes via `PermissionRequest` hook; cannot inject answer except via cmux send |

**Trade-off:** cockpit loses *programmatic* control of the conversation (you can't `turn/start` over RPC; you must type into the TUI via cmux send). This is the same trade-off Orca explicitly took and called acceptable in their orchestration coordinator (`coordinator.ts` — agent calls back via `orca task complete`, not protocol).

### 5.2 The No Path — what would kill this idea

Things that would force cockpit to stay with app-server:

- **Programmatic dispatch.** If cockpit's captain-spawns-crew flow requires *the daemon* to send the initial prompt to codex without a human typing, that's app-server territory. (Counter: cmux send works, see notify-relay; cockpit already accepts process-tree dance for the captain.)
- **Cross-restart conversation resume that survives the codex process dying.** With the hook approach, if codex itself crashes, the conversation is gone (no `thread/resume` equivalent without app-server — Orca documents this as a real gap). With app-server, daemon-owned codex can be relaunched and `thread/resume`'d.
- **Programmatic approval answering.** If cockpit wants the captain to auto-approve some classes of tool calls, the app-server `ToolRequestUserInput` round-trip is the only way; hooks observe but don't decide (notchi and Orca punt this to the human).

None of these are *fatal*. They are real capability deltas. PR #98 is genuinely more ambitious than notchi/Orca on dimensions (5.1.5) and (5.1.7); the question is whether those ambitions are worth the UI cost.

### 5.3 The Hybrid Path — TUI for display, hooks AND app-server for tracking

Codex 0.133 supports `codex app-server` and the TUI as *separate processes*. Nothing forbids running both:

- One **interactive TUI codex** in a cmux pane, for display + human input, with hooks tapped.
- A **separate app-server codex** for *programmatic* tasks (the captain spawning a headless crew, programmatic approvals, anti-#2576 strict event semantics).

This is, in effect, the cockpit-today design split by use case:
- *Interactive crew* (human typing): TUI + hooks. No bridge renderer. Issue #102 is closed by deletion.
- *Headless crew* (captain spawns codex with a prompt, gets a result): app-server, same as PR #98 today.

The split is along the line PR #98's own scope already drew: PR #98 closed the "interactive-codex slice" of #86; the "headless slice" remains for a follow-up. The hybrid path is to **stop trying to interactively-render through app-server** (issue #102's whole framing) and accept that interactive == TUI + hooks, headless == app-server.

The cost: two normalizers, two integration tests, two version-skew matrices to track. The benefit: each use case uses the channel it's actually best at.

---

## 6. Ranking and recommendation

| Path | Native TUI? | Structured tracking? | Daemon-bounce survival? | Programmatic dispatch? | Prior art? | Eng cost from today |
|---|---|---|---|---|---|---|
| **Stay on PR #98 + ship #102** | No (we render) | Yes | Yes | Yes | Cockpit (alone) | ~4-6h for #102 renderer |
| **Yes path (TUI + hooks only)** | Yes | Yes (less rich than app-server) | Yes (codex process unowned by daemon) | No (must type via cmux) | notchi, Orca | ~1-2 days, deletes #102 entirely |
| **Hybrid (TUI+hooks for interactive, app-server for headless)** | Yes (interactive) | Yes (both surfaces) | Yes | Yes (headless only) | None — novel | ~2-3 days, deletes #102, adds 2nd normalizer |
| Zed-style codex-core embed | No | Yes | n/a | Yes | Zed | Weeks; wrong language; rejected. |

**Recommendation: the Hybrid Path.**

Reasoning, opinionated:

1. **Issue #102 should be closed wontfix.** Building a fake codex TUI on top of app-server events is exactly the work the rest of the ecosystem (notchi, Orca, Zed) decided not to do. We will spend renderer effort for years and still look worse than the real codex TUI a `brew install codex` away. The energy is wasted.

2. **The "fragility" argument from the 2026-05-19 Orca research was misdiagnosed.** It was true about TUI-as-driver. It was false about TUI-with-hook-side-channel. Notchi proves the hook channel is production-stable at scale (894-star app shipping to thousands of macOS notch users). The conclusion that justified PR #98's UI cost was over-broad.

3. **PR #98's app-server foundation is still right for headless.** Anti-#2576, daemon-bounce reattach via `thread/resume`, programmatic gates — these are real capabilities the hook channel cannot offer, and they matter for captain→crew dispatch. Don't tear PR #98 out; demote it to the headless half of a split.

4. **Interactive becomes a thin shim.** `cockpit crew chat --provider codex` spawns a codex TUI pane, installs hooks on first run, daemon listens. No bridge renderer. No #102. No fight with codex's own UI. The pane *is* the UI.

5. **One real-world test before committing:** prove the hook latency + reliability story on the cockpit daemon's existing Unix socket with a 30-minute interactive codex session under load (file edits, approvals, compaction). If hook fires drop or arrive out-of-order under stress, the Yes/Hybrid paths fail and we keep PR #98. Both notchi and Orca run this configuration in production, so the prior is strongly in favor.

### 6.1 Does this flip the #102 plan?

**Yes — provided the hook-channel reliability test passes.** Issue #102 exists because PR #98's architecture forced cockpit to render codex itself. The Hybrid Path eliminates that need for the interactive case, which is the only case #102 cares about. #102 should be re-scoped to *"investigate TUI-passthrough + hook tap; if feasible, close #102 wontfix and file the hybrid integration spec instead."*

### 6.2 Does this flip the PR #98 decision?

**No — PR #98 stays merged and shipping.** The Hybrid Path keeps app-server for headless, where it's irreplaceable. The flip is on issue #102 (the renderer parity goal), not on PR #98 (the app-server foundation). The 2026-05-19 Orca research was directionally correct about app-server being the right answer for *one of two* use cases; it just framed it as the answer for *both*.

---

## 7. Open questions / next actions

1. **Spike: hook latency under load.** Write a 100-line cockpit-codex-hook shim, install into `~/.codex/hooks.json` against a local codex 0.133, run a real session, measure SessionStart→Stop event lag on the daemon socket. Target: p99 < 100ms.
2. **Verify hooks fire in TUI with cmux `claude -c` resume semantics.** Codex 0.130 introduced thread-resume in the TUI; confirm hooks still fire across `codex --continue`/`codex resume`. Notchi's `SessionStart` matcher is literally `"startup|resume"` so this is presumably handled, but we should test.
3. **`config.toml` trust-hash automation.** Lift notchi's `upsertFeatureFlag` + Orca's `config-toml-trust.ts` into cockpit's first-run installer; otherwise hooks silently drop on 0.129+.
4. **Decide the captain→crew dispatch story for the interactive case.** Two options: (a) captain types prompts into the codex TUI pane via cmux send (notify-relay pattern, already-built); (b) crew is always spawned by a human typing in the captain pane. (a) is operationally identical to today's captain→Claude flow; (b) is a UX downgrade. Recommend (a).
5. **File the hybrid spec** as a follow-up to `docs/specs/2026-05-20-cockpit-interactive-codex-design.md`, scoped to the interactive slice only, before doing any renderer work on #102.

---

## 8. Sources

- [notchi (sk-ruban/notchi)](https://github.com/sk-ruban/notchi) — README, `CodexHookInstaller.swift`, `notchi-codex-hook.sh`, `SocketServer.swift`, `HookEvent.swift`, `CodexProviderAdapter.swift`
- Orca prior research: [`docs/research/2026-05-19-orca-codex-wrapping-study.md`](2026-05-19-orca-codex-wrapping-study.md)
- [Zed external agents docs](https://zed.dev/docs/ai/external-agents) — Codex via ACP
- [Zed codex-acp adapter](https://github.com/zed-industries/codex-acp) — `Cargo.toml`, `src/codex_agent.rs`
- [Zed blog: Codex is Live in Zed](https://zed.dev/blog/codex-is-live-in-zed)
- [openai/codex `codex-rs/hooks/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/lib.rs) — `HOOK_EVENT_NAMES`
- [openai/codex `codex-rs/tui/src/chatwidget/hooks.rs`](https://github.com/openai/codex) — proof TUI invokes hooks
- [DeepWiki: codex rollout persistence and replay (§3.5.2)](https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay)
- [openai/codex docs/config.md `Lifecycle hooks`](https://github.com/openai/codex/blob/main/docs/config.md)
- Local evidence: `~/.codex/sessions/2026/05/25/rollout-*.jsonl` with `"originator":"codex-tui"`, `"cli_version":"0.133.0"`
- Cockpit context: PR #98, Issue #102, `src/commands/crew-attach.ts`
