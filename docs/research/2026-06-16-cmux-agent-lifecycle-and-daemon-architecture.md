# cmux agent-lifecycle detection & cockpit daemon architecture — research dossier

**Date:** 2026-06-16
**Purpose:** Brainstorm reference. Captures everything researched about (1) cmux socket reachability, (2) how cmux detects agent lifecycle, (3) implications for cockpit's relay + event-bridge, (4) a driver-agnostic `LifecycleSource` design, (5) running codex interactively via hooks instead of the app-server.
**Sources:** live probes on this machine (cmux 0.64.16, codex-cli 0.139.0), cmux docs (`docs/agent-hooks.md`, `notifications.md`, `feed.md`), and a source-level dive of `github.com/manaflow-ai/cmux@main` (Swift macOS monorepo). Related: issues #326 (compat backlog), #332 (deprecate relay), #114 (native codex TUI + hooks), #201 (codex first-turn hang).

---

## 1. cmux socket is now reachable from ANY process (relay no longer must live in cmux)

**Live-verified.** Running cmux with every cmux env var scrubbed (`env -i HOME PATH only` — simulates the launchd daemon, a non-cmux-descendant):
```
$ env -i HOME=$HOME PATH=$PATH cmux ping            -> PONG
$ env -i HOME=$HOME PATH=$PATH cmux workspace list  -> * workspace:3  ⚓ cockpit-captain ...
```
cmux auto-discovers a **canonical socket** at `~/.local/state/cmux/cmux.sock` (`CMUX_SOCKET_PATH`; moved out of Application Support in cmux #5176) and authenticates without inherited env/password.

**Consequence:** the premise behind cockpit's relay-proxy architecture — *"process-lineage denies all daemon-originated cmux calls"* — is **false** on 0.64.16. The daemon can call `cmux send/read-screen/workspace …` directly. → **#332** (deprecate notify-relay → daemon-direct). Closes the old #249 ("future non-cmux direct path") whose premise is now disproven.

---

## 2. How cmux detects agent lifecycle (the mechanism to learn)

cmux tracks a 4-state lifecycle per agent session: **`running | idle | needsInput | unknown`** (`Sources/AgentHibernation/AgentHibernationLifecycleState.swift`, `allowsHibernation = (state == .idle)`).

### 2a. Primary signal = HOOKS (source of truth)

cmux installs a hook into each agent's **native config**, fired by the agent on lifecycle transitions, routed **over the socket**:
```sh
"$cmux_cli" --socket "$CMUX_SOCKET_PATH" hooks <agent> <sub>   # || echo '{}'  (never blocks the agent)
```
Canonical event → state map (`CLI/CMUXCLI+AgentHookDefinitions.swift`, `subcommandActions`):

| Hook subcommand | Lifecycle | Trigger examples |
|---|---|---|
| `session-start`, `prompt-submit`, `shell-exec` | **running** | session begins / user prompt / tool starts |
| `stop`, `agent-response` | **idle** | turn ended |
| `notification`, `PermissionRequest` (feed, 120–125s sync) | **needsInput** | permission / blocking decision |
| `session-end`, `session-finalize` | teardown | process exit |

Hard rule (`Sources/Feed/FeedCoordinator.swift`): *an explicit running/idle/needsInput update from the agent always wins over any inferred state.* `needsInput` only relaxes to `running` on the next `prompt-submit`.

**Per-agent native install** (`cmux hooks setup <agent>` — 16 agents: codex, grok, opencode, pi, omp, amp, cursor, gemini, kiro, rovodev, copilot, codebuddy, factory, qoder, antigravity, hermes):

| Agent | Native file written | Events | Disable / config-dir env |
|---|---|---|---|
| **Claude Code** | *no persistent file* — per-launch PATH shim → `cmux-claude-wrapper` injects `--settings` hooks | SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/Notification/Stop/SessionEnd | `CMUX_CLAUDE_HOOKS_DISABLED=1` |
| **Codex** | `~/.codex/hooks.json` + `~/.codex/config.toml` (`codex_hooks=true`) | SessionStart→running, UserPromptSubmit→running, Stop→idle; feed: PreToolUse, PermissionRequest | `CMUX_CODEX_HOOKS_DISABLED=1`, `CODEX_HOME` |
| **Gemini** | `~/.gemini/settings.json` | SessionStart→running, BeforeAgent→running, AfterAgent→idle, SessionEnd | `CMUX_GEMINI_HOOKS_DISABLED=1` |
| **OpenCode** | `~/.config/opencode/plugins/cmux-session.js` (+ `cmux-feed.js`) | SDK plugin event bus (self-registered) | `CMUX_OPENCODE_HOOKS_DISABLED=1`, `OPENCODE_CONFIG_DIR` |

### 2b. Persistence: `~/.cmuxterm/<agent>-hook-sessions.json`

The same hook write mirrors to a durable JSON store (`Sources/RestorableAgentTypes.swift` `hookStoreFileURL`; override `CMUX_AGENT_HOOK_STATE_DIR`). Live schema captured on this machine (`claude-hook-sessions.json`):
```jsonc
{
  "activeSessionsBySurface": { "<SURFACE_UUID>": { "sessionId", "updatedAt" } },
  "activeSessionsByWorkspace": { "<WORKSPACE_UUID>": { ... } },
  "sessions": { "<sessionId>": {
      "agentLifecycle": "running|idle|needsInput|unknown",
      "cwd", "pid", "sessionId", "transcriptPath", "isRestorable",
      "lastBody": "Claude needs your permission", "lastSubtitle": "Permission",
      "launchCommand": { "launcher","executablePath","arguments","workingDirectory","environment","source" },
      "updatedAt"
  } }
}
```
**Source of truth = live socket events (`agent.hook.*`); the JSON store is the durable mirror** (same write produces both; they don't diverge by design). For an external daemon the **file is the more stable contract** (`version:1`), the socket stream is lower-latency but internal/less-stable.

### 2c. Hook-LESS fallback = liveness only, NOT lifecycle

When no hook is installed (`Sources/VaultAgentProcessScanner.swift`, `CmuxTopSnapshot.swift`):
- **libproc process scan** + `sysctl(KERN_PROCARGS2)` reads each PID's argv+env; binds process↔panel by matching `CMUX_WORKSPACE_ID`/`CMUX_SURFACE_ID` in its env; classifies claude/codex/opencode by binary basename/argv. → yields **liveness + identity only**; a purely process-detected entry gets `lifecycle: nil`.
- **tail + PID fingerprint** (last 12 lines + sorted PID set, stable across `confirmationSeconds`) → quiescence test for hibernation (`Sources/App/AgentHibernationController.swift`).
- **OSC 133** → shell command-block segmentation only. **OSC 9/99/777** → desktop notifications only. **Neither drives `agentLifecycle`** (the wrapper even disables Claude's OSC notif channel so hooks are the sole signal).

→ **`needsInput`/`running`/`idle` are hook-only.** Hook-less gives you "alive + quiescent", never "waiting for a human".

---

## 3. Implication for what cockpit shipped (#328 B1 / #331 B4)

- #328/#331 consume cmux's `agent.hook.*` socket events. Per §2a this **only fires for claude crews today** (claude auto-wraps; codex/gemini/opencode are NOT `cmux hooks setup`-installed on this machine → no events). Verified live: only `~/.cmuxterm/claude-hook-sessions.json` exists.
- This is **option (b)** in §4 — the most cmux-coupled, least-stable-wire path. Treat #328/#331 as a **claude stopgap**, not the durable design.

---

## 4. Driver-agnostic design: a `LifecycleSource` port

cockpit's stated goal: support multiple terminal drivers (cmux today, others later) without lifecycle detection dying on a driver swap. The user built the daemon precisely to avoid hard cmux-coupling — that concern is **validated** (cmux lifecycle = cmux hooks + cmux socket + cmux file).

Define a `LifecycleSource` port in cockpitd, two implementations behind it:

| Option | What | Pro | Con |
|---|---|---|---|
| **(A) CmuxStoreSource** *(ship now, as adapter)* | watch `~/.cmuxterm/<agent>-hook-sessions.json`, read `agentLifecycle`, verify `pid` liveness yourself | simplest; **16 agents free**; stable `version:1` schema; matches live reality | cmux-coupled (file vanishes if cmux swapped) |
| **(B) Socket `agent.hook.*`** | subscribe to cmux event bus | push, low-latency | most coupled + least-stable wire; **avoid as primary** |
| **(C) NativeHookSource** *(build incrementally, = the core)* | cockpit installs its OWN hooks into each agent native config (mirror `AgentHookDef`) → `cockpitd hooks <agent> <sub>`; + own `KERN_PROCARGS2` scan keyed on `COCKPIT_CREW_TASK_ID`/`COCKPIT_SURFACE`; + OSC 9/777 as universal turn-end hint | fully portable; survives cmux swap | reimplements cmux's installer + per-agent template matrix; risk of double-hook collision with cmux |

**Recommendation: hybrid (A)+(C) behind the port.** Ship (A) as the cmux *driver adapter* now (cheapest accurate lifecycle for 16 agents). Build (C) as the driver-agnostic core. Both feed ONE normalized reducer using cmux's exact event→state map (§2a), honoring "explicit agent update wins". Process-scan + fingerprint = liveness/quiescence layer only, never a substitute for hook-only `needsInput`. This also folds into #332 (daemon-direct): the same daemon that drops the relay-proxy can read `~/.cmuxterm` + drop screen-scraping in one refactor.

---

## 5. Codex: run interactively via hooks instead of the app-server (big gap)

### Today
cockpit runs codex **not interactively**: `codex exec --json --skip-git-repo-check --sandbox workspace-write [task]` (one-shot/print, `src/control/headless/codex.ts`) plus an **app-server JSON-RPC client** (`src/control/codex/app-server-client.ts`). Code comment: *"until the interactive-wiring spec lands."* This is why codex crews can't take `cockpit crew send` follow-ups and why lifecycle/signal was fragile. Original blocker (memory): *"codex PARKED — signal lifecycle blocked by its workspace-write sandbox"* — `cockpit crew signal` (a shell call from inside the sandboxed codex) was denied.

### What changed
- **codex-cli 0.139.0 has a native hooks system** — verified live: `--dangerously-bypass-hook-trust` ("run enabled hooks without requiring persisted hook trust"), i.e. hooks + a **trust** model. This is the API cmux uses (`~/.codex/hooks.json` + `config.toml codex_hooks=true`).
- cmux runs **bare interactive `codex` (TUI)** and gets lifecycle from these hooks — **no app-server, no JSON-RPC**.

### The unlock
cockpit can adopt cmux's pattern: **interactive `codex` TUI in a cmux surface + install `~/.codex/hooks.json`** (SessionStart→running, Stop→idle, PreToolUse/PermissionRequest→needsInput). Crucially this **sidesteps the original sandbox blocker**: lifecycle now comes from codex's own (trusted) hook process reporting out, NOT from a `cockpit crew signal` shell call the sandbox blocks. → drop the app-server complexity, gain multi-turn `crew send`, unify codex with the claude/opencode lifecycle model. This is exactly **issue #114** ("Hybrid: native codex TUI + hook-based daemon tracking, replaces #102").

### Caveats to brainstorm
- **Hook trust:** codex requires persisted hook trust (or the `--dangerously-bypass-hook-trust` flag — avoid; the user rejects "dangerously" flags). Need to find how codex persists hook trust and trust cockpit's hook once at setup.
- **First-turn hang #201** must be handled in interactive mode.
- **Collision:** if both cmux and cockpit install codex hooks, dedupe (cmux uses `~/.codex/hooks.json`; cockpit's NativeHookSource (§4C) could reuse or namespace).
- Decide: cockpit installs its OWN codex hooks (option C, portable) vs relies on `cmux hooks setup codex` + reads `~/.cmuxterm/codex-hook-sessions.json` (option A, coupled).

---

## 6. Open questions for the brainstorm
1. Port boundary: what's the minimal `LifecycleSource` interface (events? poll? both)? How does the reducer reconcile A vs C when both report?
2. Migration: do #328/#331 get refactored behind the port, or kept as the cmux adapter and wrapped?
3. Relay (#332): fully retire, or keep a thin in-process notification-delivery piece? Daemon-direct `cmux send` must re-home the #258/#302 defer-while-typing logic.
4. Codex (#114): cockpit-owned hooks (portable) vs lean on cmux's codex hooks (coupled)? Trust handling without dangerous flags?
5. Hibernation (C2, #329): if cockpit reads `~/.cmuxterm`, a hibernated crew must read as alive — reconcile with cmux's `allowsHibernation == idle`.
6. Driver abstraction (#31): does the `LifecycleSource` port slot under the existing runtime/workspace/notifier plugin model?

---

## Key cmux source files (manaflow-ai/cmux@main)
- `Resources/bin/cmux-claude-wrapper` — claude PATH-shim hook injection
- `CLI/CMUXCLI+AgentHookDefinitions.swift` — per-agent native templates, event→subcommand map, socket-routed hook command
- `Sources/RestorableAgentTypes.swift` / `RestorableAgentSession.swift` — `~/.cmuxterm/<agent>-hook-sessions.json` path + record schema + live-PID filter + process-detected merge
- `Sources/AgentHibernation/AgentHibernationLifecycleState.swift` — the 4-state enum
- `Sources/Feed/FeedCoordinator.swift` — socket-event reducer / needsInput attention / "explicit update wins"
- `Sources/VaultAgentProcessScanner.swift`, `Sources/CmuxTopSnapshot.swift` — hook-less process scan (liveness/identity only)
- `Sources/App/AgentHibernationController.swift` — tail+PID fingerprint quiescence
- `Sources/CmuxEventPublishing.swift` (+ `docs/events.md`) — `agent.hook.*` socket bus (option B)
