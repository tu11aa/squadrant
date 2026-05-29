# Orca — Full-System Study & Deep Comparison vs. Cockpit

**Date:** 2026-05-19
**Subject:** https://github.com/stablyai/orca @ `03b88951` (HEAD 2026-05-19, "feat: expand ai commit agent support (#1928)")
**Clone:** `/tmp/orca-study` (TypeScript / Electron / pnpm; ~2000 merged PRs by bug-ref numbering)
**Compared against:** cockpit @ develop `9e61220` (post PR #85, control-plane merged)
**Companion memo:** `2026-05-19-orca-codex-wrapping-study.md` (codex-specific deep dive — read first for the codex mechanism)

This memo is the whole-system study: every major subsystem with file:line evidence, then a rigorous head-to-head against cockpit's architecture.

---

# PART A — Orca: The Whole System

## A0. One-paragraph architecture

Orca is an **Electron desktop IDE** that hosts *any* CLI coding agent as its **native interactive TUI inside a `node-pty`**, rendered with xterm.js, one per git-worktree pane. It is fundamentally a **terminal multiplexer for agents** with three layers bolted on: (1) an out-of-process **PTY daemon** (`src/main/daemon/`) that owns the pty children and survives Electron restarts via server-side headless-terminal snapshots; (2) a **unified agent-status pipeline** that installs each agent's *own native hook system* and normalizes ~10 different event vocabularies into 4 canonical states over a loopback HTTP server; (3) an **RPC runtime** (`src/main/runtime/`) exposing an `orca ...` CLI over an AF_UNIX socket (plus WebSocket+E2EE for the mobile app), on top of which a polling **orchestration coordinator** dispatches a task DAG to agent terminals by *typing prompts into PTYs* and collecting `worker_done` callbacks. The agent loop is PTY-centric end to end; protocols (`codex app-server`) are used only for side-channel telemetry.

## A1. Generic agent-driving model — the crux

**The per-agent launch table** is `src/shared/tui-agent-config.ts`. `TUI_AGENT_CONFIG: Record<TuiAgent, TuiAgentConfig>` (`:58-260`) holds 30 agents. Each entry: `detectCmd` / `launchCmd` / `expectedProcess` (PATH probe, spawn, process-recognition), `promptInjectionMode`, optional `preflightTrust`, `draftPromptFlag`, `draftPromptEnvVar`, `draftPasteReadySignal`.

**`promptInjectionMode` variants** (`:3-9`) — how the *first* prompt reaches the agent:
- `argv` — passed as a CLI argument (claude, codex, pi, droid, cursor). For codex the comment `:75-79` notes the positional prompt auto-submits, so orca still must paste a draft.
- `flag-prompt` / `flag-prompt-interactive` / `flag-interactive` — agent-specific flag (opencode `--prompt`; gemini; copilot `-i` because `--prompt` would run non-interactively and *kill the hosted TUI*, `:242-246`).
- `stdin-after-start` — type into the running TUI after it boots (aider, goose, amp, ~15 others). **This is screen-timing-dependent injection**: write text into the pty, wait, send Enter.

**`preflightTrust`** (`:36-43`): cursor/copilot/codex gate first launch behind a "trust this folder?" menu that would *eat* the bracketed paste. Orca pre-writes the exact trust artifact the agent writes post-accept (`src/main/agent-trust-presets.ts`) so the menu never fires. Codex uses `'codex'` preset (its `config.toml` trust hash machinery, see A3).

**`draftPasteReadySignal`** (`:44-49`): for a draft (non-submitted) prompt, orca must time the bracketed paste. Generic agents use a quiet-render timer; codex gets the stronger `'codex-composer-prompt'` signal — orca watches the rendered pty stream for codex's `›` composer prompt (it even cites codex's internal `chat_composer.rs`). Consumed in `src/renderer/src/lib/agent-paste-draft.ts`. **This is the only place orca reads codex's rendered TUI to make a decision, and it's purely paste-timing.**

**Onboarding a new agent** = add one `TUI_AGENT_CONFIG` row + (if the agent has a hook system) a `src/main/<agent>/hook-service.ts`. Header comment `:52-57` is explicit: this table exists so "the picker, launcher, and preflight checks [don't] quietly drift apart as new agents are added."

### Turn/done normalization across heterogeneous agents — THE key engineering decision

**Every agent has a *different* native hook system; orca writes a per-agent managed script and normalizes server-side.** Nine `hook-service.ts` files (`claude, codex, copilot, cursor, droid, gemini, grok, hermes, opencode`), each subscribing to that agent's *own* event vocabulary:

