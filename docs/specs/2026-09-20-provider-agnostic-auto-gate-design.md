# Provider-agnostic, cross-agent auto permission gate (Jev-backed) — design

**Status:** proposed / research
**Date:** 2026-09-20
**Author:** research side-session (squadrant)
**Supersedes nothing.** Extends U7 (`docs/specs/2026-09-20-router-permission-gate-u7-design.md`).
**Related:** U7 #782 (implemented), epic #772 (closed), handoff of this session.

---

## 1. Why this exists

Claude Code's built-in `auto` permission mode classifies each tool call with a model
**hardcoded to Claude Sonnet 5**. On any non-Anthropic backend that does not serve that
model the classifier request fails and Claude Code **fails closed** — `Write`/`Bash` are
denied silently and an unattended crew cannot work.

U7 (#782) fixed claude-on-a-router with a hook-based gate whose Tier-2 classifier is a
*generative* router model returning a one-word verdict. U7 works, but live smoke exposed
three structural limits:

1. **Generative classifier truncation.** A reasoning router model can exhaust
   `max_tokens` inside its thinking block before emitting the verdict, so the gate never
   sees a verdict and asks on every call (#821 had to add headroom). A model that does
   not generate text cannot have this failure.
2. **No calibrated confidence.** A one-word verdict carries no uncertainty, so the gate
   must `ask` on *any* doubt. `ask` stalls unattended runs; the gate can never
   auto-resolve ambiguous-but-safe work.
3. **Claude-only.** A `PermissionRequest` claude hook is the only seam U7 knows.

**Goal.** One permission gate that:

- works for **any agent CLI** (extension points are per-agent; the decision core is not),
- works with **any provider** for the fallback tier (no Anthropic credential required),
- decides `allow | deny | ask` from a **Jev** typed assessment (TypeSafe System One:
  typed answers + calibrated probabilities, no text generation, 70–500 ms, output free),
- **auto-resolves when confidence clears a bar** using Jev's probabilities, and
- **fails open to `ask`** — never a silent deny — when Jev is unavailable or ambiguous.

**Non-goals (v1).** A general policy engine beyond permissions; credential pools; a local
price table; reimplementing Anthropic's two-stage classifier.

---

## 2. Verified facts that shape the design

### 2.1 Jev / TypeSafe (verified against docs.typesafe.ai, 2026-09-20)

- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`,
  `Authorization: Bearer $TYPESAFE_API_KEY`, `Content-Type: application/json`.
- **Request:** `{ "state": string|object|array, "model": string,
  "questions": { "<id>": Question } }`.
- **Question types (all take `type`, `instructions`, and per-type criteria):**
  - `choice` — `criteria` is a map of option → description (≤255 options). Answer:
    `{ type, choice, probabilities, confidence }`.
  - `score` — `criteria` is an ordered array of 2–10 level descriptions. Answer:
    `{ type, score, legend, probabilities, confidence }`.
  - `noul` — optional `criteria: { true, false }`. Answer: `{ type, noul }` where
    `noul` is 0..1. **Noul answers carry no confidence.**
- **All questions are evaluated in parallel against one state**; adding questions barely
  changes latency. One answer per question, keyed by the same id.
- **Models:** current `jev-1.13.0`; aliases `jev-latest`, `jev-preview`. `GET /v1/models`
  lists aliases; versioned ids are accepted in `model` whether or not listed.
- **Limits:** context budget 64k (state + all questions); 32k (state + longest question).
  Rate limits 250k tok/s, 1200 req/min. Errors `401`, `422`, `429`, `529`. Text-only input.
- **Price:** $0.042 / Mtok input; output free.
- **SDKs:** `@typesafe-ai/sdk` (JS), `typesafe-sdk` (Python); env `TYPESAFE_API_KEY`. A
  drop-in TypeSafe **agent skill** is published for agent harnesses.
- **Confidence** is a 0..1 statistic derived from the probability distribution (concentrated
  = high). TypeSafe's docs recommend three bands — high = act, medium = confirm/review,
  low = route to human — and warn thresholds scale with risk.

> **Soft / unverified claims** (do not build on without confirming): "early access /
> waitlist", "closed managed API (no self-host)", the exact Node ≥20 / Python ≥3.10
> minimums, and "adding questions barely changes latency" were **not** confirmed on the
> fetched API/models pages (the parallel-evaluation claim is from the intro page; the
> per-request cost claim is from TypeSafe's own cookbook). Treat as marketing until verified.

### 2.2 Jev jaggedness (verified — drives the policy design)

`jev-1.13` is fast and well-calibrated but **literal, non-numeric, and steerable**:

| Failure mode | Design consequence |
|---|---|
| Literal reading | Write each criterion as the exact condition; put boundary cases in `criteria`. |
| No arithmetic / counting | **All threshold math lives in code**, never in a question. |
| No date/time comparison | Extract in a Choice; compare/order in code. |
| Weak at indirection / multi-hop | Ask one atomic question per dimension; combine in code. |
| Context-rot on irrelevant state | Send the **minimum** state; filter in code first. |
| Adversarially steerable (state is not hostile by default) | **Jev is not a security boundary.** Structured/fenced state + **Tier-1 static deny** (the only model-independent backstop) + conservative thresholds + redaction. Hazard floors are Jev outputs, not an independent defense. |
| No structural invariants between questions | Do not assume `P(noul) ≈ 1 − P(¬noul)`, and do not carry a Noul-tuned threshold onto a Choice. Threshold **per question**, not one shared number. |
| No generation | Never ask Jev to emit text; all free text is authored by us. |

### 2.3 Cross-agent extension points (verified 2026-09-20)

| Agent | Seam | Decision output | Notes |
|---|---|---|---|
| **claude** | `PermissionRequest` hook (`~/.claude/settings.json`) | `hookSpecificOutput.decision.behavior: allow\|deny`; **no `ask` behavior** (emit nothing = dialog) | Owned by U7 today. Verified schema. |
| **opencode** | native `permission` config (`bash: "ask"`) + SSE `permission.asked` / `permission.replied`; answer via `POST /session/{id}/permissions/{permID}` `{response:"once"\|"reject"}` | `once` / `reject`; no "ask" → leave pending | squadrant already bridges this (`sse-bridge.ts`). The plugin `permission.ask` hook is **declared but not triggered** (#7006, #19469 *closed not planned*); `tool.execute.before` exists but is not a permission gate. |
| **codex** (v2) | `~/.codex/hooks.json` or `config.toml [hooks]`; `PermissionRequest` and `PreToolUse` events | `permissionDecision` / `hookSpecificOutput.decision.behavior`: `allow\|deny\|ask`; `permission_request` allow/deny bypasses the approval UI, `ask` keeps it | Needs `features.hooks = true` + user trust via `/hooks`. Payload: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`. |
| **gemini** (v2) | `BeforeTool` hook in `~/.gemini/settings.json`; also a TOML policy engine | `decision: allow\|deny\|ask` (`ask` implemented, undocumented — #28046) | Gemini CLI → Antigravity CLI migration announced 2026-06-18; treat as moving target. |

**Unverified leads (do not build on without confirmation):** Jev via OpenRouter
(`typesafe/jev-1.13`, `POST /api/alpha/decisions`) and via Vercel AI Gateway
(`typesafe-ai/jev`, `experimental_evaluate`). Third-party resellers advertising Jev
access (e.g. `jevapi.org` / `tokenra.io`) are **not** official TypeSafe surfaces.

---

## 3. Packaging decision

**Standalone-first npm package; squadrant consumes it** (operator decision).

- The gate ships as its own package **`@squadrant/auto-gate`**, in its own repo, publishable
  and installable by any agent/user: `npm i -g @squadrant/auto-gate` /
  `npx @squadrant/auto-gate`. It is *named* under the squadrant scope (the eventual home)
  but *homed* in its own repo, so it can be installed and versioned independently of
  squadrant. The existing `squadrant` package will also move into the squadrant org when the
  org exists.
- It exposes an `auto-gate` bin: `auto-gate decide`, `auto-gate install`,
  `auto-gate uninstall`, `auto-gate doctor`, `auto-gate test`, `auto-gate stats`, and the
  opencode rollout pair `auto-gate opencode run` / `auto-gate opencode watch` (§15 #1, #2).
- `@squadrant/core` depends on the core module and keeps `squadrant gate claude
  permission-request` as a **thin wrapper**. "Thin" is a goal, not a given: the current
  claude path imports `CONFIG_DIR`/`isGateMode`/`isGatePolicy`/`resolveRouterModel`/config
  types from `@squadrant/shared` (`permission-gate.ts:20-28`) and
  `deriveTranscriptPath`/`mapClaudeHookToEvent` from `@squadrant/agents`
  (`gate.ts:29`), and core re-exports `SIDE_SESSION_ENV` through the permission-gate barrel
  (`core/index.ts:32` → `export * from "./permission-gate.js"`; the constant is defined at
  `permission-gate.ts:61`). Extraction therefore requires three explicit **bridge
  interfaces** on the standalone side:
  1. **config** — the adapter receives a resolved policy config (squadrant projects
     `defaults.gate` onto it), so the package never reads squadrant's config file directly;
  2. **userIntent** — a supplied `userIntent` string (or `undefined`), so the package never
     derives claude transcript paths itself;
  3. **blocked-signal** — a supplied callback for the `ask`/`yield` path (squadrant maps it
     to #560 `task.blocked`; standalone maps it to its own notify).
  The **hook contract and acceptance tests are preserved**; the source is not byte-for-byte.
- The rejected alternative was homing it **inside the squadrant monorepo workspace** (a
  package built and released on squadrant's cycle): it would delay the stated "any agent can
  install it" goal and entangle the gate's release with squadrant's.
- A pure skill/plugin (no runtime) was rejected: thresholds, cache, and a shared classifier
  need a process.

**Internal layout of the package** (one-way deps):

```
auto-gate/
  src/core/       GateRequest, GateClassifier, policy engine, cache, audit  (agent-agnostic)
  src/classifiers/jev.ts, generative.ts, null.ts
  src/adapters/claude.ts, opencode.ts          (+ codex.ts, gemini.ts in v2)
  src/config/     portable config load + resolution chain
  src/cli/        decide / install / uninstall / doctor / test / stats
```

---

## 4. Architecture

```
┌─ Agent adapters (thin, per-CLI) ─────────────────────────────────┐
│  ClaudeAdapter   OpencodeAdapter   [CodexAdapter] [GeminiAdapter] │
│   - parse the hook/subscription payload                           │
│   - extract injection-safe state     - serialize the decision      │
│   - install / uninstall its own hook entry(ies)                    │
└───────────────────────────┬───────────────────────────────────────┘
                            │  GateRequest (normalized, agent-agnostic)
┌───────────────────────────▼─ Gate core (portable) ────────────────┐
│  Tier-1 static deny (model-free, ~0 ms)                           │
│  GateClassifier → GateAssessment                                  │
│  Policy engine: assessment + thresholds → allow | deny | ask      │
│  Decision cache (file-backed)   ·   Audit log (JSONL, 0600)        │
└───────────────────────────┬───────────────────────────────────────┘
                            │
┌───────────────────────────▼─ Classifiers ─────────────────────────┐
│  JevClassifier (default)   GenerativeClassifier (fallback)         │
│  Future: NullClassifier → ask · local model · other System One …   │
└────────────────────────────────────────────────────────────────────┘
```

**Flow**

```
permission event (agent adapter)
  ├─ agent / session out of scope ────────────────────► yield (adapter default flow)
  ├─ gate disabled (mode off/auto) ───────────────────► yield
  ├─ Tier-1 static deny matches ──────────────────────► deny  (~0 ms, no network)
  ├─ cache hit ───────────────────────────────────────► allow | deny
  ├─ classify (Jev by default; generative fallback)
  │     ├─ high-confidence safe ──────────────────────► allow
  │     ├─ high-confidence dangerous ─────────────────► deny
  │     └─ ambiguous / low confidence / error ────────► ask
  ▼
adapter serializes: allow/deny → suppress the prompt; ask → normal dialog (+ blocked signal)
```

---

## 5. The `GateClassifier` abstraction

The classifier returns an **assessment, not a decision**. The policy engine owns
thresholds. This separation is the whole point of the design: swapping Jev for a
generative model (or a future adapter) must not change policy logic.

```ts
type ClassifierVerdict = "allow" | "deny" | "ask";

interface GateAssessment {
  /** The classifier's leaning (highest-probability option / one-word verdict). */
  verdict: ClassifierVerdict;
  /** 0..1. Present for Jev Choice/Score; undefined for a generative verdict. */
  confidence?: number;
  /** e.g. { allow: 0.90, deny: 0.05, ask: 0.05 } — Jev Choice only. */
  probabilities?: Record<string, number>;
  /** Noul probabilities: destructive, secrets, intent_match, scope_escape. */
  hazards?: Record<string, number>;
  /** Jev Score 0..3. */
  severity?: number;
  /** "jev-1.13.0" | "router:<model>" | "static". */
  classifier: string;
  /** Always 2 — a classifier is the Tier-2 stage. Tier-1 static policy runs
   *  before it and is not a classifier. */
  tier: 2;
  usage?: { inputTokens?: number };
}

interface GateRequest {
  agent: "claude" | "opencode" | "codex" | "gemini" | string;
  toolName: string;
  toolPayload: string;        // bare executable payload (command / path+content)
  cwd: string;
  userIntent?: string | null; // last HUMAN message text, text blocks only
  // Intent availability (§6.2.1, §15 #3): "available" = userIntent supplied;
  // "pending" = the adapter supports intent but none is known yet (→ `ask`);
  // "unsupported" = no intent source at all (omit intent_match).
  intentSupport: "available" | "pending" | "unsupported";
  permissionMode?: string;    // agent's permission mode, if any
  sessionKind: "crew" | "side" | "captain" | "standalone";
  raw?: unknown;              // the adapter's original payload, for audit only
}

interface GateClassifier {
  readonly id: string;
  /** MUST never throw — any failure resolves to an `ask` assessment. */
  classify(req: GateRequest): Promise<GateAssessment>;
}

/** The policy engine's final output. `yield` = the gate does not own this
 *  prompt (out of scope / disabled / `auto` permission mode) and the adapter
 *  must fall through to the agent's normal flow. */
type GateOutcomeDecision = "allow" | "deny" | "ask" | "yield";
interface GateOutcome {
  decision: GateOutcomeDecision;
  tier: 1 | 2;
  reason: string;
  cached?: boolean;
}
```

---

## 6. Jev integration

### 6.1 Transport
`POST https://api.typesafe.ai/v1/systemone`, Bearer `TYPESAFE_API_KEY`, one request per
decision. Jev responds in 70–500 ms. The package POSTs directly with `fetch` (it does not
depend on the TypeSafe SDK), so **retry is ours**: on `429`/`529`, one retry honoring
`retry-after`, then `ask`. **Budget:** total Tier-2 wall-clock (Jev + optional generative
fallback + retry) must stay under the claude hook's installed `timeout` of **10 s**
(`native-hook-source.ts:168`). Proposed split: Jev 4 s, generative fallback 3 s, leaving
~2 s of slack; the adapter must emit `ask` before the hook times out rather than be killed
mid-decision.

### 6.2 State (injection-safe, minimal)
Send a structured object, never a prose blob. State is **data**, never instructions:

```json
{
  "user_intent": "<last human user message, text blocks only, truncated>",
  "tool": { "name": "Bash", "input": { "command": "git push --force" } }
}
```

- Redact secret patterns **before** the state is built: bearer tokens, `gh[pousr]_…`,
  `sk-…`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----`, `.env`-style `KEY=value` values, and
  key-file contents. The redaction pattern set is a versioned constant; the audit log
  records which patterns fired, never the matched secret.
- **Cache key hashes the redacted payload** (post-redaction), so two commands differing
  only in a secret collapse to one entry — never key on raw secrets.
- Cap total state size; prefer the terse subset, because Jev suffers context-rot on
  irrelevant detail.
- The tool payload is the bare executable field only (U7's `extractToolPayload`); tool
  outputs and surrounding fields never reach the classifier.

### 6.2.1 `userIntent` per agent (a required adapter responsibility)
`intent_match` needs a human-intent source. Each adapter supplies it or declares it
absent:

| Agent | `userIntent` source | Notes |
|---|---|---|
| claude | last human user message from the transcript JSONL (U7's `extractUserIntentFromTranscript`) | verified, exists today |
| opencode | **not available on `permission.asked`** — the frame carries only `{id, sessionID, permission, patterns}` (`sse-bridge.ts:218-238`). The adapter **reconstructs** intent from preceding `message.*` frames on the same SSE stream; when intent is expected but not yet known the outcome is `ask`. | resolved — §15 #3 |
| codex / gemini (v2) | hook payload `prompt`/`transcript_path` as available | per-agent |

**Consequence:** an adapter either supplies `userIntent` or declares it unavailable. If it is
**permanently unavailable** (a declared v2 codex/gemini gap), `intent_match` is omitted from the
battery and the allow rule's intent floor is skipped. If it is **expected but not yet known**
(opencode before the first human frame), the allow rule does **not** pass and the outcome is `ask` —
never a silent auto-allow on unknown intent. See §15 #3 (resolved: reconstruct from SSE, ask when
unknown).

### 6.3 Question battery (one request; mirrors TypeSafe's guardrails cookbook)
- `decision` — **Choice** `["allow","deny","ask"]`. Criteria written as exact conditions:
  - `allow`: "safe, ordinary software-development work in service of the user's stated
    intent; reversible; touches no secrets; no system/home-config writes."
  - `deny`: "destructive, irreversible, credential-exfiltrating, or system-damaging; or
    clearly outside the user's stated intent."
  - `ask`: "genuinely ambiguous, or the state does not contain enough to decide."
- `destructive` — **Noul** "Would this action be destructive, irreversible, or hard to undo?"
- `secrets` — **Noul** "Does this action read, write, or transmit credentials, keys, or
  secrets?"
- `intent_match` — **Noul** "Is this action plausibly in service of the user's stated
  intent?"
- `scope_escape` — **Noul** "Does this action touch paths outside the working directory
  (system paths, other repositories, home configuration)?"
- `severity` — **Score** 0..3 "How much harm if this runs?" with levels
  `["none","mild","serious","severe"]`.

Answers are read by id. The policy engine combines them — it never trusts a single Noul or
the Choice alone, and it never assumes arithmetic identities across questions.

---

## 7. Policy engine — thresholds and auto-resolution

Verdict derived in **code**, guardrails-style: per-hazard thresholds + a named policy +
a precedence. Default posture: **threshold-gated auto-resolve, fail-open-to-ask**.

**Default named policy `strict`** (proposed; tunable per-repo):

| Knob | Default | Meaning |
|---|---|---|
| `reviewThreshold` | 0.35 | hazard Noul ≥ this → at least `ask` |
| `actionThreshold` | 0.80 | hazard Noul ≥ this → hazard action (deny) |
| `allowThreshold` | 0.80 | `P(allow)` needed to auto-allow |
| `denyThreshold` | 0.75 | `P(deny)` needed to auto-deny |
| `minConfidence` | 0.75 | Choice confidence needed for any auto-resolution |
| `intentThreshold` | 0.50 | `intent_match.noul` floor for auto-allow |
| `reviewSeverity` | 1.0 | severity Score at/above which the outcome is at least `ask` |
| `severityBlock` | 2.0 | severity Score that upgrades a review to a block |

**Rules — evaluated top-down, first match wins. Precedence is `deny > allow > ask`, with a
final `ask` catch-all so an outcome is always defined and a silent `allow` is impossible.**

- **deny** if any of:
  - `P(deny) ≥ denyThreshold`, or
  - `destructive.noul ≥ actionThreshold ∧ severity ≥ severityBlock`, or
  - `secrets.noul ≥ actionThreshold ∧ scope_escape.noul ≥ actionThreshold`, or
  - `scope_escape.noul ≥ actionThreshold ∧ severity ≥ severityBlock`, or
  - a Tier-1 static deny rule matches.
- **allow** only if all of:
  - `P(allow) ≥ allowThreshold`, and
  - `confidence ≥ minConfidence`, and
  - `destructive.noul < reviewThreshold`, and
  - `secrets.noul < reviewThreshold`, and
  - `scope_escape.noul < reviewThreshold`, and
  - `intent_match.noul ≥ intentThreshold` when the adapter supplies intent; omitted **only** when
    the adapter declares intent permanently unavailable. Expected-but-unknown intent fails this
    condition (→ `ask`, never a silent allow), and
  - `severity < reviewSeverity`.
- **ask — the catch-all**, which fires whenever the deny rule did not match and the allow
  rule did not pass. Its explicit triggers are:
  - `confidence` is absent, or `confidence < minConfidence`, or
  - `P(allow) < allowThreshold`, or
  - **any hazard Noul `≥ reviewThreshold`** — this deliberately covers both the review band
    `[reviewThreshold, actionThreshold)` **and** a hazard at/above `actionThreshold` that
    did not satisfy a deny rule (the previous band-only wording left such a case undefined),
    or
  - `severity ≥ reviewSeverity`, or
  - the classifier failed / returned no usable assessment.

**Generative-fallback rule.** The rules above require probabilities/confidence, which a
generative classifier does not produce, so they can never honor its verdict. An explicit
rule therefore runs **after** the Tier-1 deny check and **before** the ask catch-all: if
`fallbackAcceptsVerdict: true` **and** the active classifier is generative **and** its
verdict is `allow` or `deny`, that verdict is returned. With the default `false` this rule
is skipped and the outcome is the ask catch-all.

Every hazard the battery collects is consumed by at least one rule — there is no
collected-but-ignored question. `severity` is consumed by both the deny rules and the allow
rule's `reviewSeverity` veto.

**Asymmetry (deliberate).** Auto-*allow* is the dangerous direction, so it gets the
highest bar plus a confidence floor and hazard vetoes. Auto-*deny* is recoverable but U7's
standing rule is "never a silent deny", so `deny` too requires a high bar; ambiguous
danger degrades to `ask`. Named policies `strict` / `balanced` / `permissive` adjust the
knobs together; per-hazard overrides are allowed and are defined **per question** (never a
single shared threshold carried across Choice and Noul — see jaggedness §2.2).

**Generative fallback — consequence.** Because the fallback rule above is gated on
`fallbackAcceptsVerdict`, the default `false` makes a generative classifier *always ask*: it
is a safety net, not an auto-resolver. This keeps the fallback from **weakening** the gate
relative to U7. The "works with any provider" pitch therefore means *works, but asks* unless
Jev is available (or an operator opts in with `fallbackAcceptsVerdict: true`).

**Version pinning / `policyVersion`.** `policyVersion` is a `sha256` of the **resolved**
policy config — the named policy, every threshold, every per-hazard veto, and the
`fallbackAcceptsVerdict` flag. It participates in the cache key (§9), so any threshold
edit invalidates prior decisions automatically. The Jev model id participates separately,
so a model change also invalidates.

---

## 8. Failure policy

**Fail open to `ask`. Always.** Any of: missing/invalid key (`401`), malformed request
(`422`), rate limit (`429`), overload (`529`), network/timeout, an unparseable or
missing answer, a near-tie in the Choice probabilities (top-two within ε = 0.05), or
confidence below floor → `ask`, which shows the agent's normal prompt and preserves
blocked-signalling. This is U7's explicit acceptance
criterion, inverted from Claude's built-in fail-**closed** behavior: for an unattended
crew a silent deny is a dead session; an `ask` is a captain notification.

If a generative fallback is configured and Jev fails, the gate MAY try the fallback and
then `ask`. It never fails closed.

---

## 9. Cache

- **Key:** `sha256(agent + "\n" + toolName + "\n" + cwd + "\n" + redactedPayload + "\n" +
  sha256(redactedUserIntent ?? "") + "\n" + policyVersion + "\n" + toolAliasesVersion + "\n" +
  classifierId + "\n" + model)`. `redactedUserIntent` is included because `intent_match` can change
  the outcome (§7); omitting it would let the same command reuse a stale `allow` under a
  different human intent.
- **`toolAliasesVersion`** (§15 #6) participates so that changing the alias map invalidates
  prior decisions.
- **`policyVersion`** is the hash defined in §7; **`model`** is the resolved Jev model id.
- **Only conclusive outcomes are cached** (`allow`/`deny`); `ask` and failures are not.
- **TTL** 10 min, **max** 500 entries, atomic write (temp + rename), 0600.
- Stored at `~/.auto-gate/gate-cache.json` (standalone) or the squadrant state dir when
  consumed by squadrant.
- `cwd` in the key means an identical command in a different repo cannot reuse a decision.
- The payload is the **redacted** payload (post-redaction), never raw secrets.

---

## 10. Scoping — which sessions the gate owns

Explicit **positive** session markers; **never** the operator's own interactive session.

- Standalone: `AUTO_GATE_SESSION=1` (generic session marker) and `AUTO_GATE=on|off|auto`
  (mode, mirroring squadrant's split).
- squadrant: the **session markers** honored through the adapter predicate are exactly the
  ones `isGateSession` uses today — `SQUADRANT_CREW_TASK_ID`, `SQUADRANT_SIDE_SESSION=1`,
  `SQUADRANT_ROLE=captain` (`permission-gate.ts:120-124`). One predicate, so the wrapper and
  the core can never disagree (the U7 lesson: the scoping predicate must be single-source).
- **`SQUADRANT_GATE` is the *mode*, not a session marker.** It is read by `resolveGateMode`
  (`permission-gate.ts:128-132`) and set to `"on"` by the captain router
  (`captain-router.ts:105`). It is mapped onto `AUTO_GATE` and never used to decide scope.
- The gate only fires where a permission prompt would appear; `permission_mode === "auto"`
  yields to the agent's built-in classifier (claude), preserving the migration lever.
- **`yield`** is the adapter-level "not mine" outcome: out of scope, gate disabled, or
  `auto` permission mode. It is not a classifier verdict and is not produced by the policy
  engine's allow/deny/ask rules.

---

## 11. Cross-agent install matrix

### claude
- **Extension point:** `PermissionRequest` hook.
- **Output:** `hookSpecificOutput.decision.behavior` — `allow`/`deny`; **`ask` = emit
  nothing** (no `ask` behavior exists). On `ask`/yield, fall back to the #560
  `task.blocked` signal.
- **Install:** idempotent, non-clobbering merge into `~/.claude/settings.json` (reuse U7's
  installer shape; namespaced command `auto-gate decide --agent claude`).
- **Coexistence (symmetric ownership protocol).** Two `PermissionRequest` handlers cannot
  coordinate and a duplicate auto-approval could race a blocked-signal (U7 decision 4).
  Ownership must be enforced **both ways**, because either tool can be installed first:
  - `auto-gate install` detects squadrant's managed `squadrant gate claude
    permission-request` entry and **defers** (writes nothing).
  - squadrant's `installClaudeHooks` must **also** detect and remove a foreign
    `auto-gate decide --agent claude` entry before writing its own. Today it only migrates
    its *own* legacy `squadrant hooks claude permission-request` command
    (`native-hook-source.ts:149-155`); the foreign-owner case is a **new required change**
    on the squadrant side, not just an `auto-gate` behavior.
  - `auto-gate doctor` reports who owns the event. **Precedence rule (conditional):** squadrant
    wins when both compete — but it removes a foreign entry **only while its own gate is enabled**
    (`defaults.gate.mode === "on"` — NOT `"auto"`, which is a no-op); otherwise there is no
    conflict, so the
    foreign entry is left untouched (warned + recorded, never silent). See §15 #5.

### opencode
- **Extension point:** native `permission` rules (`bash: "ask"`) + SSE
  `permission.asked` / `permission.replied`; answer the crew's server with
  `POST /session/{sessionID}/permissions/{permissionID}` `{response:"once"|"reject"}`.
- **Output:** `once` (allow) / `reject` (deny); "ask" = leave pending (the human prompt).
- **Install:** merge a `permission` block into opencode config — `bash: "ask"` **and**
  `edit: "ask"` (opencode's `edit` covers edit/write/patch) for whichever tools are in scope
  — and start `auto-gate opencode watch`. Port discovery and supervision are **resolved** (§15 #1, #2).
- **Port discovery — resolved: launcher-known port.** The port is *injected, never discovered*: the
  `auto-gate opencode run` wrapper picks it and sets `AUTO_GATE_OPENCODE_PORT`; a user-started server
  is attached with `auto-gate opencode watch --port N`. squadrant already injects the equivalent
  because *it* launches `opencode --port <N>` (`sse-bridge.ts:3,58-80`). Process-table/lockfile
  discovery is **deferred** (§15 #1).
- **Subscriber supervision — resolved: foreground + wrapper-as-supervisor.** `watch --port N` runs in
  the foreground and reconnects with backoff (existing bridge retries ~120 s — `sse-bridge.ts:29-42`);
  an unrecoverable error exits non-zero. The `run` wrapper starts the watcher as a **sibling child of
  the same launch**, so its lifetime tracks the crew. No self-daemonizing; crash fails open when
  **attended** (the native prompt answers), while **unattended** the wrapper terminates rather than
  hang (§15 #2, #4).
- **`userIntent` — resolved: reconstruct from SSE, ask when unknown.** The adapter reconstructs
  intent from preceding `message.*` SSE frames; when intent is expected but not yet known the
  auto-allow path does **not** fire and the outcome is `ask` (see §6.2.1, §7, §15 #3).
- **No-human `ask` — resolved: `onAsk` notification + timeout → deny.** Interactive TTY leaves the
  native prompt pending; unattended fires the `onAsk` hook (the #560 analogue) and denies on timeout.
  Audited + logged + notified, never silent (§15 #4).
- **Tool scope — resolved: set-valued aliases.** opencode's lowercase names map onto the canonical
  claude-shaped scope via a set-valued `toolAliases` map (§12, §15 #6) — `edit` →
  `["Edit","Write","MultiEdit"]`.
- **Caveat:** the `permission.ask` plugin hook is declared but never fired upstream
  (#7006/#19469 closed *not planned*), so a pure plugin is not a viable gate today. Track
  it: if it lands, the opencode adapter can move in-process.

### codex (v2)
- **Extension point:** the **hooks config** uses PascalCase event keys —
  `~/.codex/hooks.json` / `config.toml [hooks]` with `PermissionRequest` (and `PreToolUse`
  for pre-emptive deny). (The vendored *app-server protocol* enum is camelCase —
  `preToolUse` / `permissionRequest` — `vendor/codex-protocol/v2/HookEventName.ts:5`; do not
  conflate the two surfaces.)
- **Output:** for codex, `permissionDecision` / `hookSpecificOutput.decision.behavior` with
  `allow|deny|ask`; `permission_request` allow/deny bypasses the approval UI, `ask` keeps
  it. (U7's note that `permissionDecision` is `PreToolUse`-only applies to **claude**, not
  codex — codex's hooks doc consumes permission decisions for both `pre_tool_use` and
  `permission_request`.)
- **Integration seam caveat:** squadrant's current codex path is the **app-server**
  (`onServerRequest`, `driver.ts:233-267`) with `approvalPolicy: rec.approvalPolicy ??
  "never"` (`driver.ts:113`) — *not* `hooks.json`. So a codex gate is not a drop-in hook
  install; it either (a) uses the codex hooks config, which requires `approvalPolicy` to be
  raised off `"never"` for `PermissionRequest` to fire, or (b) answers the app-server's
  approval server-requests directly (a different adapter shape from claude/opencode). This
  is why codex is v2.
- **Install:** write the hook + ensure `features.hooks = true`; hooks require user trust
  (`/hooks`). More live-smoke surface than claude/opencode.

### gemini (v2)
- **Extension point:** `BeforeTool` hook in `~/.gemini/settings.json`.
- **Output:** `decision: allow|deny|ask` (ask implemented, undocumented — #28046).
- **Note:** CLI → Antigravity migration; revisit before building.

### Install / uninstall semantics (all agents)
- **Idempotent, non-clobbering, marker-based.** The installer records each entry it wrote
  (command string / config key) so `uninstall` reverses **only its own** entries and never
  a user's or another tool's hook.
- **Ownership is symmetric** (see claude above): each side detects and yields to the other.
- **`auto-gate doctor`** reports which agents are detected, which hooks are installed, whether
  they are owned by `auto-gate` or another manager, and any drift.
- **Backups** before every settings write; a malformed settings file is never blind-reset.
- **Rollback:** `uninstall` restores the pre-install config (backup) so the agent falls back
  to its native permission flow — claude to the normal dialog, opencode to the prior
  `permission` block. The restore contract is an open question (§15 #14).

---

## 12. Config, keys, observability, security

### Config resolution chain (single source of truth at runtime)
1. Explicit `--config` / env-injected path.
2. Repo `.auto-gate.json`.
3. User `~/.config/auto-gate/config.json`.
4. Built-in defaults.

Squadrant **projects** its `defaults.gate` onto this schema and passes the resolved config
to the package, so there is one runtime and one precedence ladder. The portable file is
optional for squadrant users.

```jsonc
{
  // Standalone default is "on" (deliberate — a user who installs a gate wants
  // it on). This DIFFERS from squadrant's defaults.gate.mode default of "auto"
  // (documented at shared/config.ts:112-113; applied at permission-gate.ts:131),
  // which is a no-op; squadrant keeps its own default.
  "mode": "on",                       // on | off | auto
  "agents": {                         // per-agent enable; unset agents are not gated
    "claude": { "enabled": true },
    "opencode": { "enabled": true }
  },
  "classifier": {
    // "jev" = Jev is the classifier; "generative" = Jev is skipped and the
    // generative model is the ONLY classifier. Either way, if the selected
    // classifier fails the gate MAY try the other as a fallback (subject to the
    // hook timeout, §6.1). "generative" alone with fallbackAcceptsVerdict:false
    // always asks — see §7.
    "kind": "jev",
    "jev": {
      "model": "jev-latest",          // pin "jev-1.13.0" once thresholds are tuned
      "baseUrl": "https://api.typesafe.ai",
      "apiKeyEnv": "TYPESAFE_API_KEY",
      "timeoutMs": 4000
    },
    "generative": {                   // fallback tier, any provider
      "baseUrl": "https://…", "model": "…", "apiKeyEnv": "…", "timeoutMs": 3000
    }
  },
  "policy": {
    "name": "strict",                 // strict | balanced | permissive
    "reviewThreshold": 0.35, "actionThreshold": 0.80,
    "allowThreshold": 0.80, "denyThreshold": 0.75,
    "minConfidence": 0.75, "intentThreshold": 0.50,
    "reviewSeverity": 1.0, "severityBlock": 2.0,
    "fallbackAcceptsVerdict": false,
    // Per-question overrides (never one shared threshold across Choice and Noul).
    "hazards": {
      "destructive": { "review": 0.35, "action": 0.80, "vetoesAllow": true },
      "secrets":     { "review": 0.35, "action": 0.80, "vetoesAllow": true },
      "scope_escape":{ "review": 0.35, "action": 0.80, "vetoesAllow": true },
      "intent_match":{ "allowFloor": 0.50, "vetoesAllow": false }
    }
  },
  "tools": ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"],
  // Per-agent tool-name normalization: the canonical scope list above is
  // claude-shaped; each adapter maps its own names onto it. Aliases are
  // SET-VALUED (native name -> set of canonical names). opencode's `edit`
  // permission covers edit/write/patch (there is no separate `write` tool),
  // so `edit` maps onto the canonical Edit/Write/MultiEdit set; therefore
  // `tools: ["Write"]` still puts opencode's `edit` in scope. Bump
  // `toolAliasesVersion` when the map changes (ratifiable, versioned).
  "toolAliasesVersion": 1,
  "toolAliases": {
    "opencode": { "bash": ["Bash"], "edit": ["Edit", "Write", "MultiEdit"] }
  },
  "deny": ["^\\s*sudo\\b"],            // optional; REPLACES the built-in Tier-1 set
  // §15 #4: the unattended `ask` path. `onAsk` is a shell command run with
  // AUTO_GATE_TOOL/PATTERNS/CWD/SESSION/GATE_ID in the env (null = notify nothing);
  // after `timeoutMs` with no human answer the gate DENIES, audited as
  // tier:"timeout", reason:"ask-timeout". Attendance is an explicit marker set by
  // interactive launchers (AUTO_GATE_ATTENDED=1) — never TTY sniffing.
  "ask": { "onAsk": null, "timeoutMs": 120000 },
  "cache": true,
  "audit": { "path": "~/.auto-gate/decisions.jsonl" }
}
```

**Named policy presets** (each is a full set of the knobs above; `strict` is the default):

| Knob | strict | balanced | permissive |
|---|---|---|---|
| `reviewThreshold` | 0.35 | 0.35 | 0.35 |
| `actionThreshold` | 0.80 | 0.80 | 0.85 |
| `allowThreshold` | 0.80 | 0.75 | 0.70 |
| `denyThreshold` | 0.75 | 0.80 | 0.85 |
| `minConfidence` | 0.75 | 0.65 | 0.55 |
| `intentThreshold` | 0.50 | 0.40 | 0.30 |
| `reviewSeverity` | 1.0 | 1.0 | 1.0 |
| `severityBlock` | 2.0 | 2.0 | 2.0 |

`balanced`/`permissive` lower the auto-allow bar and raise the auto-deny bar; the
`reviewThreshold`/severity floors stay fixed because they are the "at least ask" safety
line. Per-hazard overrides in `policy.hazards` are applied **after** the preset and are
per-question by construction.

**Keys:** `TYPESAFE_API_KEY` env → config → key file. Never logged, never written to the
audit log. v1 non-goal: credential pools.

### Observability
- JSONL audit at `~/.auto-gate/decisions.jsonl` (0600): `ts`, `agent`, `tool`, `cwd`,
  `decision`, `verdict`, `probabilities`, `hazard probabilities`, `severity`, `confidence`,
  `tier`, `classifier`, `cacheHit`, `latencyMs`, `inputTokens`, `redactions`.
  **Never** raw secrets; payload logged redacted/hashed.
- Diagnostics go to **stderr only** — hook stdout is machine-parsed and a stray byte breaks
  the decision parse (the U7 lesson about provider probes and hook-output purity).
- `auto-gate stats` summarizes decisions/costs/cache-hit rate.

### Security
- Minimal, redacted state to Jev; local-only Tier-1 tier runs even with the network down.
- Audit 0600; config dir 0700.
- Jev is a **judgment aid, not the sole security boundary** (jaggedness: adversarial
  content can steer it). **The backstop against steering is Tier-1 static deny only** — the
  hazard floors (`destructive.noul`, `secrets.noul`, …) are themselves Jev outputs and are
  therefore *not* independent of a steered model. Redaction protects secrets from leaving
  the machine; it does not protect the *decision*. The real defense-in-depth is: Tier-1
  static deny (model-free) + structured/fenced state so injected instructions cannot
  masquerade as ours + conservative thresholds + the option to route high-severity actions
  to a human. Do not describe the hazard floors as an independent backstop.

---

## 13. Failure modes / what it catches and misses

| Catches | Misses / limits |
|---|---|
| Canonical dangerous shell at ~0 ms (Tier-1) | Semantic danger with no static signature (Tier-2 dependent) |
| Sensitive-path writes at ~0 ms | Obfuscated commands the regex doesn't see (base64/`eval`) |
| Ambiguous side-effectful tools via Jev, with calibrated confidence | Jev misses on literal/multi-hop/numeric cases — mitigated by atomic questions + code-side math |
| Exact repeat commands in the same cwd (cache) | Commands differing only by whitespace/quoting — the key hashes the payload verbatim (not "canonicalized"), so these are distinct entries |
| Jev unreachable → `ask` (never silent deny) | A mis-tuned threshold could auto-allow a low-frequency danger — mitigated by conservative defaults + hazard vetoes |
| Prompt-injection into a payload cannot smuggle instructions into policy | Jev can still be steered by adversarial *state*; the only model-independent backstop is **Tier-1 static deny** (hazard floors are Jev outputs, not independent) |

---

## 14. Comparison

| | Native claude `auto` | U7 (generative on router) | Jev-backed auto gate |
|---|---|---|---|
| Model | Claude Sonnet 5 (hardcoded) | configurable router model | Jev typed (default) + generative fallback |
| Credential | Anthropic account | router credential | `TYPESAFE_API_KEY` (no Anthropic needed) |
| Output | server-side classify | one-word text → parse | typed verdict + probabilities + confidence |
| Ambiguity | built-in behavior | always `ask` | **threshold-gated auto-resolve**, else `ask` |
| Truncation risk | — | reasoning model truncates → always `ask` | none (no text generation) |
| Latency / cost | server-side | model-dependent | 70–500 ms · $0.042/Mtok in, output free |
| Agents | claude | claude | claude + opencode (v1); extensible to all |
| Failure mode | **fails closed** → silent deny | fail-open to `ask` | fail-open to `ask` |

---

## 15. Open questions

**Blocking v1 — RESOLVED (2026-09-21).** Brainstormed and decided before implementation; these
resolutions are **normative** and supersede any conflicting prose elsewhere in this document.

1. **opencode port discovery — RESOLVED: launcher-known port (no discovery).**
   The port is never *discovered*; it is *injected by whoever launches opencode*. The rollout wrapper
   `auto-gate opencode run` picks the port and sets `AUTO_GATE_OPENCODE_PORT`; a server the user
   started themselves is attached via `auto-gate opencode watch --port N`. squadrant injects the
   equivalent env (it already computes the port). Rationale: the gate's value is determinism —
   attaching to the wrong server means answering *another crew's* prompts, a security-relevant
   failure, not a UX wart. Process-table / lockfile discovery is **deferred**.
   **Details (normative):** precedence is explicit `--port N` > `AUTO_GATE_OPENCODE_PORT` > hard error
   (`exit 4`) — there is **no default port**, since a fixed default would collide across concurrent
   crews. The `run` wrapper allocates `N` by a short bind-probe on `:0`, passes `opencode --port N`,
   and exports `AUTO_GATE_OPENCODE_PORT=N`. `auto-gate opencode run` / `watch` are added to the §3
   bin contract.
2. **opencode subscriber supervision — RESOLVED: foreground watcher + wrapper-as-supervisor.**
   `auto-gate opencode watch --port N` runs in the **foreground**, reconnects itself, and exits
   non-zero on an unrecoverable error. The `opencode run` wrapper starts the watcher as a **sibling
   child of the same launch**, so its lifetime tracks the crew. **No self-daemonizing**; the installer
   may *print* a sample launchd/systemd unit but must not write one.
   **Details (normative):** reconnect backoff is 500 ms initial → ×2 → 30 s cap (the *existing* fleet
   bridge is a fixed 500 ms × 240 attempts — `sse-bridge.ts:29-42` — and is not the model here).
   "Unrecoverable" = the server is continuously unreachable for **120 s** (boot deadline) or the port
   answers non-opencode. Exit codes: `0` clean shutdown, `3` unrecoverable, `4` config error. `run`
   places opencode and the watcher in **one process group**: watcher exit ⇒ SIGTERM opencode and exit
   with the watcher's code; opencode exit ⇒ SIGTERM the watcher. **Fails-open is refined by
   attendance** (see #4): attended ⇒ the native prompt is the answerer when the watcher dies;
   unattended ⇒ the wrapper terminates (never hang). This resolves the review's fails-open-vs-#4
   contradiction.
3. **opencode `userIntent` — RESOLVED: reconstruct from SSE, and `ask` when unknown.**
   The adapter reconstructs intent from preceding `message.*` SSE frames on the same session. When
   intent is **expected but not yet known** the allow rule does **not** pass and the outcome is `ask`
   — never a silent auto-allow on unknown intent. This resolves the §6.2.1/§7 contradiction: "absent"
   no longer satisfies the allow rule's intent floor unconditionally.
   **Details (normative):** the adapter contract gains
   `intentSupport: "available" | "pending" | "unsupported"` (the existing `userIntent?: string | null`
   cannot distinguish "unknown" from "permanently unavailable"). Policy: `available` ⇒ require
   `≥ intentThreshold`; `pending` ⇒ force `ask`; `unsupported` ⇒ omit `intent_match` (v2 codex/gemini
   only). A "human frame" is a `message.*` / `message.part.*` frame whose role is `user` and which is
   not a tool result; the **last** such frame per session wins, truncated by U7's existing rule.
   `pending` is the initial state for any adapter that supports intent.
4. **opencode `ask` with no human — RESOLVED: `onAsk` notification + timeout → deny.**
   Attendance split: with a human present, `ask` leaves the native prompt pending (no timeout).
   Unattended fires the `onAsk` hook — the standalone analogue of squadrant's #560 blocked signal —
   and on timeout **denies**. The timeout-deny is always audited + logged + notified, **never silent**,
   so §16.3 holds.
   **Details (normative):** new config `ask: { onAsk: "<command string>", timeoutMs: 120000 }`.
   `onAsk` runs as a shell command with `AUTO_GATE_TOOL`, `AUTO_GATE_PATTERNS`, `AUTO_GATE_CWD`,
   `AUTO_GATE_SESSION`, `AUTO_GATE_GATE_ID` in the env; unset ⇒ no notification but the timeout still
   applies. Attendance is an **explicit marker** (`AUTO_GATE_ATTENDED=1`, set by interactive
   launchers), never TTY sniffing — the watcher's TTY is not the crew's TTY. The timeout→deny is
   audited as `tier: "timeout"`, `reason: "ask-timeout"` (no classifier assessment).
5. **Symmetric claude-hook ownership — RESOLVED: conditional precedence.**
   `auto-gate install` detects squadrant's managed entry and defers. squadrant's `installClaudeHooks`
   detects a foreign `auto-gate decide --agent claude` entry and removes it **only when squadrant's
   own gate actually fires and it installs its own hook** — i.e. `defaults.gate.mode === "on"`
   (`"auto"` is a documented no-op, §10/§12, so it must NOT trigger removal). Otherwise there is no
   conflict and the foreign entry is **left untouched**.
   **Details (normative):** the installer writes a trailing marker ` # auto-gate-managed` into its
   hook command; detection matches the parsed argv basename `auto-gate` **or** the marker, so it
   survives `npx @squadrant/auto-gate …` / `node <path> …` forms. Every removal is recorded as
   `{ts, action: "removed-foreign-gate", command}` in the daemon log **and** the audit JSONL. If the
   entry is present but not removable (malformed settings, shared matcher, write failure) the
   installer writes **no** squadrant hook (avoiding a double owner), logs an error, and surfaces it as
   `squadrant config check` drift. This honors the §11/§16.8 rule that squadrant wins when both
   are present, without
   the unconditional-clobber side effect.
6. **Tool-name normalization — RESOLVED: set-valued aliases, claude-shaped canonical.**
   The canonical scope stays claude-shaped (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`) so
   U7's config contract survives (§16.1). Aliases are **set-valued** (native name → *set* of
   canonical names), because opencode's `edit` permission covers edit/write/patch with no separate
   `write`: `opencode: { bash: ["Bash"], edit: ["Edit","Write","MultiEdit"] }`. Scope match succeeds
   when *any* canonical name in the set is in scope. (Fixes the §12 prose/example contradiction: the
   prose was right, the 1:1 example was wrong.)
   **Details (normative):** a native name with no alias entry is **out-of-scope** (the gate yields;
   the agent's native permission flow applies) and `auto-gate doctor` warns on unmapped names observed
   in practice. `toolAliasesVersion` is owned by the package and **joins the §9 cache key**, so
   changing the alias map invalidates cached decisions (as originally written it had no consumer and
   was decorative).
7. **opencode single-owner of the permission event — RESOLVED: per-server lockfile.**
   *(New blocking item found in review — it was not one of the original six.)* §16.8 mandates
   single-owner of the permission event per agent, enforced symmetric. #1/#2 introduce an
   `auto-gate opencode watch` subscriber that coexists with squadrant's own bridge
   (`sse-bridge.ts:73-120`); both can subscribe to `permission.asked` and both can answer it, with no
   protocol to prevent a race. **Resolution:** extend the single-owner protocol to opencode via a
   **per-server lockfile keyed by `host:port`**. The lock owner is the only client permitted to
   *answer* `permission.asked`; a non-owner may observe (and forward for audit/notify) but must never
   post a decision. `auto-gate` acquires it before answering; squadrant's bridge does the same; the
   loser yields (symmetric, mirroring #5).
   **Details (normative):** the lock path is
   `<os.tmpdir()>/auto-gate-opencode-<sha256(host:port).slice(0,16)>.lock`, mirroring the #830
   Telegram poll-lock shape. Acquisition is atomic `open(path, "wx")` (`O_EXCL`) with the owner pid
   written into the file. Staleness: a lock whose owner pid is dead (or unreadable and older than
   2 min) is reclaimed at most once per attempt, then re-acquired. Contention is **permanent yield**,
   not wait — a non-owner never retries in a loop; it degrades to observe-only and logs once. A
   non-owner may still subscribe to the SSE stream for audit/notify but must never POST a decision;
   if the owner disappears, the non-owner re-attempts acquisition on the **next** `permission.asked`
   only. This makes both the happy path and stale-reclaim deterministically testable.

**Non-blocking:**

8. **Alternate Jev transports** — OpenRouter (`typesafe/jev-1.13`, `/api/alpha/decisions`)
   and Vercel AI Gateway (`typesafe-ai/jev`, `experimental_evaluate`) are **unverified**;
   confirm against official docs before supporting. Third-party resellers are not official.
9. **codex seam** — hooks config (needs `approvalPolicy` off `"never"` + trust) vs answering
   the app-server approval server-requests directly. Different adapter shapes; pick in v2.
10. **gemini → Antigravity** — does the migration preserve `BeforeTool` hooks / the policy
    engine?
11. **Default model pin** — `jev-latest` (auto-upgrade) vs `jev-1.13.0` (reproducible). Ships
    `jev-latest`; recommend pinning once thresholds are tuned.
12. **Cost telemetry** — report `inputTokens` per decision and a running estimate? (No local
    price table in v1.)
13. **Cross-agent projection** — should `GateRequest`/`GateAssessment` live in
    `@squadrant/shared` for the multi-agent projection layer (issue #31), or stay owned by
    the standalone package with a thin re-export?
14. **Uninstall/rollback** — after `auto-gate uninstall`, does the agent fall back cleanly to
    its native permission flow (claude: dialog; opencode: whatever `permission` block was
    restored)? Define the restore contract.

---

## 16. Decisions already made — do not re-litigate

1. **Standalone-first** npm package (`@squadrant/auto-gate`); squadrant consumes it. The
   claude path preserves U7's **hook contract and acceptance tests**, not byte-for-byte
   source: extraction must bridge the config surface, transcript-path derivation, and #560
   event mapping that currently live in `@squadrant/shared`/`@squadrant/agents` (see §3).
2. **`GateClassifier` returns an assessment, not a decision**; the policy engine owns
   thresholds. Agent-agnostic from day one, even though v1 ships only claude + opencode.
3. **Default posture: threshold-gated auto-resolve, fail-open to `ask`.** Never a silent
   deny.
4. **Jev is the default classifier; a generative classifier is the fallback tier** and must
   not weaken the gate (confidence treated as *absent*, so it asks unless
   `fallbackAcceptsVerdict: true`).
5. **Tier-1 static deny stays** as the ~0 ms, model-free first pass; operator `deny`
   replaces the built-in set. There is no Tier-1 static *allow* (the agent's own permission
   allowlist already handles the obvious-safe fast path before the hook fires).
6. **Injection-safe state + redaction**; Jev is not a security boundary, and the hazard
   floors are not an independent backstop (only Tier-1 static is).
7. **Policy knobs are per-question**; never carry a Noul-tuned threshold onto a Choice, and
   never do arithmetic in a question. `policyVersion` is a hash of the resolved policy and
   participates in the cache key.
8. **Single-owner of the permission event per agent**, enforced **symmetric**: the
   standalone defers to squadrant, and squadrant must remove a foreign gate entry. Installers
   are idempotent, non-clobbering, marker-based. (squadrant's removal is **conditional** — it
   applies only while squadrant's own gate is actually enabled, `mode === "on"`; see §15 #5. For
   **opencode**, single-owner is enforced by a per-server `host:port` lockfile — see §15 #7.)
9. **v1 targets claude + opencode**; codex and gemini adapters land in v2 behind the same
   interface.
