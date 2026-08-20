## Project Direction: Multi-Agent

Squadrant is a **multi-agent orchestration layer**, not a Claude-Code-only tool. Claude Code is the reference implementation today; Codex, Cursor, and Gemini CLI are supported (or in progress) through the runtime driver abstraction and the upcoming cross-agent projection layer (issue #31).

When working on squadrant:
- Prefer **`AGENTS.md`** as the canonical instruction format. `CLAUDE.md` is becoming a thin wrapper.
- When adding agent-facing features, ask: *"does this work for non-Claude agents too?"* If not, file a follow-up issue to generalize it.
- Don't add Claude-only surface area without a migration path. The three plugin slots (runtime / workspace / notifier) exist specifically to avoid this.
- Skills in `plugin/skills/` are portable markdown — Claude Code reads them via the Skill tool; other agents read them via `AGENTS.md` inclusion.

Full direction statement: [`docs/specs/2026-04-24-multi-agent-direction.md`](docs/specs/2026-04-24-multi-agent-direction.md).

## Repository layout

Six packages in a one-way DAG: `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`

| Package | Owns |
|---|---|
| `@squadrant/shared` | Config schema, types, constants — leaf, zero internal deps |
| `@squadrant/core` | Daemon, state-machine, protocol, `AgentDriver` interface |
| `@squadrant/agents` | AI driver seam: claude / codex / opencode / gemini |
| `@squadrant/workspaces` | Runtime (cmux), workspace (obsidian), notifier drivers |
| `@squadrant/web` | Observability dashboard (bundled HTML/JS) |
| `@squadrant/cli` | Commands, bin entry, daemon host — root package |

Build outputs: `dist/index.js` (CLI bin) · `dist/squadrantd.js` (daemon). See [architecture diagram](docs/diagrams/2026-06-18-squadrant-monorepo-architecture.html).

## Coding Discipline: Karpathy Principles

Every coding task in this repo (captain, crew, and direct edits) follows [`plugin/skills/karpathy-principles/SKILL.md`](plugin/skills/karpathy-principles/SKILL.md):

1. **Think before coding** — surface assumptions and tradeoffs; ask if ambiguous
2. **Simplicity first** — no speculative abstractions, no impossible-case error handling
3. **Surgical changes** — every changed line traces to the request; no drive-by refactors
4. **Goal-driven execution** — define verifiable success criteria before implementing

These complement (do not replace) `superpowers:test-driven-development`.
