# Squadrant

Run your coding agents like an engineering team. You're the manager —
Squadrant gives you **captains** who plan and delegate, and **crews** who
write the code.

## The mental model

```
You
 │
 ├── squadrant launch <project>   →  Captain (project A)
 │                                     │
 │                                     └── squadrant crew spawn  →  Crew, Crew, …
 │
 └── squadrant launch <project-2> →  Captain (project B)
                                        └── …
```

- **You** — set direction, make the calls only you can make.
- **Captain** — one per project, lives in cmux, plans and delegates. Your
  standing project lead.
- **Crew** — a fresh interactive sub-session the captain spawns to actually
  write the code, then reports back and signals when it's done or blocked.

One person, operating like an engineering org.

> Squadrant is also moving to support every major coding agent — Claude Code,
> Codex, Cursor, Gemini CLI — not just Claude Code. Claude Code is the
> reference implementation today; other agents land through the plugin
> system's driver abstractions and the upcoming cross-agent projection layer
> ([#31](https://github.com/tu11aa/squadrant/issues/31)). See
> [`docs/specs/2026-04-24-multi-agent-direction.md`](docs/specs/2026-04-24-multi-agent-direction.md).

## Why you'd want it

- **Run several projects at once** — one captain per project, each with its
  own context, all supervised from the same session.
- **Delegate instead of micromanage** — hand a task to a crew and let it
  work; you don't watch every keystroke.
- **Agents signal you, not the other way around** — crews report **CREW
  DONE** / **CREW BLOCKED** / **CREW NEEDS INPUT** instead of you polling a
  pane to see if it's finished.
- **Drive it from your phone** — optional two-way Telegram bridge, so you can
  delegate and get notified without being at your desk.

## What it feels like

```
squadrant launch brove
  → Captain boots in cmux

You (in the captain pane): "build the export-to-CSV feature"
  → Captain spawns a crew: squadrant crew spawn brove "build export-to-CSV"

  → Crew works in its own tab, writes the code, runs tests

  → 🎉 CREW DONE — captain reviews, merges or follows up
```

Full walkthrough, including your first captain and crew, step by step: see
[QUICKSTART.md](QUICKSTART.md).

## Install

```bash
npm i -g squadrant               # global `squadrant` CLI (alias: `squad`)
squadrant init
squadrant doctor
```

See [QUICKSTART.md](QUICKSTART.md) for prerequisites, the from-source build,
and a guided first run.

> Squadrant was formerly published/developed as `claude-cockpit`; it was
> rebranded in 0.9.0 as it grew into a multi-agent orchestration layer.

## Supported Agents

| Agent | Status | Notes |
|---|---|---|
| Claude Code | ✅ Shipping | Reference implementation; reads `CLAUDE.md`, Skill tool, MCP via settings.json |
| Codex CLI | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.codex/AGENTS.md` (#45). First-class role identity is #35. |
| Cursor | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.cursor/rules/squadrant-global.mdc` (#45). |
| Gemini CLI | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.gemini/GEMINI.md` (#45). |
| opencode | ✅ driver + projection (interactive crew) | `opencode run "<prompt>"` with `--format json` / `-m <model>`; AGENTS.md projects to `~/.config/opencode/AGENTS.md`. |

Cross-agent config sync (one canonical source → agent-specific formats) is
tracked in [#31](https://github.com/tu11aa/squadrant/issues/31).

## Where to go next

- [QUICKSTART.md](QUICKSTART.md) — hands-on first run: install, first
  captain, first crew, optional Telegram
- [Architecture diagram](docs/diagrams/2026-06-18-squadrant-monorepo-architecture.html)
  — visual overview of the monorepo
- [docs/reference.md](docs/reference.md) — full command table, monorepo
  structure, architecture deep-dive, Telegram integration, config schema
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, branching, and conventions for
  contributing

## Inspirations

- **[Andrej Karpathy](https://x.com/karpathy/status/2015883857489522876)** — coding principles baked into every captain/crew role ([`plugin/skills/karpathy-principles/SKILL.md`](plugin/skills/karpathy-principles/SKILL.md))
- **[forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)** — reference packaging for the four principles (MIT)
- **[Multica](https://github.com/multica-ai/multica)** — validated the multi-agent runtime + skill-compounding direction
- **[AGENTS.md](https://agents.md/)** — convergence point for cross-agent instructions
- **[OpenSpace](https://github.com/openspacelabs/openspace)** — self-improving learnings loop (record → capture → fix → mark-useful)
- **[ComposioHQ](https://github.com/ComposioHQ/composio)** — tool/skill portability across agents

## License

MIT
