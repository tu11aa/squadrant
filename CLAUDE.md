<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **squadrant** (4157 symbols, 6162 relationships, 156 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/squadrant/context` | Codebase overview, check index freshness |
| `gitnexus://repo/squadrant/clusters` | All functional areas |
| `gitnexus://repo/squadrant/processes` | All execution flows |
| `gitnexus://repo/squadrant/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

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
