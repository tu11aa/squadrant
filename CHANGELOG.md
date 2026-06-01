# Changelog

All notable changes to claude-cockpit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