| Agent | Config target | Native turn-start / turn-done events (evidence) |
|---|---|---|
| claude | `~/.claude/settings.json` | `UserPromptSubmit` / `Stop` (`claude/hook-service.ts:21-42`) |
| codex | `~/.codex/hooks.json` + `config.toml` trust | `UserPromptSubmit` / `Stop`, `PermissionRequest` (`codex/hook-service.ts:42-49`) |
| gemini | `~/.gemini/settings.json` | `BeforeAgent` / `AfterAgent`; **no permission hook → no waiting state** (`gemini/hook-service.ts:21-32`) |
| cursor | `~/.cursor/hooks.json` (camelCase) | `beforeSubmitPrompt` / `stop`; `beforeShellExecution`/`beforeMCPExecution` = approvals (`cursor/hook-service.ts:22-46`) |
| grok | `~/.grok/hooks/orca-status.json` | `user_prompt_submit`/`Stop` (`grok/hook-service.ts:21-45`) |
| copilot | `~/.copilot/hooks/orca.json` | PascalCase `UserPromptSubmit`/`Stop`, `subagentStart` (`copilot/hook-service.ts:27-44`) |
| droid | `~/.factory/settings.json` | `UserPromptSubmit`/`Stop` (`droid/hook-service.ts:19-37`) |
| hermes | `~/.hermes/...` YAML plugin | `pre_llm_call`/`post_llm_call`, `pre_approval_request` (`hermes/hook-service.ts:26-37`) |
| opencode | injected JS plugin | `SessionBusy`/`SessionIdle`/`PermissionRequest` (plugin-side mapped, `opencode/hook-service.ts:53-60`) |

The managed script POSTs the raw hook payload + pane metadata to a loopback HTTP server. **Normalization is server-side** in `src/shared/agent-hook-listener.ts`: per-source `normalize<Agent>Event()` functions (`:1344` claude, `:1434` codex, `:1392` gemini, `:1478` opencode, …) map every vocabulary onto **4 canonical states**: `'working' | 'blocked' | 'waiting' | 'done'` (`src/shared/agent-status-types.ts:6`). E.g. claude `:1351-1361`: `{UserPromptSubmit,PreToolUse,PostToolUse}→working`, `PermissionRequest→waiting`, `Stop→done`. An **exhaustive `switch` with a `never` guard** (`isNewTurnEvent` `:1274-1305`) forces a compile error if a new agent source is added without a turn-start mapping — a deliberate "fail at typecheck, not silently false" design.

**Crucial truth (the answer to "does every agent use hooks"): NO — three tiers, degrading.**
1. **Primary: native hooks** → 4-state normalization (above).
2. **Fallback: OSC-title scraping.** `orca-runtime.ts:1797-1872`: `extractLastOscTitle(data)` → `detectAgentStatusFromTitle()` on raw pty bytes. This drives the `terminal wait --for tui-idle` primitive (`:4289,:4330`) used by the orchestration coordinator when no hooks/preamble exist. Comment `:1861-1866`: resolves tui-idle on *any* transition→idle because "Claude Code may skip 'working' entirely on fast tasks, going null→idle, and the coordinator's tui-idle waiter would hang forever." This is **screen-scraping for completion** — exactly the class of signal cockpit's anti-false-done invariant distrusts. Orca itself documents its fragility (the "#1437 stuck-spinner bug": stale 'working' after agent exits, `:1846-1850`).
3. **Last resort: terminal output reading** (`terminal read`, 120-line buffer). The orchestration skill explicitly says "for status monitoring, not result extraction. Prefer structured `worker_done` payloads over parsing terminal output" (`skills/orchestration/SKILL.md`).

**Non-obvious tradeoff:** orca accepts heterogeneity instead of forcing a protocol. It writes into 8 third-party agent home dirs (`~/.claude .codex .copilot .cursor .factory .gemini .grok .hermes`) and maintains 9 bespoke installers + a giant normalization switch. The payoff: real turn signals from each agent's own runtime without scraping. The cost: enormous surface area, per-agent drift risk, and a documented version-coupling (codex 0.129+ trust hashes, A3).

## A2. PTY / process layer

`src/main/providers/local-pty-provider.ts` — `import * as pty from 'node-pty'` (`:11`), `ptyProcesses = Map<string, pty.IPty>` (`:37`), `spawn()` (`:160-320`) builds env (`:232-271` — strips inherited NO_COLOR, sets LANG, removes pane-identity env so child identity ≠ parent), uses `spawnShellWithFallback` (`:310`). A pane→process map is by pty id. `ssh-pty-provider.ts` mirrors this over SSH (`ssh2`). Comment `:39` flags a real native gotcha: node-pty's `onData/onExit` register NAPI ThreadSafeFunctions that must be disposed before kill or they "leave callbacks alive into Electron shutdown, which can abort the app" (also seen in `codex-fetcher.ts:347-351`).

