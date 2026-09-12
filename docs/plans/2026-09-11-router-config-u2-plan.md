# Router/Config U2 (schema & routing semantics) Implementation Plan

> **Status: APPROVED — executing.** Spec `docs/specs/2026-09-11-router-config-u2-design.md` reviewed
> and approved by the captain; base branch = `develop` (U1/#780 merged). If the spec changes,
> re-derive the affected tasks before proceeding.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `defaults.router` config block, a `backend` field on roles and routing rules, model-alias resolution, drift validation, and the daemon-side router service so a role/rule can select `native | direct | proxy` — with zero behavior change when `config.router` is absent.

**Architecture:** Types + pure resolution live in `@squadrant/shared` (leaf). Rule/role/spawn resolution lives in `@squadrant/core`. The daemon service (`@squadrant/core/src/router/service.ts`) wraps the already-implemented U1 `createRouterShim` and mints one token per project; the CLI host (`squadrantd.ts`) constructs it only when `config.router` exists. Driver env injection is U3 and is NOT built here.

**Tech Stack:** TypeScript (Node 24), vitest, commander. No new dependencies.

**Issue / dependency map:**
- This plan is the implementation for **#774 (U2)**. It writes no GitHub issues.
- **Branch base:** `develop`. U1 (#773) is implemented and merged to `develop`
  (PR [#780](https://github.com/tu11aa/squadrant/pull/780), 2026-09-11) — verify
  `git ls-files packages/core/src/router | head` shows `shim.ts` before starting.
- Do not redesign U1. `packages/core/src/router/{types,shim,auth,errors,sanitize,stream}.ts` + tests
  are already on `develop`.
- U3 (#775) consumes the resolver/service this plan exposes for env injection.
- U4–U6 (#776–#778) are out of scope.
- Spec: `docs/specs/2026-09-11-router-config-u2-design.md` (decisions 1–8 locked).

**Scope guards:**
- Do NOT edit shim internals (U1). The only U1 file touched is `packages/core/src/router/types.ts` (re-import `BackendMode`) and `packages/core/src/router/index.ts` (add one export line).
- Do NOT edit any agent driver / `RuntimeSpawnOptions` (U3).
- Do NOT add the CLI↔daemon `router-credentials` request kind — that protocol is U3. U2 exposes `RouterService.credentialsFor()` in-process.

**Focused test command:** `pnpm vitest run <path>` — full suite: `pnpm test`. Typecheck: `pnpm lint`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/config.ts` (modify) | `BackendMode`, `RouterKind`, `RouterModelAlias`, `RouterConfig`; `backend?` on `RoleAssignment`/`CrewRoutingRule`; `defaults.router?` |
| `packages/shared/src/router-model.ts` (create) | `isBackendMode`, `resolveRouterModel` |
| `packages/shared/src/index.ts` (modify) | export `router-model.js` |
| `packages/shared/src/lib/config-drift.ts` (modify) | new `invalid` checks |
| `packages/shared/src/daemon-keys.ts` (modify) | add `defaults.router` |
| `packages/core/src/router/types.ts` (modify) | re-import `BackendMode` from shared |
| `packages/core/src/router/service.ts` (create) | `resolveRouterUpstream`, `createRouterService` |
| `packages/core/src/router/index.ts` (modify) | export `service.js` |
| `packages/core/src/router-resolution.ts` (create) | `resolveBackend`, `assertBackendUsable` |
| `packages/core/src/crew-routing.ts` (modify) | `CrewRouteResult.backend` |
| `packages/core/src/crew-spawn.ts` (modify) | resolve + assert backend, expand model alias, `onBackendResolved` dep, `backend?` input |
| `packages/core/src/daemon/context.ts` (modify) | `routerService?` on opts + context |
| `packages/core/src/daemon/start.ts` (modify) | start/stop the router service |
| `packages/core/src/index.ts` (modify) | export router surface + `router-resolution.js` |
| `packages/cli/src/squadrantd.ts` (modify) | construct the router service when `config.router` present |
| `packages/cli/src/commands/crew.ts` (modify) | `--backend` flag |
| `plugin/skills/add-pick-crew-rule/SKILL.md` (modify) | document `backend` + aliases |

---

## Phase 1 — Schema (`@squadrant/shared`)

### Task 1.1: Router types + `backend` on roles/rules

**Files:**
- Modify: `packages/shared/src/config.ts`
- Test: `packages/shared/src/__tests__/router-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/router-types.test.ts
import { describe, it, expect } from "vitest";
import { getDefaultConfig, type BackendMode, type RouterConfig } from "../config.js";

describe("router config types", () => {
  it("accepts defaults.router and per-role/per-rule backend", () => {
    const router: RouterConfig = {
      kind: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go",
      apiKeyEnv: "OPENCODE_GO_KEY",
      authHeader: "x-api-key",
      extraHeaders: { "x-opencode-session": "squadrant" },
      port: 0,
      isAnthropic: false,
      models: { flash: { upstream: "deepseek-v4.1-flash", agents: { opencode: "opencode-go/deepseek-v4.1-flash" } } },
    };
    const mode: BackendMode = "proxy";
    const c = getDefaultConfig();
    c.defaults.router = router;
    c.defaults.roles = { ...c.defaults.roles, crew: { agent: "claude", backend: mode, model: "flash" } };
    c.defaults.crewRouting = { rules: [{ tier: "hard", match: "refactor", agent: "claude", backend: "proxy", model: "flash" }] };

    expect(c.defaults.router?.kind).toBe("opencode-go");
    expect(c.defaults.roles?.crew?.backend).toBe("proxy");
    expect(c.defaults.crewRouting?.rules[0].backend).toBe("proxy");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/router-types.test.ts`
Expected: FAIL — `RouterConfig`/`BackendMode` not exported and `backend` is not a known property.

- [ ] **Step 3: Add the types to `packages/shared/src/config.ts`**

Insert after the `ModelAlias` line (currently line 30):

```ts
/** U1 backend seam. `native` is the global default; routing is opt-in. */
export type BackendMode = "native" | "direct" | "proxy";

export function isBackendMode(v: string): v is BackendMode {
  return v === "native" || v === "direct" || v === "proxy";
}

/** Recognized upstream shapes; drives auth/isAnthropic defaults + validation. */
export type RouterKind = "opencode-go" | "openrouter" | "ccr" | "litellm" | "custom";

export const ROUTER_KINDS: readonly RouterKind[] = ["opencode-go", "openrouter", "ccr", "litellm", "custom"];

export function isRouterKind(v: string): v is RouterKind {
  return (ROUTER_KINDS as readonly string[]).includes(v);
}

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
  /** Env var holding the credential. */
  apiKeyEnv?: string;
  /** Credential header. "Authorization" (Bearer, default) | "x-api-key". */
  authHeader?: string;
  /** Static headers merged into every upstream request (e.g. x-opencode-session). */
  extraHeaders?: Record<string, string>;
  /** Loopback bind port; 0 (default) = ephemeral. */
  port?: number;
  /** true for a real-Anthropic upstream (disables U1 stripping). */
  isAnthropic?: boolean;
  /** Optional alias table consumed by resolveRouterModel. */
  models?: Record<string, RouterModelAlias>;
}
```

Add `backend?: BackendMode;` to `RoleAssignment` (after `model?`):

```ts
export interface RoleAssignment {
  agent: string;
  model?: string;
  /** U2 backend seam. Unset ⇒ "native". `direct`/`proxy` are claude-only. */
  backend?: BackendMode;
  /** Per-role thinking level → claude `--effort <level>`. Unset ⇒ flag omitted. */
  thinking?: ThinkingLevel;
}
```

Add `backend?: BackendMode;` to `CrewRoutingRule` (after `model?`):

```ts
export interface CrewRoutingRule {
  tier: string;
  match: string;
  agent: string;
  model?: string;
  /** U2 backend seam. Unset ⇒ falls through to the role default. */
  backend?: BackendMode;
}
```

Add `router?: RouterConfig;` to `SquadrantConfig.defaults` (after `effort?`):

```ts
    /** U2: optional router upstream. Absent ⇒ the shim is never constructed and
     *  every backend resolves to `native` (zero behavior change). */
    router?: RouterConfig;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/router-types.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/src/__tests__/router-types.test.ts
git commit -m "feat(#774): add router config types + per-role/rule backend"
```

### Task 1.2: `resolveRouterModel` alias expansion

**Files:**
- Create: `packages/shared/src/router-model.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/router-model.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/router-model.test.ts
import { describe, it, expect } from "vitest";
import { resolveRouterModel } from "../router-model.js";
import type { RouterConfig } from "../config.js";

const router: RouterConfig = {
  kind: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go",
  models: { flash: { upstream: "deepseek-v4.1-flash", agents: { opencode: "opencode-go/deepseek-v4.1-flash" } } },
};

describe("resolveRouterModel", () => {
  it("expands an alias to the upstream id for claude", () => {
    expect(resolveRouterModel("flash", "claude", router)).toBe("deepseek-v4.1-flash");
  });
  it("expands an alias to the per-agent id for opencode", () => {
    expect(resolveRouterModel("flash", "opencode", router)).toBe("opencode-go/deepseek-v4.1-flash");
  });
  it("passes an unknown value through as a literal", () => {
    expect(resolveRouterModel("deepseek/deepseek-chat", "claude", router)).toBe("deepseek/deepseek-chat");
    expect(resolveRouterModel("opencode-go/deepseek-v4.1-flash", "opencode", router)).toBe("opencode-go/deepseek-v4.1-flash");
  });
  it("returns undefined when there is no model", () => {
    expect(resolveRouterModel(undefined, "claude", router)).toBeUndefined();
  });
  it("returns the model unchanged when router is absent", () => {
    expect(resolveRouterModel("flash", "claude", undefined)).toBe("flash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/router-model.test.ts`
Expected: FAIL — cannot resolve `../router-model.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/router-model.ts
import type { RouterConfig } from "./config.js";

/**
 * Resolve a configured model id for a specific harness. If `model` names an alias
 * in `router.models`, return the per-agent id when present, else the upstream id.
 * Any other value is a literal and passes through unchanged (backward compatible).
 */
export function resolveRouterModel(
  model: string | undefined,
  agentName: string,
  router: RouterConfig | undefined,
): string | undefined {
  if (!model) return undefined;
  const alias = router?.models?.[model];
  if (!alias) return model;
  return alias.agents?.[agentName] ?? alias.upstream;
}
```

- [ ] **Step 4: Add the export**

In `packages/shared/src/index.ts`, after `export * from "./effort.js";`:

```ts
export * from "./router-model.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/router-model.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/router-model.ts packages/shared/src/__tests__/router-model.test.ts packages/shared/src/index.ts
git commit -m "feat(#774): add resolveRouterModel alias expansion"
```

### Task 1.3: Single-source `BackendMode` in core

**Files:**
- Modify: `packages/core/src/router/types.ts:4`

- [ ] **Step 1: Replace the local declaration with a re-export**

In `packages/core/src/router/types.ts`, delete line 4:

```ts
export type BackendMode = "native" | "direct" | "proxy";
```

and replace it with:

```ts
export type { BackendMode } from "@squadrant/shared";
```

- [ ] **Step 2: Typecheck**

Run: `pnpm lint`
Expected: PASS — no duplicate/colliding export; `@squadrant/core` re-exports the shared union.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/router/types.ts
git commit -m "refactor(#774): re-export BackendMode from shared (single source)"
```

---

## Phase 2 — Routing resolution (`@squadrant/core`)

### Task 2.1: `resolveCrewRoute` returns `backend`

**Files:**
- Modify: `packages/core/src/crew-routing.ts`
- Test: `packages/cli/src/__tests__/crew-routing.test.ts`

- [ ] **Step 1: Add the failing test**

Append inside the `describe("resolveCrewRoute", …)` block in `packages/cli/src/__tests__/crew-routing.test.ts`:

```ts
  it("returns the rule's backend when present", () => {
    const config = makeConfig({
      crewRouting: {
        rules: [{ tier: "hard", match: "refactor", agent: "claude", backend: "proxy", model: "flash" }],
      },
    });
    const result = resolveCrewRoute("refactor the auth module", config);
    expect(result).toMatchObject({ agent: "claude", backend: "proxy", model: "flash", tier: "hard" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/crew-routing.test.ts`
Expected: FAIL — `backend` is `undefined` on the result.

- [ ] **Step 3: Update `packages/core/src/crew-routing.ts`**

Replace the file body with:

```ts
import type { BackendMode, SquadrantConfig } from "@squadrant/shared";

export interface CrewRouteResult {
  agent: string;
  model?: string;
  backend?: BackendMode;
  tier: string;
  matchedRule: string;
}

/**
 * Resolve a crew route from task text against config.defaults.crewRouting.rules.
 * Returns the first matching rule's agent/model/backend, or null if no rule
 * matches or crewRouting is absent. Pure — no side effects.
 */
export function resolveCrewRoute(taskText: string, config: SquadrantConfig): CrewRouteResult | null {
  const rules = config.defaults.crewRouting?.rules;
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    const re = new RegExp(rule.match, "i");
    if (re.test(taskText)) {
      return {
        agent: rule.agent,
        ...(rule.model !== undefined ? { model: rule.model } : {}),
        ...(rule.backend !== undefined ? { backend: rule.backend } : {}),
        tier: rule.tier,
        matchedRule: rule.match,
      };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/__tests__/crew-routing.test.ts`
Expected: PASS (all cases, including the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/crew-routing.ts packages/cli/src/__tests__/crew-routing.test.ts
git commit -m "feat(#774): resolveCrewRoute carries rule backend"
```

### Task 2.2: `resolveBackend` + `assertBackendUsable`

**Files:**
- Create: `packages/core/src/router-resolution.ts`
- Test: `packages/core/src/__tests__/router-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/router-resolution.test.ts
import { describe, it, expect } from "vitest";
import { resolveBackend, assertBackendUsable, shouldBuildRouterService } from "../router-resolution.js";
import type { RouterConfig } from "@squadrant/shared";

const router: RouterConfig = { kind: "opencode-go", baseUrl: "https://opencode.ai/zen/go" };

describe("resolveBackend", () => {
  it("prefers explicit > rule > role > native", () => {
    expect(resolveBackend("direct", "proxy", "native")).toBe("direct");
    expect(resolveBackend(undefined, "proxy", "native")).toBe("proxy");
    expect(resolveBackend(undefined, undefined, "proxy")).toBe("proxy");
    expect(resolveBackend(undefined, undefined, undefined)).toBe("native");
  });
});

describe("assertBackendUsable", () => {
  it("allows native for any agent", () => {
    expect(() => assertBackendUsable({ backend: "native", agent: "opencode", router: undefined })).not.toThrow();
  });
  it("allows direct/proxy for claude when router is configured", () => {
    expect(() => assertBackendUsable({ backend: "proxy", agent: "claude", router })).not.toThrow();
    expect(() => assertBackendUsable({ backend: "direct", agent: "claude", router })).not.toThrow();
  });
  it("rejects direct/proxy on a non-claude agent", () => {
    expect(() => assertBackendUsable({ backend: "proxy", agent: "opencode", router })).toThrow(/claude-only/);
  });
  it("rejects direct/proxy when defaults.router is absent", () => {
    expect(() => assertBackendUsable({ backend: "proxy", agent: "claude", router: undefined })).toThrow(
      /defaults\.router is not configured/,
    );
  });
});

describe("shouldBuildRouterService", () => {
  it("is true only when configured and not under vitest", () => {
    expect(shouldBuildRouterService(router, false)).toBe(true);
    expect(shouldBuildRouterService(router, true)).toBe(false);
    expect(shouldBuildRouterService(undefined, false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/router-resolution.test.ts`
Expected: FAIL — cannot resolve `../router-resolution.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/router-resolution.ts
import type { BackendMode, RouterConfig } from "@squadrant/shared";

/** U2 precedence: explicit flag > routing rule > role default > "native". Pure. */
export function resolveBackend(
  explicit: BackendMode | undefined,
  routeBackend: BackendMode | undefined,
  roleBackend: BackendMode | undefined,
): BackendMode {
  return explicit ?? routeBackend ?? roleBackend ?? "native";
}

/**
 * Reject an unusable backend selection before any spawn work happens:
 *  - `direct`/`proxy` speak the Anthropic Messages seam → claude-only.
 *  - `direct`/`proxy` need an upstream → defaults.router must be configured.
 * `native` is always usable.
 */
export function assertBackendUsable(o: { backend: BackendMode; agent: string; router: RouterConfig | undefined }): void {
  if (o.backend === "native") return;
  if (o.agent !== "claude") {
    throw new Error(`backend '${o.backend}' is claude-only; agent '${o.agent}' must use backend 'native'`);
  }
  if (!o.router) {
    throw new Error(`backend '${o.backend}' selected for agent 'claude' but defaults.router is not configured`);
  }
}

/** Daemon-boot gate: build the router service only when configured, and never under vitest. */
export function shouldBuildRouterService(router: RouterConfig | undefined, isVitest: boolean): boolean {
  return !!router && !isVitest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/__tests__/router-resolution.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Export from core**

In `packages/core/src/index.ts`, after `export * from "./crew-routing.js";`:

```ts
export * from "./router-resolution.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/router-resolution.ts packages/core/src/__tests__/router-resolution.test.ts packages/core/src/index.ts
git commit -m "feat(#774): add backend resolution + claude-only/router-required guard"
```

### Task 2.3: Wire backend + model alias into `runCrewSpawn`

**Files:**
- Modify: `packages/core/src/crew-spawn.ts`
- Test: `packages/core/src/__tests__/crew-spawn.test.ts`

- [ ] **Step 1: Add the failing tests**

Append inside the `describe("routing", …)` block in `packages/core/src/__tests__/crew-spawn.test.ts`:

```ts
    it("applies the rule backend and reports it via onBackendResolved", async () => {
      const config = {
        ...makeConfig(),
        defaults: {
          ...makeConfig().defaults,
          router: { kind: "opencode-go", baseUrl: "https://opencode.ai/zen/go", apiKey: "k" },
          crewRouting: {
            rules: [{ match: "refactor", agent: "claude", tier: "hard", backend: "proxy", model: "flash" }],
          },
        },
      } as unknown as SquadrantConfig;
      const runtime = makeRuntime();
      const agent = makeAgent("claude");
      const deps = makeSpawnDeps(runtime, agent);
      deps.onBackendResolved = vi.fn();

      await runCrewSpawn({ project: PROJECT, task: "refactor the daemon" }, config, deps);

      expect(deps.onBackendResolved).toHaveBeenCalledWith({ backend: "proxy" });
    });

    it("prefers an explicit backend over the rule", async () => {
      const config = {
        ...makeConfig(),
        defaults: {
          ...makeConfig().defaults,
          router: { kind: "opencode-go", baseUrl: "https://opencode.ai/zen/go", apiKey: "k" },
          crewRouting: { rules: [{ match: "refactor", agent: "claude", tier: "hard", backend: "proxy" }] },
        },
      } as unknown as SquadrantConfig;
      const runtime = makeRuntime();
      const agent = makeAgent("claude");
      const deps = makeSpawnDeps(runtime, agent);
      deps.onBackendResolved = vi.fn();

      await runCrewSpawn({ project: PROJECT, task: "refactor the daemon", backend: "native" }, config, deps);

      expect(deps.onBackendResolved).toHaveBeenCalledWith({ backend: "native" });
    });

    it("throws when a proxy backend is selected without defaults.router", async () => {
      const config = {
        ...makeConfig(),
        defaults: {
          ...makeConfig().defaults,
          crewRouting: { rules: [{ match: "refactor", agent: "claude", tier: "hard", backend: "proxy" }] },
        },
      } as unknown as SquadrantConfig;
      const runtime = makeRuntime();
      const deps = makeSpawnDeps(runtime, makeAgent("claude"));

      await expect(
        runCrewSpawn({ project: PROJECT, task: "refactor the daemon" }, config, deps),
      ).rejects.toThrow(/defaults\.router is not configured/);
    });

    it("expands a model alias for the resolved agent", async () => {
      const config = {
        ...makeConfig(),
        defaults: {
          ...makeConfig().defaults,
          router: {
            kind: "opencode-go",
            baseUrl: "https://opencode.ai/zen/go",
            apiKey: "k",
            models: { flash: { upstream: "deepseek-v4.1-flash", agents: { opencode: "opencode-go/deepseek-v4.1-flash" } } },
          },
          crewRouting: { rules: [{ match: "daemon", agent: "opencode", tier: "standard", model: "flash" }] },
        },
      } as unknown as SquadrantConfig;
      const runtime = makeRuntime();
      const agent = makeAgent("opencode");
      const deps = makeSpawnDeps(runtime, agent);
      deps.resolveAgent = vi.fn().mockReturnValue(agent);

      await runCrewSpawn({ project: PROJECT, task: "fix daemon bug" }, config, deps);

      expect(agent.buildCommand).toHaveBeenCalledWith(
        expect.objectContaining({ model: "opencode-go/deepseek-v4.1-flash" }),
      );
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/src/__tests__/crew-spawn.test.ts -t routing`
Expected: FAIL — `onBackendResolved` is not called; the proxy-no-router case does not throw; the alias is not expanded.

- [ ] **Step 3: Add `backend` to `CrewSpawnInput`**

In `packages/core/src/crew-spawn.ts`, after the `model?: string;` field in `CrewSpawnInput`:

```ts
  /** U2 backend override for this spawn — takes precedence over rule/role. */
  backend?: BackendMode;
```

Change the imports at the top of `crew-spawn.ts` to include the new names. The existing `import type { … } from "@squadrant/shared";` should add `BackendMode`; and add a runtime import:

```ts
import { resolveRouterModel } from "@squadrant/shared";
import { resolveBackend, assertBackendUsable } from "./router-resolution.js";
```

- [ ] **Step 4: Add `onBackendResolved` to `CrewSpawnDeps`**

After `onModelResolved?(…)` in `CrewSpawnDeps`:

```ts
  /** Optional: called once the effective backend is resolved (before spawn). */
  onBackendResolved?(o: { backend: BackendMode }): void;
```

- [ ] **Step 5: Resolve + assert backend after routing**

`agentName` is declared at `crew-spawn.ts:417` and `agent`/`agentName` are both in scope after
`const agent = deps.resolveAgent(agentName);` (line 418). Insert the block **after line 418 and
before the `if (agentName === "codex")` early-return (line 427)** — not before line 417, or
`agentName` is used before declaration (TS2448).

Use a distinct name (`roleBackend`); the pre-existing `const crewRole = config.defaults.roles?.crew;`
further down (~line 456) must not be redeclared. `roles.crew.backend` applies **only when the role's
agent matches the resolved agent** — the same guard the model path uses at line 457 — so a
non-claude routing rule does not inherit a claude-only role backend:

```ts
  const crewRoleCfg = config.defaults.roles?.crew;
  const roleBackend = crewRoleCfg && crewRoleCfg.agent === agent.name ? crewRoleCfg.backend : undefined;
  const backend = resolveBackend(input.backend, route?.backend, roleBackend);
  assertBackendUsable({ backend, agent: agent.name, router: config.defaults.router });
  deps.onBackendResolved?.({ backend });
```

(`deps.onBackendResolved` fires for every agent/backend, including `native` — the CLI decides
whether to print it.)

- [ ] **Step 6: Expand the model alias (router backends only)**

Replace the existing `const crewModel = input.model ?? route?.model ?? configModel;` line (currently ~line 458) with:

```ts
  const rawModel = input.model ?? route?.model ?? configModel;
  const crewModel = backend === "native"
    ? rawModel
    : resolveRouterModel(rawModel, agent.name, config.defaults.router);
```

Alias expansion is gated on a router backend: a native spawn must keep whatever literal id the
operator configured (e.g. an opencode `provider/model`), never an upstream-specific alias target.

(Leave the pre-existing `const crewRole` and `configModel` lines above it untouched.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/crew-spawn.test.ts -t routing`
Expected: PASS (existing + 4 new routing cases).

- [ ] **Step 8: Run the full crew-spawn suite + typecheck**

Run: `pnpm vitest run packages/core/src/__tests__/crew-spawn.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/crew-spawn.ts packages/core/src/__tests__/crew-spawn.test.ts
git commit -m "feat(#774): resolve+assert backend and expand model alias at spawn"
```

### Task 2.4: `--backend` CLI flag

**Files:**
- Modify: `packages/cli/src/commands/crew.ts` (spawn option/action ~182-233; CLI wrapper deps ~73)

- [ ] **Step 1: Add the option**

After the `--thinking` option (currently line 196):

```ts
  .option("--backend <mode>", "Backend seam for this spawn: native|direct|proxy (claude only); takes precedence over rule/role")
```

- [ ] **Step 2: Validate + forward it in the action**

The spawn action signature (currently lines 198-202) must gain `backend` in its opts type:

```ts
      opts: { name?: string; direction: PanePlacement; agent: string; approval: boolean; shared: boolean; taskFile?: string; model?: string; thinking?: string; backend?: string },
```

In the action body, add:

```ts
        const rawBackend = opts.backend;
        if (rawBackend !== undefined && !isBackendMode(rawBackend)) {
          throw new Error(`Invalid --backend '${rawBackend}'. Valid values: native, direct, proxy`);
        }
```

and include `backend: rawBackend as BackendMode | undefined,` in the `runCrewSpawn({ … })` input object.

Add to the imports from `@squadrant/shared` at the top of `crew.ts`: `isBackendMode`, `type BackendMode`.

- [ ] **Step 3: Print the resolved backend**

In the CLI wrapper `runCrewSpawn` in `packages/cli/src/commands/crew.ts`, add a dep next to `onModelResolved`:

```ts
    onBackendResolved: ({ backend }) => {
      if (backend !== "native") console.log(chalk.dim(`backend: ${backend}`));
    },
```

- [ ] **Step 4: Typecheck + manual help check**

Run: `pnpm lint && node packages/cli/dist/index.js crew spawn --help 2>/dev/null | grep -A1 -- --backend`
Expected: typecheck PASS; help lists `--backend <mode>`. (If `dist/` is stale, run `pnpm build` first.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/crew.ts
git commit -m "feat(#774): add --backend flag to crew spawn"
```

---

## Phase 3 — Validation & daemon keys (`@squadrant/shared`)

### Task 3.1: Drift `invalid` checks

**Files:**
- Modify: `packages/shared/src/lib/config-drift.ts`
- Test: `packages/shared/src/lib/__tests__/config-drift.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("detectDrift — invalid", …)` in `packages/shared/src/lib/__tests__/config-drift.test.ts`:

```ts
  it("flags an unknown router kind", () => {
    const u = userConfig();
    (u.defaults as any).router = { kind: "bogus", baseUrl: "https://x.test" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.router.kind")).toBe(true);
  });

  it("flags both apiKey and apiKeyEnv set", () => {
    const u = userConfig();
    (u.defaults as any).router = { kind: "opencode-go", baseUrl: "https://x.test", apiKey: "k", apiKeyEnv: "K" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.router.apiKey")).toBe(true);
  });

  it("flags a non-claude role backend", () => {
    const u = userConfig();
    (u.defaults.roles as any).crew = { agent: "opencode", backend: "proxy" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.roles.crew.backend")).toBe(true);
  });

  it("flags a router backend selected with no defaults.router", () => {
    const u = userConfig();
    (u.defaults.roles as any).crew = { agent: "claude", backend: "proxy" };
    delete (u.defaults as any).router;
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.roles.crew.backend")).toBe(true);
  });

  it("does NOT flag defaults.router as missing drift", () => {
    const u = userConfig();
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.path.startsWith("defaults.router"))).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/shared/src/lib/__tests__/config-drift.test.ts`
Expected: FAIL — none of the router invalid items are produced (the last test likely passes already).

- [ ] **Step 3: Implement the checks in `detectDrift`**

Add to the imports at the top of `config-drift.ts`:

```ts
import { isBackendMode, isRouterKind, type RouterConfig, type BackendMode } from "../config.js";
```

Immediately before `return items;` at the end of `detectDrift`, add:

```ts
  // ── U2 router validation ────────────────────────────────────────────────
  const router = user.defaults?.router as RouterConfig | undefined;
  if (router) {
    if (typeof router.kind === "string" && !isRouterKind(router.kind)) {
      items.push({ path: "defaults.router.kind", kind: "invalid", severity: "warn", current: router.kind, note: "unknown router kind" });
    }
    try {
      // eslint-disable-next-line no-new
      new URL(router.baseUrl);
    } catch {
      items.push({ path: "defaults.router.baseUrl", kind: "invalid", severity: "warn", current: router.baseUrl, note: "not an absolute URL" });
    }
    if (router.port !== undefined && (!Number.isInteger(router.port) || router.port < 0 || router.port > 65535)) {
      items.push({ path: "defaults.router.port", kind: "invalid", severity: "warn", current: router.port, note: "port must be an integer 0..65535" });
    }
    if (router.apiKey !== undefined && router.apiKeyEnv !== undefined) {
      items.push({ path: "defaults.router.apiKey", kind: "invalid", severity: "warn", note: "apiKey and apiKeyEnv are mutually exclusive" });
    }
    for (const [alias, a] of Object.entries(router.models ?? {})) {
      for (const agentName of Object.keys(a.agents ?? {})) {
        if (!(agentName in agents)) {
          items.push({ path: `defaults.router.models.${alias}.agents.${agentName}`, kind: "invalid", severity: "warn", current: agentName, note: "unknown agent in model alias" });
        }
      }
    }
  }

  const checkBackend = (path: string, backend: BackendMode | undefined, agentName: string | undefined) => {
    if (backend === undefined) return;
    if (!isBackendMode(backend)) {
      items.push({ path, kind: "invalid", severity: "warn", current: backend, note: "unknown backend; expected native|direct|proxy" });
      return;
    }
    if (backend !== "native") {
      if (agentName !== "claude") {
        items.push({ path, kind: "invalid", severity: "warn", current: backend, note: `backend '${backend}' is claude-only (agent '${agentName ?? "?"}')` });
      } else if (!router) {
        items.push({ path, kind: "invalid", severity: "warn", current: backend, note: `backend '${backend}' requires defaults.router` });
      }
    }
  };

  for (const [role, asn] of Object.entries((user.defaults?.roles ?? {}) as Record<string, { agent?: string; backend?: BackendMode }>)) {
    checkBackend(`defaults.roles.${role}.backend`, asn?.backend, asn?.agent);
  }
  const rules = (user.defaults?.crewRouting?.rules ?? []) as Array<{ agent?: string; backend?: BackendMode }>;
  rules.forEach((rule, i) => checkBackend(`defaults.crewRouting.rules.${i}.backend`, rule.backend, rule.agent));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/shared/src/lib/__tests__/config-drift.test.ts`
Expected: PASS (all existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/lib/config-drift.ts packages/shared/src/lib/__tests__/config-drift.test.ts
git commit -m "feat(#774): validate router config + backend selections in config check"
```

### Task 3.2: Router changes restart the daemon

**Files:**
- Modify: `packages/shared/src/daemon-keys.ts`
- Test: `packages/shared/src/__tests__/daemon-keys.test.ts`

- [ ] **Step 1: Add the assertion**

In `packages/shared/src/__tests__/daemon-keys.test.ts`, add `"defaults.router"` and
`"defaults.router.baseUrl"` to the **first** loop — the `it("flags daemon-cached keys")` list at
lines 6-12 — which asserts `isDaemonCachedKey(k)` is `true`:

```ts
      "defaults.taskTimeoutMs",
      "defaults.cmuxEventsBridge",
      "defaults.router",
      "defaults.router.baseUrl",
      "projects.brove",
```

Then add a case:

```ts
  it("treats defaults.router as daemon-cached (config set restarts the daemon)", () => {
    expect(isDaemonCachedKey("defaults.router")).toBe(true);
    expect(isDaemonCachedKey("defaults.router.baseUrl")).toBe(true);
  });
```

Do **not** touch the `it("ignores fresh-read keys")` loop (lines 17-25) — `defaults.effort`,
`defaults.crewRouting.rules`, and `models.crew` are correctly fresh-read and stay `false`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/daemon-keys.test.ts`
Expected: FAIL — `isDaemonCachedKey("defaults.router")` is false (`defaults.router` is not yet in
`DAEMON_CACHED_PREFIXES`; `daemon-keys.ts` has no `crewRouting` prefix).

- [ ] **Step 3: Add the prefix**

In `packages/shared/src/daemon-keys.ts`, add to `DAEMON_CACHED_PREFIXES`:

```ts
  "defaults.router",
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/daemon-keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/daemon-keys.ts packages/shared/src/__tests__/daemon-keys.test.ts
git commit -m "feat(#774): restart daemon on defaults.router change"
```

---

## Phase 4 — Daemon router service

### Task 4.1: `createRouterService`

**Files:**
- Create: `packages/core/src/router/service.ts`
- Modify: `packages/core/src/router/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/router/__tests__/service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/router/__tests__/service.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { resolveRouterUpstream, createRouterService, type RouterService } from "../service.js";
import type { RouterConfig } from "@squadrant/shared";

async function mockUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

describe("resolveRouterUpstream", () => {
  it("defaults authHeader by kind and resolves apiKeyEnv", () => {
    const go = resolveRouterUpstream({ kind: "opencode-go", baseUrl: "https://go.test", apiKeyEnv: "K" }, { K: "secret" } as NodeJS.ProcessEnv);
    expect(go).toMatchObject({ baseUrl: "https://go.test", apiKey: "secret", authHeader: "x-api-key", isAnthropic: false });

    const or = resolveRouterUpstream({ kind: "openrouter", baseUrl: "https://or.test", apiKey: "plain" }, {} as NodeJS.ProcessEnv);
    expect(or).toMatchObject({ apiKey: "plain", authHeader: "Authorization" });
  });

  it("honours an explicit isAnthropic", () => {
    const u = resolveRouterUpstream({ kind: "custom", baseUrl: "https://a.test", apiKey: "k", isAnthropic: true }, {} as NodeJS.ProcessEnv);
    expect(u.isAnthropic).toBe(true);
  });
});

describe("createRouterService", () => {
  let upstream: { url: string; close: () => Promise<void> } | null = null;
  let service: RouterService | null = null;
  afterEach(async () => { await service?.stop(); service = null; await upstream?.close(); upstream = null; });

  it("proxy credentials carry the loopback url + a per-project token", async () => {
    upstream = await mockUpstream();
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: upstream.url, apiKey: "k" };
    service = createRouterService(cfg, ["proj-a", "proj-b"]);
    await service.start();
    const a = service.credentialsFor("proj-a", "proxy");
    const b = service.credentialsFor("proj-b", "proxy");
    expect(a.backend).toBe("proxy");
    expect(a.baseUrl).toContain("127.0.0.1");
    expect(a.token).toBeTruthy();
    expect(a.token).not.toBe(b.token);
  });

  it("direct credentials carry the upstream url, apiKey, and extraHeaders", () => {
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: "https://go.test", apiKey: "k", extraHeaders: { "x-opencode-session": "squadrant" } };
    service = createRouterService(cfg, ["proj-a"]);
    const d = service.credentialsFor("proj-a", "direct");
    expect(d).toEqual({ backend: "direct", baseUrl: "https://go.test", apiKey: "k", extraHeaders: { "x-opencode-session": "squadrant" } });
  });

  it("throws for proxy credentials before start (url port is still 0)", () => {
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: "https://go.test", apiKey: "k" };
    service = createRouterService(cfg, ["proj-a"]);
    expect(() => service!.credentialsFor("proj-a", "proxy")).toThrow(/not started/);
  });

  it("throws when no credential is configured", () => {
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: "https://go.test" };
    service = createRouterService(cfg, ["proj-a"]);
    expect(() => service!.credentialsFor("proj-a", "direct")).toThrow(/credential is missing/);
  });

  it("throws for a project with no minted token", async () => {
    upstream = await mockUpstream();
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: upstream.url, apiKey: "k" };
    service = createRouterService(cfg, ["proj-a"]);
    await service.start();
    expect(() => service!.credentialsFor("proj-zzz", "proxy")).toThrow(/no token for project 'proj-zzz'/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/service.test.ts`
Expected: FAIL — cannot resolve `../service.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/router/service.ts
import type { RouterConfig } from "@squadrant/shared";
import { mintToken } from "./auth.js";
import { createRouterShim } from "./shim.js";
import type { RouterHealth, RouterShim, RouterUpstream } from "./types.js";

export interface RouterCredentials {
  backend: "direct" | "proxy";
  baseUrl: string;
  /** proxy: daemon-minted per-project bearer token. */
  token?: string;
  /** direct: the upstream credential (no shim to swap auth). */
  apiKey?: string;
  /** direct: static headers to place in ANTHROPIC_CUSTOM_HEADERS. */
  extraHeaders?: Record<string, string>;
}

export interface RouterService {
  start(): Promise<void>;
  stop(): Promise<void>;
  url(): string;
  health(): Promise<RouterHealth>;
  credentialsFor(project: string, backend: "direct" | "proxy"): RouterCredentials;
}

/** Map the config block to the shim's input shape, deriving kind-based defaults. */
export function resolveRouterUpstream(router: RouterConfig, env: NodeJS.ProcessEnv = process.env): RouterUpstream {
  const credential = router.apiKey ?? (router.apiKeyEnv ? env[router.apiKeyEnv] : undefined) ?? "";
  const authHeader = router.authHeader ?? (router.kind === "opencode-go" ? "x-api-key" : "Authorization");
  return {
    baseUrl: router.baseUrl,
    apiKey: credential,
    authHeader,
    extraHeaders: router.extraHeaders,
    isAnthropic: router.isAnthropic ?? false,
  };
}

/**
 * Daemon-internal router service. Construct only when defaults.router exists.
 * Mints one token per project for the shim and exposes spawn-time credentials.
 */
export function createRouterService(
  router: RouterConfig,
  projects: string[],
  deps: { log?: (m: string) => void; fetch?: typeof fetch } = {},
): RouterService {
  const log = deps.log ?? (() => {});
  const upstream = resolveRouterUpstream(router);
  if (!upstream.apiKey) {
    log("router: no credential configured (set defaults.router.apiKey or apiKeyEnv) — routed spawns will fail");
  }

  const tokenByProject = new Map<string, string>();
  const projectTokens = new Map<string, string>();
  for (const p of projects) {
    const t = mintToken();
    tokenByProject.set(p, t);
    projectTokens.set(t, p);
  }

  const shim: RouterShim = createRouterShim({
    upstream,
    projectTokens,
    port: router.port ?? 0,
    log,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  let started = false;

  return {
    async start() {
      await shim.start();
      started = true;
    },
    async stop() {
      await shim.stop();
      started = false;
    },
    url: () => shim.url(),
    health: () => shim.health(),
    credentialsFor(project, backend) {
      if (!upstream.apiKey) {
        throw new Error("defaults.router credential is missing (set apiKey or apiKeyEnv)");
      }
      if (backend === "direct") {
        return { backend, baseUrl: router.baseUrl, apiKey: upstream.apiKey, extraHeaders: upstream.extraHeaders };
      }
      if (!started) {
        throw new Error("router service not started");
      }
      const token = tokenByProject.get(project);
      if (!token) {
        throw new Error(`router service has no token for project '${project}'`);
      }
      return { backend, baseUrl: shim.url(), token };
    },
  };
}
```

Note: `types.ts` exports `RouterHealth`, `RouterShim`, and `RouterUpstream`; `shim.ts` exports `createRouterShim` and re-exports `RouterShim`. Import the three types from `./types.js` as shown.

- [ ] **Step 4: Export it**

In `packages/core/src/router/index.ts`, add:

```ts
export * from "./service.js";
```

`packages/core/src/index.ts` **already** has `export * from "./router/index.js";` on `develop`
(verified at `origin/develop:packages/core/src/index.ts:28`, post-#780). Confirm it is present.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/service.test.ts && pnpm lint`
Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/router/service.ts packages/core/src/router/index.ts packages/core/src/index.ts packages/core/src/router/__tests__/service.test.ts
git commit -m "feat(#774): add daemon router service (upstream mapping + per-project tokens)"
```

### Task 4.2: Wire the service into the daemon host

**Files:**
- Modify: `packages/core/src/daemon/context.ts`
- Modify: `packages/core/src/daemon/start.ts`
- Modify: `packages/cli/src/squadrantd.ts`

- [ ] **Step 1: Add the context/opts field**

In `packages/core/src/daemon/context.ts`, add an import:

```ts
import type { RouterService } from "../router/service.js";
```

Add to `SquadrantdOpts` (near `telegramBridge`):

```ts
  /** Inject a fake router service for tests. */
  routerService?: RouterService;
```

Add to `DaemonContext` (near its `telegramBridge`):

```ts
  routerService?: RouterService;
```

Add `routerService: undefined,` to the default context object (where `telegramBridge: undefined` is set).

- [ ] **Step 2: Start it in `start.ts`**

In `packages/core/src/daemon/start.ts`, right after the Telegram start block (`if (ctx.telegramBridge) { … ctx.telegramBridge.start(); … }`):

```ts
    // Router shim (opt-in #774). Constructed by the host only when config.router
    // is present; starting it is best-effort — a bind failure must not take the
    // daemon down.
    if (ctx.routerService) {
      void ctx.routerService.start()
        .then(() => log(`router: listening ${ctx.routerService!.url()}`))
        .catch((e) => log(`router service start failed: ${(e as Error).message}`));
    }
```

In the shutdown path, next to `try { ctx.telegramBridge?.stop(); } catch { /* best-effort */ }`:

```ts
      try { await ctx.routerService?.stop(); } catch { /* best-effort */ }
```

- [ ] **Step 3: Construct it in `squadrantd.ts`**

Add to the `@squadrant/core` import list: `createRouterService`, and to the `@squadrant/shared` import list: `type RouterConfig`. Then, after the Telegram bridge construction block (currently ending around line 273), add:

```ts
  // ── Router shim (opt-in #774) ─────────────────────────────────────────────
  // Built only when config.router exists. Skipped under vitest (tests inject
  // opts.routerService); absent config ⇒ undefined ⇒ zero behavior change.
  const routerCfg = loadConfig().defaults.router;
  ctx.routerService = opts.routerService
    ?? (shouldBuildRouterService(routerCfg, !!process.env.VITEST) && routerCfg
      ? createRouterService(routerCfg, Object.keys(loadConfig().projects), { log })
      : undefined);
```

Import `shouldBuildRouterService` from `@squadrant/core` as well.

- [ ] **Step 4: Typecheck**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 5: Run the gating test**

Run: `pnpm vitest run packages/core/src/__tests__/router-resolution.test.ts`
Expected: PASS — the `shouldBuildRouterService` cases added in Task 2.2 cover the boot gate deterministically. The host-level `startDaemon` wiring (that an injected `routerService` is started/stopped) is exercised end-to-end by U3, which is the first consumer of `credentialsFor`.

Note on readiness: the host start is fire-and-forget (below), so `RouterService.start()` may not have
resolved when a spawn asks for credentials. `credentialsFor("proxy")` throws `router service not
started` until it does; **U3 owns waiting on `health()` before injecting env.** Do not add a spawn
gate here.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/daemon/context.ts packages/core/src/daemon/start.ts packages/cli/src/squadrantd.ts
git commit -m "feat(#774): construct + start the router service when config.router is set"
```

---

## Phase 5 — Skill documentation

### Task 5.1: Update `add-pick-crew-rule`

**Files:**
- Modify: `plugin/skills/add-pick-crew-rule/SKILL.md`

- [ ] **Step 1: Update the rule shape**

Replace the shape block (lines 11-18) with:

````markdown
```jsonc
{
  "tier":  "<label>",      // human label, e.g. "extreme" / "hard" / "daily"
  "match": "<regex>",      // case-insensitive regex tested against the task text
  "agent": "claude|codex|gemini|opencode",
  "model": "opus|sonnet|flash|<literal upstream id>",  // a squadrant alias or a literal
  "backend": "native|direct|proxy"   // optional; claude-only for direct/proxy
}
```
````

- [ ] **Step 2: Add the backend/alias notes**

After the "Rules are evaluated in order; the **first match wins**." line, add:

```markdown
`backend` is meaningful only for `agent: "claude"`:
- `native` (default) — the CLI's own auth; no router needed.
- `direct` — point Claude at `defaults.router.baseUrl` directly.
- `proxy` — point Claude at the squadrant loopback shim.

A rule with `backend: "direct"` or `"proxy"` **requires `defaults.router`** to be configured;
otherwise the spawn fails with a hard error and `squadrant config check` flags it.

`model` may be either a **squadrant alias** (defined in `defaults.router.models`) or a literal
upstream id. An alias expands per agent — e.g. `flash` →
`deepseek-v4.1-flash` for claude, `opencode-go/deepseek-v4.1-flash` for opencode. A value that is
not a defined alias is used verbatim, so existing configs keep working.
```

- [ ] **Step 3: Update the precedence section**

Replace the "Precedence reminder" bullet list with:

```markdown
## Precedence reminder

- Explicit `--agent` / `--model` / `--backend` on `squadrant crew spawn` **always** override routing.
- `backend` precedence: `--backend` > rule `backend` > `defaults.roles.<role>.backend` > `native`.
- Passing `--agent` or `--model` suppresses the rule entirely (including its `backend`).
- If no rule matches, the spawn falls through to `defaults.roles.crew` behavior.
```

- [ ] **Step 4: Commit**

```bash
git add plugin/skills/add-pick-crew-rule/SKILL.md
git commit -m "docs(#774): document backend + model aliases in add-pick-crew-rule"
```

---

## Self-review notes (executor must keep)

- **Branch base:** `develop` (U1/#780 already merged). Run `git ls-files packages/core/src/router | head` to confirm before Task 1.
- **`roleBackend` naming:** Task 2.3 Step 5 uses `roleBackend` deliberately so the pre-existing `const crewRole = config.defaults.roles?.crew;` (~line 456) is not redeclared. Do not reuse `crewRole` there.
- **`BackendMode` provenance:** `@squadrant/core` re-exports it from `@squadrant/shared` (Task 1.3). Do not add a second declaration.
- **No `router-credentials` wire protocol:** `RouterService.credentialsFor` is in-process only. U3 decides how the CLI reaches it.
- **No `{project}` templating:** `extraHeaders` are static in v1 (spec decision).
- **`shouldBuildRouterService`** lives in core (Task 2.2) so the daemon boot gate is unit-testable without standing up `startDaemon`.
- **Role backend is agent-gated** (Task 2.3 Step 5): `roles.crew.backend` applies only when `roles.crew.agent === agent.name`, mirroring the model guard. Only `roles.crew` is consumed in U2 (spec decision 2).
- **Readiness is U3's** (Task 4.2 note): `credentialsFor("proxy")` throws until `start()` resolves; the spawn path must wait on `health()`.
- Spec coverage: schema (Phase 1), placement + upstream scope (Phase 1), model aliasing (Tasks 1.2/2.3), precedence + native-vs-router (Tasks 2.2/2.3), validation + skill (Phases 3/5), backward-compat (no backfill anywhere; gate checks only run when config present), daemon wiring (Phase 4).
