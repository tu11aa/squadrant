# #667 Slice 3 — Claude Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude crews and captains a native `ControlChannel` so squadrant can deliver a message over Claude's own UDS inbox socket and know what happened to it, instead of inferring delivery from terminal pixels.

**Architecture:** A new `ClaudePeerChannel` implements the existing `ControlChannel` port over Claude's newline-delimited-JSON inbox socket. Because Claude's accept path is silent, T0 delivery is confirmed by T1: after writing the line we watch the session registry (already read by slice 1's `ClaudePeerRegistrySource`) for an `idle → busy` flip. The daemon additionally binds its own `.sock` inside the receivers' socket directory so it becomes *addressable* and receives `peer_message_status` receipts — which is the only way `held` is observable at all.

**Tech Stack:** TypeScript (NodeNext ESM), `node:net` UDS, vitest. No new dependencies.

**Spec:** [`docs/specs/2026-08-13-agent-control-channel-design.md`](../../specs/2026-08-13-agent-control-channel-design.md) — read §1 (the port), §2 (outcomes), §3 (T1-confirms-T0 and retry policy), and the two 2026-08-17 smoke-test sections. The wire protocol itself is in `~/squadrant-hub/spokes/squadrant/findings/2026-08-08-cc-peer-messaging-protocol.md` (§2 framing/envelope, §3 inbound gate, §4 receipts).

**Depends on:** Slices 1 and 2, both merged to `develop` (`cc85958`, `9160ef4`). Do not re-implement anything they landed.

## Global Constraints

Every task's requirements implicitly include all of these.

- **NodeNext ESM:** every relative import MUST end in `.js`. `tsc` and `vitest` both miss a missing extension; the only real gate is `node dist/index.js --help` after `pnpm build`.
- **One-way package DAG:** `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`. The port stays in `core`; the implementation goes in `agents`; wiring goes in `cli`. `core` may NEVER import `@squadrant/agents`.
- **No test may depend on ambient state.** Inject every socket, timer, and filesystem read. A test that reaches a real socket is a test that lies on CI. Precedent: `heal.ts` accepts `isDaemonAlive`; `OpencodeHttpChannel` accepts `fetchImpl`.
- **Ships behind `off` by default.** `resolveControlChannelMode` already returns `"off"` for unset/unknown/invalid. Merging this slice must change nothing for an operator who does not opt in.
- **NEVER retry `accepted` / `queued` / `held`.** Claude silently drops byte-identical messages from the same sender inside a **30 s** window (`dedupWindowMs: 30000`). A naive retry manufactures exactly the false negative this work removes. Retry ONLY on transport error (`ECONNREFUSED`, timeout), and the body MUST vary.
- **The daemon must NEVER attest `from-mode="bypass"`.** Verified: it holds *every* message. Attest nothing, or attest the receiver's real class.
- **`held` is terminal for the send call.** Surface it to the operator. Never auto-resolve, never fall back to the pane.
- **Smoke runs on a throwaway TEST project only**, never a real one, and never against `~/.config/squadrant` (set `SQUADRANT_CONFIG`). A crew seized the production socket doing this on 2026-08-13.
- **When spawning `claude` from inside a Claude Code session, clear the inherited `CLAUDE_CODE_*` env** (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`) or the spawned session silently skips its own registry registration (issue #680). Use `env -i HOME=… PATH=… TERM=… CLAUDE_CODE_HARBOR_KITE=1 claude …`.
- **Terminal states stay with `squadrant crew signal`.** No code in this slice may emit `task.done` / `task.blocked` / `task.cancelled`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/agents/src/claude/peer-wire.ts` (create) | Pure envelope construction + NDJSON write over an injected socket factory. No policy, no registry reads. |
| `packages/agents/src/claude/receipt-listener.ts` (create) | Binds squadrant's own `.sock` in the receivers' socket dir; parses `peer_message_status` frames; emits typed receipts. |
| `packages/agents/src/claude/peer-channel.ts` (create) | `ControlChannel` impl: `send()` (wire + receipt race + T1 confirm), `probe()` (registry read). Composes the three above. |
| `packages/core/src/control-channel.ts` (modify) | Add `confirmed?: boolean` to the `accepted` branch; update `describeOutcome`. Additive only. |
| `packages/agents/src/drivers/types.ts` (modify) | Add `messagingSocketPath?: string` to `SpawnOptions`. |
| `packages/agents/src/drivers/claude.ts` (modify) | Emit `--messaging-socket-path <path>` when the option is set. |
| `packages/core/src/crew-spawn.ts` (modify) | Resolve the channel **per agent** instead of taking one; allocate + persist the socket path. |
| `packages/cli/src/commands/crew.ts` (modify) | Construct both channels and pass a resolver. |
| `docs/testing/crew-lifecycle-checklist.md` (modify) | Add the claude-delivery smoke rows. |

---

### Task 1: Extend `DeliveryOutcome.accepted` with a confirmation flag

Claude's accept path is silent, so "we wrote the bytes" and "the agent started a turn" are different facts. The spec (§3) requires recording `accepted-unconfirmed` **honestly** rather than pretending. This is an additive field, not a sixth branch — `fallsBackToPane` must keep behaving identically.

**Files:**
- Modify: `packages/core/src/control-channel.ts`
- Test: `packages/core/src/__tests__/control-channel.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `DeliveryOutcome` `accepted` branch is now `{ status: "accepted"; via: ChannelName; confirmed?: boolean }`. `describeOutcome` renders `confirmed === false` as `accepted via <via> (unconfirmed — no turn observed)`. `fallsBackToPane` unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/__tests__/control-channel.test.ts`:

```ts
import { describeOutcome, fallsBackToPane } from "../control-channel.js";

describe("accepted confirmation flag (#667 slice 3)", () => {
  it("renders an unconfirmed accept distinctly from a confirmed one", () => {
    expect(describeOutcome({ status: "accepted", via: "claude-peer", confirmed: true }))
      .toBe("accepted via claude-peer");
    expect(describeOutcome({ status: "accepted", via: "claude-peer", confirmed: false }))
      .toBe("accepted via claude-peer (unconfirmed — no turn observed)");
  });

  it("omitted confirmed reads as a plain accept (slice 2 callers unchanged)", () => {
    expect(describeOutcome({ status: "accepted", via: "opencode-http" }))
      .toBe("accepted via opencode-http");
  });

  it("an unconfirmed accept still does NOT fall back to the pane", () => {
    // Critical: unconfirmed means "we don't know the agent read it", NOT "it failed".
    // Falling back here would double-send — the exact duplicate this port removes.
    expect(fallsBackToPane({ status: "accepted", via: "claude-peer", confirmed: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/__tests__/control-channel.test.ts -t "confirmation flag"`
Expected: FAIL — the unconfirmed string does not match, because `describeOutcome` ignores the flag.

- [ ] **Step 3: Implement**

In `packages/core/src/control-channel.ts`, change the `accepted` branch of `DeliveryOutcome`:

```ts
  | { status: "accepted"; via: ChannelName; confirmed?: boolean }  // agent acknowledged receipt
```

Add this comment above it:

```ts
  // `confirmed` exists because claude's accept path is SILENT (verified: a
  // delivered message produced no receipt after 20 s). `confirmed: false` means
  // "the bytes were accepted by a listening process, but no turn was observed".
  // It is NOT a failure and MUST NOT fall back to the pane. opencode omits the
  // field entirely — its 204 is a real server-side accept.
```

And in `describeOutcome`:

```ts
    case "accepted":
      return o.confirmed === false
        ? `accepted via ${o.via} (unconfirmed — no turn observed)`
        : `accepted via ${o.via}`;
```

- [ ] **Step 4: Run the test and the full core suite**

Run: `pnpm vitest run packages/core/src/__tests__/control-channel.test.ts`
Expected: PASS, and every pre-existing case in that file still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/control-channel.ts packages/core/src/__tests__/control-channel.test.ts
git commit -m "feat(#667): record accepted-unconfirmed on the DeliveryOutcome accepted branch"
```

---

### Task 2: `peer-wire.ts` — envelope construction and the NDJSON write

Pure and injectable. This task owns the wire format and nothing else: no registry reads, no receipt correlation, no retry policy.

**Files:**
- Create: `packages/agents/src/claude/peer-wire.ts`
- Test: `packages/agents/src/claude/__tests__/peer-wire.test.ts`

**Interfaces:**
- Consumes: Task 1's `DeliveryOutcome` type is NOT used here — this layer returns a raw write result.
- Produces:
  - `buildUserEnvelope(opts: { sessionId?: string; from?: string; content: string; msgId: string }): PeerUserEnvelope`
  - `type WireResult = { ok: true } | { ok: false; reason: "gone" | "transport"; error: string }`
  - `writeLine(socketPath: string, envelope: object, deps: PeerWireDeps): Promise<WireResult>`
  - `interface PeerWireDeps { connect: (path: string) => import("node:net").Socket; timeoutMs?: number }`

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/claude/__tests__/peer-wire.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildUserEnvelope, writeLine } from "../peer-wire.js";

/** A fake net.Socket. No real socket is ever opened — see the no-ambient-state rule. */
function fakeSocket(behaviour: "connect" | "enoent" | "hang") {
  const s = new EventEmitter() as any;
  s.written = [];
  s.write = (chunk: string, cb?: () => void) => { s.written.push(chunk); cb?.(); return true; };
  s.end = vi.fn();
  s.destroy = vi.fn();
  s.setTimeout = vi.fn();
  process.nextTick(() => {
    if (behaviour === "connect") s.emit("connect");
    if (behaviour === "enoent") s.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
    // "hang" emits nothing.
  });
  return s;
}

describe("buildUserEnvelope", () => {
  it("produces the verified type:user envelope shape", () => {
    const e = buildUserEnvelope({
      sessionId: "ses_abc", from: "uds:/tmp/cc-socks/squadrantd.sock",
      content: "hello", msgId: "11111111-1111-4111-8111-111111111111",
    });
    expect(e).toEqual({
      msgV: 1,
      msg_id: "11111111-1111-4111-8111-111111111111",
      type: "user",
      priority: "next",
      session_id: "ses_abc",
      from: "uds:/tmp/cc-socks/squadrantd.sock",
      message: { role: "user", content: "hello" },
    });
  });

  it("omits session_id and from when not supplied rather than sending null", () => {
    const e = buildUserEnvelope({ content: "hi", msgId: "m1" }) as Record<string, unknown>;
    expect("session_id" in e).toBe(false);
    expect("from" in e).toBe(false);
  });

  it("NEVER includes a from-mode attestation", () => {
    // Global constraint: attesting from-mode="bypass" holds EVERY message.
    // This layer must not emit the field at all.
    const e = buildUserEnvelope({ content: "hi", msgId: "m1" }) as Record<string, unknown>;
    expect("from-mode" in e).toBe(false);
    expect("from_mode" in e).toBe(false);
  });

  it("rejects empty content — the receiver silently ignores it", () => {
    expect(() => buildUserEnvelope({ content: "", msgId: "m1" })).toThrow(/non-empty/);
  });
});

describe("writeLine", () => {
  it("writes exactly one newline-terminated JSON line", async () => {
    const sock = fakeSocket("connect");
    const r = await writeLine("/tmp/x.sock", { type: "user" }, { connect: () => sock });
    expect(r).toEqual({ ok: true });
    expect(sock.written).toEqual(['{"type":"user"}\n']);
  });

  it("maps ENOENT to gone — the session is dead, caller may fall back", async () => {
    const sock = fakeSocket("enoent");
    const r = await writeLine("/tmp/x.sock", { type: "user" }, { connect: () => sock });
    expect(r).toEqual({ ok: false, reason: "gone", error: expect.stringContaining("ENOENT") });
  });

  it("maps a hang to transport, not gone — retry is allowed only here", async () => {
    const sock = fakeSocket("hang");
    const r = await writeLine("/tmp/x.sock", { type: "user" }, { connect: () => sock, timeoutMs: 5 });
    expect(r).toEqual({ ok: false, reason: "transport", error: expect.stringContaining("timeout") });
  });

  it("refuses a line over the receiver's 1 MiB buffer cap", async () => {
    const sock = fakeSocket("connect");
    const huge = { type: "user", message: { role: "user", content: "x".repeat(1_048_600) } };
    const r = await writeLine("/tmp/x.sock", huge, { connect: () => sock });
    expect(r).toEqual({ ok: false, reason: "transport", error: expect.stringContaining("1 MiB") });
    expect(sock.written).toEqual([]);  // never even attempted
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/peer-wire.test.ts`
Expected: FAIL — `Cannot find module '../peer-wire.js'`.

- [ ] **Step 3: Implement**

Create `packages/agents/src/claude/peer-wire.ts`:

```ts
// packages/agents/src/claude/peer-wire.ts
//
// Claude cross-session messaging wire format (#667 slice 3).
//
// Empirically determined 2026-08-08 and reconfirmed on 2.1.233 (2026-08-17);
// see the spec's smoke sections. Framing is one JSON object + one "\n". The
// receiver NEVER sends anything back on the inbound connection — a successful
// connect+write is the entire in-band signal. Receipts arrive out-of-band on
// OUR socket (receipt-listener.ts), which is why `from` matters.
//
// This module is deliberately pure: envelope shape and byte delivery only. No
// registry reads, no retry policy, no outcome mapping.

import type { Socket } from "node:net";

/** Receiver destroys the connection past this. Refuse locally instead. */
const MAX_LINE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 3_000;

export interface PeerUserEnvelope {
  msgV: 1;
  msg_id: string;
  type: "user";
  priority: "next";
  session_id?: string;
  from?: string;
  message: { role: "user"; content: string };
}

export interface PeerWireDeps {
  connect: (path: string) => Socket;
  timeoutMs?: number;
}

export type WireResult =
  | { ok: true }
  | { ok: false; reason: "gone" | "transport"; error: string };

/**
 * Build the verified `type: "user"` envelope.
 *
 * `session_id` is the pid-reuse guard: a mismatch against the receiver's own id
 * is silently dropped, which is exactly what we want — better a silent drop than
 * a message injected into whoever inherited the pid.
 *
 * NOTE: no `from-mode` attestation is ever emitted. Attesting "bypass" against a
 * `--permission-mode auto` receiver holds EVERY message (verified twice).
 */
export function buildUserEnvelope(opts: {
  sessionId?: string;
  from?: string;
  content: string;
  msgId: string;
}): PeerUserEnvelope {
  if (!opts.content) throw new Error("peer-wire: message content must be a non-empty string");
  return {
    msgV: 1,
    msg_id: opts.msgId,
    type: "user",
    priority: "next",
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    ...(opts.from ? { from: opts.from } : {}),
    message: { role: "user", content: opts.content },
  };
}

/** Write one NDJSON line. Resolves once the bytes are flushed. */
export function writeLine(
  socketPath: string,
  envelope: object,
  deps: PeerWireDeps,
): Promise<WireResult> {
  const line = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    return Promise.resolve({
      ok: false,
      reason: "transport",
      error: `line exceeds the receiver's 1 MiB buffer cap (${Buffer.byteLength(line, "utf8")} bytes)`,
    });
  }

  return new Promise<WireResult>((resolve) => {
    let settled = false;
    const done = (r: WireResult) => { if (!settled) { settled = true; resolve(r); } };

    const sock = deps.connect(socketPath);
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* best-effort */ }
      done({ ok: false, reason: "transport", error: `timeout after ${deps.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` });
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    sock.on("connect", () => {
      sock.write(line, () => {
        clearTimeout(timer);
        try { sock.end(); } catch { /* best-effort */ }
        done({ ok: true });
      });
    });

    sock.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT/ECONNREFUSED: nothing is listening -> the session is gone. That is
      // a real answer, not a transport blip, and it is the caller's cue to fall
      // back to the pane. Everything else may be transient.
      const gone = e.code === "ENOENT" || e.code === "ECONNREFUSED";
      done({ ok: false, reason: gone ? "gone" : "transport", error: e.message });
    });
  });
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/peer-wire.test.ts`
Expected: PASS, all 8 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/claude/peer-wire.ts packages/agents/src/claude/__tests__/peer-wire.test.ts
git commit -m "feat(#667): claude peer-messaging wire format and NDJSON writer"
```

