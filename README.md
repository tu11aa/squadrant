# claude-cockpit

Multi-project orchestration layer for coding agents. One command session controls everything.

> **Direction:** Cockpit is moving to support all major coding agents — Claude Code, Codex, Cursor, Gemini CLI, Aider — not just Claude Code. Claude Code is the reference implementation today; other agents land through the plugin system's driver abstractions and the upcoming cross-agent projection layer ([#31](https://github.com/tu11aa/claude-cockpit/issues/31)). See [`docs/specs/2026-04-24-multi-agent-direction.md`](docs/specs/2026-04-24-multi-agent-direction.md).

## How It Works

```
cockpit launch <project>          → Captain (per project, in cmux)
cockpit launch --all              → Reactor + every Captain
cockpit command --task briefing   → One-shot Command session in a split pane
                                       (also: --task learnings-review | wiki-aggregate)
Captain → cockpit crew spawn …    → Crew (split pane, fresh agent CLI session)
```

1. **`cockpit init`** — first-time setup
2. **`cockpit launch <project>`** — start the project's captain in cmux
3. **`cockpit launch --all`** — start the reactor and every captain at once
4. **`cockpit command --task briefing`** — on-demand Command session for cross-project work (optional; spawns in a split pane and exits when done)
5. **`cockpit status`** — quick status check without spawning anything

## Install

```bash
npm install -g claude-cockpit
cockpit init
cockpit doctor
```

## Prerequisites

