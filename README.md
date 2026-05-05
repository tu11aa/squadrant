# claude-cockpit

Multi-project orchestration layer for coding agents. One command session controls everything.

> **Direction:** Cockpit is moving to support all major coding agents — Claude Code, Codex, Cursor, Gemini CLI, Aider — not just Claude Code. Claude Code is the reference implementation today; other agents land through the plugin system's driver abstractions and the upcoming cross-agent projection layer ([#31](https://github.com/tu11aa/claude-cockpit/issues/31)). See [`docs/specs/2026-04-24-multi-agent-direction.md`](docs/specs/2026-04-24-multi-agent-direction.md).

## How It Works

```
cockpit launch → Command session (Claude Code in cmux)
                    ├── brove-captain (Agent Teams + worktrees)
                    │   ├── crew-pvp (worktree: feat/pvp)
                    │   └── crew-bridge (worktree: fix/bridge)
                    └── scaffold-captain
                        └── crew-migration
```

1. **`cockpit init`** — first-time setup
2. **`cockpit launch`** — starts the command workspace in cmux
3. **Talk to the command session** — "brove has a UI task" → it spawns a captain → captain spawns crew
4. **`cockpit status`** — quick status check without Claude

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
| `cockpit launch` | Start the command workspace |
| `cockpit launch <project>` | Start a specific project captain |
| `cockpit launch --all` | Launch command + reactor + all captains |
| `cockpit status` | Show all project status (no Claude needed) |
| `cockpit standup` | Daily standup summary (zero LLM tokens) |
| `cockpit doctor` | Health check — verify dependencies |
| `cockpit projects list` | List registered projects |
| `cockpit projects add <name> <path>` | Register a project |
| `cockpit projects remove <name>` | Unregister a project |
| `cockpit reactor check` | Run one reactor poll cycle |
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

- **Command** (Opus) — overseer, monitors all projects, spawns captains
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

### Obsidian Vaults (Hub-and-Spoke)

- **Hub vault** (`~/cockpit-hub`) — cross-project dashboard + hub wiki
- **Spoke vaults** — per-project status, learnings, and wiki

### Knowledge System

- **Learnings** — raw observations recorded by captains after tasks
- **Wiki** — compiled, indexed knowledge pages in spoke vaults (`wiki/pages/`)
- **Hub Wiki** — cross-project knowledge aggregated by command
- Scripts: `wiki-ingest.sh`, `wiki-query.sh`, `wiki-log.sh`

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
| Codex CLI | ✅ via cockpit projection | Runtime driver (feature branch); instructions via `AGENTS.md` needed |
| Cursor | ✅ via cockpit projection | Runtime driver; rules via `.cursor/rules/*.mdc` via [#31](https://github.com/tu11aa/claude-cockpit/issues/31) |
| Gemini CLI | ✅ via cockpit projection | Runtime driver; instructions via `GEMINI.md` |
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
