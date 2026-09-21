# Provider-agnostic auto permission gate (`@squadrant-ai/auto-gate`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone, provider-agnostic permission gate described in the #828 design, in phases that each produce working, testable software.

**Architecture:** A standalone npm package (`@squadrant-ai/auto-gate`, own repo — §16.1) exposing a bin consumed by any agent and by squadrant. The core is a **classifier → assessment → policy engine → outcome** pipeline: a classifier (Jev, or a generative fallback) returns an *assessment*; a pure policy engine applies thresholds and owns the allow/deny/ask decision; a cache and an audit log wrap it. Per-agent adapters (claude `PermissionRequest` hook; opencode SSE subscriber) translate native events into one `GateRequest` and map the outcome back.

**Tech Stack:** TypeScript (ESM), vitest, node ≥ 20. Plain `fetch` (no SDK). No runtime dependency on squadrant.

**Spec:** [`docs/specs/2026-09-20-provider-agnostic-auto-gate-design.md`](../specs/2026-09-20-provider-agnostic-auto-gate-design.md) — with **PR #832** (§15 resolutions) as the normative version. **This plan assumes #832 is merged first.**

**Prerequisite (DONE 2026-09-21):** the standalone repo exists — **`Squadrant-AI/auto-gate`** (private), cloned to **`~/me/auto-gate`**, default branch `main`, and registered with squadrant as project `auto-gate`. File paths below are relative to that repo root, not the squadrant monorepo.

**Naming (resolved):** GitHub org `Squadrant-AI`; **npm org must be created as `squadrant` (lowercase)** so the package name `@squadrant-ai/auto-gate` is publishable — npm scopes are lowercase and independent of the GitHub org name (`Squadrant-AI` would give `@squadrant-ai/*`). Publish is **deferred** until that scope exists; nothing in P1 needs it.

---

## Why this is split into phases

The spec covers several subsystems that are independently shippable. Per the planning skill's scope check, one plan per subsystem:

| Phase | Subsystem | Spec | Shippable/testable on its own? |
|---|---|---|---|
| **P0** | Repo + toolchain bootstrap | §3 | — |
| **P1** | **Core: types, Tier-1, policy engine, cache, scope** (no I/O) | §5, §7, §8, §9, §10, §15#6 | ✅ pure, fully unit-testable |
| **P2** | Classifiers: Jev client + generative fallback + null | §6, §2.1 | ✅ mockable transport |
| **P3** | Config chain, audit, CLI (`decide`/`test`/`stats`/`doctor`) | §12, §9, §11 | ✅ `auto-gate test` drives P1+P2 end-to-end |
| **P4** | claude adapter + install/uninstall + ownership | §11 claude, §15#5 | ✅ hook contract tests (U7 preserved) |
| **P5** | opencode adapter: port, supervision, userIntent, onAsk, single-owner | §11 opencode, §15#1–#4, #7 | ✅ two-server integration test |
| **P6** | squadrant integration (consume the package; foreign-hook removal) | §3, §15#5, AGENTS.md | ✅ monorepo tests |

