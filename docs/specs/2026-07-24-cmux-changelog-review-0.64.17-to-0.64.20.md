# cmux changelog review — 0.64.17 → 0.64.20

**Date:** 2026-07-24
**Role:** research side-session
**Baseline:** `packages/shared/src/lib/compat-manifest.ts:5` → cmux `{ min: "0.64.0", lastVerified: "0.64.17" }`

Legend: **[V]** = verified against the local binary/bundle/logs. **[R]** = read from release notes / PR bodies / issues only.

---

## 0. The version discrepancy — resolved

**cmux did not update. It has been *asking* to update for four days.**

| Fact | Evidence |
|---|---|
| Installed: `0.64.17 (97) [9ed29d81a]` | **[V]** `cmux --version`; `CFBundleShortVersionString=0.64.17`, `CFBundleVersion=97` |
| Bundle untouched since Jun 23 | **[V]** `Contents/` mtime `Jun 23 17:53`; bundle moved into place `Jun 24 08:44` |
| Latest is `0.64.20` (build 100), 2026-07-19 | **[V]** Sparkle appcast at `.../releases/latest/download/appcast.xml` |
| We are missing **three** releases | **[V]** `gh release list`: v0.64.18 (Jul 14), v0.64.19 (Jul 14), v0.64.20 (Jul 19) |
| cmux has known about 0.64.20 since **2026-07-20T03:11:59Z** | **[V]** `~/Library/Logs/cmux-update.log`: `state -> updateAvailable(0.64.20)`, re-confirmed hourly ever since |
| It will never self-install | **[V]** `defaults read com.cmuxterm.app`: `SUAutomaticallyUpdate = 0`, `SUEnableAutomaticChecks = 1`, `SULastCheckTime` moved 02:32Z → 03:32Z during this session |
| Nothing was ever downloaded | **[V]** `~/Library/Caches/com.cmuxterm.app/org.sparkle-project.Sparkle/{PersistentDownloads,Installation,Launcher}` all empty, dated Jun 24 08:44 (the last successful install) |

So `lastVerified: "0.64.17"` is still accurate for what is running. **Nothing changed underneath us.**

### Latent hazard: this build's in-app updater is the known-broken one

**[V]** `Contents/Frameworks/Sparkle.framework` → **2.8.1**; `otool -l .../Updater.app/Contents/MacOS/Updater` → `sdk 15.5`. Host is macOS 26 (`DTPlatformVersion 26.5`, Darwin 25.5.0).

That is the exact configuration in cmux issue #5123 / PR #6678 **[R]**: on macOS 26 the kernel's `AppleSystemPolicy` rejects the SDK-mismatched Sparkle progress agent, the `-spkp` service never registers, and the update fails with `SUSparkleErrorDomain(4005)`. Fixed in 0.64.18 by bumping Sparkle to 2.9.3.

**Not verified:** that an update attempt actually failed here. There is no Sparkle download cache and no local log evidence of a 4005. The empty cache is equally consistent with the user simply never accepting the prompt. Either way — **if the in-app update fails, install the 0.64.20 DMG manually**; the fix for the updater itself only ships *in* 0.64.18.

---

## 1. (a) Breaking / behavior-changing for squadrant

All of these are **prospective** — they activate only when we upgrade.

### A1. Blank/absent `--workspace` now resolves to the *caller*, not the focused workspace
PR #6757 (0.64.18) **[R]**. Resolver order becomes: explicit `--workspace` → caller's `CMUX_WORKSPACE_ID` → focused fallback.

**Touches:** every `cmux()` call in `packages/workspaces/src/runtimes/cmux.ts`. Our wrapper forwards `process.env`, so a squadrant CLI invocation *from inside a cmux pane* would leak `CMUX_WORKSPACE_ID` to the child.

**Risk: low.** **[V]** audited every invocation — all of `send`, `send-key`, `read-screen`, `tree`, `rename-tab`, `close-surface`, `new-surface`, `workspace-action`, `tab-action` pass `--workspace` explicitly. Only `--version` and `workspace list --json` omit it, and neither is workspace-scoped.

**Important negative result:** this does **not** fix #564. The daemon runs under launchd (**[V]** PPID 1, `com.squadrant.daemon`) with no `CMUX_WORKSPACE_ID`, so it lands on the unchanged focused fallback. See §3.

### A2. Control-socket access policy becomes live-reloading and fail-closed
PR #7988 (0.64.20) **[R]**. Introduces `SocketControlServerConfiguration`; policy changes reconfigure without rebinding, **policy generations revoke stale commands and event streams** after a mode or credential change, restrictive modes verify same-user peers *per command*, permission failures fail closed, and `mode = off` unlinks the listener.

