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

## Releasing

Releases follow GitFlow: cut `release/vX.Y.Z` from `develop`, bump `package.json` + `CHANGELOG.md`, then PR into `main`. A push to `main` triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which tags `vX.Y.Z` (from `package.json`), creates a GitHub Release from the CHANGELOG, and publishes to npm.

### npm publishing — use staged publishing

npm is retiring long-lived tokens that bypass 2FA for publishing:

- Since **August 2026**, bypass-2FA granular access tokens (GATs) can no longer perform account, org, or package **governance** actions (create/delete tokens, change maintainers or package access, configure trusted publishing) — those now require an interactive 2FA challenge.
- **Around January 2027**, bypass-2FA tokens lose **direct `npm publish`** entirely. Their remaining surface is reading private packages and **staging** a publish.

Automated publishing therefore moves to **staged publishing** (requires npm CLI ≥ 11.15.0, Node ≥ 22.14.0):

1. **CI stages** — `npm stage publish` uploads the tarball to a staging area. It never prompts for 2FA and works with any token type (including a bypass-2FA GAT or an OIDC trust token).
2. **A maintainer approves, with 2FA** — the version becomes installable only after approval:
   - CLI: `npm stage list` → `npm stage view <stage-id>` → `npm stage approve <stage-id>`
   - or the **Staged Packages** tab on npmjs.com

A package must **already exist** on the registry before it can be staged — staged publishing cannot create a brand-new package. The approval step requires a human 2FA challenge regardless of which token (or OIDC identity) staged the upload.

**Alternative — Trusted Publishing (OIDC):** register a trusted publisher for the package (GitHub repo + workflow name), give the publish job `permissions: id-token: write`, and use `actions/setup-node` with `registry-url`. This removes the stored token entirely. If the package requires proof-of-presence, still route the publish through `npm stage publish` — the approval step remains a human 2FA challenge.

**Do not** rely on a long-lived `NPM_TOKEN` secret for direct `npm publish` — that path is being removed. Until the workflow is migrated to `npm stage publish` (or OIDC), a release can be published locally with an interactive OTP:

```bash
npm publish --access public --otp=<code>
```

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
