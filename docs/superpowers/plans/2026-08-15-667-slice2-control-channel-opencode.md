# #667 Slice 2 — `ControlChannel` port + opencode delivery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `ControlChannel` port whose delivery result is a five-branch union instead of a boolean, implement it for opencode over HTTP, and put it behind a three-position per-agent rollout flag that defaults to `off`.

**Architecture:** `AgentDriver` is a launch-time interface with no place for runtime control, so this adds one new port in `core` (mirroring the shape `LifecycleSource` already established) and one implementation in `agents`. The opencode implementation addresses a crew by session id via `POST /session/{id}/prompt_async`, which returns `204` on accept and `404` for a dead session — a detectable failure mode, unlike reading a terminal. The pane path (`confirmedSendToPane`) is untouched and remains the fallback.

**Tech Stack:** TypeScript (NodeNext ESM — **relative imports need the `.js` extension**), vitest, pnpm workspaces, `fetch`.

**Spec:** [`docs/specs/2026-08-13-agent-control-channel-design.md`](../../specs/2026-08-13-agent-control-channel-design.md) — this slice implements §1 (the seam), the opencode half of §2 (Delivery), and §5's rollout flag.

**Depends on:** nothing. Slice 2 is independent of Slice 1 and the two can run as parallel crews.

## Global Constraints