- [Claude Code](https://claude.ai/code) >= 2.1.32
- [cmux](https://cmux.dev) (macOS terminal for coding agents)
- [Obsidian](https://obsidian.md) (status tracking)
- Node.js >= 22

### Required Integrations

```bash
# Claude Memory — cross-session continuity
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem

# Task Master — PRD decomposition (works via Max subscription)
npm install -g task-master-ai

# GSD — wave-based execution for crew (fresh context per step)
npx get-shit-done-cc@latest --claude --global
```

See `core/plugins.md` for full plugin setup.

### Obsidian Plugins

See `obsidian/plugins.md` for Dataview, Templater setup.

## Commands

| Command | Description |
|---------|-------------|
| `cockpit init` | First-time setup — config, hub vault, scripts |
| `cockpit launch <project>` | Start a specific project captain |
| `cockpit launch --all` | Launch reactor + all captain workspaces |
| `cockpit command [--task <briefing\|learnings-review\|wiki-aggregate>] [--agent <a>]` | Spawn a one-shot Command session in a split pane (no persistent Command). |
| `cockpit status` | Show all project status (no Claude needed) |
| `cockpit standup` | Daily standup summary (zero LLM tokens) |
| `cockpit doctor` | Health check — verify dependencies |
| `cockpit projects list` | List registered projects |
| `cockpit projects add <name> <path>` | Register a project |
| `cockpit projects remove <name>` | Unregister a project |
| `cockpit reactor check` | Run one reactor poll cycle |
| `cockpit reactor poll-status [--json]` | Run one auto-status poll across all registered projects (writes `{spokeVault}/status.md`). |
| `cockpit dashboard [--once]` | Print a one-shot status grid for all projects to the terminal. |
| `cockpit dashboard --pane [--direction <dir>] [--interval <s>]` | Open a refreshing sidebar pane in the current cmux workspace. |
| `cockpit dashboard sync-hub [--json]` | Mirror spoke `status.md` files into `{hubVault}/projects/` for Obsidian Dataview. |
| `cockpit reactor status` | Show reactor state |
| `cockpit runtime status <project>` | Check if a project's captain workspace is running |
| `cockpit runtime send <project> <msg>` | Send a message to a captain workspace (auto-Enter) |
| `cockpit runtime list` | List all workspaces from the active runtime |
| `cockpit workspace read <project> <path>` | Read a scope-relative file from the project's spoke vault |
| `cockpit workspace list <project> <dir>` | List entries in a spoke vault directory |
| `cockpit workspace read --hub <path>` | Read from the hub vault |
| `cockpit tracker create-issue <project> <title>` | Create an issue in the project's tracker repo |
| `cockpit tracker merge-pr <project> <num>` | Enable auto-merge on a PR |
| `cockpit tracker get-checks <project> <num>` | Print PR check runs |
| `cockpit notify <message>` | Send a message to the user via the configured notifier |
| `cockpit projection emit [--scope user\|project] [--project <name>] [--target <name>] [--all]` | Emit cockpit rules + skills to Cursor/Codex/Gemini config files |
| `cockpit projection diff [same flags]` | Preview projection changes without writing |
| `cockpit projection list` | Show registered projection targets and their destinations |
| `cockpit crew spawn <project> <task> [--direction <d>] [--agent <a>]` | Spawn a crew session in a split pane next to the project's captain |
| `cockpit shutdown [project]` | Graceful shutdown |
| `cockpit feedback` | Open opt-in feedback issue |

## Architecture

### Roles

- **Command** (Opus) — *on-demand* cross-project session. Spawned by `cockpit command --task <briefing|learnings-review|wiki-aggregate>` in a split pane; exits when the task completes. No persistent Command process.
- **Captain** (Opus) — project leader, uses Agent Teams + git worktrees
- **Crew** (Sonnet by default) — fresh CLI session in a split pane next to the captain. Spawned via `cockpit crew spawn`. Works with any agent CLI (claude, codex, gemini, aider). Disposable; uses GSD for complex tasks.
- **Reactor** (Sonnet) — always-on GitHub event poller, auto-delegates to captains (incl. auto-fix on CI failure, with escalation after max retries)

### Model Routing

Each role runs on the optimal model for cost/quality tradeoff. Configured in `config.json`:
- Command/Captain/Review: Opus (coordination + quality)
- Crew/Reactor: Sonnet (execution)
- Exploration: Haiku (cheap lookups)

### Runtime Abstraction

Workspaces run on a pluggable **runtime driver** (currently only `cmux`). Each project may override the global default via its `runtime` field. Bash scripts call `cockpit runtime <op>` to talk to the configured runtime instead of any specific binary. New runtimes (tmux, Docker, SSH) are added as driver files in `src/runtimes/` — see `docs/specs/2026-04-20-plugin-system-runtime-design.md`.

### Workspace Abstraction

Vault storage (hub + per-project spokes) runs behind a pluggable **workspace driver** (currently only `obsidian`). Filesystem operations — `read`, `write`, `list`, `exists`, `mkdir` — go through the driver instead of `fs` directly. Each project may override the global default via its `workspace` field. Bash scripts call `cockpit workspace <op>` to read/write vault data without hardcoding paths. New backends (Notion, plain-md, S3) are added as driver files in `src/workspaces/` — see `docs/specs/2026-04-21-plugin-system-workspace-design.md`.

### Tracker Abstraction

Issue/PR operations run behind a pluggable **tracker driver** (currently only `github`). One-shot ops — create-issue, merge-pr, get-checks, get-run-log, list-issues — go through the driver instead of `gh` CLI directly. Bash scripts call `cockpit tracker <op>`. Polling stays provider-specific (`scripts/poll-github.sh`); future providers add their own poll scripts. Each project may override the global default via its `tracker` field. New backends (Linear, Jira, GitLab) are added as driver files in `src/trackers/` — see `docs/specs/2026-04-21-plugin-system-tracker-design.md`.

### Notifier Abstraction

User-facing notifications run behind a pluggable **notifier driver** (currently only `cmux`). Escalations, reactor alerts, and other "tell the user" events go through `cockpit notify <message>`. The default `CmuxNotifier` delegates to `cockpit runtime send --command` — the abstraction exists as a swap-point for future Slack/Discord/email/pager drivers. Notifier is global (no per-project override). See `docs/specs/2026-04-21-plugin-system-notifier-design.md`.

### Crew Spawn (Split-Pane CLI)

Crew is no longer a Claude Agent Team member. The captain spawns a crew session via `cockpit crew spawn <project> "<task>"`, which opens a split pane in the captain's cmux workspace and starts a fresh CLI session for the chosen agent (`--agent claude|codex|gemini|aider`). The crew session loads `crew.<agent>.md` as its system prompt and the task as its inline prompt — exactly the OpenAI-Swarm "handoff = next prompt" pattern. State lives in the pane buffer + git; the pane is disposable. See [`docs/specs/2026-05-05-cockpit-thin-redirect-design.md`](docs/specs/2026-05-05-cockpit-thin-redirect-design.md).

### Projection (Cross-Agent Config Sync)

Cockpit rules (Karpathy principles, captain-ops) and per-project AGENTS.md emit to each supported agent's canonical path via `cockpit projection emit`. User-level projection pushes cockpit's skills to `~/.cursor/rules/cockpit-global.mdc`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`. Project-level projection pushes a managed project's own `AGENTS.md` into `{project}/CLAUDE.md`, `{project}/.cursor/rules/cockpit.mdc`, `{project}/GEMINI.md` — zero cockpit-global content leaks into the project repo. Shared files use `<!-- cockpit:start --> ... <!-- cockpit:end -->` markers; dedicated files overwrite. See `docs/specs/2026-04-24-plugin-system-projection-design.md`.

The user-level projection now also inlines `orchestrator/captain.generic.md` and `orchestrator/crew.generic.md` as `## Captain Role` / `## Crew Role` sections inside the cockpit marker block, so non-Claude agents (Codex, Gemini, Cursor) load the same role descriptions Claude Code loads via `--append-system-prompt-file`. See `docs/specs/2026-05-05-multi-agent-template-parity-plan.md` (#45).

### Obsidian Vaults (Hub-and-Spoke)

- **Hub vault** (`~/cockpit-hub`) — cross-project dashboard + hub wiki
- **Spoke vaults** — per-project status, learnings, and wiki

### Knowledge System (opt-in writes)

- **Status (auto)** — every reactor cycle (`cockpit reactor poll-status`) reads each captain's cmux pane, classifies the tail into `idle | busy | blocked | errored | offline`, and writes `{spokeVault}/status.md`. No agent action required. Manual `write-status.sh` writes are opt-in and may be clobbered on the next poll.
- **Dashboard** — `cockpit dashboard --pane` opens a refreshing sidebar pane in cmux that lists every project's auto-derived state. `cockpit dashboard sync-hub` mirrors each spoke `status.md` into `{hubVault}/projects/` so the hub vault's `dashboard.md` Dataview query renders the same data inside Obsidian. The reactor cycle calls `sync-hub` after every `poll-status`.
- **Handoff files** — captain writes when in-flight work needs to survive into tomorrow; skipped on uneventful sessions.
- **Daily logs** — captain writes when the day produced something worth a log; not on a schedule.
- **Learnings** — recorded when a captain encounters a genuinely surprising or reusable pattern.
- **Wiki** — compiled, indexed knowledge pages in spoke vaults (`wiki/pages/`); promoted from learnings when worth maintaining.
- **Hub Wiki** — cross-project knowledge aggregated by an on-demand `cockpit command --task wiki-aggregate` run.
- Scripts: `wiki-ingest.sh`, `wiki-query.sh`, `wiki-log.sh`.

### Session Continuity

- **Handoff files** — captain writes context on shutdown, reads on startup
- **Session freshness** — auto-detects new day or template changes, forces fresh context
- **claude-mem** — cross-session memory via MCP plugin

## Config

`~/.config/cockpit/config.json`

```json
{
  "commandName": "command",
  "hubVault": "~/cockpit-hub",
  "runtime": "cmux",
  "workspace": "obsidian",
  "tracker": "github",
  "notifier": "cmux",
  "projects": {
    "brove": {
      "path": "~/projects/brove",
      "captainName": "brove-captain",
      "spokeVault": "~/cockpit-hub/spokes/brove",
      "host": "local",
      "runtime": "cmux",
      "workspace": "obsidian",
      "tracker": "github"
    }
  },
  "defaults": {
    "maxCrew": 5,
    "worktreeDir": ".worktrees",
    "teammateMode": "in-process",
    "permissions": {
      "command": "default",
      "captain": "acceptEdits"
    },
    "models": {
      "command": "opus",
      "captain": "opus",
      "crew": "sonnet",
      "reactor": "sonnet",
      "exploration": "haiku",
      "review": "opus"
    }
  }
}
```

## Supported Agents

| Agent | Status | Notes |
|---|---|---|
| Claude Code | ✅ Shipping | Reference implementation; reads `CLAUDE.md`, Skill tool, MCP via settings.json |
| Codex CLI | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.codex/AGENTS.md` (#45). First-class role identity is #35. |
| Cursor | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.cursor/rules/cockpit-global.mdc` (#45). |
| Gemini CLI | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.gemini/GEMINI.md` (#45). |
| Aider | 📋 Planned | `CONVENTIONS.md`; MCP via external config |

Cross-agent config sync (one canonical source → agent-specific formats) is tracked in [#31](https://github.com/tu11aa/claude-cockpit/issues/31).

## Inspirations

- **[Andrej Karpathy](https://x.com/karpathy/status/2015883857489522876)** — coding principles baked into every captain/crew role ([`plugin/skills/karpathy-principles/SKILL.md`](plugin/skills/karpathy-principles/SKILL.md))
- **[forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)** — reference packaging for the four principles (MIT)
- **[Multica](https://github.com/multica-ai/multica)** — validated the multi-agent runtime + skill-compounding direction
- **[AGENTS.md](https://agents.md/)** — convergence point for cross-agent instructions
- **[OpenSpace](https://github.com/openspacelabs/openspace)** — self-improving learnings loop (record → capture → fix → mark-useful)
- **[ComposioHQ](https://github.com/ComposioHQ/composio)** — tool/skill portability across agents

## License

MIT