---

### Task 3: `receipt-listener.ts` — become addressable so `held` is observable

The receiver refuses to send a receipt to a `from` address outside its own socket namespace: our reply socket must live in the **same directory** as the receiver's socket and end in `.sock`. Without this, `held` is invisible and the `held` branch of `DeliveryOutcome` can never fire for Claude.

**Files:**
- Create: `packages/agents/src/claude/receipt-listener.ts`
- Test: `packages/agents/src/claude/__tests__/receipt-listener.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type PeerReceipt = { status: "held" | "denied" | "delivered" | "expired"; reason: string; origMsgId: string }`
  - `class ClaudeReceiptListener` with:
    - `constructor(deps: { socketPath: string; createServer: typeof import("node:net").createServer; log?: (m: string) => void })`
    - `start(): Promise<void>`
    - `stop(): void`
    - `waitFor(origMsgId: string, timeoutMs: number): Promise<PeerReceipt | undefined>`
    - `onLate(cb: (r: PeerReceipt) => void): void` — receipts arriving after `waitFor` resolved (a human approving a hold minutes later).
    - `readonly address: string` — the `uds:<path>` string to put in `from`.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/claude/__tests__/receipt-listener.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeReceiptListener } from "../receipt-listener.js";

/** Fake net.Server + a helper to feed it a connection carrying NDJSON. */
function fakeServer() {
  const srv = new EventEmitter() as any;
  srv.listen = (_p: string, cb?: () => void) => { cb?.(); return srv; };
  srv.close = vi.fn((cb?: () => void) => cb?.());
  srv.feed = (lines: string) => {
    const conn = new EventEmitter() as any;
    conn.setEncoding = vi.fn();
    srv.emit("connection", conn);
    conn.emit("data", lines);
    conn.emit("end");
  };
  return srv;
}