**Touches:** `packages/core/src/daemon/delivery-loop.ts` (daemon-direct delivery) and any long-lived `cmux events` stream. Our daemon holds a long-lived relationship with the socket; a generation bump can now revoke an in-flight command or drop the event stream mid-run. **[V]** current access mode is `automation` (`cmux capabilities` → `"access_mode": "automation"`), which is the permissive end — but a Settings commit or `reload_config` can now change that live.

**Action on upgrade:** verify the delivery loop reconnects on a revoked stream rather than treating it as a dead cmux.

### A3. Surfaces and workspaces become user-reorderable by keyboard
PR #8080 (0.64.20) **[R]** adds shortcuts for moving the selected surface left/right and workspace up/down.

**Touches:** anything we cache keyed on positional refs (`surface:N`, `workspace:N`). Those refs drift on reorder. Relevant to #567. **Mitigation: key on UUIDs, not positional refs** (`--id-format uuids` / `both`).

### A4. Hidden terminal renderers are reclaimed under memory pressure
PR #7050 (0.64.18) **[R]** — on a `DispatchSourceMemoryPressure` warning/critical, every *hidden* realized terminal renderer is released immediately (visible ones are never selected).

**Touches:** `readScreen` / `readPaneScreen` against non-visible panes — which is the normal case for us. Notably, PR #7050's own baseline was measured on **this exact version**: `0.64.17 (97)`, 2060 MB app footprint, 4.55 GB child RSS across 150 processes.

**Action on upgrade:** confirm `read-screen` on a hidden pane still returns content after a reclaim, rather than an empty buffer. An empty screen read would be indistinguishable from a stuck agent in our delivery logic.

### A5. Claude hook layer substantially rewritten
**[V]** `gh api .../compare/v0.64.17...v0.64.20` — six *added* CLI hook files: `AgentHookNotificationPolicy`, `CMUXCLI+AgentHookCatalog`, `CMUXCLI+AgentHookRestoreEvidence`, `CMUXCLI+ClaudeHookDeliveryTarget`, `CMUXCLI+ClaudeHookWorkspaceRouting`, `CMUXCLI+ClaudePushNotificationHook`; plus modified `AgentHookDefinitions` (262 changes) and `CodexFireAndForgetHooks`.

**Touches:** squadrant's own hook-driven confirmation (#470/#471/#473) writes to the same `~/.claude/settings.json` that `cmux hooks claude` manages. Collision/ownership-matcher risk is real and **unassessed**. PR #6798 explicitly notes a known follow-up where re-install leaves stale inline duplicates that "dodge the ownership matcher."

**Action on upgrade:** diff `~/.claude/settings.json` before/after, and re-run the crew-lifecycle checklist.

### A6. Claude argv handling on session restore changed
PR #8070 (0.64.19) **[R]**. Adds `Policy.booleanOptions` so Claude boolean flags stop swallowing a following positional; `--bg`/`--background` are now **dropped on restore**; interactively-chosen permission mode is persisted and replayed as `--permission-mode <mode>` — but only when the preserved argv doesn't already carry one.

**Touches:** our captain/crew launch argv. **[V]** live example from `cmux sessions list --json`:
```
["/Users/q3labsadmin/.local/bin/claude", "--permission-mode", "auto", "--model", "opus",
 "--append-system-prompt-file", ".../templates/captain.claude.md", "--plugin-dir", ".../plugin"]
```
We already pass `--permission-mode` explicitly, so explicit-wins keeps our behavior. Worth a post-upgrade check that `--append-system-prompt-file` and `--plugin-dir` survive a restore intact (a dropped `--append-system-prompt-file` would silently un-brief a restored captain).

---

## 2. (b) New capabilities worth exploiting

### B1. 🔴 The biggest one needs **no upgrade at all** — `feed.list` + reply RPCs

**[V]** on the running 0.64.17:

```
$ cmux rpc feed.list '{}'
total items: 1375
kinds:     {toolUse: 994, stop: 155, toolResult: 91, userPrompt: 82,
            sessionStart: 23, sessionEnd: 20, question: 10}
statuses:  {telemetry: 1365, expired: 8, pending: 2}
fields:    created_at, cwd, id, kind, question_multi_select, question_options,
           question_prompt, questions, request_id, resolved_at, source, status,
           text, title, tool_input, tool_name, tool_result, tool_result_is_error,
           updated_at, workstream_id
```

A `kind: "question"` item with `status: "pending"` carries `request_id`, `question_prompt`, `question_options[]` (each with `id`/`label`/`description`), `question_multi_select`, `cwd`, `workstream_id`. **[V]** two such items are pending right now.

**[V]** the reply methods already exist in `cmux capabilities`: `feed.question.reply`, `feed.permission.reply`, `feed.exit_plan.reply` (plus `feed.push`, `feed.jump`, `feed.list`).

