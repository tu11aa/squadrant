# Router/Transport — U1 design

**Status:** approved direction, not started
**Date:** 2026-09-11
**Issue:** [#772](https://github.com/tu11aa/squadrant/issues/772) — decouple agent harness from provider

**Scope note:** this spec covers **U1 only (Router/Transport layer)**. Config schema, routing
rules, and per-role `backend` are U2. Driver env-injection plumbing is U3. Neither is designed
here.

## Why this exists

Squadrant's harness (`claude` / `codex` / `opencode` / `gemini`) is coupled to its provider
(native subscription vs API gateway). Issue #772 proposes keeping the Claude Code harness while
routing the LLM calls to an arbitrary backend via `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_MODEL`.

U1 answers one question: **what is the transport between the harness and the provider, and who
owns the translation?** The answer determined below is deliberately narrow, because the hard part
(Anthropic↔OpenAI protocol translation) is *not* squadrant's job.

## Research findings that shaped this design

1. **OpenRouter ships a native Anthropic Messages endpoint ("Anthropic Skin").** Claude Code can
   point `ANTHROPIC_BASE_URL=https://openrouter.ai/api` at it directly, with no local proxy.
   Thinking, native tool use, streaming, and multi-turn all pass through for **Anthropic models**.
   OpenRouter also accepts `cache_control` and converts breakpoints to provider-native caching,
   and returns `usage.cost`.
   — [OpenRouter Claude Code integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration),
   [Create a message (`/v1/messages`)](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message)
2. **The native skin is only reliable for Anthropic models.** Non-Anthropic reasoning models
   (DeepSeek, Grok) break on the second turn when thinking is involved: Claude Code emits an
   assistant `thinking` block with an **empty signature**, and the replay is rejected upstream
   (`400 … thinking must be passed back`). The documented workaround is a translation shim that
   rewrites reasoning on the round-trip.
   — anthropics/claude-code [#68995](https://github.com/anthropics/claude-code/issues/68995),
   opencode [#24261](https://github.com/anomalyco/opencode/issues/24261) / [#35689](https://github.com/anomalyco/opencode/issues/35689),
   musistudio/claude-code-router [#866](https://github.com/musistudio/claude-code-router/issues/866)
3. **Anthropic server-side tools conflict with third-party upstreams.** Claude Code's search tool
   produced `400 Invalid Anthropic Messages API request` through OpenRouter; disabling it fixes
   it. — anthropics/claude-code [#31380](https://github.com/anthropics/claude-code/issues/31380)
4. **The codebase has no router/transport code today.** `packages/agents/src/drivers/claude.ts`
   builds a plain `claude` command; no `ANTHROPIC_*` env is injected anywhere
   (`grep ANTHROPIC_BASE_URL|openrouter|baseUrl` → 0 hits). `RuntimeSpawnOptions.command` is a
   shell string; UI/daemon layers can therefore inject env via the command prefix or `--settings`.

## Decisions

1. **Transport = "any endpoint that speaks Anthropic Messages."** The seam is
   `ANTHROPIC_BASE_URL` + token + model. Squadrant never speaks the OpenAI protocol. Protocol and
   model translation stay upstream (OpenRouter's Anthropic skin, or any Anthropic-compatible
   router the user brings such as CCR / LiteLLM).
2. **Default implementation for `backend:"router"` is a built-in thin shim in `squadrantd`**,
   not an external router and not direct-only. The shim is *Anthropic-in / Anthropic-out* — it
   fixes the concrete reasoning-replay breakage and adds cost/health/auth, and delegates all real
   translation to the upstream. This keeps the surface small while making the headline use case
   (cheap non-Anthropic models via router) actually work.
3. **The shim lives in `@squadrant/core` as a daemon-internal service**, constructed only when
   `config.router` is present — same shape as `TelegramBridge`. Absent config ⇒ zero behavior
   change.
4. **(b) Thinking/empty-signature policy: normalize, never emit a signatureless block.**
   Outbound replay rewrites each assistant `thinking` block to carry a non-empty deterministic
   placeholder `signature` when empty, preserving `text`; `redacted_thinking` and unrecognized
   reasoning artifacts are stripped. Validate live (see §7); if upstream rejects the placeholder,
   fall back to "drop unsigned thinking + provider-native empty reasoning."
   **Empirical result (2026-09-11, opencode-go `deepseek-v4.1-flash`): the bug does NOT
   reproduce** — the upstream returns a non-empty `signature` on thinking blocks and multi-turn
   tool-use replay succeeds (intra-invocation agentic loop and cross-invocation `-c`). The
   sanitizer is therefore not required for U1's upstream and Phase 6 is skipped. Revisit only if
   the upstream contract changes.
5. **(c) Caching passes through untouched.** `cache_control` is the upstream's job to convert.
   Only Anthropic *server-side* tools (`bash_20250124`, `text_editor_*`, `computer_*`,
   `web_search_*`) and Anthropic-only request fields (`container`, `context_management`,
   `mcp_servers`) are stripped for non-Anthropic upstreams; custom/MCP tool definitions pass
   untouched. The `anthropic-beta` **header** is deliberately forwarded (whitelisted) — only the
   body-form fields listed here are stripped.
6. **(d) Streaming and tool-use pass through; auth and cost are owned by the shim.** No SSE
   reassembly (the Anthropic seam is already Anthropic-shaped). Client bearer is swapped for the
   upstream auth header. `usage` (plus the top-level `cost` the upstream returns — observed as a
   numeric string on opencode-go) is captured; no local price table in v1.

## Architecture

Three `backend` modes behind one seam:

| Mode | Claude points at | Protocol translation | Reasoning sanitize |
|---|---|---|---|
| `native` **(global default)** | CLI's own auth (unchanged) | n/a | n/a |
| `direct` | OpenRouter skin / CCR / LiteLLM / Anthropic | upstream | nobody (bug accepted) |
| `proxy` (default *when routing*) | squadrantd loopback shim | upstream | the shim |

**Default is `native`.** The global default `backend` is `native`, so a user who stops paying
for a router (or never configures one) reverts to a Claude subscription/API login with **zero
config change and zero squadrant code in the path**. `proxy` and `direct` are opt-in: they only
activate when `config.router` is present *and* the role/rule selects `backend:"router"`. No router
config ⇒ behavior is byte-for-byte today's behavior.

```
 ┌──────────────┐   Anthropic Messages   ┌────────────────────┐   Anthropic Messages   ┌──────────────────┐
 │ claude CLI   │ ─────────────────────▶ │  RouterShim        │ ─────────────────────▶ │ OpenRouter skin  │
 │ (harness)    │ ◀───────────────────── │  (squadrantd,      │ ◀───────────────────── │ / CCR / LiteLLM  │
 └──────────────┘      SSE passthrough   │   loopback)        │   SSE passthrough +    └──────────────────┘
        ▲                                │   • sanitize (b/c) │      usage tee                 │
        │ ANTHROPIC_BASE_URL             │   • auth swap      │                                ▼
        │ ANTHROPIC_AUTH_TOKEN           │   • health / cost  │                       provider (DeepSeek,
        │ ANTHROPIC_API_KEY=""           └────────────────────┘                        Gemini, Grok, …)
        │ ANTHROPIC_MODEL
        └── injected by U3
```

**Lifecycle**

- Constructed by the daemon only when `config.router` exists; listens on loopback
  `127.0.0.1:<port>`.
- Each request must carry a **daemon-minted per-project token** in
  `Authorization: Bearer …`. The shim maps it to the upstream credential. Other local processes
  without the token get `401` (loopback is necessary but not sufficient).
- **Spawn gate:** crews are spawned only after `/healthz` reports ready; upstream 4xx/5xx flips
  health and surfaces as a task failure / `CREW BLOCKED` with the upstream message.

## Shim behavior

### Request path (outbound)

1. Authenticate the minted token; `401` on mismatch.
2. Parse the Anthropic Messages body. Malformed ⇒ `400` without forwarding.
3. If upstream is non-Anthropic:
   - strip Anthropic server-side tools and Anthropic-only fields (decision 5),
   - leave custom/MCP tools and `cache_control` untouched,
   - strip `redacted_thinking` / unknown reasoning artifacts.
4. Forward to the configured upstream base URL with the upstream credential.

### Response path (inbound)

- **Non-stream:** parse JSON; for each assistant `thinking` block, ensure a non-empty `signature`
  (placeholder if missing); re-emit the Anthropic envelope.
- **Stream:** pipe SSE through unchanged, with a tee that parses the final `usage` (and
  `message_stop`). Do **not** reassemble tool-use or reasoning deltas — pass them through.
- Upstream errors are re-emitted as the Anthropic error envelope
  (`{"type":"error","error":{…}}`) so Claude Code renders them natively.

## Interface contract

U1 **consumes** config (owned by U2) and **owns** the runtime seam and the env names U3 injects.

**Shim endpoints**

| Endpoint | Purpose |
|---|---|
| `POST /v1/messages` | Anthropic Messages proxy (stream + non-stream) |
| `GET /healthz` | Readiness + upstream reachability for the spawn gate |

**Env contract (U1 defines the names; U3 injects them)**

```
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
ANTHROPIC_AUTH_TOKEN=<daemon-minted per-project token>
ANTHROPIC_API_KEY=""            # explicitly empty — prevents Anthropic fallback
ANTHROPIC_MODEL=<model id>      # e.g. deepseek/deepseek-chat
```

`ANTHROPIC_API_KEY` must be an explicitly empty string, not unset, or Claude Code can fall back to
authenticating against Anthropic directly (per OpenRouter's integration guide).

## Error handling

| Condition | Shim response |
|---|---|
| Missing/invalid minted token | `401` |
| Malformed request body | `400`, not forwarded |
| Upstream reasoning `400` | log upstream body; Anthropic-shaped `400` + short hint |
| Upstream unreachable / `5xx` | Anthropic-shaped `502`; `/healthz` unhealthy; captain notified |
| Client disconnect mid-stream | abort upstream request; release the connection |

## Testing / verification

**Unit** — sanitizer: thinking-normalize (empty sig → placeholder), server-tool stripping, cache
passthrough, Anthropic error-envelope mapping, token auth.

**Integration** — mock upstream: byte-faithful SSE passthrough, usage tee on the final event,
non-stream JSON rewriting.

**Live acceptance (spike, not CI)** — the gate for decision (b):
- DeepSeek-via-OpenRouter completes **≥3 turns** with tool use (the #68995 repro).
- Anthropic-via-OpenRouter still works end-to-end.
- `native` mode is byte-for-byte unchanged.

## Out of scope (U1)

- Anthropic↔OpenAI translation and tool-use reassembly.
- Config schema, routing rules, per-role `backend` (U2).
- Driver env-injection implementation (U3).
- Non-claude harnesses.
- Cost dashboards / local price tables / credential pools.

## Open questions / risks

- **Placeholder signature acceptance is unproven.** The live spike in §7 decides between
  placeholder-signature and drop-fallback. Do not ship (b) without that repro.
- **Upstream protocol drift.** The shim depends on OpenRouter's Anthropic skin behavior; pin and
  test against a recorded contract, and fail loudly rather than silently rewrite.
- **Depends on U2/U3 landing** for anything user-visible. U1 can be built and tested standalone
  against a mock or a hand-set env.

## Decisions already made — do not re-litigate

1. Anthropic-Messages seam; squadrant never speaks OpenAI protocol.
2. Built-in thin shim in `squadrantd`, not external CCR-required and not direct-only.
3. Shim is a daemon-internal service in `@squadrant/core` (TelegramBridge shape).
4. Thinking policy: normalize (placeholder signature), empirically validated, drop-as-fallback.
5. `cache_control` passes through; only server-side tools / Anthropic-only fields are stripped.
6. Streaming/tool-use passthrough; shim owns auth + cost capture.
7. **Global default `backend` is `native`** — routing is opt-in; no router config means unchanged
   Claude subscription/API behavior.
