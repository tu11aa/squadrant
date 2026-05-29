# Cockpit Claude Interactive Through Daemon — Design

**Date:** 2026-05-26
**Status:** Approved design, pre-implementation. Brainstormed in-session 2026-05-26.
**Predecessors (read first):**
- `docs/specs/2026-05-17-cockpit-control-plane-design.md` — control-plane foundation (esp. §"Architecture", anti-#2576 invariant at line 109, deferred legacy-re-pointing at line 76, walkthrough ② "Interactive observable" at line 122)
- `docs/specs/2026-05-20-cockpit-interactive-codex-design.md` — reference architecture being mirrored for Claude
**Cross-refs:** closes the **interactive-claude slice** of #64 (crew→captain completion signal). Does not close the headless slice of #86 (open follow-up).

---

## 1 · Problem & non-goals

**Problem.** When a Claude crew finishes work, the captain has no reliable signal. The captain polls `cockpit crew read` (cmux pane scraping) and uses fragile proxies — like polling `git log` for known commit subjects — which false-fires the instant expected SHAs exist *even when the crew is still mid-restructure*. Field evidence: 2026-05-18 OnePlan session, where the captain repeatedly review-tripped on premature "DONE" while the crew was doing post-commit git surgery (#64 follow-up comment, 2026-05-17). Result: human in the loop has to manually settle-check (`cockpit crew read` idle + `git status` clean + `git log` re-read) every wave.

The control-plane (PR #85) gave codex this signal — `cockpit crew chat --provider codex` dispatches a TaskRecord through `cockpitd` and the captain learns terminal state via `cockpit crew status`. Phase 2 (PR #98) wired the codex `app-server` driver. **Claude still goes through the legacy cmux-only path** (`crew.ts:163-200`) — it never registers a TaskRecord, the daemon never sees it, the captain still scrapes.

**Goal.** Make `cockpit crew spawn --agent claude` daemon-supervised. A captain dispatching a Claude crew gets exactly what they get for codex today: a TaskRecord in the store, normalized `task.started`/`task.progress`/`task.done` events on the bus, terminal state queryable without scraping. Same surface, mirrored mechanism.

**Mechanism.** Claude's native Stop/SubagentStop/SessionEnd hooks already exist (`src/control/interactive/claude.ts::mergeClaudeHooks`) — built during PR #85 but never wired into the spawn path. The Claude crew runs in a cmux tab as today (no daemon-owned child process — that's the codex pattern; Claude already has the cmux tab as its observable surface). The daemon's only new role is **receiving normalized hook events** posted from `cockpit crew _hook` (today a no-op stub; this spec makes it functional).

**Non-goals (YAGNI — explicitly out):**
- Headless Claude (`claude -p`). Daemon already owns headless via `runHeadless` (`src/control/headless-launcher.ts`) — that path is fine. This spec is interactive only.
- Codex / Gemini / Aider / opencode interactive. Codex already shipped (PR #98); the rest stay as today.
- A streaming `attach` channel for Claude. Codex needed it because the codex client lives outside the cmux tab; for Claude the cmux tab *is* the renderer. Captain reads streamed deltas via `cockpit crew read` (legacy, unchanged) — no daemon streaming verb needed.
- Captain-side reactor / nudge / Telegram surface. Those subscribe to `task.done`/`task.blocked` as separate downstream specs (the bus exists after this spec).
- Replacing legacy `crew send`/`crew read`/`crew close`. They keep working verbatim against the cmux tab. The new lifecycle (`dispatch`/`status`/`signal`) is **additive**.
- Killing the Claude process from the daemon. The daemon owns no Claude PID; the cmux tab owns it. Daemon supervision = state ledger, not process control.

---

## 2 · Lessons from prior attempt (PRs #71, #69, #67 — scrapped 2026-05-16)

PRs #71 (`feat(crew): crew completion reliability`), #69 (design spec for #64), and #67 (Telegram remote control spec) were closed 2026-05-16 with the comment *"Scrapping — 2026-05-15 research/impl quality unusable. Fresh start, see #64."* The scrap was about **quality, not architecture** — the four-layer split (detection adapter / sentinel / reactor / driver contract) was directionally correct. What this spec keeps and what it discards:

| Prior layer | Decision now | Why |
|---|---|---|
| Plugin Stop/SubagentStop hook firing a cockpit command | **KEEP** (mechanism unchanged; the `mergeClaudeHooks` helper already in tree was extracted from this work) | Native Claude surface, no alternative |
| `cockpit crew-signal` CLI emitting normalized JSON | **KEEP renamed `cockpit crew signal`** (subcommand, not standalone) | Resurrecting the *interface* but routed through the daemon socket, not file sentinels |
| Sentinel files in `~/.config/cockpit/state/<project>/<crew>.<state>.json` | **DISCARD** | The control-plane store (PR #85) *is* the sentinel now. Parallel sentinel files = duplicate truth. |
| Reactor backstop that scans sentinels each cycle | **DISCARD** | Daemon already surfaces state via `cockpit crew status`. Reactor will subscribe to bus events in a separate spec, not poll files. |
| `AgentDriver.crewSignal?()` per-provider contract | **DISCARD** | The contract is the normalized event vocabulary on the daemon socket. Per-provider logic = hook-to-event translation, which lives in `src/control/interactive/<provider>.ts` (Approach 3, spec §"Provider Adapters"). |
| `COCKPIT_CREW` env gate on the hook | **KEEP as `COCKPIT_CREW_TASK_ID`** | Same purpose (no-op the hook outside spawned crews); now carries the daemon's `taskId` directly so the hook can POST without a project/crew-name lookup. |

**The 2026-05-17 follow-up insight (issue #64 comment) is load-bearing for the anti-#2576 design:** completion signal must assert "crew is idle AND working tree is settled," not just "a process exited." The git-restructure-after-last-commit window is exactly where a naive Stop-hook-as-done lies. This spec honors that by making bare `Stop` = `task.progress` (liveness only) and requiring **explicit** `cockpit crew signal done` to terminate — the crew runs the signal *after* its own `git status`-clean check, codified in the template.

**One root cause of the original quality slip** (per memory `project_claude_mem_observer_bug.md` and the May-2026 reset note): 18-file PRs spanning command/driver/sentinel/reactor/hooks with no atomic boundaries. This plan ships in ~9 atomic tasks, each in one commit, with one verifiable change.

---

## 3 · Approach (single phase, surgical)

One branch: `feature/claude-interactive-through-daemon`. Five mechanical changes that compose into the goal. No standalone smoke gate (unlike codex Phase 1) because the constituent parts are all already in tree — this work is about wiring, not new protocol implementation.

**Boundary.** This spec touches:
- `cockpit crew spawn --agent claude` — adds `cockpitdCall(dispatch)` before the cmux tab opens; passes `taskId` into the tab via env.
- `src/control/interactive/claude.ts` — `mergeClaudeHooks` is finally called at spawn time (per-crew, not global, so non-cockpit Claude sessions stay clean).
- `src/control/cockpitd.ts` — `launchInteractive` for `provider="claude"` is added (a thin in-process driver — does not spawn anything, just records `task.started`; the cmux tab does the actual launching).
- `src/commands/crew-control.ts` — `_hook` stub becomes functional; new `signal` subcommand added.
- Templates — `crew.claude.md` + `crew.generic.md` get a "before exiting, run `cockpit crew signal done`" step.

**Approach 3 boundary preserved:** daemon owns headless children by PID (already true); receives normalized hook events for interactive (codex via app-server; Claude via Stop hook bridge — *this spec*). No new protocol verbs. No new socket framing. The hook bridge POSTs the existing `{kind:"event", project, event:ControlEvent}` request that the daemon already handles (`src/control/daemon.ts:73-79`).

---

## 4 · Architecture

```
   ┌──────────────────────────────┐
   │ captain (in cmux tab)         │
   │ cockpit crew spawn --agent    │
   │   claude <project> "<task>"   │
   └───────┬──────────────────────┘
           │ 1. cockpitdCall(dispatch)
           ▼
   ┌──────────────────────────────┐         ┌─────────────────────────┐
   │ cockpitd                      │ <─POST──┤ cockpit crew _hook Stop │
   │ • TaskRecord created           │  4.    │ (in crew's cmux tab,    │
   │ • launchInteractive(claude)    │ event  │  invoked by Claude's    │
   │   = no-op driver (records      │        │  native Stop hook)      │
   │   task.started; cmux tab does  │        └─────────────────────────┘
   │   the real launching)          │                ▲
   │ • merges Stop/SubagentStop/    │                │ Claude's native hook
   │   SessionEnd hooks into the    │                │ fires after every turn,
   │   per-crew settings.json       │                │ session-end, subagent-end
   └────────┬─────────────────────┘                │
            │ 2. open cmux tab                       │
            │    env: COCKPIT_CREW_TASK_ID=<id>      │
            │    settings dir: COCKPIT_PROJECT_DIR   │
            │    --settings <merged>                 │
            ▼                                        │
   ┌──────────────────────────────┐                │
   │ cmux tab (crew)               │ ────────────────┘
   │ claude <flags>                 │
   │   --append-system-prompt-file  │
   │   --settings <per-crew merged> │
   │   <task as first prompt>       │
   └────────────────────────────────┘
            │ 5. when actually done (idle + tree clean):
            │    `cockpit crew signal done`
            ▼
   ┌──────────────────────────────┐
   │ cockpitd                      │
   │ task.done → state=done        │
   └──────────────────────────────┘
            │ 6. captain reads:
            ▼
       cockpit crew status <project> <id> → {state: "done", ...}
```

**Five mechanical wires, no new protocol.** The arrows numbered 1, 2, 4, 5, 6 are all existing daemon verbs or socket calls.

### 4.1 Per-crew settings.json merge — not global

The scrapped PR #71 used `plugin/hooks/hooks.json` that fires for *any* Claude session loading the cockpit plugin — i.e. it would have polluted captain and command sessions too. The cleaner pattern (already enabled by Claude's CLI):

1. At spawn time, write `~/.config/cockpit/state/<project>/<taskId>/settings.json` containing the merged hooks (via `mergeClaudeHooks({}, "cockpit crew _hook")`).
2. Pass `--settings <that-path>` to the spawned `claude` command (Claude's CLI honors a per-invocation settings override).
3. The hook fires only inside that crew's process — captain and command sessions are untouched.
4. The hook payload arrives on `cockpit crew _hook`'s stdin; the `COCKPIT_CREW_TASK_ID` env var (set on the cmux tab) tells it which task to POST against.

This is **the** clean fix for the original "global vs per-crew hook" tension. It is enabled by Claude CLI's `--settings` flag (verified: present in claude-cli ≥0.45) — if that flag turns out to be wrong-named in the version in use, the fallback is to write to `$HOME/.config/cockpit/state/<project>/<taskId>/.claude/settings.json` and `cd` the spawn there, which Claude reads as project-scoped settings. The plan's Task 1 includes a CLI probe to confirm the flag name before any other task runs.

### 4.2 The `_hook` bridge — already-stubbed verb made functional

`src/commands/crew-control.ts:165-170` already registers `cockpit crew _hook <event>` as hidden. Today it just prints `hook:${event}`. The functional version:

```
cockpit crew _hook <event>   # event ∈ Stop | SubagentStop | SessionEnd
  reads Claude hook JSON from stdin (Claude's hook contract: { session_id, transcript_path, ... } on Stop/SubagentStop; { session_id, reason } on SessionEnd)
  if no COCKPIT_CREW_TASK_ID env → exit 0 silently (defensive: hook accidentally fires outside a crew)
  maps event → ControlEvent:
    Stop, SubagentStop → task.progress (anti-#2576: liveness, NEVER done)
    SessionEnd         → task.progress (NOT task.done — Claude can exit unexpectedly; explicit signal still required)
  POSTs {kind:"event", project: <from env>, event: <normalized>} to cockpitd socket
  exit 0 (hook contract: non-zero blocks Claude)
```

**Anti-#2576 invariant baked in here.** The temptation is to make `Stop` = `task.done`. That is exactly the trap. A Claude turn ends with `Stop` after every single message it sends, not at task end. `SessionEnd` is closer to "done" but fires on user `/exit`, `Ctrl-C`, OOM crashes, etc. — none of which mean the *task* is done. The only reliable "done" comes from the crew explicitly running `cockpit crew signal done` after its own settle-check, exactly mirroring the spec line 122 walkthrough ② for Claude default.

### 4.3 The `signal` verb — the explicit done-signal

```
cockpit crew signal done [--message <m>]
cockpit crew signal blocked --question <q>
cockpit crew signal failed --error <e>
```

Reads `COCKPIT_CREW_TASK_ID` + `COCKPIT_CREW_PROJECT` from env. POSTs the matching ControlEvent (`task.done` / `task.blocked` / `task.failed`) to the daemon. Exit 0 on success; non-zero with stderr on failure (e.g. daemon unreachable).

**Idempotent** (terminal states absorb in the state machine — `src/control/state-machine.ts`): a crew that signals twice or after the daemon has already declared `failed` from a different path gets a no-op success. The captain never sees double-`done`.

The `signal done` command emits `task.done` with `resultRef` set to a small fixture (the optional `--message` text, written to `~/.config/cockpit/state/<project>/_results/<id>.txt`) so `cockpit crew status` can render something useful without scraping the cmux tab.

### 4.4 `launchInteractive` for Claude — minimal in-process driver

`src/control/cockpitd.ts:155` currently throws for any `provider !== "codex"`. This spec adds a Claude branch that does **almost nothing**:

```
launchInteractive: async (rec) => {
  if (rec.provider === "codex") return codexDriver.dispatch(rec);
  if (rec.provider === "claude" && rec.mode === "interactive") {
    // The cmux tab does the actual launch. The daemon only ledger.
    ingest(rec.project)({ type: "task.started", id: rec.id });
    return;
  }
  throw new Error(`interactive mode is not yet implemented for provider '${rec.provider}'`);
}
```

No `ClaudeInteractiveDriver` class. No PID tracking. The daemon doesn't own a Claude process. State transitions arrive entirely via the hook bridge. **This is the same shape as spec §"Architecture" line 47-52 "INTERACTIVE path" already specified** — the daemon doesn't own interactive PIDs; it owns the *event stream*.

---

## 5 · Event mapping

Two surfaces produce daemon events for a Claude crew:

| Source | Trigger | ControlEvent | Effect on state |
|---|---|---|---|
| Spawn-time dispatch | Captain runs `cockpit crew spawn --agent claude …` | (`{kind:"dispatch"}` not an event) | `submitted` → store; `launchInteractive` emits `task.started` |
| `launchInteractive` (claude branch) | Daemon receives the dispatch | `task.started {id}` | `submitted → working` |
| Claude `Stop` hook | After every assistant turn ends | `task.progress {id, note:"stop"}` | liveness tick; stays `working` |
| Claude `SubagentStop` hook | After a sub-agent turn (Agent Team) ends | `task.progress {id, note:"subagent-stop"}` | liveness tick |
| Claude `SessionEnd` hook | User `/exit`, `Ctrl-C`, CLI crash, OOM | `task.progress {id, note:"session-end"}` | liveness tick — **NOT terminal** (anti-#2576; we cannot tell if work was done) |
| `cockpit crew signal done` | Crew explicit | `task.done {id, resultRef}` | `→ done` |
| `cockpit crew signal blocked` | Crew explicit | `task.blocked {id, reason, question}` | `→ blocked` |
| `cockpit crew signal failed` | Crew explicit | `task.failed {id, error}` | `→ failed` |
| Watchdog | `now - lastHeartbeat > heartbeatBudgetMs` while `working` | (synthesized in `evaluateStall`) | `→ stalled` |

**The mapping is intentionally lossy on the hook side and explicit on the signal side.** The cmux tab carries Claude's full output — the daemon doesn't need to mirror it. The daemon's job is *state*, not *content*. Captain reads content via `cockpit crew read` (unchanged); state via `cockpit crew status` (new for Claude).

**SessionEnd is a deliberate liveness-only mapping** because SessionEnd is not unambiguous: a user could `/exit` mid-task by accident. If the user actually wants to terminate (success/fail), the crew template instructs an explicit signal before exit. If SessionEnd fires without prior signal, the task stays `working` and the watchdog will eventually mark it `stalled` — that's the right level of "something went wrong" without fabricating `done`.

---

## 6 · TaskRecord lifecycle (worked example)

A captain spawns a crew: `cockpit crew spawn alpha "fix the typo in README.md" --agent claude`.

1. **t=0 dispatch.** `crew.ts::runCrewSpawn` builds a `TaskRecord` (`provider:"claude"`, `mode:"interactive"`, `state:"submitted"`, `task:"fix the typo..."`, `cwd:proj.path`), POSTs `{kind:"dispatch", record}` to cockpitd. Daemon stores it.
2. **t=10ms launchInteractive.** Daemon calls the Claude branch, emits `task.started` → state-machine reduces `submitted → working`. `lastHeartbeat = t`.
3. **t=20ms cmux tab opens.** `crew.ts` writes the per-crew settings.json with `mergeClaudeHooks({}, "cockpit crew _hook")`, then runs `runtime.sendToPane(pane, "claude --append-system-prompt-file <role> --settings <per-crew> ...")` with env `COCKPIT_CREW_TASK_ID=<id> COCKPIT_CREW_PROJECT=alpha`. Sends the task as first prompt 3s later (existing `CLI_BOOT_DELAY_MS`).
4. **t=3s..30s working.** Claude makes edits, runs `git add`, `git commit`, etc. After each assistant turn, Claude's Stop hook fires `cockpit crew _hook Stop` (inheriting env from the cmux tab). The hook POSTs `task.progress`. Each event refreshes `lastHeartbeat` — watchdog stays quiet.
5. **t=35s crew settle-check.** Crew (per template) runs `git status` — clean. Runs `cockpit crew signal done --message "typo fixed in commit abc1234"`.
6. **t=35.05s done.** Daemon receives `{kind:"event", event:{type:"task.done", id, resultRef:"~/.config/cockpit/state/alpha/_results/<id>.txt"}}`. State-machine reduces → `done`. Store written.
7. **t=36s captain reads.** Captain runs `cockpit crew status alpha <id>` → `{state:"done", resultRef:"…/<id>.txt", lastEvent:"task.done"}`. Captain reads `resultRef` for the message; merges the branch; closes the cmux tab. **No `crew read` scraping anywhere in the loop.**

**Walkthrough ② hang detection.** Same as codex/claude headless: `working` with no events for `heartbeatBudgetMs` (default 5 min) → watchdog declares `stalled`. Captain `status` shows it. Recovery is out of scope (deferred).

**Walkthrough ③ daemon bounce.** Claude crew in cmux tab keeps running (daemon doesn't own its PID — that's launchd-level cmux behavior). On daemon restart, `reconcile` (`src/control/daemon.ts:123`) sees the interactive task as `working` with no pid → marks `stalled` (conservative). When the next Stop hook fires, the `task.progress` event recovers `stalled → working` (`recoverStall` in `src/control/watchdog.ts`). No lost work, conservative state, eventually self-heals. This is acceptable because the cmux tab's output is the durable record of what the crew did; daemon state is a ledger.

---

## 7 · Edge cases & error handling

| Failure | Behavior |
|---|---|
| Daemon down at dispatch | `cockpitdCall` retries via `ensureDaemon` (existing path); fails loud with "control plane unavailable" — captain *cannot* spawn a crew that can't be tracked. Refusal-to-degrade. |
| Daemon down mid-task | Cmux tab keeps running; hook POST returns ECONNREFUSED → `_hook` exits 0 silently (non-zero would block Claude). Events are lost during the window; daemon `reconcile` on restart marks task `stalled`; next Stop hook recovers it. Acceptable loss: liveness only, no terminal signals dropped because terminal signals come from explicit `signal` (which the crew can retry or the captain can see absence of via `status`). |
| `_hook` invoked outside a crew (no `COCKPIT_CREW_TASK_ID`) | Silent exit 0. Defensive: if someone forgets to scope settings.json to per-crew, the hook still doesn't crash Claude. |
| `signal done` invoked with no env | Exits non-zero with "not running under a crew (COCKPIT_CREW_TASK_ID unset)" — explicit error because this is an interactive command, not a hook. |
| Crew uses `/exit` without `signal done` | `SessionEnd` → `task.progress` only. Watchdog eventually → `stalled`. Captain sees stalled task in `cockpit crew tasks`, scrapes pane to learn what happened (degraded but correct). |
| Crew uses `/exit` after `signal done` | Terminal state absorbs the late `task.progress` from `SessionEnd`. No double-emit. |
| Spawned with the same `--name` twice | Existing guard (`crew.ts:117`) throws before dispatch — daemon never sees a duplicate. |
| `--settings` flag wrong-named in this Claude version | Plan Task 1 probes for it; if absent, fall back to per-crew project-scoped settings dir + `cd`. Plan documents the decision tree. |
| Hook merge corrupts a user's existing per-crew settings | Per-crew settings file is daemon-generated each spawn; no user file at that path. `mergeClaudeHooks` is already idempotency-tested (`src/control/__tests__/interactive-claude.test.ts:16-22`). |
| Hook command unavailable on PATH inside cmux tab | The hook command is `cockpit crew _hook`. If `cockpit` is not on PATH, Claude logs the hook failure and continues — task stays `working`, watchdog flags `stalled` after threshold. Plan Task 1 includes a PATH-availability check in spawn. |

---

## 8 · Cross-references & follow-ups

- **Closes** the interactive-Claude slice of **#64** (crew→captain completion signal). The headless-Claude slice (`claude -p` mid-flight) is already closed by `runHeadless` (PR #85).
- **Sets up** the deferred legacy-re-pointing spec (spec line 76): once Claude crews are daemon-supervised, the captain-ops skill's "scrape `cockpit crew read`" guidance can shift to "query `cockpit crew status`". That migration is its own spec — this one ships the substrate.
- **Sets up** reactor/Telegram surfaces (the eventual #65 family): they subscribe to `task.done`/`task.blocked`/`task.stalled` on the bus that now exists for Claude.
- **Does not depend on** #87 (protocol schema validation), #92 (`PROTOCOL_VERSION`), #94 (keepalive framing). No new socket verbs — uses existing `{kind:"event"}` and `{kind:"dispatch"}`.
- **Follow-up spec:** captain-ops migration (consume `cockpit crew status` instead of `crew read` polling).
- **Follow-up spec:** `task.done` payload schema (today: free-text `resultRef`. Future: structured `{summary, branch, commits[]}` so reactor/Telegram can render nicely without re-parsing).
- **~~Open question, decided by Plan Task 1's CLI probe:~~ RESOLVED 2026-05-26:** `claude --help` confirms `--settings <file-or-json>` is supported on the local CLI (claude-cli probe via `probeClaudeSettingsFlag()` returns `"flag"`). All subsequent tasks use the happy path: per-invocation `--settings <per-crew-file>`. The `"project-dir"` fallback branch in the plan is dead code for this implementation.

---

## 9 · Success criterion

A captain runs `cockpit crew spawn alpha "fix the typo in README.md" --agent claude`. A Claude crew opens in a cmux tab and does the work. When done, the crew runs `cockpit crew signal done` and exits. The captain queries `cockpit crew status alpha <id>` and sees `state:"done"` *without ever calling `cockpit crew read`*. A hung crew (no `signal` for >5 min) shows `state:"stalled"` in `cockpit crew tasks alpha` deterministically. **The Claude interactive slice of #64 is closed.**
