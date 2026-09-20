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
- **Price:** $0.042 / Mtok input; output free. Early access / waitlist; closed managed API
  (no self-host).
- **SDKs:** `@typesafe-ai/sdk` (Node ≥20), `typesafe-sdk` (Python ≥3.10); env
  `TYPESAFE_API_KEY`. A drop-in TypeSafe **agent skill** is published for agent harnesses.
- **Confidence** is a 0..1 statistic derived from the probability distribution (concentrated
  = high). TypeSafe's docs recommend three bands — high = act, medium = confirm/review,
  low = route to human — and warn thresholds scale with risk.

### 2.2 Jev jaggedness (verified — drives the policy design)

`jev-1.13` is fast and well-calibrated but **literal, non-numeric, and steerable**:

| Failure mode | Design consequence |
|---|---|
| Literal reading | Write each criterion as the exact condition; put boundary cases in `criteria`. |
| No arithmetic / counting | **All threshold math lives in code**, never in a question. |
| No date/time comparison | Extract in a Choice; compare/order in code. |
| Weak at indirection / multi-hop | Ask one atomic question per dimension; combine in code. |
| Context-rot on irrelevant state | Send the **minimum** state; filter in code first. |
| Adversarially steerable (state is not hostile by default) | **Jev is not a security boundary.** Injection-safe state + Tier-1 static deny + hazard floors + redaction backstop it. |
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
  `auto-gate uninstall`, `auto-gate doctor`, `auto-gate test`, `auto-gate stats`.
- `@squadrant/core` depends on the core module and keeps `squadrant gate claude
  permission-request` as a **thin wrapper** — the claude path and its U7 acceptance
  criteria are preserved byte-for-byte.
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
│  Tier-1 static policy (model-free deny/allow, ~0 ms)              │
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
  ├─ Tier-1 static allow matches ─────────────────────► allow (~0 ms, no network)
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
  tier: 1 | 2;
  usage?: { inputTokens?: number };
}

interface GateRequest {
  agent: "claude" | "opencode" | "codex" | "gemini" | string;
  toolName: string;
  toolPayload: string;        // bare executable payload (command / path+content)
  cwd: string;
  userIntent?: string | null; // last HUMAN message text, text blocks only
  permissionMode?: string;    // agent's permission mode, if any
  sessionKind: "crew" | "side" | "captain" | "standalone";
  raw?: unknown;              // the adapter's original payload, for audit only
}

interface GateClassifier {
  readonly id: string;
  /** MUST never throw — any failure resolves to an `ask` assessment. */
  classify(req: GateRequest): Promise<GateAssessment>;
}
```

---

## 6. Jev integration

### 6.1 Transport
`POST https://api.typesafe.ai/v1/systemone`, Bearer `TYPESAFE_API_KEY`, one request per
decision. Timeout budget ~5 s (Jev responds in 70–500 ms; the headroom covers 429/529
backoff-free retry). 429/529 → single exponential retry (SDK default), then `ask`.

### 6.2 State (injection-safe, minimal)
Send a structured object, never a prose blob. State is **data**, never instructions:

```json
{
  "user_intent": "<last human user message, text blocks only, truncated>",
  "tool": { "name": "Bash", "input": { "command": "git push --force" } }
}
```

- Redact secret patterns (bearer tokens, `gh[pousr]_…`, `sk-…`, `AKIA…`, `.env` values,
  key-file contents) before sending.
- Cap total state size; prefer the terse subset, because Jev suffers context-rot on
  irrelevant detail.