const RECEIPT = (status: string, orig: string) => JSON.stringify({
  type: "control", action: "peer_message_status", status,
  reason: `r-${status}`, orig_msg_id: orig, msgV: 1, msg_id: "x",
}) + "\n";

describe("ClaudeReceiptListener", () => {
  it("advertises a uds: address in the receivers' socket directory", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/squadrantd.sock", createServer: () => srv });
    expect(l.address).toBe("uds:/tmp/cc-socks/squadrantd.sock");
  });

  it("resolves waitFor with a correlated held receipt", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: () => srv });
    await l.start();
    const p = l.waitFor("m-1", 1000);
    srv.feed(RECEIPT("held", "m-1"));
    await expect(p).resolves.toEqual({ status: "held", reason: "r-held", origMsgId: "m-1" });
  });

  it("ignores a receipt for a different message", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: () => srv });
    await l.start();
    const p = l.waitFor("m-1", 20);
    srv.feed(RECEIPT("held", "m-OTHER"));
    await expect(p).resolves.toBeUndefined();
  });

  it("resolves undefined on timeout — silence is ambiguous, never an error", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: () => srv });
    await l.start();
    await expect(l.waitFor("m-1", 10)).resolves.toBeUndefined();
  });

  it("routes a late receipt (human approved a hold) to onLate", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: () => srv });
    await l.start();
    const late: unknown[] = [];
    l.onLate((r) => late.push(r));
    await l.waitFor("m-2", 5);                 // times out first
    srv.feed(RECEIPT("delivered", "m-2"));     // ...then the human approves
    expect(late).toEqual([{ status: "delivered", reason: "r-delivered", origMsgId: "m-2" }]);
  });

  it("survives a partial line split across two data events", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: () => srv });
    await l.start();
    const p = l.waitFor("m-3", 1000);
    const full = RECEIPT("denied", "m-3");
    const conn = new EventEmitter() as any;
    conn.setEncoding = vi.fn();
    srv.emit("connection", conn);
    conn.emit("data", full.slice(0, 20));
    conn.emit("data", full.slice(20));
    await expect(p).resolves.toEqual({ status: "denied", reason: "r-denied", origMsgId: "m-3" });
  });

  it("discards non-JSON and non-receipt frames without throwing", async () => {
    const srv = fakeServer();
    const l = new ClaudeReceiptListener({ socketPath: "/tmp/cc-socks/s.sock", createServer: () => srv });
    await l.start();
    const p = l.waitFor("m-4", 30);
    srv.feed("not json\n" + JSON.stringify({ type: "control", action: "something_else" }) + "\n");
    await expect(p).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/receipt-listener.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/agents/src/claude/receipt-listener.ts`:

```ts
// packages/agents/src/claude/receipt-listener.ts
//
// #667 slice 3: squadrant's own inbox, so Claude will talk back to us.
//
// Verified 2026-08-08: the receiver refuses to send a receipt to a `from`
// address outside its own socket namespace — the reply path must sit in the SAME
// DIRECTORY as the receiver's socket and end in ".sock". So this binds a socket
// next to the crews' sockets and advertises it in every envelope's `from`.
//
// That directory is therefore a trust boundary; hardening its permissions is
// tracked in #675, NOT here.
//
// Receipt semantics (all four verified live on 2.1.233, 2026-08-17):
//   held      -> awaiting the recipient user's approval
//   denied    -> user declined; NO user turn is ever added
//   delivered -> a previously-held message was released
//   expired   -> the hold aged out
// The plain accept path sends NOTHING. Absence of a receipt is ambiguous: it
// means delivered OR refused OR silently dropped. Never treat it as failure.

import type { Server } from "node:net";

export interface PeerReceipt {
  status: "held" | "denied" | "delivered" | "expired";
  reason: string;
  origMsgId: string;
}

const KNOWN: ReadonlySet<string> = new Set(["held", "denied", "delivered", "expired"]);

export interface ClaudeReceiptListenerDeps {
  socketPath: string;
  createServer: (handler: (conn: import("node:net").Socket) => void) => Server;
  log?: (m: string) => void;
}

export class ClaudeReceiptListener {
  readonly address: string;
  private server?: Server;
  private readonly waiters = new Map<string, (r: PeerReceipt) => void>();
  private lateCb?: (r: PeerReceipt) => void;

  constructor(private readonly deps: ClaudeReceiptListenerDeps) {
    this.address = `uds:${deps.socketPath}`;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.deps.createServer((conn) => this.handle(conn));
      this.server.listen(this.deps.socketPath, () => resolve());
    });
  }

  stop(): void {
    try { this.server?.close(); } catch { /* best-effort */ }
    this.server = undefined;
    this.waiters.clear();
  }

  onLate(cb: (r: PeerReceipt) => void): void { this.lateCb = cb; }

  /**
   * Wait for the receipt correlating to one msg_id.
   *
   * Resolves `undefined` on timeout — and that is NOT an error. The accept path
   * is silent by design, so "no receipt" is the common, healthy case.
   */
  waitFor(origMsgId: string, timeoutMs: number): Promise<PeerReceipt | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(origMsgId); resolve(undefined); }, timeoutMs);
      this.waiters.set(origMsgId, (r) => { clearTimeout(timer); this.waiters.delete(origMsgId); resolve(r); });
    });
  }

  private handle(conn: import("node:net").Socket): void {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.dispatch(line);
      }
    });
    conn.on("error", () => { /* a peer hanging up is not our problem */ });
  }

  private dispatch(line: string): void {
    if (!line.trim()) return;
    let f: Record<string, unknown>;
    try { f = JSON.parse(line) as Record<string, unknown>; }
    catch { this.deps.log?.(`claude-receipt: discarded non-JSON frame`); return; }
    if (f.action !== "peer_message_status") return;
    const status = String(f.status ?? "");
    if (!KNOWN.has(status)) { this.deps.log?.(`claude-receipt: unknown status ${status}`); return; }

    const r: PeerReceipt = {
      status: status as PeerReceipt["status"],
      reason: String(f.reason ?? ""),
      origMsgId: String(f.orig_msg_id ?? ""),
    };
    const waiter = this.waiters.get(r.origMsgId);
    if (waiter) { waiter(r); return; }
    // No waiter: the send call already returned. This is the human-approved-a-hold
    // path — minutes can pass. Surface it so the captain learns the real outcome.
    this.lateCb?.(r);
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/receipt-listener.test.ts`
Expected: PASS, all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/claude/receipt-listener.ts packages/agents/src/claude/__tests__/receipt-listener.test.ts
git commit -m "feat(#667): claude receipt listener so held/denied/delivered are observable"
```

---

### Task 4: `peer-channel.ts` — the `ControlChannel` implementation with T1-confirms-T0

**Files:**
- Create: `packages/agents/src/claude/peer-channel.ts`
- Test: `packages/agents/src/claude/__tests__/peer-channel.test.ts`

**Interfaces:**
- Consumes: `buildUserEnvelope`/`writeLine`/`WireResult` (Task 2); `ClaudeReceiptListener`/`PeerReceipt` (Task 3); `DeliveryOutcome` with `confirmed` (Task 1); `parseRegistryDir`/`toLifecycleSnapshot` from slice 1's `packages/agents/src/claude/registry.ts`.
- Produces: `class ClaudePeerChannel implements ControlChannel` with `name = "claude-peer"`, `agent = "claude"`, and constructor deps `{ socketPathFor, sessionIdFor, statusFor, wire, receipts, newMsgId, sleep, confirmWindowMs?, log? }`.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/claude/__tests__/peer-channel.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ClaudePeerChannel } from "../peer-channel.js";

