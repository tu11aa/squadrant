# Changelog

All notable changes to Squadrant (formerly claude-cockpit) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0] - 2026-06-23

### Added
- **Tap-first Telegram commands (inline buttons).** `/notify`, `/effort`, and `/crews`/`/launch`/`/mute`/`/unmute` now reply with tappable button panels instead of needing typed arguments — pick from buttons, no syntax to remember. Button taps are gated on your user-id (remoteControl) like commands, applied via the existing state writers / curated command runner, and the panel re-renders to mark the new state. Typed forms (`/notify cap on`, `/crews <project>`, `/effort <mode>`) still work for power users.
- **Guided `/spawn` over Telegram.** `/spawn` now replies with a project picker; tap a project and the bot asks (ForceReply) for the task — your reply spawns the crew. No typed arguments needed. (Completes the tap-first command UX.)

### Fixed
- **An incomplete `/notify` in a Telegram project topic now replies with a tap-first button panel instead of being sent to the captain.** A bare `/notify` (or `/notify@<botname>`, or a dimension with no value like `/notify cap`) previously fell through and was appended as a captain message. It is now recognized as a `/notify` attempt: fail-closed behind remote control, then either applied (when typed in full, e.g. `/notify cap on`) or answered with the notification panel (Captain on/off · crew tier · mute/unmute). Ordinary messages and `/mute`/`/unmute` are unchanged.
- **Telegram commands tapped from the `/` menu in groups now work correctly.** Telegram appends `@<botname>` to menu-tapped commands (e.g. `/status@squadrant_bot`). The three command parsers (`parseCommand`, `parseNotifyPref`, `notifyToggle`) now strip this suffix from the first token before matching, so menu-tapped commands are recognized identically to manually typed bare commands.

### Added
- **`squadrant telegram setup` auto-captures your Telegram user-id.** The running daemon now passively records the sender id from every allowlisted inbound message into `telegram-state.json` (`lastUserId`). On a re-run of `setup` in reuse mode, if the daemon has seen a message from you, setup auto-offers "Enable remote control for your user-id `<id>`?" without requiring `--user-id` or a conflicting `getUpdates` detection poll. Precedence: `--user-id` flag > `getUpdates`-detected (first-run only) > `lastUserId` from state.
- **`squadrant telegram setup` is now re-run-safe.** Re-running setup with an existing supergroup configured skips `getUpdates` entirely — avoids the 60 s timeout caused by the daemon's poll consuming the single-consumer long-poll channel. New `--redetect` flag forces fresh group detection; new `--user-id <id>` flag lets you enable remote control on a re-run without touching `getUpdates`. Allowlist precedence: `--user-id` > detected userId (first-run only) > existing `cfg.users` (preserved).
- **Daemon auto-restarts when you change daemon-cached config.** `squadrant telegram setup`, `squadrant config set <telegram.*|defaults.taskTimeoutMs|defaults.cmuxEventsBridge|projects.*>`, and project registration now restart the daemon so the change takes effect immediately (was: silently stale until a manual `squadrant heal daemon`). Use `--no-restart` to opt out. Interactive crews + tasks + Telegram state recover automatically via the disk store + boot reconcile.
- **Telegram `/command` menu registration.** `squadrant telegram setup` now registers the bot's command menu automatically, and `squadrant telegram register-commands` (re)registers it on demand — so `/status`, `/notify`, `/mute`, etc. appear in Telegram's `/` autocomplete. Setup also reuses an existing bot token on re-run (use `--reset-token` to rotate it), reports existing project topics so you can see what's already linked, and never recreates topics that already exist in state.
- **`squadrant:telegram` skill** documenting setup, remote control, command registration, and notification tuning.
- **Telegram mute confirmations.** Turning a project quieter via `squadrant telegram notify <p> off|cap off|crew <lower>` now posts a one-time confirmation into that project's topic (bypassing the mute), so you can tell on Telegram that it went silent rather than guessing.
- **Per-project layered config.** A new override layer at `~/.config/squadrant/projects/<name>.json` resolves as built-in → global `config.json` → per-project, merged per key (`resolveNotify` / `loadProjectOverride` / `saveProjectOverride` in `@squadrant/shared`). Fully additive: an absent project file behaves exactly as the global defaults — no migration. The resolver is generic; Telegram notification is its first tenant (per-project `effort`/`models` keys are reserved, not yet wired).
- **Telegram notification tiers (per-project).** Outbound lifecycle pushes are filtered by a per-project **crew tier** — `none` ⊂ `done_only` (`task.done`/`task.failed`) ⊂ `alert_only` (+ blocked/approval/input/timeout, the default) ⊂ `all`. New CLI `squadrant telegram notify <project> crew <tier>` / `cap <on|off>` and Telegram `/notify crew <tier>` / `/notify cap <on|off>` (fail-closed behind remote control) write the per-project config file. The live `active` mute axis (`/mute` / `/unmute` / `notify <project> on|off`) is unchanged and stays in `telegram-state.json`; the live value overrides the config-default `active`.
- **Distinct Telegram formatting** for `task.failed` (CREW FAILED + error), `task.approval.requested` (APPROVAL NEEDED + question), `task.input.requested` (INPUT NEEDED + question), and `task.timeout` (CREW TIMEOUT) — previously these fell to the generic line.
- **`cap` gate on `squadrant telegram send`** — with a project's resolved `cap=off`, explicit captain messages are suppressed (not sent), independent of idle-mute.