## A3. Hook/event ingestion & install lifecycle

`src/main/agent-hooks/server.ts` (39 KB, one class by design `:1`): loopback `http.createServer` with **bearer-token auth** (`X-Orca-Agent-Hook-Token`), **IPC fanout** (`setListener`/`lastStatusByPaneKey` replay), an `ingestRemote()` path that bypasses HTTP for SSH-relay-forwarded events, and an on-disk `last-status.json` (`:71`) that survives restart so dashboard rows reappear. The shared listener (`src/shared/agent-hook-listener.ts`) holds the parser/normalizer so the SSH relay can host the *same* pipeline remotely without Electron ("relay normalizes; Orca routes", `:12`).

**Managed-script lifecycle** (`agent-hooks/installer-utils.ts`): `install()` writes a `<agent>-hook.sh`/`.cmd`/`.ps1` and registers it; `createManagedCommandMatcher(scriptFileName)` matches by *filename not exact command* so a fresh install sweeps stale entries from old builds / different Electron userData (dev vs prod) — without it "repeated installs accumulate duplicate hook entries" (`codex/hook-service.ts:268-272`). Scripts re-source `$ORCA_AGENT_HOOK_ENDPOINT` on every fire so a *surviving pty* keeps reporting to a *new* orca instance's port/token after restart (`codex/hook-service.ts:104-112`).

**Codex 0.129+ trust-hash machinery** (`src/main/codex/config-toml-trust.ts`, `hook-service.ts:297-320`): codex 0.129+ "silently drops untrusted hooks" — orca computes the `trusted_hash` (mirroring codex-rs `fingerprint.rs::version_for_toml` and `hooks/src/lib.rs::hook_event_key_label`), writes per-hook trust entries into `~/.codex/config.toml` last (`:325-338`), and reports `partial` if trust is stale because "a green status without trust verification is misleading" (`:150-152`). **This is the single most reusable production gotcha in the repo.**

## A4. Orchestration coordinator (autonomous multi-agent)

