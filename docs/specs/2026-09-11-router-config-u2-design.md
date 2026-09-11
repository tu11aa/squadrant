# Router/Config — U2 design (schema & routing semantics)

**Status:** design, approved direction
**Date:** 2026-09-11
**Issue:** [#774](https://github.com/tu11aa/squadrant/issues/774) — config schema & routing semantics (epic [#772](https://github.com/tu11aa/squadrant/issues/772))

**Scope note:** this spec covers **U2 only (config schema + routing semantics + daemon wiring)**.
The transport/shim is **U1** (`docs/specs/2026-09-11-router-transport-u1-design.md`, decisions 1–7
LOCKED). Driver env injection is **U3** (`#775`). Cost UI is **U5**. Nothing here redesigns the shim.

**Reading order:** U1 spec → this spec → U1 plan.

## Why this exists

U1 defines the runtime seam: a daemon-internal, loopback Anthropic-Messages proxy (`RouterShim`)
that activates **only when `config.router` exists**, plus the env contract U3 injects
(`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY=""` / `ANTHROPIC_MODEL`).
U1 deliberately does not say *what config shape selects a backend*, *where the `backend` field
lives*, or *how a model id is named across harnesses*. That is U2.

U2 answers one question: **how does a role or a routing rule select `native` / `direct` / `proxy`
and a model, and how is that resolved at spawn time** — without changing any behavior for a user
who has not configured a router.

## Current state (verified in-tree)

- `SquadrantConfig.defaults` (`packages/shared/src/config.ts`) has `roles` (`RoleAssignment`:
  `agent`, `model?`, `thinking?`), `crewRouting.rules` (`CrewRoutingRule`: `tier`, `match`,
  `agent`, `model?`), and `effort`. No `router`.
- `resolveCrewRoute(task, config)` (`packages/core/src/crew-routing.ts:15`) returns the first
  matching rule's `{agent, model?, tier, matchedRule}` or `null`. Pure.
- `runCrewSpawn` (`packages/core/src/crew-spawn.ts:408-461`) resolves
  `agent = route.agent ?? input.agent ?? "claude"` and
  `model = input.model ?? route.model ?? (roles.crew.model when agent matches)`. Routing is
  consulted **only when** `!input.agentExplicit && !input.model`.
- `detectDrift` (`packages/shared/src/lib/config-drift.ts:66`) validates agent drivers and role
  agents against `agents.*`; `MANAGED_PATHS` drives `config check --fix`.
- **U1 is implemented and merged to `develop`** (PR [#780](https://github.com/tu11aa/squadrant/pull/780),
  merged 2026-09-11) — `packages/core/src/router/{types,shim,auth,errors,sanitize,stream}.ts`
  + tests. U2 branches from `develop`. Two surfaces already exist and must NOT be re-declared:
  - `BackendMode = "native" | "direct" | "proxy"` (`packages/core/src/router/types.ts:4`).
  - `RouterUpstream { baseUrl, apiKey, authHeader?, extraHeaders?, isAnthropic? }`
    (`packages/core/src/router/types.ts:9`) — the shim's input shape.
  (The router surface is already re-exported from `packages/core/src/index.ts:28` on `develop`.)
- Config files are written `0600` and the dir `0700` (`packages/shared/src/lib/config-io.ts`), so
  an inline secret is consistent with the existing `telegram.botToken` pattern.
- **The live config today works around the missing feature** by putting `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` into `defaults.claudeEnv`, which `installClaudeHooks`
  merges into `~/.claude/settings.json`. That leaks a provider key into a Claude settings file and
  routes **every** Claude session, captain included, with no per-role control. U2/U3 replace it.
- Upstream actually chosen for routing: **opencode-go** (`https://opencode.ai/zen/go`,
  `x-api-key` + required `x-opencode-session`, model `deepseek-v4.1-flash`).

## Decisions

1. **`defaults.router` is a single optional global block.** One upstream per machine. Roles and
   rules vary only `backend` + `model`; there is no per-rule upstream override (U1's shim is
   single-upstream; a second gateway is out of scope). Absent `router` ⇒ the shim is never
   constructed and every backend resolves to `native`.
2. **`backend` lives on BOTH `RoleAssignment` and `CrewRoutingRule`** — matching `agent`/`model`,
   which already exist on both. A role default (`roles.crew.backend`) can be overridden by a
   routing rule, which can be overridden by an explicit `--backend` flag. **U2 only consumes
   `roles.crew`** (the spawn role); `backend` on `captain`/`command`/`side`/`exploration` is
   type-level only until a later unit wires those spawners — `config check` still validates its
   shape.
   `roles.crew.backend` applies **only when `roles.crew.agent` equals the resolved agent** (the
   same guard the model path uses), so a non-claude routing rule does not inherit a claude-only
   role backend.
3. **Backend is the U1 three-value closed set: `native | direct | proxy`.** U2 **supersedes** the
   umbrella label `"router"` that appears in the epic-issue sketch (#772) *and* in U1's own prose
   (U1 decisions 2 and the architecture diagram, written before the 3-value set was finalized);
   `"router"` is **not** a valid config value. `native` is the global default.
4. **Model ids resolve through an optional alias layer** (`defaults.router.models.<alias>` with a
   per-harness `agents` map) because the same logical model is spelled differently per harness
   (`opencode-go/deepseek-v4.1-flash` for opencode vs raw `deepseek-v4.1-flash` for the claude
   harness through the shim). A `model` that is not a defined alias is treated as a **literal** and
   passed through unchanged — this keeps every existing config working.
5. **Router backends are claude-only.** `direct`/`proxy` speak the Anthropic Messages seam; a
   non-claude harness (`opencode`/`codex`/`gemini`) always runs `native`. `config check` flags
   `backend != native` on a non-claude agent as `invalid`.
6. **A router backend with no `config.router` is a hard error at spawn** and an `invalid` drift
   item. Failing loud beats silently running on a subscription/API login the operator did not
   intend (Karpathy principle 1).
7. **No `config.router` ⇒ zero behavior change.** No backfill, no migration, no shim, no env.
   Unlike `crewRouting` (`config.ts:282`), U2 never writes default router config on load.
8. **Secrets stay in `config.json` (0600), with an `apiKeyEnv` alternative.** `defaults.router`
   is deliberately **not** added to `MANAGED_PATHS`, so `config check --fix` never seeds or
   rewrites credentials.

## Config schema

### TypeScript (additions to `packages/shared/src/config.ts`)

```ts
/** U1 backend seam. `native` is the global default; routing is opt-in.
 *  Single source of truth — `packages/core/src/router/types.ts` must re-import
 *  this from `@squadrant/shared` instead of re-declaring it (DAG: shared is the leaf). */
export type BackendMode = "native" | "direct" | "proxy";

/** Recognized upstream shapes. Drives auth/isAnthropic defaults + validation. */
export type RouterKind = "opencode-go" | "openrouter" | "ccr" | "litellm" | "custom";

/** A squadrant model alias, expanded per harness at spawn time. */
export interface RouterModelAlias {
  /** Id the configured upstream expects (e.g. "deepseek-v4.1-flash"). */
  upstream: string;
  /** Per-harness override (e.g. { opencode: "opencode-go/deepseek-v4.1-flash" }). */
  agents?: Record<string, string>;
}

export interface RouterConfig {
  kind: RouterKind;
  /** Origin + base path, WITH NO VERSION SEGMENT — the client appends "/v1/messages"
   *  automatically; never include "/v1". */
  baseUrl: string;
  /** Inline credential. Mutually exclusive with apiKeyEnv. */
  apiKey?: string;
  /** Env var holding the credential (preferred when the operator keeps keys out of JSON). */
  apiKeyEnv?: string;
  /** Credential header. "Authorization" (Bearer, default) | "x-api-key" (opencode-go). */
  authHeader?: string;
  /** Extra headers merged into every upstream request, e.g. { "x-opencode-session": "..." }. */
  extraHeaders?: Record<string, string>;
  /** Loopback bind port; 0 (default) = ephemeral. */
  port?: number;
  /** true for a real-Anthropic upstream (disables U1 server-tool/field stripping). */
  isAnthropic?: boolean;
  /** Optional alias table consumed by model resolution (decision 4). */
  models?: Record<string, RouterModelAlias>;
}
```

Additions to existing interfaces:

```ts
export interface RoleAssignment {
  agent: string;
  model?: string;
  backend?: BackendMode;      // NEW
  thinking?: ThinkingLevel;
}

export interface CrewRoutingRule {
  tier: string;
  match: string;
  agent: string;
  model?: string;
  backend?: BackendMode;      // NEW
}
```

`SquadrantConfig.defaults` gains `router?: RouterConfig`. `CrewRouteResult`
(`packages/core/src/crew-routing.ts`) gains `backend?: BackendMode`.

### JSONC (worked example — the opencode-go upstream)

```jsonc
{
  "defaults": {
    "router": {
      "kind": "opencode-go",
      "baseUrl": "https://opencode.ai/zen/go",   // no /v1
      "apiKeyEnv": "OPENCODE_GO_KEY",
      "authHeader": "x-api-key",
      "extraHeaders": { "x-opencode-session": "squadrant" },
      "port": 0,
      "isAnthropic": false,
      "models": {
        "flash": {
          "upstream": "deepseek-v4.1-flash",
          "agents": { "opencode": "opencode-go/deepseek-v4.1-flash" }
        }
      }
    },
    "roles": {
      // harness claude through the loopback shim — reasoning is normalized by U1 (b)
      "crew": { "agent": "claude", "backend": "proxy", "model": "flash" }
    },
    "crewRouting": {
      "rules": [
        { "tier": "hard",  "match": "refactor|implement|feature",
          "agent": "claude", "backend": "proxy", "model": "flash" },
        { "tier": "quota", "match": "backend-service",
          "agent": "codex", "backend": "native" }
      ]
    }
  }
}
```

`extraHeaders` are **static** in v1. The shim holds a single upstream for all projects, so it cannot
vary a header per request; a machine-wide `x-opencode-session` is what the U1 live spike validated.
Per-project session ids are a future U1 shim enhancement (they would need the minted token →
project mapping at the shim, which already exists).

## Routing semantics

### Backend selection per harness

| `agent` | `backend` | Path | Env injected (U3) |
|---|---|---|---|
| `claude` | `native` | CLI's own auth — unchanged | none |
| `claude` | `direct` | `ANTHROPIC_BASE_URL=router.baseUrl` + real credential + `ANTHROPIC_CUSTOM_HEADERS` | baseUrl + apiKey + model + headers |
| `claude` | `proxy` | `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (U1 shim) | shim url + minted token + model |
| non-claude | `native` | native CLI/provider — unchanged | none (default) |
| non-claude | `direct`/`proxy` | **rejected** (decision 5) | — |

`proxy` is the default *mode* once a role chooses to route (U1 architecture table), but choosing
`direct`/`proxy` is always explicit. `backend` absent ⇒ `native`, even when `config.router` exists.

### Precedence

```
agent   = --agent   ?? rule.agent   ?? roles[role].agent   ?? "claude"
model   = --model   ?? rule.model   ?? roles[role].model*   ?? <agent default>
backend = --backend ?? rule.backend ?? roles[role].backend  ?? "native"
```

`*` role model applies only when `roles[role].agent === resolved agent` — the existing guard in
`crew-spawn.ts:457`, preserved so a cross-agent crew never receives an invalid model arg.

**`--backend` and the rule gate.** `--backend` does **not** suppress the rule: it overrides only
the `backend` field, while the rule still supplies `agent`/`model`. Concretely, the existing gate
(`crew-spawn.ts:410`) stays keyed on `--agent`/`--model` only, and backend is resolved separately:

```
route   = (!agentExplicit && !model) ? resolveCrewRoute(task, config) : null   // unchanged
backend = --backend ?? route?.backend ?? roles[role].backend ?? "native"
```

So `squadrant crew spawn … --backend native` (no `--agent`/`--model`) runs the rule's `agent`/`model`
on the native backend; passing `--model` suppresses the rule entirely (existing #275 contract) and
backend falls to the role default. This is deliberate — a rule's agent/model pair is a unit.

Backward-compat note: `crew-spawn.ts:410` consults routing **only when**
`!input.agentExplicit && !input.model`. U2 preserves this — passing `--agent` or `--model`
suppresses the rule *including* `rule.backend`, falling through to the role default. This is the
existing #275 contract and is documented in the `add-pick-crew-rule` skill, not changed here.

### Resolution order for `native` vs `router`

1. Effective `backend === "native"` → no router work at any layer.
2. Effective `backend` is `direct`/`proxy`:
   - `config.router` present → resolve target via the daemon (proxy) or config (direct).
   - `config.router` absent → **hard error** at spawn:
     `backend 'proxy' selected for agent 'claude' but defaults.router is not configured`.
3. `direct`/`proxy` on a non-claude agent → hard error at spawn (mirrored by `config check`).

## Model-id resolution (alias layer)

Pure helper, owned by `@squadrant/shared` (used by crew-spawn and any other role spawner):

```ts
export function resolveRouterModel(
  model: string | undefined,
  agentName: string,
  router: RouterConfig | undefined,
): string | undefined {
  if (!model) return undefined;
  const alias = router?.models?.[model];
  if (!alias) return model;                                  // literal passthrough
  return alias.agents?.[agentName] ?? alias.upstream;
}
```

Examples (with the alias table above):

| config `model` | agent | resolved |
|---|---|---|
| `flash` | `claude` | `deepseek-v4.1-flash` |
| `flash` | `opencode` | `opencode-go/deepseek-v4.1-flash` |
| `opencode-go/deepseek-v4.1-flash` | `opencode` | unchanged (literal) |
| `deepseek/deepseek-chat` | `claude` | unchanged (literal) |

This is why an existing config with a full `opencode-go/...` model keeps working verbatim: it is not
a declared alias, so it passes through. An alias name that collides with a literal id is the
operator's responsibility; documented in the skill.

**Ordering at spawn.** `resolveRouterModel` runs **after** the `roles[role].agent === agent.name`
delegation-source check, and receives whichever `model` that resolution produced
(`--model` → `rule.model` → role model → agent default). The value passed to the driver and to
`onModelResolved` is the **resolved** id (e.g. `deepseek-v4.1-flash`), not the alias name — so
existing fallback warnings (`model-guard.ts`) and logs see the real model.

## Daemon wiring (U2 owns)

Mirrors `TelegramBridge`: constructed **iff `config.router` is present**, inside the CLI host
(`packages/cli/src/squadrantd.ts`) — U1's plan explicitly reserved `squadrantd.ts` for U2.

- Resolve credential: `router.apiKey ?? process.env[router.apiKeyEnv]`. Missing both ⇒ the service
  logs a warning and `credentialsFor()` fails with
  `defaults.router credential is missing (set apiKey or apiKeyEnv)` for any `direct`/`proxy` request,
  so a misconfiguration surfaces as the documented hard error rather than an upstream `401`.
- **`RouterConfig → RouterUpstream` mapping.** `RouterUpstream` (`types.ts:9`) is the only shape the
  shim accepts; the daemon constructs exactly one, not a second shape:

  | `RouterConfig` | `RouterUpstream` |
  |---|---|
  | `baseUrl` | `baseUrl` |
  | `apiKey` / `env[apiKeyEnv]` | `apiKey` |
  | `authHeader` | `authHeader` (kind default when unset) |
  | `extraHeaders` | `extraHeaders` |
  | `isAnthropic` | `isAnthropic` |
  | `kind`, `port`, `models` | not passed (U2-only) |

- Derive defaults from `kind` when unset: `opencode-go` ⇒ `authHeader: "x-api-key"`,
  `isAnthropic: false`; `openrouter`/`ccr`/`litellm`/`custom` ⇒ `authHeader: "Authorization"`,
  `isAnthropic` from config only.
- Start the shim on `127.0.0.1:router.port ?? 0`; the bound URL is the runtime source of truth.
- Mint **one token per project** for the daemon's lifetime; keep `Map<token, project>`. Tokens are
  never logged and never written to disk.
- Expose the resolved target to the spawn path over the existing daemon socket so U3 can inject
  env without the CLI re-deriving port/token. Sketch (exact protocol is U3's to finalize):

  ```
  request : { kind: "router-credentials", project }
  proxy   : { backend: "proxy", baseUrl: "http://127.0.0.1:<port>", token: "<minted>" }
  direct  : { backend: "direct", baseUrl: "<router.baseUrl>", apiKey: <router credential>,
              extraHeaders: { ... } }   // direct has no shim; extra headers must ride the harness
  native  : { backend: "native" }
  ```

  `direct` deliberately returns the real upstream credential to the spawn path (there is no shim to
  swap auth). Because U1's proxy env contract has no arbitrary-header mechanism, `direct` uses a
  **different env mapping** (U3): `ANTHROPIC_BASE_URL=router.baseUrl`,
  `ANTHROPIC_API_KEY=<credential>`, and `ANTHROPIC_CUSTOM_HEADERS` built from `extraHeaders`. This
  keeps `direct` viable for `x-api-key` + `x-opencode-session` upstreams; a `direct` upstream must
  accept either `x-api-key` or `Authorization: Bearer`, or it needs the shim (`proxy`).

- **Readiness gate.** `RouterShim.url()` returns `http://127.0.0.1:<port>` but `<port>` is `0` until
  `listen` completes. `createRouterService` therefore tracks `started` (set after `shim.start()`
  resolves) and `credentialsFor("proxy")` **throws** `router service not started` until then. The
  host start is fire-and-forget, so U3 owns the spawn-time wait: a routed spawn must call
  `health()` / await readiness before injecting env. A dead upstream surfaces via U1 `/healthz` as
  `CREW BLOCKED`, not a silent `:0` URL.

## Validation & integration

### `squadrant config check` (`packages/shared/src/lib/config-drift.ts`)

New `invalid` items (severity `warn`), detected in `detectDrift`:

| Condition | Path |
|---|---|
| `router.kind` not in `RouterKind` | `defaults.router.kind` |
| `router.baseUrl` not an absolute URL | `defaults.router.baseUrl` |
| `router.port` not an int in `0..65535` | `defaults.router.port` |
| `router.apiKey` and `router.apiKeyEnv` both set | `defaults.router.apiKey` |
| `rules[i].backend` not in `native/direct/proxy` | `defaults.crewRouting.rules.<i>.backend` |
| `roles[r].backend` not in `native/direct/proxy` | `defaults.roles.<r>.backend` |
| `backend` `direct`/`proxy` with `agent !== claude` | the offending path |
| a rule/role resolves to `direct`/`proxy` while `defaults.router` is absent | the offending path |
| `router.models.<alias>.agents` references an unknown agent | `defaults.router.models.<alias>.agents.<name>` |

`defaults.router` is **not** added to `MANAGED_PATHS` (decision 8): `--fix` must not seed secrets
or rewrite the block. It **must** be added to `DAEMON_CACHED_PREFIXES`
(`packages/shared/src/daemon-keys.ts`) so `squadrant config set defaults.router…` triggers
`restartDaemonIfRunning` (`packages/cli/src/commands/config.ts:106`) — `isDaemonCachedKey` only
restarts a key that is present in that list. Without it, editing a router key via the CLI would
leave the running shim on the old upstream. A **direct file edit** of `config.json` still requires
a manual daemon bounce (the shim is constructed at boot); the spec records that.

### `add-pick-crew-rule` skill (`plugin/skills/add-pick-crew-rule/SKILL.md`)

- Extend the documented rule shape with optional `"backend": "native|direct|proxy"`.
- Document: `backend` is meaningful only for `agent: "claude"` (`direct`/`proxy`); non-claude rules
  stay `native`.
- Document: a routed rule requires `defaults.router`; its `model` may be a squadrant alias from
  `defaults.router.models` or a literal id.
- Keep the existing precedence reminder; add `--backend` to the overrides list.

## Backward compatibility

- **No `config.router`:** shim never constructed (U1), every backend resolves `native`, nothing is
  injected, and `loadConfig` performs no router migration/backfill. Byte-for-byte today's behavior.
- **Existing `roles.*.model` / `rules[].model` literals** (e.g. the live
  `opencode-go/deepseek-v4.1-flash`) pass through `resolveRouterModel` unchanged.
- **Existing `crewRouting` backfill** (`config.ts:282-292`) is untouched.
- **`effort`** is unaffected: it remains a captain-side hint, not a code path in resolution.
- New fields are all optional; no schema version bump is required.

## Testing / verification

**Unit — `@squadrant/shared`**
- `resolveRouterModel`: alias→claude, alias→opencode, literal passthrough, undefined.
- drift: each `invalid` row above; and `defaults.router` never appears as `missing` (not managed).

**Unit — `@squadrant/core`**
- `resolveCrewRoute` returns `backend` from a matching rule.
- backend precedence: explicit > rule > role > `native`, incl. the model-matches-agent guard.
- non-claude + `direct`/`proxy` → throws; `proxy` with no `config.router` → throws.

**Integration**
- daemon constructs the shim iff `config.router` is present (mirror the TelegramBridge boot test).
- `router-credentials` returns the expected shape per backend.

**Out of this spec (U3):** a routed `claude` spawn carries the 4 env vars; a `native` spawn carries
none; `ANTHROPIC_API_KEY` is empty-string not unset.

## Out of scope (U2)

- Shim internals, sanitizer, streaming, cost tee (U1).
- Driver env injection mechanics (U3).
- Cost dashboards / local price tables (U5).
- Per-rule/per-role upstream override and multi-upstream routing (decision 1).
- Routing a non-claude harness through an Anthropic-shaped upstream (decision 5).
- Anthropic↔OpenAI protocol translation (U1 decision 1).
- Migrating the live `defaults.claudeEnv` workaround — operational cleanup, tracked separately;
  U2 only makes it unnecessary.

## Open questions / risks

- **`direct` credential exposure.** `direct` has no shim to swap auth, so the spawn path receives
  the upstream key to place in the harness env. Accepted for the Anthropic-native case; revisit if
  a shim-always policy is preferred.
- **Model-alias collision.** An alias name equal to a literal id silently wins. Mitigation is
  documentation + the skill; a stricter "alias names must not contain `/`" rule is a possible
  follow-up if operators hit it.
- **Daemon bounce on router change.** `router` is boot-time config; changing it needs a restart.
  Documented, acceptable for v1.
- **`extraHeaders` are static (no templating) in v1.** Per-project session ids need a U1 shim
  change (derive the session from the minted project token); deferred, and the static value is what
  the U1 spike proved works.

## Decisions already made — do not re-litigate

1. Single global `defaults.router`; roles/rules vary `backend` + `model` only.
2. `backend` on both `RoleAssignment` and `CrewRoutingRule`.
3. Backend values are U1's `native | direct | proxy`; `"router"` is not a value; `native` default.
4. Optional alias layer `defaults.router.models`, literal passthrough otherwise.
5. `direct`/`proxy` are claude-only; non-claude is always `native`.
6. Router backend without `config.router` → hard error + `config check` invalid.
7. No `config.router` ⇒ zero behavior change; no backfill.
8. Secrets inline (0600) or via `apiKeyEnv`; `defaults.router` stays out of `MANAGED_PATHS`.