### Known issues
- A config-write restart can orphan in-flight **headless** crews (interactive crews recover fine) — see [#410](https://github.com/tu11aa/squadrant/issues/410).

### Changed
- **Telegram notifications are now per-project and muted by default.** Lifecycle events (crew done/blocked/idle) are delivered to a project's topic only after you engage that project — by sending any message into its topic, by `/unmute` (Telegram, requires remoteControl), or by `squadrant telegram notify <project> on`. This changes prior behavior where every project pushed all lifecycle events. Mute again with `/mute <project>` or `squadrant telegram notify <project> off`. Command replies and the General command channel are unaffected.

## [0.10.0] - 2026-06-23

The Telegram stability slice — closes two usability gaps so the integration is solid enough to release, both gated behind a fail-closed user-id allowlist + an opt-in master switch. Default behavior is unchanged on upgrade (`remoteControl` defaults to `false`).

### Added

- **Project-topic auto-launch ([#403](https://github.com/tu11aa/squadrant/issues/403)).** When a project-topic message arrives and no captain is alive, the daemon boots one (async `execFile`, bounded warmup poll, per-project debounce) then delivers the message — instead of silently queuing. Acts only with remote control enabled.
- **General command channel ([#402](https://github.com/tu11aa/squadrant/issues/402)).** Slash commands in the supergroup's General topic run a curated registry of squadrant operations from the phone: `/help`, `/status`, `/projects`, `/crews`, `/launch`, `/effort`, `/config get|set`, `/spawn`. Each maps to a validated CLI argv run via async `execFile` (no shell passthrough); unknown/freeform input gets a `/help` hint.
- **User-id allowlist + `remoteControl` opt-in ([#321](https://github.com/tu11aa/squadrant/issues/321)).** `TelegramConfig` gains `users?: number[]` and `remoteControl?: boolean`. Control surfaces act **only** when `remoteControl === true` **and** `message.from.id ∈ users[]` — fail-closed; chat membership alone is never enough.
- **`squadrant config get` / `config set`** — read/write a config value by dotted key. `config set` over Telegram is restricted to a default-deny writable-key allowlist (currently `defaults.effort`); secrets can never be written remotely.
- **`telegram setup` enhancement** — the wizard now captures your Telegram user-id and offers to enable remote control, writing `users` + `remoteControl` idempotently.

### Security

- `/config set` over Telegram rejects `telegram.botToken`, `telegram.users`, `telegram.chats`, and `telegram.supergroupId` (default-deny allowlist). Inbound handlers never let an error escape the poll loop, preserving at-least-once offset semantics.

## [0.9.2] - 2026-06-22

A patch release adding the agent self-reporting feedback loop and fixing a stale version in the feedback command.

### Added

- **Agent self-reporting prompt block** — `AGENTS.md` gains a "Reporting squadrant bugs" section that instructs crew agents to route detected squadrant defects up to the captain, who can then file a GitHub issue. Enables a semi-automatic defect feedback loop without requiring CLI tooling.
- **`CONTRIBUTING.md`** — new root-level contributor guide covering the development setup, the agent self-reporting convention, and how to file issues.

### Fixed

- **`squadrant feedback` now reports the real version.** `packages/cli/src/commands/feedback.ts` was hardcoding `"0.1.0"` as the squadrant version in submitted feedback; it now reads the actual version from the package at runtime.

## [0.9.1] - 2026-06-22

A patch release fixing four issues that surfaced during the v0.9.0 claude-cockpit → squadrant live cutover.

### Fixed

- **Migration build no longer aborts on stale workspace links.** `scripts/migrate-to-squadrant.sh` step 6 now runs `pnpm install` **before** `pnpm build`. After the repo folder is renamed, pnpm's workspace symlinks still point at the old `@cockpit/*` package dirs, so building first failed with hundreds of unresolved-import errors mid-cutover; reinstalling regenerates the `@squadrant/*` links first.
- **Memory remap no longer false-alarms "DATA LOSS".** `scripts/remap-claude-mem.sh` now flags data loss only when the observation count **decreases** (`-lt`), not on any change (`-ne`). A live claude-mem observer can legitimately insert new rows mid-remap (the script never deletes), which previously tripped a spurious `FATAL ... DATA LOSS` and aborted.
- **Captain/crew Stop hooks no longer invoke the removed `cockpit` binary.** `scripts/migrate-to-squadrant.sh` gained a step that rewrites stale `cockpit crew _hook` commands to `squadrant crew _hook` in existing Claude Code settings files (repo-level and global). The hook-generation source already emitted the new command, but settings files written before the rebrand kept failing with `cockpit: command not found` on every Stop/PostToolUse hook.
- **Stray smoke-test file no longer ships in the npm tarball.** Deleted `scripts/notify-relay-placement-smoke.mjs`, which leaked into the v0.9.0 package because `package.json` `files` includes the whole `scripts/` directory.

## [0.9.0] - 2026-06-22

### Changed

- **Rebrand: `claude-cockpit` → Squadrant.** The project grew from a Claude-Code-only tool into a multi-agent orchestration layer (Claude, Codex, opencode, Gemini), so the `claude-` brand was retired. Every brand surface is renamed:
  - npm package `claude-cockpit` → **`squadrant`**; CLI command `cockpit` → **`squadrant`** (+ alias **`squad`**).
  - Internal packages `@cockpit/*` → `@squadrant/*`; daemon bundle `dist/cockpitd.js` → `dist/squadrantd.js`.
  - Runtime config dir `~/.config/cockpit` → `~/.config/squadrant`; launchd label `com.cockpit.daemon` → `com.squadrant.daemon`; hub vault `~/cockpit-hub` → `~/squadrant-hub`; skill namespace `cockpit:*` → `squadrant:*`; crew env vars `COCKPIT_*` → `SQUADRANT_*`.
- A one-time migration script (`scripts/migrate-to-squadrant.sh`, idempotent, with `--dry-run` + automatic backup) performs the live cutover: moves the config dir and hub vault and rewrites `config.json` to the new paths/labels.

## [0.8.2] - 2026-06-21

### Fixed

- `cockpit effort` no longer self-notifies the captain that ran the command — the active-notify loop now skips the project whose path matches the current working directory (realpath-canonical, with a stale-path fallback). (#383)
- **Zombie task resurrection** — the daemon sweep's timeout branch no longer falls through to clobber a terminal (cancelled) task back to `working`; terminal states are now sticky, ending the repeated CREW TIMEOUT + name-collision mis-tag. (#380, #378)

### Added

- Explicit **`stopped` project status** — closing a captain workspace now reaps its orphaned interactive crews exactly once (on a confirmed captain-gone K-streak) and the dashboard renders a calm `stopped` state (magenta/⏻) instead of a red CRITICAL fault. A genuine fault (corrupt store, unexpected surface-gone) still rolls up to `gone`. (#388, #324, #323)
- **Debug-gated send instrumentation** (`COCKPIT_DEBUG_SEND`) — captures a pre/post input-box read-back frame around each captain delivery to catch the intermittent #339 Enter-inserts-newline glitch in the wild. Read-only (never re-sends), strict no-op when the flag is unset. (#386, #339)
- **Global effort dial** (`cockpit effort <max|balance|low>`) — one tokenomics lever the captain honors when spawning crews: `max` biases toward the strongest model, `low` toward cheaper agents/models, `balance` keeps default routing. Captain-discretion, not a mechanical routing rewrite. (#381, #317)

### Changed

- **Control-plane store hygiene** — automatic garbage-collection of stale terminal task records on sweep, a `crewTag` helper to disambiguate crew notifications, and a manual purge command with force override. (#382, #378)

### CI

- **Runtime smoke step** — CI now executes the bundled bins (`node dist/index.js --help`, `crew --help`, `cockpitd --help`) after build, catching NodeNext ESM `.js`-extension crashes that tsc + vitest miss. (#384, #344)

## [0.8.1] - 2026-06-19

A **post-reorg cleanup** patch. The public CLI surface is unchanged.

### Removed

- **notify-relay fully deleted** — daemon-direct cmux delivery is now unconditional (the relay proxy hop is gone). Captain-gone detection moved to projectHealth (stoppedProjects/captainMissingStreak). (#332, #373)

### Added

- **Semantic crew heartbeat** — the watchdog now distinguishes three states instead of one overloaded idle pulse: **CREW IDLE** (real turn-end, Stop hook only), **CREW QUIET** (alive but deep-thinking; stays `working`, no false 'awaiting-input'), and **CREW STALLED** (a tool call in flight past TOOL_STALL_BUDGET_MS=10min — a recoverable 'possibly hung' warn that auto-clears on the tool's PostToolUse). Degrades to QUIET-only for opencode/codex. (#354, #375)

### Changed

- **Thin-wrapper refactor** — `launch.ts` (446→210) and `crew.ts` (804→510) now push orchestration logic into @cockpit/core / @cockpit/agents / @cockpit/workspaces (session-freshness, buildAgentCmd, crew-protocol incl. the #278 completion-protocol with an exact-string snapshot guard, crew-lifecycle reap, cmux-readiness, pane helpers), each unit-testable without spawning processes. (#367, #374, #376)

### Docs

- Refreshed docs/testing/crew-lifecycle-checklist.md for the relay deletion + the new CREW QUIET/STALLED model. (#377)

## [0.8.0] - 2026-06-18

An **architecture release**. Cockpit's flat `src/` is now an internal **six-package workspace monorepo** — `shared · core · agents · workspaces · web · cli` — behind a one-way dependency DAG enforced by TypeScript project references, bundled by tsup into the same single `dist/index.js` (CLI) + `dist/cockpitd.js` (daemon). The public CLI surface is unchanged. This release also lands **daemon-direct cmux delivery** (the notify-relay is off the hot path) and a cluster of daemon/lifecycle bug fixes that surfaced during the cutover.

### Changed

- **Monorepo reorganization (internal, no user-facing change).** The flat `src/` tree and three top-level dirs became six private workspace packages, each with a single responsibility, wired by a `cli` composition root: `@cockpit/shared` (config schema, types, leaf lib), `@cockpit/core` (daemon, state-machine, protocol, and the `AgentDriver`/driver-seam interfaces), `@cockpit/agents` (the AI-driver seam — claude/codex/opencode/gemini), `@cockpit/workspaces` (the environment seam — cmux runtime, obsidian workspace, cmux notifier), `@cockpit/web` (the observability dashboard), and `@cockpit/cli` (commands, bin entry, daemon host). TS project references enforce the one-way DAG (`shared ◄ core ◄ {agents, workspaces, web} ◄ cli`) so `core` can never import a concrete driver or the CLI; adding a new surface or agent is a new folder plus one wiring line. tsup inlines all five library packages into the same two bundled outputs, so the launchd daemon entrypoint and `cockpit` bin are unchanged. (#352, #355, #356, #357, #358, #361, #366, #368)

- **Daemon-direct cmux delivery (`daemonDirectCmux`).** The daemon now delivers crew lifecycle events straight through the cmux runtime/notifier instead of via a separate notify-relay tab, removing a process-lineage wall and a class of relay-tab-death blind spots. (#332, #342, #345, #346, #347, #348, #351)

### Fixed

- **Daemon socket hijack (#360).** `cockpitd` did an unlink-then-bind on the shared socket with no liveness guard, so a second invocation (including a stray CLI) could orphan a live daemon — state reads survived but new connections failed. It now connect-probes any existing socket and **refuses to start if a live daemon answers**, and short-circuits `--help`/`--version` without booting. (#362)

- **Crew-tasks control-plane timeouts = event-loop starvation (#2).** A synchronous `execFileSync` in the cmux driver blocked the daemon's hot path, causing `crew tasks`/`signal`/`spawn` to time out while `status` kept working — and drove constant daemon PID churn. Converted to async `execFile`; the churn is gone. (#365)

- **Config read ENOENT in the bundled CLI (#363).** `package.json` path resolution overshot one directory in the tsup bundle (`cockpit config`/`--version` failed); corrected to resolve relative to the bundled `dist/`. (#365)

- **Codex app-server orphans on daemon stop (#3).** The codex interactive driver now stops its app-server cleanly when the daemon stops, instead of leaving reaped-to-daemon orphans. (#365)

- **Hardcoded crew-worktree base branch (#359).** Crew/side worktrees now derive their base from `git symbolic-ref refs/remotes/origin/HEAD` instead of a hardcoded `develop`, so main-based repos work. (#362)

- **Daemon-direct cutover hardening.** Re-entrancy guard on the delivery+probe loops (#347), three delivery-storm bugs — cursor corrupt-guard, `writeCursor` race, stale-skip (#346) — production construction of `DaemonCmux` when the flag is on (#345), missing ESM `.js` import extensions causing `ERR_MODULE_NOT_FOUND` at runtime (#343), and a `launch` double-run / startup-send confirmation fix under cmux 0.64.16 (#340).

### Added

- **`/where-i-am` (`/wim`) orientation skill.** A quick project-status report for re-orienting at the start of a session. (#364)

### Docs

- Post-reorg documentation refresh: README, `CLAUDE.md`, and `AGENTS.md` now describe the six-package layout; a new current architecture diagram (`docs/diagrams/2026-06-18-cockpit-monorepo-architecture.html`) replaces the pre-reorg overview; and a `docs/README.md` master index was added. Shipped/superseded specs, plans, diagrams, and research were archived (bundled to the hub vault) so the tree carries only active docs — nothing deleted. (#349, #369, #370)

## [0.7.0] - 2026-06-16

A compatibility release aligning cockpit with **cmux 0.64.16**, headlined by a fix for `cockpit launch --fresh` (broken by cmux's new pinned-workspace protection) and the elimination of cmux's deprecation noise. Introduces an **external-tool compatibility manifest** so dependency drift is caught early, plus first steps toward driver-agnostic crew-lifecycle detection via cmux's native event stream.

### Added

- **External-tool compatibility manifest + `doctor` drift check.** New `src/lib/compat-manifest.ts` pins the supported version of every external component cockpit depends on — `cmux` (min 0.64.0, last-verified 0.64.16), `claude` (min 2.1.32), `node` (min 18, last-verified 24.6.0), and presence-checked `codex` 0.139.0 / `gemini` 0.38.2 / `opencode` 1.17.4. `cockpit doctor` now warns (non-blocking) when an installed tool is below its floor or newer than the last-verified version, surfacing a future breaking update early instead of letting it fail silently. (#325)

- **cmux native event stream for crew-idle detection (B1).** The daemon consumes cmux's `agent.hook.Stop` events as an additional crew-idle signal, keeping the screen-scrape as fallback. (#328)

- **Agent-hook working-state to suppress false stalls (B4/A3).** `agent.hook.PreToolUse`/`UserPromptSubmit` derive a "working" state so a crew mid-tool-call is no longer misreported as stalled (the #292 class). Additive and gated; the delicate draft scraper is untouched. (#331)

### Fixed

- **`cockpit launch --fresh` works again on pinned workspaces.** cmux 0.64.16 refuses to close a pinned workspace; the driver's `stop()` now unpins before closing, so `--fresh` replaces the captain workspace instead of leaving a stale duplicate. (#325)

- **cmux deprecation noise eliminated.** Migrated the driver to cmux's canonical noun-verb commands (`workspace list/create/rename/close`) and set `CMUX_QUIET=1` in the cmux subprocess env, removing the per-call "legacy alias" notices. Read commands also lock `--id-format refs` to stay robust against a future default change. (#325, #327)

- **Focus-neutral crew spawn (A1/B3).** cmux's new freeform-canvas layout broke the index-based focus-restore dance; the driver now passes `--focus false` (cmux's new default) and drops the dance entirely, preventing keystroke leakage into a crew's launch line. (#327)

- **`--json` parsing for `workspace list` / `tree`.** Replaces brittle regex parsing of cmux text output with structured JSON. (#327)

- **Relay-health log noise pruned.** The daemon no longer floods `not_found: Workspace not found` every sweep on stale closed-crew refs — stale records are pruned and logged once. (#329)

### Changed

- **Agent Hibernation evaluated, gated off.** cmux's agent-hibernation is global-only and would hibernate the captain/relay, so it ships behind `defaults.cmuxAgentHibernation` (default `false`) with documented rationale rather than enabled. (#329)

### Docs

- cmux 0.62→0.64 compatibility audit, the agent-lifecycle + daemon-architecture research dossier, and a workspace-groups (audit C1) deferral note — backing follow-up issues #326 (compat backlog), #332 (deprecate relay → daemon-direct cmux), #333 (driver-agnostic `LifecycleSource`), and #114 (native codex TUI via hooks). (#327, #330, #334)

## [0.6.2] - 2026-06-16

A patch release bundling the **web observability dashboard** and a **startup-delivery fix** — the work that accumulated on `develop` after 0.6.1, ahead of the cmux-compat changes that land in 0.7.0.

### Added

- **Web observability dashboard.** New `cockpit dashboard --web [--port] [--interval]` serves a zero-dependency localhost HTTP+SSE dashboard. It assembles a degrade-never-blank `FullSnapshot` (Tier 0–4: daemon state, crews, mailbox stats, and external probes for cmux / agent CLIs / vaults / config behind injectable runners) and renders pure HTML/SSE with a severity rollup, a stale banner, and remediation text. Ships a light, WCAG-AA theme with an explanatory title on every widget, tabs, and zero-dep SVG donut/sparkline charts. Read-only beta. Closes #314, #319. (#314, #319)

### Fixed

- **Dashboard snapshot/probe accuracy.** Corrected the hub-spoke vault health check, project-scoped probes, lag reporting, and severity classification; adds a `stale` `ProbeState` for template-drift caution. Data audited 68/68 fields accurate. Closes #320. (#320)

- **Startup prompt delivered exactly once.** The captain launch path now recognizes non-streaming working states (a shell-waiting spinner carries no token down-counter), so a working captain is no longer misread as idle and re-sent the startup prompt — eliminating the 3× duplicate startup runs. (#312, #292 follow-up)

## [0.6.1] - 2026-06-15

A reliability patch addressing relay ghost-materialization, headless launcher I/O pressure, cross-project boot-if-down, and crew spawn focus leakage — plus a build fix and a CI gate.

### Fixed

- **Cross-project boot-if-down now works reliably.** The target captain is brought to operational before warmup is judged; warmup timeout extended from 30 s → 120 s and exposed as `--warmup-timeout` flag. Closes #288. (#291)

- **Headless launcher I/O pressure reduced.** Task-progress writes are coalesced via a 250 ms / 50-chunk debounce with a final flush, stopping O(chunks) file writes. stdout/stderr capture is capped at a 4 MB tail to bound memory. Closes #88. (#293)

- **Relay no longer materializes Claude Code ghost-suggestions into drafts.** A buffer-liveness probe replaces the destructive re-paste mechanism: the probe distinguishes a ghost auto-suggestion from a real draft without clearing the input, so a ghost can never be committed as a crew message. The ~5-min defer stall from the previous heuristic is also eliminated via an early stability-probe path. Closes #294 and #302. (#297, #303)

- **`crew spawn` (tab) no longer steals cmux focus.** Captain focus is restored after the new-pane call, preventing keystroke leakage into the crew launch command. Closes #295. (#299)

- **TypeScript build error in headless-launcher tests fixed.** The `writeResult` mock was typed incorrectly, breaking `npm run build`. Closes #300. (#301)

### Changed

- **`crew spawn` defaults to an isolated git worktree+branch.** Parallel crews no longer collide on a shared working tree; opt out with `--shared` for small single-file tasks. Closes #296. (#298)

- **CI `build-and-test` is a required merge gate on `develop`.** Broken builds and test failures are now caught at PR time rather than after merge.

## [0.6.0] - 2026-06-14

A coordination-layer release headlined by **leveled crew routing** and the **side-sessions framework**, plus two crew-lifecycle reliability fixes — crews now signal `DONE` on their own, and `--worktree` crews are genuinely isolated. Also ships **experimental** cross-project intra-group delegation.

### Added

- **Leveled crew routing.** Captains now pick a crew's agent + model by task tier via a configurable `defaults.crewRouting.rules[]` ruleset (JSON, keyword → tier → `{agent, model}`, first-match-wins by array order). `resolveCrewRoute` is consulted at spawn; an explicit `--agent`/`--model` always overrides. New `cockpit:add-pick-crew-rule` skill edits the ruleset. Default tiers: extreme→claude/opus, hard→claude/sonnet, mobile→codex, daily→opencode. Closes #275. (#276)

- **Side-sessions framework.** New `cockpit side spawn|send|list|close --role research|debug` opens a dedicated fresh-context tab on the **captain model (opus)**, deliberately **off the crew/daemon lifecycle** — no task record, no `CREW IDLE/DONE` noise to the primary captain. `research` discusses ideas and produces artifacts (issue/spec/plan) with no edits; `debug` does systematic-debugging in an isolated scratch worktree (instrument + failing test, never ships) and hands a diagnosis + optional draft patch back. Report-back is offer-and-confirm: a structured handoff via `cockpit runtime send` to the captain pane plus a durable `{spokeVault}/side-handoffs/<topic>.md` record. New `cockpit:side-session` skill. Closes #283. (#284, #285)

- **Cross-project intra-group delegation (experimental).** `cockpit group dispatch <to-project> "<task>"` records a tracked task on a same-group sibling and wakes its captain via the existing mailbox/relay; the dispatcher yields and is notified when the task settles (done/blocked/failed). Validates same-group + `acceptDelegations`, attempts boot-if-down with a bounded warmup poll, and rejects loudly (task not recorded) on warmup failure. **Experimental:** boot-if-down of a *down* sibling does not yet reliably produce an operational target captain (#288) — works best when the target captain is already up. Closes #246. (#274)

- **PR-time CI.** `ci.yml` now runs the build + full test suite on every pull request to `develop` and `main`, closing the gap where broken tests could reach `develop` silently (tests previously ran only on push to `main`). (#273)

### Fixed

- **Crew `DONE` is now signalled reliably and unprompted.** claude and opencode crews used to finish their work, report via text, and end the turn without ever running `cockpit crew signal done` → the watchdog parked the task at `awaiting-input` (`CREW IDLE`), so the captain never saw `CREW DONE`. The first turn sent to claude/opencode crews now carries a concrete **completion-protocol** suffix with `--task-id`/`--project` baked in (codex parity — robust to the keystroke-env race AND to model discretion). captain-ops also gained a **"Handling CREW IDLE"** reconciliation step (classify done-vs-waiting-vs-working on a single spot-check). Closes #278. (#281)

- **`--worktree` crews are now isolated.** A `--worktree` crew used to run git in the captain's MAIN checkout (the pane was created in the captain workspace cwd and the session never `cd`'d into the worktree), dragging the captain's HEAD onto the crew branch. The claude/opencode launch now `cd`s into the spawn cwd first (no-op for non-worktree spawns). Closes #279. (#282)

- **crewRouting config-migration backfill.** Existing `~/.config/cockpit/config.json` files written before routing existed never received `defaults.crewRouting`, so leveled routing was a silent no-op. `loadConfig` now backfills the default ruleset when absent, persists it once, and prints a one-time upgrade notice. Closes #286. (#289)

- **Relay draft-preservation third state.** `parseDraftFromScreen` now defers delivery on an overlay/unknown screen instead of misclassifying it, so a crew reply can't clobber an in-progress captain draft in that state. (#268) (#272)

- **Daemon teardown flake + crew anti-polling guidance.** The daemon test teardown now awaits async server close (eliminates an `ENOTEMPTY` flake, #146); captain-ops gained an anti-polling guard so captains don't spin unbounded `until` loops reading crew screens (#241). (#277)

## [0.5.4] - 2026-06-11

A stability release headlined by the **RAM-flood fix** — orphaned headless `claude -p` sessions no longer accumulate until the machine runs out of memory. Also adds per-spawn `--model` override, captain-draft preservation in the inbox, a captain-managed relay with live `cockpit relay logs`, `PROTOCOL_VERSION` framing, `cockpit heal`, and project-management skills.

### Added

- **`--model <alias>` flag for per-spawn crew model override.** `cockpit crew spawn --model <alias>` overrides `defaults.roles.crew.model` for a single spawn, taking precedence over runtime config — fixing model-drift when the stored config is stale. Closes #250. (#265)

- **`cockpit-register-project` and `cockpit-new-project` skills.** Two agent-usable skills so captains can register an existing repo (resolve path, derive name, pick group, `cockpit projects add`, verify) or stand up a brand-new GitHub repo (`gh repo create` → clone → register) without hand-editing `config.json`. Both document the `--group-role` auto-primary gotcha. Closes #262. (#263)

- **Captain-managed relay supervisor.** The captain now owns its notify-relay as a single `run_in_background` process running an in-process restart loop (3s backoff), replacing the separate `✉ notify-relay` cmux tab spawned by `cockpit launch` that could die unnoticed. Closes #240. (#242)

- **`cockpit relay logs <project> [--follow]`.** On-demand live visibility into the captain-owned relay over a per-project unix socket — no persistent logfile (lines are broadcast to connected readers only and dropped when nobody is watching), and the relay core is untouched (wired via the existing `opts.log` injection point). Closes #244. (#247)

- **Relay logs a `deliver` line on successful delivery.** The relay's happy path now logs each crew signal flowing through, so a healthy relay no longer looks idle in `cockpit relay logs` — previously it only logged on failure. (#244) (#248)

- **Relay-as-cmux-proxy for crew-surface liveness.** Surface-liveness probes now run inside the captain's cmux lineage (where the relay lives) and post results back to the daemon, instead of the launchd daemon calling `cmux` directly — which always returned empty `"gone"` verdicts and ghost-reaped live crews. The pre-result default stays `"unknown"`, which never reaps. (#239 Phase B) (#257)

- **Socket-boundary schema validation.** `daemon.handle()` validates `event.type` against the full `ControlEvent` union before touching state and fast-errors on malformed frames; the event reducer gained an exhaustive `default` so an unknown/future event type can never return `undefined`. Closes #87. (#256)

- **Wire `PROTOCOL_VERSION` and keepalive framing.** `src/control/protocol.ts` now exports `PROTOCOL_VERSION = 1`. The client (`sendRequest`) stamps `_v` on every outgoing request; the server stamps `_v` on every reply. On a version mismatch the client rejects with a clear error (`cockpitd protocol vN, this client expects vM — upgrade cockpitd or this CLI`) instead of silently misparsing. An absent `_v` (pre-v1 daemon) is treated as compatible — no breakage on rolling restart. The bump policy is documented inline: bump for any wire-shape change. `startServer` also emits a `{"type":"_keepalive"}` frame every 10 s on held-open attach connections (crew-attach stream and future subscribe channels), using an injectable clock so tests drive the timer without real delays. `createDecoder` and `decodeFrames` silently discard keepalive frames at the shared decode layer, so no consumer ever sees them. Closes #92 and #94.

- **`cockpit heal <component>` — targeted remediation surface.** Three subcommands close the detect → notify → remediate loop for remote/unattended operation. `heal status [--project P] [--json]` (dry-run: prints unhealthy components and the exact fix command; `--json` is machine-readable for skill/Telegram bridges; exit 0=healthy, 1=error, 2=unhealthy). `heal relay <project>` (re-establishes the notify-relay via the existing `spawnInjector` primitive; idempotent — no-op on alive/stale relay so it never competes with the captain's `#240`-owned supervisor). `heal daemon` (restarts cockpitd via the idempotent launchd kickstart path). `cockpit heal crew <id>` is explicitly deferred (overlaps #100). Closes #234. (#234)

- **Hard crew task-timeout.** The daemon sweep now detects non-terminal tasks that exceed a per-task wall-clock ceiling (default 8h, configurable via `defaults.taskTimeoutMs`). When the ceiling is crossed the daemon fires a detect-only `CREW TIMEOUT` escalation to the captain via the existing mailbox → notify-relay pipe — the same path `CREW STALLED` / `CREW DONE` ride. No state change or kill (detection-first, per #77). Distinct from the heartbeat/stall budget, which only measures heartbeat freshness; a continuously-heartbeating crew stuck on one task for hours is now caught. Closes #225. (#225)

### Fixed

- **RAM-flood root-causes — the freeze that filled swap and forced restarts.** Orphaned `claude -p` headless sessions were accumulating until the machine ran out of memory (seen at 13.5 GB swap on 24 GB, load avg 82). Three root causes fixed: **(#259)** the launchd-throttled (`KeepAlive`+`ThrottleInterval=10`) `cockpitd` crash-loop that re-dispatched headless tasks on every boot — a stray `src/control/cockpitd.js` launch path is guarded, socket-write failures no longer escape as fatals, and an `inFlightHeadlessIds` guard stops `reconcile()` from double-dispatching; **(#260)** the test suite shelling out to the real `claude` CLI when `startCockpitd` ran without a mocked spawn — a `launchHeadless` injection seam isolates tests; **(#261)** headless children orphaning to PPID 1 and surviving daemon death — `activeHeadlessKills` reaps them on `stop()`. Verified end-to-end: a live daemon on the fix ran with a single boot, 0 crash signatures, and 0 leaked sessions. (#264)

- **Captain's in-progress draft is preserved on relay delivery.** Typing in the captain inbox while a crew reply arrived used to concatenate your draft into the delivered message and submit both. The relay now defers delivery while you have a real in-progress draft and delivers only when the input is empty (deliver-when-empty); a configurable walk-away fallback (`relay.maxDeferDeliveries`, default `300` ≈ 5 min at the ~1s poll) force-delivers a long-held draft via best-effort backspace clear-and-restore. `parseDraftFromScreen` is scoped to the live input box so transcript text never triggers a spurious defer or gets re-pasted. (#258 — #266, #267, #269)

- **`cockpit shutdown` now terminalizes crew task records before closing workspaces.** Previously, closing a captain workspace left all its crew task records non-terminal in the daemon store (ghost records). On daemon restart the `#225` timeout sweep fired against every ghost simultaneously, flooding the captain with `CREW TIMEOUT` notifications. `cockpit shutdown [project]` now sends `task.cancelled` (reason: `captain shutdown`) for every non-terminal crew task before closing the workspace — the same terminalization `cockpit crew close` already performed. Daemon errors during terminalization are swallowed so a down daemon never blocks the workspace close. Closes ghost-source root cause of the `#225` timeout flood. (#225)

- **Crew task-timeout now terminalizes the record (persistent dedup, flood-proof across restarts).** The prior `#225` implementation used an in-memory `firedTimeout` Set that reset on daemon restart, re-firing every `CREW TIMEOUT` notification for all still-non-terminal tasks on every restart. The Set is removed; when a task exceeds the wall-clock ceiling the sweep now transitions it to `cancelled` (`lastEvent: "sweep.task-timeout"`) via `store.put` **before** firing the notification. The terminal state is the persistent dedup: `TERMINAL_STATES.has(r.state)` at the top of the sweep loop gates every future pass, including passes from a freshly-restarted daemon instance. The timeout message continues to report the task's **original** state (e.g. `state: awaiting-input`), not `cancelled`. Reverses the detect-only decision from `#77`; detect-only + volatile dedup was the flood bug. (#225)

- **Running captains no longer show 'gone'.** Captain liveness now derives from the relay heartbeat the daemon can see over the socket, instead of a cmux read the launchd daemon is always denied. Relay beating → captain alive; heartbeat gone → captain gone; no relay registered → unknown (no false alarm). (#239 Phase A)

## [0.5.3] - 2026-06-06

A reliability and config-hygiene release. Adds a service-health layer and config-drift detection, and hardens the daemon against false crew-cancellation and hung cmux subprocesses.

### Added

- **Service-health layer.** Relay register / health-check / heal plus component liveness; `cockpit doctor` and `cockpit status --detailed` now surface component health, and the daemon best-effort heals a downed relay while always surfacing it as actionable. (#226, closes #207, #77, #208)
- **Config drift detection.** `config.json` carries a `_cockpitVersion` stamp and is checked against the current default schema after an update. `cockpit config check --fix` applies the safe tier (missing/deprecated keys); the `config-doctor` skill reconciles judgment calls (changed defaults, invalid values). Closes the config.json half of cockpit's auto-update story. (#230)

### Fixed

- **No more false-cancellation of live crews.** `SessionEnd` terminalization is gated behind a surface-liveness probe, so a nested/subprocess `SessionEnd` (GSD, subagents, claude-mem) no longer cancels a live crew. Fixes a regression introduced in 0.5.2. (#229, closes #227)
- **A hung cmux can no longer wedge captain/relay.** cmux subprocess calls now time out (15s) so a hung cmux fails fast instead of wedging the captain or relay. (#228, closes #209)
- **reapCrewChildren works on busy machines.** Raised the `ps auxE` maxBuffer so child-process reaping does not silently fail under load. (#222 — shipped in 0.5.2; its changelog entry was omitted at the time.)

## [0.5.2] - 2026-06-05

A daemon-reliability and crew-safety patch release. The headline fix
terminalizes dead interactive crews so they stop re-emitting false
`CREW STALLED` alerts, plus per-crew worktree isolation and shell-injection-safe
crew dispatch.

### Added

- **Per-crew git worktree isolation.** Crews can now run in their own git
  worktree via `--worktree`, so concurrent crews no longer collide on a shared
  working tree / HEAD. (#216, #218)
- **opencode CP3 permission gate.** Interactive opencode crews can surface
  `permission.asked` to the captain (opt-in), closing the last notify-and-answer
  gap for opencode. (#215)
- **Injection-safe crew dispatch.** `cockpit crew spawn`/`send` accept
  `--task-file` / `--message-file` to pass briefs and messages by file,
  bypassing shell metacharacter substitution and inline-brief truncation.
  (#177, #205)

### Fixed

- **Dead interactive crews are now terminalized.** A three-part fix stops
  orphaned interactive crews (no live pane, no heartbeat) from oscillating
  `working ↔ stalled` and firing false `CREW STALLED` alerts forever:
  `SessionEnd` now terminalizes a claude crew instead of resuming it to
  `working`; `crew close` terminalizes the daemon task even when the pane is
  already gone; and a surface-liveness backstop in the daemon's sweep/reconcile
  reaps crews whose surface is provably gone. Liveness-based, so the 24h
  interactive heartbeat budget (#131/#133) is preserved. (#139, #219)
- **notify-relay no longer silently drops events.** The daemon↔relay formatter
  is unified so the daemon is the single source of truth; `CREW IDLE` and
  `task.approval.requested` events reach the captain instead of being discarded
  on formatter drift. (#210, #214, #217)
- **codex first-turn race.** The initial codex turn is no longer dropped
  ("no thread for task") — first-turn `say()` is gated on the in-flight
  dispatch. (#212, #213)
- **Bounded crew read/tasks output.** `cockpit crew read`/`tasks` output is
  bounded to prevent truncated results and `/compact` churn. (#206)

### Docs

- Corrected the crew-lifecycle checklist methodology (two signal mechanisms,
  CP4 gap #210, 2026-06-03 findings). (#211)

## [0.5.0] - 2026-06-01

This release closes the cross-agent **crew-lifecycle parity** goal: all three
agents (claude, codex, opencode) now have a controlled lifecycle plus
notify-and-answer on questions/permissions, each driven by a *reliable* signal
source rather than screen-scraping.

### Added

- **opencode SSE turn-end bridge.** Interactive opencode crews now launch as
  `opencode --port <N>`; the daemon opens a long-lived subscription to the
  crew's `/event` stream and maps the documented `session.idle` event to a
  turn-end, so it learns a crew is idle without the crew shelling out to
  cockpit. The daemon no longer sits at `working` forever. (#188)
- **codex crew sandbox parity.** Codex crews now run with
  `sandbox: "danger-full-access"`, matching the already-unsandboxed
  claude/opencode crews, so `cockpit crew signal done|blocked|failed` can reach
  the daemon socket. The full codex signal lifecycle (question / done / reopen)
  now works end-to-end. `approvalPolicy` remains an independent axis, so the
  permission gate still fires under `--approval`. (#190)
- **Semi-automatic claude crews.** `acceptEdits` permission mode plus a
  permission allowlist let crews run on cheaper models while still gating risky
  operations. (#178)
- **Event-driven permission detection.** The claude `Notification` hook surfaces
  a real permission prompt as CREW BLOCKED within ~0–3s; the in-cmux notify-relay
  also detects crews parked at a prompt. (#180, #181)
- **Trailing-question detection.** A crew that ends a turn on a question is
  surfaced to the captain as CREW BLOCKED. (#174, #176)
- **Crew lifecycle test checklist.** A reusable 6-checkpoint regression harness
  to run on any crew/daemon/relay/template change.
  (`docs/testing/crew-lifecycle-checklist.md`)

### Fixed

- **codex approval round-trip.** `answer()` maps approve/deny to the codex
  app-server schema (old `approved`/`denied`, v2 `accept`/`decline`), so captain
  approvals are accepted instead of silently rejected.
- **Turn-end no longer clobbers a blocked crew.** `task.turn.completed` from
  `blocked` is now a no-op, so an app-server/SSE trailing turn-end can't drop the
  question a `signal blocked` just raised.
- **Silent mid-turn re-block.** `crew send` to a blocked/awaiting crew re-arms
  the daemon so a subsequent permission prompt re-fires CREW BLOCKED. (#183)
- **`crew close` terminalizes the task** via a silent `cancelled` state, ending
  phantom CREW BLOCKED/IDLE pushes after a captain-initiated close. (#184)
- **Exactly-once first-turn delivery** plus an opencode boot-race readiness
  gate. (#175)

### Changed

- **CREW IDLE notifications reverted.** The idle-ping feature (#182/#185/#185b)
  was removed: it depended on the claude `Stop` hook, which fires unreliably in
  the claude-mem/cmux environment (a probe sat at `working` for 216s+ with the
  hook never firing). Reliable idle/turn-end detection now comes per-agent from
  real protocol events — opencode SSE `session.idle` and codex app-server
  `TurnCompleted` — instead of a flaky hook.

## [0.4.0] - 2026-05-29

### Added

- **Control-plane daemon (cockpitd).** A new background daemon provides an
  AF_UNIX socket server with newline-JSON framing, a task state machine, atomic
  per-task JSON state store, heartbeat watchdog with stall detection and
  automatic recovery, startup crash-reconciliation, and self-healing daemon
  management on every `cockpit` invocation. A launchd plist target is included
  for macOS service integration. (PR #85 and the full control-plane series)
- **Codex interactive crews.** An `AppServerClient` speaking the codex app-server
  v2 protocol (mandatory handshake, thread start/resume/read, id-correlated
  requests, notification fanout), a `CodexInteractiveDriver` owning the
  app-server child process, an approval/gate primitive, a `cockpit crew attach`
  cmux-tab renderer, and `cockpit crew chat --provider codex` / `--approval` /
  `reply --gate` verbs. (#86 interactive slice, #96–#104)
- **Claude interactive crews routed through the daemon.** Claude crew sessions
  now flow through cockpitd rather than bypassing it, unifying the session
  lifecycle under the daemon's state machine. (#108, #64 slice)
- **opencode interactive crews wired through the daemon.** opencode crews gain
  a dedicated crew template, per-crew permission configuration, and
  `autoApprove`/model passthrough, all served through the daemon. (#127, #128,
  #129)
- **Daemon push-notifications to the captain.** Terminal task events are
  delivered to the captain via an in-cmux relay, keeping the captain informed
  without polling. (#109, #110, #111, #112)
- **Mailbox + injector foundational refactor.** A new mailbox abstraction and
  injector layer underpin the daemon's communication channels. (#113, #116)
- **Dashboard status grid now reads live daemon task state.** The dashboard no
  longer depends on `status.md` — it queries the daemon directly for current
  task state. (#154)
- **Self-contained architecture HTML report**, with a Vietnamese translation.
  (#147, #149)
- **Process-cleanup rule** added to crew templates and the `captain-ops` skill
  to ensure child processes are cleaned up on session exit. (#164)
- **Release automation.** A GitHub Actions workflow tags `vX.Y.Z` from
  `package.json`, publishes a GitHub Release with notes from the `CHANGELOG`
  section, and (when an `NPM_TOKEN` secret is set) publishes to npm — on every
  push to `main`. (#170)

### Changed

- **Crew sessions use an identity-first generic template** with a no-nested-subagents
  rule, replacing agent-specific templates. (#105, #106)
- **Source-managed directories self-heal on every cockpit invocation.** Missing
  directories under source control are re-created automatically. (#74)
- **Plugin manifest registers the cockpit skill namespace.** Dead
  `plugin/package.json` removed. (#72, #73)

### Fixed

- **Multi-line crew prompts no longer fragment.** Newlines are collapsed before
  the cmux send, preventing truncated prompts. (#136, #166)
- **First-turn crew dispatch no longer drops on slow CLI boot.** Fixed delays
  have been replaced with pane-readiness polling for reliable first-turn
  delivery. (#165, #167)
- **False `CREW STALLED` alerts eliminated.** The `Stop` map now correctly
  resolves to `awaiting-input`, and the heartbeat refreshes mid-turn via a
  `PostToolUse` hook. (#124, #131, #133)
- **cmux shell-injection closed** in `sendToPane`/`sendToSurface` and the notify
  path. (#119, #122)
- **notify-relay now runs as a hidden background tab** rather than a split pane,
  preventing accidental interference. (#117, #123, #161, #162)
- **Daemon-bounce loop fixed** by separating `PATH` drift detection from
  program-arg changes. (#126)
- **cmux stderr no longer leaks into the captain terminal.** (#121, #125)
- **Fresh-install gaps closed:** cmux binary path resolution cascade (issues #1,
  #144), launchd plist `PATH` baking (issues #5, #143), and a reconciled
  Node >=18 floor across README, `cockpit doctor`, and `package.json` (#142).
- **Cockpit hooks delivered via `.claude/settings.local.json`** instead of
  `--settings`, aligning with Claude Code's recommended hook mechanism. (#134,
  #137)
- **codex `approvalPolicy` defaults to `'never'`** for unattended crews. (#132)
- **`task.reopened` semantic fixed.** Re-tasking a done crew now fires
  `CREW DONE` again as expected. (#148, #150)
- **vitest scoped to `src/**/*.test.ts`** to avoid picking up non-source test
  files. (#157, #158)
- **Captain tab renamed and pinned** so crew reports route to the correct
  surface. (#83, #84)
- **Projection reads the canonical project source** outside the `cwd` sandbox.
  (#63)
- **Control-plane red-team hardening:** path-traversal sanitization, fail-loud
  interactive dispatch, and `PATH` baked into the launchd plist.
- **Captain is notified when a crew goes idle.** An idle interactive crew now
  transitions to `awaiting-input` and fires a single accurate `CREW IDLE` notice
  instead of a misleading `CREW STALLED`; the explicit `signal done` path still
  fires `CREW DONE`. (#172)
- **codex crews can report terminal state.** `cockpit crew signal` accepts
  `--task-id`/`--project` flags, and codex threads receive their concrete task
  id + project via `developerInstructions`, so codex crews can signal
  done/blocked/failed like claude/opencode. (#173)

### Removed

- **Reactor engine.** The always-on GitHub poller / auto-delegation engine has
  been retired — reaction rules (`reactions.json`), the polling and matching
  scripts, the auto-status poller and status classifier, the `reactor` role and
  its skill, and the `cockpit reactor` command are all gone. Event-driven
  auto-delegation is no longer part of cockpit; agents are launched explicitly.
- **Aider runtime driver and support.** The `aider` driver, its tests, and all
  spawn/launch/doctor/template wiring have been removed. Aider was never wired
  into `src/config.ts` and saw no active use; cockpit's supported agents are now
  Claude Code, Codex, Gemini CLI, and opencode. The `--agent aider` option no
  longer exists.

## [0.3.3] - 2026-05-15

### Added

- **opencode CLI agent support.** New driver (`createOpencodeDriver`)
  probes `opencode --version` and declares
  `auto_approve / json_output / streaming / model_routing`
  capabilities. `cockpit crew spawn ... --agent opencode` builds
  `opencode run "<prompt>"` (plus `--format json` and `-m <model>`
  when applicable). The matching projection emitter writes to
  `~/.config/opencode/AGENTS.md` at user scope and `<root>/AGENTS.md`
  at project scope, sharing the same marker-merge flow as codex.
  opencode crews run as interactive sub-sessions like claude crews —
  `cockpit crew send` delivers follow-up turns to the live TUI.
  Print-mode is still used for one-shot roles (reactor, exploration).

## [0.3.2] - 2026-05-06

### Fixed

- **Crew now honors configured model routing.** `cockpit crew spawn` was not
  passing `--model` to the agent CLI, so Claude crews silently fell back to
  the user's global default (typically opus) instead of the configured
  `defaults.roles.crew.model` (sonnet by default). Read the model from
  config and pass it through `buildCommand`. Token spend for crew sessions
  drops accordingly.
- Model passthrough is **agent-aware**: only applied when the spawn agent
  matches the role's configured agent (`defaults.roles.crew.agent`). Cross-
  agent crews (e.g. `--agent codex` while config routes crew to claude) skip
  the model arg, since model names are agent-specific (`sonnet` is a Claude
  alias and would be invalid for codex / aider / gemini).

## [0.3.1] - 2026-05-06

Crew sessions become **interactive sub-sessions** instead of one-shot print
runs — the captain's equivalent of a Claude Agent Team subagent. Each crew is
named, addressable, stays idle between turns, and is driven by new
`cockpit crew send/read/close/list` verbs. Closes #56.

### Added

- **Interactive Claude crews** — `cockpit crew spawn` boots Claude without
  `-p`, then sends the task as the first turn after the CLI is ready. The
  session stays alive between turns waiting for the captain's next message.
- **Named crews** — `--name <n>` (or auto-generated `crew-1`, `crew-2`, …
  picking the next free slot from existing tabs in the captain workspace).
  Tab title becomes `🔧 <project>:<name>` so the surface itself is the
  registry — no state file.
- **`cockpit crew send <project> <name> "<message>"`** — send a follow-up
  turn to an existing crew. Replaces the "spawn a new tab for every turn"
  pattern.
- **`cockpit crew read <project> <name>`** — read the crew's current screen
  from the CLI (no need to flip into the cmux UI).
- **`cockpit crew close <project> <name>`** — shutdown a crew (closes its
  tab).
- **`cockpit crew list <project>`** — list live crews for a project.
- **`SpawnOptions.interactive`** flag — Claude driver omits `-p` when set so
  callers can deliver the prompt over runtime.send.
- **`RuntimeDriver.listSurfaces(workspaceId)`** — enumerate surfaces (tabs /
  panes) inside a workspace with their titles. Cmux driver parses
  `cmux tree --workspace`.

### Changed

- **Captain templates + `captain-ops` SKILL** rewritten — teach the new
  spawn-once / send-follow-ups / close-when-done pattern. Stops the "tons of
  tabs" growth seen pre-0.3.1.
- **README + CLI help** updated with the new verbs.

### Known limitations

- Non-Claude agents (codex / gemini / aider) still launch in print-mode;
  full interactive support per agent is a follow-up.
- Crew tabs do not persist across `cockpit shutdown <project>` — they're
  surfaces inside the captain workspace and die with it. Matches Agent Team
  semantics.

## [0.3.0] - 2026-05-05

The thin-redirect release. Cockpit becomes a thin multi-agent orchestration
layer where the captain is disposable, crew are fresh CLI sessions in split
panes (any agent), Command is on-demand, and an auto-poller derives liveness
from cmux pane content so agents don't have to write status.

Umbrella tracking: #40 (closed). Design spec:
[`docs/specs/2026-05-05-cockpit-thin-redirect-design.md`](docs/specs/2026-05-05-cockpit-thin-redirect-design.md).

### Added

- **Crew spawn via split-pane CLI** — `cockpit crew spawn <project> <task>
  [--direction <d>] [--agent claude|codex|gemini|aider]` opens a fresh agent
  CLI in a split pane next to the captain. Replaces Claude-only `TeamCreate`
  / `Agent` tool. Works for any agent (#41, #46).
- **`RuntimeDriver` pane operations** — `newPane`, `closePane`, `sendToPane`,
  `readPaneScreen` so callers reach panes via the existing abstraction (#41).
- **Auto-status poller** — reactor reaction polls captain panes via
  `cockpit runtime read-screen`, classifies state (idle/busy/blocked/errored/
  offline) from the last ~50 lines, writes `{spokeVault}/status.md` with
  state + timestamp + last-activity excerpt. Pure machine, no agent action
  required (#43, #48).
- **Dashboard** — `cockpit dashboard --pane` opens a refreshing sidebar grid
  in cmux; hub Obsidian Dataview page aggregates all spoke `status.md` files.
  Both consume the same auto-derived data (#44, #49).
- **`cockpit command [--task briefing|learnings-review|wiki-aggregate]`** —
  on-demand one-shot Command session in a split pane, instead of an
  always-on persistent Command workspace (#42, #47).
- **Multi-agent template parity** — `captain.generic.md` /
  `crew.generic.md` projected to `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`,
  `.cursor/rules/cockpit.mdc` so non-Claude agents have working captain/crew
  contracts (#45, #50).

### Changed

- **Captain templates and `captain-ops` skill** rewritten — no more
  `TeamCreate` / `Agent` / `SendMessage` references; crew spawning routes
  through `cockpit crew spawn`; mandatory write-status-after-every-event
  rule removed (the auto-poller covers liveness).
- **`captain.claude.md`** — added one-line compact-recovery doc note.
  Verified live: role survives `/compact` via `--append-system-prompt-file`,
  so role-amnesia is not a real problem; only work-context loss remains and
  is covered by handoffs.
- **`launch --all`** — no longer auto-launches a Command session. Bare
  `cockpit launch` no longer defaults to Command. Command is opt-in via the
  new `cockpit command` subcommand.
- **Vault discipline** — handoff / wiki / learnings are now opt-in
  (captain writes when meaningful), not nagged on every event. Vault
  becomes a consumer of auto-derived status, not the primary write target.
- **`scripts/spawn-crew-pane.sh`** is now a thin shim that forwards to
  `cockpit crew spawn` (preserved for backward compat).

### Removed

- "Captain MUST write status after every significant event" rule
- "Daily log" requirement (still possible, just opt-in)
- Auto-launched Command session in `--all` flow
- Claude-only `TeamCreate` / `Agent` tool dependence in captain workflow

## [0.2.0] - 2026-05-05

First tagged release. Establishes cockpit as a multi-agent orchestration layer
(Command → Captain → Crew + Reactor) with a pluggable slot architecture and
GitHub-driven automation.

### Added

#### Multi-agent foundation
- Driver model for multi-agent support — Codex, Cursor, Gemini CLI, and Aider
  alongside Claude Code (#16).
- Multi-agent direction statement and Karpathy coding-discipline skill applied
  across captain/crew/direct edits (#32, #33).
- Projection slot V1 — cross-agent config sync so non-Claude agents see the
  same project context (#31, #36).

#### Plugin slot system (#9)
- Phase 1: Runtime slot — abstracts cmux behind a runtime driver (#20).
- Phase 2: Workspace slot — pluggable workspace provisioning (#26).
- Phase 3: Tracker slot — pluggable status/progress tracking (#28).
- Phase 4: Notifier slot — pluggable notification surfaces (#29).

#### Reactor & automation
- Reaction engine — declarative GitHub event polling with rule-based actions
  in a dedicated workspace (#1).
- CI Feedback Reactor — auto-fix CI failures via crew dispatch (#3).
- `cockpit retro` command — weekly/sprint retrospective summaries from daily
  logs and git history (#6).

#### Commands & workflows
- `cockpit launch` and `cockpit shutdown` — bootstrap and tear down the
  Command/Captain/Crew workspace set in cmux.
- `cockpit standup` — daily standup summary from captain logs.
- `cockpit feedback` — capture user feedback into the project record.
- Daily briefing on new day; captain writes daily logs.
- Project groups — sibling repos share context via claude-mem; primary
  repo auto-detected; `--group-role` enforced.
- Auto-discovery of repos under a parent directory with primary/sibling
  identification.
- Auto-generated unique captain names with collision validation on
  `projects add`.
- Session continuity — resume last session by default; `--fresh` flag
  forces a new session; built on `claude -c`.
- Configurable permission modes for command and captain sessions (#21,
  #22) — defaults to `auto`.
- Workspace icons — command, captain, crew — for cmux visual distinction.

#### Knowledge & integrations
- LLM Wiki knowledge compilation system — Karpathy-inspired ingest/query/log
  scripts per spoke vault (#13).
- GSD integration for crew wave-based execution on multi-step tasks (#14).
- Model routing config — Opus for command/captain/review, Sonnet for
  crew/reactor (#12).
- Task Master integration via session handoff files.
- Docs scaffolding for research, specs, and ADRs.
- Project roadmap covering 13 features across P0–P3.

### Changed

- Cockpit roles default to `auto` permission mode at launch (#21, #22).
- `--append-system-prompt-file` used for roles to preserve project CLAUDE.md;
  templates deployed via `cockpit init`.
- Captain writes status on session start and after every task event.
- Command session restricted to delegation-only tools (Bash/Read/Write); no
  Grep/Glob/Edit on project source.
- Switched from manual `git worktree` to Claude Code's built-in worktrees.

### Fixed

- Command-ops freshness gate — validates captain workspace age before reuse,
  preventing stale-session bugs (#37, #38).
- Exact captain-name matching enforced — never reuse similar workspaces.
- Use absolute cmux path everywhere; auto-launch the cmux app if not running.
- Detect external-terminal launches and bring up the cmux app.
- Use `workspace:N` refs (not names) for `cmux select-workspace`.
- Install CLAUDE.md into workspace cwd; navigate to command on launch.
- Brove project path corrected; warn on `projects add` when no `.git` found.
- Strengthened command CLAUDE.md hard rules against doing work directly.
- Correct plugin keys, captain naming, and status display.

### Documentation

- README with install, commands, and architecture.
- Multi-agent direction spec (`docs/specs/2026-04-24-multi-agent-direction.md`).
- P0 roadmap items marked complete; out-of-repo work moved out.

[0.2.0]: https://github.com/tu11aa/claude-cockpit/releases/tag/v0.2.0