- **Package DAG is one-way:** `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`. `core` may **not** import from `agents`. Port in `core`, implementation in `agents`, wiring in `cli`.
- **NodeNext ESM:** every relative import ends in `.js`. `tsc` and `vitest` both miss this; `node dist/index.js --help` is the real gate.
- **No test may depend on ambient state.** `fetch` is injected everywhere. A test that reaches a real port lies on CI.
- **Default is `off`.** Merging this slice must change nothing for any user who does not opt in. `off` means the code path is not entered at all.
- **Never retry on an accept.** Claude drops byte-identical messages inside a 30 s window; a naive retry manufactures exactly the false negative this project exists to remove. Retry **only** on transport error, and vary the body.
- **`gone` and `unsupported` are the only two paths back to the pane, and both must log why.** A silent fallback reintroduces the ambiguity this slice removes.
- Terminal state still comes only from `squadrant crew signal` (anti-#2576). This slice emits no lifecycle events.
- Commit convention: `feat(#667): …`.

---

## Design decision made while writing this plan — confirm before Task 5

The spec (§5) says shadow mode *"runs ALONGSIDE the pane path; logs only what each concluded and where they DISAGREED."* That is harmless for **liveness** (read-only) but **not** for **delivery**: genuinely sending through both paths delivers the message to the crew **twice**.

**This plan therefore defines shadow mode for delivery as a dry-run probe:**

- the pane still performs the one and only real send, and still decides behaviour;
- the control channel performs a **non-mutating** reachability probe (`GET`, never `prompt_async`);
- squadrant logs what each path concluded and every disagreement.

This preserves the measurement the spec actually wants — *"every instance where the pane says 'not delivered' and HTTP says the session is alive is countable evidence for #514/#657"* — with zero double-send risk. It was chosen because the operator was away when the question was raised; **flag it for confirmation before Task 5 lands.** If the operator prefers channel-leads-with-pane-observing, that is a different flag position (`on`), not `shadow`, and Task 5 changes shape.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/control-channel.ts` *(new)* | The port: `ControlChannel`, `DeliveryOutcome`, `ChannelName`. Types + one pure helper. No I/O. |
| `packages/core/src/__tests__/control-channel.test.ts` *(new)* | Tests for the pure outcome helpers. |
| `packages/agents/src/opencode/http-channel.ts` *(new)* | The opencode implementation: session resolution, `prompt_async`, probe, outcome mapping. |
| `packages/agents/src/opencode/__tests__/http-channel.test.ts` *(new)* | Tests with an injected `fetch`. No real port. |
| `packages/shared/src/config.ts:98-134` *(modify)* | Add `defaults.controlChannel` to the schema + default. |
| `packages/shared/src/__tests__/config.control-channel.test.ts` *(new)* | Schema default + per-project layering tests. |
| `packages/core/src/crew-spawn.ts:553-570` *(modify)* | The one hook point: the `deliver` closure inside `runCrewSend`. |
| `packages/core/src/__tests__/crew-send-control-channel.test.ts` *(new)* | Flag-position behaviour: off / shadow / on. |
| `packages/core/src/index.ts` · `packages/agents/src/index.ts` *(modify)* | Exports. |
| `packages/cli/src/commands/crew.ts:63-74` *(modify)* | Construct the channel and pass it into `coreRunCrewSend`. |

---

### Task 1: The `ControlChannel` port

**Files:**
- Create: `packages/core/src/control-channel.ts`
- Test: `packages/core/src/__tests__/control-channel.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Consumes: `ControlChannelMode` from `@squadrant/shared` (added in Step 1 below).
- Produces:
  - `type ControlChannelMode = "off" | "shadow" | "on"` **in `@squadrant/shared`** — defined once, beside the config schema that carries it (Task 3 adds the schema field itself). Core re-exports it; the DAG allows `core → shared`, never the reverse.
  - `type ChannelName = "claude-peer" | "opencode-http"`
  - `type DeliveryOutcome` — the five-branch union
  - `interface ControlChannel { readonly name; readonly agent; send(taskId, message); probe(taskId); interrupt?(taskId); }`
  - `function fallsBackToPane(o: DeliveryOutcome): boolean`
  - `function describeOutcome(o: DeliveryOutcome): string`
  - Three new `AgentCapability` members in `packages/agents/src/drivers/types.ts`.

- [ ] **Step 1: Add `ControlChannelMode` to `shared` and the new capabilities to `agents`**

In `packages/shared/src/config.ts`, beside the other exported config types:

```ts
/** #667 per-agent control-channel rollout position. Unset ⇒ "off". */
export type ControlChannelMode = "off" | "shadow" | "on";
```

In `packages/agents/src/drivers/types.ts`, extend the `AgentCapability` union (spec §1) — these are what `probe()` will advertise once slices 2 and 3 land, and what the capability seam keys on:

```ts
export type AgentCapability =
  | "teams"
  | "json_output"
  | "sandbox"
  | "model_routing"
  | "skills"
  | "auto_approve"
  | "streaming"
  | "prompt_file"
  // #667: runtime control over the agent's own native API. Tiered, NOT reduced to
  // the intersection of the two agents — designing to the common denominator would
  // discard opencode's most valuable endpoints.
  | "control_send"      // T0 — deliver a message into a live session
  | "control_observe"   // T1 — read liveness / status
  | "control_interact"; // T2 — approvals, questions, interrupt (opencode only)
```

> Adding union members is additive and inert: `ROLE_REQUIREMENTS` is unchanged, so no role gains a new requirement and no existing probe result becomes invalid.

**Why a union and not a boolean.** `confirmedSendToPane` returns `{ delivered: boolean }`. That collapse is the original sin: a five-branch reality (accepted / queued / held / gone / unsupported) forced into true/false, and the collapse is precisely where the false negatives come from. On 2026-08-13 `crew send` reported "not delivered" twice for messages that had in fact arrived and were visible with a `QUEUED` marker — a `queued` outcome rendered as `false`.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/__tests__/control-channel.test.ts`:

```ts
// Tests for the ControlChannel port's pure helpers (#667 slice 2).
import { describe, it, expect } from "vitest";
import { fallsBackToPane, describeOutcome } from "../control-channel.js";
import type { DeliveryOutcome } from "../control-channel.js";

describe("fallsBackToPane", () => {
  it("gone falls back — the session is dead, the pane is the last resort", () => {
    expect(fallsBackToPane({ status: "gone" })).toBe(true);
  });

  it("unsupported falls back — no channel for this agent", () => {
    expect(fallsBackToPane({ status: "unsupported" })).toBe(true);
  });

  it("accepted does NOT fall back", () => {
    expect(fallsBackToPane({ status: "accepted", via: "opencode-http" })).toBe(false);
  });

  it("queued does NOT fall back — accepted while mid-turn is still accepted", () => {
    // This is the #657 shape: the message arrived and is queued. Treating it as a
    // failure and re-sending is exactly the duplicate-message bug.
    expect(fallsBackToPane({ status: "queued", via: "opencode-http" })).toBe(false);
  });

  it("held does NOT fall back — it is surfaced to the operator, never retried", () => {
    expect(fallsBackToPane({ status: "held", via: "claude-peer", reason: "approval" })).toBe(false);
  });
});

describe("describeOutcome — every outcome must be loggable", () => {
  const cases: DeliveryOutcome[] = [
    { status: "accepted", via: "opencode-http" },
    { status: "queued", via: "opencode-http" },
    { status: "held", via: "claude-peer", reason: "awaiting approval" },
    { status: "gone" },
    { status: "unsupported" },
  ];

  it("produces a non-empty description for all five branches", () => {
    for (const c of cases) expect(describeOutcome(c).length).toBeGreaterThan(0);
  });

  it("includes the channel name when there is one", () => {
    expect(describeOutcome({ status: "accepted", via: "opencode-http" })).toContain("opencode-http");
  });

  it("includes the reason for held — the operator needs to know why", () => {
    expect(describeOutcome({ status: "held", via: "claude-peer", reason: "awaiting approval" }))
      .toContain("awaiting approval");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/__tests__/control-channel.test.ts`
Expected: FAIL — `Cannot find module '../control-channel.js'`

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/control-channel.ts`:

```ts
// packages/core/src/control-channel.ts
//
// ControlChannel port (#667 slice 2) — runtime control of a live agent session
// over its own native API, replacing terminal-pixel inference.
//
// AgentDriver is a LAUNCH-time interface (probe / buildCommand / parseOutput /
// stop) with no place for runtime control, so this is a separate port following
// exactly the shape LifecycleSource established. Implementations live in
// @squadrant/agents; core may not import them (one-way package DAG).

import type { ControlChannelMode } from "@squadrant/shared";

/** Which wire an outcome came from. */
export type ChannelName = "claude-peer" | "opencode-http";

// ControlChannelMode is defined ONCE, in @squadrant/shared alongside the config
// schema that carries it (Task 3), and re-exported here for callers that only
// import the port. The package DAG allows core → shared, never the reverse.
export type { ControlChannelMode };

/**
 * The result of a delivery attempt.
 *
 * NEVER a boolean. confirmedSendToPane collapses this five-branch reality into
 * true/false, and that collapse is where the false negatives come from — on
 * 2026-08-13 `crew send` reported "not delivered" twice for messages that had
 * arrived and were visible with a QUEUED marker.
 *
 * `gone` and `unsupported` are the ONLY two branches that fall back to the pane,
 * and both must be logged. A silent fallback reintroduces the ambiguity this
 * port exists to remove.
 */
export type DeliveryOutcome =
  | { status: "accepted"; via: ChannelName }
  | { status: "queued"; via: ChannelName }
  | { status: "held"; via: ChannelName; reason: string }
  | { status: "gone" }
  | { status: "unsupported" };

/** What a non-mutating reachability probe can conclude. Used by shadow mode. */
export type ProbeResult =
  | { status: "reachable"; via: ChannelName }
  | { status: "gone" }
  | { status: "unsupported" };

/**
 * One channel per agent that has a native control API.
 *
 * Capabilities are TIERED, not reduced to their intersection — designing to the
 * common denominator would discard opencode's most valuable endpoints. T2
 * members are optional; an agent that lacks them simply does not implement them.
 *
 *   T0 send     — send()            claude ✅  opencode ✅
 *   T1 observe  — probe()           claude ✅  opencode ✅
 *   T2 interact — interrupt(), …    claude ❌  opencode ✅
 */
export interface ControlChannel {
  /** Identifies the channel in logs and outcomes. */
  readonly name: ChannelName;
  /** The provider string on a TaskRecord this channel serves ("opencode"|"claude"). */
  readonly agent: string;
  /** T0. Deliver one message into a live session. */
  send(taskId: string, message: string): Promise<DeliveryOutcome>;
  /** T1. Non-mutating liveness check. MUST NOT deliver anything. */
  probe(taskId: string): Promise<ProbeResult>;
  /** T2 (optional). Abort the running turn. */
  interrupt?(taskId: string): Promise<boolean>;
}

/**
 * Only a dead session or a missing channel returns to the pane.
 *
 * accepted / queued / held all mean the message REACHED the agent. Retrying any
 * of them manufactures a duplicate — and for claude, a byte-identical retry
 * inside 30 s is silently dropped, producing exactly the false negative this
 * port removes.
 */
export function fallsBackToPane(o: DeliveryOutcome): boolean {
  return o.status === "gone" || o.status === "unsupported";
}

/** Human-readable one-liner. Every fallback and disagreement is logged with this. */
export function describeOutcome(o: DeliveryOutcome): string {
  switch (o.status) {
    case "accepted": return `accepted via ${o.via}`;
    case "queued":   return `queued via ${o.via} (agent mid-turn)`;
    case "held":     return `held via ${o.via}: ${o.reason}`;
    case "gone":     return "session gone — falling back to pane";
    case "unsupported": return "no control channel for this agent — falling back to pane";
  }
}
```

- [ ] **Step 5: Export from `core`**

In `packages/core/src/index.ts`, add:

```ts
export { fallsBackToPane, describeOutcome } from "./control-channel.js";
export type { ControlChannel, ControlChannelMode, DeliveryOutcome, ProbeResult, ChannelName } from "./control-channel.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/control-channel.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 7: Confirm the capability addition compiles everywhere**

Run: `pnpm build`
Expected: clean. If a `switch` over `AgentCapability` anywhere is exhaustive, the three new members will surface as compile errors — fix those call sites rather than widening the type back.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/control-channel.ts packages/core/src/__tests__/control-channel.test.ts \
        packages/core/src/index.ts packages/shared/src/config.ts packages/agents/src/drivers/types.ts
git commit -m "feat(#667): ControlChannel port with a five-branch DeliveryOutcome"
```

---

### Task 2: `OpencodeHttpChannel` — the opencode implementation

**Files:**
- Create: `packages/agents/src/opencode/http-channel.ts`
- Test: `packages/agents/src/opencode/__tests__/http-channel.test.ts`
- Modify: `packages/agents/src/index.ts` (export)

**Interfaces:**
- Consumes: `ControlChannel`, `DeliveryOutcome`, `ProbeResult` from `@squadrant/core` (Task 1).
- Produces: `class OpencodeHttpChannel implements ControlChannel` + `interface OpencodeHttpChannelDeps { fetchImpl?; portFor; log?; timeoutMs? }`.

**The wire, verified live 2026-08-13** against opencode 1.18.18 in a throwaway `/tmp/oc-lab`:

```
POST /session/{id}/prompt_async {"parts":[{"type":"text","text":"…"}]}  → 204
POST /session/ses_doesnotexist/prompt_async                             → 404 {"name":"NotFoundError"}
POST /tui/append-prompt {"text":"…"}                                    → 200 true
POST /tui/submit-prompt                                                 → 200 true
```

**Use `prompt_async`, not `/tui/*`.** Both work. `/tui/append-prompt` targets whichever session the TUI currently has **focused** — under operator takeover (#649) the operator may have switched sessions and the message lands in the wrong one with nothing to indicate it. `prompt_async` is addressed by session id and returns `404` when the id is wrong. **Prefer the failure mode that is detectable.**

**The 404 is the most important line in this task.** A dead session is *reported as dead* instead of guessed at. That single status code is what makes `gone` an honest branch rather than an inference.

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/opencode/__tests__/http-channel.test.ts`:

```ts
// Tests for OpencodeHttpChannel (#667 slice 2).
// fetch is injected everywhere — no real opencode server, no real port.
// A test that reaches a real port lies on CI (2026-08-13 incident).
import { describe, it, expect, vi } from "vitest";
import { OpencodeHttpChannel } from "../http-channel.js";

const TASK = "task-1";
const PORT = 4096;

/** Minimal fetch stub: route → Response. */
function stubFetch(routes: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) return new Response("no route", { status: 500 });
    const r = routes[key];
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
}

function channel(routes: Parameters<typeof stubFetch>[0], portFor?: () => number | undefined) {
  const fetchImpl = stubFetch(routes);
  const ch = new OpencodeHttpChannel({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    portFor: portFor ?? (() => PORT),
  });
  return { ch, fetchImpl };
}

describe("OpencodeHttpChannel — identity", () => {
  it("is named opencode-http and serves the opencode provider", () => {
    const { ch } = channel({});
    expect(ch.name).toBe("opencode-http");
    expect(ch.agent).toBe("opencode");
  });
});

describe("OpencodeHttpChannel — send", () => {
  it("204 from prompt_async maps to accepted", async () => {
    const { ch } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 204 },
    });
    expect(await ch.send(TASK, "hello")).toEqual({ status: "accepted", via: "opencode-http" });
  });

  it("404 maps to gone — a dead session is REPORTED dead, not guessed at", async () => {
    const { ch } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 404, body: { name: "NotFoundError" } },
    });
    expect(await ch.send(TASK, "hello")).toEqual({ status: "gone" });
  });

  it("uses prompt_async, never /tui/* — /tui targets the FOCUSED session (#649 risk)", async () => {
    const { ch, fetchImpl } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 204 },
    });
    await ch.send(TASK, "hello");
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/prompt_async"))).toBe(true);
    expect(urls.some((u) => u.includes("/tui/"))).toBe(false);
  });

  it("sends the message in opencode's parts shape", async () => {
    const { ch, fetchImpl } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 204 },
    });
    await ch.send(TASK, "hello world");
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/prompt_async"))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      parts: [{ type: "text", text: "hello world" }],
    });
  });

  it("no known port maps to unsupported — the caller falls back to the pane", async () => {
    const { ch } = channel({}, () => undefined);
    expect(await ch.send(TASK, "hello")).toEqual({ status: "unsupported" });
  });

  it("an unreachable server maps to gone, not a throw", async () => {
    const ch = new OpencodeHttpChannel({
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      portFor: () => PORT,
    });
    expect(await ch.send(TASK, "hello")).toEqual({ status: "gone" });
  });

  it("caches the resolved session id across sends", async () => {
    const { ch, fetchImpl } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 204 },
    });
    await ch.send(TASK, "one");
    await ch.send(TASK, "two");
    const listCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/session?"));
    expect(listCalls).toHaveLength(1);
  });

  it("re-resolves the session after a 404 instead of caching a dead id forever", async () => {
    let promptStatus = 404;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/prompt_async")) return new Response(null, { status: promptStatus });
      return new Response(JSON.stringify([{ id: "ses_1", time: { updated: 2 } }]), { status: 200 });
    });
    const ch = new OpencodeHttpChannel({ fetchImpl: fetchImpl as unknown as typeof fetch, portFor: () => PORT });
    expect(await ch.send(TASK, "one")).toEqual({ status: "gone" });
    promptStatus = 204;
    expect(await ch.send(TASK, "two")).toEqual({ status: "accepted", via: "opencode-http" });
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/session?"))).toHaveLength(2);
  });

  it("picks the most recently updated session when several exist", async () => {
    const { ch, fetchImpl } = channel({
      "/session?": { status: 200, body: [
        { id: "ses_old", time: { updated: 1 } },
        { id: "ses_new", time: { updated: 9 } },
      ] },
      "/prompt_async": { status: 204 },
    });
    await ch.send(TASK, "hello");
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/prompt_async"))!;
    expect(String(call[0])).toContain("ses_new");
  });

  it("an empty session list maps to gone", async () => {
    const { ch } = channel({ "/session?": { status: 200, body: [] } });
    expect(await ch.send(TASK, "hello")).toEqual({ status: "gone" });
  });
});

