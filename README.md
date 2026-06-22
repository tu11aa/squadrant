# Squadrant

Multi-project orchestration layer for coding agents. One command session controls everything.

> **Direction:** Squadrant is moving to support all major coding agents — Claude Code, Codex, Cursor, Gemini CLI — not just Claude Code. Claude Code is the reference implementation today; other agents land through the plugin system's driver abstractions and the upcoming cross-agent projection layer ([#31](https://github.com/tu11aa/squadrant/issues/31)). See [`docs/specs/2026-04-24-multi-agent-direction.md`](docs/specs/2026-04-24-multi-agent-direction.md).

## How It Works

```
squadrant launch <project>          → Captain (per project, in cmux)
squadrant launch --all              → Every Captain
squadrant command --task briefing   → One-shot Command session in a split pane
                                       (also: --task learnings-review | wiki-aggregate)
Captain → squadrant crew spawn …    → Crew (new tab in the captain workspace, fresh agent CLI)
```

1. **`squadrant init`** — first-time setup
2. **`squadrant launch <project>`** — start the project's captain in cmux
3. **`squadrant launch --all`** — start every captain at once
4. **`squadrant command --task briefing`** — on-demand Command session for cross-project work (optional; spawns in a split pane and exits when done)
5. **`squadrant status`** — quick status check without spawning anything

## Install

```bash
npm i -g squadrant               # global `squadrant` CLI (alias: `squad`)
squadrant init
squadrant doctor
```

Or from source:

```bash
git clone https://github.com/tu11aa/squadrant.git
cd squadrant
pnpm install
pnpm build                       # produces dist/index.js (the squadrant bin)
npm link                         # symlinks the global `squadrant`/`squad` to dist/index.js
squadrant init
squadrant doctor
```

> Squadrant was formerly published/developed as `claude-cockpit`; it was rebranded in 0.9.0 as it grew into a multi-agent orchestration layer.

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
| `squadrant init` | First-time setup — config, hub vault, scripts |
| `squadrant launch <project>` | Start a specific project captain |
| `squadrant launch --all` | Launch all captain workspaces |
| `squadrant command [--task <briefing\|learnings-review\|wiki-aggregate>] [--agent <a>]` | Spawn a one-shot Command session in a split pane (no persistent Command). |
| `squadrant status` | Show all project status (no Claude needed) |
| `squadrant standup` | Daily standup summary (zero LLM tokens) |
| `squadrant doctor` | Health check — verify dependencies |
| `squadrant projects list` | List registered projects |
| `squadrant projects add <name> <path>` | Register a project |
| `squadrant projects remove <name>` | Unregister a project |
| `squadrant dashboard [--once]` | Print a one-shot status grid for all projects to the terminal. |
| `squadrant dashboard --pane [--direction <dir>] [--interval <s>]` | Open a refreshing sidebar pane in the current cmux workspace. |
| `squadrant dashboard sync-hub [--json]` | Mirror spoke `status.md` files into `{hubVault}/projects/` for Obsidian Dataview. |
| `squadrant runtime status <project>` | Check if a project's captain workspace is running |
| `squadrant runtime send <project> <msg>` | Send a message to a captain workspace (auto-Enter) |
| `squadrant runtime list` | List all workspaces from the active runtime |
| `squadrant workspace read <project> <path>` | Read a scope-relative file from the project's spoke vault |
| `squadrant workspace list <project> <dir>` | List entries in a spoke vault directory |
| `squadrant workspace read --hub <path>` | Read from the hub vault |
| `squadrant notify <message>` | Send a message to the user via the configured notifier |
| `squadrant projection emit [--scope user\|project] [--project <name>] [--target <name>] [--all]` | Emit squadrant rules + skills to Cursor/Codex/Gemini config files |
| `squadrant projection diff [same flags]` | Preview projection changes without writing |
| `squadrant projection list` | Show registered projection targets and their destinations |
| `squadrant crew spawn <project> <task> [--name <n>] [--direction tab\|right\|left\|up\|down] [--agent <a>]` | Spawn an interactive crew sub-session (tab in the captain workspace by default; `--direction` for a pane) |
| `squadrant crew send <project> <name> <message>` | Send a follow-up turn to an existing crew |
| `squadrant crew read <project> <name>` | Read a crew session's current screen |
| `squadrant crew close <project> <name>` | Shutdown a crew session (closes its tab) |
| `squadrant crew list <project>` | List live crews for a project |
| `squadrant shutdown [project]` | Graceful shutdown |
| `squadrant effort [max\|balance\|low]` | Get or set the global crew tokenomics dial (no arg prints current) |
| `squadrant retro` | Generate a retro (weekly/sprint summary) from daily logs and git (zero tokens) |
| `squadrant config check` | Detect config drift vs the current default schema |
| `squadrant heal [--dry-run\|daemon]` | Targeted, idempotent remediation for squadrant components (daemon, health) |
| `squadrant group dispatch …` | Cross-project intra-group operations (dispatch a task to a sibling project) |
| `squadrant cmux …` | cmux integration helpers |
| `squadrant feedback` | Open opt-in feedback issue |

