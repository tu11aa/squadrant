# Router/Transport U1 (RouterShim) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daemon-internal, loopback Anthropic-Messages reverse proxy (`RouterShim`) that forwards Claude Code traffic to any Anthropic-compatible upstream, sanitizing reasoning-replay and Anthropic-only fields, and recording usage/cost.

**Architecture:** A `node:http` server inside `@squadrant/core` (`packages/core/src/router/`). It authenticates a daemon-minted bearer token, forwards `POST /v1/messages` to a configured upstream (opencode-go by default), passes SSE through byte-for-byte while teeing usage, normalizes `thinking` block signatures, strips Anthropic server-side tools/fields for non-Anthropic upstreams, and re-emits errors as the Anthropic error envelope. It is inert until U2 wires config and U3 injects env.

**Tech Stack:** TypeScript (Node 24), `node:http`, `node:stream`, global `fetch`, vitest. No new runtime dependencies.

**Issue / dependency map:**
- This plan is the implementation for **#773 (U1)**. It writes no GitHub issues.
- **U2 (#774)** owns config schema + daemon wiring (`config.router`, role `backend`, routing rules).
- **U3 (#775)** owns driver env injection (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY=""` / `ANTHROPIC_MODEL`).
- U4–U6 (#776–#778) are out of scope.
- Spec: `docs/specs/2026-09-11-router-transport-u1-design.md` (decisions 1–7 are locked; do not reopen).

**Scope guards:**
- Do NOT edit `packages/cli/src/squadrantd.ts` (that is U2 wiring).
- Do NOT edit any driver / `SpawnOptions` (that is U3).
- The only pre-existing file U1 modifies is `packages/core/src/index.ts` (add one export line).

---

## File Structure

All new files live under `packages/core/src/router/`:

| File | Responsibility |
|---|---|
| `types.ts` | Public types: `RouterUpstream` (incl. `authHeader` + `extraHeaders`), `RouterShimOptions`, `RouterShim`, `RouterUsage`, `RouterHealth`, `BackendMode`, `ThinkingPolicy` |
| `auth.ts` | Mint/parse/verify the per-project bearer token |
| `errors.ts` | Build the Anthropic error envelope |
| `sanitize.ts` | Outbound request stripping + thinking-block normalization (request and response) |
| `stream.ts` | SSE pass-through tee that extracts usage/cost; non-stream usage extraction |
| `shim.ts` | `createRouterShim()` — HTTP server, routing, forwarding, health |
| `index.ts` | Re-export the public surface |
| `__tests__/auth.test.ts` | Unit: token mint/parse/resolve |
| `__tests__/errors.test.ts` | Unit: error envelope |
| `__tests__/sanitize.test.ts` | Unit: stripping, cache passthrough, thinking normalize |
| `__tests__/stream.test.ts` | Unit: usage tee (byte-faithful, chunk boundaries) + JSON usage |
| `__tests__/shim.integration.test.ts` | Integration against a mock upstream (auth, non-stream, SSE, health, errors) |

Modified: `packages/core/src/index.ts` (one line: `export * from "./router/index.js";`).

**Focused test command:** `pnpm vitest run <path>` — full suite: `pnpm test`. Typecheck: `pnpm lint`.

---

## Phase 0 — BLOCKING GATE: live spike for decision (b)

> **This phase blocks Phase 6.** Do not implement signature normalization until the spike result is recorded below. The spike is throwaway and must be deleted after.

**Environment assumptions:** `OPENCODE_GO_KEY` is exported in the shell. The upstream is **opencode-go** (`https://opencode.ai/zen/go`), which speaks Anthropic Messages at `${base}/v1/messages`. Auth is the `x-api-key` header plus a **required** `x-opencode-session` header. The base URL must **NOT** contain `/v1` (Claude Code appends it; `/zen/go/v1` would become `/zen/go/v1/v1/messages` → 404). Verified live by the captain: raw HTTP → 200, `claude -p` → "pong".

- [ ] **Step 0.1: Smoke-test the opencode-go contract**

Run:
```bash
curl -sS https://opencode.ai/zen/go/v1/messages \
  -H "x-api-key: $OPENCODE_GO_KEY" \
  -H "x-opencode-session: spike-$(date +%s)" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","max_tokens":16,"messages":[{"role":"user","content":"say pong"}]}'
```
Expected: HTTP 200 with a JSON message whose `content[0].text` is roughly "pong". If this fails, fix the key/session header before proceeding.

- [ ] **Step 0.2: Baseline repro (no shim) — confirm the turn-2 failure**

Run Claude Code pointed straight at opencode-go:
```bash
export ANTHROPIC_BASE_URL="https://opencode.ai/zen/go" \
       ANTHROPIC_API_KEY="$OPENCODE_GO_KEY" \
       ANTHROPIC_CUSTOM_HEADERS="x-opencode-session: spike-baseline" \
       ANTHROPIC_MODEL="deepseek-v4.1-flash"
claude
```
In the session, perform a **3-turn tool-use** conversation:
1. `Read package.json and report the version.`
2. `Write that version into /tmp/spike-version.txt.`
3. ``Run `cat /tmp/spike-version.txt` and confirm.``

Expected (bug reproduced): turn 1 succeeds; turn 2 or 3 returns `API Error: 400 Provider returned error` (or `The content[].thinking ... must be passed back`). Record the exact error. If the bug does NOT reproduce, stop and re-read the spec — decision (b) may be unnecessary; note it and skip Phase 6.

- [ ] **Step 0.3: Write the throwaway spike proxy**

Create `scripts/spikes/router-thinking-spike.mjs`:

```js
// Throwaway Phase 0 spike (delete after recording the result). Forwards
// Anthropic Messages to an upstream and rewrites signatureless thinking blocks.
import { createServer } from "node:http";

const UPSTREAM = process.env.SPIKE_UPSTREAM ?? "https://opencode.ai/zen/go";
const KEY = process.env.OPENCODE_GO_KEY;
const SESSION = process.env.SPIKE_SESSION ?? `spike-${Date.now()}`;
const MODE = process.env.SPIKE_MODE ?? "normalize"; // "normalize" | "drop"
const PLACEHOLDER = "squadrant-router";
let requestSeen = 0;

function norm(content) {
  if (!Array.isArray(content)) return content;
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== "object") { out.push(b); continue; }
    if (b.type === "redacted_thinking") continue;
    if (b.type === "thinking") {
      const sig = typeof b.signature === "string" ? b.signature : "";
      if (sig) { out.push(b); continue; }
      if (MODE === "drop") continue;
      out.push({ ...b, signature: PLACEHOLDER });
      continue;
    }
    out.push(b);
  }
  return out;
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/messages") { res.writeHead(404); res.end(); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (Array.isArray(body.messages)) body.messages = body.messages.map((m) => ({ ...m, content: norm(m.content) }));

  const upstream = await fetch(UPSTREAM.replace(/\/+$/, "") + "/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "x-opencode-session": SESSION,
      "anthropic-version": req.headers["anthropic-version"] ?? "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  requestSeen++;
  console.log(`[spike] request #${requestSeen} upstream=${upstream.status} stream=${body.stream === true} mode=${MODE}`);
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
  res.end();
});

const port = Number(process.env.SPIKE_PORT ?? 8799);
server.listen(port, "127.0.0.1", () => console.log(`[spike] listening http://127.0.0.1:${port} mode=${MODE}`));
```

- [ ] **Step 0.4: Run the spike in `normalize` mode and repeat the 3-turn repro**

Terminal A:
```bash
SPIKE_MODE=normalize node scripts/spikes/router-thinking-spike.mjs
```
Terminal B:
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8799" \
       ANTHROPIC_API_KEY="$OPENCODE_GO_KEY" \
       ANTHROPIC_MODEL="deepseek-v4.1-flash"
claude
```
Repeat the same 3 turns. Expected: **all 3 turns complete, tools run in each turn.**

- [ ] **Step 0.5: If `normalize` failed, run `drop` mode**

If Step 0.4 still 400s, restart the spike with `SPIKE_MODE=drop` and repeat. Expected: 3 turns complete.

- [ ] **Step 0.6: Record the GATE RESULT**

Fill this in (and mirror it into the spec's Decision 4 note):

```
GATE RESULT (decision b) — RECORDED 2026-09-11
- upstream: opencode-go https://opencode.ai/zen/go
- model: deepseek-v4.1-flash
- baseline error (Step 0.2): NONE — bug did NOT reproduce
- intra-invocation (3 tool turns) + cross-invocation (`-c`) replay: both HTTP 200
- normalize-mode result (Step 0.4): N/A (bug absent)
- drop-mode result (Step 0.5): N/A (bug absent)
- SHIPPED POLICY: none — opencode-go returns a non-empty thinking `signature`
  (observed = message id). **Phase 6 SKIPPED** per the Step 0.2 skip clause.
```

Marked steps: 0.1 ✅ 0.2 ✅ 0.3–0.5 skipped (no bug to fix) 0.6 ✅ 0.7 ✅

- [ ] **Step 0.7: Delete the spike + commit the result**

```bash
rm scripts/spikes/router-thinking-spike.mjs
git add docs/specs/2026-09-11-router-transport-u1-design.md docs/plans/2026-09-11-router-transport-u1-plan.md
git commit -m "docs(#773): record U1 thinking-spike gate result"
```

**Gate rule:** If a bug was reproduced, Phase 6's first code step must set the default `thinkingPolicy` to the SHIPPED POLICY recorded in Step 0.6. If no bug reproduced (this run), skip Phase 6. If a bug reproduced and neither mode passed, STOP — report to the captain; do not invent a third workaround.

---

## Phase 1 — Scaffolding + token auth

### Task 1.1: Public types

**Files:**
- Create: `packages/core/src/router/types.ts`

- [ ] **Step 1: Write `types.ts`** (types are inert; no test file)

```ts
// packages/core/src/router/types.ts
// U1 public surface. The seam is "any endpoint that speaks Anthropic Messages";
// squadrant never speaks the OpenAI protocol (spec decision 1).
export type BackendMode = "native" | "direct" | "proxy";

/** Decision (b): how to treat an assistant thinking block with no signature. */
export type ThinkingPolicy = "normalize" | "drop-unsigned";

export interface RouterUpstream {
  /** Origin + base path, WITH NO VERSION SEGMENT (`/v1` is appended by the
   *  client automatically). e.g. "https://opencode.ai/zen/go" or
   *  "http://127.0.0.1:3456". Never include `/v1`, or the request becomes
   *  `/…/v1/v1/messages` and 404s. */
  baseUrl: string;
  /** Upstream credential. Sent in the header named by `authHeader`. */
  apiKey: string;
  /** Header used to send `apiKey`. `"Authorization"` → `Authorization: Bearer <key>`
   *  (default); `"x-api-key"` → `x-api-key: <key>` (opencode-go). */
  authHeader?: string;
  /** Extra headers merged into every upstream request, e.g.
   *  { "x-opencode-session": "<id>" } — required by opencode-go (missing ⇒ 400
   *  MissingSessionID). */
  extraHeaders?: Record<string, string>;
  /** true when the upstream is real Anthropic. When false/absent, Anthropic-only
   *  server tools + request fields are stripped (spec decision 5). */
  isAnthropic?: boolean;
}

export interface RouterUsage {
  project: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface RouterHealth {
  ready: boolean;
  upstreamReachable: boolean;
  lastError?: string;
}

export interface RouterShimOptions {
  upstream: RouterUpstream;
  /** Bearer token -> project id. Minted by the daemon; never logged. */
  projectTokens: Map<string, string>;
  /** 0 => ephemeral port (default). */
  port?: number;
  /** Default "127.0.0.1". */
  host?: string;
  /** Default "normalize" (overridden by Phase 0's SHIPPED POLICY). */
  thinkingPolicy?: ThinkingPolicy;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
  /** Best-effort usage/cost sink. Must never throw. */
  onUsage?: (u: RouterUsage) => void;
  log?: (m: string) => void;
}

export interface RouterShim {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Base URL clients point ANTHROPIC_BASE_URL at, e.g. http://127.0.0.1:53421 */
  url(): string;
  health(): Promise<RouterHealth>;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm lint`
Expected: PASS (no errors introduced).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/router/types.ts
git commit -m "feat(#773): add router shim public types"
```

### Task 1.2: Token auth

**Files:**
- Create: `packages/core/src/router/auth.ts`
- Test: `packages/core/src/router/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/router/__tests__/auth.test.ts
import { describe, it, expect } from "vitest";
import { mintToken, parseBearer, resolveProject } from "../auth.js";

describe("router auth", () => {
  it("mints high-entropy unique tokens", () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it("parses a bearer header case-insensitively", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer   abc123 ")).toBe("abc123");
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });

  it("resolves the project for a known token and rejects unknown", () => {
    const tokens = new Map([["t1", "proj-a"]]);
    expect(resolveProject(tokens, "Bearer t1")).toBe("proj-a");
    expect(resolveProject(tokens, "Bearer nope")).toBeNull();
    expect(resolveProject(tokens, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/auth.test.ts`
Expected: FAIL — cannot resolve `../auth.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/router/auth.ts
import { randomBytes } from "node:crypto";

/** 32 random bytes, base64url — high entropy, URL/header safe. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Extract the token from an `Authorization: Bearer <t>` header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Resolve the project for an inbound request, or null when unauthorized. */
export function resolveProject(tokens: Map<string, string>, header: string | undefined): string | null {
  const token = parseBearer(header);
  if (!token) return null;
  return tokens.get(token) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router/auth.ts packages/core/src/router/__tests__/auth.test.ts
git commit -m "feat(#773): add router shim token auth"
```

### Task 1.3: Error envelope

**Files:**
- Create: `packages/core/src/router/errors.ts`
- Test: `packages/core/src/router/__tests__/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/router/__tests__/errors.test.ts
import { describe, it, expect } from "vitest";
import { anthropicError } from "../errors.js";

describe("anthropicError", () => {
  it("builds the Anthropic error envelope", () => {
    expect(anthropicError(401, "authentication_error", "nope")).toEqual({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "nope" } },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/errors.test.ts`
Expected: FAIL — cannot resolve `../errors.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/router/errors.ts
export interface AnthropicErrorBody {
  type: "error";
  error: { type: string; message: string };
}

/** Build a status + Anthropic-shaped error envelope so Claude Code renders it natively. */
export function anthropicError(
  status: number,
  type: string,
  message: string,
): { status: number; body: AnthropicErrorBody } {
  return { status, body: { type: "error", error: { type, message } } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router/errors.ts packages/core/src/router/__tests__/errors.test.ts
git commit -m "feat(#773): add Anthropic error envelope helper"
```

---

## Phase 2 — `POST /v1/messages`, non-stream passthrough

### Task 2.1: Server skeleton + non-stream forward

**Files:**
- Create: `packages/core/src/router/shim.ts`
- Create: `packages/core/src/router/index.ts`
- Test: `packages/core/src/router/__tests__/shim.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/router/__tests__/shim.integration.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createRouterShim, type RouterShim } from "../shim.js";

async function startMockUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

let shim: RouterShim | null = null;
let upstream: { url: string; close: () => Promise<void> } | null = null;
afterEach(async () => {
  await shim?.stop();
  shim = null;
  await upstream?.close();
  upstream = null;
});

const tokens = new Map([["tok-1", "proj-a"]]);

describe("router shim integration", () => {
  it("rejects a missing/invalid token with a 401 Anthropic envelope", async () => {
    upstream = await startMockUpstream((_q, s) => s.end("{}"));
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe("authentication_error");
  });

  it("forwards a non-stream request and returns the upstream body", async () => {
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(200, { "content-type": "application/json" });
      s.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "ok" }] }));
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: Array<{ text: string }> };
    expect(json.content[0].text).toBe("ok");
  });

  it("uses configured authHeader + extraHeaders and forwards anthropic-* headers", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    upstream = await startMockUpstream((req, s) => {
      seen = req.headers;
      s.writeHead(200, { "content-type": "application/json" });
      s.end("{}");
    });
    shim = createRouterShim({
      upstream: {
        baseUrl: upstream.url,
        apiKey: "go-key",
        authHeader: "x-api-key",
        extraHeaders: { "x-opencode-session": "sess-1" },
        isAnthropic: false,
      },
      projectTokens: tokens,
    });
    await shim.start();
    await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok-1",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(seen["x-api-key"]).toBe("go-key");
    expect(seen["x-opencode-session"]).toBe("sess-1");
    expect(seen["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(seen["authorization"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/shim.integration.test.ts`
Expected: FAIL — cannot resolve `../shim.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/router/shim.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RouterHealth, RouterShim, RouterShimOptions, RouterUpstream, RouterUsage } from "./types.js";
import { resolveProject } from "./auth.js";
import { anthropicError } from "./errors.js";

/** Append an Anthropic path to a base URL without dropping a base path
 *  (https://opencode.ai/zen/go + /v1/messages => https://opencode.ai/zen/go/v1/messages). */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const DEFAULT_AUTH_HEADER = "Authorization";

/** Build upstream request headers: content negotiation, configured auth
 *  (authHeader + extraHeaders), and a whitelist of client `anthropic-*`
 *  headers (so `anthropic-beta` rides along). */
function buildUpstreamHeaders(
  req: IncomingMessage,
  upstream: RouterUpstream,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
  const authName = upstream.authHeader ?? DEFAULT_AUTH_HEADER;
  headers[authName] =
    authName.toLowerCase() === "authorization" ? `Bearer ${upstream.apiKey}` : upstream.apiKey;
  for (const [k, v] of Object.entries(upstream.extraHeaders ?? {})) headers[k] = v;
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key.startsWith("anthropic-") && typeof v === "string") headers[key] = v;
  }
  if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
  return headers;
}

export function createRouterShim(opts: RouterShimOptions): RouterShim {
  const fetchImpl = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  let server: Server | undefined;
  let boundPort = 0;
  let lastError: string | undefined;
  let upstreamReachable = true;
  const upstreamUrl = joinUrl(opts.upstream.baseUrl, "/v1/messages");

  function emitUsage(u: RouterUsage): void {
    try {
      opts.onUsage?.(u);
    } catch {
      /* best-effort */
    }
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const project = resolveProject(opts.projectTokens, req.headers.authorization);
    if (!project) {
      const e = anthropicError(401, "authentication_error", "invalid squadrant router token");
      writeJson(res, e.status, e.body);
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      const e = anthropicError(400, "invalid_request_error", "malformed JSON body");
      writeJson(res, e.status, e.body);
      return;
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await fetchImpl(upstreamUrl, {
        method: "POST",
        headers: buildUpstreamHeaders(req, opts.upstream, body.stream === true),
        body: JSON.stringify(body),
      });
    } catch (err) {
      upstreamReachable = false;
      lastError = err instanceof Error ? err.message : String(err);
      const e = anthropicError(502, "api_error", `router upstream unreachable: ${lastError}`);
      writeJson(res, e.status, e.body);
      return;
    }
    upstreamReachable = true;

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text();
      log(`router upstream ${upstreamRes.status}: ${text.slice(0, 500)}`);
      const e = anthropicError(upstreamRes.status, "api_error", text.slice(0, 500) || "upstream error");
      writeJson(res, e.status, e.body);
      return;
    }

    const text = await upstreamRes.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const e = anthropicError(502, "api_error", "upstream returned non-JSON");
      writeJson(res, e.status, e.body);
      return;
    }
    void emitUsage;
    void project;
    writeJson(res, upstreamRes.status, parsed);
  }

  function handler(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "POST" && req.url === "/v1/messages") {
      void handleMessages(req, res);
      return;
    }
    writeJson(res, 404, anthropicError(404, "not_found_error", "not found").body);
  }

  return {
    async start() {
      if (server) return;
      server = createServer(handler);
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
      });
      const addr = server.address();
      boundPort = typeof addr === "object" && addr ? addr.port : 0;
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    },
    url() {
      return `http://${opts.host ?? "127.0.0.1"}:${boundPort}`;
    },
    async health(): Promise<RouterHealth> {
      return { ready: server?.listening === true, upstreamReachable, lastError };
    },
  };
}
```

Create `packages/core/src/router/index.ts`:

```ts
// packages/core/src/router/index.ts — U1 router/transport public surface.
export * from "./types.js";
export * from "./auth.js";
export * from "./errors.js";
export * from "./shim.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/shim.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router/shim.ts packages/core/src/router/index.ts packages/core/src/router/__tests__/shim.integration.test.ts
git commit -m "feat(#773): router shim http server + non-stream messages passthrough"
```

---

## Phase 3 — Streaming SSE passthrough

### Task 3.1: Pipe SSE byte-for-byte

**Files:**
- Modify: `packages/core/src/router/shim.ts`
- Test: `packages/core/src/router/__tests__/shim.integration.test.ts`

- [ ] **Step 1: Add the failing test** (append inside the `describe` block)

```ts
  it("streams SSE bytes through unchanged", async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n';
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(200, { "content-type": "text/event-stream" });
      s.end(sse);
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(sse);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/shim.integration.test.ts`
Expected: FAIL — the stream request falls into the non-stream branch, so either the status/content-type is wrong or the body is JSON-parse-failed.

- [ ] **Step 3: Add streaming to `shim.ts`**

Add to the imports at the top:

```ts
import { Readable } from "node:stream";
```

Replace the block from `if (!upstreamRes.ok) {` through the final `writeJson(res, upstreamRes.status, parsed);` with:

```ts
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text();
      log(`router upstream ${upstreamRes.status}: ${text.slice(0, 500)}`);
      const e = anthropicError(upstreamRes.status, "api_error", text.slice(0, 500) || "upstream error");
      writeJson(res, e.status, e.body);
      return;
    }

    const contentType = upstreamRes.headers.get("content-type") ?? "";
    if (body.stream === true && upstreamRes.body) {
      res.writeHead(upstreamRes.status, {
        "content-type": contentType || "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const nodeStream = Readable.fromWeb(
        upstreamRes.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );
      nodeStream.on("error", () => res.end());
      nodeStream.pipe(res);
      return;
    }

    const text = await upstreamRes.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const e = anthropicError(502, "api_error", "upstream returned non-JSON");
      writeJson(res, e.status, e.body);
      return;
    }
    void emitUsage;
    void project;
    writeJson(res, upstreamRes.status, parsed);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/shim.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router/shim.ts packages/core/src/router/__tests__/shim.integration.test.ts
git commit -m "feat(#773): byte-faithful SSE passthrough"
```

---

## Phase 4 — `GET /healthz`

### Task 4.1: Health endpoint

**Files:**
- Modify: `packages/core/src/router/shim.ts`
- Test: `packages/core/src/router/__tests__/shim.integration.test.ts`

- [ ] **Step 1: Add the failing test** (append inside the `describe` block)

```ts
  it("reports readiness via /healthz", async () => {
    upstream = await startMockUpstream((_q, s) => s.end("{}"));
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).ready).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/shim.integration.test.ts`
Expected: FAIL — `/healthz` returns 404.

- [ ] **Step 3: Add the health route to `handler`**

Insert before the 404 fallback in `shim.ts`:

```ts
    if (req.method === "GET" && req.url === "/healthz") {
      writeJson(res, 200, {
        ready: server?.listening === true,
        upstreamReachable,
        lastError,
      } satisfies RouterHealth);
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/shim.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router/shim.ts packages/core/src/router/__tests__/shim.integration.test.ts
git commit -m "feat(#773): add /healthz readiness endpoint"
```

---

## Phase 5 — Strip Anthropic server-tools + Anthropic-only fields

### Task 5.1: Request sanitizer

**Files:**
- Create: `packages/core/src/router/sanitize.ts`
- Test: `packages/core/src/router/__tests__/sanitize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/router/__tests__/sanitize.test.ts
import { describe, it, expect } from "vitest";
import { sanitizeRequest } from "../sanitize.js";

const nonAnthropic = { baseUrl: "https://opencode.ai/zen/go", apiKey: "k", isAnthropic: false };
const anthropic = { baseUrl: "https://api.anthropic.com", apiKey: "k", isAnthropic: true };

describe("sanitizeRequest", () => {
  it("strips Anthropic-only fields and server tools for non-Anthropic upstreams", () => {
    const body = {
      model: "deepseek/deepseek-chat",
      container: "c",
      context_management: {},
      mcp_servers: [],
      tools: [
        { type: "custom", name: "mcp__foo", input_schema: {} },
        { type: "web_search_20250305", name: "web_search" },
        { type: "bash_20250124", name: "bash" },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = sanitizeRequest(body, nonAnthropic, "normalize");
    expect(out.container).toBeUndefined();
    expect(out.context_management).toBeUndefined();
    expect(out.mcp_servers).toBeUndefined();
    expect((out.tools as Array<{ type: string }>).map((t) => t.type)).toEqual(["custom"]);
  });

  it("keeps server tools when the upstream is real Anthropic", () => {
    const out = sanitizeRequest({ tools: [{ type: "bash_20250124", name: "bash" }] }, anthropic, "normalize");
    expect((out.tools as unknown[]).length).toBe(1);
  });

  it("leaves cache_control untouched", () => {
    const body = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }] };
    const out = sanitizeRequest(body, nonAnthropic, "normalize");
    expect((out.system as Array<{ cache_control: unknown }>)[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/sanitize.test.ts`
Expected: FAIL — cannot resolve `../sanitize.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/router/sanitize.ts
import type { RouterUpstream, ThinkingPolicy } from "./types.js";

// Anthropic executes these server-side; a third-party upstream cannot, and
// rejects the request when they are present (OpenRouter #31380; same class for
// opencode-go).
export const SERVER_TOOL_TYPE_RE = /^(bash|text_editor|str_replace_editor|computer|web_search|code_execution|memory)_\d+/;

/** Request fields only real Anthropic understands. */
export const ANTHROPIC_ONLY_REQUEST_FIELDS = ["container", "context_management", "mcp_servers"] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strip the outbound request for a non-Anthropic upstream. cache_control is
 *  deliberately preserved — the upstream maps cache breakpoints to its own
 *  provider-native caching (spec decision 5). */
export function sanitizeRequest(
  body: Record<string, unknown>,
  upstream: RouterUpstream,
  _policy: ThinkingPolicy,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (!upstream.isAnthropic) {
    for (const f of ANTHROPIC_ONLY_REQUEST_FIELDS) delete out[f];
    if (Array.isArray(out.tools)) {
      out.tools = out.tools.filter(
        (t) => !(isObj(t) && typeof t.type === "string" && SERVER_TOOL_TYPE_RE.test(t.type)),
      );
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/sanitize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire it into the shim**

In `shim.ts`, import it:
```ts
import { sanitizeRequest } from "./sanitize.js";
```
Then, right after the JSON parse succeeds, add:
```ts
    const sanitized = sanitizeRequest(body, opts.upstream, opts.thinkingPolicy ?? "normalize");
```
and change `body: JSON.stringify(body)` in the forward call to `body: JSON.stringify(sanitized)`. Keep using `body.stream` for the stream check.

- [ ] **Step 6: Run the integration test to verify nothing regressed**

Run: `pnpm vitest run packages/core/src/router/__tests__/shim.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/router/sanitize.ts packages/core/src/router/__tests__/sanitize.test.ts packages/core/src/router/shim.ts
git commit -m "feat(#773): strip Anthropic server tools + Anthropic-only fields"
```

---

## Phase 6 — Thinking-block normalization (GATED on Phase 0)

> Do not start until Phase 0's `GATE RESULT` is recorded. Use the SHIPPED POLICY as the default.

### Task 6.1: Normalize signatures (request + response)

**Files:**
- Modify: `packages/core/src/router/sanitize.ts`
- Test: `packages/core/src/router/__tests__/sanitize.test.ts`

- [ ] **Step 1: Add the failing tests** (append to `sanitize.test.ts`; add `sanitizeResponse` to the import)

```ts
import { sanitizeRequest, sanitizeResponse } from "../sanitize.js";

describe("thinking normalization", () => {
  it("fills an empty signature with the placeholder on an outbound message", () => {
    const body = {
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "" }] }],
    };
    const out = sanitizeRequest(body, nonAnthropic, "normalize") as {
      messages: Array<{ content: Array<{ signature: string }> }>;
    };
    expect(out.messages[0].content[0].signature).toBe("squadrant-router");
  });

  it("preserves a real signature", () => {
    const body = {
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig" }] }],
    };
    const out = sanitizeRequest(body, nonAnthropic, "normalize") as {
      messages: Array<{ content: Array<{ signature: string }> }>;
    };
    expect(out.messages[0].content[0].signature).toBe("sig");
  });

  it("drops redacted_thinking blocks", () => {
    const out = sanitizeRequest(
      { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] }] },
      nonAnthropic,
      "normalize",
    ) as { messages: Array<{ content: unknown[] }> };
    expect(out.messages[0].content).toEqual([]);
  });

  it("drop-unsigned policy removes unsigned thinking blocks", () => {
    const out = sanitizeRequest(
      { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "" }] }] },
      nonAnthropic,
      "drop-unsigned",
    ) as { messages: Array<{ content: unknown[] }> };
    expect(out.messages[0].content).toEqual([]);
  });

  it("normalizes an inbound response thinking block", () => {
    const out = sanitizeResponse(
      { content: [{ type: "thinking", thinking: "t", signature: "" }, { type: "text", text: "ok" }] },
      "normalize",
    ) as { content: Array<{ type: string; signature?: string }> };
    expect(out.content[0].signature).toBe("squadrant-router");
    expect(out.content[1].type).toBe("text");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/sanitize.test.ts`
Expected: FAIL — `sanitizeResponse` is not exported / request content is not normalized.

- [ ] **Step 3: Implement normalization in `sanitize.ts`**

Add the placeholder constant and the content normalizer, and apply it in `sanitizeRequest`; add `sanitizeResponse`:

```ts
/** Deterministic, non-empty stand-in for a provider that returns no signature. */
export const PLACEHOLDER_SIGNATURE = "squadrant-router";

/** Fill/normalize thinking blocks in a content array. Never returns a thinking
 *  block with an empty signature (spec decision 4). */
export function normalizeThinkingContent(content: unknown, policy: ThinkingPolicy): unknown {
  if (!Array.isArray(content)) return content;
  const out: unknown[] = [];
  for (const block of content) {
    if (!isObj(block)) {
      out.push(block);
      continue;
    }
    if (block.type === "redacted_thinking") continue;
    if (block.type === "thinking") {
      const sig = typeof block.signature === "string" ? block.signature : "";
      if (sig.length > 0) {
        out.push(block);
        continue;
      }
      if (policy === "drop-unsigned") continue;
      out.push({ ...block, signature: PLACEHOLDER_SIGNATURE });
      continue;
    }
    out.push(block);
  }
  return out;
}

/** Inbound response normalizer — ensures Claude Code stores a signature it can
 *  replay on the next turn. */
export function sanitizeResponse(
  body: Record<string, unknown>,
  policy: ThinkingPolicy,
): Record<string, unknown> {
  if (!isObj(body) || !Array.isArray(body.content)) return body;
  return { ...body, content: normalizeThinkingContent(body.content, policy) };
}
```

Then in `sanitizeRequest`, after the `if (!upstream.isAnthropic) { … }` block (and outside it, so Anthropic upstreams are also normalized defensively), add:

```ts
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      if (!isObj(m)) return m;
      return { ...m, content: normalizeThinkingContent(m.content, policy) };
    });
  }
```

Rename the existing parameter `_policy` to `policy` so it is used.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/sanitize.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Wire response normalization into the shim**

In `shim.ts`, import `sanitizeResponse`:
```ts
import { sanitizeRequest, sanitizeResponse } from "./sanitize.js";
```
Change the final non-stream write to:
```ts
    const policy = opts.thinkingPolicy ?? "normalize";
    writeJson(res, upstreamRes.status, sanitizeResponse(parsed, policy));
```
(Define `const policy = opts.thinkingPolicy ?? "normalize";` once near the top of `createRouterShim` and also use it in the `sanitizeRequest` call from Phase 5.)

- [ ] **Step 6: Add an integration assertion and run**

Append to `shim.integration.test.ts`:

```ts
  it("normalizes an empty signature on a non-stream response", async () => {
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(200, { "content-type": "application/json" });
      s.end(JSON.stringify({ content: [{ type: "thinking", thinking: "t", signature: "" }] }));
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    const json = (await res.json()) as { content: Array<{ signature: string }> };
    expect(json.content[0].signature).toBe("squadrant-router");
  });
```

Run: `pnpm vitest run packages/core/src/router/__tests__/`
Expected: PASS (all router tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/router/sanitize.ts packages/core/src/router/shim.ts packages/core/src/router/__tests__/
git commit -m "feat(#773): normalize thinking-block signatures (request + response)"
```

---

## Phase 7 — Usage / cost tee

### Task 7.1: Stream tee + JSON usage

**Files:**
- Create: `packages/core/src/router/stream.ts`
- Test: `packages/core/src/router/__tests__/stream.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/router/__tests__/stream.test.ts
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createUsageTee, usageFromJson } from "../stream.js";
import type { RouterUsage } from "../types.js";

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

describe("createUsageTee", () => {
  it("passes bytes through unchanged and emits usage at flush", async () => {
    const seen: RouterUsage[] = [];
    const tee = createUsageTee("proj-a", (u) => seen.push(u));
    const src = Buffer.from(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7,"cost":0.0012}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const out = await collect(Readable.from([src]).pipe(tee));
    expect(out.equals(src)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      project: "proj-a",
      inputTokens: 10,
      outputTokens: 7,
      costUsd: 0.0012,
    });
  });

  it("survives a chunk boundary mid-line", async () => {
    const seen: RouterUsage[] = [];
    const tee = createUsageTee("p", (u) => seen.push(u));
    const a = Buffer.from('data: {"type":"message_delta","usa');
    const b = Buffer.from('ge":{"output_tokens":3}}\n\n');
    await collect(Readable.from([a, b]).pipe(tee));
    expect(seen[0].outputTokens).toBe(3);
  });
});

describe("usageFromJson", () => {
  it("extracts usage and cost from a non-stream body", () => {
    const u = usageFromJson("p", {
      usage: { input_tokens: 5, output_tokens: 6, cost: 0.002, cache_read_input_tokens: 100 },
    });
    expect(u).toMatchObject({
      project: "p",
      inputTokens: 5,
      outputTokens: 6,
      costUsd: 0.002,
      cacheReadTokens: 100,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/stream.test.ts`
Expected: FAIL — cannot resolve `../stream.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/router/stream.ts
import { Transform } from "node:stream";
import type { RouterUsage } from "./types.js";

function absorb(evt: unknown, acc: RouterUsage): void {
  if (typeof evt !== "object" || evt === null) return;
  const e = evt as Record<string, unknown>;
  const message = typeof e.message === "object" && e.message !== null ? (e.message as Record<string, unknown>) : undefined;
  const usage = (e.usage ?? message?.usage) as Record<string, unknown> | undefined;
  if (!usage) return;
  if (typeof usage.input_tokens === "number") acc.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") acc.outputTokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") acc.cacheReadTokens = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number") acc.cacheWriteTokens = usage.cache_creation_input_tokens;
  if (typeof usage.cost === "number") acc.costUsd = usage.cost;
}

/** Pass-through Transform that scans SSE `data:` lines for usage and calls
 *  onUsage once at flush. Bytes are never modified. */
export function createUsageTee(project: string, onUsage: (u: RouterUsage) => void): Transform {
  let buf = "";
  const acc: RouterUsage = { project };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") {
            try {
              absorb(JSON.parse(payload), acc);
            } catch {
              /* non-JSON keep-alive */
            }
          }
        }
      }
      cb(null, chunk);
    },
    flush(cb) {
      try {
        onUsage(acc);
      } catch {
        /* best-effort */
      }
      cb();
    },
  });
}

/** Extract usage from a non-streaming response body. */
export function usageFromJson(project: string, body: Record<string, unknown>): RouterUsage {
  const acc: RouterUsage = { project };
  absorb({ usage: body.usage }, acc);
  return acc;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/stream.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the tee + JSON usage into `shim.ts`**

Add imports:
```ts
import { createUsageTee, usageFromJson } from "./stream.js";
```
In the streaming branch, replace `nodeStream.pipe(res);` with:
```ts
      const tee = createUsageTee(project, emitUsage);
      nodeStream.pipe(tee).pipe(res);
```
In the non-stream branch, replace `void emitUsage; void project;` with:
```ts
    emitUsage(usageFromJson(project, parsed));
```

- [ ] **Step 6: Add an integration assertion and run**

Append to `shim.integration.test.ts`:

```ts
  it("tees usage from a streamed response", async () => {
    const sse =
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2,"cost":0.0004}}\n\n';
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(200, { "content-type": "text/event-stream" });
      s.end(sse);
    });
    const usage: Array<{ project: string; outputTokens?: number; costUsd?: number }> = [];
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
      onUsage: (u) => usage.push(u),
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [], stream: true }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 10));
    expect(usage[0]).toMatchObject({ project: "proj-a", outputTokens: 2, costUsd: 0.0004 });
  });
```

Run: `pnpm vitest run packages/core/src/router/__tests__/`
Expected: PASS (all router tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/router/stream.ts packages/core/src/router/shim.ts packages/core/src/router/__tests__/
git commit -m "feat(#773): tee usage/cost from stream + non-stream responses"
```

---

## Phase 8 — Error handling

### Task 8.1: Error mapping (upstream failures + malformed input + 404)

**Files:**
- Modify: `packages/core/src/router/shim.ts`
- Test: `packages/core/src/router/__tests__/shim.integration.test.ts`

- [ ] **Step 1: Add the failing tests** (append inside the `describe` block)

```ts
  it("maps an upstream 400 to an Anthropic 400 envelope with the upstream message", async () => {
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(400, { "content-type": "application/json" });
      s.end(JSON.stringify({ error: { message: "thinking must be passed back" } }));
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(json.type).toBe("error");
    expect(json.error.message).toContain("thinking must be passed back");
  });

  it("returns a 502 Anthropic envelope when the upstream is unreachable", async () => {
    shim = createRouterShim({
      upstream: { baseUrl: "http://127.0.0.1:1", apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.type).toBe("api_error");
  });

  it("rejects a malformed body with a 400 without forwarding", async () => {
    upstream = await startMockUpstream((_q, s) => s.end("{}"));
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/shim.integration.test.ts`
Expected: FAIL on the upstream-unreachable case (fetch may throw synchronously or the 400 message may already pass). The malformed-body case passes already from Phase 2. Fix only what fails.

- [ ] **Step 3: Harden the upstream-error message**

In `shim.ts`, replace the `!upstreamRes.ok` branch body with a helper that extracts the upstream `error.message` when the body is JSON:

```ts
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text();
      log(`router upstream ${upstreamRes.status}: ${text.slice(0, 500)}`);
      let message = text.slice(0, 500);
      try {
        const parsedErr = JSON.parse(text) as { error?: { message?: string } };
        message = parsedErr.error?.message ?? message;
      } catch {
        /* keep raw text */
      }
      const e = anthropicError(upstreamRes.status, "api_error", message || "upstream error");
      writeJson(res, e.status, e.body);
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/shim.integration.test.ts`
Expected: PASS (all integration tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router/shim.ts packages/core/src/router/__tests__/shim.integration.test.ts
git commit -m "feat(#773): map upstream failures to Anthropic error envelopes"
```

---

## Phase 9 — Native-unchanged regression + core export

### Task 9.1: Export from core

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the export line**

Add to `packages/core/src/index.ts` (after the `./telegram/index.js` line):

```ts
export * from "./router/index.js";
```

- [ ] **Step 2: Typecheck + full router test**

Run: `pnpm lint && pnpm vitest run packages/core/src/router/__tests__/`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(#773): export router shim from @squadrant/core"
```

### Task 9.2: Prove `native` mode is byte-for-byte unchanged

**Files:** none (verification only).

- [ ] **Step 1: Confirm no pre-existing production file changed except the one export**

Run:
```bash
git diff --stat origin/develop -- ':!packages/core/src/router' ':!packages/core/src/index.ts'
```
Expected: empty output (no other tracked file changed by U1).

- [ ] **Step 2: Confirm the daemon host was not wired (that is U2)**

Run:
```bash
grep -n "createRouterShim\|router/index" packages/cli/src/squadrantd.ts
```
Expected: no output. (If there is output, revert it — U1 must stay unwired.)

- [ ] **Step 3: Confirm no driver/`SpawnOptions` change (that is U3)**

Run:
```bash
git diff --stat origin/develop -- packages/agents
```
Expected: empty output.

- [ ] **Step 4: Full suite**

Run: `pnpm test`
Expected: PASS, with the same known baseline (relay-proxy tests are known-flaky; compare against the pre-change baseline, do not chase them).

- [ ] **Step 5: Record the verification in the plan and commit**

Append a short `## Verification log` section at the bottom of this plan with the exact command outputs, then:
```bash
git add docs/plans/2026-09-11-router-transport-u1-plan.md
git commit -m "docs(#773): record U1 native-unchanged verification"
```

---

## Risks & mitigations

| Risk (from spec §Open questions) | Mitigation in this plan |
|---|---|
| Placeholder signature is rejected upstream | **Phase 0 blocking gate** decides `normalize` vs `drop-unsigned` before any Phase 6 code. Recorded SHIPPED POLICY drives the default. If neither passes, STOP and report. |
| Upstream protocol drift (opencode-go contract changes) | The mock-upstream integration tests pin the contract we depend on (SSE shape, `usage`, error envelope). Re-run **Phase 0** whenever the opencode-go contract (`x-opencode-session`, auth header, model slug) or the Claude Code version changes; treat a Phase 0 failure as a signal to re-open decision (b). |
| Byte-faithful streaming | `shim.integration.test.ts` asserts `res.text() === sse` exactly; the usage tee is byte-neutral by construction. |
| `native` regression | Phase 9 proves U1 touches only new files + one export, and never wires the daemon. |
| Port/socket leakage in tests | Every integration test starts the shim on port 0 and stops it in `afterEach`. |

## Env contract (U1 defines the names; U3 injects them)

Documented here for U3; **not implemented in U1**:
```
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>   # shim.url()
ANTHROPIC_AUTH_TOKEN=<minted project token>  # mintToken(), keyed in projectTokens
ANTHROPIC_API_KEY=""                         # explicitly empty — prevents Anthropic fallback
ANTHROPIC_MODEL=<upstream model id>          # e.g. deepseek-v4.1-flash
```

Upstream auth is **not** part of this env contract — it lives on the server side in
`RouterUpstream.authHeader` (`"x-api-key"` for opencode-go) + `extraHeaders`
(`{ "x-opencode-session": "<id>" }`). The client only holds the minted loopback token.