describe("OpencodeHttpChannel — probe (shadow mode must never deliver)", () => {
  it("reports reachable when a session resolves", async () => {
    const { ch } = channel({ "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] } });
    expect(await ch.probe(TASK)).toEqual({ status: "reachable", via: "opencode-http" });
  });

  it("issues only GETs — a probe that POSTs would double-deliver in shadow mode", async () => {
    const { ch, fetchImpl } = channel({ "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] } });
    await ch.probe(TASK);
    for (const call of fetchImpl.mock.calls) {
      const method = ((call[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      expect(method).toBe("GET");
    }
  });

  it("reports gone when the server is unreachable", async () => {
    const ch = new OpencodeHttpChannel({
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      portFor: () => PORT,
    });
    expect(await ch.probe(TASK)).toEqual({ status: "gone" });
  });

  it("reports unsupported when no port is known", async () => {
    const { ch } = channel({}, () => undefined);
    expect(await ch.probe(TASK)).toEqual({ status: "unsupported" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/http-channel.test.ts`
Expected: FAIL — `Cannot find module '../http-channel.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/agents/src/opencode/http-channel.ts`:

```ts
// packages/agents/src/opencode/http-channel.ts
//
// ControlChannel over opencode's embedded HTTP server (#667 slice 2).
//
// Interactive opencode crews already launch as `opencode --port <N>` and the port
// is persisted on the TaskRecord (rec.serverPort, crew-spawn.ts:400), so there is
// no discovery and no race — the daemon knows the address before it needs it.
//
// Verified live 2026-08-13 against opencode 1.18.18:
//   POST /session/{id}/prompt_async  → 204
//   POST /session/ses_bogus/…        → 404 {"name":"NotFoundError"}
//
// prompt_async is preferred over /tui/append-prompt + /tui/submit-prompt (both of
// which also work) because /tui/* targets whichever session the TUI has FOCUSED.
// Under operator takeover (#649) the operator may have switched sessions and the
// message would land in the wrong one with nothing to indicate it. prompt_async is
// addressed by session id and 404s on a wrong id — prefer the detectable failure.
import type { ControlChannel, DeliveryOutcome, ProbeResult } from "@squadrant/core";

export interface OpencodeHttpChannelDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** taskId → the crew's opencode server port, or undefined if unknown. */
  portFor: (taskId: string) => number | undefined;
  /** Per-request timeout (ms). Default 5000. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

interface OpencodeSession {
  id: string;
  time?: { updated?: number };
}

export class OpencodeHttpChannel implements ControlChannel {
  readonly name = "opencode-http" as const;
  readonly agent = "opencode";

  /** taskId → resolved session id. Invalidated on 404 (see send()). */
  private sessionByTask = new Map<string, string>();

  private readonly fetchImpl: typeof fetch;
  private readonly portFor: (taskId: string) => number | undefined;
  private readonly timeoutMs: number;
  private readonly log?: (msg: string) => void;

  constructor(deps: OpencodeHttpChannelDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.portFor = deps.portFor;
    this.timeoutMs = deps.timeoutMs ?? 5000;
    this.log = deps.log;
  }

  async send(taskId: string, message: string): Promise<DeliveryOutcome> {
    const port = this.portFor(taskId);
    if (port == null) return { status: "unsupported" };

    const sessionId = await this.resolveSession(taskId, port);
    if (!sessionId) return { status: "gone" };

    let res: Response;
    try {
      res = await this.request(
        `http://127.0.0.1:${port}/session/${sessionId}/prompt_async`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: message }] }) },
      );
    } catch (e) {
      // Transport failure. Report gone so the caller falls back to the pane ONCE,
      // logged. Never loop here — the retry policy lives at the call site.
      this.log?.(`opencode-http send transport error for ${taskId}: ${(e as Error).message}`);
      return { status: "gone" };
    }

    if (res.status === 204 || res.status === 200) {
      return { status: "accepted", via: this.name };
    }
    if (res.status === 404) {
      // The session id is stale (crew restarted, session closed). Drop the cache
      // so the NEXT send re-resolves rather than 404ing forever against a dead id.
      this.sessionByTask.delete(taskId);
      this.log?.(`opencode-http: session ${sessionId} for ${taskId} is gone (404)`);
      return { status: "gone" };
    }
    this.log?.(`opencode-http: unexpected status ${res.status} for ${taskId}`);
    return { status: "gone" };
  }

  /**
   * Non-mutating reachability check. MUST NOT deliver anything — shadow mode
   * calls this alongside a real pane send, and a POST here would deliver the
   * message twice.
   */
  async probe(taskId: string): Promise<ProbeResult> {
    const port = this.portFor(taskId);
    if (port == null) return { status: "unsupported" };
    const sessionId = await this.resolveSession(taskId, port);
    return sessionId ? { status: "reachable", via: this.name } : { status: "gone" };
  }

  // ── private ───────────────────────────────────────────────────────────────

  /**
   * Resolve (and cache) the crew's session id.
   *
   * opencode 1.18.18 is mid-migration from /session/* to /api/session/*, so both
   * are tried. This is a capability probe, NOT a version comparison — the honest
   * check is "does this route answer", and neither path is a promised-stable
   * contract. Re-run the smoke suite when opencode is upgraded.
   */
  private async resolveSession(taskId: string, port: number): Promise<string | undefined> {
    const cached = this.sessionByTask.get(taskId);
    if (cached) return cached;

    for (const path of ["/session?", "/api/session?"]) {
      let res: Response;
      try {
        res = await this.request(`http://127.0.0.1:${port}${path}`, { method: "GET" });
      } catch {
        return undefined; // server unreachable — caller maps this to gone
      }
      if (!res.ok) continue;
      let sessions: OpencodeSession[];
      try {
        sessions = (await res.json()) as OpencodeSession[];
      } catch {
        continue;
      }
      if (!Array.isArray(sessions) || sessions.length === 0) continue;
      // A crew pane may hold several sessions; the most recently updated is the
      // one the operator is looking at.
      const newest = sessions.reduce((a, b) =>
        (b.time?.updated ?? 0) > (a.time?.updated ?? 0) ? b : a);
      if (!newest?.id) continue;
      this.sessionByTask.set(taskId, newest.id);
      return newest.id;
    }
    return undefined;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  }
}
```

- [ ] **Step 4: Export from `agents`**

In `packages/agents/src/index.ts`:

```ts
export { OpencodeHttpChannel } from "./opencode/http-channel.js";
export type { OpencodeHttpChannelDeps } from "./opencode/http-channel.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/http-channel.test.ts`
Expected: PASS — 15 tests

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/opencode/http-channel.ts packages/agents/src/opencode/__tests__/http-channel.test.ts packages/agents/src/index.ts
git commit -m "feat(#667): OpencodeHttpChannel — prompt_async delivery with detectable 404"
```

---

### Task 3: The `defaults.controlChannel` rollout flag

**Files:**
- Modify: `packages/shared/src/config.ts` (schema at ~line 110, default at ~line 181, backfill at ~line 219)
- Test: `packages/shared/src/__tests__/config.control-channel.test.ts` *(new)*

**Interfaces:**
- Consumes: `ControlChannelMode` (added to `packages/shared/src/config.ts` in Task 1 Step 1).
- Produces: `type ControlChannelConfig = Partial<Record<string, ControlChannelMode>>` on `SquadrantConfig["defaults"]["controlChannel"]`, and `function resolveControlChannelMode(cfg, agent): ControlChannelMode`.

**Shape**, per spec §5 — read per send so flipping needs no restart, and per-project overridable through the existing deep-merge layering (`projects/<name>.json`):

```json
{ "defaults": { "controlChannel": { "claude": "off", "opencode": "shadow" } } }
```

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/__tests__/config.control-channel.test.ts`:

```ts
// Tests for the #667 controlChannel rollout flag.
import { describe, it, expect } from "vitest";
import { resolveControlChannelMode } from "../config.js";

describe("resolveControlChannelMode", () => {
  it("an absent controlChannel block means off for every agent", () => {
    // Safe by default: merging slice 2 must change nothing for anyone who has
    // not opted in.
    expect(resolveControlChannelMode(undefined, "opencode")).toBe("off");
  });

  it("an agent not listed defaults to off", () => {
    expect(resolveControlChannelMode({ claude: "on" }, "opencode")).toBe("off");
  });

  it("returns the configured mode for a listed agent", () => {
    expect(resolveControlChannelMode({ opencode: "shadow" }, "opencode")).toBe("shadow");
    expect(resolveControlChannelMode({ opencode: "on" }, "opencode")).toBe("on");
  });

  it("an invalid value falls back to off rather than throwing", () => {
    // A typo in config must not take the delivery path with it.
    expect(resolveControlChannelMode({ opencode: "yes" as never }, "opencode")).toBe("off");
  });

  it("agents are independent — claude on does not enable opencode", () => {
    const cfg = { claude: "on" as const, opencode: "off" as const };
    expect(resolveControlChannelMode(cfg, "claude")).toBe("on");
    expect(resolveControlChannelMode(cfg, "opencode")).toBe("off");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/config.control-channel.test.ts`
Expected: FAIL — `resolveControlChannelMode is not a function`

- [ ] **Step 3: Add the schema and the resolver**

In `packages/shared/src/config.ts`, add near the other `defaults` fields (after `claudeEnv`, ~line 134):

```ts
    /** #667 per-agent control-channel rollout. Absent ⇒ every agent "off".
     *  Read per send, so flipping a position needs no daemon restart.
     *    off     unchanged behaviour — the channel code path is not entered
     *    shadow  pane still sends and still decides; the channel runs a
     *            NON-MUTATING probe and squadrant logs any disagreement
     *    on      channel leads; the pane becomes the fallback
     *  Per-project override via projects/<name>.json (existing deep merge). */
    controlChannel?: ControlChannelConfig;
```

And near the other exported types:

```ts
// ControlChannelMode itself was added to this file in Task 1 Step 1 — do not
// redeclare it here.
export type ControlChannelConfig = Partial<Record<string, ControlChannelMode>>;

const CONTROL_CHANNEL_MODES: ReadonlySet<string> = new Set(["off", "shadow", "on"]);

/**
 * Resolve one agent's rollout position. Unset, unknown agent, or an invalid
 * value all mean "off" — a config typo must never silently take the delivery
 * path with it.
 */
export function resolveControlChannelMode(
  cfg: ControlChannelConfig | undefined,
  agent: string,
): ControlChannelMode {
  const v = cfg?.[agent];
  return v && CONTROL_CHANNEL_MODES.has(v) ? v : "off";
}
```

> **Do not add a `controlChannel` block to `getDefaultConfig()`.** Absent means off; writing an explicit block into every user's config on upgrade would be a visible change for a slice that is meant to be inert. No backfill either.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/shared/src/__tests__/config.control-channel.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Confirm no config drift is introduced**

```bash
pnpm build && squadrant config check
```

Expected: no new drift items. If `config check` reports drift, `getDefaultConfig()` was modified — revert that part.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/src/__tests__/config.control-channel.test.ts
git commit -m "feat(#667): defaults.controlChannel rollout flag, off by default"
```

---

### Task 4: Hook the channel into `runCrewSend`

**Files:**
- Modify: `packages/core/src/crew-spawn.ts:553-570` (the `deliver` closure)
- Test: `packages/core/src/__tests__/crew-send-control-channel.test.ts` *(new)*

**Interfaces:**
- Consumes: `ControlChannel`, `DeliveryOutcome`, `fallsBackToPane`, `describeOutcome` (Task 1); `resolveControlChannelMode` (Task 3).
- Produces: two new optional fields on `runCrewSend`'s `deps`:
  ```ts
  controlChannel?: ControlChannel;
  controlChannelMode?: (agent: string) => ControlChannelMode;
  onChannelLog?: (msg: string) => void;
  ```

**The hook point.** `packages/core/src/crew-spawn.ts:553-555` today:

```ts
const deliver = deps.sendToPane ?? ((pane, msg) => runtime.sendToPane(pane, msg).then(() => ({ delivered: true })));
const { delivered, blockedByModal } = await deliver(crew, message);
```

Everything before it (modal precheck, operator-hold guard, `pickMostRecentTask`, the reopen/started emits) is unchanged and still runs. The channel is consulted **only** at the moment of delivery.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/crew-send-control-channel.test.ts`:

```ts
// #667 slice 2: flag-position behaviour of the control channel inside runCrewSend.
// Everything is injected — no runtime, no daemon, no HTTP.
import { describe, it, expect, vi } from "vitest";
import { runCrewSend } from "../crew-spawn.js";
import type { ControlChannel, DeliveryOutcome } from "../control-channel.js";

const PROJECT = "proj";
const NAME = "crew-1";

function makeChannel(over: Partial<ControlChannel> = {}): ControlChannel {
  return {
    name: "opencode-http", agent: "opencode",
    send: async () => ({ status: "accepted", via: "opencode-http" }) as DeliveryOutcome,
    probe: async () => ({ status: "reachable", via: "opencode-http" }),
    ...over,
  } as ControlChannel;
}

/** Minimal runtime + deps harness; sendToPane records whether the pane was used. */
function harness(opts: {
  mode?: "off" | "shadow" | "on";
  channel?: ControlChannel;
  paneDelivered?: boolean;
} = {}) {
  const logs: string[] = [];
  const sendToPane = vi.fn(async () => ({ delivered: opts.paneDelivered ?? true }));
  const runtime = {
    listPanes: async () => [{ paneId: "p1", title: `🔧 ${PROJECT}:${NAME}` }],
    sendToPane: async () => {},
    readPaneScreen: async () => "",
  } as never;
  const deps = {
    listTasks: async () => [{ id: "t1", name: NAME, project: PROJECT, state: "working",
                              provider: "opencode", createdAt: 1, serverPort: 4096 }],
    emitEvent: async () => {},
    sendToPane,
    controlChannel: opts.channel ?? makeChannel(),
    controlChannelMode: () => opts.mode ?? "off",
    onChannelLog: (m: string) => logs.push(m),
  } as never;
  return { runtime, deps, sendToPane, logs };
}

describe("runCrewSend — mode: off", () => {
  it("never touches the channel", async () => {
    const send = vi.fn();
    const probe = vi.fn();
    const { runtime, deps, sendToPane } = harness({
      mode: "off", channel: makeChannel({ send, probe }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(send).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(sendToPane).toHaveBeenCalledOnce();
  });
});

describe("runCrewSend — mode: shadow", () => {
  it("sends through the pane exactly once and never through the channel", async () => {
    // The whole point: shadow must NOT double-deliver.
    const send = vi.fn();
    const probe = vi.fn(async () => ({ status: "reachable", via: "opencode-http" as const }));
    const { runtime, deps, sendToPane } = harness({
      mode: "shadow", channel: makeChannel({ send, probe }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledOnce();
  });

  it("logs a disagreement when the pane says not-delivered but the session is alive", async () => {
    // This is the countable evidence for #514/#657.
    const { runtime, deps, logs } = harness({ mode: "shadow", paneDelivered: false });
    await expect(runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps)).rejects.toThrow(/not delivered/);
    expect(logs.join("\n")).toMatch(/disagree/i);
  });

  it("logs agreement without noise when both paths concur", async () => {
    const { runtime, deps, logs } = harness({ mode: "shadow", paneDelivered: true });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(logs.join("\n")).not.toMatch(/disagree/i);
  });

  it("still throws on pane failure — shadow never changes behaviour", async () => {
    const { runtime, deps } = harness({ mode: "shadow", paneDelivered: false });
    await expect(runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps)).rejects.toThrow();
  });
});

describe("runCrewSend — mode: on", () => {
  it("delivers through the channel and does not touch the pane on accepted", async () => {
    const { runtime, deps, sendToPane } = harness({ mode: "on" });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("treats queued as success — it arrived, the agent is just mid-turn", async () => {
    // #657's exact shape. Falling back here would duplicate the message.
    const { runtime, deps, sendToPane } = harness({
      mode: "on",
      channel: makeChannel({ send: async () => ({ status: "queued", via: "opencode-http" }) }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("falls back to the pane exactly once on gone, and logs why", async () => {
    const { runtime, deps, sendToPane, logs } = harness({
      mode: "on",
      channel: makeChannel({ send: async () => ({ status: "gone" }) }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("gone");
  });

  it("falls back on unsupported and logs why — a silent fallback is forbidden", async () => {
    const { runtime, deps, sendToPane, logs } = harness({
      mode: "on",
      channel: makeChannel({ send: async () => ({ status: "unsupported" }) }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("unsupported");
  });

  it("surfaces held to the operator and never retries or falls back", async () => {
    const { runtime, deps, sendToPane } = harness({
      mode: "on",
      channel: makeChannel({
        send: async () => ({ status: "held", via: "opencode-http", reason: "awaiting approval" }),
      }),
    });
    await expect(runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps)).rejects.toThrow(/awaiting approval/);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("never sends twice — one accepted send means one delivery", async () => {
    const send = vi.fn(async () => ({ status: "accepted", via: "opencode-http" as const }));
    const { runtime, deps, sendToPane } = harness({ mode: "on", channel: makeChannel({ send }) });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(send).toHaveBeenCalledOnce();
    expect(sendToPane).not.toHaveBeenCalled();
  });
});

describe("runCrewSend — mode resolution is per-agent", () => {
  it("uses the crew's provider to choose the mode", async () => {
    const modeFor = vi.fn(() => "off" as const);
    const { runtime, deps } = harness({});
    (deps as { controlChannelMode: unknown }).controlChannelMode = modeFor;
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(modeFor).toHaveBeenCalledWith("opencode");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/__tests__/crew-send-control-channel.test.ts`
Expected: FAIL — the channel is never consulted; `off`-mode tests may pass but every `shadow`/`on` test fails.

- [ ] **Step 3: Extend the `deps` type**

In `packages/core/src/crew-spawn.ts`, add to `runCrewSend`'s `deps` parameter (after `isBlockedByModal`, ~line 502):

```ts
    // #667 slice 2: native control channel for this crew's agent. Absent ⇒ the
    // pane path is used unchanged, exactly as before this slice.
    controlChannel?: ControlChannel;
    /** Per-agent rollout position. Absent ⇒ always "off". */
    controlChannelMode?: (agent: string) => ControlChannelMode;
    /** Where channel decisions and disagreements are recorded. */
    onChannelLog?: (msg: string) => void;
```

And at the top of the file:

```ts
import { fallsBackToPane, describeOutcome } from "./control-channel.js";
import type { ControlChannel, ControlChannelMode } from "./control-channel.js";
```

- [ ] **Step 4: Replace the delivery block**

Replace `packages/core/src/crew-spawn.ts:553-570` with:

```ts
  const deliver: (pane: PaneRef, msg: string) => Promise<{ delivered: boolean; blockedByModal?: boolean }> =
    deps.sendToPane ?? ((pane, msg) => runtime.sendToPane(pane, msg).then(() => ({ delivered: true })));

  // ── #667 slice 2: control channel ────────────────────────────────────────
  // Three positions, resolved per send from the crew's own provider:
  //   off     the block below is not entered at all
  //   shadow  the pane still sends and still decides; the channel runs a
  //           NON-MUTATING probe and any disagreement is logged. Deliberately
  //           NOT a real channel send — that would deliver the message twice.
  //   on      the channel leads; the pane becomes the fallback
  const agent = task?.provider;
  const mode: ControlChannelMode =
    deps.controlChannel && agent && deps.controlChannelMode
      ? deps.controlChannelMode(agent)
      : "off";
  const channelLog = deps.onChannelLog ?? (() => {});

  if (mode === "on" && deps.controlChannel && task) {
    const outcome = await deps.controlChannel.send(task.id, message);
    channelLog(`crew send ${name}: ${describeOutcome(outcome)}`);
    if (outcome.status === "held") {
      // Never retried, never fallen back — the operator must act. Retrying a
      // held message is how duplicates are manufactured.
      throw new Error(
        `Message to crew '${name}' is held: ${outcome.reason}. ` +
          `Resolve it in the crew's session, then re-send.`,
      );
    }
    if (!fallsBackToPane(outcome)) {
      // accepted / queued: it reached the agent. Done — do NOT also use the pane.
      return;
    }
    // gone / unsupported: fall back to the pane ONCE, already logged above.
  }

  if (mode === "shadow" && deps.controlChannel && task) {
    // Probe FIRST so the comparison reflects the session's state at send time,
    // and so a slow probe cannot delay a message that already went out.
    const probe = await deps.controlChannel.probe(task.id);
    const { delivered: paneOk, blockedByModal: paneModal } = await deliver(crew, message);
    const channelWouldSay = probe.status === "reachable" ? "deliverable" : probe.status;
    if (paneOk !== (probe.status === "reachable")) {
      // The measurement this mode exists for: countable evidence for #514/#657.
      channelLog(
        `crew send ${name}: DISAGREEMENT — pane=${paneOk ? "delivered" : "not delivered"}, ` +
          `channel=${channelWouldSay}`,
      );
    } else {
      channelLog(`crew send ${name}: agree (pane=${paneOk}, channel=${channelWouldSay})`);
    }
    if (paneModal) throw new Error(blockedByModalMessage());
    if (!paneOk) {
      throw new Error(`Message not delivered to crew '${name}' — the paste/submit could not be confirmed. Re-send with 'squadrant crew send ${project} ${name}'.`);
    }
    return;
  }

  const { delivered, blockedByModal } = await deliver(crew, message);
  // #516 backstop: covers the TOCTOU window between the precheck above and this
  // delivery attempt, and callers that don't inject isBlockedByModal at all.
  if (blockedByModal) {
    throw new Error(blockedByModalMessage());
  }
  if (!delivered) {
    // #566: a follow-up send has no self-heal sweep behind it — a stderr-only
    // warning let the CLI print "✔ Sent" and exit 0 for a message that was never
    // submitted. Throw so the caller fails loudly instead.
    throw new Error(`Message not delivered to crew '${name}' — the paste/submit could not be confirmed. Re-send with 'squadrant crew send ${project} ${name}'.`);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/crew-send-control-channel.test.ts`
Expected: PASS — 13 tests

- [ ] **Step 6: Run the existing crew-send tests unchanged**

Run: `pnpm vitest run packages/core/src/__tests__/crew-spawn.test.ts packages/cli/src/commands/__tests__/crew.test.ts`
Expected: PASS, **with no test modified**. These tests inject no `controlChannel`, so they take the `off` path — which must be byte-identical to today's behaviour. If any of them needed editing, the `off` path is not inert and the change is wrong.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/crew-spawn.ts packages/core/src/__tests__/crew-send-control-channel.test.ts
git commit -m "feat(#667): consult the control channel in runCrewSend behind an off-by-default flag"
```

---

### Task 5: Wire the CLI and smoke it live

**Files:**
- Modify: `packages/cli/src/commands/crew.ts:63-74`
- Modify: `docs/testing/crew-lifecycle-checklist.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new API.

> **Confirm the shadow-mode decision at the top of this plan with the operator before landing this task.**

- [ ] **Step 1: Wire `runCrewSend` in the CLI**

In `packages/cli/src/commands/crew.ts`, extend `runCrewSend`:

```ts
export async function runCrewSend(project: string, name: string, message: string, opts?: { force?: boolean }): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const cfg = loadConfig();
  // #667 slice 2: the channel needs the crew's opencode port, which the daemon
  // already persists on the TaskRecord (rec.serverPort). Resolved lazily so the
  // off path does no work at all.
  let tasks: TaskRecord[] = [];
  const controlChannel = new OpencodeHttpChannel({
    portFor: (taskId) => tasks.find((t) => t.id === taskId)?.serverPort,
    log: (m) => console.error(chalk.dim(m)),
  });
  return coreRunCrewSend(project, name, message, runtime, workspaceId, {
    listTasks: async (p) => {
      tasks = (await squadrantdCall({ kind: "list", project: p })) as TaskRecord[];
      return tasks;
    },
    emitEvent: async (p, event) => { await squadrantdCall({ kind: "event", project: p, event }); },
    sendToPane: (pane, msg) => confirmedSendToPane(runtime, pane, msg),
    isBlockedByModal: (pane) => paneHasOpenModal(runtime, pane),
    controlChannel,
    controlChannelMode: (agent) => resolveControlChannelMode(cfg.defaults.controlChannel, agent),
    onChannelLog: (m) => console.error(chalk.dim(m)),
  }, opts);
}
```

Add the imports (`OpencodeHttpChannel` from `@squadrant/agents`, `resolveControlChannelMode` and `loadConfig` from `@squadrant/shared`).

- [ ] **Step 2: Build and verify the runtime gate**

```bash
pnpm build && node dist/index.js --help
```

Expected: usage prints. Catches a missing `.js` in a relative import, which `tsc` and `vitest` both miss.

- [ ] **Step 3: Confirm `off` is genuinely inert**

With no `controlChannel` block in config, run a normal `squadrant crew send` against a live opencode crew.

Expected: identical behaviour and identical output to before this slice — no new log lines at all. **Any visible difference means `off` is not inert.**

- [ ] **Step 4: Smoke `shadow` on a throwaway TEST project**

> **Never smoke against the real config.** Export `SQUADRANT_CONFIG` to a throwaway directory (honoured since #668). A crew booted a daemon against `~/.config/squadrant` on 2026-08-13 and **seized the production socket**.

```bash
export SQUADRANT_CONFIG="$(mktemp -d)/squadrant"
echo "$SQUADRANT_CONFIG"   # confirm it is NOT ~/.config/squadrant
squadrant config set defaults.controlChannel.opencode shadow
```

Send to a live opencode crew and read the log line.

Expected: `crew send crew-1: agree (pane=true, channel=deliverable)`, the crew receives the message **exactly once**, and the transcript shows one user turn. Two turns means the probe is mutating — a bug in `probe()`.

- [ ] **Step 5: Close unknown (a) — what opencode does mid-turn**

This is one of the three unknowns the spec deliberately left to smoke rather than guessing. With the crew **mid-turn**, flip to `on` and send:

```bash
squadrant config set defaults.controlChannel.opencode on
squadrant crew send <test-project> crew-1 "mid-turn probe message"
```

Record which happens:
- **204 and the message is queued** → the `accepted` mapping is right; consider adding a distinct `queued` mapping if opencode signals it.
- **an error status** → map that status to `queued` or `gone` explicitly in `http-channel.ts` and add a unit test for it.

**Read the transcript, not the status code.** `204` proves only that a handler accepted bytes; the transcript proves the turn ran.

- [ ] **Step 6: Close the `gone` path end-to-end**

Kill the crew's opencode process, then send.

Expected: `session gone — falling back to pane`, the pane fallback runs **once**, and there is no retry loop.

- [ ] **Step 7: Record versions and update the checklist**

```bash
opencode --version
```

Append to `docs/testing/crew-lifecycle-checklist.md`:

```markdown
## Control channel (#667 slice 2)

opencode's HTTP routes are **not** a promised-stable contract — 1.18.18 is mid-migration
from `/session/*` to `/api/session/*`. `OpencodeHttpChannel` probes both.

On any opencode upgrade, re-run:
- shadow-mode send → exactly ONE user turn in the transcript (a mutating probe would double it)
- `prompt_async` → 204 on a live session
- `prompt_async` → 404 on a dead session id (this is what makes `gone` honest)
```

- [ ] **Step 8: Commit and open the PR**

```bash
git add packages/cli/src/commands/crew.ts docs/testing/crew-lifecycle-checklist.md
git commit -m "feat(#667): wire the opencode control channel into crew send"
gh pr create --base develop --title "feat(#667): slice 2 — ControlChannel port + opencode delivery" \
  --body "Implements §1, the opencode half of §2, and the §5 rollout flag of
docs/specs/2026-08-13-agent-control-channel-design.md.

Off by default — merging changes nothing for anyone who does not opt in.

- DeliveryOutcome is a five-branch union, never a boolean (that collapse is where
  the #514/#657 false negatives come from)
- prompt_async over /tui/*: addressed by session id, 404s on a dead session
- shadow mode is a DRY-RUN PROBE, not a second send — see the note at the top of
  the plan; confirm this reading before merge

Smoke evidence and opencode version below."
```

---

## Success Criteria

1. `pnpm build && pnpm test` green **and CI green on the PR** — not just locally (the 2026-08-13 lesson: that suite was green only because the machine had a live daemon).
2. `node dist/index.js --help` runs.
3. **No existing test needed modification.** The `off` path must be byte-identical to today.
4. With no config change, `squadrant crew send` behaves and logs exactly as before.
5. Shadow mode delivers the message **exactly once** (verified in the crew's transcript, not by status code) and logs an agree/disagree line.
6. `prompt_async` returns 204 on a live session and 404 on a dead one, live.
7. The `gone` path falls back to the pane once, logged, with no retry loop.
8. Unknown (a) — opencode's mid-turn behaviour — is **recorded from observation**, and the mapping in `http-channel.ts` matches what was observed.

## Explicit Non-Goals

- Claude delivery (`peer-channel.ts`, `--messaging-socket-path`, T1-confirms-T0) — that is slice 3, which depends on slices 1 and 2.
- Retiring `confirmedSendToPane`. It stays as the fallback for `gone` / `unsupported`.
- The opencode server password. Split to **#675** by operator decision on 2026-08-15; it is a live hole today, predates this work, and must not wait on the shadow-mode schedule.
- T2 interact (approvals, questions, interrupt). The `interrupt?()` slot exists on the port; nothing implements it in this slice.
- Cutting over from shadow to `on` by default. Per the operator's 2026-08-15 decision, cutover is **evidence-based, not calendar-based** — the threshold is set after this slice lands and real event volume is visible.