## Monorepo structure

Six internal packages in a one-way dependency DAG. All are private (not published to npm).

| Package | Owns | Notes |
|---|---|---|
| `@squadrant/shared` | Config schema, TypeScript types, constants | Leaf lib — zero internal deps |
| `@squadrant/core` | Daemon logic, state-machine, protocol, `AgentDriver` interface, task/crew bus | No concrete drivers — pure interfaces + orchestration |
| `@squadrant/agents` | AI driver seam — `claude`, `codex`, `opencode`, `gemini` drivers + registry | Implements `AgentDriver`. Add a new AI agent here. |
| `@squadrant/workspaces` | Runtime (cmux), workspace (obsidian), notifier (cmux) drivers + registries | Implements surface/workspace/notifier seams |
| `@squadrant/web` | Observability dashboard — bundled HTML/JS served by CLI | Read-only UI; inlined by CLI's tsup build |
| `@squadrant/cli` | Commands, bin entry, daemon host, templates, plugin dir | Root — depends on all other packages |

**Dependency DAG:** `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`

**Build outputs** (`pnpm build` via tsup, all internal packages inlined):
- `dist/index.js` — CLI bin (`squadrant` command), entry: `packages/cli/src/index.ts`
- `dist/squadrantd.js` — daemon process, entry: `packages/cli/src/daemon-host.ts`

See the [architecture diagram](docs/diagrams/2026-06-18-cockpit-monorepo-architecture.html) for a visual overview.

## Architecture

### Roles

- **Command** (Opus) — *on-demand* cross-project session. Spawned by `squadrant command --task <briefing|learnings-review|wiki-aggregate>` in a split pane; exits when the task completes. No persistent Command process.
- **Captain** (Opus) — project leader, uses Agent Teams + git worktrees
- **Crew** (Sonnet by default) — interactive sub-session running as a new tab in the captain's workspace (or a split pane via `--direction`). Each crew is named (`crew-1`, `crew-2`, …) and stays idle between turns waiting for the captain's next message — same model as a Claude Agent Team subagent. Spawn with `squadrant crew spawn`, send follow-ups with `squadrant crew send`, close when done. Works with any agent CLI (claude and opencode are fully interactive; codex/gemini currently print-mode). Uses GSD for complex tasks.

### Model Routing

Each role runs on the optimal model for cost/quality tradeoff. Configured in `config.json`:
- Command/Captain/Review: Opus (coordination + quality)
- Crew: Sonnet (execution)
- Exploration: Haiku (cheap lookups)

### Runtime Abstraction

Workspaces run on a pluggable **runtime driver** (currently only `cmux`). Each project may override the global default via its `runtime` field. Bash scripts call `squadrant runtime <op>` to talk to the configured runtime instead of any specific binary. New runtimes (tmux, Docker, SSH) are added as driver files in `@squadrant/workspaces` (`packages/workspaces/runtimes/`) — see `docs/specs/archive/2026-04-20-plugin-system-runtime-design.md`.

### Workspace Abstraction

Vault storage (hub + per-project spokes) runs behind a pluggable **workspace driver** (currently only `obsidian`). Filesystem operations — `read`, `write`, `list`, `exists`, `mkdir` — go through the driver instead of `fs` directly. Each project may override the global default via its `workspace` field. Bash scripts call `squadrant workspace <op>` to read/write vault data without hardcoding paths. New backends (Notion, plain-md, S3) are added as driver files in `@squadrant/workspaces` (`packages/workspaces/workspaces/`) — see `docs/specs/archive/2026-04-21-plugin-system-workspace-design.md`.

### Notifier Abstraction

User-facing notifications run behind a pluggable **notifier driver** (currently only `cmux`). Escalations and other "tell the user" events go through `squadrant notify <message>`. The default `CmuxNotifier` delegates to `squadrant runtime send --command` — the abstraction exists as a swap-point for future Slack/Discord/email/pager drivers. Notifier is global (no per-project override). See `docs/specs/archive/2026-04-21-plugin-system-notifier-design.md`.

### Crew Spawn (Interactive Sub-Sessions)

Crew is the captain's equivalent of an Agent Team subagent — but runtime-agnostic. The captain spawns a crew via `squadrant crew spawn <project> "<task>" [--name <n>]`, which opens a new tab in the captain's cmux workspace, boots an interactive Claude session (no `-p`), and sends the task as the first turn. The crew works on it and **stays idle** waiting for follow-ups. The captain drives the session with `squadrant crew send/read/close/list`, addressing each crew by its tab title (`🔧 <project>:<name>`).