- The tool payload is the bare executable field only (U7's `extractToolPayload`); tool
  outputs and surrounding fields never reach the classifier.

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
| `severityBlock` | 2.0 | severity Score that upgrades a review to a block |

**Rules (precedence: deny > ask > allow):**
- **deny** if `P(deny) ≥ denyThreshold`, **or**
  `(destructive.noul ≥ actionThreshold ∧ severity ≥ severityBlock)`, **or**
  `(secrets.noul ≥ actionThreshold ∧ scope-risk)`, **or** a Tier-1 static rule matches.
- **allow** if `P(allow) ≥ allowThreshold` **∧** `confidence ≥ minConfidence` **∧**
  `destructive.noul < reviewThreshold` **∧** `intent_match.noul ≥ intentThreshold` **∧**
  `secrets.noul < reviewThreshold`.
- **else ask.**

**Asymmetry (deliberate).** Auto-*allow* is the dangerous direction, so it gets the
highest bar plus a confidence floor and hazard vetoes. Auto-*deny* is recoverable but U7's
standing rule is "never a silent deny", so `deny` too requires a high bar; ambiguous
danger degrades to `ask`. Named policies `strict` / `balanced` / `permissive` adjust the
knobs together; per-hazard overrides are allowed and are defined **per question** (never a
single shared threshold carried across Choice and Noul — see jaggedness §2.2).

**Generative fallback.** The generative classifier yields only `allow|deny|ask` with no
probabilities/confidence. Under the fallback the policy treats `confidence = 0` and
`probabilities` absent, so only a decisive verdict under an explicit
`fallbackAcceptsVerdict: true` (default false) is honored; otherwise it degrades to `ask`.
This keeps the fallback from **weakening** the gate relative to U7.

**Version pinning.** `policyVersion` and the Jev model id participate in the cache key, so
a threshold or model change invalidates prior decisions automatically.

---

## 8. Failure policy

**Fail open to `ask`. Always.** Any of: missing/invalid key (`401`), malformed request
(`422`), rate limit (`429`), overload (`529`), network/timeout, an unparseable or
missing answer, a Choice tie, or confidence below floor → `ask`, which shows the agent's
normal prompt and preserves blocked-signalling. This is U7's explicit acceptance
criterion, inverted from Claude's built-in fail-**closed** behavior: for an unattended
crew a silent deny is a dead session; an `ask` is a captain notification.

If a generative fallback is configured and Jev fails, the gate MAY try the fallback and
then `ask`. It never fails closed.

---

## 9. Cache

- **Key:** `sha256(agent + "\n" + toolName + "\n" + cwd + "\n" + canonicalPayload + "\n" +
  policyVersion + "\n" + classifierId + "\n" + model)`.
- **Only conclusive outcomes are cached** (`allow`/`deny`); `ask` and failures are not.
- **TTL** 10 min, **max** 500 entries, atomic write (temp + rename), 0600.
- Stored at `~/.auto-gate/gate-cache.json` (standalone) or the squadrant state dir when
  consumed by squadrant.
- `cwd` in the key means an identical command in a different repo cannot reuse a decision.

---

## 10. Scoping — which sessions the gate owns

Explicit **positive** session markers; **never** the operator's own interactive session.

- Standalone: `AUTO_GATE_SESSION=1` (generic marker) and/or `AUTO_GATE=on`.
- squadrant: existing markers are honored through the adapter predicate —
  `SQUADRANT_CREW_TASK_ID`, `SQUADRANT_SIDE_SESSION=1`, `SQUADRANT_ROLE=captain`,
  `SQUADRANT_GATE`. One predicate, so the wrapper and the core can never disagree (the
  U7 lesson: the scoping predicate must be single-source).
- The gate only fires where a permission prompt would appear; `permission_mode === "auto"`
  yields to the agent's built-in classifier (claude), preserving the migration lever.

---

## 11. Cross-agent install matrix

### claude
- **Extension point:** `PermissionRequest` hook.
- **Output:** `hookSpecificOutput.decision.behavior` — `allow`/`deny`; **`ask` = emit
  nothing** (no `ask` behavior exists). On `ask`/yield, fall back to the #560
  `task.blocked` signal.
- **Install:** idempotent, non-clobbering merge into `~/.claude/settings.json` (reuse U7's
  installer shape; namespaced command `auto-gate decide --agent claude`).
- **Coexistence:** if squadrant's managed `squadrant gate claude permission-request` is
  present, the standalone installer **defers** rather than adding a second owner — two
  handlers cannot coordinate and a duplicate auto-approval could race a blocked-signal
  (U7 decision 4).

### opencode
- **Extension point:** native `permission` rules (`bash: "ask"`) + SSE
  `permission.asked` / `permission.replied`; answer the crew's server with
  `POST /session/{sessionID}/permissions/{permissionID}` `{response:"once"|"reject"}`.
- **Output:** `once` (allow) / `reject` (deny); "ask" = leave pending (the human prompt).
- **Install:** merge a `permission` block into opencode config, and run
  `auto-gate opencode watch` — a small subscriber process. (The daemon may host the
  subscriber when squadrant is present; standalone needs it as a foreground/subprocess.)
- **Caveat:** the `permission.ask` plugin hook is declared but never fired upstream
  (#7006/#19469 closed *not planned*), so a pure plugin is not a viable gate today. Track
  it: if it lands, the opencode adapter can move in-process.

### codex (v2)
- **Extension point:** `hooks.json` / `config.toml [hooks]`, `PermissionRequest` (and
  `PreToolUse` for pre-emptive deny).
- **Output:** `permissionDecision` / `hookSpecificOutput.decision.behavior` with
  `allow|deny|ask`; `permission_request` allow/deny bypasses the approval UI, `ask` keeps it.
- **Install:** write the hook + ensure `features.hooks = true`; hooks require user trust
  (`/hooks`). More live-smoke surface than claude/opencode — deferred to v2.

### gemini (v2)
- **Extension point:** `BeforeTool` hook in `~/.gemini/settings.json`.
- **Output:** `decision: allow|deny|ask` (ask implemented, undocumented — #28046).
- **Note:** CLI → Antigravity migration; revisit before building.

### Install / uninstall semantics (all agents)
- **Idempotent, non-clobbering, marker-based.** The installer records each entry it wrote
  (command string / config key) so `uninstall` reverses **only its own** entries and never
  a user's or another tool's hook.
- **`auto-gate doctor`** reports which agents are detected, which hooks are installed, whether
  they are owned by `auto-gate` or another manager, and any drift.
- **Backups** before every settings write; a malformed settings file is never blind-reset.

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
  "mode": "on",                       // on | off | auto
  "agents": {                         // per-agent enable; unset agents are not gated
    "claude": { "enabled": true },
    "opencode": { "enabled": true }
  },
  "classifier": {
    "kind": "jev",                    // jev | generative
    "jev": {
      "model": "jev-latest",          // pin "jev-1.13.0" once thresholds are tuned
      "baseUrl": "https://api.typesafe.ai",
      "apiKeyEnv": "TYPESAFE_API_KEY"
    },
    "generative": {                   // fallback tier, any provider
      "baseUrl": "https://…", "model": "…", "apiKeyEnv": "…"
    }
  },
  "policy": {
    "name": "strict",
    "reviewThreshold": 0.35, "actionThreshold": 0.80,
    "allowThreshold": 0.80, "denyThreshold": 0.75,
    "minConfidence": 0.75, "intentThreshold": 0.50, "severityBlock": 2.0,
    "fallbackAcceptsVerdict": false
  },
  "tools": ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"],
  "deny": ["^\\s*sudo\\b"],            // optional; REPLACES the built-in Tier-1 set
  "cache": true,
  "audit": { "path": "~/.auto-gate/decisions.jsonl" }
}
```

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
  content can steer it). Tier-1 static deny + hazard floors + optional high-severity review
  are the backstop. State is fenced/structured so injected instructions in a payload cannot
  masquerade as our instructions.

---

## 13. Failure modes / what it catches and misses

| Catches | Misses / limits |
|---|---|
| Canonical dangerous shell at ~0 ms (Tier-1) | Semantic danger with no static signature (Tier-2 dependent) |
| Sensitive-path writes at ~0 ms | Obfuscated commands the regex doesn't see (base64/`eval`) |
| Ambiguous side-effectful tools via Jev, with calibrated confidence | Jev misses on literal/multi-hop/numeric cases — mitigated by atomic questions + code-side math |
| Exact repeat commands in the same cwd (cache) | Commands differing only by whitespace/quoting (hash differs) |
| Jev unreachable → `ask` (never silent deny) | A mis-tuned threshold could auto-allow a low-frequency danger — mitigated by conservative defaults + hazard vetoes |
| Prompt-injection into a payload cannot smuggle instructions into policy | Jev can still be steered by adversarial *state* — Tier-1 + floors are the backstop |

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

1. **Alternate Jev transports** — OpenRouter (`typesafe/jev-1.13`,
   `/api/alpha/decisions`) and Vercel AI Gateway (`typesafe-ai/jev`,
   `experimental_evaluate`) are **unverified**; confirm against official docs before
   supporting. Third-party resellers are not official.
2. **Claude-hook single ownership** — when squadrant *and* the standalone gate are both
   installed, who owns `PermissionRequest`? Proposed: first-owner-wins with a defer rule
   (squadrant's entry wins), surfaced by `auto-gate doctor`.
3. **opencode subscriber lifecycle** — a long-lived subscriber outside the daemon is
   heavier than a hook; how is it supervised? Does a future `permission.ask` plugin hook
   land upstream?
4. **codex trust UX** — `features.hooks = true` + `/hooks` review is friction; is it
   acceptable for crew spawns, or does it need a managed-config path?
5. **gemini → Antigravity** — does the migration preserve `BeforeTool` hooks / the policy
   engine?
6. **Default model pin** — `jev-latest` (auto-upgrade) vs `jev-1.13.0` (reproducible). Ships
   `jev-latest`; recommend pinning once thresholds are tuned.
7. **Cost telemetry** — report `inputTokens` per decision and a running estimate? (No local
   price table in v1.)
8. **Cross-agent projection** — should `GateRequest`/`GateAssessment` live in
   `@squadrant/shared` for the multi-agent projection layer (issue #31), or stay owned by
   the standalone package with a thin re-export?

---

## 16. Decisions already made — do not re-litigate

1. **Standalone-first** npm package (`@squadrant/auto-gate`); squadrant consumes it; the claude
   wrapper preserves U7 byte-for-byte.
2. **`GateClassifier` returns an assessment, not a decision**; the policy engine owns
   thresholds. Agent-agnostic from day one, even though v1 ships only claude + opencode.
3. **Default posture: threshold-gated auto-resolve, fail-open to `ask`.** Never a silent
   deny.
4. **Jev is the default classifier; a generative classifier is the fallback tier** and must
   not weaken the gate (confidence treated as 0).
5. **Tier-1 static deny stays** as the ~0 ms, model-free first pass; operator `deny`
   replaces the built-in set.
6. **Injection-safe state + redaction**; Jev is not a security boundary.
7. **Policy knobs are per-question**; never carry a Noul-tuned threshold onto a Choice, and
   never do arithmetic in a question.
8. **Single-owner of the permission event per agent**; installers are idempotent,
   non-clobbering, marker-based, and defer to squadrant's managed hook.
9. **v1 targets claude + opencode**; codex and gemini adapters land in v2 behind the same
   interface.