**This document details P1 only.** P2–P6 get their own plan documents once P1 lands (their designs depend on P1's types settling).

---

## P1 file structure

| File | Responsibility |
|---|---|
| `src/core/types.ts` | `GateRequest`, `GateAssessment`, `GateOutcome`, `ClassifierVerdict`, `PolicyConfig`, `ToolAliases` |
| `src/core/tools.ts` | Set-valued alias resolution + scope matching (§15#6) |
| `src/core/tier1.ts` | Pure, model-free static deny (~0 ms) |
| `src/core/policy.ts` | The §7 rules: deny / generative-fallback / allow / ask catch-all |
| `src/core/policy-version.ts` | `policyVersion` = sha256 of the resolved policy (§7) |
| `src/core/cache.ts` | §9 key, TTL/max, atomic 0600 write |
| `src/core/scope.ts` | §10 positive session markers → `yield` when not ours |
| `src/index.ts` | Public barrel |

**Explicitly NOT in P1:** any network call, any file-system side effect outside `cache.ts`, any agent adapter, any CLI. P1 is a pure library.

---

## Task 0: Repo + baseline (Phase 0)

**Files:** none (repo bootstrap)

- [ ] **Step 1: Confirm the repo + baseline** (the repo already exists — do NOT re-create it)

```bash
cd ~/me/auto-gate
git remote -v   # expect: git@github.com:Squadrant-AI/auto-gate.git
git log --oneline -1   # expect: 99d7689 Initial commit
pnpm init
```

The initial commit contains only `README.md` (GitHub-generated).

- [ ] **Step 2: Toolchain + baseline green**

Add TypeScript + vitest + `"type": "module"`, a `tsconfig.json` targeting `ES2022`/`NodeNext`, and scripts `build`/`test`. Create a trivial `src/index.ts` and one passing test.

Run: `pnpm install && pnpm build && pnpm test`
Expected: build clean; 1 test passing. **Record the passing count** — later tasks diff against it.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: bootstrap @squadrant-ai/auto-gate (typescript + vitest)"
```

---

## Task 1: Core types + tool-scope resolution

**Files:**
- Create: `src/core/types.ts`, `src/core/tools.ts`
- Test: `src/core/__tests__/tools.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { canonicalNames, isInScope } from "../tools.js";

const ALIASES = { opencode: { bash: ["Bash"], edit: ["Edit", "Write", "MultiEdit"] } };

describe("tool-scope resolution (#15#6)", () => {
  it("maps a native name to its canonical set", () => {
    expect(canonicalNames("opencode", "edit", ALIASES)).toEqual(["Edit", "Write", "MultiEdit"]);
  });

  it("an unmapped native name yields no canonical names (out of scope)", () => {
    expect(canonicalNames("opencode", "webfetch", ALIASES)).toEqual([]);
  });

  it("claude names are their own canonical (identity)", () => {
    expect(canonicalNames("claude", "Bash", ALIASES)).toEqual(["Bash"]);
  });

  it("scopes on ANY canonical name in the set", () => {
    // opencode `edit` covers write ⇒ ["Write"] alone must put it in scope
    expect(isInScope("opencode", "edit", ALIASES, ["Write"])).toBe(true);
    expect(isInScope("opencode", "edit", ALIASES, ["Bash"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '../tools.js'`)

Run: `pnpm test src/core/__tests__/tools.test.ts`

- [ ] **Step 3: Implement `src/core/types.ts`**

```ts
export type ClassifierVerdict = "allow" | "deny" | "ask";
export type GateOutcomeDecision = "allow" | "deny" | "ask" | "yield";
export type IntentSupport = "available" | "pending" | "unsupported";

/** native tool name → set of canonical (claude-shaped) names */
export type ToolAliases = Record<string, Record<string, string[]>>;

export interface GateRequest {
  agent: string;
  toolName: string;
  toolPayload: string;
  cwd: string;
  userIntent?: string | null;
  intentSupport: IntentSupport;
  permissionMode?: string;
  sessionKind: "crew" | "side" | "captain" | "standalone";
  raw?: unknown;
}

export interface GateAssessment {
  verdict: ClassifierVerdict;
  confidence?: number;
  probabilities?: Record<string, number>;
  hazards?: Record<string, number>;
  severity?: number;
  classifier: string;
  tier: 2;
  usage?: { inputTokens?: number };
}

export interface GateOutcome {
  decision: GateOutcomeDecision;
  tier: 1 | 2;
  reason: string;
  cached?: boolean;
}

export interface PolicyConfig {
  name: "strict" | "balanced" | "permissive";
  reviewThreshold: number;
  actionThreshold: number;
  allowThreshold: number;
  denyThreshold: number;
  minConfidence: number;
  intentThreshold: number;
  reviewSeverity: number;
  severityBlock: number;
  fallbackAcceptsVerdict: boolean;
  hazards: {
    destructive: { review: number; action: number; vetoesAllow: boolean };
    secrets: { review: number; action: number; vetoesAllow: boolean };
    scope_escape: { review: number; action: number; vetoesAllow: boolean };
    intent_match: { allowFloor: number; vetoesAllow: boolean };
  };
  tools: string[];
}
```

- [ ] **Step 4: Implement `src/core/tools.ts`**

```ts
import type { ToolAliases } from "./types.js";

const CLAUDE_CANONICAL = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Canonical names for a native tool name. Empty ⇒ unmapped ⇒ out of scope. */
export function canonicalNames(agent: string, nativeName: string, aliases: ToolAliases): string[] {
  const perAgent = aliases[agent];
  if (perAgent) {
    const mapped = perAgent[nativeName];
    if (mapped) return mapped;
    // A claude-shaped name passed through an aliased agent still matches.
    if (CLAUDE_CANONICAL.has(nativeName)) return [nativeName];
    return [];
  }
  // No alias table for this agent: claude-shaped names are canonical; others out of scope.
  return CLAUDE_CANONICAL.has(nativeName) ? [nativeName] : [];
}

/** Scope match: ANY canonical name in the set is in scope (§15#6, any-of). */
export function isInScope(
  agent: string,
  nativeName: string,
  aliases: ToolAliases,
  tools: string[],
): boolean {
  const canon = canonicalNames(agent, nativeName, aliases);
  return canon.some((c) => tools.includes(c));
}
```

- [ ] **Step 5: Run tests — expect PASS.** Then commit.

```bash
git add src/core/types.ts src/core/tools.ts src/core/__tests__/tools.test.ts
git commit -m "feat(core): types + set-valued tool-scope resolution (#15#6)"
```

---

## Task 2: Tier-1 static deny

**Files:**
- Create: `src/core/tier1.ts`
- Test: `src/core/__tests__/tier1.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { matchesTier1Deny, DEFAULT_TIER1_DENY } from "../tier1.js";

describe("tier-1 static deny", () => {
  it("matches the built-in sudo rule", () => {
    expect(matchesTier1Deny("sudo rm -rf /", DEFAULT_TIER1_DENY)).toBe(true);
  });
  it("matches rm -rf / and its flag-orders (regression: -fr slipped through)", () => {
    for (const c of ["rm -rf /", "rm -fr /", "rm -r -f /", "rm --recursive --force /"]) {
      expect(matchesTier1Deny(c, DEFAULT_TIER1_DENY), c).toBe(true);
    }
  });
  it("is order-agnostic for flag clusters", () => {
    expect(matchesTier1Deny("rm -Rf /", DEFAULT_TIER1_DENY)).toBe(true);
  });
  it("does NOT match ordinary work", () => {
    for (const c of ["ls -la", "rm -rf ./dist", "git commit -m x", "npm test"]) {
      expect(matchesTier1Deny(c, DEFAULT_TIER1_DENY), c).toBe(false);
    }
  });
  it("an operator-supplied list REPLACES the built-in set", () => {
    expect(matchesTier1Deny("sudo ls", [/^\s*apt\b/])).toBe(false);
  });
  it("never throws on garbage input", () => {
    expect(() => matchesTier1Deny("", DEFAULT_TIER1_DENY)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/core/tier1.ts`**

```ts
/** ~0 ms, model-free first pass. The ONLY independent backstop (spec §12). */
export const DEFAULT_TIER1_DENY: RegExp[] = [
  /(^|[;&|]\s*)sudo\b/,
  // rm with recursive+force in any flag order, targeting / or a system path
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(-[a-z]*[rf][a-z]*\s+)*\/(\s|$)/i,
  /\brm\s+--(recursive|force)\b[^\n]*\/(\s|$)/i,
  /\b(mkfs(\.\w+)?|dd\s+[^\n]*of=\/dev\/)\b/,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\bchmod\s+(-R\s+)?0?777\s+\/(\s|$)/,
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
];

export function matchesTier1Deny(payload: string, deny: RegExp[] = DEFAULT_TIER1_DENY): boolean {
  if (typeof payload !== "string" || payload.length === 0) return false;
  return deny.some((re) => re.test(payload));
}
```

- [ ] **Step 4: Run tests — expect PASS.** Iterate on the regexes until the regression cases pass, then commit.

```bash
git add src/core/tier1.ts src/core/__tests__/tier1.test.ts
git commit -m "feat(core): tier-1 static deny, flag-order-agnostic"
```

---

## Task 3: Policy engine (§7)

**Files:**
- Create: `src/core/policy.ts`, `src/core/policy-version.ts`
- Test: `src/core/__tests__/policy.test.ts`

- [ ] **Step 1: Write the failing tests** (the rules are the spec; encode each explicitly)

```ts
import { describe, it, expect } from "vitest";
import { decide } from "../policy.js";
import { STRICT } from "../presets.js";
import type { GateRequest, GateAssessment } from "../types.js";

const req = (o: Partial<GateRequest> = {}): GateRequest => ({
  agent: "claude", toolName: "Bash", toolPayload: "ls", cwd: "/w",
  intentSupport: "available", userIntent: "list files",
  sessionKind: "crew", ...o,
});
const asmt = (o: Partial<GateAssessment> = {}): GateAssessment => ({
  verdict: "ask", classifier: "jev", tier: 2, ...o,
});

describe("policy engine (§7)", () => {
  it("deny: P(deny) ≥ denyThreshold", () => {
    const a = asmt({ verdict: "deny", probabilities: { deny: 0.8, allow: 0.1, ask: 0.1 }, confidence: 0.8 });
    expect(decide(req(), a, STRICT, false).decision).toBe("deny");
  });

  it("deny: tier-1 match decides even without a usable assessment", () => {
    expect(decide(req(), asmt(), STRICT, true).decision).toBe("deny");
  });

  it("allow requires every condition", () => {
    const a = asmt({ verdict: "allow", probabilities: { allow: 0.95, deny: 0.02, ask: 0.03 }, confidence: 0.9,
      hazards: { destructive: 0.1, secrets: 0.1, scope_escape: 0.1, intent_match: 0.9 }, severity: 0 });
    expect(decide(req(), a, STRICT, false).decision).toBe("allow");
  });

  it("allow FAILS on a single hazard veto", () => {
    const a = asmt({ verdict: "allow", probabilities: { allow: 0.95 }, confidence: 0.9,
      hazards: { destructive: 0.5, secrets: 0.1, scope_escape: 0.1, intent_match: 0.9 }, severity: 0 });
    expect(decide(req(), a, STRICT, false).decision).toBe("ask");
  });

  it("intent pending ⇒ NEVER allow (→ ask), even with clean hazards", () => {
    const a = asmt({ verdict: "allow", probabilities: { allow: 0.99 }, confidence: 0.99,
      hazards: { destructive: 0, secrets: 0, scope_escape: 0, intent_match: 0.99 }, severity: 0 });
    expect(decide(req({ intentSupport: "pending", userIntent: null }), a, STRICT, false).decision).toBe("ask");
  });

  it("intent unsupported ⇒ intent floor omitted (allow still possible)", () => {
    const a = asmt({ verdict: "allow", probabilities: { allow: 0.99 }, confidence: 0.99,
      hazards: { destructive: 0, secrets: 0, scope_escape: 0 }, severity: 0 });
    expect(decide(req({ intentSupport: "unsupported", userIntent: null }), a, STRICT, false).decision).toBe("allow");
  });

  it("intent available but below floor ⇒ ask", () => {
    const a = asmt({ verdict: "allow", probabilities: { allow: 0.99 }, confidence: 0.99,
      hazards: { destructive: 0, secrets: 0, scope_escape: 0, intent_match: 0.2 }, severity: 0 });
    expect(decide(req(), a, STRICT, false).decision).toBe("ask");
  });

  it("generative fallback is skipped unless fallbackAcceptsVerdict", () => {
    const a = asmt({ verdict: "allow", classifier: "generative", hazards: { destructive: 0, secrets: 0, scope_escape: 0 } });
    expect(decide(req(), a, STRICT, false).decision).toBe("ask");
    expect(decide(req(), a, { ...STRICT, fallbackAcceptsVerdict: true }, false).decision).toBe("allow");
  });

  it("missing confidence ⇒ ask (the catch-all)", () => {
    expect(decide(req(), asmt({ verdict: "allow", probabilities: { allow: 0.99 } }), STRICT, false).decision).toBe("ask");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/core/presets.ts`** (transcribed from §7/§12)

```ts
import type { PolicyConfig } from "./types.js";
const hazards = {
  destructive: { review: 0.35, action: 0.8, vetoesAllow: true },
  secrets: { review: 0.35, action: 0.8, vetoesAllow: true },
  scope_escape: { review: 0.35, action: 0.8, vetoesAllow: true },
  intent_match: { allowFloor: 0.5, vetoesAllow: false },
};
export const STRICT: PolicyConfig = {
  name: "strict", reviewThreshold: 0.35, actionThreshold: 0.8, allowThreshold: 0.8,
  denyThreshold: 0.75, minConfidence: 0.75, intentThreshold: 0.5, reviewSeverity: 1.0,
  severityBlock: 2.0, fallbackAcceptsVerdict: false, hazards,
  tools: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"],
};
export const BALANCED: PolicyConfig = { ...STRICT, name: "balanced", allowThreshold: 0.75, denyThreshold: 0.8, minConfidence: 0.65, intentThreshold: 0.4 };
export const PERMISSIVE: PolicyConfig = { ...STRICT, name: "permissive", allowThreshold: 0.7, denyThreshold: 0.85, minConfidence: 0.55, intentThreshold: 0.3, actionThreshold: 0.85 };
export const PRESETS = { strict: STRICT, balanced: BALANCED, permissive: PERMISSIVE } as const;
```

- [ ] **Step 4: Implement `src/core/policy.ts`**

```ts
import type { GateAssessment, GateRequest, GateOutcome, PolicyConfig } from "./types.js";

const GENERATIVE = new Set(["generative", "router"]);

export function decide(
  req: GateRequest,
  a: GateAssessment,
  p: PolicyConfig,
  tier1Matched: boolean,
): GateOutcome {
  const P = (k: string) => a.probabilities?.[k];
  const H = (k: string) => a.hazards?.[k];
  const sev = a.severity;

  // 1. DENY
  if (tier1Matched) return { decision: "deny", tier: 1, reason: "tier-1 static deny" };
  if ((P("deny") ?? 0) >= p.denyThreshold) return { decision: "deny", tier: 2, reason: "P(deny) ≥ denyThreshold" };
  if ((H("destructive") ?? 0) >= p.actionThreshold && (sev ?? 0) >= p.severityBlock)
    return { decision: "deny", tier: 2, reason: "destructive ≥ action ∧ severity ≥ block" };
  if ((H("secrets") ?? 0) >= p.actionThreshold && (H("scope_escape") ?? 0) >= p.actionThreshold)
    return { decision: "deny", tier: 2, reason: "secrets ≥ action ∧ scope_escape ≥ action" };
  if ((H("scope_escape") ?? 0) >= p.actionThreshold && (sev ?? 0) >= p.severityBlock)
    return { decision: "deny", tier: 2, reason: "scope_escape ≥ action ∧ severity ≥ block" };

  // 2. GENERATIVE FALLBACK (only if explicitly opted in)
  const isGenerative = [...GENERATIVE].some((g) => a.classifier.startsWith(g));
  if (p.fallbackAcceptsVerdict && isGenerative && (a.verdict === "allow" || a.verdict === "deny"))
    return { decision: a.verdict, tier: 2, reason: "generative verdict (fallbackAcceptsVerdict)" };

  // 3. ALLOW — every condition must hold
  const confidenceOk = a.confidence !== undefined && a.confidence >= p.minConfidence;
  const intentOk =
    req.intentSupport === "unsupported" ? true
    : req.intentSupport === "pending" ? false
    : (H("intent_match") ?? 0) >= p.intentThreshold;
  if (
    (P("allow") ?? 0) >= p.allowThreshold &&
    confidenceOk &&
    (H("destructive") ?? 1) < p.reviewThreshold &&
    (H("secrets") ?? 1) < p.reviewThreshold &&
    (H("scope_escape") ?? 1) < p.reviewThreshold &&
    intentOk &&
    (sev ?? 1) < p.reviewSeverity
  ) return { decision: "allow", tier: 2, reason: "allow conditions satisfied" };

  // 4. ASK — catch-all
  return { decision: "ask", tier: 2, reason: "catch-all ask" };
}
```

> Note the `?? 1` defaults on the hazard vetoes: a **missing** hazard must fail the allow rule (conservative), never silently pass.

- [ ] **Step 5: Implement `src/core/policy-version.ts`**

```ts
import { createHash } from "node:crypto";
import type { PolicyConfig } from "./types.js";

/** Deterministic (sorted-key) JSON, so key order can never change the hash. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function policyVersion(p: PolicyConfig): string {
  return createHash("sha256").update(canonical(p)).digest("hex");
}
```

- [ ] **Step 6: Run tests — expect PASS.** Commit.

```bash
git add src/core/policy.ts src/core/presets.ts src/core/policy-version.ts src/core/__tests__/policy.test.ts
git commit -m "feat(core): policy engine + presets + policyVersion (§7)"
```

---

## Task 4: Cache (§9)

**Files:**
- Create: `src/core/cache.ts`
- Test: `src/core/__tests__/cache.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, GateCache } from "../cache.js";

const base = { agent: "claude", toolName: "Bash", cwd: "/w", redactedPayload: "ls",
  redactedUserIntent: "list", policyVersion: "pv1", toolAliasesVersion: 1, classifierId: "jev", model: "jev-1.13.0" };

describe("cache (§9)", () => {
  it("key changes when toolAliasesVersion changes", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, toolAliasesVersion: 2 }));
  });
  it("key changes when intent changes", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, redactedUserIntent: "delete" }));
  });
  it("key changes when cwd changes", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, cwd: "/other" }));
  });
  it("stores allow/deny but never ask", () => {
    const c = new GateCache(join(mkdtempSync(join(tmpdir(), "ag-")), "c.json"));
    c.set("k1", { decision: "allow", tier: 2, reason: "" });
    c.set("k2", { decision: "ask", tier: 2, reason: "" });
    expect(c.get("k1")?.decision).toBe("allow");
    expect(c.get("k2")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/core/cache.ts`**

```ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GateOutcome } from "./types.js";

export interface CacheKeyParts {
  agent: string; toolName: string; cwd: string; redactedPayload: string;
  redactedUserIntent: string | null; policyVersion: string; toolAliasesVersion: number;
  classifierId: string; model: string;
}

export function cacheKey(k: CacheKeyParts): string {
  const intentHash = createHash("sha256").update(k.redactedUserIntent ?? "").digest("hex");
  return createHash("sha256")
    .update([k.agent, k.toolName, k.cwd, k.redactedPayload, intentHash, k.policyVersion,
      String(k.toolAliasesVersion), k.classifierId, k.model].join("\n"))
    .digest("hex");
}

const TTL_MS = 10 * 60_000;
const MAX = 500;

export class GateCache {
  private entries = new Map<string, { at: number; outcome: GateOutcome }>();
  constructor(private file: string) { this.load(); }

  get(key: string): GateOutcome | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > TTL_MS) { this.entries.delete(key); return undefined; }
    return { ...e.outcome, cached: true };
  }

  set(key: string, outcome: GateOutcome): void {
    if (outcome.decision !== "allow" && outcome.decision !== "deny") return; // never cache ask
    this.entries.set(key, { at: Date.now(), outcome: { ...outcome, cached: undefined } });
    if (this.entries.size > MAX) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    this.save();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, { at: number; outcome: GateOutcome }>;
      for (const [k, v] of Object.entries(raw)) this.entries.set(k, v);
    } catch { /* missing/corrupt cache is not an error */ }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
      renameSync(tmp, this.file);
      chmodSync(this.file, 0o600);
    } catch { /* cache write failure must never break a decision */ }
  }
}
```

- [ ] **Step 4: Run tests — expect PASS.** Commit.

```bash
git add src/core/cache.ts src/core/__tests__/cache.test.ts
git commit -m "feat(core): decision cache with toolAliasesVersion in the key (§9)"
```

---

## Task 5: Scope predicate (§10) + barrel

**Files:**
- Create: `src/core/scope.ts`, `src/index.ts`
- Test: `src/core/__tests__/scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isGateSession } from "../scope.js";

describe("scope predicate (§10)", () => {
  it("crew / side / captain session markers are in scope", () => {
    expect(isGateSession({ SQUADRANT_CREW_TASK_ID: "t1" })).toBe(true);
    expect(isGateSession({ SQUADRANT_SIDE_SESSION: "1" })).toBe(true);
    expect(isGateSession({ SQUADRANT_ROLE: "captain" })).toBe(true);
  });
  it("standalone marker is in scope", () => {
    expect(isGateSession({ AUTO_GATE_SESSION: "1" })).toBe(true);
  });
  it("the operator's own interactive session is NOT", () => {
    expect(isGateSession({})).toBe(false);
    expect(isGateSession({ SQUADRANT_ROLE: "operator" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/core/scope.ts`**

```ts
/** Positive session markers only — never scope the operator's own session (§10). */
export function isGateSession(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.SQUADRANT_CREW_TASK_ID ||
    env.SQUADRANT_SIDE_SESSION === "1" ||
    env.SQUADRANT_ROLE === "captain" ||
    env.AUTO_GATE_SESSION === "1",
  );
}
```

- [ ] **Step 4: Implement `src/index.ts`** (public barrel)

```ts
export * from "./core/types.js";
export * from "./core/tools.js";
export * from "./core/tier1.js";
export * from "./core/policy.js";
export * from "./core/presets.js";
export * from "./core/policy-version.js";
export * from "./core/cache.js";
export * from "./core/scope.js";
```

- [ ] **Step 5: Run the full suite — expect all PASS, build clean.** Commit.

```bash
git add src/core/scope.ts src/index.ts src/core/__tests__/scope.test.ts
git commit -m "feat(core): scope predicate + public barrel (§10)"
```

---

## P1 self-review

- **Spec coverage:** §5 types ✅ T1; §7 rules ✅ T3; §8 fail-open-to-ask ✅ T3 (catch-all) + T5 (no throw paths); §9 cache ✅ T4; §10 scope ✅ T5; §15#6 aliases ✅ T1. §15#3 intent semantics ✅ T3. Not in P1 (by design): §6 classifiers, §11 adapters, §12 config chain, §15#1/#2/#4/#5/#7 — those are P2–P6.
- **Placeholders:** none — every step has runnable code/commands.
- **Type consistency:** `GateRequest.intentSupport`, `PolicyConfig`, `GateOutcome` are defined once (T1) and used unchanged in T3/T4/T5.
- **Known risk:** the Tier-1 regexes in T2 are the highest-churn part (the #830 lesson: flag-order bugs). T2's test list is deliberately adversarial; add cases as they're found.

## Open dependency (needs your call)

- **PR #832 is MERGED** (`d4c0a73`) — the §15 resolutions are normative on `develop`. ✅ Resolved.
- **Repo home resolved:** `Squadrant-AI/auto-gate` (private), `~/me/auto-gate`, registered as squadrant project `auto-gate`. ✅
- **npm scope not yet created.** Create the npm org `squadrant` (lowercase) before the first publish; `@squadrant-ai/auto-gate` is unpublishable until then. Not on P1's critical path.
- **Deferred (separate op):** transferring `tu11aa/squadrant` → `Squadrant-AI/squadrant`. ⚠️ The npm **OIDC trusted publisher** must be updated to the new owner *before* the next release, or `release.yml` publish fails.