Pass `--direction right|left|up|down` to use a split pane instead of a tab. State lives in the surface buffer + git; tabs die with the captain workspace on `squadrant shutdown`. Non-Claude agents (codex/gemini) currently still launch in print-mode; full interactive support is a follow-up. See [`docs/specs/archive/2026-05-05-squadrant-thin-redirect-design.md`](docs/specs/archive/2026-05-05-squadrant-thin-redirect-design.md).

### Effort Dial (Tokenomics)

`squadrant effort max|balance|low` is a single global dial that biases how aggressively crews consume tokens — a captain-discretion signal, not mechanical routing. `max` favors quality/tokens, `low` biases toward economy (e.g. preferring opencode for cheap work); `balance` sits between. Run `squadrant effort` with no argument to print the current setting. The value lives in config and is honored by captains via the captain-ops playbook ([#317](https://github.com/tu11aa/squadrant/issues/317) / [#381](https://github.com/tu11aa/squadrant/pull/381)).

### Crew Lifecycle & Delivery

- **Daemon-direct delivery** — crew turns and handoffs are delivered straight to the cmux surface by the daemon. The old `notify-relay` supervisor was deleted; there is no relay process to keep alive ([#332](https://github.com/tu11aa/squadrant/issues/332)).
- **Semantic heartbeat** — crews emit a lifecycle signal the captain reads as **CREW IDLE / QUIET / STALLED**, distinguishing "waiting for you" from "wedged" without scraping the pane ([#354](https://github.com/tu11aa/squadrant/issues/354)).
- **`stopped` project status + orphan reap** — when a captain goes away, the daemon reaps its orphaned crews and marks the project `stopped` (intentional shutdown) rather than leaving stale tabs or faulting ([#324](https://github.com/tu11aa/squadrant/issues/324) / [#323](https://github.com/tu11aa/squadrant/issues/323) / [#388](https://github.com/tu11aa/squadrant/pull/388)).

### Telegram (Two-Way, opt-in)

Drive squadrant from your phone ([#65](https://github.com/tu11aa/squadrant/issues/65)). When a `telegram` block is present in config, a daemon-internal bridge:

- **Outbound** — pushes each project's crew lifecycle events (CREW DONE / BLOCKED / IDLE) and other captain notifications to that project's Telegram forum topic. Best-effort: a Telegram failure never delays or breaks delivery to the captain pane.
- **Inbound (captain-only)** — a message you send in a project's topic is delivered into that project's **captain pane** as a labeled `📩 [from Telegram]` message; the captain decides what to do with it.

Absent the config block, the bridge is never constructed — zero behavior change. No runtime SDK is added (plain `fetch`; `@grammyjs/types` is a dev-only type dependency).

**Setup (recommended):**
1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Run `squadrant telegram setup` — it prompts for the bot token (input hidden), validates it via the Bot API, and auto-detects your supergroup id.
3. Bind a project to a topic: `squadrant telegram link <project>` (creates the forum topic and records the binding).
4. Check wiring with `squadrant telegram status`.

**Setup (manual):**
Put the token + ids in config (or export `TELEGRAM_BOT_TOKEN`) — see the `telegram` block under [Config](#config). Then run `squadrant telegram link <project>`.

> **⚠️ Security gap (v1):** anyone who can post in the linked supergroup can steer the captain — **chat membership implies captain control**. Inbound is only filtered by a `chat_id` allowlist; a per-user-id allowlist that closes this is deferred to [#321](https://github.com/tu11aa/squadrant/issues/321). Inbound text is always treated as data (a captain message), never executed as a shell command.

> **Interim note (link ↔ daemon 409):** the Telegram Bot API allows only one `getUpdates` consumer at a time. If a future link flow needs `getUpdates` and the daemon's inbound poll is running, you may hit a 409 conflict — run `squadrant telegram link` with the daemon stopped (#321 MAJOR-4). v1's `link` uses only `createForumTopic`, so this does not apply today, but keep it in mind for hardening.

### Projection (Cross-Agent Config Sync)

Squadrant rules (Karpathy principles, captain-ops) and per-project AGENTS.md emit to each supported agent's canonical path via `squadrant projection emit`. User-level projection pushes squadrant's skills to `~/.cursor/rules/squadrant-global.mdc`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`. Project-level projection pushes a managed project's own `AGENTS.md` into `{project}/CLAUDE.md`, `{project}/.cursor/rules/squadrant.mdc`, `{project}/GEMINI.md` — zero squadrant-global content leaks into the project repo. Shared files use `<!-- squadrant:start --> ... <!-- squadrant:end -->` markers; dedicated files overwrite. See `docs/specs/archive/2026-04-24-plugin-system-projection-design.md`.

The user-level projection now also inlines `templates/captain.generic.md` and `templates/crew.generic.md` as `## Captain Role` / `## Crew Role` sections inside the squadrant marker block, so non-Claude agents (Codex, Gemini, Cursor) load the same role descriptions Claude Code loads via `--append-system-prompt-file`. See `docs/specs/archive/2026-05-05-multi-agent-template-parity-plan.md` (#45).

### Obsidian Vaults (Hub-and-Spoke)

- **Hub vault** (`~/squadrant-hub`) — cross-project dashboard + hub wiki
- **Spoke vaults** — per-project status, learnings, and wiki

### Knowledge System (opt-in writes)

- **Status (opt-in)** — captains record `{spokeVault}/status.md` via `write-status.sh` (also written by the captain session-end hook) when there's something worth noting (a blocker, "starting work on X"). Not on a schedule.
- **Dashboard** — `squadrant dashboard --pane` opens a refreshing sidebar pane in cmux that lists every project's live state, queried from the squadrant daemon's task records. `squadrant dashboard sync-hub` mirrors each spoke `status.md` into `{hubVault}/projects/` so the hub vault's `dashboard.md` Dataview query renders the same data inside Obsidian.
- **Handoff files** — captain writes when in-flight work needs to survive into tomorrow; skipped on uneventful sessions.
- **Daily logs** — captain writes when the day produced something worth a log; not on a schedule.
- **Learnings** — recorded when a captain encounters a genuinely surprising or reusable pattern.
- **Wiki** — compiled, indexed knowledge pages in spoke vaults (`wiki/pages/`); promoted from learnings when worth maintaining.
- **Hub Wiki** — cross-project knowledge aggregated by an on-demand `squadrant command --task wiki-aggregate` run.
- Scripts: `wiki-ingest.sh`, `wiki-query.sh`, `wiki-log.sh`.

### Session Continuity

- **Handoff files** — captain writes context on shutdown, reads on startup
- **Session freshness** — auto-detects new day or template changes, forces fresh context
- **claude-mem** — cross-session memory via MCP plugin

## Config

`~/.config/squadrant/config.json`

```json
{
  "commandName": "command",
  "hubVault": "~/squadrant-hub",
  "runtime": "cmux",
  "workspace": "obsidian",
  "notifier": "cmux",
  "telegram": {
    "botToken": "123456:ABC...",
    "supergroupId": -1001234567890,
    "chats": [-1001234567890],
    "pollMs": 1000
  },
  "projects": {
    "brove": {
      "path": "~/projects/brove",
      "captainName": "brove-captain",
      "spokeVault": "~/squadrant-hub/spokes/brove",
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

The `telegram` block is **optional** — omit it and the Telegram bridge is never constructed. `botToken` may be left out of the file and supplied via the `TELEGRAM_BOT_TOKEN` env var instead. `chats` is the inbound `chat_id` allowlist; `pollMs` (default `1000`) is the inbound long-poll cadence. See [Telegram (Two-Way, opt-in)](#telegram-two-way-opt-in).

## Supported Agents

| Agent | Status | Notes |
|---|---|---|
| Claude Code | ✅ Shipping | Reference implementation; reads `CLAUDE.md`, Skill tool, MCP via settings.json |
| Codex CLI | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.codex/AGENTS.md` (#45). First-class role identity is #35. |
| Cursor | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.cursor/rules/squadrant-global.mdc` (#45). |
| Gemini CLI | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.gemini/GEMINI.md` (#45). |
| opencode | ✅ driver + projection (interactive crew) | `opencode run "<prompt>"` with `--format json` / `-m <model>`; AGENTS.md projects to `~/.config/opencode/AGENTS.md`. |

Cross-agent config sync (one canonical source → agent-specific formats) is tracked in [#31](https://github.com/tu11aa/squadrant/issues/31).

## Inspirations

- **[Andrej Karpathy](https://x.com/karpathy/status/2015883857489522876)** — coding principles baked into every captain/crew role ([`plugin/skills/karpathy-principles/SKILL.md`](plugin/skills/karpathy-principles/SKILL.md))
- **[forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)** — reference packaging for the four principles (MIT)
- **[Multica](https://github.com/multica-ai/multica)** — validated the multi-agent runtime + skill-compounding direction
- **[AGENTS.md](https://agents.md/)** — convergence point for cross-agent instructions
- **[OpenSpace](https://github.com/openspacelabs/openspace)** — self-improving learnings loop (record → capture → fix → mark-useful)
- **[ComposioHQ](https://github.com/ComposioHQ/composio)** — tool/skill portability across agents

## License

MIT
