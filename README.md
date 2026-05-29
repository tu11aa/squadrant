# claude-cockpit

Multi-project orchestration layer for coding agents. One command session controls everything.

> **Direction:** Cockpit is moving to support all major coding agents — Claude Code, Codex, Cursor, Gemini CLI — not just Claude Code. Claude Code is the reference implementation today; other agents land through the plugin system's driver abstractions and the upcoming cross-agent projection layer ([#31](https://github.com/tu11aa/claude-cockpit/issues/31)). See [`docs/specs/2026-04-24-multi-agent-direction.md`](docs/specs/2026-04-24-multi-agent-direction.md).

## How It Works

```
cockpit launch <project>          → Captain (per project, in cmux)
cockpit launch --all              → Every Captain
cockpit command --task briefing   → One-shot Command session in a split pane
                                       (also: --task learnings-review | wiki-aggregate)
Captain → cockpit crew spawn …    → Crew (new tab in the captain workspace, fresh agent CLI)
```

1. **`cockpit init`** — first-time setup
2. **`cockpit launch <project>`** — start the project's captain in cmux
3. **`cockpit launch --all`** — start every captain at once
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
- Node.js >= 18

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
| `cockpit launch --all` | Launch all captain workspaces |
| `cockpit command [--task <briefing\|learnings-review\|wiki-aggregate>] [--agent <a>]` | Spawn a one-shot Command session in a split pane (no persistent Command). |
| `cockpit status` | Show all project status (no Claude needed) |
| `cockpit standup` | Daily standup summary (zero LLM tokens) |
| `cockpit doctor` | Health check — verify dependencies |
| `cockpit projects list` | List registered projects |
| `cockpit projects add <name> <path>` | Register a project |
| `cockpit projects remove <name>` | Unregister a project |
| `cockpit dashboard [--once]` | Print a one-shot status grid for all projects to the terminal. |
| `cockpit dashboard --pane [--direction <dir>] [--interval <s>]` | Open a refreshing sidebar pane in the current cmux workspace. |
| `cockpit dashboard sync-hub [--json]` | Mirror spoke `status.md` files into `{hubVault}/projects/` for Obsidian Dataview. |
| `cockpit runtime status <project>` | Check if a project's captain workspace is running |
| `cockpit runtime send <project> <msg>` | Send a message to a captain workspace (auto-Enter) |
| `cockpit runtime list` | List all workspaces from the active runtime |
| `cockpit workspace read <project> <path>` | Read a scope-relative file from the project's spoke vault |
| `cockpit workspace list <project> <dir>` | List entries in a spoke vault directory |
| `cockpit workspace read --hub <path>` | Read from the hub vault |
| `cockpit notify <message>` | Send a message to the user via the configured notifier |
| `cockpit projection emit [--scope user\|project] [--project <name>] [--target <name>] [--all]` | Emit cockpit rules + skills to Cursor/Codex/Gemini config files |
| `cockpit projection diff [same flags]` | Preview projection changes without writing |
| `cockpit projection list` | Show registered projection targets and their destinations |
| `cockpit crew spawn <project> <task> [--name <n>] [--direction tab\|right\|left\|up\|down] [--agent <a>]` | Spawn an interactive crew sub-session (tab in the captain workspace by default; `--direction` for a pane) |
| `cockpit crew send <project> <name> <message>` | Send a follow-up turn to an existing crew |
| `cockpit crew read <project> <name>` | Read a crew session's current screen |
| `cockpit crew close <project> <name>` | Shutdown a crew session (closes its tab) |
| `cockpit crew list <project>` | List live crews for a project |
| `cockpit shutdown [project]` | Graceful shutdown |
| `cockpit feedback` | Open opt-in feedback issue |

## Architecture

### Roles

- **Command** (Opus) — *on-demand* cross-project session. Spawned by `cockpit command --task <briefing|learnings-review|wiki-aggregate>` in a split pane; exits when the task completes. No persistent Command process.
- **Captain** (Opus) — project leader, uses Agent Teams + git worktrees
- **Crew** (Sonnet by default) — interactive sub-session running as a new tab in the captain's workspace (or a split pane via `--direction`). Each crew is named (`crew-1`, `crew-2`, …) and stays idle between turns waiting for the captain's next message — same model as a Claude Agent Team subagent. Spawn with `cockpit crew spawn`, send follow-ups with `cockpit crew send`, close when done. Works with any agent CLI (claude and opencode are fully interactive; codex/gemini currently print-mode). Uses GSD for complex tasks.

### Model Routing

Each role runs on the optimal model for cost/quality tradeoff. Configured in `config.json`:
- Command/Captain/Review: Opus (coordination + quality)
- Crew: Sonnet (execution)
- Exploration: Haiku (cheap lookups)

### Runtime Abstraction