**Why this matters:** this is a direct, structured answer to *"is this pane safe to write to?"* — the question `#484`'s `hasModalOptionList` currently answers by **screen-scraping**. A `status == "pending"` check is:
- unambiguous (no "is this a selection list or a ghost draft?" guessing),
- immune to glyph drift — the failure class that caused **#499** (`Ask anything…` vs `Ask anything...`),
- and *answerable*: `feed.question.reply(request_id, option)` replaces typing into the pane and pressing Enter, which is what auto-confirmed the modal in **#484**.

Caveat: `feed list` is **not** exposed as a CLI subcommand on 0.64.17 (`cmux feed` only offers `tui`/`clear`) — reach it via `cmux rpc feed.list`. Only `source: "claude"` items were present in this sample; codex/opencode coverage is unverified.

### B2. 🔴 `cmux sessions list --json` — also already available, also undocumented

**[V]** on 0.64.17. Not listed in `cmux --help`; `cmux sessions --help` documents it. Reads `~/.cmuxterm/*-hook-sessions.json` and **explicitly does not require a running cmux socket**.

Per-session fields **[V]**: `agent`, `agent_lifecycle` (`"running"`), `session_id`, `pid`, `cwd`, `launch_working_directory`, `launch_arguments[]`, `started_at`, `active_for_surface`, `active_for_workspace`, `active_surface_session_id`, `active_workspace_session_id`, `active_prompt_turn_id`, `last_prompt_turn_id`, `runtime_status`, `session_dir`. Filters: `--agent --session --workspace --surface --cwd --limit --all --json`.

This is a **third ground-truth source** — exactly the row #567 asks for. `pid` + `agent_lifecycle` give OS-level truth; `started_at` gives generation; `active_prompt_turn_id` is a non-scraped "a turn is in flight" signal (relevant to the #492 turn-boundary class); `launch_arguments` identifies *which* squadrant role a session is (a captain is the one carrying `templates/captain.claude.md`).

### B3. Tree already reports the caller and the tty
**[V]** `cmux tree --json` returns a top-level `caller` block (`window_ref`/`workspace_ref`/`pane_ref`/`surface_ref`/`tab_ref`/`surface_type`) *alongside* `active`, and each surface carries `tty`. `cmux identify [--no-caller]` exposes the same. Useful for disambiguating "who am I" vs "what's focused" without heuristics.

### B4. Agent-session tracking rewrite — upgrade-gated
PR #6798 (0.64.18) **[R]**, the most directly relevant upstream work:
- **tree-aware liveness** — judged from the surface's *process tree*, not one recorded pid, so a dying launcher/`node` shim re-binds to the real agent instead of falsely ending the session;
- **observe-floor detection** — a throttled process-tree scan binds untracked claude/codex under a surface (claude via `--session-id`/`--resume` argv);
- the live send/list gate becomes **deterministic pid-liveness instead of the terminal-title heuristic**;
- resume re-bind keyed on the real `terminalPanel.id`, fired whenever a restored surface carries a resumable binding.

That is our LivenessRegistry problem, solved on the cmux side. Worth re-reading before we build more of #567 ourselves.

