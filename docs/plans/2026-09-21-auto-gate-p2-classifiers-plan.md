# auto-gate P2 — Classifier layer (Jev + generative fallback + null) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Tier-2 classifier layer for `@squadrant-ai/auto-gate` — a Jev client that turns a `GateRequest` into a `GateAssessment`, a generative fallback, and a null classifier — with **no live network in tests** and **fail-open-to-`ask` on every error path**.

**Architecture:** A pure pipeline with one impure edge. `redact` → `buildQuestions`/`buildState` (pure) → `JevClient.classify` (the only I/O: one `fetch`) → `parseJevResponse` (pure) → `GateAssessment`. Every failure (401/422/429/529, timeout, unparseable, near-tie) resolves to an `ask` assessment — the classifier **never throws** (§5 contract). P1's policy engine consumes the assessment; P2 does not change policy.

**Tech Stack:** TypeScript ESM, vitest, node ≥ 20. Plain `fetch` (no `@typesafe-ai/sdk`), `AbortController`.

**Spec:** [`docs/specs/2026-09-20-provider-agnostic-auto-gate-design.md`](../specs/2026-09-20-provider-agnostic-auto-gate-design.md) §2.1 (verified API), §2.2 (jaggedness), §5 (contract), §6 (Jev), §8 (failure policy).

**Depends on:** P1 (`main` @ `4e1c971`) — `GateRequest`, `GateAssessment`, `ClassifierVerdict`, `PolicyConfig`, `intentSupport` all exist.

**Scope boundary (deliberate):** no adapters, no CLI, no config-file loading, no cache wiring — those are P3/P4/P5. P2 delivers `classify(req)` plus its pure parts, all unit-testable with an injected `fetch`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/core/redact.ts` | Pure: secret-pattern redaction → `{ text, fired }` |
| `src/classifiers/battery.ts` | Pure: `GateRequest` → the §6.3 question battery |
| `src/classifiers/jev-state.ts` | Pure: `GateRequest` → the minimal, redacted, injection-safe state object |
| `src/classifiers/jev-parse.ts` | Pure: raw Jev answers → `GateAssessment \| null` (near-tie ⇒ null) |
| `src/classifiers/jev.ts` | The only I/O: POST `/v1/systemone`, timeout, one retry, never throws |
| `src/classifiers/generative.ts` | Fallback classifier: verdict only, confidence absent |
| `src/classifiers/null.ts` | Always-`ask` classifier |
| `src/classifiers/classify.ts` | Orchestration: Jev → generative → ask, under the wall-clock budget |

---

## Task 1: Redaction (`src/core/redact.ts`)

**Files:** Create `src/core/redact.ts` · Test `src/core/__tests__/redact.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { redact, REDACTION_PATTERNS_VERSION } from "../redact.js";

