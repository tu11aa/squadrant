# Quickstart

A guided first run: install, launch your first captain, spawn your first
crew, and (optionally) wire up your phone. For the pitch, see the
[README](README.md); for the full command/config reference, see
[docs/reference.md](docs/reference.md).

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

## Install & init

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

`squadrant init` does first-time setup — config, hub vault, scripts.
`squadrant doctor` verifies dependencies are wired up correctly.

## Your first captain

```bash
squadrant launch <project>
```

This starts the project's captain in cmux — a persistent Opus session that
plans and delegates for that project. `squadrant launch --all` starts every
registered captain at once. `squadrant status` gives you a quick status check
without spawning anything.

## Your first crew

Tell your captain what you want built. The captain spawns a crew — a fresh,
interactive sub-session (a new tab in the captain's workspace) — to do the
work, and drives it with a few commands:

```bash
squadrant crew spawn <project> "<task>" [--name <n>]   # spawn, task = first turn
squadrant crew send <project> <name> "<message>"       # send a follow-up turn
squadrant crew read <project> <name>                   # read the crew's current screen
squadrant crew close <project> <name>                  # shut it down when done
squadrant crew list <project>                          # list live crews
```

The crew works on the task and then goes idle waiting for your (or the
captain's) next message — same mental model as a Claude Agent Team subagent.
When it finishes, it signals **CREW DONE** (or **CREW BLOCKED** if it needs a
decision) instead of you having to babysit the pane.

## Drive it from your phone (optional)

Squadrant can bridge captains to a Telegram supergroup so you can delegate
and get lifecycle notifications (CREW DONE / BLOCKED / APPROVAL / …) from
your phone.

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Run `squadrant telegram setup` — it prompts for the bot token (input
   hidden), validates it via the Bot API, auto-detects your supergroup id,
   captures your Telegram user-id, and offers to enable remote control.
3. Bind a project to a topic: `squadrant telegram link <project>` (creates
   the forum topic and records the binding).
4. Check wiring with `squadrant telegram status`.

That's the happy path. For the full security model (fail-closed remote
control), per-project notification tuning, and the config schema, see
[Telegram (Two-Way, opt-in)](docs/reference.md#telegram-two-way-opt-in) in
the reference doc.

## Other handy things (optional)

- `squadrant command --task briefing` — one-shot cross-project Command
  session in a split pane (also: `--task learnings-review | wiki-aggregate`)
- `squadrant dashboard --pane` — a refreshing sidebar pane showing every
  project's live state
- `squadrant status` — quick status check, no Claude needed

## Troubleshooting

- `squadrant doctor` — health check, verifies dependencies
- `squadrant heal [--dry-run|daemon]` — targeted, idempotent remediation for
  squadrant components (daemon, health)

For everything else — the full command table, monorepo layout, architecture,
and config schema — see [docs/reference.md](docs/reference.md).