### B5. Smaller ones
- **`notifications.suppressOnlyFocusedSurface`** (PR #6893, 0.64.18) — narrows implicit notification auto-withdraw to the *exact focused surface*. Fits our notifier semantics better than today's workspace-wide withdraw.
- **Notify on fatal Codex turn errors** (PR #8170, 0.64.20) — a lifecycle signal we currently have no source for.
- **Diff viewer moved to a Rust sidecar** (PR #7804, 0.64.20) — touches our `showDiff` / `cmux diff -` stdin path (#604). Behavior-compatible per the notes, but our `--focus` handling should be re-smoked.
- **`workspace list --json` already exposes `latest_submitted_at` / `latest_submitted_message`** **[V]** on 0.64.17 — a per-workspace "last prompt actually submitted" timestamp. A cheap independent confirmation that a delivery landed.

---

## 3. Against the four open problems

### #590 — stuck delivery followed by daemon SIGTERM
**No cmux change explains this, and structurally none could.**

- We run 0.64.17. Nothing in 0.64.18/19/20 was ever executing on this machine. **[V]**
- The one cmux mechanism that *can* externally SIGTERM a process is cmux issue **#7490** (closed) **[R]**: macOS's kernel low-swap *"no paging space action"* SIGTERMs processes under swap exhaustion — reported on 0.64.17, with the app silently auto-relaunching. Attractive, because it would explain *both* halves of #590 (a thrashing machine makes deliveries defer *and* gets processes killed) as a common cause rather than cause-and-effect.
- **Ruled out for the 2026-07-20 12:41:19Z event** **[V]**:
  - cmux app pid **630 survived** — `cmux-update.log` shows its periodic probes continuing at `13:32:31Z`, `14:32:31Z`, `15:37:05Z`, `16:37:05Z` that day. A swap-exhaustion sweep takes the 2 GB app before a node daemon.
  - `last reboot` shows no reboot between Mon Jul 20 09:10 and Tue Jul 21 08:57 (local).
  - No `low swap` entries in 30 days of unified log.
  - Current state is tight but not swapping: 21 G used / 2.6 G unused, `vm.swapusage total = 0.00M`.
  - *(One weak signal, not evidence: the 12:20:38Z → 13:32:31Z probe gap is ~72 min against a 3600 s interval. Consistent with sleep or a stall in the window containing 12:41. Not load-bearing.)*
- cmux has **no process-tree path to our daemon**: **[V]** `squadrantd` is PPID 1, launched by LaunchAgent `com.squadrant.daemon` (`KeepAlive = true`, `ThrottleInterval = 10`). It is not a cmux child, so pane/workspace teardown and the quit watchdog (PR #6837) cannot reach it.

**Conclusion: the suspect list stays launchd-side.** Signal-source logging remains the right next step; cmux is not the culprit.

**Incidental find worth its own note** **[V]**: the LaunchAgent plist bakes a cmux-instance-scoped `PATH` entry —
`/var/folders/pz/.../T/cmux-cli-shims/66793AB2-FC1A-4017-8581-1EB2C747097E`
— which goes stale on any cmux restart. `/Applications/cmux.app/Contents/Resources/bin` is also on the path, so cmux resolution still works, but this is a real staleness bug in the #567 neighbourhood.

### Delivery deferral / #484 — better answer exists **today**
See **B1**. Replace the `hasModalOptionList` screen-scrape with `cmux rpc feed.list` → `kind == "question" && status == "pending"` scoped by `cwd`/`workstream_id`; optionally answer structurally via `feed.question.reply` instead of typing. No upgrade required. This removes a whole failure class (glyph drift, #499) from the delivery path.

### #567 — detecting cmux/system restart and remapping
Two halves:

1. **Buildable now:** `cmux sessions list --json` (**B2**) supplies pid + `agent_lifecycle` + `started_at` + `active_for_surface` per session, *without the cmux socket*. That is the missing reality column in #567's reconcile table, and it survives the case where cmux itself is down.
2. **Upgrade-time hazard:** cmux issue **#1984** (open) **[R]** — *"App update kills all terminal sessions — no session persistence across Sparkle restart."* Installing the pending 0.64.20 is precisely the #567 scenario, live and unhandled. **Land a remap-on-restart safety net before upgrading**, or expect the 2026-07-11 incident to repeat.
3. Key remapped state on **UUIDs**, not positional refs — see **A3**.

### #564 — `runtime read-screen` returns the focused tab
Solvable now, and **not** solved by upgrading:

- PR #6757 changes the *caller* fallback, which the daemon never hits (**A1**). **[V]**
- The fix is squadrant-side and the data is already there: resolve the captain's **surface UUID** via `cmux sessions list --json` (the session whose `launch_arguments` include `templates/captain.claude.md` for that project's cwd), then pass `--surface` explicitly. `cmux tree --json` also gives per-workspace surface refs with `title` (e.g. `⚓ scaffold-captain`) and `tty`. **[V]**
- The issue's proposed output header (`# captain: <name>`) can be populated from the same record, closing the "nothing says which one you got" gap.

---

## 4. (c) Irrelevant to us

The bulk of 0.64.18/0.64.20 by volume: iOS app / TestFlight / App Store lanes / Iroh transport, the web landing pages and SEO/IndexNow work, browser extension settings, Ghostty SSH wrapper paths, remote-tmux and ssh-tmux fixes, sidebar/AppKit rendering work, mobile chat UI, macOS 27 launch crashes, Sleepy Mode, scroll-delta handling, and the CI/Nightly pipeline changes.

---

## 5. Recommended order

1. **Do not upgrade yet.** Land a #567 remap-on-restart safety net first — cmux #1984 makes the upgrade itself the trigger.
2. **Adopt `feed.list` for delivery deferral (#484).** No upgrade needed; removes a failure class.
3. **Fix #564 with `sessions list --json` surface targeting.** No upgrade needed.
4. **Keep #590 on the launchd track.** cmux is exonerated; add signal-source logging.
5. **When upgrading:** manual DMG (the in-app updater on this build is the known-broken Sparkle 2.8.1/SDK-15.5 combo), then re-run the crew-lifecycle checklist with attention to A2 (socket policy/event-stream revocation), A4 (hidden-pane `read-screen`), A5 (`~/.claude/settings.json` hook collisions), and A6 (captain argv survives restore). Bump `lastVerified` only after that passes.