describe("redact (§6.2)", () => {
  it("strips bearer tokens, gh tokens, sk- keys, AWS ids", () => {
    const r = redact("curl -H 'Authorization: Bearer abc123DEF456ghi' -H 'x: ghp_0123456789abcdefghij'");
    expect(r.text).not.toContain("abc123DEF456ghi");
    expect(r.text).not.toContain("ghp_0123456789abcdefghij");
    expect(r.text).toContain("Bearer [REDACTED]");
    expect(r.fired).toContain("bearer");
  });
  it("strips KEY=value env-style secrets but keeps the key name", () => {
    const r = redact("TYPESAFE_API_KEY=sk-live-abcdef123456");
    expect(r.text).toContain("TYPESAFE_API_KEY=[REDACTED]");
    expect(r.text).not.toContain("sk-live-abcdef123456");
  });
  it("strips PEM private key bodies", () => {
    const r = redact("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----");
    expect(r.text).not.toContain("MIIabc");
    expect(r.fired).toContain("private-key");
  });
  it("is idempotent and never throws on garbage", () => {
    expect(redact("")).toEqual({ text: "", fired: [] });
    expect(() => redact(null as unknown as string)).not.toThrow();
  });
  it("exposes a version for the audit/pattern set", () => {
    expect(typeof REDACTION_PATTERNS_VERSION).toBe("string");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/core/redact.ts`**

```ts
export const REDACTION_PATTERNS_VERSION = "v1";

interface Rule { id: string; re: RegExp; replace: string }

// Order matters: the more specific token shapes run before the generic KEY=value rule.
const RULES: Rule[] = [
  { id: "bearer", re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "$1 [REDACTED]" },
  { id: "gh-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: "[REDACTED]" },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: "[REDACTED]" },
  { id: "aws-id", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: "[REDACTED]" },
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[REDACTED PRIVATE KEY]" },
  { id: "pem-body", re: /MII[A-Za-z0-9+/=]{40,}/g, replace: "[REDACTED]" },
  { id: "env-assign", re: /\b([A-Z][A-Z0-9_]{2,})=(["']?)([^\s"']{6,})\2/g, replace: "$1=[REDACTED]" },
];

export interface RedactResult { text: string; fired: string[] }

/** Redact secret patterns. Pure; `fired` names the rules that matched (never the secret). */
export function redact(input: string): RedactResult {
  if (typeof input !== "string" || input.length === 0) return { text: "", fired: [] };
  let text = input;
  const fired: string[] = [];
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      fired.push(rule.id);
      text = text.replace(rule.re, rule.replace);
    }
    rule.re.lastIndex = 0; // /g regexes are stateful — reset between calls
  }
  return { text, fired };
}
```

- [ ] **Step 4: Run — expect PASS.** Commit.

```bash
git add src/core/redact.ts src/core/__tests__/redact.test.ts
git commit -m "feat(core): versioned secret redaction (§6.2)"
```

---

## Task 2: Question battery + state builder

**Files:** Create `src/classifiers/battery.ts`, `src/classifiers/jev-state.ts` · Test `src/classifiers/__tests__/battery.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildQuestions } from "../battery.js";
import { buildState } from "../jev-state.js";
import type { GateRequest } from "../../core/types.js";

const req = (o: Partial<GateRequest> = {}): GateRequest => ({
  agent: "claude", toolName: "Bash", toolPayload: "git push --force", cwd: "/w",
  userIntent: "push my work", intentSupport: "available", sessionKind: "crew", ...o,
});

describe("question battery (§6.3)", () => {
  it("asks the 6 questions when intent is available", () => {
    const q = buildQuestions(req());
    expect(Object.keys(q).sort()).toEqual(
      ["decision", "destructive", "intent_match", "scope_escape", "secrets", "severity"].sort(),
    );
    expect(q.decision.type).toBe("choice");
    expect(q.decision.criteria).toMatchObject({ allow: expect.any(String), deny: expect.any(String), ask: expect.any(String) });
    expect(q.severity.type).toBe("score");
    expect(q.severity.criteria).toHaveLength(4);
  });
  it("OMITS intent_match when intent is unsupported (permanently unavailable)", () => {
    expect(buildQuestions(req({ intentSupport: "unsupported", userIntent: null })).intent_match).toBeUndefined();
  });
  it("includes intent_match when available; omits the VALUE when pending (policy forces ask)", () => {
    expect(buildQuestions(req({ intentSupport: "pending", userIntent: null })).intent_match).toBeDefined();
  });
});

describe("jev state (§6.2)", () => {
  it("is structured, minimal, and redacted — never prose", () => {
    const s = buildState(req({ toolPayload: "export TOKEN=ghp_0123456789abcdefghij && echo ok" }));
    expect(s.tool.name).toBe("Bash");
    expect(JSON.stringify(s)).not.toContain("ghp_0123456789abcdefghij");
    expect(s).toHaveProperty("tool.input");
  });
  it("omits user_intent entirely when absent", () => {
    expect(buildState(req({ intentSupport: "unsupported", userIntent: null })).user_intent).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/classifiers/battery.ts`**

```ts
import type { GateRequest } from "../core/types.js";
import { redact } from "../core/redact.js";

export interface ChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
export interface NoulQuestion { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
export interface ScoreQuestion { type: "score"; instructions: string; criteria: string[] }
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

const DECISION: ChoiceQuestion = {
  type: "choice",
  instructions: "Decide whether the agent may run this action, given the user's stated intent.",
  criteria: {
    allow: "Safe, ordinary software-development work in service of the user's stated intent; reversible; touches no secrets; no system/home-config writes.",
    deny: "Destructive, irreversible, credential-exfiltrating, or system-damaging; or clearly outside the user's stated intent.",
    ask: "Genuinely ambiguous, or the state does not contain enough to decide.",
  },
};

/** One request, all questions parallel (§6.3). intent_match is omitted when the
 *  adapter declares intent permanently unavailable (§6.2.1). */
export function buildQuestions(req: GateRequest): Record<string, Question> {
  const q: Record<string, Question> = {
    decision: DECISION,
    destructive: { type: "noul", instructions: "Would this action be destructive, irreversible, or hard to undo?" },
    secrets: { type: "noul", instructions: "Does this action read, write, or transmit credentials, keys, or secrets?" },
    scope_escape: { type: "noul", instructions: "Does this action touch paths outside the working directory (system paths, other repositories, home configuration)?" },
    severity: { type: "score", instructions: "How much harm if this runs?", criteria: ["none", "mild", "serious", "severe"] },
  };
  if (req.intentSupport !== "unsupported") {
    q.intent_match = { type: "noul", instructions: "Is this action plausibly in service of the user's stated intent?" };
  }
  return q;
}

/** Kept beside the battery so both redact identically. Exported for reuse. */
export { redact };
```

- [ ] **Step 4: Implement `src/classifiers/jev-state.ts`**

```ts
import type { GateRequest } from "../core/types.js";
import { redact } from "../core/redact.js";

const MAX_STATE_CHARS = 8_000; // terse: Jev suffers context-rot on irrelevant detail (§2.2)

export interface JevState {
  user_intent?: string;
  tool: { name: string; input: Record<string, unknown> };
}

/** Structured, minimal, redacted. State is data, never instructions (§6.2). */
export function buildState(req: GateRequest): JevState {
  const payload = redact(req.toolPayload).text;
  const state: JevState = {
    tool: { name: req.toolName, input: { payload: payload.slice(0, MAX_STATE_CHARS) } },
  };
  if (req.intentSupport === "available" && req.userIntent) {
    state.user_intent = redact(req.userIntent).text.slice(0, MAX_STATE_CHARS);
  }
  return state;
}
```

- [ ] **Step 5: Run — expect PASS.** Commit.

```bash
git add src/classifiers/battery.ts src/classifiers/jev-state.ts src/classifiers/__tests__/battery.test.ts
git commit -m "feat(classifiers): question battery + injection-safe redacted state (§6.2/§6.3)"
```

---

## Task 3: Jev response parsing (pure)

**Files:** Create `src/classifiers/jev-parse.ts` · Test `src/classifiers/__tests__/jev-parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseJevResponse } from "../jev-parse.js";

const ok = {
  decision: { type: "choice", choice: "allow", probabilities: { allow: 0.9, deny: 0.05, ask: 0.05 }, confidence: 0.9 },
  destructive: { type: "noul", noul: 0.1 },
  secrets: { type: "noul", noul: 0.05 },
  scope_escape: { type: "noul", noul: 0.2 },
  intent_match: { type: "noul", noul: 0.9 },
  severity: { type: "score", score: 0, legend: "none", probabilities: {}, confidence: 0.8 },
};

describe("parseJevResponse (§5, §8)", () => {
  it("maps answers into a GateAssessment", () => {
    const a = parseJevResponse(ok, "jev-1.13.0", ["decision","destructive","secrets","scope_escape","intent_match","severity"])!;
    expect(a.verdict).toBe("allow");
    expect(a.confidence).toBe(0.9);
    expect(a.probabilities).toEqual(ok.decision.probabilities);
    expect(a.hazards).toEqual({ destructive: 0.1, secrets: 0.05, scope_escape: 0.2, intent_match: 0.9 });
    expect(a.severity).toBe(0);
    expect(a.classifier).toBe("jev-jev-1.13.0");
    expect(a.tier).toBe(2);
  });
  it("returns null on a near-tie in the Choice (ε=0.05) → caller asks", () => {
    const near = { ...ok, decision: { ...ok.decision, probabilities: { allow: 0.51, ask: 0.49, deny: 0 } } };
    expect(parseJevResponse(near, "m", ["decision"])).toBeNull();
  });
  it("returns null when the Choice has no confidence", () => {
    const { confidence, ...rest } = ok.decision;
    expect(parseJevResponse({ ...ok, decision: rest }, "m", ["decision"])).toBeNull();
  });
  it("returns null when the decision answer is missing or malformed", () => {
    expect(parseJevResponse({}, "m", ["decision"])).toBeNull();
    expect(parseJevResponse({ decision: { type: "choice" } }, "m", ["decision"])).toBeNull();
  });
  it("tolerates a missing Noul (hazard simply absent → policy is conservative)", () => {
    const a = parseJevResponse({ ...ok, secrets: undefined }, "m", ["decision","secrets"])!;
    expect(a.hazards?.secrets).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/classifiers/jev-parse.ts`**

```ts
import type { GateAssessment, ClassifierVerdict } from "../core/types.js";

const NEAR_TIE_EPSILON = 0.05; // §8
const VERDICTS: ClassifierVerdict[] = ["allow", "deny", "ask"];

type RawAnswer = Record<string, unknown>;

/** Pure. Returns null for anything the policy engine should treat as "no usable
 *  assessment" (→ ask): a near-tie, a missing/malformed Choice, or no confidence. */
export function parseJevResponse(
  raw: Record<string, RawAnswer | undefined>,
  model: string,
  askedIds: string[],
): GateAssessment | null {
  const d = raw.decision as { choice?: unknown; probabilities?: Record<string, number>; confidence?: number } | undefined;
  if (!d || typeof d.choice !== "string" || !VERDICTS.includes(d.choice as ClassifierVerdict)) return null;
  if (typeof d.confidence !== "number") return null;
  if (d.probabilities) {
    const sorted = Object.values(d.probabilities).sort((a, b) => b - a);
    if (sorted.length >= 2 && sorted[0] - sorted[1] < NEAR_TIE_EPSILON) return null;
  }

  const hazards: Record<string, number> = {};
  for (const id of ["destructive", "secrets", "scope_escape", "intent_match"]) {
    if (!askedIds.includes(id)) continue;
    const noul = (raw[id] as { noul?: unknown } | undefined)?.noul;
    if (typeof noul === "number") hazards[id] = noul;
  }

  const sevAnswer = raw.severity as { score?: unknown } | undefined;
  const severity = typeof sevAnswer?.score === "number" ? sevAnswer.score : undefined;

  return {
    verdict: d.choice as ClassifierVerdict,
    confidence: d.confidence,
    ...(d.probabilities ? { probabilities: d.probabilities } : {}),
    ...(Object.keys(hazards).length ? { hazards } : {}),
    ...(severity !== undefined ? { severity } : {}),
    classifier: `jev-${model}`,
    tier: 2,
  };
}
```

- [ ] **Step 4: Run — expect PASS.** Commit.

```bash
git add src/classifiers/jev-parse.ts src/classifiers/__tests__/jev-parse.test.ts
git commit -m "feat(classifiers): pure Jev answer parsing, near-tie => null (§5/§8)"
```

---

## Task 4: Jev transport (the only I/O)

**Files:** Create `src/classifiers/jev.ts` · Test `src/classifiers/__tests__/jev.test.ts`

- [ ] **Step 1: Write the failing test** (inject `fetch`; no real network)

```ts
import { describe, it, expect, vi } from "vitest";
import { createJevClassifier } from "../jev.js";
import type { GateRequest } from "../../core/types.js";

const req: GateRequest = {
  agent: "claude", toolName: "Bash", toolPayload: "ls", cwd: "/w",
  userIntent: "list files", intentSupport: "available", sessionKind: "crew",
};
const body = { decision: { type: "choice", choice: "allow", probabilities: { allow: 0.95, deny: 0.03, ask: 0.02 }, confidence: 0.9 },
  destructive: { noul: 0.1 }, secrets: { noul: 0.1 }, scope_escape: { noul: 0.1 }, intent_match: { noul: 0.9 }, severity: { score: 0 } };
const res = (status: number, json: unknown, headers: Record<string,string> = {}) => ({
  ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => json,
});

describe("jev transport (§6.1, §8)", () => {
  it("POSTs {state, model, questions} with a Bearer token and returns an assessment", async () => {
    const fetchImpl = vi.fn(async () => res(200, body));
    const c = createJevClassifier({ apiKey: "k", model: "jev-1.13.0", fetchImpl: fetchImpl as never });
    const a = await c.classify(req);
    expect(a.verdict).toBe("allow");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string,string>).authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "jev-1.13.0" });
  });
  it("NEVER throws: 401/422/500/timeout/network all resolve to ask", async () => {
    for (const impl of [
      async () => res(401, { error: "nope" }),
      async () => res(422, {}),
      async () => res(500, {}),
      async () => { throw new Error("ECONNRESET"); },
    ]) {
      const c = createJevClassifier({ apiKey: "k", model: "m", fetchImpl: impl as never });
      const a = await c.classify(req);
      expect(a.verdict).toBe("ask");
      expect(a.tier).toBe(2);
    }
  });
  it("retries ONCE on 429 honoring retry-after, then succeeds", async () => {
    let n = 0;
    const impl = vi.fn(async () => (++n === 1 ? res(429, {}, { "retry-after": "0" }) : res(200, body)));
    const c = createJevClassifier({ apiKey: "k", model: "m", fetchImpl: impl as never, sleep: async () => {} });
    expect((await c.classify(req)).verdict).toBe("allow");
    expect(impl).toHaveBeenCalledTimes(2);
  });
  it("gives up after one failed retry with ask", async () => {
    const impl = vi.fn(async () => res(429, {}, { "retry-after": "0" }));
    const c = createJevClassifier({ apiKey: "k", model: "m", fetchImpl: impl as never, sleep: async () => {} });
    expect((await c.classify(req)).verdict).toBe("ask");
    expect(impl).toHaveBeenCalledTimes(2);
  });
});

describe("null classifier", () => {
  it("always asks", async () => {
    const { createNullClassifier } = await import("../null.js");
    const a = await createNullClassifier().classify(req);
    expect(a.verdict).toBe("ask");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/classifiers/jev.ts`**

```ts
import type { GateAssessment, GateRequest } from "../core/types.js";
import { buildQuestions } from "./battery.js";
import { buildState } from "./jev-state.js";
import { parseJevResponse } from "./jev-parse.js";

export interface JevOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;   // budget: 4000 (§6.1)
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

const ASK_CLASSIFIER = "jev-unavailable";

/** One request per decision (§6.1). MUST never throw — every failure is `ask` (§8). */
export function createJevClassifier(o: JevOptions) {
  const base = o.baseUrl ?? "https://api.typesafe.ai";
  const timeoutMs = o.timeoutMs ?? 4000;
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** Every failure resolves here (§8). The reason is logged (audit/redaction in
   *  P3), never put on the assessment — policy only needs the verdict. */
  const ask = (reason: string): GateAssessment => {
    o.log?.(`jev → ask (${reason})`);
    return { verdict: "ask", classifier: ASK_CLASSIFIER, tier: 2 };
  };

  async function postOnce(body: unknown): Promise<{ status: number; retryAfter?: string; json?: unknown }> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const retryAfter = r.headers?.get?.("retry-after") ?? undefined;
      const json = r.ok ? await r.json() : undefined;
      return { status: r.status, retryAfter: retryAfter ?? undefined, json };
    } finally {
      clearTimeout(t);
    }
  }

  return {
    id: "jev",
    async classify(req: GateRequest): Promise<GateAssessment> {
      const questions = buildQuestions(req);
      const payload = { state: buildState(req), model: o.model, questions };
      const askedIds = Object.keys(questions);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await postOnce(payload);
          if (r.status === 429 || r.status === 529) {
            if (attempt === 0) {
              const wait = Number(r.retryAfter ?? "0") * 1000;
              await sleep(Number.isFinite(wait) ? Math.min(wait, 2000) : 0);
              continue;
            }
            return ask("rate-limited");
          }
          if (r.status !== 200 || !r.json) return ask(`http ${r.status}`);
          return parseJevResponse(r.json as Record<string, never>, o.model, askedIds) ?? ask("unusable");
        } catch (e) {
          if (attempt === 0) continue; // one retry covers a transient network blip
          o.log?.(`jev failed: ${(e as Error).message}`);
          return ask("network");
        }
      }
      return ask("exhausted");
    },
  };
}
```

- [ ] **Step 4: Implement `src/classifiers/null.ts`**

```ts
import type { GateAssessment, GateRequest } from "../core/types.js";

/** Always `ask` — used when no classifier is configured (§5: never throw). */
export function createNullClassifier() {
  return {
    id: "null",
    async classify(_req: GateRequest): Promise<GateAssessment> {
      return { verdict: "ask", classifier: "null", tier: 2 };
    },
  };
}
```

- [ ] **Step 5: Run — expect PASS.** Commit.

```bash
git add src/classifiers/jev.ts src/classifiers/null.ts src/classifiers/__tests__/jev.test.ts
git commit -m "feat(classifiers): Jev transport (45s budget, one retry, never throws) + null (#6.1/#8)"
```

---

## Task 5: Generative fallback + orchestration

**Files:** Create `src/classifiers/generative.ts`, `src/classifiers/classify.ts` · Test `src/classifiers/__tests__/classify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { classify } from "../classify.js";
import type { GateRequest } from "../../core/types.js";

const req: GateRequest = { agent: "claude", toolName: "Bash", toolPayload: "ls", cwd: "/w",
  userIntent: "list", intentSupport: "available", sessionKind: "crew" };
const ask = async () => ({ verdict: "ask" as const, classifier: "x", tier: 2 as const });
const allow = async () => ({ verdict: "allow" as const, classifier: "x", tier: 2 as const });

describe("classify orchestration (§4, §8)", () => {
  it("returns the Jev result when Jev produces a usable assessment", async () => {
    const a = await classify(req, { kind: "jev", primary: { id: "jev", classify: allow } });
    expect(a.verdict).toBe("allow");
  });
  it("tries the generative fallback when Jev yields ask, and its verdict is taken", async () => {
    const fallback = { id: "gen", classify: vi.fn(allow) };
    const a = await classify(req, { kind: "jev", primary: { id: "jev", classify: ask }, fallback });
    expect(a.verdict).toBe("allow");
    expect(fallback.classify).toHaveBeenCalledOnce();
  });
  it("returns ask when both fail", async () => {
    const a = await classify(req, { kind: "jev", primary: { id: "jev", classify: ask }, fallback: { id: "gen", classify: ask } });
    expect(a.verdict).toBe("ask");
  });
  it("does NOT call the fallback when Jev already returned deny/allow", async () => {
    const fallback = { id: "gen", classify: vi.fn(ask) };
    await classify(req, { kind: "jev", primary: { id: "jev", classify: allow }, fallback });
    expect(fallback.classify).not.toHaveBeenCalled();
  });
  it("kind:'generative' skips Jev entirely", async () => {
    const primary = { id: "jev", classify: vi.fn(allow) };
    const a = await classify(req, { kind: "generative", primary, fallback: { id: "gen", classify: ask } });
    expect(a.verdict).toBe("ask");
    expect(primary.classify).not.toHaveBeenCalled();
  });
  it("NEVER throws, even if a classifier violates its contract", async () => {
    const boom = { id: "b", classify: async () => { throw new Error("nope"); } };
    const a = await classify(req, { kind: "jev", primary: boom });
    expect(a.verdict).toBe("ask");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/classifiers/classify.ts`**

```ts
import type { GateAssessment, GateRequest } from "../core/types.js";

export interface Classifier { id: string; classify(req: GateRequest): Promise<GateAssessment> }

export interface ClassifyConfig {
  kind: "jev" | "generative";
  primary: Classifier;
  fallback?: Classifier;
}

async function safe(c: Classifier, req: GateRequest): Promise<GateAssessment> {
  try {
    const a = await c.classify(req);
    if (!a || typeof a.verdict !== "string") throw new Error("malformed assessment");
    return a;
  } catch {
    return { verdict: "ask", classifier: `${c.id}-error`, tier: 2 };
  }
}

/** Jev first (unless kind==='generative'), then the fallback, else ask (§4, §8).
 *  The fallback is a safety net: §7 only honours its verdict when
 *  fallbackAcceptsVerdict is true, so reaching it never weakens the gate. */
export async function classify(req: GateRequest, cfg: ClassifyConfig): Promise<GateAssessment> {
  const first = cfg.kind === "jev" ? cfg.primary : cfg.fallback;
  if (first) {
    const a = await safe(first, req);
    if (a.verdict !== "ask" || a.probabilities) return a; // a usable verdict ends the chain
  }
  if (cfg.kind === "jev" && cfg.fallback) return safe(cfg.fallback, req);
  return { verdict: "ask", classifier: "none", tier: 2 };
}
```

- [ ] **Step 4: Implement `src/classifiers/generative.ts`** (any OpenAI-compatible endpoint; verdict only)

```ts
import type { GateAssessment, GateRequest } from "../core/types.js";
import { buildState } from "./jev-state.js";

export interface GenerativeOptions {
  baseUrl: string; model: string; apiKeyEnv?: string;
  timeoutMs?: number; fetchImpl?: typeof fetch; log?: (m: string) => void;
}

const PROMPT = [
  "You are a permission gate for a coding agent. Reply with exactly one word: allow, deny, or ask.",
  "allow = safe, ordinary development work in service of the user's intent.",
  "deny = destructive, irreversible, credential-exfiltrating, or system-damaging.",
  "ask = ambiguous or insufficient information.",
].join(" ");

/** A generative classifier yields a VERDICT ONLY (no confidence, no hazards) — §5.
 *  That is deliberate: with fallbackAcceptsVerdict:false the policy engine ignores
 *  it and asks (§7). Never throws — any failure is `ask`. */
export function createGenerativeClassifier(o: GenerativeOptions) {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 3000;
  const key = o.apiKeyEnv ? process.env[o.apiKeyEnv] : undefined;
  return {
    id: "generative",
    async classify(req: GateRequest): Promise<GateAssessment> {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetchImpl(`${o.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({
            model: o.model,
            messages: [
              { role: "system", content: PROMPT },
              { role: "user", content: JSON.stringify({ intent: req.userIntent ?? null, tool: req.toolName, payload: buildState(req).tool.input }) },
            ],
            max_tokens: 4, temperature: 0,
          }),
          signal: ac.signal,
        });
        if (!r.ok) return { verdict: "ask", classifier: "generative-unavailable", tier: 2 };
        const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        const word = (body.choices?.[0]?.message?.content ?? "").trim().toLowerCase();
        const verdict = word === "allow" ? "allow" : word === "deny" ? "deny" : "ask";
        return { verdict, classifier: `generative:${o.model}`, tier: 2 }; // confidence intentionally ABSENT
      } catch (e) {
        o.log?.(`generative failed: ${(e as Error).message}`);
        return { verdict: "ask", classifier: "generative-unavailable", tier: 2 };
      } finally {
        clearTimeout(t);
      }
    },
  };
}
```

- [ ] **Step 5: Run — expect PASS.** Then export from the barrel and build.

Append to `src/index.ts`:
```ts
export * from "./core/redact.js";
export * from "./classifiers/classify.js";
export * from "./classifiers/jev.js";
export * from "./classifiers/generative.js";
export * from "./classifiers/null.js";
```

```bash
pnpm build && pnpm test 2>&1 | tail -20
git add src/classifiers/ src/index.ts
git commit -m "feat(classifiers): generative fallback + classify orchestration (§4/§8)"
```

---

## P2 self-review

- **Spec coverage:** §2.1 transport/limits/errors ✅ T4; §2.2 jaggedness (no arithmetic in questions, one atomic question per dimension, minimum state) ✅ T2/T3; §5 contract (never throw, tier 2) ✅ T3–T5; §6.1 transport + one retry + budget ✅ T4; §6.2 injection-safe redacted state ✅ T1/T2; §6.3 battery ✅ T2; §8 failure policy (near-tie ε=0.05, missing confidence, all errors ⇒ ask) ✅ T3/T4. Not in P2: cache wiring, config loading, adapters, CLI.
- **Placeholders:** none — every step has runnable code/commands.
- **Type consistency:** `GateRequest`/`GateAssessment`/`ClassifierVerdict` are P1's (unchanged); `Classifier` is defined once in T5 and reused.
- **Known risk:** the Jev wire envelope is taken from §2.1 (verified 2026-09-20). If the live API differs, only `jev.ts` + `jev-parse.ts` change — they are deliberately the only two files that know the wire format.
- **Budget note:** Jev 4 s + generative 3 s ≤ the 10 s claude hook timeout (§6.1). The orchestration does not yet enforce a combined deadline — that lands with the adapter (P4), where the hook timeout is known.

## Not in this plan (next phases)

P3 config/audit/CLI · P4 claude adapter · P5 opencode adapter · P6 squadrant integration.