/** Minimal deps: nothing touches a real socket, clock, or filesystem. */
function mk(over: Partial<Parameters<typeof ClaudePeerChannel.prototype.constructor>[0]> = {}) {
  const base = {
    socketPathFor: (_t: string) => "/tmp/cc-socks/crew.sock",
    sessionIdFor: (_t: string) => "ses_abc",
    statusFor: vi.fn().mockReturnValue("idle"),
    wire: vi.fn().mockResolvedValue({ ok: true }),
    receipts: { address: "uds:/tmp/cc-socks/squadrantd.sock", waitFor: vi.fn().mockResolvedValue(undefined) },
    newMsgId: () => "m-1",
    sleep: vi.fn().mockResolvedValue(undefined),
    confirmWindowMs: 100,
  };
  return new ClaudePeerChannel({ ...base, ...over } as never);
}

describe("ClaudePeerChannel.send", () => {
  it("returns unsupported when the task has no socket path", async () => {
    const ch = mk({ socketPathFor: () => undefined });
    expect(await ch.send("t1", "hi")).toEqual({ status: "unsupported" });
  });

  it("returns gone when nothing is listening", async () => {
    const ch = mk({ wire: vi.fn().mockResolvedValue({ ok: false, reason: "gone", error: "ENOENT" }) });
    expect(await ch.send("t1", "hi")).toEqual({ status: "gone" });
  });

  it("held wins over a status flip — a held receipt is authoritative", async () => {
    const ch = mk({
      receipts: {
        address: "uds:/x.sock",
        waitFor: vi.fn().mockResolvedValue({ status: "held", reason: "parity", origMsgId: "m-1" }),
      },
      statusFor: vi.fn().mockReturnValue("busy"),
    });
    expect(await ch.send("t1", "hi")).toEqual({ status: "held", via: "claude-peer", reason: "parity" });
  });

  it("confirms via the T1 idle->busy flip when no receipt arrives", async () => {
    // idle at send time, busy after -> the injected message started a turn.
    const statusFor = vi.fn().mockReturnValueOnce("idle").mockReturnValue("busy");
    const ch = mk({ statusFor });
    expect(await ch.send("t1", "hi")).toEqual({ status: "accepted", via: "claude-peer", confirmed: true });
  });

  it("records accepted-unconfirmed when no flip is observed, and does NOT retry", async () => {
    const wire = vi.fn().mockResolvedValue({ ok: true });
    const ch = mk({ wire, statusFor: vi.fn().mockReturnValue("idle") });
    expect(await ch.send("t1", "hi")).toEqual({ status: "accepted", via: "claude-peer", confirmed: false });
    expect(wire).toHaveBeenCalledTimes(1);   // the 30 s dedup rule
  });

  it("treats an already-busy session as accepted-unconfirmed, never as a flip", async () => {
    // Busy before AND after tells us nothing — refusing to claim confirmation
    // here is the whole point of not inferring.
    const ch = mk({ statusFor: vi.fn().mockReturnValue("busy") });
    expect(await ch.send("t1", "hi")).toEqual({ status: "accepted", via: "claude-peer", confirmed: false });
  });

  it("puts its own receipt address in from, and never a from-mode", async () => {
    const wire = vi.fn().mockResolvedValue({ ok: true });
    const ch = mk({ wire });
    await ch.send("t1", "hi");
    const envelope = wire.mock.calls[0][1] as Record<string, unknown>;
    expect(envelope.from).toBe("uds:/tmp/cc-socks/squadrantd.sock");
    expect(envelope.session_id).toBe("ses_abc");
    expect("from-mode" in envelope).toBe(false);
  });

  it("does not retry a transport error itself — the caller owns retry policy", async () => {
    const wire = vi.fn().mockResolvedValue({ ok: false, reason: "transport", error: "timeout" });
    const ch = mk({ wire });
    expect(await ch.send("t1", "hi")).toEqual({ status: "gone" });
    expect(wire).toHaveBeenCalledTimes(1);
  });
});

