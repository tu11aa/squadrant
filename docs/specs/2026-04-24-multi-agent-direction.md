# Direction: Cockpit is Multi-Agent

**Date:** 2026-04-24
**Status:** Direction statement — guides all future work
**Related issues:** [#31](https://github.com/tu11aa/claude-cockpit/issues/31) projection, [#32](https://github.com/tu11aa/claude-cockpit/issues/32) Karpathy skill, [#33](https://github.com/tu11aa/claude-cockpit/issues/33) Multica reference

## Decision

Cockpit is a **multi-agent orchestration layer**, not a Claude Code accessory. It should support Claude Code, Codex, Cursor, Gemini CLI, and future coding agents equally. Features that only work for Claude Code are a migration target, not a permanent state.

## Why now

The plugin system (phases 1-4, all shipped) already abstracts the four major Claude-specific surfaces behind driver interfaces:

- **Runtime** — cmux today; tmux / Docker / SSH / other CLIs are future drivers
- **Workspace** — Obsidian today; Notion / plain-md / S3 are future drivers
- **Tracker** — GitHub today; Linear / Jira / GitLab are future drivers
- **Notifier** — cmux today; Slack / Discord / email / pager are future drivers

The abstraction proved out. The missing layer is **agent-side**: templates, skills, and instructions that only Claude Code reads.

## What "supports all" means concretely

| Layer | Claude Code | Codex | Cursor | Gemini CLI |
|---|---|---|---|---|
| Runtime | ✅ cmux | ✅ (runtime driver) | ✅ (runtime driver) | ✅ (runtime driver) |
| Instructions | `CLAUDE.md` | `AGENTS.md` | `.cursor/rules/*.mdc` | `GEMINI.md` |
| Skills | `SKILL.md` via Skill tool | via AGENTS.md include | via rule include | via GEMINI.md include |
| MCP config | `~/.claude/settings.json` | `~/.codex/config.toml` | `~/.cursor/mcp.json` | varies |
| Memory | claude-mem (MCP) | claude-mem (MCP, if MCP supported) | claude-mem (MCP) | claude-mem (MCP) |

## Pain points when using non-Claude agents today

From trying Cursor / Codex / Gemini CLI on cockpit-managed projects:

- Skills written for Claude's Skill tool aren't invoked (other agents don't have the tool)
- `CLAUDE.md` rules aren't read (agent looks at its own file)
- MCP servers aren't configured (each agent has its own config path)
- Daily logs / standup / retro integrations assume cmux + Claude
- Captain/crew templates are written Claude-specific (`.claude.md`) — generic versions (`.generic.md`) exist but are thinner

## Strategy

### Principles

1. **Claude Code is still the reference implementation.** It ships working today; other agents are migrations, not rewrites.
2. **AGENTS.md is the canonical instruction format.** `CLAUDE.md` becomes a thin wrapper or symlink.
3. **Skills stay portable markdown.** Claude Code reads via the Skill tool; other agents read via AGENTS.md inclusion. Don't translate frontmatter until a cross-agent SKILL.md spec stabilizes.
4. **Delegate what others already own.** MCP config sync → `conductor` or `mcp-linker`. Skill sharing → `skillshare`. Don't reinvent.
5. **Don't copy Multica.** Their team + cloud model is a different product. Cockpit's moat is solo-dev + knowledge-graph + local-first.

### Sequence

1. **Now** — direction stated (this doc, README, CLAUDE.md)
2. **Next** — Karpathy skill ported + wired into captain/crew templates ([#32](https://github.com/tu11aa/claude-cockpit/issues/32))
3. **Soon** — `cockpit projection` command for cross-agent config sync ([#31](https://github.com/tu11aa/claude-cockpit/issues/31))
4. **Later** — evaluate Multica ideas ([#33](https://github.com/tu11aa/claude-cockpit/issues/33)), runtime drivers for non-cmux agents

### Non-goals

- Team collaboration features (that's Multica's space)
- Web UI / daemon / WebSocket streaming (local-first, terminal-first)
- Replacing cmux as the default runtime (cmux stays the reference)
- Waiting for cross-agent SKILL.md standardization before shipping anything

## Success criteria

- A dev can open a cockpit-registered project in Codex, Cursor, or Gemini CLI and get **roughly equivalent** context (role identity, skills, MCP servers).
- "Roughly equivalent" means: the agent knows it's a captain/crew, knows how to spawn subtasks, has access to the same MCP servers, and can read status/learnings/wiki.
- Claude Code experience does not regress.

## Inspirations

- **[Multica](https://github.com/multica-ai/multica)** — validated the multi-agent runtime + skill-compounding direction
- **[AGENTS.md](https://agents.md/)** — convergence point for cross-agent instructions (Linux Foundation)
- **[Andrej Karpathy's coding principles](https://x.com/karpathy/status/2015883857489522876)** — behavioral baseline for every agent we orchestrate
- **[forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)** — reference packaging (plugin + CLAUDE.md + Cursor rule)
- **[amtiYo/agents](https://github.com/amtiYo/agents)** — canonical `.agents/` dir projecting to 9 agents; reference for [#31](https://github.com/tu11aa/claude-cockpit/issues/31)