`src/main/runtime/orchestration/{coordinator,preamble,db}.ts`. SQLite-backed (`db.ts` 33 KB). Model:
- **Tasks form a DAG** (`task-create --deps`); a task→`ready` when all deps `completed`; completing a task auto-promotes dependents (skill doc "DAG resolution step").
- **Coordinator loop** (`coordinator.ts:148-225`): `decompose()` then poll `tick()` every 2 s (`DEFAULT_POLL_MS=2000`): `processMessages → processEscalations → processDecisionGates → warnStaleDispatches → dispatchReadyTasks → checkConvergence`. Phases `decomposing→dispatching→monitoring→merging→done` (`:74`). **Decomposition is NOT AI** — tasks must be pre-created; `:201-206` explicitly defers AI decomposition to "a future phase where the coordinator itself is an LLM agent."
- **Dispatch** (`:480-574`): pre-flight git-drift guard (skip, don't fail, if worktree >20 commits behind base — burning the circuit breaker would convert a recoverable state into hard-fail, `:481-521`); create dispatch context; build preamble; **`runtime.sendTerminal(handle,{text:preamble, enter:true})`** — i.e. *type the prompt into the pty*. `writeTerminalAction` (`orca-runtime.ts:4245-4273`): writes text, **`setTimeout 500ms`**, then writes `\r` — "TUI apps treat a single large write as a paste event." This is exactly cockpit's legacy cmux screen-scrape injection.
- **Feedback** = the agent voluntarily runs `orca orchestration send --type worker_done --payload {...}` (taught by `preamble.ts:buildDispatchPreamble`, `:38-60`+). Coordinator reads the SQLite mailbox; `handleWorkerDone` (`:303-343`) marks task complete & frees the terminal. No protocol — cooperative callback.
- **Watchdog**: heartbeat every 5 min (preamble), `HUNG_THRESHOLD_MS=10min` (`coordinator.ts:88`). `warnStaleDispatches` (`:227-241`) only **warns**, deliberately does NOT auto-fail: "the false-positive cost (a slow worker producing correct output) is higher than the false-negative cost (a hung worker keeps its terminal slot until a human notices)." Heartbeats keyed by `dispatchId` not task, so a stale heartbeat from a previously-failed retry can't mask a hung new dispatch (`:274-301`).
- **Circuit breaker**: 3 consecutive dispatch failures → context `circuit_broken`, task `failed` (skill doc; `failDispatch` `:562-568`). Dispatch contexts are separate rows from tasks ("sling pattern") so retries don't dirty the task.
- **Decision gates** = human-in-the-loop: `gate-create` blocks a task + completes its dispatch; `gate-resolve` returns it to `ready` with resolution injected into the next preamble.

## A5. Worktree management

Git-worktree-native (README: "Every feature gets its own worktree"). `orca-runtime-git.ts` (24 KB) + `worktree-teardown.ts` + `ipc/worktrees.ts`. Each pane bound to a worktree; the orchestration "inter-worktree pattern" (one agent per worktree for parallel work) vs "intra-worktree" (split panes, shared files) is documented in the skill. Drift guard (A4) is the notable engineering decision: stale base detection is a *dispatch* concern, not a worktree concern.

## A6. Source control / review

`src/main/source-control/` + `orca-runtime-git.ts`. Diffs computed in main, rendered in renderer; "Annotate AI Diffs" and inline commit without leaving the app (README feature wall). Commit-message generation is the *only* non-agent `codex exec` use (`commit-message-agent-spec.ts:248-269`, `exec --ephemeral --skip-git-repo-check -s read-only`, stdin delivery for diff-size safety).

## A7. Integrations

- **GitHub / Linear / GitLab / Gitea / Azure DevOps / Bitbucket** — dedicated `src/main/{github,linear,gitlab,...}` dirs; PRs/issues/Actions linked per worktree.
- **SSH remotes** — `src/relay/` ships a **lightweight relay daemon** SCP'd to the remote and launched over an SSH exec channel, framed JSON-RPC over stdin/stdout. On client disconnect the relay keeps PTYs alive in a grace period on a unix socket; reconnect via `relay.js --connect` bridging the new SSH channel (`src/relay/relay.ts:13-20`). It hosts the *same* agent-hook pipeline (`src/relay/agent-hook-server.ts`).
- **Mobile companion app** (`mobile/`, React Native): connects to the desktop runtime's **WebSocket transport + E2EE channel** (`runtime-rpc.ts:21-23,229-290`, `DEFAULT_WS_PORT=6768`). Pairing via an encoded offer (`shared/pairing.ts`, `PAIRING_OFFER_VERSION`); E2EE keypair (`runtime/e2ee-keypair.ts`); device registry with scopes (`runtime/device-registry.ts`). The daemon's headless terminal snapshots (A8) are what the phone renders.

## A8. Electron architecture & the PTY daemon

`src/{main,renderer,preload,shared,cli,relay}`. Main owns truth; renderer is a view; preload bridges; shared is Electron-free (so relay can reuse it). **Security boundary** for the CLI: `src/main/runtime/runtime-rpc.ts` ("the single security boundary for the bundled CLI", `:1-8`) — token auth, bootstrap-metadata file (exactly one on-disk discovery file), AF_UNIX + optional WS, keepalive framing (`{"_keepalive":true}` every 10 s past 10 s so long dispatches don't trip the 30 s socket idle timer, `:46+`), orphan-socket sweep.

**The PTY daemon** (`src/main/daemon/`, 59 files) is the standout subsystem and the direct analog to `cockpitd`:
- Out-of-process: Electron `fork()`s it (`daemon-init.ts:12`), AF_UNIX socket (`daemon-server.ts:55-134`), `chmod 0o600`, token auth, **protocol versioning** (`types.ts:6` `PROTOCOL_VERSION=7`, `PREVIOUS_DAEMON_PROTOCOL_VERSIONS=[1..6]` — "daemons can survive app updates; bump for wire-shape changes").
- **Server-side headless terminal**: each session runs a `@xterm/headless` `Terminal` + `SerializeAddon` (`headless-emulator.ts:1-5`) so the daemon maintains the *rendered* screen state, not just bytes.
- **Reattach via snapshot**: `terminal-host.ts:66-76,202-229` — on client reconnect, `getSnapshot()` returns `TerminalSnapshot{snapshotAnsi,...}` (`types.ts:14-16`); a "final checkpoint" snapshot is persisted on exit (`history-manager.ts`). Sessions whose subprocess hasn't exited are *not* reattached as new ("reattaching would..." guard `:66-71`).
- **Restart orchestration**: a documented 7-step atomic provider-swap (`daemon-init.ts:1-8`), `restartInFlight` promise coalescing so two restart triggers can't both enter the sequence (`:40-46`). Stale-daemon detection + `killStaleDaemon` (`daemon-health.ts`).
- This means: **Electron main/renderer can crash and restart; the pty children keep running in the daemon; the UI reattaches to a serialized screen.** The codex/agent *conversation* still isn't resumable (it's whatever state the live pty holds), but the *process and screen survive*. This is orca's answer to the daemon-bounce-orphans class of problem.

## A9. CLI surface (the "ignition key")

`src/cli/index.ts` → `RuntimeClient` → AF_UNIX/WS RPC to the running runtime. `src/cli/runtime/launch.ts::launchOrcaApp()` will *spawn the Electron app* if not running (`ORCA_OPEN_COMMAND`/`ORCA_APP_EXECUTABLE` overrides; `open <bundle>` on macOS). So the CLI is genuinely a thin RPC client + app-launcher — **conceptually identical to cockpit's "CLI is an ignition key, not the brain."** Command specs in `src/cli/specs/`, handlers in `src/cli/handlers/` (`orchestration.ts`, `terminal.ts`, `worktree.ts`, …). `codex-command-classification.ts` classifies user-typed codex commands into "needs visible terminal" vs "safe in background pty" (knows the full ≥0.13x subcommand surface incl. `app-server`, `mcp-server`, `remote-control`, `exec-server`, `stdio-to-uds` — but only to classify, never to drive).

## A10. Config footprint (what orca writes outside its own dir)

**Invasive by necessity of the hooks model.** Writes managed scripts + hook registrations into **8 third-party agent home dirs**: `~/.claude/settings.json`, `~/.codex/hooks.json` + `~/.codex/config.toml`, `~/.copilot/hooks/orca.json`, `~/.cursor/hooks.json`, `~/.factory/settings.json`, `~/.gemini/settings.json`, `~/.grok/hooks/orca-status.json`, `~/.hermes/...`, plus `~/.orca/agent-hooks/*.sh`. Mitigations: filename-scoped matchers to avoid clobbering user hooks; trust-entry cleanup that only removes entries hash-matching orca's own command (`codex/hook-service.ts:485-511`, "a sourcePath-only filter would wipe the user's manually-approved entries"). Still: this is the opposite of cockpit's "scoped to `~/.config/cockpit`, non-invasive" stance.

## A11. Self-improvement / learning / telemetry

**No self-improving/learning subsystem.** `src/main/telemetry/` is anonymous-usage analytics only (`consent.ts`, `install-id.ts`, `cohort-classifier.ts`, `burst-cap.ts`, `classify-error.ts`) — opt-out telemetry, not a feedback loop that changes behavior. There is no learnings-capture, no wiki-compilation, no self-heal-on-invocation. (Cockpit's learnings + LLM-wiki + self-healing daemon have no orca analog — see Part B.)

## A12. Real bugs / workarounds / version-gotchas (the gold)

- **Codex 0.129+ silent hook-drop** unless `config.toml` trust hash present (A3) — directly relevant to any codex-hooks path.
- **#1437 stuck-spinner**: OSC-title 'working' stays sticky after agent exits & shell takes over title; fixed by clearing `lastAgentStatus` on unclassifiable titles (`orca-runtime.ts:1846-1860`). *Evidence that title-scraping for completion is fragile.*
- **#1148 opencode daemon-parity regression**: sessionId shape changed from numeric to `<worktreeId>@@<uuid>`; an old path-traversal regex silently rejected every legit id, leaving the plugin never loading. Fixed by SHA-256-hashing the id to a 32-hex dir name (`opencode/hook-service.ts:22-50`). *Evidence: session-id shape changes are a recurring break source.*
- **node-pty NAPI ThreadSafeFunction leak**: must dispose onData/onExit before kill or Electron aborts on shutdown (`local-pty-provider.ts:39`, `codex-fetcher.ts:347-351`).
- **codex `--prompt`/`--ephemeral` & copilot `--prompt` foot-guns**: non-interactive flags would kill the hosted TUI (`tui-agent-config.ts:242-246`); argv prompt exceeds Windows/SSH cmdline limits → stdin (`commit-message-agent-spec.ts:251-253`).
- **Coordinator can't AI-decompose yet** (`coordinator.ts:201-206`) — tasks must be pre-created.
- **`allow-stale-base` regex matches inside fenced code blocks** — accepted v1 limitation, fails toward "dispatches through" (`coordinator.ts:44-49`).
- **tui-idle null→idle race**: fast tasks skip 'working'; waiter would hang forever (`orca-runtime.ts:1861-1866`).

---

# PART B — Deep Comparison vs. Cockpit

## B(i) Subsystem-by-subsystem

| Subsystem | Orca approach | Cockpit approach (post #85) | Who's ahead & why |
|---|---|---|---|
| **Agent driving (interactive)** | Native TUI in node-pty; prompt typed in (`sendTerminal` + 500 ms + `\r`) | Headless = daemon-owned child PID (`claude -p`, `opencode run`, `codex exec --json`); interactive = injected hooks (Claude); codex-interactive is the open fork | **Split.** Cockpit's headless path is cleaner (no screen timing) for batch; orca's TUI model is the only thing that gives a *human-attachable* live session today. Cockpit lacks orca's reattachable live UI. |
| **Turn/done detection** | Native hooks → 4-state normalization; OSC-title fallback; output read last | `reduce(state,event)` state machine; hook events (Claude); anti-false-done invariant | **Cockpit ahead on rigor** (pure reducer, TERMINAL_STATES, explicit "turn-end ≠ completion"). **Orca ahead on breadth** (9 agents normalized, real signals). Orca's #1437/tui-idle bugs *empirically validate* cockpit's distrust of scrape-based done. |
| **Cross-agent normalization** | `agent-hook-listener.ts` per-source `normalize*` + `never`-guarded switch; 4 canonical states | Provider tiering (provider × mode); per-provider drivers | **Orca ahead.** Cockpit has no equivalent unified normalization layer across heterogeneous hook vocabularies — this is orca's deepest asset. |
| **Daemon / process supervision** | Out-of-proc forked daemon, AF_UNIX, token, **protocol-versioned**, **server-side headless-terminal snapshot + reattach** | `cockpitd` launchd, AF_UNIX, per-task JSON state, heartbeat watchdog, `reduce` | **Orca ahead on resilience** (reattach via serialized screen survives main/renderer crash). Cockpit's open issue #86 (daemon-bounce orphans in-flight headless) is *exactly* the problem orca's snapshot/reattach + protocol-version + restart-coalescing solves. **Cockpit ahead on state purity** (typed JSON state machine vs orca's screen blob). |
| **Orchestration model** | SQLite task DAG, polling coordinator (2 s), preamble injected by typing, `worker_done` callback, circuit breaker, decision gates, dispatch-context "sling" | Command→Captain→Crew + Reactor; orchestration *inside* an agent session | **Comparable, different locus.** Orca's coordinator is *code* (deterministic, but can't AI-decompose). Cockpit's is an *LLM session* (flexible, AI-decomposes natively). Orca's circuit-breaker + dispatchId-keyed heartbeat + "warn-don't-autofail" are battle-tested patterns cockpit's watchdog should adopt. |
| **HITL / approvals** | Punted: agent shows its own TUI approval; orca observes (`PermissionRequest→waiting`) + decision-gates as workflow checkpoints | Anti-false-done; approvals are the open codex-interactive design question | **Orca pragmatic, not better.** Its approvals are answered by a human in the TUI, not over a protocol. Cockpit answering approvals over app-server is a capability orca lacks — but has zero prior art here (high risk). Orca's *decision-gate* concept (block task → human resolves → resolution injected into next preamble) is a clean pattern cockpit's Captain layer could adopt directly. |
| **CLI as ignition** | `orca` CLI = thin RPC client; `launchOrcaApp()` spawns the app if down | "CLI is ignition key, not the brain" — bootstraps then orchestration in-session | **Identical philosophy, independently arrived at.** Strong validation of cockpit's stance. |
| **Skills / portability** | Ships `skills/{orchestration,orca-cli,computer-use}/SKILL.md`; `CLAUDE.md` = `@AGENTS.md` one-liner | Load-on-demand portable skills; `AGENTS.md` canonical, `CLAUDE.md` thin wrapper | **Identical pattern, independently arrived at.** Orca's `CLAUDE.md → @AGENTS.md` is literally cockpit's stated direction. Validation. |
| **Multi-agent breadth** | 30 agents, 9 with native hooks, generic fallback for the rest | Claude (ref), codex/opencode headless, others via driver abstraction | **Orca far ahead on breadth.** Its `TUI_AGENT_CONFIG` + per-agent hook-service pattern is a proven template for cockpit's runtime-driver slot. |
| **Remote / SSH** | Relay daemon SCP'd over SSH, grace-period pty survival, same hook pipeline remote | Not a focus | **Orca ahead** (not a current cockpit goal; note for later). |
| **Mobile / external UI** | WS + E2EE + pairing + device registry; renders daemon snapshots | Obsidian hub-spoke reporting (read-only-ish) | **Different goals.** Orca = live control; cockpit = reporting. Not directly comparable. |
| **Config footprint** | Invasive: writes into 8 agent home dirs (hooks model) | Non-invasive: scoped to `~/.config/cockpit` | **Cockpit ahead on hygiene** — but note this is *because* cockpit doesn't yet do interactive multi-agent via native hooks. If cockpit adopts agent hooks it inherits orca's footprint problem; orca's filename-scoped matchers + hash-matched cleanup are the mitigation template. |
| **Self-improvement / learning** | None (telemetry is analytics only) | Learnings system + LLM-wiki + self-healing daemon | **Cockpit clearly ahead** — unique, no orca analog. Do not regress. |
| **State model** | Screen-snapshot blob + SQLite orchestration rows | Pure `reduce(state,event)`, typed JSON per-task, TERMINAL_STATES | **Cockpit ahead.** Orca's "truth" for a live agent is a serialized terminal — opaque, un-introspectable. Cockpit's typed state is auditable and testable. Keep it. |

## B(ii) The 5 deepest architectural insights for cockpit

1. **Daemon-bounce is solved with a server-side rendered-state snapshot + reattach + protocol version, not just process supervision.** Cockpit's issue #86 (daemon bounce orphans in-flight headless) is *the* problem `src/main/daemon/{terminal-host,headless-emulator,history-manager}.ts` + `types.ts:6` `PROTOCOL_VERSION` solve. The insight: a daemon owning agent children needs (a) a serialized resumable representation of each child's state, (b) a versioned protocol so a child outlives an app upgrade, (c) restart-coalescing so concurrent bounce triggers can't double-enter teardown (`daemon-init.ts:40-46`). For cockpit's *headless* path the resumable representation isn't a screen — it's the **JSON state + the child's resumable session id** (`codex exec` rollout, `claude --resume`). The orca lesson: design the resume artifact as a first-class persisted thing the daemon writes on every state transition (orca's "final checkpoint"), not something reconstructed at bounce time.

2. **There is no protocol that gives you turn-done for free across agents — orca proves the only reliable signal is the agent's own runtime event (hooks), and everything else (titles, output, timeouts) is a degrading fallback it openly distrusts.** Orca's #1437 and tui-idle-null→idle bugs are field evidence *for* cockpit's anti-false-done invariant. Strategic implication: cockpit's codex-interactive fork should bias toward whatever yields a *real codex-emitted event* — `codex app-server` notifications (`TurnCompleted` as liveness) OR codex's own hooks (the orca path) — and treat the legacy cmux scrape as the same "last resort" tier orca explicitly demotes.

3. **Heterogeneous agents demand a normalization layer; orca's `never`-guarded per-source switch is the template.** If cockpit grows beyond Claude for *interactive*, it will hit orca's exact problem: 9 different event vocabularies, no two agents agreeing on "turn started." `agent-hook-listener.ts`'s design — bespoke `normalize<Agent>Event()` per source, exhaustive switch that fails at *typecheck* when a source is unmapped, collapsing to 4 canonical states — is the proven shape. Cockpit's provider-tiering should grow an explicit `normalizeProviderEvent` seam with the same compile-time exhaustiveness, feeding the `reduce()`.

4. **The orchestration coordinator's battle-tested watchdog patterns beat cockpit's current heartbeat design on three specifics:** (a) **heartbeats keyed by dispatch-id not task** (a retried task has multiple dispatches; a late heartbeat from the dead one must not refresh the live one — `coordinator.ts:274-301`); (b) **warn-don't-autofail on stale** (false-positive killing a slow-but-correct worker costs more than a hung worker holding a slot — `:227-231`); (c) **circuit breaker as a separate "dispatch-context" row from the task** so retries don't dirty task state ("sling pattern"). Cockpit's per-task JSON state + watchdog should explicitly model dispatch attempts as separate sub-records with their own heartbeat lineage.

5. **Decision-gates are a clean, codeable HITL primitive cockpit lacks.** Orca's gate = "block task → human answers a structured question → resolution text auto-injected into the next dispatch preamble" (`skills/orchestration/SKILL.md`, `coordinator.ts` gate handling). This is exactly the "semi-automatic, prompted-at-key-moments" pattern in cockpit's own design memory, but formalized as a first-class state (`pending|resolved|timeout`) that gates the DAG. Cockpit's Captain close-out / approval moments could adopt this verbatim.

## B(iii) Where cockpit is genuinely ahead — do NOT regress toward orca

1. **Pure `reduce(state,event)` + typed per-task JSON state + TERMINAL_STATES.** Orca's live-agent "truth" is a serialized xterm screen blob — opaque, un-unit-testable, un-queryable. Cockpit's auditable typed state machine is strictly better engineering for an orchestrator. Orca's SQLite orchestration rows are fine but the *agent-state* truth is a screen. Keep cockpit's model.
2. **Anti-false-done invariant as a stated principle.** Orca *has* the bug class (#1437, tui-idle hangs) and patches them reactively. Cockpit elevates "turn-end is liveness, never completion" to an invariant. That's the right level. Do not weaken it to match orca's pragmatic title-scraping.
3. **Non-invasive config footprint (`~/.config/cockpit`).** Orca writes into 8 third-party home dirs and carries the maintenance burden (9 installers, trust-hash sync, filename-scoped sweep, codex-0.129 coupling). Cockpit should adopt agent-hooks *only with eyes open* about this cost — and if it does, copy orca's mitigations (filename-scoped matchers, hash-matched cleanup) rather than the blast radius.
4. **Self-improving subsystems (learnings, LLM-wiki, self-heal-on-invoke).** Zero orca analog. Genuinely differentiating. Keep investing.
5. **Orchestration as an LLM session, not hardcoded code.** Orca's coordinator literally cannot decompose a spec (`coordinator.ts:201-206` — deferred to "a future phase where the coordinator itself is an LLM agent"). Cockpit's Command/Captain *are* that future phase already. This is a real lead — orca's roadmap is chasing where cockpit already is.

## B(iv) Concrete recommendations for cockpit (named subsystems/files)

1. **Close issue #86 with an orca-style resume artifact, not just process supervision.** In `cockpitd`'s per-task JSON state store, persist a `resumeRef` on every state transition: for headless codex = the rollout/session id usable by `codex exec resume`; for `claude -p` = the `--resume` session id; for app-server = the `thread` id (`thread/resume`). On daemon bounce, the state machine's recovery path re-attaches via `resumeRef`, mirroring orca's "final checkpoint snapshot." Add a daemon **protocol version** constant (orca `types.ts:6`) so a child can outlive a cockpitd upgrade, and **coalesce concurrent restarts** (orca `daemon-init.ts:40-46`).

2. **Add a `normalizeProviderEvent(provider, rawEvent) -> CanonicalEvent` seam with compile-time exhaustiveness**, feeding `reduce()`. Model it on `agent-hook-listener.ts:1274-1342` (per-source function + `never`-guarded switch). Canonical set should map cleanly to cockpit's existing states; keep `TurnCompleted`/`Stop` classified as *liveness*, gated to *completion* only by an explicit terminal event — the invariant survives the new seam.

3. **Refactor the watchdog to dispatch-attempt granularity.** In the per-task state, model attempts as sub-records each with their own `lastHeartbeatAt` and a `circuitBroken` flag after N failures (orca `coordinator.ts:274-301`, "sling pattern"). Adopt **warn-don't-autofail** as the default stale policy (orca `:227-231`) — surface to Captain, don't kill.

4. **For the codex-interactive fork: orca's evidence tilts toward app-server, not orca's own hook path.** Reason: orca only uses codex hooks because it's *already* hosting the TUI for a human; cockpit's interactive codex has no human-attached TUI requirement that forces the pty model, and orca's `codex-fetcher.ts:88-261` proves a clean app-server JSON-RPC client works (mandatory ordered handshake: `initialize`→await→`initialized` *notification*→methods; newline-framed; id-less = notification; envelope-wrapped results). Take orca's hook-trust gotcha as a *general* warning (codex silently degrades when config preconditions unmet → make daemon "ready" contingent on a successful app-server `initialize` round-trip, not just child-spawned).

5. **Adopt the decision-gate primitive in the Captain layer.** A first-class `gate{pending|resolved|timeout}` state that blocks a task's DAG node, surfaces a structured question to the human (cockpit's semi-automatic ethos), and injects the resolution into the next Crew dispatch. Orca's `gate-create`/`gate-resolve` + "resolution context included in the next dispatch preamble" is the exact shape.

6. **Steal the foot-gun catalogue verbatim into cockpit's runtime drivers:** non-interactive flags that kill a hosted session (`codex --ephemeral`, copilot `--prompt`), argv-vs-stdin for large prompts (`commit-message-agent-spec.ts:251-253`), node-pty NAPI dispose-before-kill (`local-pty-provider.ts:39`) if cockpit ever pty-hosts, and session-id-shape-change as a recurring break source (orca #1148) — cockpit's `resumeRef` from rec #1 must be treated as an opaque hashed token, not parsed.

---

## Appendix — Honest uncertainty

- Shallow clone (`--depth=1`); historical "why" is from in-code comments + bug-ref numbers, not git log. Bug numbers (#1437, #1148, etc.) are referenced in comments; I did not fetch the PRs.
- `db.ts` (33 KB) and `orca-runtime.ts` (369 KB) were sampled at the load-bearing call sites, not read in full — orchestration DAG-promotion and the full sendTerminal path are evidenced but the entire 369 KB runtime was not exhaustively read.
- Mobile/relay E2EE flow studied at the runtime-rpc seam, not into the React Native client.
- Orca's *internal* design docs (`docs/design/agent-status-over-ssh.md`, `DESIGN_DOC_PREAMBLE_FIX.md`, `daemon-staleness-ux.md`) are referenced by comments but several are not present in this shallow checkout; claims tied to them rest on the comment text quoting their section numbers.
