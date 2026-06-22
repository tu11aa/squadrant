# Contributing to Squadrant

Thanks for helping improve Squadrant. This guide captures the conventions already
true in the repo — follow them and your change will land cleanly.

## Setup

Squadrant uses **pnpm** (pinned to `pnpm@10.30.3` via `packageManager`):

```bash
pnpm install      # install workspace deps
pnpm build        # tsc -b across the six packages, then tsup bundles dist/
pnpm test         # vitest (run mode)
pnpm lint         # tsc --noEmit
```

`pnpm build` must run before `pnpm test` on a fresh checkout — the tests resolve
the internal packages (`@squadrant/*`) from their build outputs.

## Branching (GitFlow)

- Branch off **`develop`**.
- Open your PR back into **`develop`**.
- **`main` is release-only** — never PR a feature straight to `main`.

## Run tests + lint locally before opening a PR

**There is no PR-time CI.** Tests only run on push to `main`, so broken tests have
reached `develop` silently before. Run `pnpm test` and `pnpm lint` on a clean
checkout and confirm both are green before you open a PR.

## The ESM / NodeNext `.js`-extension gotcha

This is a NodeNext ESM project: **relative imports must include the `.js`
extension** (`import { x } from "./foo.js"`), even though the source is `.ts`.
`tsc` and `vitest` will happily pass with a missing extension, but the bundled
runtime crashes. The real gate is:

```bash
node dist/index.js --help
```

If that works after a build, your imports are correct.

## Coding discipline — Karpathy principles

Every change follows [`plugin/skills/karpathy-principles/SKILL.md`](plugin/skills/karpathy-principles/SKILL.md):

1. **Think before coding** — surface assumptions and tradeoffs; ask if ambiguous.
2. **Simplicity first** — no speculative abstractions, no impossible-case error handling.
3. **Surgical changes** — every changed line traces to the request; no drive-by refactors.
4. **Goal-driven execution** — define verifiable success criteria before implementing.

## Monorepo shape

Six packages in a one-way DAG — put each change in the right package:

```
shared ◄ core ◄ {agents, workspaces, web} ◄ cli
```

| Package | Owns |
|---|---|
| `@squadrant/shared` | Config schema, types, constants — leaf, zero internal deps |
| `@squadrant/core` | Daemon, state-machine, protocol, `AgentDriver` interface |
| `@squadrant/agents` | AI driver seam: claude / codex / opencode / gemini |
| `@squadrant/workspaces` | Runtime (cmux), workspace (obsidian), notifier drivers |
| `@squadrant/web` | Observability dashboard (bundled HTML/JS) |
| `@squadrant/cli` | Commands, bin entry, daemon host — root package |

## Platform

Squadrant is **macOS-only** for now. Guard platform-specific tests accordingly
(`it.skipIf(process.platform !== "darwin")`).

## Agent-filed issues

Issues opened by an agent are titled **`[agent-report] <signature>`** (see the
"Reporting squadrant bugs" block in `AGENTS.md`). If you're picking one up, this
guide is the path that closes the loop: **bug found → issue → fix → PR**.