Workspaces run on a pluggable **runtime driver** (currently only `cmux`). Each project may override the global default via its `runtime` field. Bash scripts call `cockpit runtime <op>` to talk to the configured runtime instead of any specific binary. New runtimes (tmux, Docker, SSH) are added as driver files in `src/runtimes/` — see `docs/specs/2026-04-20-plugin-system-runtime-design.md`.

### Workspace Abstraction

Vault storage (hub + per-project spokes) runs behind a pluggable **workspace driver** (currently only `obsidian`). Filesystem operations — `read`, `write`, `list`, `exists`, `mkdir` — go through the driver instead of `fs` directly. Each project may override the global default via its `workspace` field. Bash scripts call `cockpit workspace <op>` to read/write vault data without hardcoding paths. New backends (Notion, plain-md, S3) are added as driver files in `src/workspaces/` — see `docs/specs/2026-04-21-plugin-system-workspace-design.md`.

### Notifier Abstraction

User-facing notifications run behind a pluggable **notifier driver** (currently only `cmux`). Escalations and other "tell the user" events go through `cockpit notify <message>`. The default `CmuxNotifier` delegates to `cockpit runtime send --command` — the abstraction exists as a swap-point for future Slack/Discord/email/pager drivers. Notifier is global (no per-project override). See `docs/specs/2026-04-21-plugin-system-notifier-design.md`.

### Crew Spawn (Interactive Sub-Sessions)

Crew is the captain's equivalent of an Agent Team subagent — but runtime-agnostic. The captain spawns a crew via `cockpit crew spawn <project> "<task>" [--name <n>]`, which opens a new tab in the captain's cmux workspace, boots an interactive Claude session (no `-p`), and sends the task as the first turn. The crew works on it and **stays idle** waiting for follow-ups. The captain drives the session with `cockpit crew send/read/close/list`, addressing each crew by its tab title (`🔧 <project>:<name>`).

Pass `--direction right|left|up|down` to use a split pane instead of a tab. State lives in the surface buffer + git; tabs die with the captain workspace on `cockpit shutdown`. Non-Claude agents (codex/gemini) currently still launch in print-mode; full interactive support is a follow-up. See [`docs/specs/2026-05-05-cockpit-thin-redirect-design.md`](docs/specs/2026-05-05-cockpit-thin-redirect-design.md).

### Projection (Cross-Agent Config Sync)

Cockpit rules (Karpathy principles, captain-ops) and per-project AGENTS.md emit to each supported agent's canonical path via `cockpit projection emit`. User-level projection pushes cockpit's skills to `~/.cursor/rules/cockpit-global.mdc`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`. Project-level projection pushes a managed project's own `AGENTS.md` into `{project}/CLAUDE.md`, `{project}/.cursor/rules/cockpit.mdc`, `{project}/GEMINI.md` — zero cockpit-global content leaks into the project repo. Shared files use `<!-- cockpit:start --> ... <!-- cockpit:end -->` markers; dedicated files overwrite. See `docs/specs/2026-04-24-plugin-system-projection-design.md`.

The user-level projection now also inlines `orchestrator/captain.generic.md` and `orchestrator/crew.generic.md` as `## Captain Role` / `## Crew Role` sections inside the cockpit marker block, so non-Claude agents (Codex, Gemini, Cursor) load the same role descriptions Claude Code loads via `--append-system-prompt-file`. See `docs/specs/2026-05-05-multi-agent-template-parity-plan.md` (#45).

### Obsidian Vaults (Hub-and-Spoke)

- **Hub vault** (`~/cockpit-hub`) — cross-project dashboard + hub wiki
- **Spoke vaults** — per-project status, learnings, and wiki

### Knowledge System (opt-in writes)

- **Status (opt-in)** — captains record `{spokeVault}/status.md` via `write-status.sh` (also written by the captain session-end hook) when there's something worth noting (a blocker, "starting work on X"). Not on a schedule.
- **Dashboard** — `cockpit dashboard --pane` opens a refreshing sidebar pane in cmux that lists every project's live state, queried from the cockpit daemon's task records. `cockpit dashboard sync-hub` mirrors each spoke `status.md` into `{hubVault}/projects/` so the hub vault's `dashboard.md` Dataview query renders the same data inside Obsidian.
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
  "notifier": "cmux",
  "projects": {
    "brove": {
      "path": "~/projects/brove",
      "captainName": "brove-captain",
      "spokeVault": "~/cockpit-hub/spokes/brove",
      "host": "local",
      "runtime": "cmux",
      "workspace": "obsidian",
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
| opencode | ✅ driver + projection (interactive crew) | `opencode run "<prompt>"` with `--format json` / `-m <model>`; AGENTS.md projects to `~/.config/opencode/AGENTS.md`. |

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
