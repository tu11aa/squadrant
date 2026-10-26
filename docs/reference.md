# Squadrant Reference

Full command list, monorepo layout, architecture deep-dive, Telegram
integration, and config schema. If you're new here, start with the
[README](../README.md) for the pitch and [QUICKSTART](../QUICKSTART.md) for a
guided first run — come back here when you need the details.

## Table of contents

- [Commands](#commands)
- [Monorepo structure](#monorepo-structure)
- [Architecture](#architecture)
  - [Roles](#roles)
  - [Model Routing](#model-routing)
  - [Thinking Level (per-role)](#thinking-level-per-role)
  - [Provider Presets (`squadrant init`)](#provider-presets-squadrant-init)
  - [Router Backend (Harness/Provider Decoupling)](#router-backend-harnessprovider-decoupling)
  - [Runtime Abstraction](#runtime-abstraction)
  - [Workspace Abstraction](#workspace-abstraction)
  - [Notifier Abstraction](#notifier-abstraction)
  - [Lifecycle Sources](#lifecycle-sources)
  - [Control/Captain Channel (#667)](#controlcaptain-channel-667)
  - [Agent Session Introspection (#669)](#agent-session-introspection-669)
  - [Crew Spawn (Interactive Sub-Sessions)](#crew-spawn-interactive-sub-sessions)
  - [Answering a Crew's Open Prompt (#592)](#answering-a-crews-open-prompt-592)
  - [Effort Dial (Tokenomics)](#effort-dial-tokenomics)
  - [Crew Lifecycle & Delivery](#crew-lifecycle--delivery)
  - [Telegram (Two-Way, opt-in)](#telegram-two-way-opt-in)
  - [Projection (Cross-Agent Config Sync)](#projection-cross-agent-config-sync)
  - [Storage layout: workspace (#983)](#storage-layout-workspace-983)
  - [Knowledge System (opt-in writes)](#knowledge-system-opt-in-writes)
  - [Session Continuity](#session-continuity)
  - [Runtime state (`~/.local/state/squadrant`, #983)](#runtime-state-localstatesquadrant-983)
- [Captain rollover](#captain-rollover-1010)
- [Context meter & rollover suggestions](#context-meter--rollover-suggestions-1015)
- [Human review guide](#human-review-guide-1012)
- [MCP server (`squadrant mcp`)](#mcp-server-squadrant-mcp-1029)
- [Config](#config)

## Commands

| Command | Description |
|---------|-------------|
| `squadrant init [--preset <a\|b\|c>] [--hub <path>]` | First-time setup — provider preset, config, hub vault, scripts |
| `squadrant launch <project>` | Start a specific project captain |
| `squadrant launch --all` | Launch all captain workspaces |
| `squadrant command [--task <briefing\|learnings-review\|wiki-aggregate>] [--agent <a>]` | Spawn a one-shot Command session in a split pane (no persistent Command). |
| `squadrant captain compact <project> [--focus <text>]` | Queue a `/compact` for the project's Claude captain and return immediately. See [Captain rollover](#captain-rollover-1010). |
| `squadrant status` | Show all project status (no Claude needed) |
| `squadrant standup` | Daily standup summary (zero LLM tokens) |
| `squadrant doctor [-v]` | Health check — verify dependencies. Also warns about dangling path references (`-v` lists all of them, not just 5 per site); see [Reference sweep](#reference-sweep-998). |
| `squadrant migrate kb [--dry-run]` | One-shot move to the KB storage layout: spoke exchange to `~/squadrant/workspace/<p>/`, retired hub files and the already-copied legacy `~/.config/squadrant` state to `~/squadrant/archive/<date>/`, plus `knowledge migrate`. Then rewrites references to the moved paths. Never deletes; idempotent. See [Storage layout](#storage-layout-workspace-983). |
| `squadrant migrate path <from> <to> [--dry-run]` | Move a file or dir you made, with the same merge rules as `migrate kb`, then rewrite references to it. If `<from>` is already gone and `<to>` exists, it only rewrites the references. See [Reference sweep](#reference-sweep-998). |
| `squadrant projects list` | List registered projects |
| `squadrant projects add <name> <path>` | Register a project (creates `~/squadrant/workspace/<name>/`; no Obsidian spoke scaffold since #983) |
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
| `squadrant crew answer <project> <name> <option> [--expect <text>] [--text <answer>]` | Deliberately answer a crew's open AskUserQuestion/permission prompt by index or text — never an implicit default (#592) |
| `squadrant crew read <project> <name>` | Read a crew session's current screen |
| `squadrant crew msg <project> <seq>` | Print one mailbox entry in full — the crew's whole reply or question, also from rotated segments (#1030) |
| `squadrant crew close <project> <name>` | Shutdown a crew session (closes its tab) |
| `squadrant crew list <project>` | List live crews for a project |
| `squadrant sessions [--json] [--agent <name>] [--project <name>] [--live-only]` | List live agent sessions squadrant can introspect (read-only; [#669](https://github.com/tu11aa/squadrant/issues/669)) |
| `squadrant whoami [--json]` | Show the agent session calling the command (read-only; [#669](https://github.com/tu11aa/squadrant/issues/669)) |
| `squadrant shutdown [project]` | Graceful shutdown. Closes the captain workspace whether or not it is pinned (unpins first, like `launch --fresh`); a refused close prints cmux's reason |
| `squadrant effort [max\|balance\|low]` | Get or set the global crew tokenomics dial (no arg prints current) |
| `squadrant gate mode [on\|off\|auto]` | Get or set the permission gate mode `defaults.gate.mode` (no arg prints current + source: env/config/default); no daemon bounce needed ([#854](https://github.com/tu11aa/squadrant/issues/854)) |
| `squadrant gate status` | Show the effective gate mode/source, resolved engine, classifier model, and whether the engine's credential is present (never the value) |
| `squadrant retro` | Generate a retro (weekly/sprint summary) from daily logs and git (zero tokens) |
| `squadrant config check` | Detect config drift vs the current default schema |
| `squadrant heal [--dry-run\|daemon]` | Targeted, idempotent remediation for squadrant components (daemon, health) |
| `squadrant ping <project> "<msg>"` | Fire-and-forget: deliver a message into any registered project's captain pane (no tracked task, no report-back) |
| `squadrant dispatch <project> "<task>"` | Dispatch a tracked task to any registered project; reports back to the origin on settle. Same group additionally auto-accepts and boots the target captain if down (`squadrant launch` gets the `--warmup-timeout` budget, default 120s; a failed launch reports its exit code + stderr — see #999) — see [cross-project ping & dispatch](specs/2026-07-02-cross-project-ping-dispatch-design.md) |
| `squadrant group dispatch …` | **Deprecated alias** for `squadrant dispatch` — kept working, prints a deprecation note |
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

See the [architecture diagram](diagrams/2026-08-22-squadrant-architecture.html) for a visual overview (6-package DAG, driver seams, lifecycle sources, control/captain channel).

## Architecture

### Roles

- **Command** (Opus) — *on-demand* cross-project session. Spawned by `squadrant command --task <briefing|learnings-review|wiki-aggregate>` in a split pane; exits when the task completes. No persistent Command process.
- **Captain** (Opus) — project leader, uses Agent Teams + git worktrees
- **Crew** (Sonnet by default) — interactive sub-session running as a new tab in the captain's workspace (or a split pane via `--direction`). Each crew is named (`crew-1`, `crew-2`, …) and stays idle between turns waiting for the captain's next message — same model as a Claude Agent Team subagent. Spawn with `squadrant crew spawn`, send follow-ups with `squadrant crew send`, close when done. Works with any agent CLI (claude, opencode, and codex are fully interactive; gemini currently print-mode). Uses GSD for complex tasks.

### Model Routing

Each role runs on the optimal model for cost/quality tradeoff. Configured in `config.json`:
- Command/Captain/Review: Opus (coordination + quality)
- Crew: Sonnet (execution)
- Exploration: Haiku (cheap lookups)

### Thinking Level (per-role)

Alongside a per-role **model**, each role can pin a per-role **thinking level** — how hard the model reasons within a session. It maps to Claude Code's `--effort` flag and is **claude-only**: codex / opencode / gemini never receive the flag.

```json
{
  "defaults": {
    "roles": {
      "captain": { "agent": "claude", "model": "fable", "thinking": "medium" },
      "crew":    { "agent": "claude", "model": "sonnet", "thinking": "high" }
    }
  }
}
```

- Valid values: `low` | `medium` | `high` | `xhigh` | `max`.
- Settable on any role (`command` | `captain` | `crew` | `exploration` | `side`).
- **Unset ⇒ the flag is omitted entirely** ⇒ the agent's own default effort. There is no built-in default.
- Override per invocation with `squadrant launch --thinking <level>` (captain/command) or `squadrant crew spawn --thinking <level>` (crew). Precedence, highest first: explicit `--thinking` flag → `defaults.roles.<role>.thinking` → omitted — the same rule `--model` already follows.
- An invalid level fails fast with the list of valid values, rather than being passed through for the claude CLI to warn about and silently ignore.

> **Not the same thing as [`defaults.effort`](#effort-dial-tokenomics).** `defaults.effort` (`max|balance|low`, set via `squadrant effort`) is the *crew tokenomics dial* — a global, captain-discretion signal about how aggressively to spend tokens. `defaults.roles.<role>.thinking` is a per-role reasoning-depth setting emitted as a CLI flag. They share the word `max` and nothing else; changing one does not affect the other.

### Provider Presets (`squadrant init`)

A fresh install must not assume the operator has an Anthropic credential. `squadrant init` asks **one** provider question — or takes `--preset <a|b|c>` non-interactively — and writes the matching `defaults` blocks ([#826](https://github.com/tu11aa/squadrant/issues/826)). Preset A (all-claude + `auto`) remains the default and preserves back-compat.

A preset writes **both** `roles` **and** `defaults.crewRouting.rules` — otherwise the shipped rules (`extreme`/`hard` → `claude`) would silently override a non-claude `roles.crew` for most tasks. Every tier resolves to the same agent family as `roles`.

| Preset | Provider | Writes |
|---|---|---|
| **A** *(default)* | Claude Code (Pro/Max subscription or API key) | `roles` = all `claude` (command/captain/side = `opus`, crew = `sonnet`, exploration = `haiku`); `permissions` command/captain/crew = `auto`; `crewRouting` = the shipped rules (`extreme`/`hard` → `claude` opus/sonnet, `mobile` → `codex`, `daily` → `opencode`) |
| **B** | opencode (no Anthropic subscription) | `roles` = all `opencode`, model `opencode-go/deepseek-v4.1-flash`; `permissions` = `auto`; `crewRouting` = `extreme`/`hard`/`daily` → `opencode` (same model), `mobile` → `codex`; router/gate absent |
| **C** | Codex (ChatGPT Pro) | `roles` = all `codex`; `crewRouting` = every tier → `codex` |

> Preset C used to be "Claude harness + router backend" (advanced) and Codex was `d`. That router preset was retired — the operator no longer runs claude through a router — and Codex moved down to `c` to keep the catalog contiguous. `--preset d` is still accepted as a deprecated alias for `c` so existing scripts/configs don't hard-fail; `squadrant init --help` no longer lists it. The router/gate machinery itself is unchanged and still available via manual config — see [Router Backend](#router-backend-harnessprovider-decoupling).

- **Non-interactive:** `squadrant init --preset <a|b|c>`. Invalid ids fail fast before any write.
- **Re-run-safe:** on an existing config, init fills only a wholly-absent `roles`/`permissions`/`crewRouting` block. Pass `--preset <id>` explicitly to overwrite the preset-owned blocks (`roles`, `permissions`, `crewRouting`). Unrelated sections (`defaults.router`, `defaults.gate`, `defaults.effort`, `projects`, `telegram`, …) are never touched.
- **Credential detection:** init probes `claude auth status` (JSON). With no Anthropic credential it **warns** and suggests B — it never silently keeps/claims A. A probe that is missing, errors, or returns unreadable output degrades to "not authenticated".

### Router Backend (Harness/Provider Decoupling)

Squadrant separates the **harness** (the agent CLI that owns the terminal, hooks, permissions, and lifecycle) from the **backend** (where the model actually comes from). On every role and routing rule, `agent` selects the harness (`claude` | `codex` | `opencode` | `gemini`) and the optional `backend` selects the provider ([#772](https://github.com/tu11aa/squadrant/issues/772)):

| `backend` | What it means |
|---|---|
| `native` **(default)** | The harness uses its own auth (a subscription or the CLI's own API login). No router code runs. |
| `direct` | The `claude` harness points straight at an Anthropic-Messages upstream (`ANTHROPIC_BASE_URL` + credential). No shim. |
| `proxy` | The `claude` harness points at squadrant's loopback shim in `squadrantd`, which swaps auth, strips Anthropic-only fields for non-Anthropic upstreams, and exposes health + cost. |

`direct`/`proxy` are **claude-only** — they speak the Anthropic Messages seam, so a non-claude harness always runs `native` (a non-claude `direct`/`proxy` is rejected at spawn and flagged by `squadrant config check`). An absent `backend` is `native`, even when `defaults.router` exists.

The seam is *"any endpoint that speaks Anthropic Messages"* — squadrant never translates to the OpenAI protocol; that is the upstream's job (OpenRouter's Anthropic skin, or a local router such as CCR / LiteLLM). See the [transport design](specs/2026-09-11-router-transport-u1-design.md) and [config design](specs/2026-09-11-router-config-u2-design.md).

#### Config block

`defaults.router` is a **single optional global block** — one upstream per machine. Roles and rules vary only `backend` + `model`; there is no per-rule upstream override.

```jsonc
{
  "defaults": {
    "router": {
      "kind": "openrouter",        // opencode-go | openrouter | ccr | litellm | custom
      "baseUrl": "https://openrouter.ai/api",  // origin + base path, NO "/v1"
      "apiKey": "sk-or-...",       // inline credential…
      "apiKeyEnv": "OPENROUTER_API_KEY",  // …or the env var holding it (mutually exclusive)
      "authHeader": "Authorization",      // "Authorization" (Bearer, default) | "x-api-key"
      "extraHeaders": {},          // static headers on every upstream request
      "port": 0,                   // loopback bind port; 0 = ephemeral
      "isAnthropic": false,        // true only for a real-Anthropic upstream
      "models": {                  // optional alias table (see "Model ids" below)
        "sonnet": { "upstream": "anthropic/claude-sonnet-5" }
      }
    },
    "roles": {
      "crew": { "agent": "claude", "backend": "proxy", "model": "sonnet" }
    },
    "crewRouting": {
      "rules": [
        { "tier": "hard", "match": "refactor|implement|feature",
          "agent": "claude", "backend": "proxy", "model": "sonnet" }
      ]
    }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `kind` | yes | One of `opencode-go` \| `openrouter` \| `ccr` \| `litellm` \| `custom`. Drives auth / `isAnthropic` defaults. |
| `baseUrl` | yes | Origin + base path **without** `/v1` (the client appends `/v1/messages`; including `/v1` yields `/v1/v1/messages` → 404). |
| `apiKey` / `apiKeyEnv` | one | Inline credential (config is written `0600`) or the name of the env var holding it. Mutually exclusive. The env var must be visible to the **daemon** process. |
| `authHeader` | no | `Authorization` → `Authorization: Bearer <key>` (default); `x-api-key` → `x-api-key: <key>` (the `opencode-go` default). |
| `extraHeaders` | no | Static headers merged into every upstream request, e.g. `{ "x-opencode-session": "squadrant" }` (required by opencode-go). |
| `port` | no | Loopback bind port; `0` (default) = ephemeral. |
| `isAnthropic` | no | `true` for a real-Anthropic upstream — disables the shim's server-tool / field stripping. |
| `models` | no | Optional alias table (see [Model ids](#model-ids-and-the-alias-layer)). |

**Precedence** (highest first): explicit `--backend` flag → matching rule's `backend` → `defaults.roles.<role>.backend` → `native`. A rule's `agent`/`model`/`backend` is a unit: passing `--agent` or `--model` suppresses the rule entirely (the existing [#275](https://github.com/tu11aa/squadrant/issues/275) contract); `--backend` overrides only the backend.

**`router` is boot-time config.** A direct edit of `config.json` needs a daemon bounce. Changing a key via `squadrant config set defaults.router…` restarts the daemon for you (`defaults.router` is in `DAEMON_CACHED_PREFIXES`).

#### How to set up a router (OpenRouter)

OpenRouter ships a native Anthropic Messages endpoint (the "Anthropic skin"), so the `claude` harness can use it directly. The walkthrough below routes **crew** through the shim; adjust `roles`/`crewRouting` to route other roles too (only `crew` is wired to the router spawn path today).

1. **Create an OpenRouter API key** at [openrouter.ai/keys](https://openrouter.ai/keys) and export it where the daemon can read it:
   ```bash
   export OPENROUTER_API_KEY=sk-or-...
   ```
   Prefer `apiKeyEnv` over inlining the key in `config.json`.
2. **Add the router + role block** to `~/.config/squadrant/config.json`:
   ```jsonc
   {
     "defaults": {
       "router": {
         "kind": "openrouter",
         "baseUrl": "https://openrouter.ai/api",
         "apiKeyEnv": "OPENROUTER_API_KEY",
         "port": 0,
         "isAnthropic": false,
         "models": {
           "sonnet": { "upstream": "anthropic/claude-sonnet-5" }
         }
       },
       "roles": {
         "crew": { "agent": "claude", "backend": "proxy", "model": "sonnet" }
       }
     }
   }
   ```
   Or set it one key at a time (the `defaults.router…` writes restart the daemon; `defaults.roles…` is read at spawn time):
   ```bash
   squadrant config set defaults.router.kind openrouter
   squadrant config set defaults.router.baseUrl https://openrouter.ai/api
   squadrant config set defaults.router.apiKeyEnv OPENROUTER_API_KEY
   squadrant config set defaults.roles.crew.agent claude
   squadrant config set defaults.roles.crew.backend proxy
   squadrant config set defaults.roles.crew.model sonnet
   ```
3. **Bounce the daemon** if you edited the file directly (`squadrant shutdown` then relaunch) — the shim is constructed at boot.
4. **Verify** with the [release checklist](#release-verification-checklist): `squadrant config check` is clean, the shim's `/healthz` is ready, and a routed crew reports the router model.
5. **Spawn a crew** — `squadrant crew spawn <project> "<task>"` — and confirm it runs on the router model.

Use the model id exactly as your upstream spells it (check the upstream's model list); the `models` alias table bridges differing spellings.

**Alternatives to OpenRouter** (same shape, different `kind`/`baseUrl`):

- **CCR** ([claude-code-router](https://github.com/musistudio/claude-code-router)) — `kind: "ccr"`, `baseUrl` at the local CCR endpoint (e.g. `http://127.0.0.1:3456`); `authHeader` defaults to `Authorization`. CCR already translates protocols, so `direct` can work, but `proxy` adds the shim's health / auth / cost.
- **LiteLLM** — `kind: "litellm"`, `baseUrl` at the LiteLLM proxy (e.g. `http://127.0.0.1:4000`), credential in `Authorization` (a LiteLLM virtual key). Same `direct`-vs-`proxy` choice.
- **`custom`** — any other Anthropic-Messages-compatible endpoint; set `baseUrl`/`authHeader`/`extraHeaders` explicitly.

#### Model ids and the alias layer

A `model` value is looked up in `defaults.router.models`. If it names an alias, it expands per harness (`models.<alias>.agents.<harness>` ?? `models.<alias>.upstream`); **anything else passes through literally** — this is what keeps existing configs working unchanged.

> **Known gap (U6).** With no `models` map, a harness-specific literal such as `opencode-go/deepseek-v4.1-flash` is injected as `ANTHROPIC_MODEL` verbatim. That spelling is correct for the **native opencode** harness but is **not** a model id the opencode-go upstream serves (it expects `deepseek-v4.1-flash`), so a *routed claude* spawn using that literal asks the upstream for a model it does not have. Bridge the two spellings with an alias:
>
> ```jsonc
> "models": {
>   "flash": { "upstream": "deepseek-v4.1-flash",
>              "agents": { "opencode": "opencode-go/deepseek-v4.1-flash" } }
> }
> ```
>
> then set `"model": "flash"` on the role/rule. A kind-derived default alias table (auto-normalizing `opencode-go/…` → `…` for the claude harness) was considered and deliberately **not** added: it would be new behavior outside the U2 schema and could silently rewrite an operator's literal id. Follow-up under epic [#772](https://github.com/tu11aa/squadrant/issues/772).

#### Subagent & small/fast model slots

Claude Code sends **subagent** and **small/fast** requests to separate model slots (`CLAUDE_CODE_SUBAGENT_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`). A router upstream usually serves only the routed model, so a slot left at an Anthropic alias (`sonnet`) makes every subagent/small call fail with `400 … Model is unavailable`. Squadrant keeps the slots in sync automatically, in two places:

- **Routed spawns.** `buildRouterEnv` mirrors the resolved model into `ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, and `ANTHROPIC_SMALL_FAST_MODEL`, so a routed `claude` crew/captain never asks the upstream for a model it does not have. A `native` spawn injects none of them (byte-for-byte unchanged).
- **`~/.claude/settings.json` reconcile.** On every daemon boot, `installClaudeHooks` aligns those two keys to `ANTHROPIC_MODEL` **only when** `ANTHROPIC_BASE_URL` points at a custom (non-`api.anthropic.com`) upstream: an absent key is filled, a bare Claude alias (`sonnet`/`opus`/`haiku`) or a `claude-…` id is aligned, and any other (custom) id is left untouched. An official/absent base URL is a no-op, no other `env` key is touched, and the `defaults.claudeEnv` non-clobbering precedence is preserved.

#### Backward compatibility & migration

- **No `config.router` ⇒ zero behavior change.** The shim is never constructed, every backend resolves to `native`, nothing is injected, and `loadConfig` performs no router backfill or migration. Existing `roles.*.model` / `rules[].model` literals pass through the alias resolver unchanged.
- **The native default is explicit:** an absent `backend` is `native`, for every role and rule. A machine with no router config behaves byte-for-byte as it did before this feature.
- **Migration/upgrade for existing users: nothing to do.** The feature is opt-in and additive; new fields are all optional, so there is no schema-version bump and no config rewrite. If you were routing by hand via `defaults.claudeEnv` (`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`), that workaround keeps working but routes **every** Claude session (captain included) with no per-role control — `defaults.router` + a role/rule `backend` replaces it with per-role scope. Migrating off `claudeEnv` is optional cleanup.

#### Release verification checklist

- [ ] **Native path unchanged** — a `native` crew (or any config without `defaults.router`) carries none of the router env vars (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`); the spawn command is byte-for-byte the pre-router command. `pnpm test` crew-spawn + router suites green.
- [ ] **Routed crew end-to-end** (the U1 live acceptance):
  - [ ] the shim's `GET /healthz` reports ready (`ready: true`, `upstreamReachable: true`) before the spawn gate opens;
  - [ ] a routed crew reports the **router** model (the resolved upstream id, not the alias or the CLI default);
  - [ ] `Bash` runs inside the routed crew (tool use works through the shim).
- [ ] **`squadrant config check`** clean for the router block and backend selections.
- [ ] **Credential missing fails loud** — a routed spawn with no `apiKey`/`apiKeyEnv` surfaces the documented error (`defaults.router credential is missing …`), not an upstream `401`.

### Runtime Abstraction

Workspaces run on a pluggable **runtime driver** (currently only `cmux`). Each project may override the global default via its `runtime` field. Bash scripts call `squadrant runtime <op>` to talk to the configured runtime instead of any specific binary. New runtimes (tmux, Docker, SSH) are added as driver files in `@squadrant/workspaces` (`packages/workspaces/runtimes/`) — see `docs/specs/archive/2026-04-20-plugin-system-runtime-design.md`.

**cmux compatibility (verified on 0.64.22):**
- Squadrant supports cmux `min: "0.64.0"`, with `lastVerified: "0.64.22"` (`packages/shared/src/lib/compat-manifest.ts`).
- **Claude argv-truncation fix (cmux #8070):** cmux 0.64.19+ fixed the upstream issue where `launchCommand.arguments` was truncated at `--messaging-socket-path` in `claude-hook-sessions.json`. The squadrant flag-ordering workaround (placing `--messaging-socket-path` at the end of launch argv, #697/#759) and the `ps` argv-recovery fallback remain active to ensure safety on older cmux versions (retiring only when `min >= 0.64.19`).
- **Stale surface closing (cmux #9422):** `cmux close-surface` fails closed (non-zero exit) on stale/unknown surfaces rather than falling back to the focused surface; squadrant's `closePane` catches and swallows the error gracefully.
- **Access mode:** Squadrant operates with cmux socket control mode `automation` (`capabilities.access_mode: "automation"`). Live policy reload (#7988) maintains event subscriptions across configuration reloads.

### Workspace Abstraction

Vault storage (hub + per-project spokes) runs behind a pluggable **workspace driver** (currently only `obsidian`, **deprecated** since #983: exchange files moved to `~/squadrant/workspace/<p>/`, see [Storage layout](#storage-layout-workspace-983); the driver still serves the spoke learnings/wiki until KB phase 4b). Filesystem operations — `read`, `write`, `list`, `exists`, `mkdir` — go through the driver instead of `fs` directly. Each project may override the global default via its `workspace` field. Bash scripts call `squadrant workspace <op>` to read/write vault data without hardcoding paths. New backends (Notion, plain-md, S3) are added as driver files in `@squadrant/workspaces` (`packages/workspaces/workspaces/`) — see `docs/specs/archive/2026-04-21-plugin-system-workspace-design.md`.

### Notifier Abstraction

User-facing notifications run behind a pluggable **notifier driver** (currently only `cmux`). Escalations and other "tell the user" events go through `squadrant notify <message>`. The default `CmuxNotifier` delegates to `squadrant runtime send --command` — the abstraction exists as a swap-point for future Slack/Discord/email/pager drivers. Notifier is global (no per-project override). See `docs/specs/archive/2026-04-21-plugin-system-notifier-design.md`.

### Lifecycle Sources

Squadrant used to infer whether a captain/crew was alive or idle by scraping terminal titles/pixels — slow, and wrong in ways nobody could tell apart from a true answer. That model was replaced (#333) by a `LifecycleSource` port with three concrete implementations feeding one core state machine:

- **`CmuxStore`** — reads cmux's own session store directly; authoritative when the runtime is cmux, distinguishes a user-initiated close from a crash.
- **`NativeHook`** — Claude Code's native hooks (`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`Stop`/`Notification`/`SessionEnd`, wired via `squadrant hooks claude`, see [Managed settings.json](../CLAUDE.md)) — the primary source for claude captains/crews.
- **`CodexAppServer`** — Codex's JSON-RPC app-server connection, used when the agent is codex.

A per-tick pid floor (`kill(pid,0)`) arbitrates when sources disagree; provenance precedence is `runtime ≥ agent > scan`. This is the ground-truth layer the [captain-liveness redesign](../specs/2026-07-07-captain-liveness-redesign.md) (v0.15.0) and the [control/captain channel](#controlcaptain-channel-667) below both build on.

**Captain-memory write gate (#556).** The unmatched `PreToolUse` hook entry (fires for every tool call, not just `AskUserQuestion`) doubles as a write gate on the captain's long-term memory directory (`~/.claude/projects/<encoded-cwd>/memory/`). Inside a crew session (`SQUADRANT_CREW_TASK_ID` set), a `Write`/`Edit`/`MultiEdit`/`NotebookEdit` targeting that directory, or a `Bash` command whose text references a path under it, is denied via `hookSpecificOutput.permissionDecision: "deny"` and logged to stderr — the pure decision logic (`decideCaptainMemoryWrite`, `packages/agents/src/interactive/claude.ts`) takes tool name/input/env/home dir and is unit-tested without spawning claude. Rule: crews report findings in their done/blocked message; captains decide what's durable. Captain/command sessions (no crew env vars) are unaffected.

**Attribution trailer guard (#1007).** The same `PreToolUse` entry also enforces the operator's attribution choice, for captain and crew sessions alike (unlike the #556 gate). When `~/.claude/settings.json` has `attribution.commit === ""` (or legacy `includeCoAuthoredBy: false`), a `Bash` command running `git commit` (incl. `--amend`), `git merge`/`git rebase`, `gh pr create|edit|merge` whose text contains a `Co-Authored-By:` line naming Claude/Anthropic/Codex/OpenAI/Gemini/opencode, or a `Generated with … Claude Code` line, is denied; the deny reason names the exact line to remove so the agent can retry. Human `Co-Authored-By:` lines pass. The setting is read once per hook run and an unreadable file fails open. Claude Code's own setting only stops the harness adding the trailer — models hand-write it too. Pure logic: `decideAttributionTrailer` / `readAttributionDisabled` in `packages/agents/src/interactive/claude.ts`. Non-Claude crews are covered by a template rule only.

**AFK auto-continue (#616).** Claude Code's AFK mode (`CLAUDE_AFK_TIMEOUT_MS` / `CLAUDE_AFK_COUNTDOWN_MS`) auto-resolves `AskUserQuestion` prompts with a synthetic no-answer after an idle timeout. squadrant never enables this itself; it is opt-in per machine via the [`defaults.claudeEnv`](#config) overlay (#615). Approval-class prompts are guarded by a safe-option-only clause in the captain/crew templates: if a question resolves without a human answer, treat it as *not* approval and take only the safe, reversible option (or none). We do not disable AFK outright because it defuses the modal-induced "delivery stuck" precondition of [#590](https://github.com/tu11aa/squadrant/issues/590) — a modal self-clears long before the stuck threshold fires. The real fix for answering while away is remote answer via Telegram ([#486](https://github.com/tu11aa/squadrant/issues/486)).

### Control/Captain Channel (#667)

The next step past lifecycle sources: use each agent's **native control API** as ground truth for *delivery*, not just liveness — did a message I sent actually land and get processed, not just "the pane looks idle now." Screen-scraped delivery inference (`confirmedSendToPane`: paste → settle → Enter → re-read the screen) produced a long bug tail (#447, #455, #466, #484, #492, #516, #566, #590, #514, #657) because it's an inference that fails silently.

- **`controlChannel`** (per agent type: `off` / `shadow` / `on`) — both `claude` and `opencode` ship `on` by default: delivery verdicts for crew turns come from an agent receipt via `@squadrant/core`'s `control-channel.ts`, not pane-scraping. `claude` was cut over 2026-08-20; `opencode`'s native control API (`prompt_async` → 204, dead session → 404) was live-proven 2026-09-19 (single-crew send + cross-worktree no-misroute) and is now on by default too; `pi`/`gemini`/ACP agents don't fit this model and are out of scope. `off → shadow` needs a daemon bounce; `shadow → on` does not.
- **`captainChannel`** (`off` / `shadow` / `on`, default `on` when unset — #887; existing captains must be relaunched to get the peer socket) — `on` routes captain-bound delivery over the native peer socket, bypassing the pane-defer machine entirely. `shadow` probes but never sends: it logs and discards the probe result, provides no liveness of its own, and falls back to pane delivery — which re-enters draft/ghost/modal/`no-box` deferral. Prefer `on`; `shadow` is a verification aid, not a safe fallback. (Crew wrapper/receipt text visible in `on` mode is a sender-identity artifact tracked separately in #711, not an inherent property of the channel.)
- Implementation: `@squadrant/core/src/captain-channel.ts`, `control-channel.ts`, `lifecycle-source.ts`.
- Design doc: [`specs/2026-08-13-agent-control-channel-design.md`](specs/2026-08-13-agent-control-channel-design.md). Diagram: [`diagrams/2026-08-13-agent-control-channel.html`](diagrams/2026-08-13-agent-control-channel.html).

#### Sender frame on every delivered message (#1029)

Claude Code renders every socket-delivered message as an anonymous "Another Claude session sent a message", ignoring any sender name the transport carries (spike #1029). So squadrant names the sender **in the text**, once, at the delivery layer — the same `@squadrant/core` function (`frameMessage`, `squadrant-message.ts`) for every transport (claude peer socket, opencode, pane fallback). The frame is ONE compact header line, then the body (no XML — it is read in a terminal):

```
📨 crew:mcpspike → done · taskId: 66884473 · seq: 12
merged into #245 (718 tests) …
```

| Direction | Where it is framed | Sender |
|---|---|---|
| crew event → captain (CREW DONE / BLOCKED / IDLE …) | delivery loop, from the mailbox entry | `crew:<name>` (short task id when unnamed) |
| delegation report-back (`dispatch`) → origin captain | delivery loop; `payload.fromProject` set by `appendToMailbox` | `crew:<target project>/<name>` |
| captain `crew send` → crew | `runCrewSend` | `captain:<project>` |
| captain `side send` → side session; thread park request → thread | `runSideSend`, `requestPark` | `captain:<project>` |
| Telegram inbound → captain | bridge (channel path) / delivery loop (mailbox fallback) | `telegram:@username` (else first name, else user id) |
| thread park decision → captain | delivery loop (`payload.from`) | `thread:<id>` |
| side handoff → captain | `squadrant runtime send --from side:<name>` (also `ping --from`) | `side:<name>` |
| `ping` / `runtime send` from a captain session | delivery loop / `ping` (`cli/lib/sender-label.ts`, shared) | `captain:<project>` (`SQUADRANT_ROLE=captain`, project from cwd), unless `--from` |
| `ping` / `runtime send` from a crew / thread tab / side tab | same | `crew:<project>/<name>` / `thread:<id>` / `side` |
| `ping` / `runtime send` from a plain terminal — even inside a project directory | same | `cli` (a cwd under a project does not make a shell the captain) |
| KB reconcile requests | `squadrant knowledge reconcile` | `knowledge` |
| daemon alerts, compact-resume | delivery loop / compact resume | `daemon` |

- Header fields, in order, absent ones omitted: sender · `→ status/kind` · `taskId: <short id>` · `seq: <mailbox seq>` · `stale: <age>` · `reply: squadrant ping <project> "<msg>"`. For a crew event the status is the lifecycle verb (`done`, `blocked`, `idle`, `failed`, `review`, `stalled`, `turn failed`, `undelivered`, `held-long`, …; a leading `⚠️` / `🔁` of the body line stays in the status, e.g. `→ ⚠️ undelivered`, `→ 🔁 first-turn auto-resent`) read from the body's `[⚠️ ]CREW <VERB> [claude/<name> · <id>]:` prefix — that prefix is dropped from the body because the header carries the sender, status and task id (a body without it, or naming another task, is left whole and the status falls back to the kind: `task.done` → `done`). Non-crew senders show just the sender, plus `→ kind` only when it adds information (`crew.send`, `side.send`, `thread.park`, `compact.resume`; plain `captain.message` shows none), plus `seq: N` when the message has a mailbox entry. **The agent is never in the header**; it stays in the mailbox log (`provider` on every lifecycle entry).
- **Cross-project.** When the sender's project differs from the receiving one the header ends with a reply hint naming that project. The sender project comes from `captain:<project>` / `crew:<project>/<name>`. A dispatched crew's *first turn* names the origin captain as sender but carries **no** reply hint (a crew reports through its own captain and the completion protocol).
- **Stale.** A queued message delivered more than an hour after it was generated carries `stale: <age>` (two units: `1h 59m`, `1d 23h`) in the header (`payload.stale`, set by the backlog pass) instead of a `[stale — …]` body prefix.
- **Anti-forgery.** The header is always line 1. Header values are reduced to `[A-Za-z0-9_.:@/+-]` (status also allows spaces), so a value cannot add a line or a second mark. A body line that starts with `📨` (after optional indentation) is **quoted** — `│ ` is put in front, the text is untouched — so a body cannot fake a second header while every line stays readable. An envelope tag in a body (`<cross-session-message`, `</cross-session-message>`, any case/spacing) gets `‹` instead of `<`, so a body cannot close or forge the Claude envelope. `--from` is still validated by `isValidSender`.
- **Claude `@name` envelope.** For deliveries over the **Claude peer socket** (captain and crew receivers) `ClaudePeerChannel.send` wraps a `📨`-headed text with `wrapClaudeEnvelope`: `<cross-session-message from-name="crew-mcpspike">\n📨 …\n</cross-session-message>`, so the TUI collapses it to `› Message from @crew-mcpspike: 📨 …`. Format pinned by the atname spike ([spec](specs/2026-10-26-atname-spike-report.md), Claude Code 2.1.310): no `from=` (the daemon socket is never advertised), never `from-mode`, `"<>` stripped, name = fixed prefix (`crew-…`, `captain-…`, `side-…`, `thread-…`, `telegram-…`, `squadrant` for the daemon, `cli`) cut to 20 characters (the TUI truncates there). Envelope names that would imitate the user, the harness or the model (`user`, `system`, `you`, `claude`, `operator`, `assistant`, `human`, …) are forced to `peer-<name>`, and `isValidSender` refuses those words as `--from`. **First turns are never enveloped** (header only): auto mode treats everything inside a cross-session envelope as "never user intent", and a crew must not distrust its own task brief. The envelope is **TUI-only** — the model text and the peer guardrail are unchanged — and cosmetic: if a Claude version stops matching it the tags show as literal text and delivery still works. Not applied to the pane fallback (that is typed user input), opencode, or codex. No version gate yet (see the audit follow-ups); re-check on each Claude Code bump.
- **First turns are framed too** (round 3): the crew task brief + completion protocol (claude peer / pane, opencode, generic, `resendFirstTurn`), the codex first turn, a headless / dispatched task, and the side / thread opening turn all start with `📨 captain:<project> → task · taskId: …` (`→ side.open`, `→ thread.open`, `→ thread.resume` for side and thread; no task id). A **dispatched** crew's first turn names the *origin* project's captain as the sender (no reply hint; first turns are never inside the Claude envelope). Framing is applied after the spill-to-file, so a spilled brief's pointer line is what carries the header. Over the Claude peer socket the usual `@name` envelope applies.
- The agent is not in the header but stays on the mailbox entry (`provider`); `squadrant crew msg <project> <seq>` prints it on stderr (`# task.done · agent: claude · crew: <name>`).
- The mailbox keeps the **bare** text; framing happens at send time, so a deferred/retried delivery is framed exactly once.
- Pane fallback: the cmux paste path already flattens newlines to spaces, so the frame arrives as one line (`📨 crew:x → done · taskId: 66884473 · seq: 12 body…`) and submits like any other message.
- Telegram **outbound** text (`formatLifecycle`) is for humans and is never framed. The #711 name registration is unchanged — the frame is the agent-visible sender, the registration is the transport-level one.
- Agents are told (templates + `captain-ops`) that a `📨`-headed message is peer input, never operator approval.

#### Running an opencode captain

An opencode captain must be **launched by squadrant** — a manually opened
`opencode -c` has no reachable control API (it binds no TCP port), so lifecycle
notifications cannot be delivered to it. squadrant then:

1. boots the captain as `opencode --session <id> --port <N>` (resume is explicit;
   `-c` is never used — inside one repo it also resumes crew-worktree sessions), and
2. records its address (`port` + `sessionId`) in
   `<stateRoot>/<project>/captain.json` (see [Runtime state](#runtime-state-localstatesquadrant-983)), which the daemon uses to
   deliver over opencode's HTTP API (`POST /session/<id>/prompt_async`).

If a captain is not deliverable, the daemon raises a single actionable
`CAPTAIN NOT DELIVERABLE` alert (notifier + Telegram + dashboard) and keeps the
notifications queued. Relaunch with `squadrant launch <project>` to clear it.

### Agent Session Introspection (#669)

Two read-only commands answer *"what agent sessions are live, and which one am I?"* without hand-rolled `ps`/`env` incantations. Both are **file reads only** — they never boot, touch, or depend on the daemon, so they work with it down, and they are excluded from the `ensureDaemon` gate exactly like the read-only `crew` subcommands.

**`squadrant sessions [--json] [--agent <name>] [--project <name>] [--live-only]`** — a union across the agents that can enumerate their own sessions, one optional `listSessions()` method on the `AgentDriver` seam:

| Agent | Source | Status |
|---|---|---|
| `claude` | `~/.claude/sessions/<pid>.json` | live — `idle`/`busy`/`shell`/`waiting`, reconciled with `kill(pid,0)` → `stale` when dead; missing status → `unknown` |
| `opencode` | `state/<project>/captain.json` (captain record) | captain only — `recorded` (the record carries no status; opencode crew sessions have no persisted registry) |
| `codex` / `gemini` | — | unsupported |

Rows are `{ agent, id, pid, cwd, status, address }`. `address` is the native control address: a claude UDS socket path, or `http://127.0.0.1:<port>` for opencode. `--json` is the stable contract; the table is for humans. Requesting `--agent codex` explicitly exits non-zero rather than printing an empty list.

**`squadrant whoami [--json]`** — resolves the *calling* session from positive signals only (never `pgrep`, which silently omits the invoking process):

- `role` — `SQUADRANT_CREW_TASK_ID` ⇒ `crew`, else `SQUADRANT_ROLE` (e.g. `captain`), else `unknown`.
- `project` — the crew's `SQUADRANT_CREW_PROJECT`, else the longest registered project path that is a prefix of the cwd.
- `agent` / `sessionId` / `address`:
  - **claude** — self-identifies from `$CLAUDE_CODE_MESSAGING_SOCKET`, confirmed against the registry for the session id.
  - **opencode captain** — the captain record's `sessionId` + `port`.
  - **crew** — the task record's `sessionId` and socket/port.

```json
{ "project": "squadrant", "role": "captain", "agent": "opencode",
  "sessionId": "ses_f4d5…", "address": "http://127.0.0.1:49526",
  "source": "captain-record" }
```

An opencode captain whose record exists but whose session id is not resolved yet (cold start) returns `sessionId: null` with a `note`, exit 0. When nothing identifies the caller, `source` is `"none"` and the command exits 1 with a clear message — never a stack trace.

Design: [`#669`](https://github.com/tu11aa/squadrant/issues/669).

### Crew Spawn (Interactive Sub-Sessions)

Crew is the captain's equivalent of an Agent Team subagent — but runtime-agnostic. The captain spawns a crew via `squadrant crew spawn <project> "<task>" [--name <n>]`, which opens a new tab in the captain's cmux workspace, boots an interactive Claude session (no `-p`), and sends the task as the first turn. The crew works on it and **stays idle** waiting for follow-ups. The captain drives the session with `squadrant crew send/read/close/list`, addressing each crew by its tab title (`🔧 <project>:<name>`).

Pass `--direction right|left|up|down` to use a split pane instead of a tab. State lives in the surface buffer + git; tabs die with the captain workspace on `squadrant shutdown`. codex now launches interactively (parity with claude/opencode); gemini currently still launches in print-mode, full interactive support is a follow-up. See [`docs/specs/archive/2026-05-05-squadrant-thin-redirect-design.md`](specs/archive/2026-05-05-squadrant-thin-redirect-design.md).

### Answering a Crew's Open Prompt (#592)

`squadrant crew send` correctly **refuses** to touch a pane while a crew has an AskUserQuestion/permission modal open — a bare keystroke would confirm whatever option the model happened to highlight ([#484](https://github.com/tu11aa/squadrant/issues/484)). That used to be a dead end: the refusal's own advice ("wait for the prompt to close") was unactionable, since the prompt only closes when answered.

`squadrant crew answer <project> <name> <option>` is the deliberate escape hatch. It reads the crew's rendered option list back, requires an **explicit** 1-based index or an exact/prefix text match (never an implicit default), and only then drives the selection, then `Enter`:

```
$ squadrant crew read myproj video          # see the options first
❯ 1. Use main as the base
  2. Use the existing stale branch
  3. Ask me something else

$ squadrant crew answer myproj video 1
→ selecting 1. "Use main as the base"
✔ Answered myproj:video with 1. "Use main as the base" — prompt closed
```

- `--expect "<text>"` refuses if the resolved option's label doesn't contain that text — a guard against the option order shifting between renders (it's model-generated, not fixed).
- `--text "<answer>"` is for a free-text option (e.g. "Type something."): select it, then type the given answer and submit.
- If no option list is visible, `crew answer` refuses rather than guessing — read the screen with `crew read` first.
- **Both agent dialog shapes are recognised.** claude's AskUserQuestion/permission list (`❯ N. Label` between horizontal rules) is driven with `Down`/`Up`; an opencode permission prompt (`△ Permission required` with an `Allow once   Allow always   Reject` bar and a `⇆ select  enter confirm` footer) is driven with `Left`/`Right` — its selection is a `⇆` row, not a vertical list ([#856](https://github.com/tu11aa/squadrant/issues/856)). Because cmux reads the pane as plain text (no ANSI), opencode's background-colour highlight is invisible; its known first-option default is treated as the current selection, and text/`--expect` matching still applies.

`squadrant crew reply <project> <id> [message]` (control-plane path, keyed by task id instead of crew name) now delivers through the same path as `crew send` **before** transitioning task state — never the reverse. If delivery throws (e.g. the prompt is open), the command exits non-zero and no state transition happens; the error points at `crew answer`.

### Effort Dial (Tokenomics)

`squadrant effort max|balance|low` is a single global dial that biases how aggressively crews consume tokens — a captain-discretion signal, not mechanical routing. `max` favors quality/tokens, `low` biases toward economy (e.g. preferring opencode for cheap work); `balance` sits between. Run `squadrant effort` with no argument to print the current setting. The value lives in config and is honored by captains via the captain-ops playbook ([#317](https://github.com/tu11aa/squadrant/issues/317) / [#381](https://github.com/tu11aa/squadrant/pull/381)).

### Crew Lifecycle & Delivery

- **Daemon-direct delivery** — crew turns and handoffs are delivered straight to the cmux surface by the daemon. The old `notify-relay` supervisor was deleted; there is no relay process to keep alive ([#332](https://github.com/tu11aa/squadrant/issues/332)).
- **Semantic heartbeat** — crews emit a lifecycle signal the captain reads as **CREW IDLE / QUIET / STALLED**, distinguishing "waiting for you" from "wedged" without scraping the pane ([#354](https://github.com/tu11aa/squadrant/issues/354)).
- **Captain-pane noise tiers (#1017)** — only *actionable* crew events take a captain turn by default: `done`, `review`, `blocked` (with its question), `failed`, `task.turn.failed`, `task.timeout`, an idle turn-end addressed to the captain, and the one-shot stall escalation. Plain idle, first-stall and quiet are *informational*: silent in the pane, still visible in `squadrant crew tasks`. See [Captain-pane notification tiers](#captain-pane-notification-tiers-1017).
- **Blocked crews re-notify** — a `CREW BLOCKED` push is not one-shot. A *different* question arriving while a crew is already blocked fires a fresh notification (an identical repeat stays suppressed — the first question wins, [#174](https://github.com/tu11aa/squadrant/issues/174)), and a crew that stays blocked past ~30 minutes gets exactly one `CREW BLOCKED REMINDER` (explicitly the same question, never a new one), then stays quiet for the rest of that episode ([#857](https://github.com/tu11aa/squadrant/issues/857)).
- **`stopped` project status + orphan reap** — when a captain goes away, the daemon reaps its orphaned crews and marks the project `stopped` (intentional shutdown) rather than leaving stale tabs or faulting ([#324](https://github.com/tu11aa/squadrant/issues/324) / [#323](https://github.com/tu11aa/squadrant/issues/323) / [#388](https://github.com/tu11aa/squadrant/pull/388)).
- **Status: superseded for claude by the control channel.** The semantic heartbeat above still runs, but delivery confirmation for claude crews now comes from an agent receipt (`controlChannel=on`), not pane inference — see [Control/Captain Channel (#667)](#controlcaptain-channel-667).

#### Captain-pane notification tiers (#1017)

Every crew lifecycle event used to become a full captain turn; most (plain idle, stalled, quiet) needed no action but each re-read the whole captain context. The captain pane now uses the **same `CrewTier` model as Telegram**, set per project in `~/.config/squadrant/projects/<name>.json`:

```json
{ "captain": { "notify": { "crew": "alert_only" } } }
```

| Tier | Captain pane receives |
|---|---|
| `none` | nothing |
| `done_only` | `done`, `failed` |
| `alert_only` *(default)* | everything except informational events: `done`, `failed`, `blocked`, `review`, `approval/input requested`, `task.timeout`, `task.turn.failed`, `task.warn`/reminders, an **addressed idle** (below), the **stall escalation** (below) |
| `all` | everything above **plus** informational events, coalesced into **one `CREW DIGEST` per crew** after a 60 s quiet window (flushed first when an actionable event for that crew arrives; never delivered for a crew that has since finished) |

Informational events always stay in the task record, so `squadrant crew tasks` shows them. Telegram has its own independent tier and is unchanged. Delivery into the pane still goes through the normal mailbox/delivery loop, which defers while the captain is mid-turn.

**Idle carries content.** When a turn ends, the agent's final message (Claude: the `Stop` payload's `last_assistant_message`) rides on `task.turn.completed` as `lastMessage`, **in full** — the mailbox event keeps the whole text. Only the captain-facing `message` is bounded (#1030): 1500 chars, then `… full: squadrant crew msg <project> <seq>`; run that command to read the rest (it also finds entries in rotated segments). The task record keeps just a pointer, `lastReplySeq`, never the text. Delivery is language-neutral and deterministic (no LLM, no keywords):

- the **first turn-end after a captain message** to that crew (`crew send` to a crew in any state, including a reopen of a finished one, or dispatch) is the *reply*: the daemon stamps `reply` on it and always delivers it, text word for word (`CREW IDLE … (word for word)`), bypassing the #210 debounce — this matters because crews often never run `crew signal done` (#278);
- a turn-end whose last non-code-fence line ends with `?` is *addressed* and delivered the same way (Claude maps it to `task.blocked` with the whole message as the question, instead of only the last line);
- a **later self-resume** turn-end that has text but no captain message in between is a *plain end of turn*: informational, silent by default;
- a turn-end with **no text** from a provider that has no text source (Codex, OpenCode) keeps today's generic `CREW IDLE … awaiting your reply` (still subject to the #210 debounce). For **Claude**, the text-less lifecycle sources (cmux-store, native-hook) race the Stop hook: the daemon moves the state at once but defers the push for `idleTextGraceMs` (default 3 s) so the hook's text decides (reply / question → delivered with text, plain → silent, in either arrival order, exactly once). If no text arrives, a generic `CREW IDLE` is sent only when a reply is pending (the captain spoke); otherwise it stays silent.

**Stalls fire once.** `CREW STALLED` names the hung tool and how long it has run (e.g. `still running Bash ~11min`) and fires once per stall episode (until the crew's next turn boundary / blocked / terminal state). If the crew is still stalled with no tool result after `stallEscalationMs` (default 30 min, `DaemonDeps`), exactly one `CREW STALLED … ESCALATION` is pushed, which is actionable at the default tier, so a truly hung crew is never invisible. The source only knows the tool *name*, not its command line.

Multi-agent: Claude supplies the turn-end text. Codex (app-server) and OpenCode (control channel) turn-end events currently carry no final-message text, so their idle events keep today's generic `CREW IDLE` behaviour; when their payloads gain the text they only need to set `lastMessage` on `task.turn.completed`, and self-resume turn-ends then become silent too.

### Telegram (Two-Way, opt-in)

Drive squadrant from your phone ([#65](https://github.com/tu11aa/squadrant/issues/65)). When a `telegram` block is present in config, a daemon-internal bridge:

- **Outbound** — pushes each project's crew lifecycle events (CREW DONE / FAILED / BLOCKED / APPROVAL / INPUT / TIMEOUT / IDLE) and other captain notifications to that project's Telegram forum topic, filtered by a per-project **crew tier** (see [Notification tuning](#notification-tuning-per-project) below). Best-effort: a Telegram failure never delays or breaks delivery to the captain pane.
- **Inbound (project topic)** — a message you send in a project's topic is delivered into that project's **captain pane** as a labeled `📩 [from Telegram]` message; the captain decides what to do with it. With remote control enabled (see below), if no captain is alive the daemon **auto-launches** one, then delivers ([#403](https://github.com/tu11aa/squadrant/issues/403)).
- **General command channel** — slash commands in the supergroup's **General topic** run a curated set of squadrant operations from your phone ([#402](https://github.com/tu11aa/squadrant/issues/402)). Available: `/help`, `/status`, `/projects`, `/crews <project>`, `/launch <project>`, `/effort [max|balance|low]`, `/config get <key>`, `/config set <key> <value>`, `/spawn <project> <task…>`. Each maps to a validated CLI argv run via async `execFile` — never a shell passthrough. Unknown commands and freeform text get a `/help` hint.

Absent the config block, the bridge is never constructed — zero behavior change. No runtime SDK is added (plain `fetch`; `@grammyjs/types` is a dev-only type dependency).

**Setup (recommended):**
1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Run `squadrant telegram setup` — it prompts for the bot token (input hidden), validates it via the Bot API, auto-detects your supergroup id, captures your Telegram user-id, and offers to enable remote control.
3. Bind a project to a topic: `squadrant telegram link <project>` (creates the forum topic and records the binding).
4. Check wiring with `squadrant telegram status`.

**Setup (manual):**
Put the token + ids in config (or export `TELEGRAM_BOT_TOKEN`) — see the `telegram` block under [Config](#config). Then run `squadrant telegram link <project>`.

#### Security model (#321) — fail-closed remote control

The control surfaces (auto-launch + General command channel) are **off by default** and gated by two independent checks. A control action runs **only when both** hold:

1. `remoteControl: true` — an explicit opt-in master switch (default `false`).
2. `message.from.id ∈ users[]` — the sender's Telegram **user-id** is on the allowlist. An empty/absent `users` list ⇒ control is disabled (fail-closed). Chat membership alone is **never** enough for control.

When remote control is off (the default after upgrade), behavior is **exactly v1**: project-topic messages queue to the captain pane (no auto-launch), and General-topic slash commands are rejected with `⛔ not authorized`. Inbound text is always treated as data; only the curated registry maps to actions, and `/config set` is restricted to a default-deny writable-key allowlist (currently `defaults.effort` and `defaults.gate.mode`, the latter value-validated to `on`/`off`/`auto` — [#854](https://github.com/tu11aa/squadrant/issues/854)) — **secrets (`botToken`, `users`, `chats`, `supergroupId`) can never be written over Telegram.**

#### Notification tuning (per-project)

Notifications resolve through a **layered config**: built-in defaults → global `config.json` (`telegram.notify`) → per-project `~/.config/squadrant/projects/<name>.json`, merged per key (overriding one key never resets its siblings). Two axes are independent:

- **Live mute (`active`)** — system-tracked *session* state in `telegram-state.json`. Flipped by engagement (any message into a topic auto-unmutes), `/mute` / `/unmute` (Telegram), or `squadrant telegram notify <project> on|off`. The live value wins over the config default when present.
- **Deliberate preferences (`crew`, `cap`)** — persistent settings in the per-project config file. Written by `squadrant telegram notify <project> crew <tier>` / `cap <on|off>` (CLI) or `/notify crew <tier>` / `/notify cap <on|off>` (Telegram, fail-closed behind remote control).

**Crew tiers** (cumulative) select which lifecycle events reach a topic when active:

| Tier | Events delivered |
|---|---|
| `none` | nothing |
| `done_only` | `task.done`, `task.failed` |
| `alert_only` *(default)* | `done_only` + `task.blocked`, `task.approval.requested`, `task.input.requested`, `task.timeout` |
| `all` | every lifecycle event (incl. progress/heartbeat noise) |

**`cap`** (default `on`) gates explicit captain pushes via `squadrant telegram send` — set `cap off` for a project to stop the captain DM-ing you there (independent of idle-mute; an explicit push is not dropped just because the topic is idle-muted).

Config (deliberate prefs) and state (live toggles) are kept separate by design: `/unmute` flips your session, it does **not** rewrite your config file. An absent `projects/<name>.json` behaves exactly as the global defaults — the layer is fully additive, no migration. See `docs/superpowers/specs/2026-06-23-per-project-layered-config-design.md`.

#### Remote wake (#403) — operator-side

Auto-launch boots a captain when the **daemon is already running**. Waking a *sleeping Mac* from your phone (Wake-on-LAN / a relay that nudges the machine) is operator-side infrastructure, out of scope for this repo — see [#403](https://github.com/tu11aa/squadrant/issues/403) for the end-to-end flow.

> **Interim note (link ↔ daemon 409):** the Telegram Bot API allows only one `getUpdates` consumer at a time. The `setup` wizard polls `getUpdates` to detect your group/user-id, so run it with the daemon stopped. `link` uses only `createForumTopic`, so it's unaffected.

### Projection (Cross-Agent Config Sync)

Squadrant rules (Karpathy principles, captain-ops) and per-project AGENTS.md emit to each supported agent's canonical path via `squadrant projection emit`. User-level projection pushes squadrant's skills to `~/.cursor/rules/squadrant-global.mdc`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`. Project-level projection pushes a managed project's own `AGENTS.md` into `{project}/CLAUDE.md`, `{project}/.cursor/rules/squadrant.mdc`, `{project}/GEMINI.md` — zero squadrant-global content leaks into the project repo. Shared files use `<!-- squadrant:start --> ... <!-- squadrant:end -->` markers; dedicated files overwrite. See `docs/specs/archive/2026-04-24-plugin-system-projection-design.md`.

The user-level projection now also inlines `templates/captain.generic.md` and `templates/crew.generic.md` as `## Captain Role` / `## Crew Role` sections inside the squadrant marker block, so non-Claude agents (Codex, Gemini, Cursor) load the same role descriptions Claude Code loads via `--append-system-prompt-file`. See `docs/specs/archive/2026-05-05-multi-agent-template-parity-plan.md` (#45).

opencode additionally gets squadrant's skills projected as **loadable skill dirs**, not just inlined markdown. On every `squadrant` invocation and on daemon boot, the shipped `plugin/skills/<name>/SKILL.md` files are synced (copy-if-changed + prune) into the **user-scope** opencode skills dir `~/.config/opencode/skills/<name>/SKILL.md`, so `skill <name>` resolves in an opencode captain/crew/side session — parity with claude's `--plugin-dir`. User-scope is deliberate: it serves every project and every opencode session without writing into managed project repos (where it would drift), and it is reconciled from the shipped source on every run so an install/update can't leave it stale. Each synced dir carries a `.squadrant-managed` marker — only marked dirs are refreshed or pruned, and a name collision with a user-authored opencode skill is reported as a skip rather than clobbered. Skills without loadable frontmatter (`handback`, `takeover`) are not projected. ([#791](https://github.com/tu11aa/squadrant/issues/791))

Claude crews load a smaller plugin dir, `~/.config/squadrant/plugin-crew`, which holds only the skills a crew is told to use (`CREW_SKILLS` in `packages/shared/src/lib/runtime-sync.ts`): `karpathy-principles`, `takeover`, `handback`, `rules-ops`, `knowledge-review`, `knowledge-extract` and `human-review-guide`. Captains and command sessions load the full `plugin` dir. A test fails if a crew template, the daemon's reconcile-due message or a crew skill names a skill missing from that list ([#1002](https://github.com/tu11aa/squadrant/issues/1002)). opencode crews read the user-scope skills dir above, which holds every skill.

### Storage layout: workspace (#983)

KB spec K7 / §4 splits storage by lifecycle. Per-project exchange lives in **`~/squadrant/workspace/<project>/`** (it replaces `<hubVault>/spokes/<project>/` for these files):

```
~/squadrant/workspace/<project>/
  handoff.json            # live handoff (write-handoff.sh); read-handoff.sh archives it into handoffs/
  captain-sessions.jsonl  # captain session registry (SessionStart hook, read by `handoff facts`)
  handoffs/               # archived handoffs, <date>[-N].json
  side-handoffs/          # side-session records, <topic>.md
  inbox/
  artifacts/              # dated, immutable: reports/ research/ findings/ recaps/ plans/ daily-logs/
```

- `workspacePath(project)` in `@squadrant/shared` is the one helper. `SQUADRANT_WORKSPACE_DIR` overrides the root (`SQUADRANT_ARCHIVE_DIR` does the same for `~/squadrant/archive`).
- `projects add` and `launch` create the dirs. New projects get no Obsidian spoke scaffold (and no `status.md`, #538).
- The scripts keep their argv: `write-handoff.sh`, `read-handoff.sh` and `record-side-handoff.sh` take a project name, a workspace path, or an old spoke path, and use only its basename as the project. (A custom `--spoke` path whose basename is not the project name maps to the wrong workspace dir.)
- **Dual-read for one version.** `read-handoff.sh` falls back to `handoff.json` in the old spoke (the path passed in, or `~/squadrant-hub/spokes/<p>/`). `handoff facts` reads checkpoints and session records from both, and `standup`/`retro` read daily logs from both.
- Learnings, captured skills and the wiki stay in the spoke until KB phase 4b. `spokeVault`/`hubVault` stay in the config as deprecated aliases. `record-learning.sh` / `capture-skill.sh` / `wiki-ingest.sh` create a missing spoke dir; `wiki-query.sh` / `wiki-log.sh` are a no-op on one.

**`squadrant migrate kb [--dry-run]`** moves an existing home to this layout (KB spec §10). It prints one line per batch: `would-move`/`moved`, `would-archive`/`archived`, `skipped` or `copied` (cross-device: the original stays).

| From | To |
|---|---|
| spoke `handoff.json`, `captain-sessions.jsonl`, `handoffs/`, `side-handoffs/` | `workspace/<p>/…` (a registry that already exists in the workspace gets the old lines appended; the old file is archived) |
| spoke `reports/ research/ findings/ recaps/ plans/ daily-logs/` | `workspace/<p>/artifacts/<kind>/` |
| spoke `artifacts/` | `workspace/<p>/artifacts/` |
| hub `CLAUDE.md`, `projects/*.md`, `daily-logs/`, `wiki/` + `learnings/` when they hold only scaffold files | `~/squadrant/archive/<date>/hub/…` |
| `~/.config/squadrant/state/`, `~/.config/squadrant/squadrantd.log` | `~/squadrant/archive/<date>/config/{state/,squadrantd.log}`. This happens only once the daemon has copied the state into `~/.local/state/squadrant` (the `.seeded-from-legacy` marker, see [Runtime state](#runtime-state-localstatesquadrant-983)); until then the row is `skipped` with a note. The log is `skipped` while launchd still writes it (run `squadrant heal daemon` first). `config.json` is never touched. |
| `<hubVault>/knowledge/<kb>/`, spoke `knowledge/rules/` | same as `squadrant knowledge migrate` (kept as an alias) |

Directories are merged file by file. A file whose target already exists is reported `skipped` and left in place, never overwritten. Nothing is deleted, and a second run moves nothing. `squadrant doctor` warns while a spoke or the hub still holds files to migrate, and when a project has no workspace dir yet.

#### Reference sweep (#998)

Moving a path breaks every file that still cites the old one, such as a captain's native memory or today's handoff. So both `squadrant migrate kb` and **`squadrant migrate path <from> <to> [--dry-run]`** sweep references after they move something. They build an old → new path map from the moves they made, scan the sites below, and print one `ref` line per hit (`file:line old -> new`):

| Site | Files | Rewritten? |
|---|---|---|
| `memory:<agent>` | agent native memory: Claude's `~/.claude/projects/*/memory/**` (`SQUADRANT_NATIVE_MEMORY_ROOT` overrides the root). Codex and opencode keep no per-project memory files, so they have no entry. | yes |
| `workspace` | `workspace/<p>/handoff.json`, `workspace/<p>/side-handoffs/**` | yes |
| `workspace-checkpoint` | the newest `workspace/<p>/handoffs/*.json`: the checkpoint `handoff facts` reads, picked by the same `readNewestArchivedHandoff`. `read-handoff.sh` archives `handoff.json` there, so it is usually the live handoff. Its mtime is kept, because `handoff facts` dates the checkpoint by it. | yes |
| `workspace-archive` | the older `workspace/<p>/handoffs/*.json` (history) | no: `report-only` |
| `kb` | `.md`/`.yaml` files in the KB repos under `~/squadrant/kb/` and any configured KB path: rules, decisions, wiki, `errata.yaml`, `sources.yaml`. `.git/`, `raw/` (sha-cited source documents), `.converted/` and the derived `index.json` are skipped. | yes |
| `project` | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` at the root of each registered project's repo (a symlinked pair counts once) | yes |

- A reference matches in its `~/…`, absolute (`/Users/<you>/…`) and `$HOME/…` forms, also inside `file:` citations, and is rewritten in the same form. Sub-paths follow the move (`~/a/work/x.md` → `~/new/x.md`). Path boundaries hold: `~/a/work` never matches `~/a/workshop` or `~/a/work.md`.
- A file that was `skipped` (its target already existed) stayed where it was, so references to it are left alone.
- `--dry-run` changes no bytes and prints `would-rewrite` lines. A real run first copies each file it rewrites to `~/squadrant/archive/<date>/ref-sweep/<path relative to $HOME>`, then prints `rewritten`. An earlier backup from the same day is kept, and the new one gets a `.1` suffix. A second run rewrites nothing.
- **KB git repos.** A real run commits the files it rewrote in each KB repo, one commit per repo with the message `ref-sweep: <from> -> <to> (#998)` (`ref-sweep: N path moves (#998)` for `migrate kb`). It never pushes. It leaves out gitignored files (`_user` proposals, P15) and any file that was untracked or already differed from `HEAD` before the sweep, so your own pending edits never land in a ref-sweep commit. Those are named in a `not committed` note. A dry run commits nothing.
- **Profile hashes.** A rewritten Claude memory note gets a new bridge hash. So that the profile bridge does not then propose an `.update` identical to the trait, the sweep refreshes `#<hash12>` in the `_user` sources that cite the note (traits, proposals, `_archive/`, `_dropped.yaml`), but only where the cited hash matched the note before the rewrite. Those lines show as `ref profile:` hits. See the profile spec §6.
- `migrate path` moves `<from>` with the same rules as `migrate kb`: dirs are merged file by file, an existing target file is `skipped`, and no file is ever deleted. Afterwards the dirs left empty under `<from>` (and `<from>` itself, once empty) are removed bottom-up with `rmdir`, which cannot remove a file. That is reported as one `pruned` row (`would-prune` in a dry run). A dir that still holds a `skipped` file stays. If `<from>` is gone and `<to>` exists, it only rewrites references, which fixes a move made by hand. If both are missing, or `<to>` is inside `<from>`, it exits with an error.

```
squadrant migrate path ~/saitex/kb/work ~/squadrant/workspace/flooros/artifacts/work --dry-run
```

**`squadrant doctor`** runs the read-only side over the same sites, excluding archived history (the checkpoint handoff is checked). For each `~/…`, `$HOME/…` or absolute home path that doesn't exist, it warns with `file:line`, once per site and at most 5 entries per site (`squadrant doctor -v` lists all). It ignores paths that contain a glob or placeholder (`*`, `<`, `{`, `...`) and temp or scratchpad paths (a `tmp`, `temp` or `scratchpad` segment).

### Knowledge System (opt-in writes)

- **Status** — `write-status.sh` does not exist and nothing else writes `status.md` today; existing files are left in place as history but are no longer read by `squadrant status`/`standup`/`retro` ([#630](https://github.com/tu11aa/squadrant/issues/630) tracks a real persisted work-tracking store).
- **Dashboard** — `squadrant dashboard --pane` opens a refreshing sidebar pane in cmux that lists every project's live state, queried from the squadrant daemon's task records. `squadrant dashboard sync-hub` mirrors each spoke `status.md` into `{hubVault}/projects/` so the hub vault's `dashboard.md` Dataview query renders the same data inside Obsidian.
- **Handoff files** — captain writes when in-flight work needs to survive into tomorrow; skipped on uneventful sessions. Live in `~/squadrant/workspace/<p>/` (#983).
- **Daily logs** — captain writes when the day produced something worth a log; not on a schedule. Live in `~/squadrant/workspace/<p>/artifacts/daily-logs/` (#983).
- **Learnings** — recorded when a captain encounters a genuinely surprising or reusable pattern.
- **Wiki** — compiled, indexed knowledge pages in spoke vaults (`wiki/pages/`); promoted from learnings when worth maintaining.
- **Hub Wiki** — cross-project knowledge aggregated by an on-demand `squadrant command --task wiki-aggregate` run.
- Scripts: `wiki-ingest.sh`, `wiki-query.sh`, `wiki-log.sh`.

### Knowledge bases (rules, #893 / #936)

Each knowledge base (KB) is its own git repo under `~/squadrant/kb/<kb>/` (`squadrant knowledge init <kb>` runs `git init`; a remote is optional; a default `.gitignore` keeps `raw/` and `.converted/` local — edit it to opt in; `init` never touches an existing `.gitignore`. The default also ignores the reconcile runtime files `/scores.json` and `/escalations.json`, and `knowledge reconcile --finish` appends those two lines to an existing `.gitignore` that lacks them, leaving every other line as it is). Rules live in `<kb>/shared/rules/`; a project's own overlay lives in `<kb>/projects/<project>/rules/`, or in `<repo>/docs/rules/` when `knowledgeHome` is `"repo:docs"`. The audit log is `~/.local/state/squadrant/audit/YYYY-MM.<machine>.jsonl`.

```json
{
  "knowledgeBases": { "saitex": { "path": "~/squadrant/kb/saitex", "homeProject": "flooros", "domainCap": 150 } },
  "groups": { "saitex": { "kb": "saitex" } },
  "projects": {
    "flooros":   { "group": "saitex", "knowledge": ["conventions"] },
    "squadrant": { "knowledgeHome": "repo:docs" }
  }
}
```

- A project in a group inherits that group's KB; `projects.<p>.knowledge[]` adds extra KBs. `path` defaults to `~/squadrant/kb/<kb>`.
- `knowledge.<kb>` (the pre-#936 key) is still read as a deprecated alias; `squadrant doctor` reports it as config drift and the drift fix moves it to `knowledgeBases`.
- Old spoke overlays (`<spokeVault>/knowledge/rules/`) move to the project's overlay home too; a project with no group KB or `knowledgeHome` is skipped and reported. A KB left at `<hubVault>/knowledge/<kb>/` is flagged by `squadrant doctor`. `squadrant knowledge migrate [--dry-run]` moves it to the new root (re-homing `rules/` to `shared/rules/`), prints a report, and never deletes. If the move crosses devices it copies and leaves the original.

#### Ingest and extraction (#897)

`squadrant knowledge ingest <kb> [--dry-run] [--json] [--local-model] [--max-sections n]` checks every `sources.yaml` entry (mtime + size first, sha only on a difference), converts changed files with `markitdown` into `<kb>/.converted/` (md/txt pass through; a failed conversion is reported and skipped), and prints the section plan for the [`knowledge-extract`](../plugin/skills/knowledge-extract/SKILL.md) skill. `--dry-run` prints the token estimate and writes nothing. `knowledgeBases.<kb>.maxSectionsPerPass` (default 40) caps one pass; the remainder carries to the next. A `sensitivity: local-only` source is skipped unless `--local-model` is passed.

`sources.yaml` entries take `path`, `priority` (`company` > `project` > `agent`), optional `domain`, `sensitivity: local-only`, and `review: required`. A `review: required` source never makes live rules on its own: `apply` sends its new candidates to `_proposed/` (see Classify below). The gate is decided by the entry's `path` glob, not by files on disk, so a renamed or deleted raw file stays gated. `apply` and `review` refuse to run while `sources.yaml` has errors (a dropped entry would silently remove the gate). `squadrant knowledge sources <kb>` shows the flag. A rule ref names one file, however it is written: as `~/…`, absolute, KB-relative, or a legacy path relative to a parent of a declared source (`kb/extracted/x.md` or `flooros/CLAUDE.md` under `~/saitex`). It resolves to the first of those that exists, or, once the file is gone, the first one a `sources.yaml` entry covers. `validate`, the review gate, `sources --remove`, `apply` id matching, merges and errata, and `review` merges and priority all use this one rule, so two refs to the same file are the same ref. A stale or retired rule may have an empty `sources` list (after `knowledge sources --remove`); an `active` rule still needs one, so re-extract it from a new source or retire it. A source-less stale rule cannot be kept active: the reviewer's keep decision escalates as `no-source`, and `review --resolve --reject` refuses with a message to add a source or retire it.

The skill's output is a candidates JSON file. `squadrant knowledge apply <kb> candidates.json` does the mechanical rest:

| Step | Behaviour |
|---|---|
| Quote check | Normalised (whitespace, line-break hyphenation, smart quotes/dashes, ligatures); not found ⇒ rejected as `ungrounded` (audit `item.rejected`). The char `offset` in `.converted/` is recorded. >20% of a source dropped ⇒ "try docling". |
| Errata | `<kb>/errata.yaml` (optional, git-tracked, next to `sources.yaml`) lists stale passages: `id`, `ref`, `quote`, `reason`, and optional `evidence[]`, `checked`, `by`, `at`, `decision`. A candidate whose grounded span overlaps an erratum span in the same `ref` is **rejected** as `errata:<id>` (audit `item.rejected`). It never goes live and never goes to `_proposed/`, so a settled question is not asked again. An erratum whose quote is no longer found in the source is reported as **orphaned** (the raw file changed): printed by `apply` and listed under "Errata to re-check" in `REPORT.md`. An invalid `errata.yaml` stops `apply`. No file means no change. |
| Id matching | A quote overlapping an existing rule's `offset` in the same source takes that rule's id, whatever the model chose. |
| Classify | new ⇒ `active` (from a `review: required` source ⇒ `_proposed/` instead; a same-meaning candidate for a live rule still merges there); same id + same meaning ⇒ source added, `offset` updated; meaning changed or contradiction ⇒ `shared/rules/_proposed/<id>@<sha>.md` (old stays active); source rule missing from a fully swept source ⇒ `stale`. A second change while a proposal is pending renames the older one to `.superseded` (audit `item.superseded`). |
| Anchors | For each project subscribed to the KB, the repo is searched for `keywords + expanded`; matching `paths`/`symbols` go in `anchors.<project>`. |
| Index | `index.json` is recompiled. |

`squadrant knowledge validate <kb>` also loads `errata.yaml` (invalid entries fail) and warns on any active rule whose source quote overlaps an erratum passage, which catches errata added after the rule went live.

`item.proposed`, `item.superseded`, `item.applied` and `item.rejected` go to the audit log. Re-running on unchanged sources changes no ids and no files. A pending proposal shares its id with the live rule by design; `validate` and `reindex` do not count that as a duplicate.

#### Rule delivery to Claude (#899)

Rules reach a Claude session through the managed hooks, in-process and under a 1.5s budget (a failure or timeout injects nothing; `SQUADRANT_RULES_INJECT=0` turns it off):

| Hook | Injects |
|---|---|
| `SessionStart` | every active `must`/`must-not` rule, within the ≈800-token budget (`+N more` line past it) |
| `UserPromptSubmit` | rules matching the prompt: a named file (glob/anchor path), an anchored symbol (`computeTotal`), or enough keyword/`when` terms |
| `PostToolUse` (matcher `Read`) | rules whose `globs` match the file just read, or whose anchor for the current project lists it |

At most 5 rules and ≈800 tokens per injection; each rule is shown once per session; overflow collapses to `+N more: squadrant rules show <ids>`. `PostToolUse` is in the managed hook set, so it lands in `~/.claude/settings.json` on the next daemon boot. `squadrant rules match [--project p] [--event session|prompt|read] [--path f] [--text t] [--session id]` prints what the hooks would inject (without `--session` nothing is recorded as seen). Matching is T0 only (glob, anchor, lexical); embeddings (T1) and a daemon-warm matcher are deferred (#902).

#### Rule delivery to codex, gemini, opencode (#900)

Same core as Claude (`squadrant hooks <agent> <sub>` → `computeRulesInjection`), so budget, once-per-session dedup and the `SQUADRANT_RULES_INJECT=0` switch behave identically; the audit `agent` field is the real agent. Nothing is installed automatically: run `squadrant rules install-hooks --agent codex|gemini|opencode [--dry-run]`. It merges into the agent's own config without touching other entries.

| Agent | Config written | Prompt | After a read | Session |
|---|---|---|---|---|
| codex | `$CODEX_HOME/hooks.json` | `UserPromptSubmit` | `PostToolUse` (matcher `Bash`; a plain `cat`/`head`/`tail`/`nl`/`bat`/`sed <file>`) | `SessionStart` |
| gemini | `~/.gemini/settings.json` `hooks` | `BeforeAgent` | `AfterTool` (matcher `read_file`) | `SessionStart` |
| opencode | `~/.config/opencode/plugin/squadrant-rules.js` | `chat.message` | `tool.execute.after` (`read`) | none (no injection point) |

These formats follow each agent's documentation and have **not been live-verified** (#900 stays open until each agent's smoke test shows a rule reached the model).

**Fallback pointer.** `squadrant projection emit` adds a short "look rules up with `squadrant rules search`" section to the codex/gemini/opencode projection of a project that subscribes to a KB. It is part of the marker body, so it is written only inside `<!-- squadrant:start/end -->` and disappears on the next emit after the project unsubscribes. Each emit logs one `item.fallback` audit entry (`trigger: "fallback"`, `agent`) per KB.

### Operator profile (`_user` KB, #982)

The profile is a small record of **how the operator works**: review style, autonomy, when to ask, recurring corrections. It reaches every session of every agent (claude, codex, opencode, gemini) in every directory, including directories that are not registered projects. It holds only what is true in every project. Anything tied to one repo or company belongs in that KB's rules or decisions. Spec: [`specs/2026-10-15-user-profile-design.md`](specs/2026-10-15-user-profile-design.md). Diagram: [`diagrams/2026-10-15-operator-profile.html`](diagrams/2026-10-15-operator-profile.html).

**Storage.** `<userKb>/profile/<slug>.md` lives in its own local git repo. It is created on the first profile write (`git init`, plus a `.gitignore` for `profile/_proposed/`) and squadrant never adds a remote. `<userKb>` is `SQUADRANT_USER_KB_DIR`, else `knowledgeBases._user.path`, else `~/squadrant/kb/_user`. A path inside a registered project or inside another KB is refused (K6), and every profile write resolves through one guard that only allows `<userKb>/profile/`. Layout:
- `profile/_archive/` holds retired traits.
- `profile/_proposed/` holds proposals. It is gitignored and never committed.
- `profile/_dropped.yaml` records dropped proposals as `{source, hash, reason, date}` only, never their bodies, so company content never reaches `_user` history.

**Trait format.** Frontmatter fields:
- `id: prof.<slug>` (matches the file name)
- `domain: profile`, `level: shared`, `status`
- `kind: preference|correction|procedure`, `confirmed`, `last_confirmed`
- `summary`: ≤140 chars on one line, written as an instruction. It is the only text injected.
- `audience: all|captain|crew`, `tier: core|situational`
- optional `triggers` (stored now, used from S2)
- `sources`, `created`, `updated`

The body (why, how, examples) is read on demand.

**Cap.** Core summaries are capped at **3,000 chars per audience view**. The captain view is `all` + `captain`; the crew view is `all` + `crew`. A non-correction apply that would pass the cap is refused with `core profile is N/3,000 chars: merge or archive traits first`. A correction always applies, with an `over cap: merge pending` warning. There is no limit on how many traits you keep.

| Command | Purpose |
|---|---|
| `profile add --kind preference --apply --file -` | explicit "save to my profile": live, `confirmed: true` |
| `profile add --kind correction --apply --file -` | a correction: live with `confirmed: false`, always applies, listed at the next review |
| `profile add --kind … --file -` (no `--apply`) | an agent's inference: a proposal in `_proposed/`, never injected until kept |
| `profile review [--json]` | the queue: proposals plus unconfirmed traits, each with id, summary, kind and source dir. It also lists native memory files that a kept trait now covers (squadrant never deletes them). No flags on a TTY gives an interactive walk-through |
| `profile review --keep <id>[,…]` / `--drop <id>[,…] --reason "…"` / `--edit <id> --file -` | act by id, one commit per item. There is no bulk keep: the agent shows the operator every summary first |
| `profile list [--all] [--check [--fix]]` | active traits and both view sizes. `--check` reports invalid or uncommitted files; `--fix` commits the valid ones |
| `profile show <id>` | one trait in full |

Body input always comes from `--file` (or `-` for stdin), never argv. `--summary`, `--audience` and `--tier` override the file. Every write prints `applied|proposed prof.<slug>: "<summary>" (captain N/3,000 · crew N/3,000)`, and the agent relays that line so the operator can fix the wording at once. Each committed write uses `git commit --only` with the trailers `Domain: profile`, `Item`, `Level: shared`, `Session`, `Approved-by`. Audit events are `item.proposed|applied|approved|rejected|archived|surfaced`, with `kb: "_user"` and `domain: "profile"`.

**Crew guard.**
- In a crew session (`SQUADRANT_CREW_TASK_ID` set), `profile add --apply` becomes a proposal. `review --keep/--drop/--edit` and `list --check --fix` are refused.
- For claude crews, the #556 PreToolUse guard also denies `Write`/`Edit`/`MultiEdit`/`NotebookEdit` under `<userKb>/`, and any `Bash` command that names it, reads included. Crews use `squadrant profile show`.
- Codex, opencode and gemini crews have no PreToolUse hook, so they are covered by the CLI guard only.

**Delivery.** The profile has its **own** hook command, `squadrant hooks <agent> profile-session-start`. Its output holds only the `<squadrant-operator-profile>` block, so it is a separate `additionalContext` string and never competes with rules for Claude's 10,000-char-per-string limit.

| Agent | Wiring | When |
|---|---|---|
| claude | `installClaudeHooks` (daemon boot, verified and repaired like the other squadrant hooks) | SessionStart |
| codex | `squadrant rules install-hooks --agent codex` writes a `profile-session-start` SessionStart entry next to the rules one | SessionStart |
| gemini | `squadrant rules install-hooks --agent gemini` | SessionStart |
| opencode | the managed `squadrant-rules.js` plugin (opencode has no session-start point): on the first `chat.message` of each `sessionID`, before the rules part | first message |

The codex, gemini and opencode installs are manual. **Re-run `squadrant rules install-hooks --agent <codex|gemini|opencode>` after upgrading squadrant** to pick up the profile entry.

What each session gets:
- **Audience.** A crew sees `all` + `crew`. A captain, or any plain session, sees `all` + `captain`.
- **Content.** Active core traits, confirmed or not. Proposals are never shown.
- **Order.** Corrections first, then newest `updated`, then id.
- **Overflow.** Lines are taken in that order until the next one would pass 3,000 chars. The rest collapses to `+N more: squadrant profile list`.
- **Pending line.** `Profile: N items pending review` appears only in non-crew sessions, and only when the queue has ≥5 items or its oldest item is more than 7 days old.
- **No snapshot.** The block is recomputed at every SessionStart (startup, resume, compact, clear).
- **Fail-open.** The block is built within a 1.5 s budget. An error, a missing `_user` or a blown budget injects nothing, and the hook still exits 0. A corrupt trait file is skipped and logged, and the valid traits are still injected.
- **Kill switch.** `SQUADRANT_PROFILE_INJECT=0`.

**Native-memory bridge.** Claude native memory keeps being written. The daemon copies it one way into proposals and never writes `~/.claude/projects/**`.
- **When.** Once at daemon boot, then from the 60 s knowledge tick whenever the last run is ≥60 min old. Two runs never overlap. The last-run time is cached in `<stateRoot>/profile-bridge.json`, which holds no other state.
- **Where.** Only allowlisted dirs: the encoded Claude dir of each registered project path, plus `$HOME`. Scratch, `/tmp` and parent dirs are never scanned.
- **What.** Only `<dir>/memory/*.md` files whose `type` (top-level or `metadata.type`) is `user` or `feedback`. `MEMORY.md` is skipped.
- **Grouping.** Files with the same name across dirs become one proposal with all their sources, and differing bodies are merged under `## From <dir>` headings. The summary is a draft built from the first `description`, which you approve or edit at review.
- **Changes.** If a note behind a kept trait changes, the bridge writes `_proposed/<slug>.update.md`. Keeping it replaces the body and sources but **keeps your summary**.
- **Dedup.** Deduplication comes from the files themselves (`sources:` and `_dropped.yaml`), so deleting the cache never brings anything back.
- **Dropped stays dropped.** A note you dropped, or one behind an archived trait, does not come back even if it is edited later. Dropping an *update* proposal is different: it skips only that exact change, and a later edit of the note raises a new update. To bring it back, add it with `squadrant profile add`, or delete its line from `_dropped.yaml` so the next bridge run proposes it again.
- **First run.** The first run imports today's memories as proposals for one review. Classify each one (profile, or route it to a project KB with `--drop <id> --reason "route: saitex rules"`).

**Env overrides (tests, relocated homes).** `SQUADRANT_USER_KB_DIR` (`<userKb>`), `SQUADRANT_NATIVE_MEMORY_ROOT` (default `~/.claude/projects`), `SQUADRANT_AUDIT_DIR`, `SQUADRANT_STATE_DIR`.

**Never.** No profile code path writes `~/.claude/CLAUDE.md`, `AGENTS.md` or `GEMINI.md`. A test enforces this.

### Session Continuity

- **Handoff files** — captain writes context on shutdown, reads on startup (`~/squadrant/workspace/<p>/handoff.json`, archived to `handoffs/`)
- **Session freshness** — auto-detects new day or template changes, forces fresh context. A claude captain resumes with `-c` only when `~/.claude/projects/<cwd>/` already holds a transcript; otherwise it starts fresh, so a boot that never started claude can't leave the next launch stuck on "No conversation found to continue" (#999)
- **claude-mem** — cross-session memory via MCP plugin

### Runtime state (`~/.local/state/squadrant`, #983)

squadrant keeps its runtime state in XDG state, not in `~/.config`. `~/.config/squadrant/` holds config only, plus the daemon socket (`squadrant.sock`) and `daemon.lock`, which stay there.

All of it resolves through one helper, `stateRoot()` in `@squadrant/shared`, and the first match wins:

1. `$SQUADRANT_STATE_DIR`
2. `dirname($SQUADRANT_CONFIG)/state`, but only when `SQUADRANT_CONFIG` points somewhere other than the default `~/.config/squadrant/config.json`. An isolated harness or e2e run that sets only `SQUADRANT_CONFIG` therefore never writes into the live mailbox or results. A `SQUADRANT_CONFIG` that names the default path falls through to step 3.
3. `$XDG_STATE_HOME/squadrant`
4. `~/.local/state/squadrant`

```
<stateRoot>/
  <project>/            task store, captain.json, per-task agent configs, auto-gate-opencode.log
  inbox/                captain mailboxes + delivery cursors
  _results/  _shared/   crew results, cross-project state
  rules-inject/         rules seen-set per session
  knowledge-schedule.json  liveness.json  sessions.json  …
  logs/squadrantd.log   daemon log (launchd stdout/stderr) = logsRoot()
  .seeded-from-legacy   marker: the one-time legacy copy ran
```

The rules audit log keeps its own path, `~/.local/state/squadrant/audit/` (`SQUADRANT_AUDIT_DIR`).

Because the layout is flat, a project dir shares a namespace with those entries. `squadrant projects add` therefore rejects the names `audit`, `logs`, `inbox` and `rules-inject`, and any name starting with `_` or `.`.

**Upgrading from ≤ 0.28.x (dual-read for one version):**
- **State copy.** On its first boot, the daemon copies the legacy `~/.config/squadrant/state` into the new root.
  - Files already in the new root win, and nothing is deleted.
  - It then writes `.seeded-from-legacy` and never copies again, so a mailbox entry or task record it consumed later is not brought back.
  - If the copy fails, the daemon logs it and keeps booting; the next boot retries.
- **`sessions.json`** (launch freshness) and the **daemon-log reader** (dashboard Logs tab, snapshot log stats) read the new path when it exists and fall back to the legacy file otherwise. Writes always go to the new path.
- **launchd log path.** The plist is rewritten to `logsRoot()/squadrantd.log`, but launchd only re-reads `StandardErrorPath` when the service is bootstrapped. So the running daemon keeps logging to `~/.config/squadrant/squadrantd.log` until the next `squadrant heal daemon` (which now does the bootout and bootstrap when the loaded path is stale) or the next login. Until then the log readers use the legacy file, so the Logs tab never goes blank.
- **`squadrant doctor`** warns (never FAILs) in two cases:
  - the legacy state dir still holds files. Once they are copied, that dir is a rollback copy; `squadrant migrate kb` archives it.
  - launchd is still writing the legacy log path.

**Rolling back to 0.28.x:** the old version reads `~/.config/squadrant/state` again. It sees the state as it was at upgrade time, not anything written since. Tasks, mailbox entries and results created after the upgrade exist only under the new root. Upgrading again does not re-copy, because the `.seeded-from-legacy` marker is still there. Anything written under `~/.config/squadrant/state` during the rollback stays in that dir until `squadrant migrate kb` handles it.

## Captain rollover (#1010)

`/squadrant:rollover` (alias `/squadrant:roll`) is a captain skill for Claude captains whose context is filling. In order, the captain writes a handoff (`write-handoff.sh`), writes the daily log, runs `squadrant captain compact <project>` as its last action and ends the turn. The operator types it once.

- **`squadrant captain compact <project> [--focus <text>]`** sends `captain-compact` to the daemon and returns. The daemon polls (1 s) until the captain pane shows no turn in flight on two consecutive polls, then types `/compact <focus>` + Enter through the runtime driver using the same send guard as every pane delivery (draft, open modal/prompt and no-box all defer). It never types into a busy pane or an open prompt. After 10 minutes without a chance it drops the request and logs `captain-compact <project>: timed out … not compacted`. Default focus: "Keep the active task, open PRs/crews and decisions; the full state is in the handoff". Needs the cmux runtime; Claude captains only (Claude Code has no compact API and the peer socket can't run slash commands).
- **Compact/delivery mutex (#1015).** A message is never in flight across a compact. In two phases: (1) *draining* — the request waits, on top of the idle check, until the project's mailbox has no undelivered entries (delivery keeps running, bounded by the 10-minute timeout above; last reason `undelivered-mail`). (2) *frozen* — the instant the idle check passes, the daemon sets a delivery hold for that project **before** typing `/compact` (no `await` between the final check and the hold; if a delivery pass is mid-flight it releases and retries next tick). While held, the delivery loop skips the project, including between entries of a pass: nothing is typed or sent over the peer socket, the cursor does not advance, and entries stay on the durable mailbox. The hold ends when the `SessionStart` hook with `source: "compact"` arrives (the hook sends `captain-compact-done` to the daemon after emitting its context), or after 3 minutes (`COMPACT_HOLD_MS`) if it never does. Held entries then deliver in order. (#1038) Right after squadrant types `/compact`, it also sends the captain one message over the captain peer channel ("Compact finished — continue from the handoff nextSteps."), bypassing the mailbox and its hold: `/compact` is a local command that starts no model turn, so without it the captain sits idle until the operator types. Claude Code queues the peer message until the compact ends. Only compacts squadrant queued send it; a compact the operator typed by hand never does. It is not written to the mailbox (a mailbox entry would be redelivered), and if no captain channel is available it is logged and skipped (never a pane fallback). If the send guard defers, the hold is released (nothing was typed). Nothing compacts on its own — this only makes an operator- or captain-initiated compact safe. **Known limit:** the hold covers only daemon-initiated compacts (`squadrant captain compact` / rollover). A `/compact` the operator types by hand is not held, and delivery may type into the pane around it.
- **Live ledger (#1015).** `crew approve` records `branch`, `prUrl`, `prNumber` and `reviewStage: "pr-open"` on the task record (via the `pr` field of the approve-sourced `task.done`). The task is still terminal (`done`), but `squadrant handoff facts` → `liveRepo.liveCrews` keeps it, labelled `reviewStage: "pr-open"` ("awaiting human review"), with `reviewNote`, branch and PR URL. `merged`/`closed` is resolved lazily: each read runs `gh pr view <url> --json state` and drops the crew once the PR is merged or closed; if `gh` cannot answer the crew stays listed. No daemon polling.
- **Re-injected ledger block (#1015).** After a compact the hook also adds a `Live crew ledger` block: one line per non-terminal, PR-open or open-tab crew (a crew that signalled done but whose tab is still open reads `done: awaiting captain review`; crews that are closed with no open PR are dropped) (name, state or "awaiting human review", a task summary — the first brief line naming an issue, else its first non-heading line, ~120 chars — branch (`crew/<name>` for live crews, the recorded one once approved), PR, operator hold, the open question word for word, review note) plus the count and short previews (first 5, 100 chars each) of undelivered mailbox entries. Bounded to 4000 chars; truncation is stated in the block. Sample:

  ```
  Live crew ledger (daemon state at compact time):
  - noise [blocked] | question: "Rebase onto develop, or merge?"
  - ledger [awaiting human review] | branch crew/ledger | PR https://github.com/x/y/pull/9 | review note: tests green
  Undelivered mailbox: 2 message(s) still queued — they arrive after this context, in order:
    #12 task.done (c1): CREW DONE c1 — shipped
    #13 task.done (c2): CREW BLOCKED c2
  ```
- **Re-injection.** On `SessionStart` with `source: "compact"` in a captain session (`SQUADRANT_ROLE=captain`, no crew env), the hook adds the project's handoff plus "Context was just compacted. This is your handoff; continue from nextSteps." to `additionalContext`, in the same JSON document as the rules block. The live `handoff.json` is preferred (the rollover skill just wrote it and nothing has archived it); otherwise the newest archived handoff is used. Crews, plain sessions and the `startup|resume|clear` sources get nothing. It also covers a `/compact` the operator types by hand.

## Context meter & rollover suggestions (#1015)

Squadrant measures live context for captains and crews and **suggests** a rollover at the right moment. It never compacts a session on its own and never types `/compact`: suggestions and warnings only, the operator or captain decides (profile `prof.never-auto-compact`).

**Meter.** `{ tokens, windowTokens?, pct?, measuredAt }` or `unknown`, from `@squadrant/core` (`context-meter.ts`).

| Agent | Source |
|---|---|
| Claude (captain and crews) | Tail of the session transcript (`~/.claude/projects/<escaped-cwd>/<session>.jsonl`): `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the latest assistant call. Tail read only (128 KB, doubling up to 4 MB if the tail has no usage), cached by mtime + size, lines sharing a message id counted once, all-zero synthetic usage skipped. The line parser is shared with `squadrant tokens` (#626). `windowTokens`/`pct` only appear when the model name states the window (a `[1m]` suffix). |
| Codex | `unknown`. Token data lives in the app-server thread, not in a file squadrant can tail cheaply. |
| OpenCode | `unknown`. Tokens live in opencode's own session store; no cheap, stable read yet. |

- A **crew's** transcript is found from `TaskRecord.sessionId` + `cwd` when the record carries the session id, otherwise as the newest transcript in the crew's own worktree dir written since the task was created (one crew per worktree).
- A **captain's** transcript is the newest `claude` record in the project's `captain-sessions.jsonl` registry (#651, written by the SessionStart hook).
- Shown as a `ctx` value in `squadrant crew list` and `squadrant crew tasks` (non-terminal tasks), and in `squadrant handoff facts` (`captainContext` plus `liveCrews[].context`). `unknown` is printed as `unknown`.

**Captain suggestions** (daemon, one line through the normal captain mailbox, e.g. `Context 182k ≥ 150k at a boundary (crew done). Good moment: write the handoff, then /squadrant:rollover.`):

- Boundaries: a crew reached `done`, was closed (`cancelled`), or its `blocked` question was answered.
- Fires only when a boundary happened **and** captain context ≥ `captainSoft`. Suppressed while any crew is `blocked` on a question or the captain mailbox has undelivered entries; the boundary waits (up to 30 min) and fires when that clears.
- Rate limit: one suggestion per boundary, and again only after a further +50k of growth. A context drop below the last mark (a rollover) resets it.
- **Hard warning:** captain context ≥ `captainHard` sends one louder line (`⚠ Context 360k ≥ hard limit 350k … Warning only: nothing is compacted automatically.`), no boundary needed, repeated only after each further +100k.
- Evaluated by a 15 s daemon tick; the transcript read is mtime-cached, so an unchanged captain costs the registry read plus a `stat`.

**Crew hint.** `squadrant crew send` prints `⚠ crew X at 210k; consider a fresh crew with a brief instead of reusing it` when the target crew's context ≥ `crewSoft`. Hint only; the send always happens.

**Config** (`~/.config/squadrant/config.json`, per-project override in `projects/<name>.json`, built-in → global → project per key):

```json
{ "defaults": { "contextBudget": { "enabled": true, "captainSoft": 150000, "captainHard": 350000, "crewSoft": 150000 } } }
```

Non-numeric or non-positive values are ignored. `enabled: false` silences suggestions, warnings and the crew hint; the meter columns still show.

## MCP server (`squadrant mcp`, #1029)

`squadrant mcp` is a stdio [MCP](https://modelcontextprotocol.io) server. First slice (agent → squadrant only): the crew signal tools, so a crew signals through a typed tool call instead of a Bash command (no Bash approval, no shell quoting, a structured result).

| Tool | Same as | Args (all optional strings) |
|---|---|---|
| `crew_signal_done` | `squadrant crew signal done` | `message` |
| `crew_signal_blocked` | `squadrant crew signal blocked` | `question` |
| `crew_signal_failed` | `squadrant crew signal failed` | `error` |
| `crew_signal_review` | `squadrant crew signal review` | `message` |

Every tool also takes `task_id` / `project`, which default to `SQUADRANT_CREW_TASK_ID` / `SQUADRANT_CREW_PROJECT` from the environment. The MCP child inherits those from the agent session that spawned it, so the model passes neither.

- **One implementation.** The CLI verb and the tools both call `performCrewSignal` (`packages/core/src/crew-signal.ts`): the already-terminal check (#557), the `_results/<id>.txt` write, the #901 citation scan and the #1039 confirmation line. The tool schemas and handler live in `packages/core/src/crew-signal-tools.ts`; `packages/cli/src/commands/mcp.ts` only wires them to the SDK.
- **Errors are tool errors** (`isError: true`) with a clear message: no crew env, task already terminal, daemon unreachable.
- **Completion protocol prefers the tool.** The `COMPLETION PROTOCOL` appended to a claude/opencode crew's first turn (`buildCompletionProtocol`) and the codex developer instructions say: call `crew_signal_done` (or `_blocked` / `_failed` / `_review`) from the `squadrant` server if available, passing the explicit `task_id` / `project` (codex needs them — one app-server serves many tasks), otherwise run the `squadrant crew signal …` CLI.
- **Skipping the ToolSearch step.** Under a crew (`SQUADRANT_CREW_TASK_ID` set) `tools/list` marks every `crew_signal_*` tool with `_meta: { "anthropic/alwaysLoad": true }` (`crewSignalToolList`, tested); a non-crew session (captain, operator) keeps them deferred, though a server-level `alwaysLoad` in the registration overrides that either way; Claude Code >= 2.1.285 then loads the tools upfront instead of deferring them, other MCP clients ignore `_meta` ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp), "Mark a tool to load upfront or stay deferred"). That per-tool flag does **not** make session startup wait for the server, so the very first turn of a freshly spawned crew can still race the MCP connect (the protocol's "No such tool → ToolSearch once → CLI" fallback covers it). **Recommended registration:** also set the server-level `alwaysLoad` on the `squadrant` server entry — startup then waits (up to ~5 s) for the server to connect. squadrant documents this but does not write it for you (nothing edits your agent config); set it in the entry `claude mcp add` created in `~/.claude.json` (`"alwaysLoad": true`), and check the exact key against the docs page for your Claude Code version.
- **Lazy SDK.** `@modelcontextprotocol/sdk` is imported inside `runMcpServer`, so no other command pays for it (tested).
- **Claude Code defers MCP tools and prefixes them:** the tool is `mcp__squadrant__crew_signal_done` (a bare `crew_signal_done` is "No such tool"), but they load upfront (per-tool `alwaysLoad`, below). The claude completion protocol (`buildCompletionProtocol(…, "claude")`), `templates/crew.claude.md` and `captain-ops` name the exact tools and give one fallback order: call the tool directly; only on "No such tool" load it once with ToolSearch `select:mcp__squadrant__crew_signal_done` and retry; if it still does not exist, use the CLI; opencode, codex and generic text use the plain tool name "from the `squadrant` MCP server" (no `mcp__` prefix).
- **Install is manual in this slice** (config projection, #34, is a later slice; nothing writes to your agent config):

  ```
  claude mcp add --scope user squadrant -- squadrant mcp
  ```

  Sessions opened before the install need a restart to see the tools. The CLI `squadrant crew signal` stays as the fallback and is not removed.
- Not in this slice: daemon → agent delivery over MCP. The spike ([report](specs/2026-10-26-mcp-spike-report.md)) found that a self-post from the session's own MCP child keeps Claude's "Another Claude session" framing on 2.1.310.

## Captain discussion threads (#1016)

The captain coordinates crews; deep discussion with the operator happens in a **thread**, a fork of the captain session scoped to one topic. Crew lifecycle events never go to a thread (threads are not crews; the daemon delivers only to the captain). When the decision is settled, the thread **parks**: the captain receives ONE decision message, never the discussion, which keeps it small enough to roll over. Spec: [`docs/specs/2026-10-21-captain-threads.md`](specs/2026-10-21-captain-threads.md). Diagram: [`docs/diagrams/2026-10-21-captain-threads.html`](diagrams/2026-10-21-captain-threads.html).

| Command | Does |
|---|---|
| `squadrant thread open <project> "<topic>" [--crew <name>...]` | Forks the captain into a new tab `💬 <project>:<id>` (id = topic slug) and sends the thread prompt as the first turn. Claude: `claude --resume <captain> --fork-session --session-id <new>` plus the captain's own flags under its own name `-n squadrant-thread-<project>-<id>` (plugins, model, effort, and the captain prompt as a byte-identical copy `threads/thread.claude.md`, so cmux liveness never counts the thread as a second captain). |
| `squadrant thread park <project> <id>` | Asks the open thread to write its decision record. |
| `squadrant thread park <project> <id> --decision-file <path\|->` | Run by the thread itself: stores the record, appends ONE `captain.message` to the captain mailbox, appends one line `[thread <id>] <topic>: <decision>` to `handoff.json` `session.decisions`, closes the tab. The session id is kept. |
| `squadrant thread resume <project> <id>` | Parked thread. Within 1h of its last activity: `claude --resume <thread session>` plus a delta (crew ledger now, decisions from other threads since it parked). Later: a fresh fork of the current captain plus this topic's earlier decision records. |
| `squadrant thread close <project> <id>` | Marks it closed (terminal) and closes a live tab. |
| `squadrant thread list <project> [--all]` / `show <project> <id> [--json]` | Read the registry. |

- **Registry:** `<stateRoot>/<project>/threads/<id>.json`, next to crew task records: `{ id, project, topic, crews, state: open|parked|closed, agent, mode: fork|seed, sessionId, forkedAt, lastActiveAt, parkedAt, surfaceId, decisions[] }`. States: `open → parked | closed`, `parked → open | closed`, `closed` is terminal.
- **Decision record** (JSON the thread writes): `{ "question", "decision", "reasons": [], "rejected": [], "actions": [{ "crew", "action" }] }`; `at` is stamped by the CLI. `question` and `decision` are required.
- **Captain message** (short form):

  ```text
  💬 Thread decision — Auth cache (thread auth-cache)
  Q: Cache auth tokens in app-core?
  Decision: Yes, 10 min TTL, invalidate on logout
  Why: cuts p95 login by 40%; logout path already emits an event
  Rejected: no cache — too slow; 1h TTL — stale roles
  Actions: crew-a → add TTL cache in app-core; crew-b → no change
  Full record: squadrant thread show app auth-cache
  ```
- **Handoff:** if no live `handoff.json` exists (startup archives it), the line is appended to a copy of the newest archived handoff, so a later compact still re-injects the full context. `write-handoff.sh` replaces the file; the captain carries the `[thread …]` lines over.
- **Cap:** `defaults.maxThreads` (default 3) open threads; `open` and `resume` refuse past it. Parked threads run no process.
- **Prompt cache.** The thread instructions go in the first turn, never in the system prompt: a fork keeps the captain's cache prefix only while system prompt, tools and model match. Measured on a throwaway 188k-token session: the fork's first call read 171,960 tokens from cache and wrote 15,790 (a plain `--resume` read 171,960 and wrote 18,651); with `--session-id` 187,726 read / 7,355 written. Wall time was about 6 s per call, the same as a resume.
- **Environment:** the thread runs with `SQUADRANT_ROLE=thread SQUADRANT_THREAD_ID=<id>`, so it is not registered as the captain (`captain-sessions.jsonl`) and is gated like the captain by the U7 permission gate.
- **Agents without fork (codex, opencode, gemini):** `thread open` starts a fresh interactive session seeded with the thread prompt, the live crew ledger and the topic's decision records, and prints a note (not an error). Resume always re-seeds. opencode uses its interactive driver command. codex and gemini run their plain interactive CLI, because their drivers build only headless one-shots. A Claude captain with no registered session falls back the same way.
- **Triage:** the captain templates and `squadrant:captain-ops` carry the 3-level triage of crew questions (1 operator ↔ crew, 2 captain answers with a cited source, 3 thread). Crews list what they settled directly with the operator in their done message (`Decided with operator: …`).

## Human review guide (#1012)

`squadrant:human-review-guide` is a general skill (`plugin/skills/human-review-guide/`, `/squadrant:human-review-guide` in any session) that gives the operator a short, well-sourced guide for the **human gate** of crew PRs: intent and scope, public contracts, architecture trade-offs, test validity and a live comparison with the design. Machines (crew self-review, captain agent review, CI, lint, guard tests, KB rule checks, a repo's PR review tool) run first; the human gate covers only what those gates cannot see or did not cover.

- **Gate coverage map.** Before picking points the captain maps every gate that ran to what it covers in this diff. A point enters the guide only if no gate covered it or only a human can judge it, and carries a `Gated by` field (`none` or `<gate> (partial: …)`). What a gate verified is dropped and never re-asked.
- **Gate gaps.** Things that should be machine-checked but no gate covers (a template no test renders, a rule enforced only by prose) are listed with a suggested new gate or follow-up ticket, so a human catches each once and a machine next time.

- **Mode.** One PR: answer in chat (no file unless the operator asks for the HTML too, then both). Several PRs: a local `<workspace>/artifacts/review-guides/<date>-<topic>.md` plus an interactive `.html` (tabs: Read first, one per PR in review order, Verdict; summary table, stack diagram, review and merge order, collapse recommendation, each point's "You judge" as a checkbox counted in per-PR progress (also shown as a bar in the tab), copy buttons on anchors, test paths and the open-code block plus a header "Copy all anchors", optional design-compare card, a Verdict tab with a per-PR table plus pending decisions and a before-handing list that appear only when the guide data provides items, and "Copy my findings" with severity prefixes, the points not yet judged and the gate gaps). The HTML is self-contained, works at phone width, in light and dark, and without storage. Written in the operator's language; a language toggle against English appears only when the operator's preferences ask for bilingual docs.
- **Per PR.** Context (features, fixes, not done, breaking, waits on), tests first with a manual mutation per test, implementation points (Where `file:line` + symbol, Gated by, What, Why, Cause, Solution, You judge, Axis as tags). Every checkbox is a specific question about the PR; there is no generic checklist. Anchors are verified at the head SHA with `git grep -n` on `origin/<branch>`, the SHA is stated per PR and refreshed on every head update.
- **Written by the owner.** The session that drove the PRs (normally the captain) writes it, never a fresh crew or subagent.
- **Local only.** The guide is never posted on a PR, issue, tracker or chat. After a PR review tool run that may comment, read the comment back and strip anything beyond the tool's standard body; run such tools with commenting off while a guide request is fresh. A GitHub comment edit keeps history.
- Templates: `templates/guide.template.md`, `templates/guide.template.html`. It is in `CREW_SKILLS`, so crew and side sessions get it too; captains load it from the full `plugin` dir.

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
    "users": [987654321],
    "remoteControl": true,
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
    "maxThreads": 3,
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
    },
    "roles": {
      "captain": { "agent": "claude", "model": "fable", "thinking": "medium" }
    }
  }
}
```

The `telegram` block is **optional** — omit it and the Telegram bridge is never constructed. `botToken` may be left out of the file and supplied via the `TELEGRAM_BOT_TOKEN` env var instead. `chats` is the inbound `chat_id` allowlist; `users` is the per-user-id allowlist for **control** actions and `remoteControl` (default `false`) is the master opt-in for auto-launch + the General command channel — both must be set for any remote control to act (fail-closed, [#321](https://github.com/tu11aa/squadrant/issues/321)). `pollMs` (default `1000`) is the inbound long-poll cadence. See [Telegram (Two-Way, opt-in)](#telegram-two-way-opt-in).

The `defaults.router` block is also **optional** — omit it and every role/rule stays on the `native` backend, so behavior is unchanged. When present, roles and routing rules select `backend: "direct"` or `"proxy"` to route the `claude` harness through an Anthropic-Messages upstream. Full schema, the OpenRouter walkthrough, CCR/LiteLLM alternatives, and the backward-compat guarantee are in [Router Backend (Harness/Provider Decoupling)](#router-backend-harnessprovider-decoupling).

The `defaults.gate` block is **optional** too — omit it and the U7 permission gate is off (`mode` defaults to `auto`, a no-op, so the agent's normal permission flow is untouched). With `mode: "on"`, the new `engine` field selects **who** decides a claude `PermissionRequest`:

```jsonc
{
  "defaults": {
    "gate": {
      "mode": "on",
      "engine": "router",       // "router" (default) | "auto-gate"
      "model": "sonnet",        // router engine only
      "policy": "deny-dangerous",
      "tools": ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"],
      "cache": true,
      "deny": ["^\\s*sudo\\b"]
    }
  }
}
```

| `engine` | Behaviour |
|---|---|
| `router` **(default)** | U7's in-repo classifier: squadrant calls the configured router model directly (no Anthropic credential). Unchanged. |
| `auto-gate` | The standalone [`@squadrant-ai/auto-gate`](https://www.npmjs.com/package/@squadrant-ai/auto-gate) package decides (Jev-backed by default; its own config/keys, e.g. `TYPESAFE_API_KEY`). `allow`/`deny` print `hookSpecificOutput.decision.behavior`; `ask` prints nothing and emits exactly one `task.blocked`. |

Env vars override every field at runtime: `SQUADRANT_GATE` (mode), `SQUADRANT_GATE_ENGINE` (engine), `SQUADRANT_GATE_POLICY`, `SQUADRANT_GATE_TOOLS`, `SQUADRANT_GATE_MODEL`. Router-backed crews/captains inject `SQUADRANT_GATE=on`; the auto-gate host honours that env override even when no `defaults.gate` block is present.

**opencode ([#828](https://github.com/tu11aa/squadrant/issues/828) P6-C phase 2).** opencode has no `PermissionRequest` hook, so `engine: "auto-gate"` works differently there: instead of a per-prompt hook call, an opencode crew/captain launch is wrapped end-to-end. With `mode: "on"` + `engine: "auto-gate"` + the engine credential present (`hasAutoGateCredential` — env `TYPESAFE_API_KEY` or `~/.auto-gate-key`), squadrant launches the pane with `squadrant gate opencode-run --port <n> [--session <id>]` instead of a bare `opencode …`. That hidden command calls the package's `buildRunPlan({ args, allocate })` with `allocate` resolving to the **same port** squadrant already allocated for its own SSE bridge (turn-end detection, CREW DONE, approval answering) — never a second port — then runs opencode and the package's `opencode watch` watcher as one supervised unit (`supervise`). **Ownership:** once a crew is gate-wrapped, the auto-gate watcher is the sole answerer of opencode `permission.asked` events; squadrant's own CP3 `--approval`/`gateBash` crew-approval flag (which also answers permission prompts, via the SSE bridge) is suppressed for that crew to avoid two answerers racing the same prompt. **The wrapped crew/captain's per-task `opencode.json` sets `bash` and `edit` to `"ask"`** (everything else, incl. `external_directory`, unchanged; unwrapped configs are byte-identical to before) — opencode only emits `permission.asked` for `ask` rules, so an allow-all config would leave the watcher nothing to decide. squadrant's SSE bridge only records/surfaces the prompt (`task.approval.requested` → blocked → captain/Telegram) and never answers on its own, so if auto-gate answers `ask` (uncertain) the prompt stays open and reaches the operator. For a gate-wrapped crew (detected from its per-task config having both `bash` and `edit` at `ask`) the bridge holds each `permission.asked` for a ~5s grace window and drops it if `permission.replied` arrives first — so prompts auto-gate answers never ping the captain/Telegram; only still-open ones surface (and a later reply returns the task blocked → working). CP3 `--approval` crews surface immediately, unchanged; auto-gate is the only automatic answerer. **Gate log ([#866](https://github.com/tu11aa/squadrant/issues/866)):** the watcher's output and squadrant's own supervise log never touch the pane TTY (they garbled the TUI and broke `squadrant crew answer`); both append to `<stateRoot>/<project>/auto-gate-opencode.log` (`_shared` when no project env is set), or are discarded if that file can't be opened. **Safety fallback:** if the credential is absent, or building/running the plan throws for any other reason, squadrant logs one warning and launches opencode directly, byte-identical to the gate-off command — a gate defect must never stop a crew from starting. `mode: "on"` + `engine: "router"` is a no-op for opencode (that engine only owns Claude's `PermissionRequest` hook); opencode is unaffected either way. See [Router Backend](#router-backend-harnessprovider-decoupling).

**Switching the mode without a shell ([#854](https://github.com/tu11aa/squadrant/issues/854)).** `squadrant gate mode [on|off|auto]` reads or writes `defaults.gate.mode` directly — no arg prints the effective mode and its source (`env`/`config`/`default`); an argument validates, writes, and reports `old → new`. No daemon bounce is needed: unlike `defaults.router` (see [Managed `~/.claude/settings.json`](#managed-claudesettingsjson-615)'s daemon-cached-key note), `defaults.gate.mode` is not in `DAEMON_CACHED_PREFIXES`, so every hook invocation reads the file live. `squadrant gate status` additionally shows the resolved `engine`, the resolved classifier `model`, and whether that engine's credential resolves (`present`/`absent` — the value itself is never printed). The same toggle is available as a portable slash command — mirrors the [effort dial](#effort-dial-tokenomics)'s two-skill pattern (`plugin/skills/set-gate` owns the logic, `plugin/skills/gate` is the thin `/gate` alias) — in **both** Claude Code (the Skill tool) and opencode (the shipped skill is projected verbatim into `~/.config/opencode/skills/`, same mechanism as every other squadrant skill). `defaults.gate.mode` is also in the Telegram `WRITABLE_CONFIG_KEYS` allowlist (see [Telegram (Two-Way, opt-in)](#telegram-two-way-opt-in)), with `on`/`off`/`auto` value validation on `/config set` so a malformed value never reaches the CLI.

## Rules audit log (#935)

Every rules push and pull is logged, so you can tell whether a rule is ever surfaced and used. One JSON line per event is appended to `~/.local/state/squadrant/audit/YYYY-MM.<hostname>.jsonl` (override the directory with `SQUADRANT_AUDIT_DIR`). Fields: `ts, kb, level, project, domain:"rules", itemId, event, trigger, score, chars, agent, session`, plus `task` on delivery events (`item.surfaced`/`item.shown`/`item.searched`) when `SQUADRANT_CREW_TASK_ID` is set. That's stamped in `appendAudit`, so every agent's delivery path (Claude hooks, `rules match --agent codex|opencode`, `rules search`/`show`) records it the same way (#945).

- `item.surfaced` / `item.suppressed` come from the SessionStart and UserPromptSubmit injection (`trigger: "session"|"prompt"`). Suppressed = past the session cap, or a prompt hit that was already shown, under the strength bar, or over the 3-rule cap (the top 10 are logged).
- `item.searched` (`rules search`: one event per printed hit, attributed to that rule's KB and id, query truncated to 200 chars; a search with no hits logs one event with an empty `itemId`) and `item.shown` (`rules show`).
- Write events (`item.proposed`/`applied`/`rejected`/…) from extraction and review also use `domain:"rules"` (the KB domain, not the rule's subject domain). They count toward domain writes only and never make an id a stats row.
- Event names follow the generic KB schema (spec §7), so other domains can reuse them. Writes are best-effort: a failure prints one stderr line and never blocks a hook or command. A daemon single-writer is phase 2.

### Citations, feedback and scores (#901)

Injected blocks end with one line asking the agent to list the rule ids it applied as `Rules: <id>, <id>` at the end of its `signal done` message (commit messages count too). Every crew template (claude, opencode, and the generic one used by codex and gemini) asks the same. That is what makes "used" measurable.

- **`item.cited`** is logged when a delivered (surfaced, shown or returned by `rules search`) rule id appears as a whole token in a message. Hook points:
  - **Automatic:** `squadrant crew signal done|review` scans the `--message` and the crew branch's own commits: commits on `HEAD` that no other local branch and no remote ref other than the branch's own has, so no base branch is needed and a pushed branch still counts. It is in the CLI signal path, so it works for every agent. It is bounded (at most 200 commits, 2s git timeout, one audit-log read) and never affects the signal: a failure prints one stderr line. Each commit is cited once, deduped by sha.
  - **Manual:** `squadrant knowledge cite-scan --project p --text "<message>"` (handoff text or anything else), and `squadrant knowledge cite-scan --project p --git <repo> [--since-days 30]` (commit messages on every local branch, deduped by sha). The `--git` form is the backstop for commits made outside a crew signal, or for a branch that a later branch was stacked on before it signalled.
  - Only deliveries made before the text or commit count. Only ids the audit log shows were delivered to that project in the last 7 days can be cited.
- **`squadrant knowledge feedback <id> --followed|--violated|--noise|--wrong [--project p] [--source s] [--task id]`** logs an `item.outcome` with a `source` (`operator` by default; also `review`, `crew`, `reconcile`, `judge`, `check`) and an optional crew `task`. Records written before #945 have no `source` and count as `operator`. Reconcile's code-violation flag logs `violated` with `source: "reconcile"` itself.
- **`squadrant knowledge surfaced --task <id> [--json]`** lists the rules delivered to that crew task (surfaced, shown or searched), deduped, as `<id>  [<modality>]  <statement>`. The captain runs it at review and grades the rules that apply to the diff with `knowledge feedback <id> --followed|--violated --source review --task <id>` (captain-ops skill).
- **Scores** are computed by code, never by a model, over the last 30 days: fire rate (surfaced), pull rate (shown + searched; the `pulled` column), use rate (cited ÷ surfaced), noise rate, violation rate, evaluated (followed + violated), compliance rate (followed ÷ evaluated, `n/a` below 3 evaluations; the `Compliance` column next to `Violated`), code violations, `last_surfaced`/`last_used`, never-fired-30d; per domain writes/month, reads/month, chars injected per citation and a **dead-domain alarm** (no writes and no reads for 30 days); tier contribution; per-agent coverage; reviewer agreement (operator `approve` resolutions ÷ all operator resolutions in `verdicts.jsonl`); outcomes by source (`bySource`). Only `operator`, `review`, `judge` and `check` outcomes count toward followed/violated/noise/wrong and the rates. `crew` outcomes are shown in `bySource` but not counted. Reconcile `violated` outcomes are counted as `codeViolations` instead: they measure codebase drift, so they stay out of violation rate and out of the full pass's "reword" list. Every reconcile pass writes `<kb>/scores.json` (git-ignored) and a `## Scores` section in `REPORT.md` (committed). `squadrant knowledge stats [--kb k] [--project p] [--domain d] [--item id] [--json]` prints them on demand.
- **Rotation**: logs are monthly files. A full pass folds every month that ends before the 30-day scoring window into `YYYY-MM.<machine>.stats.json` (per-item counts, so lifetime totals and `last_used` survive) and removes the raw file. `verdicts.jsonl` is never compacted.
- **Privacy**: query text is truncated to 200 characters, REPORT.md and notifications carry ids and counts only.

## Rules KB reconcile (#898)

A KB with `homeProject` and `sources.yaml` is reconciled on a schedule kept in `stateRoot/knowledge-schedule.json` and driven by the daemon's 60s tick: an incremental pass 7 days after the first source change (the window is fixed; later edits do not push it back), a full pass every 30 days, and a full pass right away for an empty KB. One pass runs per KB at a time (a `running` entry older than 6h is taken over); a full pass absorbs a due incremental one; sources are snapshotted when the pass starts, so edits made during the pass open the next window. The daemon only appends a `captain.message` to the `homeProject` captain's mailbox; the captain spawns a crew with the `knowledge-review` skill. The daemon never spawns.

Per-KB settings (`knowledgeBases.<kb>.reconcile`, all optional): `incrementalAfterDays` (7), `fullEveryDays` (30), `autoApproveConfidence` (0.8).

| Command | Purpose |
|---|---|
| `knowledge reconcile <kb> [--full] [--now] [--dry-run]` | no flags: show schedule state. `--now`: request a pass from the home captain. `--dry-run`: show what would be requested |
| `knowledge reconcile <kb> [--full] --finish` | close the pass: full-pass checks, `REPORT.md`, schedule update, one-line captain message with the count. When the KB is its own git repo, `--finish` leaves it clean (#1002): it commits `REPORT.md` (and `.gitignore` when it has changes) with `--only`, so nothing else is swept in, and makes sure `scores.json` (derived from the audit log) and `escalations.json` (open review state) are ignored. A failed commit is logged and the file is kept |
| `knowledge review <kb> --json` | reviewer packet |
| `knowledge review <kb> --apply decisions.json` | apply typed reviewer decisions; at or above `autoApproveConfidence` they apply, otherwise they escalate |
| `knowledge review <kb>` | interactive walk-through of open escalations (approve / reject / edit; keep-doc / supersede-with-code); `--resolve <key> --approve\|--reject\|--keep-doc\|--supersede-with-code --reason …` is the scripted form |
| `knowledge sources <kb> --remove <path> [--dry-run]` | drop the `sources.yaml` entry whose `path` is exactly `<path>`, strip every rule ref it covers (glob matched, so it works after the files moved; a legacy relative ref like `kb/extracted/x.md` counts as the `~/saitex/kb/extracted/x.md` it names), mark rules left with no source `stale`, recompile `index.json`. Rules with another source stay `active`. Stale rules are still delivered until the reviewer retires them. `--dry-run` lists the effect and writes nothing. Comments and other entries in `sources.yaml` are kept. `_proposed/` files are not touched |
| `knowledge propose --kb <kb> "<statement>" --evidence "<where>"` | agent learning: writes to `_proposed/` with `agent` priority |

Always escalated, regardless of confidence: a conflict between two `company` sources, retiring a `must`/`must-not` rule, anything the reviewer flags, any proposal from a `review: required` source (reason `review-required`; the reviewer agent can never approve it), and **code-vs-doc** conflicts where the code is newer than the doc (by git dates). Those are never auto-superseded; the operator's answer is stored as a `decision` block on the rule (who, when, `keep-doc | supersede-with-code`, doc and code revisions, reason) and is not asked again unless the doc gets a new revision or the anchored code changes after the decision date. When the doc is newer, the code is flagged as a violation in `REPORT.md`.

The full pass also reports duplicate candidates, usage findings from the audit log (never surfaced, noisy, violated), domains over the cap, and `override.base-changed` for project overrides whose KB rule changed. Open escalations live in `<kb>/escalations.json`, reviewer and operator verdicts in `<kb>/verdicts.jsonl` (append-only). Write-stage events (`item.proposed|approved|rejected|applied|superseded|archived`) go to the audit log.