describe("ClaudePeerChannel.probe", () => {
  it("is reachable when the registry knows the session", async () => {
    const ch = mk({ statusFor: vi.fn().mockReturnValue("idle") });
    expect(await ch.probe("t1")).toEqual({ status: "reachable", via: "claude-peer" });
  });

  it("is gone when the registry has no entry", async () => {
    const ch = mk({ statusFor: vi.fn().mockReturnValue(undefined) });
    expect(await ch.probe("t1")).toEqual({ status: "gone" });
  });

  it("is unsupported without a socket path", async () => {
    const ch = mk({ socketPathFor: () => undefined });
    expect(await ch.probe("t1")).toEqual({ status: "unsupported" });
  });

  it("writes nothing — probe MUST be non-mutating", async () => {
    const wire = vi.fn();
    const ch = mk({ wire });
    await ch.probe("t1");
    expect(wire).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/peer-channel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/agents/src/claude/peer-channel.ts`:

```ts
// packages/agents/src/claude/peer-channel.ts
//
// #667 slice 3: ControlChannel over claude's UDS session inbox.
//
// The hard part is NOT sending — it is knowing what happened. Claude's accept
// path is silent (verified: no receipt after 20 s for a message that demonstrably
// arrived). So this composes three signals:
//
//   1. the wire result      -> did a process accept our bytes?
//   2. a receipt, if any    -> held/denied/delivered/expired (authoritative)
//   3. the T1 status flip   -> idle -> busy means a turn actually started
//
// Precedence: a receipt beats everything. Then a flip means confirmed. Then
// "accepted but unconfirmed", recorded honestly rather than guessed.
//
// RETRY: never here. accepted/queued/held are never retried (30 s byte-identical
// dedup would silently swallow it and manufacture a false negative). A transport
// failure surfaces as `gone` so the caller falls back to the pane exactly once.

import type { ControlChannel, DeliveryOutcome, ProbeResult, ChannelName } from "@squadrant/core";
import { buildUserEnvelope, type WireResult } from "./peer-wire.js";
import type { PeerReceipt } from "./receipt-listener.js";

/** Claude's registry `status` values (slice 1's registry.ts maps these). */
export type ClaudeStatus = "idle" | "busy" | "shell" | "waiting" | undefined;

export interface ClaudePeerChannelDeps {
  /** Where this task's session listens. undefined ⇒ this crew was not launched with the flag. */
  socketPathFor: (taskId: string) => string | undefined;
  /** Receiver's own session id — the pid-reuse guard. */
  sessionIdFor: (taskId: string) => string | undefined;
  /** Current registry status, from slice 1's ClaudePeerRegistrySource view. */
  statusFor: (taskId: string) => ClaudeStatus;
  wire: (socketPath: string, envelope: object) => Promise<WireResult>;
  receipts: { address: string; waitFor: (msgId: string, timeoutMs: number) => Promise<PeerReceipt | undefined> };
  newMsgId: () => string;
  sleep: (ms: number) => Promise<void>;
  /** How long to watch for a receipt and a status flip. */
  confirmWindowMs?: number;
  log?: (m: string) => void;
}

const DEFAULT_CONFIRM_WINDOW_MS = 4_000;

export class ClaudePeerChannel implements ControlChannel {
  readonly name: ChannelName = "claude-peer";
  readonly agent = "claude";

  constructor(private readonly deps: ClaudePeerChannelDeps) {}

  async send(taskId: string, message: string): Promise<DeliveryOutcome> {
    const socketPath = this.deps.socketPathFor(taskId);
    if (!socketPath) return { status: "unsupported" };

    const statusBefore = this.deps.statusFor(taskId);
    const msgId = this.deps.newMsgId();
    const envelope = buildUserEnvelope({
      content: message,
      msgId,
      from: this.deps.receipts.address,
      ...(this.deps.sessionIdFor(taskId) ? { sessionId: this.deps.sessionIdFor(taskId) } : {}),
    });

    const window = this.deps.confirmWindowMs ?? DEFAULT_CONFIRM_WINDOW_MS;
    // Arm the receipt wait BEFORE writing, or a fast hold receipt races past us.
    const receiptP = this.deps.receipts.waitFor(msgId, window);

    const w = await this.deps.wire(socketPath, envelope);
    if (!w.ok) {
      // Both "gone" and "transport" surface as gone: the caller falls back to the
      // pane once. Retrying here is what the 30 s dedup punishes.
      this.deps.log?.(`claude-peer: write failed (${w.reason}): ${w.error}`);
      return { status: "gone" };
    }

    const receipt = await receiptP;
    if (receipt) {
      if (receipt.status === "held") {
        return { status: "held", via: this.name, reason: receipt.reason };
      }
      if (receipt.status === "denied" || receipt.status === "expired") {
        // The user refused it or it aged out. It did NOT reach the session, but
        // re-sending would re-prompt a human who already said no. `gone` is the
        // honest branch: the caller logs and falls back exactly once.
        this.deps.log?.(`claude-peer: ${receipt.status} — ${receipt.reason}`);
        return { status: "gone" };
      }
      if (receipt.status === "delivered") {
        return { status: "accepted", via: this.name, confirmed: true };
      }
    }

    // No receipt: the silent-accept path. Use T1 to confirm T0. A flip out of
    // idle means our line started a turn. Anything else is unconfirmed — and we
    // say so instead of pretending.
    if (statusBefore === "idle") {
      await this.deps.sleep(window);
      const after = this.deps.statusFor(taskId);
      if (after === "busy" || after === "shell") {
        return { status: "accepted", via: this.name, confirmed: true };
      }
    }
    return { status: "accepted", via: this.name, confirmed: false };
  }

  /** Non-mutating. Registry presence only — never writes a byte. */
  async probe(taskId: string): Promise<ProbeResult> {
    if (!this.deps.socketPathFor(taskId)) return { status: "unsupported" };
    return this.deps.statusFor(taskId) === undefined
      ? { status: "gone" }
      : { status: "reachable", via: this.name };
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/peer-channel.test.ts`
Expected: PASS, all 12 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/claude/peer-channel.ts packages/agents/src/claude/__tests__/peer-channel.test.ts
git commit -m "feat(#667): ClaudePeerChannel with T1-confirms-T0 and receipt precedence"
```

---

### Task 5: Launch Claude sessions with `--messaging-socket-path` — both spawn sites

A channel is useless if the session never opens an inbox at a path we chose. Claude self-registers a socket anyway, but its path is derived from the pid — so the daemon would have to reverse-engineer it. `--messaging-socket-path` lets squadrant name the address at spawn.

**There are two independent Claude launch paths and both need this.** Crews go through the driver's `buildCommand`; captains and command sessions go through `buildAgentCmd`, which builds the claude command string itself and never calls `buildCommand`. Missing the second one is how captains stay unaddressable — and slice 4's `ping`/chat surface depends entirely on captains being addressable.

**Files:**
- Modify: `packages/agents/src/drivers/types.ts` (add to `SpawnOptions`)
- Modify: `packages/agents/src/drivers/claude.ts:30-49` (crew path — emit the flag)
- Modify: `packages/agents/src/drivers/launch-cmd.ts:24-40` (captain/command path — new optional param)
- Modify: `packages/cli/src/commands/launch.ts:113` (pass the path at the call site)
- Test: `packages/agents/src/drivers/__tests__/launch-cmd.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SpawnOptions.messagingSocketPath?: string`; the claude driver emits ` --messaging-socket-path <path>`.
  - `buildAgentCmd(agentName, registry, role, fresh, permissionMode, model?, templatesDir?, messagingSocketPath?)` — appended as the **last** optional parameter so no existing call site breaks.

- [ ] **Step 1: Write the failing test**

Append to `packages/agents/src/drivers/__tests__/launch-cmd.test.ts`:

```ts
describe("claude --messaging-socket-path (#667 slice 3)", () => {
  it("emits the flag when a socket path is supplied", () => {
    const { getDriver } = require("../registry.js");
    const cmd = getDriver("claude").buildCommand({
      prompt: "", workdir: "/tmp/w", role: "crew", interactive: true,
      messagingSocketPath: "/tmp/cc-socks/squadrant-t1.sock",
    });
    expect(cmd).toContain("--messaging-socket-path /tmp/cc-socks/squadrant-t1.sock");
  });

  it("omits the flag entirely when unset — no behaviour change by default", () => {
    const { getDriver } = require("../registry.js");
    const cmd = getDriver("claude").buildCommand({
      prompt: "", workdir: "/tmp/w", role: "crew", interactive: true,
    });
    expect(cmd).not.toContain("--messaging-socket-path");
  });
});
```

> Match the import style already used in `launch-cmd.test.ts` — if that file uses ESM `import` at the top, use the same and drop the inline `require`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/agents/src/drivers/__tests__/launch-cmd.test.ts -t "messaging-socket-path"`
Expected: FAIL — the flag is absent from the built command.

- [ ] **Step 3: Implement**

In `packages/agents/src/drivers/types.ts`, add to `SpawnOptions` (after `port?: number`):

```ts
  // #667 slice 3: claude's UDS session inbox path. Naming it at spawn is what
  // lets the daemon address the session without reverse-engineering the
  // pid-derived default. Absent ⇒ flag omitted ⇒ no behaviour change.
  messagingSocketPath?: string;
```

In `packages/agents/src/drivers/claude.ts`, inside `buildCommand`, after the `settingsPath` block:

```ts
      if (opts.messagingSocketPath) {
        cmd += ` --messaging-socket-path ${opts.messagingSocketPath}`;
      }
```

> **Undocumented-primitive note:** `--messaging-socket-path` is absent from `claude --help`. It survived 2.1.226 → 2.1.227 → 2.1.233, but treat it as a capability to probe, never a version to compare. If a future Claude rejects the flag, the crew must still boot — verify that in Step 5.

- [ ] **Step 3b: Add the captain/command path**

`buildAgentCmd` builds the claude command itself and never calls the driver's `buildCommand`, so Step 3 does not reach captains. Add a trailing optional parameter in `packages/agents/src/drivers/launch-cmd.ts`:

```ts
  templatesDir?: string,
  /** #667 slice 3: claude UDS inbox path. Captains must be addressable for the
   *  ping/chat surface (slice 4) to reach them over the control channel. Last
   *  parameter so every existing call site is unaffected. */
  messagingSocketPath?: string,
```

and inside the `driver.name === "claude"` branch, after the permission-mode flags:

```ts
    if (messagingSocketPath) {
      cmd += ` --messaging-socket-path ${messagingSocketPath}`;
    }
```

Then at `packages/cli/src/commands/launch.ts:113`, pass the captain's path:

```ts
            buildAgentCmd(agentName, registry, role, forceFresh, permissionMode, model, TEMPLATES_DIR,
              agentName === "claude" ? join(CC_SOCKS_DIR, `squadrant-captain-${project}.sock`) : undefined),
```

Add a test for both branches:

```ts
  it("captain path: buildAgentCmd emits the flag when a path is passed", () => {
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", undefined, undefined,
      "/tmp/cc-socks/squadrant-captain-demo.sock");
    expect(cmd).toContain("--messaging-socket-path /tmp/cc-socks/squadrant-captain-demo.sock");
  });

  it("captain path: omits the flag when the arg is absent (every existing call site)", () => {
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto");
    expect(cmd).not.toContain("--messaging-socket-path");
  });
```

- [ ] **Step 4: Run the driver tests**

Run: `pnpm vitest run packages/agents/src/drivers/__tests__/launch-cmd.test.ts`
Expected: PASS, including every pre-existing claude/codex/opencode case.

- [ ] **Step 5: Verify the flag does not break a real boot**

```bash
mkdir -p /tmp/cc-socks
claude --messaging-socket-path /tmp/cc-socks/probe-plan.sock --help >/dev/null 2>&1; echo "exit=$?"
```

Expected: `exit=0`. If it is non-zero, STOP — the flag has been withdrawn upstream and the plan needs a capability probe before Task 7. Record the actual output either way.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/drivers/types.ts packages/agents/src/drivers/claude.ts packages/agents/src/drivers/__tests__/launch-cmd.test.ts
git commit -m "feat(#667): claude driver accepts --messaging-socket-path"
```

---

### Task 6: Resolve the control channel **per agent**

Slice 2 wired a single `deps.controlChannel`. With two channels, delivery must pick by the crew's provider. `ControlChannel.agent` already exists for exactly this.

**Files:**
- Modify: `packages/core/src/crew-spawn.ts` (the `#667 slice 2: control channel` block, around lines 565-618)
- Test: `packages/core/src/__tests__/crew-send-control-channel.test.ts`

**Interfaces:**
- Consumes: `ControlChannel` (Task 4 provides a second implementation).
- Produces: `RunCrewSendDeps.controlChannels?: ControlChannel[]` replacing `controlChannel?: ControlChannel`. Selection is `channels.find(c => c.agent === task.provider)`. No match ⇒ mode is forced `off`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/__tests__/crew-send-control-channel.test.ts`:

```ts
describe("per-agent channel selection (#667 slice 3)", () => {
  it("routes an opencode crew to the opencode channel and never the claude one", async () => {
    const oc = { name: "opencode-http", agent: "opencode", send: vi.fn().mockResolvedValue({ status: "accepted", via: "opencode-http" }), probe: vi.fn() };
    const cc = { name: "claude-peer", agent: "claude", send: vi.fn(), probe: vi.fn() };
    await runSendWith({ provider: "opencode", mode: "on", controlChannels: [cc, oc] });
    expect(oc.send).toHaveBeenCalledTimes(1);
    expect(cc.send).not.toHaveBeenCalled();
  });

  it("routes a claude crew to the claude channel", async () => {
    const oc = { name: "opencode-http", agent: "opencode", send: vi.fn(), probe: vi.fn() };
    const cc = { name: "claude-peer", agent: "claude", send: vi.fn().mockResolvedValue({ status: "accepted", via: "claude-peer", confirmed: true }), probe: vi.fn() };
    await runSendWith({ provider: "claude", mode: "on", controlChannels: [cc, oc] });
    expect(cc.send).toHaveBeenCalledTimes(1);
    expect(oc.send).not.toHaveBeenCalled();
  });

  it("falls to the pane path when no channel serves the provider", async () => {
    const cc = { name: "claude-peer", agent: "claude", send: vi.fn(), probe: vi.fn() };
    const { paneSend } = await runSendWith({ provider: "codex", mode: "on", controlChannels: [cc] });
    expect(cc.send).not.toHaveBeenCalled();
    expect(paneSend).toHaveBeenCalledTimes(1);   // unchanged legacy behaviour
  });

  it("logs an unconfirmed claude accept without falling back", async () => {
    const cc = { name: "claude-peer", agent: "claude", send: vi.fn().mockResolvedValue({ status: "accepted", via: "claude-peer", confirmed: false }), probe: vi.fn() };
    const { paneSend, logs } = await runSendWith({ provider: "claude", mode: "on", controlChannels: [cc] });
    expect(paneSend).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("unconfirmed");
  });
});
```

> `runSendWith` is a helper you add to this file if it does not already exist: it calls `runCrewSend` with a stubbed runtime, a one-task `listTasks`, a `sendToPane` spy named `paneSend`, `controlChannelMode: () => mode`, and `onChannelLog` collecting into `logs`. Reuse the existing stubs in this file rather than inventing new ones.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/__tests__/crew-send-control-channel.test.ts -t "per-agent"`
Expected: FAIL — `controlChannels` is not a recognised dep.

- [ ] **Step 3: Implement**

In `packages/core/src/crew-spawn.ts`, replace the single-channel dep with a list. Change the deps type:

```ts
  /**
   * #667: one channel per agent with a native control API. Selected by the
   * crew's own provider — slice 2 shipped a single channel because opencode was
   * the only implementation; slice 3 adds claude, so selection is explicit.
   */
  controlChannels?: ControlChannel[];
```

Then, in the delivery block, replace the `mode` resolution and the two `deps.controlChannel` references:

```ts
  const agent = task?.provider;
  const channel = agent ? deps.controlChannels?.find((c) => c.agent === agent) : undefined;
  // No channel for this provider (codex, gemini, …) ⇒ off, regardless of config.
  // The flag cannot opt an agent in that has no implementation.
  const mode: ControlChannelMode =
    channel && agent && deps.controlChannelMode ? deps.controlChannelMode(agent) : "off";
```

and use `channel` in place of `deps.controlChannel` in both the `on` and `shadow` branches (`channel.send(...)`, `channel.probe(...)`).

- [ ] **Step 4: Run the core suite**

Run: `pnpm vitest run packages/core`
Expected: PASS. The slice 2 cases must still pass unchanged — if any needs editing beyond renaming `controlChannel` to `controlChannels: [ch]`, you have changed behaviour and must stop and reconsider.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/crew-spawn.ts packages/core/src/__tests__/crew-send-control-channel.test.ts
git commit -m "feat(#667): select the control channel by the crew's provider"
```

---

### Task 7: Wire it into the CLI and daemon, then smoke it live

**Files:**
- Modify: `packages/agents/src/index.ts` (export the new symbols)
- Modify: `packages/cli/src/commands/crew.ts:67-85` (construct both channels)
- Modify: `packages/core/src/crew-spawn.ts` (allocate + persist `messagingSocketPath` on the TaskRecord at claude crew spawn)
- Modify: `packages/shared/src/types/control.ts` (add `messagingSocketPath?: string` to `TaskRecord`)
- Modify: `docs/testing/crew-lifecycle-checklist.md`
- Test: `packages/cli/src/commands/__tests__/crew.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: a live `claude-peer` channel reachable from `squadrant crew send` when `defaults.controlChannel.claude` is `shadow` or `on`.

- [ ] **Step 1: Persist the socket path on the task record**

In `packages/shared/src/types/control.ts`, beside `serverPort`:

```ts
  /** #667 slice 3: claude UDS inbox path chosen at spawn. Mirrors serverPort's
   *  role for opencode — persisted so the daemon can re-address the session
   *  after a bounce (daemon/start.ts re-reads store.listAll()). */
  messagingSocketPath?: string;
```

At the claude crew spawn site in `packages/core/src/crew-spawn.ts` (beside where `serverPort` is reserved for opencode), derive and record:

```ts
  // Same directory as the crews' own sockets — receipts are only delivered
  // within one socket namespace, so our listener must live there too.
  const messagingSocketPath = provider === "claude"
    ? join(CC_SOCKS_DIR, `squadrant-${taskId}.sock`)
    : undefined;
```

Pass it into `buildCommand` as `messagingSocketPath` and store it on the record.

**This slice owns the socket-directory constant.** Define and **export** it once from `packages/core/src/crew-spawn.ts` — slice 4 imports it rather than redeclaring, because two definitions would drift and a drifted directory silently stops receipts (they are only delivered within one namespace):

```ts
/**
 * Where claude sessions' UDS inboxes live. Squadrant's own receipt listener MUST
 * bind inside this same directory — the receiver refuses to send a receipt to a
 * `from` address outside its own socket namespace (verified 2026-08-08).
 *
 * That makes this directory a trust boundary. Hardening its permissions is #675,
 * which is live today and NOT addressed by this slice.
 */
export const CC_SOCKS_DIR = "/tmp/cc-socks";
```

Ensure the directory exists (`mkdirSync(CC_SOCKS_DIR, { recursive: true })`) before launching a session that will bind inside it, and use the same constant at the captain launch site in Task 5 Step 3b.

- [ ] **Step 2: Export from `@squadrant/agents`**

In `packages/agents/src/index.ts`, beside slice 1's claude exports:

```ts
export { ClaudePeerChannel } from "./claude/peer-channel.js";
export type { ClaudePeerChannelDeps, ClaudeStatus } from "./claude/peer-channel.js";
export { ClaudeReceiptListener } from "./claude/receipt-listener.js";
export type { PeerReceipt } from "./claude/receipt-listener.js";
export { buildUserEnvelope, writeLine } from "./claude/peer-wire.js";
export type { PeerUserEnvelope, WireResult } from "./claude/peer-wire.js";
```

- [ ] **Step 3: Construct both channels in the CLI**

In `packages/cli/src/commands/crew.ts`, replace the single-channel construction:

```ts
  const receipts = new ClaudeReceiptListener({
    socketPath: "/tmp/cc-socks/squadrantd.sock",
    createServer: (h) => createServer(h),
    log: (m) => console.error(chalk.dim(m)),
  });
  await receipts.start();

  const controlChannels = [
    new OpencodeHttpChannel({
      portFor: (taskId) => tasks.find((t) => t.id === taskId)?.serverPort,
      log: (m) => console.error(chalk.dim(m)),
    }),
    new ClaudePeerChannel({
      socketPathFor: (taskId) => tasks.find((t) => t.id === taskId)?.messagingSocketPath,
      sessionIdFor: (taskId) => tasks.find((t) => t.id === taskId)?.sessionId,
      statusFor: (taskId) => readClaudeStatus(tasks.find((t) => t.id === taskId)),
      wire: (p, e) => writeLine(p, e, { connect: (path) => netConnect(path) }),
      receipts,
      newMsgId: () => randomUUID(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (m) => console.error(chalk.dim(m)),
    }),
  ];
```

Pass `controlChannels` instead of `controlChannel`. Stop the listener in the same place the command tears down other resources. `readClaudeStatus` reads the record's pid via slice 1's `parseRegistryDir` — if slice 1 does not already expose a single-task status helper, add a thin one in `packages/agents/src/claude/registry.ts` and export it rather than duplicating the parse here.

- [ ] **Step 4: Build and run the whole suite**

```bash
pnpm build && pnpm test
```

Expected: build clean, suite green. **A green local suite is NOT evidence** — on 2026-08-13 a suite passed locally only because that machine had a live daemon, and CI failed. Push and confirm CI green before calling this step done.

- [ ] **Step 5: Verify the runtime gate**

```bash
node dist/index.js --help && node -e "import('./dist/squadrantd.js').then(()=>console.log('ok'))"
```

Expected: both succeed. This is the only check that catches a missing `.js` extension.

- [ ] **Step 6: Live smoke on a throwaway TEST project**

```bash
export SQUADRANT_CONFIG=/tmp/sq-slice3-smoke
mkdir -p /tmp/sq-slice3-smoke /tmp/slice3-lab && cd /tmp/slice3-lab && git init -q
# register the throwaway, spawn a claude crew, then:
#   1. defaults.controlChannel.claude = "shadow"  -> expect agree/DISAGREEMENT logs, pane still delivers
#   2. defaults.controlChannel.claude = "on"      -> expect "accepted via claude-peer"
```

Record, in the artifact for Step 7:
- the `shadow` log lines (agreement and any disagreement)
- an `on` send that returns `accepted via claude-peer` **and** the receiving transcript showing the user turn — `200 true` is not evidence, `[assistant] …` responding to the message is
- one `confirmed: false` case if you can produce one (send while the crew is already busy) — verify no duplicate arrives
- a `gone` case: kill the crew process, send, confirm exactly one pane fallback and no retry storm

Then `squadrant projects remove` the throwaway and kill every process by **exact PID** — never `pkill claude`, which would kill the operator's own sessions.

- [ ] **Step 7: Update the lifecycle checklist and commit**

Add to `docs/testing/crew-lifecycle-checklist.md`:

```markdown
- [ ] #667 claude delivery: with `defaults.controlChannel.claude = "on"`, `crew send` to a claude crew logs `accepted via claude-peer` and the crew's transcript shows the user turn
- [ ] #667 claude delivery: a send to a killed claude crew logs `gone`, falls back to the pane exactly once, and does not retry
- [ ] #667 claude delivery: an unconfirmed accept logs `(unconfirmed — no turn observed)` and does NOT double-send
```

```bash
git add -A
git commit -m "feat(#667): wire the claude peer channel into crew send + live smoke"
```

---

## Success Criteria

1. `pnpm build` clean; `pnpm test` green; **CI green on the PR** (local green is not evidence).
2. `node dist/index.js --help` and importing `dist/squadrantd.js` both succeed.
3. With `defaults.controlChannel` absent, behaviour is byte-identical to `develop` today — same notifications, same pane path, same timing.
4. With `claude: "on"`, a `crew send` to a live claude crew returns `accepted via claude-peer` and the receiving transcript shows the user turn.
5. A `held` message returns the `held` branch with the real reason and is never retried or fallen back.
6. A dead claude crew returns `gone`, falls back to the pane exactly once, and never retries.
7. An unconfirmed accept is recorded as `confirmed: false` and does not double-send.
8. No new emitter of `task.done` / `task.blocked` / `task.cancelled`.
9. `squadrant heal status` still reports all components healthy.

## Non-goals

- Retiring `confirmedSendToPane` — it remains the fallback for `gone` / `unsupported`.
- Hardening the inbound gate (`crossSessionInbound`, `/tmp/cc-socks` permissions). **That is #675**, which predates this work and must not be gated behind it.
- Automating the resolution of a held prompt. If a later slice needs it, the confirm key is the Kitty CSI-u encoding `\x1b[13u` — a bare `\r` silently does nothing (verified 2026-08-17).
- The chat/`ping` surface and Telegram receipts — that is slice 4.
- Any change to opencode delivery, the SSE bridge, or slice 1's liveness sources.
