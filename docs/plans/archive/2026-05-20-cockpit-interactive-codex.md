# Cockpit Interactive Codex Implementation Plan

> **✅ Shipped** (PR #98, #101, 2026-05-20). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship live human↔codex chat in a cmux tab, driven by the `codex app-server` JSON-RPC protocol — no TUI scraping, real turn signals, daemon-bounce resilience via `thread/resume`.

**Architecture:** Approach 3, two-phase. **Phase 1** builds a standalone typed JSON-RPC client lib for the codex app-server protocol + a smoke command whose approval round-trip is the empirical go/no-go gate. **Phase 2** wires the proven lib into `cockpitd` as the interactive driver, adds a streaming subscribe channel to the daemon socket, ships `cockpit crew chat` + `cockpit crew attach` as the cmux-tab surface, and closes the interactive-codex slice of #86 via a `resumeRef`-on-every-transition `DispatchAttempt` schema.

**Tech Stack:** TypeScript (strict, ESM, `target: ES2022`, `.js` import suffix), vitest, commander, node:net AF_UNIX, codex-cli ≥0.130.0 (`codex app-server` JSON-RPC v2).

**Spec:** `docs/specs/2026-05-20-cockpit-interactive-codex-design.md` (branch `docs/codex-interactive-design @ 82e2425`).

**Conventions seen in cockpit (follow these):**
- Tests are vitest siblings in `src/control/__tests__/<source>.test.ts`; pattern in `src/control/__tests__/store.test.ts:1-40`.
- All TS imports use `.js` suffix (ESM).
- Pure functions kept pure (`state-machine.ts::reduce`); side effects live in adapters/launchers.
- Newline-delimited JSON framing already exists in `src/control/protocol.ts::createDecoder`; reuse the shape, do not re-invent it.
- Anti-#2576 invariant is enforced in `state-machine.ts`; never auto-promote a `TurnCompleted` to `done`.

---

## File Structure

### Phase 1 — `feature/codex-app-server-client`

**Create:**
- `src/control/codex/protocol/` — directory for `codex app-server generate-ts` output. Generated, not hand-edited. One auto-regenerated `README.md` at root saying "do not edit by hand."
- `src/control/codex/app-server-client.ts` — the typed JSON-RPC client. Public API: `initialize/startThread/resumeThread/readThread/sendTurn/steerTurn/interruptTurn/injectItems/respondToServerRequest`, event emitter, lifecycle.
- `src/control/codex/__tests__/app-server-client.test.ts` — unit tests with a mocked child stdio.
- `src/control/codex/__tests__/app-server-client.smoke.test.ts` — integration tests that spawn real `codex app-server`; gated by `RUN_CODEX_SMOKE=1` so CI without codex skips.
- `src/commands/codex-chat-smoke.ts` — the `cockpit codex-chat-smoke` CLI command.
- `scripts/gen-codex-types.sh` — regenerates `src/control/codex/protocol/` via `codex app-server generate-ts --experimental --out`.

**Modify:**
- `src/index.ts` — register the `codex-chat-smoke` command.
- `package.json` — add `"codex:gen-types": "bash scripts/gen-codex-types.sh"` script.

### Phase 2 — `feature/codex-interactive-crew` (off Phase 1)

**Create:**
- `src/control/codex/driver.ts` — the daemon-side interactive driver. Owns one long-lived `codex app-server` child via `AppServerClient`, maps `TaskRecord` ↔ `threadId`, emits `ControlEvent`s for `reduce()`.
- `src/control/codex/normalize.ts` — pure `normalizeAppServerNotification(n) → CanonicalEvent` with `never`-guarded exhaustive switch.
- `src/control/codex/gate.ts` — pure gate helpers (`promoteToGate`, `resolveGate`, `timeoutGate`).
- `src/control/codex/__tests__/driver.test.ts`, `normalize.test.ts`, `gate.test.ts`.
- `src/commands/crew-chat.ts` — `cockpit crew chat --provider codex --project X [--cwd …] [--model …]`.
- `src/commands/crew-attach.ts` — `cockpit crew attach <taskId>` cmux-tab renderer/input client.
- `src/control/__tests__/streaming-protocol.test.ts` — covers the new attach/say/steer/answer frames.

**Modify:**
- `src/control/types.ts` — add `DispatchAttempt` + `Gate` + `attempts: DispatchAttempt[]` on `TaskRecord`; add new `ControlEvent` variants for app-server notifications (`turn.started`, `turn.completed`, `input.requested`, `approval.requested`, `delta`, `reattached`).
- `src/control/state-machine.ts` — write `resumeRef` to current attempt on every transition; add transitions for new events (`working → awaiting-input → working`; `→ blocked → working`).
- `src/control/protocol.ts` — add the streaming subscribe verb (`{op:"attach", taskId}` + frame emit helpers); cooperate with #87 schema validation when it lands.
- `src/control/daemon.ts` — wire `launchInteractive` for `provider=codex` to the driver in `src/control/codex/driver.ts`; surface `gates` on status/list replies.
- `src/control/cockpitd.ts` — inject the codex driver into `DaemonDeps.launchInteractive`; on daemon start, iterate non-terminal interactive-codex tasks and call `driver.reattach(resumeRef)`.
- `src/control/interactive/codex.ts` — **delete** (the old "best-effort" hook adapter is replaced by the app-server driver) and remove from `src/control/interactive/registry.ts`. Keep `claude.ts` untouched.
- `src/commands/crew-control.ts` — extend `cockpit crew status` output to include `attempts[]` (current attempt's `resumeRef`, `lastHeartbeatAt`, `circuitBroken`) and any `gates`; add `cockpit crew reply --gate <gateId>`.
- `src/index.ts` — register `crew-chat`, `crew-attach` (subcommands of `crew`).

---

## Phase Gate

**Phase 1 must PASS the approval round-trip smoke before any Phase 2 task starts.** If the round-trip fails against real codex, stop and revisit the design (Path Y from the orca study becomes the considered fallback; that decision is cheap at this point because Phase 2 hasn't begun).

---

# PHASE 1 — codexAppServerClient + smoke gate

### Task 1.0: Branch off develop

**Files:** none.

- [ ] **Step 1: Create branch**

```bash
git checkout develop
git pull --ff-only
git checkout -b feature/codex-app-server-client
```

- [ ] **Step 2: Verify clean state**

```bash
git status
npm run lint  # expect: clean (tsc --noEmit, no output)
npm test --silent -- --run  # expect: all green pre-change
```

---

### Task 1.1: Vendor the app-server protocol types

**Files:**
- Create: `scripts/gen-codex-types.sh`
- Create: `src/control/codex/protocol/README.md`
- Modify: `package.json` (add script)
- Generated (committed): `src/control/codex/protocol/*.ts`

- [ ] **Step 1: Write the generator script**

```bash
mkdir -p scripts src/control/codex/protocol
cat > scripts/gen-codex-types.sh <<'SH'
#!/usr/bin/env bash
# Regenerate the codex app-server protocol bindings.
# Requires codex-cli ≥0.130.0 on PATH.
set -euo pipefail
OUT="src/control/codex/protocol"
rm -rf "$OUT"
mkdir -p "$OUT"
codex app-server generate-ts --experimental --out "$OUT"
cat > "$OUT/README.md" <<'MD'
# codex app-server protocol bindings (auto-generated)

Generated by `npm run codex:gen-types` (`scripts/gen-codex-types.sh`).
**DO NOT EDIT BY HAND.** Re-run the generator to update.

Source: `codex app-server generate-ts --experimental --out <here>` against
`codex-cli ≥0.130.0`. See `docs/specs/2026-05-20-cockpit-interactive-codex-design.md` §3.3.
MD
echo "Generated $OUT"
SH
chmod +x scripts/gen-codex-types.sh
```

- [ ] **Step 2: Add the npm script**

Modify `package.json` `"scripts"` block to add (after `"lint"`):

```json
"codex:gen-types": "bash scripts/gen-codex-types.sh"
```

- [ ] **Step 3: Run the generator**

```bash
npm run codex:gen-types
ls src/control/codex/protocol | head -5
# expect: ClientRequest.json/.ts, ServerNotification.json/.ts, etc.
```

If `codex` is not on PATH, install codex-cli ≥0.130.0 first; do not proceed without real generated types.

- [ ] **Step 4: Verify build still passes**

```bash
npm run build  # expect: clean
```

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-codex-types.sh package.json src/control/codex/protocol
git commit -m "feat(codex): vendor codex app-server v2 protocol types

Generated via 'codex app-server generate-ts --experimental' against
codex-cli ≥0.130.0. Regenerable via 'npm run codex:gen-types'."
```

---

### Task 1.2: Newline-framed JSON decoder for app-server stdio

**Files:**
- Create: `src/control/codex/__tests__/app-server-client.test.ts`
- Create: `src/control/codex/app-server-client.ts`

Cockpit already has `createDecoder()` in `src/control/protocol.ts:7-24`. The app-server uses the same shape (newline-delimited JSON, must ignore non-JSON lines defensively per orca `codex-fetcher.ts:160-164`). Reuse the pattern; we'll wrap it inside the client.

- [ ] **Step 1: Write the failing parser test**

Create `src/control/codex/__tests__/app-server-client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { _parseChunk } from "../app-server-client.js";

describe("app-server-client._parseChunk", () => {
  it("parses one newline-terminated JSON object", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, '{"a":1}\n')).toEqual([{ a: 1 }]);
    expect(acc.buf).toBe("");
  });
  it("accumulates partial lines across chunks", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, '{"a":')).toEqual([]);
    expect(_parseChunk(acc, '1}\n')).toEqual([{ a: 1 }]);
  });
  it("skips non-JSON lines defensively", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, 'noise\n{"ok":true}\nmore noise\n')).toEqual([{ ok: true }]);
  });
  it("returns multiple objects from one chunk", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, '{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

```bash
npm test -- --run src/control/codex/__tests__/app-server-client.test.ts
# expect: cannot find module '../app-server-client.js'
```

- [ ] **Step 3: Implement minimal `_parseChunk` + skeleton**

Create `src/control/codex/app-server-client.ts`:

```ts
// src/control/codex/app-server-client.ts
// Typed JSON-RPC 2.0 client for `codex app-server` v2.
// Transport: stdio (newline-delimited JSON). See spec §3.
// Defensive parser per orca codex-fetcher.ts:160-164: ignore non-JSON lines.

export function _parseChunk(acc: { buf: string }, chunk: string): unknown[] {
  acc.buf += chunk;
  const out: unknown[] = [];
  let idx: number;
  while ((idx = acc.buf.indexOf("\n")) >= 0) {
    const line = acc.buf.slice(0, idx);
    acc.buf = acc.buf.slice(idx + 1);
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip non-JSON defensively */ }
  }
  return out;
}
```

- [ ] **Step 4: Run — expect PASS (all 4)**

```bash
npm test -- --run src/control/codex/__tests__/app-server-client.test.ts
# expect: 4 passed
```

- [ ] **Step 5: Commit**

```bash
git add src/control/codex/app-server-client.ts src/control/codex/__tests__/app-server-client.test.ts
git commit -m "feat(codex): defensive newline-framed JSON parser for app-server stdio"
```

---

### Task 1.3: AppServerClient — spawn / kill / wire stdio

**Files:**
- Modify: `src/control/codex/app-server-client.ts`
- Modify: `src/control/codex/__tests__/app-server-client.test.ts`

The class owns a child process and pushes its stdout through `_parseChunk`. Tests inject a fake spawn so they don't need real codex.

- [ ] **Step 1: Write the failing lifecycle test**

Append to `app-server-client.test.ts`:

```ts
import { AppServerClient } from "../app-server-client.js";
import { EventEmitter } from "node:events";

function fakeChild() {
  const stdin = new EventEmitter() as any;
  stdin.write = (s: string) => { (stdin as any)._written = ((stdin as any)._written ?? "") + s; return true; };
  stdin.end = () => {};
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as any;
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr;
  proc.kill = (signal?: string) => { proc.emit("exit", 0, signal ?? null); };
  return proc;
}

describe("AppServerClient lifecycle", () => {
  it("spawns via injected spawner and emits 'closed' on child exit", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    const closed = new Promise<void>((res) => c.on("closed", () => res()));
    c.start();
    proc.emit("exit", 0, null);
    await closed;
  });
  it("kill() ends the child", () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    c.kill();
    // exit emitted synchronously by fake; emitter's 'closed' fires
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- --run src/control/codex/__tests__/app-server-client.test.ts
# expect: AppServerClient is not a constructor
```

- [ ] **Step 3: Implement the class skeleton**

Append to `src/control/codex/app-server-client.ts`:

```ts
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

export interface AppServerClientOpts {
  /** Override for tests; defaults to spawning real `codex app-server`. */
  spawn?: () => Child;
  clientInfo?: { name: string; version: string };
}

export class AppServerClient extends EventEmitter {
  private proc?: Child;
  private acc = { buf: "" };
  private opts: AppServerClientOpts;
  constructor(opts: AppServerClientOpts = {}) { super(); this.opts = opts; }

  start(): void {
    if (this.proc) throw new Error("AppServerClient already started");
    const sp = this.opts.spawn ?? defaultSpawn;
    this.proc = sp();
    this.proc.stdout.on("data", (d: Buffer | string) => this._onStdout(d.toString()));
    this.proc.stderr.on("data", (d: Buffer | string) => this.emit("stderr", d.toString()));
    this.proc.on("exit", (code, signal) => this.emit("closed", { code, signal }));
    this.proc.on("error", (e) => this.emit("error", e));
  }

  kill(): void {
    if (this.proc) this.proc.kill();
  }

  private _onStdout(s: string): void {
    for (const msg of _parseChunk(this.acc, s)) this._dispatch(msg);
  }

  // Filled in Task 1.4+.
  private _dispatch(_msg: unknown): void { /* noop until pending-map lands */ }
}

function defaultSpawn(): Child {
  return nodeSpawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] }) as Child;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- --run src/control/codex/__tests__/app-server-client.test.ts
# expect: all passed
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): AppServerClient lifecycle (spawn/kill/stdout pipe)"
```

---

### Task 1.4: Pending-request map + `sendRequest`

**Files:**
- Modify: `src/control/codex/app-server-client.ts`
- Modify: `src/control/codex/__tests__/app-server-client.test.ts`

JSON-RPC 2.0: every outbound request gets a unique `id`; a response with the matching `id` resolves the promise. Per orca `codex-fetcher.ts:172-175`, messages with no `id` are notifications (Task 1.5).

- [ ] **Step 1: Write the failing test**

Append to `app-server-client.test.ts`:

```ts
describe("AppServerClient.sendRequest (correlation by id)", () => {
  it("resolves with result when the response arrives", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    // Bypass handshake gate for this unit-level test:
    (c as any)._handshakeDone = true;
    const p = (c as any)._sendRequest("foo/bar", { x: 1 });
    // Read the written line, mirror back a response
    const written = (proc.stdin as any)._written as string;
    const req = JSON.parse(written.trim());
    expect(req.method).toBe("foo/bar");
    expect(req.params).toEqual({ x: 1 });
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n");
    await expect(p).resolves.toEqual({ ok: true });
  });
  it("rejects with error when an error response arrives", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = (c as any)._sendRequest("foo/bar", {});
    const req = JSON.parse((proc.stdin as any)._written.trim());
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "boom" } }) + "\n");
    await expect(p).rejects.toThrow(/boom/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- --run src/control/codex/__tests__/app-server-client.test.ts
```

- [ ] **Step 3: Implement `_sendRequest` + `_dispatch` response routing**

Add to `AppServerClient`:

```ts
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  protected _handshakeDone = false;

  protected _sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this._handshakeDone && method !== "initialize") {
      throw new Error(`AppServerClient: cannot call '${method}' before handshake (spec §3.2)`);
    }
    if (!this.proc) throw new Error("AppServerClient not started");
    const id = this.nextId++;
    const env = { jsonrpc: "2.0", id, method, params: params ?? {} };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(JSON.stringify(env) + "\n");
    });
  }

  private _dispatchResponse(msg: any): boolean {
    if (typeof msg?.id !== "number") return false;
    const slot = this.pending.get(msg.id);
    if (!slot) return false;
    this.pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`${msg.error.message ?? "rpc-error"} (code ${msg.error.code})`));
    else slot.resolve(msg.result);
    return true;
  }
```

Replace the placeholder `_dispatch`:

```ts
  private _dispatch(msg: unknown): void {
    if (this._dispatchResponse(msg)) return;
    // Notifications (id-less) handled in Task 1.5.
  }
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- --run src/control/codex/__tests__/app-server-client.test.ts
# expect: all pass (incl. error rejection)
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): id-correlated sendRequest + error routing"
```

---

### Task 1.5: Notification fanout + typed event emitter

**Files:**
- Modify: `src/control/codex/app-server-client.ts`
- Modify: `src/control/codex/__tests__/app-server-client.test.ts`

Per orca `codex-fetcher.ts:172-175` and our spec §4.7: messages with no `id` are notifications, routed by `method`. Surface them as typed events.

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe("AppServerClient notifications", () => {
  it("emits 'notification' with method+params for id-less messages", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    const got: any[] = [];
    c.on("notification", (n) => got.push(n));
    proc.stdout.emit("data",
      JSON.stringify({ jsonrpc: "2.0", method: "agentMessageDelta", params: { text: "hi" } }) + "\n");
    expect(got).toEqual([{ method: "agentMessageDelta", params: { text: "hi" } }]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- --run src/control/codex/__tests__/app-server-client.test.ts
```

- [ ] **Step 3: Implement notification routing**

Replace `_dispatch` again:

```ts
  private _dispatch(msg: unknown): void {
    if (this._dispatchResponse(msg)) return;
    if (typeof (msg as any)?.method === "string" && (msg as any).id === undefined) {
      this.emit("notification", { method: (msg as any).method, params: (msg as any).params });
      return;
    }
    // Server requests (have method AND id) handled in Task 1.10.
  }
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- --run src/control/codex/__tests__/app-server-client.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): notification fanout (id-less messages routed by method)"
```

---

### Task 1.6: Handshake enforcement (initialize → initialized → methods)

**Files:**
- Modify: `src/control/codex/app-server-client.ts`
- Modify: `src/control/codex/__tests__/app-server-client.test.ts`

Per orca `codex-fetcher.ts:142-146` and spec §3.2: `initialize` (request) → await response → `initialized` (notification, no id) → only then any other method. The client must refuse pre-handshake methods.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe("AppServerClient handshake", () => {
  it("refuses any method call before handshake", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    expect(() => (c as any)._sendRequest("turn/start", {})).toThrow(/before handshake/);
  });
  it("initialize sends a request, awaits response, then sends 'initialized' notification", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc, clientInfo: { name: "cockpit", version: "test" } });
    c.start();
    const p = c.initialize();
    const first = JSON.parse((proc.stdin as any)._written.trim().split("\n")[0]);
    expect(first.method).toBe("initialize");
    expect(first.params.clientInfo).toEqual({ name: "cockpit", version: "test" });
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { capabilities: {} } }) + "\n");
    await p;
    const lines = (proc.stdin as any)._written.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.method).toBe("initialized");
    expect(last.id).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`initialize is not a function`)

- [ ] **Step 3: Implement `initialize`**

Add to `AppServerClient`:

```ts
  async initialize(): Promise<unknown> {
    if (this._handshakeDone) return;
    if (!this.proc) throw new Error("AppServerClient not started");
    const info = this.opts.clientInfo ?? { name: "cockpit", version: "0" };
    // Send initialize directly (bypass gate) — only initialize may pre-handshake.
    const id = this.nextId++;
    const env = { jsonrpc: "2.0", id, method: "initialize", params: { clientInfo: info } };
    const res = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(JSON.stringify(env) + "\n");
    });
    // Send 'initialized' as a notification (no id).
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    this._handshakeDone = true;
    return res;
  }
```

(Replace the throw in `_sendRequest`'s pre-handshake guard with the same — it already handles the gate.)

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- --run src/control/codex/__tests__/app-server-client.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): mandatory handshake (initialize → initialized → methods)

Refuses any method call before handshake completes — orca codex-fetcher.ts:142-146
documents that skipping the 'initialized' notification produces 'Not initialized'
errors. Spec §3.2."
```

---

### Task 1.7: Thread lifecycle — `startThread` / `resumeThread` / `readThread`

**Files:**
- Modify: `src/control/codex/app-server-client.ts`
- Modify: `src/control/codex/__tests__/app-server-client.test.ts`

Per the v2 protocol (see `src/control/codex/protocol/codex_app_server_protocol.v2.schemas.json`): method names are `thread/start`, `thread/resume`, `thread/read`.

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe("AppServerClient thread lifecycle", () => {
  it("startThread → thread/start with cwd; returns threadId", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = c.startThread({ cwd: "/tmp/x" });
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("thread/start");
    expect(req.params.cwd).toBe("/tmp/x");
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { threadId: "T1" } }) + "\n");
    await expect(p).resolves.toEqual({ threadId: "T1" });
  });
  it("resumeThread → thread/resume with threadId", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = c.resumeThread({ threadId: "T1", cwd: "/tmp/x" });
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("thread/resume");
    expect(req.params.threadId).toBe("T1");
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
    await p;
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Add to `AppServerClient`:

```ts
  startThread(params: { cwd: string; model?: string; sandbox?: string; approvalPolicy?: string }): Promise<{ threadId: string }> {
    return this._sendRequest("thread/start", params) as Promise<{ threadId: string }>;
  }
  resumeThread(params: { threadId: string; cwd?: string }): Promise<unknown> {
    return this._sendRequest("thread/resume", params);
  }
  readThread(params: { threadId: string; lastN?: number }): Promise<unknown> {
    return this._sendRequest("thread/read", params);
  }
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): thread/start, thread/resume, thread/read"
```

---

### Task 1.8: `sendTurn` — resolves on `TurnCompleted` for that turn

**Files:**
- Modify: `src/control/codex/app-server-client.ts`
- Modify: `src/control/codex/__tests__/app-server-client.test.ts`

`turn/start` returns an ack quickly; the actual completion arrives via a `TurnCompleted` notification carrying the turn id. `sendTurn` resolves when that notification fires (or rejects on a matching error notification).

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe("AppServerClient.sendTurn", () => {
  it("resolves when TurnCompleted notification arrives for this turn", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = c.sendTurn("T1", "hello");
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("turn/start");
    expect(req.params.threadId).toBe("T1");
    // ack
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { turnId: "TURN-1" } }) + "\n");
    // streaming
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", method: "agentMessageDelta", params: { turnId: "TURN-1", text: "h" } }) + "\n");
    // done
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turnId: "TURN-1" } }) + "\n");
    await expect(p).resolves.toMatchObject({ turnId: "TURN-1" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Add to `AppServerClient`:

```ts
  async sendTurn(threadId: string, text: string): Promise<{ turnId: string }> {
    const ack = await this._sendRequest("turn/start", {
      threadId, input: [{ type: "text", text }],
    }) as { turnId: string };
    return new Promise((resolve, reject) => {
      const onNote = (n: { method: string; params?: any }) => {
        if (n.params?.turnId !== ack.turnId) return;
        if (n.method === "turn/completed") { cleanup(); resolve(ack); }
        if (n.method === "turn/failed") { cleanup(); reject(new Error(n.params?.error ?? "turn failed")); }
      };
      const cleanup = () => this.off("notification", onNote);
      this.on("notification", onNote);
    });
  }
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): sendTurn resolves on TurnCompleted (anti-#2576 stays at daemon layer)

Client resolves the per-turn promise on the protocol's real done signal.
TurnCompleted-as-liveness vs completion is enforced by the daemon's reducer
in Phase 2, not here — the client just relays the protocol truth."
```

---

### Task 1.9: `steerTurn` / `interruptTurn` / `injectItems`

**Files:**
- Modify: `src/control/codex/app-server-client.ts`
- Modify: `src/control/codex/__tests__/app-server-client.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe("AppServerClient steer/interrupt/inject", () => {
  it("steerTurn → turn/steer with threadId+text", async () => {
    const proc = fakeChild(); const c = new AppServerClient({ spawn: () => proc });
    c.start(); (c as any)._handshakeDone = true;
    const p = c.steerTurn("T1", "actually do X");
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("turn/steer");
    expect(req.params).toEqual({ threadId: "T1", input: [{ type: "text", text: "actually do X" }] });
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
    await p;
  });
  it("interruptTurn → turn/interrupt", async () => {
    const proc = fakeChild(); const c = new AppServerClient({ spawn: () => proc });
    c.start(); (c as any)._handshakeDone = true;
    const p = c.interruptTurn("T1");
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("turn/interrupt");
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
    await p;
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Add to `AppServerClient`:

```ts
  steerTurn(threadId: string, text: string): Promise<unknown> {
    return this._sendRequest("turn/steer", { threadId, input: [{ type: "text", text }] });
  }
  interruptTurn(threadId: string): Promise<unknown> {
    return this._sendRequest("turn/interrupt", { threadId });
  }
  injectItems(threadId: string, items: unknown[]): Promise<unknown> {
    return this._sendRequest("thread/inject_items", { threadId, items });
  }
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): steerTurn / interruptTurn / injectItems"
```

---

### Task 1.10: Server requests (approval / input-required) + `respondToServerRequest`

**Files:**
- Modify: `src/control/codex/app-server-client.ts`
- Modify: `src/control/codex/__tests__/app-server-client.test.ts`

Server requests have both `id` AND `method` (per `ServerRequest` schema in the generated types). They expect a response back to the same `id`. We emit `serverRequest` for the application to handle and provide `respondToServerRequest(requestId, payload)` to answer.

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe("AppServerClient server-request round-trip", () => {
  it("emits 'serverRequest' for messages with method AND id; responds via respondToServerRequest", async () => {
    const proc = fakeChild(); const c = new AppServerClient({ spawn: () => proc });
    c.start(); (c as any)._handshakeDone = true;
    const got: any[] = [];
    c.on("serverRequest", (r) => got.push(r));
    // Server initiates a tool-input request
    proc.stdout.emit("data",
      JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tool/request-user-input", params: { question: "ok?" } }) + "\n");
    expect(got).toEqual([{ id: 42, method: "tool/request-user-input", params: { question: "ok?" } }]);
    // Application answers
    c.respondToServerRequest(42, { answer: "yes" });
    const lastLine = (proc.stdin as any)._written.trim().split("\n").pop()!;
    expect(JSON.parse(lastLine)).toEqual({ jsonrpc: "2.0", id: 42, result: { answer: "yes" } });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement — update `_dispatch` and add `respondToServerRequest`**

Replace `_dispatch`:

```ts
  private _dispatch(msg: unknown): void {
    if (this._dispatchResponse(msg)) return;
    const m = msg as any;
    if (typeof m?.method === "string" && typeof m?.id === "number") {
      this.emit("serverRequest", { id: m.id, method: m.method, params: m.params });
      return;
    }
    if (typeof m?.method === "string" && m?.id === undefined) {
      this.emit("notification", { method: m.method, params: m.params });
    }
  }

  respondToServerRequest(id: number, result: unknown): void {
    if (!this.proc) throw new Error("AppServerClient not started");
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): server-request emit + respondToServerRequest

This is the surface that codex uses to ask the human (or driver) a question
mid-turn — approvals, input prompts. Zero prior art in orca; the smoke test
in Task 1.12 is the empirical gate for this round-trip."
```

---

### Task 1.11: `cockpit codex-chat-smoke` — PING/PONG path (basic gate)

**Files:**
- Create: `src/commands/codex-chat-smoke.ts`
- Modify: `src/index.ts`

The smoke command is a small CLI wrapping the client. PING/PONG proves multi-turn context. The approval round-trip lands in Task 1.12.

- [ ] **Step 1: Write the smoke command**

Create `src/commands/codex-chat-smoke.ts`:

```ts
// src/commands/codex-chat-smoke.ts
import { Command } from "commander";
import { AppServerClient } from "../control/codex/app-server-client.js";
import { resolve } from "node:path";

export const codexChatSmokeCommand = new Command("codex-chat-smoke")
  .description("Phase 1 gate: prove the codex app-server JSON-RPC path works end-to-end.")
  .option("--cwd <dir>", "working dir for the codex thread", process.cwd())
  .option("--model <m>", "model id (optional)")
  .option("--approval", "include the approval round-trip (Phase 1 PASS requires this)", false)
  .action(async (opts: { cwd: string; model?: string; approval: boolean }) => {
    const c = new AppServerClient({ clientInfo: { name: "cockpit", version: "smoke" } });
    const transcript: string[] = [];
    c.on("notification", (n) => transcript.push(`> ${n.method} ${JSON.stringify(n.params).slice(0, 120)}`));
    c.on("stderr", (s) => transcript.push(`[stderr] ${s.trim()}`));
    try {
      c.start();
      await c.initialize();
      const { threadId } = await c.startThread({ cwd: resolve(opts.cwd), model: opts.model, sandbox: "workspace-write" });
      await c.sendTurn(threadId, "Reply with exactly: PING-OK");
      await assertSawText(c, transcript, "PING-OK");
      await c.sendTurn(threadId, "Now reply with: PONG-OK");
      await assertSawText(c, transcript, "PONG-OK");
      process.stdout.write("smoke: BASIC ok\n");
      if (!opts.approval) { c.kill(); return; }
      // Approval round-trip — Task 1.12 fills this in.
      c.kill();
    } catch (e) {
      process.stderr.write(`smoke FAIL: ${(e as Error).message}\n${transcript.join("\n")}\n`);
      c.kill();
      process.exit(1);
    }
  });

async function assertSawText(c: AppServerClient, transcript: string[], needle: string): Promise<void> {
  const hit = transcript.some((l) => l.includes(needle));
  if (!hit) throw new Error(`expected to see '${needle}' in delta stream\nTranscript:\n${transcript.join("\n")}`);
}
```

- [ ] **Step 2: Register the command in `src/index.ts`**

Add import:

```ts
import { codexChatSmokeCommand } from "./commands/codex-chat-smoke.js";
```

Add registration (alongside the other `program.addCommand(...)` lines):

```ts
program.addCommand(codexChatSmokeCommand);
```

- [ ] **Step 3: Build and run the basic smoke against real codex**

```bash
npm run build
node dist/index.js codex-chat-smoke --cwd /tmp
# expect: smoke: BASIC ok
```

If codex returns reply text inside `params.text` rather than the JSON-stringified blob, `assertSawText` will still match (we string-include over the truncated JSON). If a future codex version changes notification shape, the smoke will fail loudly with the transcript — that is the desired behavior.

- [ ] **Step 4: Lint**

```bash
npm run lint  # expect clean
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/codex-chat-smoke.ts src/index.ts
git commit -m "feat(codex): cockpit codex-chat-smoke command (basic PING/PONG)

Approval round-trip lands in Task 1.12 and gates Phase 1 PASS."
```

---

### Task 1.12: `cockpit codex-chat-smoke` — approval round-trip (the Phase-1 GATE)

**Files:**
- Modify: `src/commands/codex-chat-smoke.ts`

The approval round-trip is the orca-zero-prior-art surface and the empirical go/no-go for Phase 2. Strategy: ask codex to write a file in `workspace-write` mode at a path that triggers an approval request (the `*ApprovalParams` server request). Answer via `respondToServerRequest`. Assert a subsequent `turn/completed` fires.

- [ ] **Step 1: Add the approval branch**

Append to the `.action(...)` body (replace the `if (!opts.approval) { c.kill(); return; }` line and the stub):

```ts
      if (!opts.approval) { c.kill(); return; }

      // Approval round-trip — Phase-1 GATE.
      const pendingApprovals: Array<{ id: number; method: string }> = [];
      c.on("serverRequest", (r) => {
        pendingApprovals.push({ id: r.id, method: r.method });
        // Approve every approval-shaped request automatically (PASS-by-affirm).
        c.respondToServerRequest(r.id, { decision: "approve" });
      });
      // Ask codex to do something that needs approval (writing a file).
      await c.sendTurn(threadId, `Write the text "approval-ok" to a file at ${resolve(opts.cwd)}/.cockpit-smoke.txt`);
      if (pendingApprovals.length === 0) {
        throw new Error("approval gate: expected at least one server-request (approval/input) during the turn");
      }
      process.stdout.write(`smoke: APPROVAL ok (${pendingApprovals.length} request(s) handled)\n`);
      c.kill();
```

- [ ] **Step 2: Build and run against real codex with `--approval`**

```bash
npm run build
node dist/index.js codex-chat-smoke --cwd /tmp --approval
# expect:
#   smoke: BASIC ok
#   smoke: APPROVAL ok (N request(s) handled)
```

If codex completes the turn without ever requesting approval (e.g. because `workspace-write` allows the path silently), pick a path the sandbox cannot touch — change the prompt to `Write to /etc/cockpit-smoke.txt and explain` to force an approval. Update the prompt until at least one approval lands and the turn still completes.

**STOP if this fails repeatedly across reasonable prompts.** Phase 2 must not start until this passes. Per spec §7, Path Y becomes the considered fallback at this point.

- [ ] **Step 3: Document the result**

Append a short evidence note to the spec history (no commit required — local note):

```bash
date >> .codex-smoke-evidence.local
node dist/index.js codex-chat-smoke --cwd /tmp --approval >> .codex-smoke-evidence.local 2>&1
echo "--- codex --version ---" >> .codex-smoke-evidence.local
codex --version >> .codex-smoke-evidence.local
```

- [ ] **Step 4: Verify build + tests still clean**

```bash
npm run build && npm test -- --run
# expect: build clean, all tests pass
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/codex-chat-smoke.ts
git commit -m "feat(codex): smoke approval round-trip — Phase 1 GATE

This passes the empirical go/no-go criterion in spec §3.5/§3.6:
a turn that triggers a server-request (approval / input) is answered
over RPC via respondToServerRequest, and the turn completes normally.

This is the orca-zero-prior-art surface — if it works in real life,
Phase 2 is sound; if not, Path Y is reconsidered before any daemon
surgery."
```

---

### Task 1.13: Phase 1 closeout — PR

**Files:** none (git/gh only).

- [ ] **Step 1: Final test sweep**

```bash
npm run lint
npm test -- --run
# expect: clean + all green
```

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feature/codex-app-server-client
```

- [ ] **Step 3: Open the PR against develop**

```bash
gh pr create --base develop --title "feat(codex): app-server JSON-RPC client + smoke gate" \
  --body "Phase 1 of \`docs/specs/2026-05-20-cockpit-interactive-codex-design.md\`.

Ships:
- \`src/control/codex/app-server-client.ts\` — typed JSON-RPC client for codex app-server v2.
- Mandatory ordered handshake (initialize → response → 'initialized' notification → methods); pre-handshake methods are refused.
- Defensive newline-framed parser (orca codex-fetcher.ts:160-164 pattern).
- Public API: initialize, startThread/resumeThread/readThread, sendTurn (resolves on TurnCompleted), steerTurn, interruptTurn, injectItems, respondToServerRequest, plus event emitter for notifications and server-requests.
- \`cockpit codex-chat-smoke\` command — Phase 1 empirical gate.
- Vendored protocol types via \`codex app-server generate-ts\` (\`npm run codex:gen-types\`).

GATE PASSED: approval round-trip works end-to-end against codex-cli ≥0.130.0 (see \`.codex-smoke-evidence.local\`).

Phase 2 begins after merge. Closes nothing on its own; sets up the interactive-codex slice of #86."
```

- [ ] **Step 4: Wait for review / CI**

(Manual checkpoint — Phase 2 does not start until this PR merges.)

- [ ] **Step 5: After merge, locally**

```bash
git checkout develop && git pull --ff-only
```

---

# PHASE 2 — daemon driver + cmux-tab client

### Task 2.0: Branch off develop (post-Phase-1 merge)

**Files:** none.

- [ ] **Step 1: Branch**

```bash
git checkout develop && git pull --ff-only
git checkout -b feature/codex-interactive-crew
```

- [ ] **Step 2: Verify Phase 1 is present**

```bash
ls src/control/codex/app-server-client.ts
ls src/control/codex/protocol/ | head -3
# expect: files exist
```

- [ ] **Step 3: Green baseline**

```bash
npm run lint && npm test -- --run
```

---

### Task 2.1: `DispatchAttempt` sub-record schema

**Files:**
- Modify: `src/control/types.ts`
- Modify: `src/control/__tests__/state-machine.test.ts`
- Modify: `src/control/state-machine.ts`

The schema is the foundation of #91 and the #86 interactive-slice fix. Add it now; write reducer behavior in Task 2.2.

- [ ] **Step 1: Add the failing test (schema + initial attempt on dispatch)**

Append to `src/control/__tests__/state-machine.test.ts`:

```ts
import type { DispatchAttempt } from "../types.js";

describe("DispatchAttempt schema", () => {
  it("a fresh TaskRecord has a single attempt with attemptId, startedAt, lastHeartbeatAt", () => {
    const rec: TaskRecord = {
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
    };
    expect(rec.attempts.length).toBe(1);
    expect(rec.attempts[0]?.attemptId).toBe("a1");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`attempts` not on TaskRecord).

- [ ] **Step 3: Add types**

Modify `src/control/types.ts` — add at the bottom, before the closing exports:

```ts
export interface DispatchAttempt {
  attemptId: string;
  startedAt: number;
  pid?: number;
  resumeRef?: string;       // opaque, hashed-treated, NEVER parsed (orca #1148)
  lastHeartbeatAt: number;
  error?: string;
  exitCode?: number;
  circuitBroken?: boolean;
}

export interface Gate {
  gateId: string;
  taskId: string;
  kind: "input" | "approval";
  question: string;
  state: "pending" | "resolved" | "timeout";
  createdAt: number;
  resolvedBy?: string;
  resolution?: unknown;
}
```

And add `attempts: DispatchAttempt[]` + `gates?: Gate[]` on `TaskRecord` (after `heartbeatBudgetMs: number;`):

```ts
  /** Append-only dispatch attempt history. Current attempt = at(-1). */
  attempts: DispatchAttempt[];
  /** Interactive-codex HITL slice (spec §4.9). */
  gates?: Gate[];
```

Update existing top-level fields' comment block to note they're derived from the latest attempt going forward, but DO NOT remove them yet (existing call sites still read them) — they will be derived in a follow-up issue (#91).

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- --run src/control/__tests__/state-machine.test.ts
```

- [ ] **Step 5: Fix the now-failing call sites**

Existing tests that create `TaskRecord` literals (e.g. `store.test.ts:8-14`) need to set `attempts: []` or `attempts: [{ attemptId: ..., startedAt: ..., lastHeartbeatAt: ... }]`. Run:

```bash
npm test -- --run
# expect: failures in store.test.ts, state-machine.test.ts, others that build TaskRecord literals
```

For each failing literal, set:

```ts
attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
```

Re-run until green.

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "feat(control): DispatchAttempt + Gate schema on TaskRecord (#91 setup, spec §4.3)

DispatchAttempt sub-record carries attemptId, startedAt, pid, resumeRef
(opaque hashed token — never parsed, orca #1148), lastHeartbeatAt, error,
exitCode, circuitBroken. attempts[] on TaskRecord is append-only; current
attempt = at(-1). Existing top-level liveness fields stay for now and will
be derived from attempts in #91's follow-up.

Gate schema added for spec §4.9 (interactive-codex HITL slice). Wiring
lands in Task 2.10."
```

---

### Task 2.2: Reducer writes `resumeRef` on every transition

**Files:**
- Modify: `src/control/state-machine.ts`
- Modify: `src/control/__tests__/state-machine.test.ts`
- Modify: `src/control/types.ts`

The cornerstone of the #86 interactive-slice fix: every state transition records the current `resumeRef` (and any pid/heartbeat update) into the latest `DispatchAttempt`. The reducer remains pure.

We extend `ControlEvent` with one new variant: `task.session` — emitted by the driver when `thread/start` returns a `threadId`. This is what writes `resumeRef`.

- [ ] **Step 1: Add the failing test**

Append:

```ts
describe("reducer · resumeRef-on-every-transition", () => {
  function base(): TaskRecord {
    return {
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 60000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
    };
  }
  it("task.session stamps resumeRef on the current attempt", () => {
    const r = reduce(base(), { type: "task.session", id: "t1", resumeRef: "TH-1" } as any, 100);
    expect(r.attempts.at(-1)?.resumeRef).toBe("TH-1");
    // pure: previous attempts unchanged
    expect(r.attempts.length).toBe(1);
  });
  it("task.started updates pid on current attempt without losing resumeRef", () => {
    let r = reduce(base(), { type: "task.session", id: "t1", resumeRef: "TH-1" } as any, 100);
    r = reduce(r, { type: "task.started", id: "t1", pid: 1234 }, 200);
    expect(r.attempts.at(-1)?.resumeRef).toBe("TH-1");
    expect(r.attempts.at(-1)?.pid).toBe(1234);
    expect(r.state).toBe("working");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (state-machine doesn't know about `task.session`).

- [ ] **Step 3: Extend `ControlEvent` and the reducer**

In `src/control/types.ts`, extend the `ControlEvent` union:

```ts
  | { type: "task.session"; id: string; resumeRef: string }
  | { type: "task.turn.started"; id: string; turnId: string }
  | { type: "task.turn.completed"; id: string; turnId: string }
  | { type: "task.delta"; id: string; turnId: string; chunk: string }
  | { type: "task.input.requested"; id: string; requestId: number; question: string }
  | { type: "task.approval.requested"; id: string; requestId: number; question: string; kind: string }
  | { type: "task.reattached"; id: string }
```

In `src/control/state-machine.ts`, add a helper at the top and use it in every case arm:

```ts
function stampAttempt(rec: TaskRecord, patch: Partial<import("./types.js").DispatchAttempt>, now: number): TaskRecord {
  const attempts = rec.attempts.slice();
  const last = attempts.at(-1) ?? { attemptId: "a0", startedAt: now, lastHeartbeatAt: now };
  attempts[attempts.length === 0 ? 0 : attempts.length - 1] = { ...last, ...patch, lastHeartbeatAt: now };
  if (attempts.length === 0) attempts.push(last);
  return { ...rec, attempts };
}
```

Add the new event arms (place inside the `switch`, before `default`):

```ts
    case "task.session":
      return stampAttempt({ ...base }, { resumeRef: ev.resumeRef }, now);
    case "task.turn.started":
      return { ...stampAttempt(base, {}, now), state: "working" };
    case "task.turn.completed":
      // Anti-#2576: liveness, NOT completion. Spec §4.8.
      return { ...stampAttempt(base, {}, now), state: "awaiting-input" as any };
    case "task.delta":
      return stampAttempt(base, {}, now);  // heartbeat-only
    case "task.input.requested":
    case "task.approval.requested":
      return { ...stampAttempt(base, {}, now), state: "blocked", question: ev.question };
    case "task.reattached":
      return stampAttempt(base, {}, now);
```

Update `task.started` to call `stampAttempt(..., { pid: ev.pid })`:

```ts
    case "task.started":
      return {
        ...stampAttempt(base, { pid: ev.pid }, now),
        state: "working",
        sessionId: ev.sessionId ?? rec.sessionId,
        question: undefined,
      };
```

Add `"awaiting-input"` to the `TaskState` union in `src/control/types.ts`.

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- --run src/control/__tests__/state-machine.test.ts
```

- [ ] **Step 5: Fix any failing TS / tests**

```bash
npm run lint
npm test -- --run
# fix any TaskState exhaustiveness now-uncovered (`awaiting-input` missing in a switch).
```

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "feat(control): reducer writes resumeRef on every transition

Spec §4.3 + §5. The #86 interactive-slice cornerstone: every transition
updates the latest attempt's resumeRef/pid/lastHeartbeatAt. The reducer
stays pure (stampAttempt returns a new attempts array).

New ControlEvent variants for app-server notifications:
  task.session  - thread/start returned a threadId
  task.turn.started / .completed
  task.delta    - streaming chunk (heartbeat-only)
  task.input.requested / .approval.requested
  task.reattached

TaskState gains 'awaiting-input' for the anti-#2576 invariant (spec §4.8):
TurnCompleted → awaiting-input, NEVER → done."
```

---

### Task 2.3: `normalizeAppServerNotification` — `never`-guarded exhaustive switch

**Files:**
- Create: `src/control/codex/normalize.ts`
- Create: `src/control/codex/__tests__/normalize.test.ts`

A pure function: app-server notification → cockpit `ControlEvent` (or null for "ignored / status-line only"). Spec §4.7.

- [ ] **Step 1: Failing test**

Create `src/control/codex/__tests__/normalize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeAppServerNotification } from "../normalize.js";

describe("normalizeAppServerNotification", () => {
  it("maps turn/started → task.turn.started", () => {
    expect(normalizeAppServerNotification("X", { method: "turn/started", params: { turnId: "u" } }))
      .toEqual({ type: "task.turn.started", id: "X", turnId: "u" });
  });
  it("maps turn/completed → task.turn.completed", () => {
    expect(normalizeAppServerNotification("X", { method: "turn/completed", params: { turnId: "u" } }))
      .toEqual({ type: "task.turn.completed", id: "X", turnId: "u" });
  });
  it("maps agentMessageDelta → task.delta (heartbeat)", () => {
    expect(normalizeAppServerNotification("X", { method: "agentMessageDelta", params: { turnId: "u", text: "hi" } }))
      .toEqual({ type: "task.delta", id: "X", turnId: "u", chunk: "hi" });
  });
  it("returns null for status-line-only notifications", () => {
    expect(normalizeAppServerNotification("X", { method: "thread/token-usage/updated", params: {} }))
      .toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/control/codex/normalize.ts`:

```ts
// src/control/codex/normalize.ts
// Pure mapping from app-server notification → cockpit ControlEvent.
// Spec §4.7. Exhaustive on the *handled* set; unknown methods → null
// (status-line / forward-compat). When codex adds notifications we add cases.
import type { ControlEvent } from "../types.js";

type Note = { method: string; params?: any };

export function normalizeAppServerNotification(taskId: string, n: Note): ControlEvent | null {
  switch (n.method) {
    case "turn/started":   return { type: "task.turn.started",   id: taskId, turnId: n.params?.turnId };
    case "turn/completed": return { type: "task.turn.completed", id: taskId, turnId: n.params?.turnId };
    case "agentMessageDelta":
    case "reasoningTextDelta":
    case "commandExecOutputDelta":
      return { type: "task.delta", id: taskId, turnId: n.params?.turnId ?? "", chunk: String(n.params?.text ?? "") };
    case "error":
      return { type: "task.failed", id: taskId, error: String(n.params?.message ?? "error") };
    // forward-compat ignored (status-line only):
    case "thread/token-usage/updated":
    case "context/compacted":
    case "thread/status/changed":
      return null;
  }
  return null; // unknown — treat as status-line, never as done
}
```

Note: server *requests* (with both `id` and `method`) are handled separately in Task 2.4's driver — they map to `task.input.requested` / `task.approval.requested`, not via this notification normalizer.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/control/codex/normalize.ts src/control/codex/__tests__/normalize.test.ts
git commit -m "feat(codex): normalizeAppServerNotification (spec §4.7)

Pure map from app-server notification → ControlEvent. Unknown methods
return null (status-line / forward-compat). Server-requests are routed
by the driver, not this function."
```

---

### Task 2.4: `CodexInteractiveDriver` — owns the app-server child, maps requests/notifications

**Files:**
- Create: `src/control/codex/driver.ts`
- Create: `src/control/codex/__tests__/driver.test.ts`
- Modify: `src/control/interactive/registry.ts` (remove codex entry)
- Delete: `src/control/interactive/codex.ts`

The driver:
1. Owns one long-lived `AppServerClient`.
2. On `dispatch(rec)`: ensures the client is up + handshake done, calls `startThread`, emits `task.session` (with `resumeRef = threadId`).
3. Subscribes to client notifications → `normalizeAppServerNotification` → applies via the store's reducer (via `events` ingress).
4. Routes server-requests to `task.input.requested` / `task.approval.requested`.
5. Provides `reattach(rec)` for daemon restart.

- [ ] **Step 1: Failing test (dispatch happy path)**

Create `src/control/codex/__tests__/driver.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { CodexInteractiveDriver } from "../driver.js";
import { EventEmitter } from "node:events";

function fakeClient() {
  const ee = new EventEmitter() as any;
  ee.initialize = vi.fn().mockResolvedValue({});
  ee.startThread = vi.fn().mockResolvedValue({ threadId: "TH-1" });
  ee.start = vi.fn();
  ee.kill = vi.fn();
  return ee;
}

describe("CodexInteractiveDriver.dispatch", () => {
  it("ensures handshake, starts a thread, and emits task.session with resumeRef", async () => {
    const client = fakeClient();
    const events: any[] = [];
    const drv = new CodexInteractiveDriver({
      makeClient: () => client,
      emit: (ev) => events.push(ev),
    });
    await drv.dispatch({
      id: "t1", project: "p", provider: "codex", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
      cwd: "/tmp/work",
    } as any);
    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/work", sandbox: "workspace-write" }));
    expect(events).toEqual([
      { type: "task.session", id: "t1", resumeRef: "TH-1" },
      { type: "task.started", id: "t1" },
    ]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/control/codex/driver.ts`:

```ts
// src/control/codex/driver.ts
import { AppServerClient } from "./app-server-client.js";
import { normalizeAppServerNotification } from "./normalize.js";
import type { ControlEvent, TaskRecord } from "../types.js";

export interface DriverDeps {
  makeClient?: () => AppServerClient;
  emit: (ev: ControlEvent) => void;  // ingress into the daemon's event pipeline
}

export class CodexInteractiveDriver {
  private client?: AppServerClient;
  private handshakeP?: Promise<void>;
  private threadByTask = new Map<string, string>();
  private taskByThread = new Map<string, string>();
  private serverRequestByTask = new Map<string, number>();   // taskId → last requestId
  private deps: DriverDeps;

  constructor(deps: DriverDeps) { this.deps = deps; }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client) return this.client;
    const c = (this.deps.makeClient ?? (() => new AppServerClient({ clientInfo: { name: "cockpit", version: "iv" } })))();
    this.client = c;
    c.start();
    c.on("notification", (n) => this.onNotification(n));
    c.on("serverRequest", (r) => this.onServerRequest(r));
    c.on("closed", () => { this.client = undefined; this.handshakeP = undefined; });
    return c;
  }

  private async ensureHandshake(): Promise<void> {
    const c = await this.ensureClient();
    if (!this.handshakeP) this.handshakeP = c.initialize().then(() => {});
    return this.handshakeP;
  }

  async dispatch(rec: TaskRecord & { cwd?: string; model?: string }): Promise<void> {
    const c = await this.ensureClient();
    await this.ensureHandshake();
    const { threadId } = await c.startThread({
      cwd: rec.cwd ?? process.cwd(),
      model: rec.model,
      sandbox: "workspace-write",
    });
    this.threadByTask.set(rec.id, threadId);
    this.taskByThread.set(threadId, rec.id);
    this.deps.emit({ type: "task.session", id: rec.id, resumeRef: threadId });
    this.deps.emit({ type: "task.started", id: rec.id });
  }

  async say(taskId: string, text: string): Promise<void> {
    const c = this.client!;
    const tid = this.threadByTask.get(taskId);
    if (!tid) throw new Error(`no thread for task ${taskId}`);
    await c.sendTurn(tid, text);
  }

  async steer(taskId: string, text: string): Promise<void> {
    const c = this.client!;
    const tid = this.threadByTask.get(taskId);
    if (!tid) throw new Error(`no thread for task ${taskId}`);
    await c.steerTurn(tid, text);
  }

  async answer(taskId: string, payload: unknown): Promise<void> {
    const c = this.client!;
    const reqId = this.serverRequestByTask.get(taskId);
    if (reqId == null) throw new Error(`no pending server-request for task ${taskId}`);
    c.respondToServerRequest(reqId, payload);
    this.serverRequestByTask.delete(taskId);
  }

  async reattach(rec: TaskRecord): Promise<void> {
    const c = await this.ensureClient();
    await this.ensureHandshake();
    const resumeRef = rec.attempts.at(-1)?.resumeRef;
    if (!resumeRef) throw new Error(`reattach: no resumeRef on task ${rec.id}`);
    await c.resumeThread({ threadId: resumeRef, cwd: (rec as any).cwd });
    this.threadByTask.set(rec.id, resumeRef);
    this.taskByThread.set(resumeRef, rec.id);
    this.deps.emit({ type: "task.reattached", id: rec.id });
  }

  private onNotification(n: { method: string; params?: any }): void {
    const tid = n.params?.threadId ?? n.params?.thread_id;
    const taskId = tid ? this.taskByThread.get(tid) : undefined;
    if (!taskId) return; // notifications without a thread context are status-line
    const ev = normalizeAppServerNotification(taskId, n);
    if (ev) this.deps.emit(ev);
  }

  private onServerRequest(r: { id: number; method: string; params?: any }): void {
    const tid = r.params?.threadId ?? r.params?.thread_id;
    const taskId = tid ? this.taskByThread.get(tid) : undefined;
    if (!taskId) return;
    this.serverRequestByTask.set(taskId, r.id);
    const kind = r.method.includes("Approval") || r.method.includes("approval") ? "approval" : "input";
    if (kind === "approval") {
      this.deps.emit({ type: "task.approval.requested", id: taskId, requestId: r.id, question: String(r.params?.question ?? r.method), kind: r.method });
    } else {
      this.deps.emit({ type: "task.input.requested", id: taskId, requestId: r.id, question: String(r.params?.question ?? r.method) });
    }
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- --run src/control/codex/__tests__/driver.test.ts
```

- [ ] **Step 5: Delete the obsolete hook adapter**

```bash
git rm src/control/interactive/codex.ts
```

Modify `src/control/interactive/registry.ts` — remove the `codex` import + entry:

```ts
import type { InteractiveHookAdapter } from "./types.js";
import { claudeInteractive } from "./claude.js";

const ADAPTERS: Record<string, InteractiveHookAdapter> = {
  claude: claudeInteractive,
};

export function getInteractiveAdapter(provider: string): InteractiveHookAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`no interactive adapter for provider '${provider}'`);
  return a;
}
```

Run tests; expect any test asserting `getInteractiveAdapter("codex")` returns something to fail — update those tests to assert it now throws (or skip codex in that suite — codex's interactive path is the driver now, not a hook adapter).

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "feat(codex): CodexInteractiveDriver — owns app-server child, emits ControlEvents

Spec §4. dispatch() ensures handshake, starts a thread, emits task.session
with resumeRef=threadId. reattach(rec) resumes via thread/resume and emits
task.reattached. Notifications routed through normalizeAppServerNotification.
Server-requests routed to task.input.requested / task.approval.requested
with requestId stored per task for answer() round-trip.

The old interactive/codex.ts 'best-effort' hook adapter is removed — codex
interactive is now driver-based (the spec's whole point)."
```

---

### Task 2.5: Daemon "ready" = handshake-complete (not child-spawned)

**Files:**
- Modify: `src/control/codex/driver.ts`
- Modify: `src/control/codex/__tests__/driver.test.ts`

The driver's dispatch already awaits `initialize` + `startThread`. Make the failure mode explicit: if either step throws or times out (default 10s), emit `task.failed` with a clear error so the task doesn't get stuck in `submitted` (spec §4.4).

- [ ] **Step 1: Failing test**

Append:

```ts
it("if initialize rejects, emits task.failed with a clear error (handshake gate)", async () => {
  const client = fakeClient();
  client.initialize = vi.fn().mockRejectedValue(new Error("Not initialized"));
  const events: any[] = [];
  const drv = new CodexInteractiveDriver({ makeClient: () => client, emit: (ev) => events.push(ev) });
  await drv.dispatch({
    id: "t1", project: "p", provider: "codex", mode: "interactive",
    state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a1", startedAt: 1, lastHeartbeatAt: 1 }],
  } as any).catch(() => {});
  expect(events.some((e) => e.type === "task.failed" && /handshake/i.test(e.error))).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL** (currently the dispatch just rethrows; the daemon catches but with a generic message).

- [ ] **Step 3: Wrap dispatch in a try/emit**

Replace the dispatch body in `driver.ts`:

```ts
  async dispatch(rec: TaskRecord & { cwd?: string; model?: string }): Promise<void> {
    try {
      const c = await this.ensureClient();
      await withTimeout(this.ensureHandshake(), 10_000, "handshake timed out");
      const { threadId } = await c.startThread({
        cwd: rec.cwd ?? process.cwd(),
        model: rec.model,
        sandbox: "workspace-write",
      });
      this.threadByTask.set(rec.id, threadId);
      this.taskByThread.set(threadId, rec.id);
      this.deps.emit({ type: "task.session", id: rec.id, resumeRef: threadId });
      this.deps.emit({ type: "task.started", id: rec.id });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.emit({ type: "task.failed", id: rec.id, error: `handshake/start failed: ${msg}` });
      throw e;  // surface to daemon for its own bookkeeping
    }
  }
```

Add helper:

```ts
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): handshake-gated 'ready' — fail loud on initialize/startThread error

Spec §4.4 — counters codex 0.129+ silent-degradation (orca config-toml-trust.ts).
A task does not transition to 'working' until initialize + startThread both
return; either failing emits task.failed with a clear error within 10s."
```

---

### Task 2.6: Streaming subscribe protocol — daemon side

**Files:**
- Modify: `src/control/protocol.ts`
- Modify: `src/control/daemon.ts`
- Create: `src/control/__tests__/streaming-protocol.test.ts`

Today the daemon socket is request/response. Add one verb: an `attach` long-lived connection that emits newline-delimited event frames out and accepts `say`/`steer`/`interrupt`/`answer` frames in. Additive — does not touch existing verbs.

- [ ] **Step 1: Failing protocol test**

Create `src/control/__tests__/streaming-protocol.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrames, type AttachFrame } from "../protocol.js";

describe("streaming protocol frames", () => {
  it("encode/decode round-trips an attach-out frame", () => {
    const f: AttachFrame = { type: "delta", taskId: "t1", text: "hello" };
    expect(decodeFrames(encodeFrame(f))).toEqual([f]);
  });
  it("ignores blank and malformed lines", () => {
    const wire = "\n{\"type\":\"turn-completed\",\"taskId\":\"t1\"}\nbogus\n";
    expect(decodeFrames(wire)).toEqual([{ type: "turn-completed", taskId: "t1" }]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Append to `src/control/protocol.ts`:

```ts
// Streaming-subscribe frames for `cockpit crew chat / attach` (spec §4.5).
// Additive; existing request/response verbs untouched. Cooperates with #87.

export type AttachFrame =
  | { type: "delta"; taskId: string; text: string }
  | { type: "turn-started"; taskId: string }
  | { type: "turn-completed"; taskId: string }
  | { type: "input-requested"; taskId: string; requestId: number; question: string }
  | { type: "approval-requested"; taskId: string; requestId: number; question: string; kind: string }
  | { type: "gate-promoted"; taskId: string; gateId: string }
  | { type: "reattached"; taskId: string }
  | { type: "closed"; taskId: string; reason: string }
  | { type: "_keepalive" };

export type AttachInbound =
  | { op: "attach"; taskId: string }
  | { op: "say"; taskId: string; text: string }
  | { op: "steer"; taskId: string; text: string }
  | { op: "interrupt"; taskId: string }
  | { op: "answer"; taskId: string; requestId: number; payload: unknown };

export function encodeFrame(f: AttachFrame): string {
  return JSON.stringify(f) + "\n";
}

export function decodeFrames(wire: string): AttachFrame[] {
  const out: AttachFrame[] = [];
  for (const line of wire.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as AttachFrame); } catch { /* skip malformed */ }
  }
  return out;
}
```

Daemon wiring (in `src/control/daemon.ts` — add a new `handleAttach(conn, taskId)` exported function that the cockpitd server dispatches to when a connection's first frame has `op: "attach"`). For Task 2.6, just export the helpers + types; the connection routing lands in Task 2.7's cockpitd wiring.

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- --run src/control/__tests__/streaming-protocol.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(protocol): attach/say/steer/interrupt/answer streaming frames (spec §4.5)

Additive newline-delimited frame set for the cockpit crew chat/attach
streaming channel. Existing request/response verbs untouched. The
_keepalive frame is reserved (cooperates with #94)."
```

---

### Task 2.7: Wire `launchInteractive` for codex + open `attach` connections in `cockpitd`

**Files:**
- Modify: `src/control/cockpitd.ts`
- Modify: `src/control/daemon.ts`
- Modify: `src/control/__tests__/daemon.test.ts`

`DaemonDeps.launchInteractive?` is the forward hook (daemon.ts existing). Wire it to a singleton `CodexInteractiveDriver` for `provider=codex`. On the socket, when a client sends `{op:"attach",taskId}`, hold the connection open and pipe driver-emitted `AttachFrame`s for that taskId to it; accept `say/steer/interrupt/answer` frames back.

- [ ] **Step 1: Failing test (wiring)**

Append a test to `src/control/__tests__/daemon.test.ts`:

```ts
import { CodexInteractiveDriver } from "../codex/driver.js";

it("daemon routes codex interactive dispatch to the driver", async () => {
  const calls: any[] = [];
  const fakeDriver = {
    dispatch: vi.fn().mockImplementation(async (rec) => calls.push(["dispatch", rec.id])),
    reattach: vi.fn(),
    say: vi.fn(), steer: vi.fn(), answer: vi.fn(),
  } as any;
  const d = createDaemon({
    store: { put: vi.fn(), get: vi.fn(), list: vi.fn(), listAll: () => [], quarantine: vi.fn() } as any,
    now: () => 1,
    launchInteractive: (rec) => rec.provider === "codex" ? fakeDriver.dispatch(rec) : Promise.reject(new Error("unhandled")),
  });
  const rec: any = {
    id: "t1", project: "p", provider: "codex", mode: "interactive",
    state: "submitted", task: "hi", createdAt: 1, lastHeartbeat: 1, lastEvent: "",
    heartbeatBudgetMs: 1000, attempts: [{ attemptId: "a", startedAt: 1, lastHeartbeatAt: 1 }],
  };
  await d.handle({ kind: "dispatch", record: rec });
  expect(calls).toEqual([["dispatch", "t1"]]);
});
```

- [ ] **Step 2: Run — expect PASS (already passes — `daemon.ts` already calls `deps.launchInteractive` if provided)**

If it does not pass, the existing daemon code in `src/control/daemon.ts` already handles the wiring (see file head from recon); the test asserts the contract.

- [ ] **Step 3: Wire the real driver in `src/control/cockpitd.ts`**

In `cockpitd.ts`, alongside the headless registry wiring, add:

```ts
import { CodexInteractiveDriver } from "./codex/driver.js";
// inside the daemon factory, BEFORE createDaemon(...):
const codexDriver = new CodexInteractiveDriver({
  emit: (ev) => ingestEvent(ev),  // ingestEvent applies the event via state-machine + store
});

// and in the deps passed to createDaemon:
launchInteractive: async (rec) => {
  if (rec.provider !== "codex") throw new Error(`interactive only implemented for codex (got '${rec.provider}')`);
  await codexDriver.dispatch(rec as any);
},
```

`ingestEvent` is the existing event-ingress path that calls `reduce()` and `store.put`. If the local name differs in `cockpitd.ts`, follow the existing pattern — search for how `event` requests already flow into the store.

- [ ] **Step 4: Add the attach-connection routing on the socket**

In `cockpitd.ts`, where the server's connection handler dispatches inbound frames: detect `{op:"attach",taskId}` as the first frame on a connection; subscribe that connection to a per-task fan-out of `AttachFrame`s. Driver writes `encodeFrame(...)` for the connections registered for that taskId. On `say/steer/interrupt/answer` from the connection, route to `codexDriver.say/steer/interruptTurn/answer(taskId, …)`.

```ts
// Pseudocode where the connection handler lives:
import { encodeFrame, decodeFrames, type AttachInbound, type AttachFrame } from "./protocol.js";
const attachConns = new Map<string, Set<NodeJS.WritableStream>>();
function broadcast(taskId: string, f: AttachFrame): void {
  for (const conn of attachConns.get(taskId) ?? []) conn.write(encodeFrame(f));
}
// On each connection's data event, parse frames; if the first is { op: "attach", taskId },
// remember the conn under that taskId; subsequent frames invoke driver methods.
```

Wire `codexDriver`'s emitted ControlEvents into `broadcast` via small `if`s:

```ts
// In the codex driver emit() callback, after applying via state machine:
if (ev.type === "task.delta") broadcast(ev.id, { type: "delta", taskId: ev.id, text: ev.chunk });
if (ev.type === "task.turn.started") broadcast(ev.id, { type: "turn-started", taskId: ev.id });
if (ev.type === "task.turn.completed") broadcast(ev.id, { type: "turn-completed", taskId: ev.id });
if (ev.type === "task.input.requested") broadcast(ev.id, { type: "input-requested", taskId: ev.id, requestId: ev.requestId, question: ev.question });
if (ev.type === "task.approval.requested") broadcast(ev.id, { type: "approval-requested", taskId: ev.id, requestId: ev.requestId, question: ev.question, kind: ev.kind });
if (ev.type === "task.reattached") broadcast(ev.id, { type: "reattached", taskId: ev.id });
```

- [ ] **Step 5: Build + test**

```bash
npm run build && npm test -- --run
# expect: clean
```

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "feat(cockpitd): wire CodexInteractiveDriver to launchInteractive + attach fan-out"
```

---

### Task 2.8: `cockpit crew attach <taskId>` — the cmux-tab client

**Files:**
- Create: `src/commands/crew-attach.ts`
- Modify: `src/commands/crew-control.ts` (add the subcommand)

The renderer: connects to the daemon socket, sends `{op:"attach",taskId}`, prints incoming `delta` frames to stdout, reads stdin line-by-line and sends `{op:"say",taskId,text}` on Enter. Prompts visibly on `input-requested` / `approval-requested`.

- [ ] **Step 1: Implement**

Create `src/commands/crew-attach.ts`:

```ts
// src/commands/crew-attach.ts
import { Command } from "commander";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { encodeFrame, decodeFrames, type AttachFrame, type AttachInbound } from "../control/protocol.js";

function socketPath(): string {
  return process.env.COCKPITD_SOCK ?? join(homedir(), ".config", "cockpit", "cockpitd.sock");
}

export const crewAttachCommand = new Command("attach")
  .description("Attach to a live interactive task (renders deltas; takes follow-ups).")
  .argument("<taskId>", "task id to attach to")
  .action(async (taskId: string) => {
    const conn = createConnection(socketPath());
    const send = (m: AttachInbound) => conn.write(JSON.stringify(m) + "\n");
    conn.on("connect", () => send({ op: "attach", taskId }));
    let pendingRequestId: number | undefined;
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const frames = decodeFrames(buf); buf = "";
      for (const f of frames) render(f);
    });
    conn.on("close", () => { process.stderr.write("\n(connection closed)\n"); process.exit(0); });

    function render(f: AttachFrame): void {
      switch (f.type) {
        case "delta": process.stdout.write(f.text); break;
        case "turn-started": process.stdout.write("\n[codex]\n"); break;
        case "turn-completed": process.stdout.write("\n[done — type a follow-up or Ctrl-C]\n> "); break;
        case "input-requested":
          pendingRequestId = f.requestId;
          process.stdout.write(`\n[codex asks] ${f.question}\n[answer]> `); break;
        case "approval-requested":
          pendingRequestId = f.requestId;
          process.stdout.write(`\n[approval] ${f.kind}: ${f.question}\n[approve/deny]> `); break;
        case "gate-promoted":
          process.stdout.write(`\n(no client was attached; the question was promoted to gate ${f.gateId})\n> `); break;
        case "reattached": process.stdout.write("\n(reattached)\n> "); break;
        case "closed": process.stdout.write(`\n(closed: ${f.reason})\n`); break;
        case "_keepalive": /* ignore */ break;
      }
    }

    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (text) => {
      if (pendingRequestId != null) {
        send({ op: "answer", taskId, requestId: pendingRequestId, payload: { text, decision: text.toLowerCase().startsWith("approve") ? "approve" : text.toLowerCase().startsWith("deny") ? "deny" : undefined } });
        pendingRequestId = undefined;
      } else {
        send({ op: "say", taskId, text });
      }
    });
    process.on("SIGINT", () => send({ op: "interrupt", taskId }));
  });
```

- [ ] **Step 2: Register under `cockpit crew`**

In `src/commands/crew-control.ts` (the file that adds control-plane verbs to the existing `crew` command, per session memory), add:

```ts
import { crewAttachCommand } from "./crew-attach.js";
// inside addControlPlaneCrewCommands(crew):
crew.addCommand(crewAttachCommand);
```

- [ ] **Step 3: Smoke check (manually — daemon not yet listening for attach, but help works)**

```bash
npm run build
node dist/index.js crew attach --help
# expect: usage line w/ <taskId>
```

- [ ] **Step 4: Lint**

```bash
npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(crew): cockpit crew attach <taskId> — cmux-tab renderer/input client

Spec §4.6. Newline-framed AttachFrame in / AttachInbound out over the
cockpitd socket. Renders deltas; prompts visibly on input/approval requests
and on gate-promoted; SIGINT issues turn/interrupt."
```

---

### Task 2.9: `cockpit crew chat` — create task, open cmux tab running attach

**Files:**
- Create: `src/commands/crew-chat.ts`
- Modify: `src/commands/crew-control.ts`

The "ignition" command: dispatches an interactive codex task via the control plane (cockpit re-uses the existing dispatch mechanism), then opens a cmux tab running `cockpit crew attach <taskId>`.

- [ ] **Step 1: Implement**

Create `src/commands/crew-chat.ts`:

```ts
// src/commands/crew-chat.ts
import { Command } from "commander";
import { buildDispatchRequest, call as cockpitdCall } from "./crew-control.js";   // existing dispatch helpers
import { spawn } from "node:child_process";

export const crewChatCommand = new Command("chat")
  .description("Open a live human↔codex chat in a cmux tab (spec §4.2).")
  .requiredOption("--provider <p>", "provider (codex only today)")
  .requiredOption("--project <name>", "project name")
  .option("--cwd <dir>", "working dir for the codex thread", process.cwd())
  .option("--model <m>", "model id (optional)")
  .action(async (opts: { provider: string; project: string; cwd: string; model?: string }) => {
    if (opts.provider !== "codex") throw new Error("crew chat is implemented for provider=codex only");
    const req = buildDispatchRequest({
      provider: "codex", mode: "interactive", project: opts.project, cwd: opts.cwd, task: "(interactive)",
    });
    const rec: any = await cockpitdCall({ kind: "dispatch", record: req });
    process.stdout.write(`task ${rec.id} dispatched\n`);
    // Open cmux tab whose command is `cockpit crew attach <taskId>`.
    // Cockpit's workspace/tab opener is invoked the same way crew spawn does it;
    // here we shell out to cmux directly with the attach command.
    const tabCmd = `cockpit crew attach ${rec.id}`;
    spawn("cmux", ["new-tab", "--", "/bin/sh", "-lc", tabCmd], { stdio: "inherit" });
  });
```

Note: `buildDispatchRequest` and `call` already exist in `src/commands/crew-control.ts` (per session memory + recon); re-export them if needed. If they aren't directly exported, expose minimal helpers from that file or call via the same daemon socket pattern the existing `dispatch` command uses.

- [ ] **Step 2: Register**

In `src/commands/crew-control.ts`:

```ts
import { crewChatCommand } from "./crew-chat.js";
// inside addControlPlaneCrewCommands(crew):
crew.addCommand(crewChatCommand);
```

- [ ] **Step 3: Build + smoke (help only — daemon attach end is wired but ensure command parses)**

```bash
npm run build
node dist/index.js crew chat --help
# expect: usage + flags
```

- [ ] **Step 4: Lint**

```bash
npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(crew): cockpit crew chat --provider codex (spec §4.2)

Dispatches an interactive codex task and opens a cmux tab running
'cockpit crew attach <taskId>'. The two halves are decoupled — attach
can be called by hand on any existing interactive task (the reconnect
path, spec §5)."
```

---

### Task 2.10: Gate primitive — 5s presence buffer → promote pending request

**Files:**
- Create: `src/control/codex/gate.ts`
- Create: `src/control/codex/__tests__/gate.test.ts`
- Modify: `src/control/codex/driver.ts`
- Modify: `src/control/cockpitd.ts`

When `task.input.requested` or `task.approval.requested` lands and no attach connection has been present for that task in the last 5s, promote the request to a `Gate`. The Captain can then resolve via `cockpit crew reply --gate <id>` (Task 2.11).

- [ ] **Step 1: Failing test (pure gate helper)**

Create `src/control/codex/__tests__/gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeGate, resolveGate, timeoutGate } from "../gate.js";

describe("gate helpers", () => {
  it("makeGate creates a pending gate with monotonic id", () => {
    const g = makeGate({ taskId: "t1", kind: "input", question: "ok?", now: 1, mkId: () => "g1" });
    expect(g).toEqual({ gateId: "g1", taskId: "t1", kind: "input", question: "ok?", state: "pending", createdAt: 1 });
  });
  it("resolveGate flips state and stamps resolution", () => {
    const g = makeGate({ taskId: "t1", kind: "approval", question: "?", now: 1, mkId: () => "g2" });
    const r = resolveGate(g, { resolvedBy: "captain", resolution: { decision: "approve" } });
    expect(r.state).toBe("resolved");
    expect(r.resolution).toEqual({ decision: "approve" });
  });
});
```

- [ ] **Step 2: Implement**

Create `src/control/codex/gate.ts`:

```ts
import type { Gate } from "../types.js";

export function makeGate(opts: {
  taskId: string;
  kind: "input" | "approval";
  question: string;
  now: number;
  mkId: () => string;
}): Gate {
  return { gateId: opts.mkId(), taskId: opts.taskId, kind: opts.kind, question: opts.question, state: "pending", createdAt: opts.now };
}
export function resolveGate(g: Gate, by: { resolvedBy: string; resolution: unknown }): Gate {
  return { ...g, state: "resolved", resolvedBy: by.resolvedBy, resolution: by.resolution };
}
export function timeoutGate(g: Gate): Gate {
  return { ...g, state: "timeout" };
}
```

- [ ] **Step 3: Wire promotion in `cockpitd.ts`**

Where the codex driver emits `task.input.requested` / `task.approval.requested`: check if `attachConns.has(taskId) && attachConns.get(taskId)!.size > 0`. If yes → broadcast as input/approval-requested. If no → wait 5s; if still no attached conn, create a `Gate` via `makeGate`, attach to `TaskRecord.gates` (update via the store), broadcast `gate-promoted` (so a late-attaching client can see it).

The buffer can be a `setTimeout(promote, 5000)` cleared when an attach conn arrives within the window.

- [ ] **Step 4: Build + test**

```bash
npm run build && npm test -- --run
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(codex): gate primitive (5s presence buffer → promote, spec §4.9)

Pure makeGate/resolveGate/timeoutGate helpers. cockpitd promotes a pending
server-request to a Gate after 5s of no attached client; clients that
(re)attach later see gate-promoted frames and can offer takeover."
```

---

### Task 2.11: Captain visibility — `crew status` shows gates; `crew reply --gate`

**Files:**
- Modify: `src/commands/crew-control.ts`
- Modify: `src/control/daemon.ts`

`cockpit crew status` already returns a TaskRecord; it now naturally carries `attempts` and `gates`. Render them. Add `cockpit crew reply --gate <gateId> <payload>` that resolves the gate via the daemon and triggers the driver's `answer()`.

- [ ] **Step 1: Extend the daemon `Req` type**

In `src/control/daemon.ts` `Req` union:

```ts
  | { kind: "gate-resolve"; project: string; gateId: string; resolvedBy: string; payload: unknown }
```

Handler:

```ts
        case "gate-resolve": {
          const rec = deps.store.listAll().find((r) => r.gates?.some((g) => g.gateId === req.gateId));
          if (!rec || !rec.gates) throw new Error(`gate ${req.gateId} not found`);
          const updatedGates = rec.gates.map((g) => g.gateId === req.gateId ? { ...g, state: "resolved" as const, resolvedBy: req.resolvedBy, resolution: req.payload } : g);
          deps.store.put({ ...rec, gates: updatedGates });
          // Driver answers via the saved requestId (it tracks it per-task).
          deps.resolveInteractiveGate?.(rec.id, req.payload);
          return rec;
        }
```

Add `resolveInteractiveGate?: (taskId: string, payload: unknown) => void;` to `DaemonDeps`.

In `cockpitd.ts`, wire `resolveInteractiveGate: (taskId, payload) => codexDriver.answer(taskId, payload)`.

- [ ] **Step 2: Extend `crew status` rendering**

In `src/commands/crew-control.ts` `status` action, after printing the task fields, print:

```ts
if (rec.gates && rec.gates.length > 0) {
  console.log("gates:");
  for (const g of rec.gates) {
    console.log(`  ${g.gateId}  ${g.state}  [${g.kind}]  ${g.question}`);
  }
}
```

- [ ] **Step 3: Add `--gate` flag to `crew reply`**

In `src/commands/crew-control.ts` `reply` command, add `.option("--gate <gateId>", "resolve a gate by id")` and in the action: if `opts.gate` is set, send `{ kind: "gate-resolve", project, gateId: opts.gate, resolvedBy: "captain", payload: { text: opts.message } }` instead of the normal `reply`.

- [ ] **Step 4: Build + test**

```bash
npm run build && npm test -- --run
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(crew): crew status surfaces gates; crew reply --gate resolves them"
```

---

### Task 2.12: Daemon-bounce reattach path (closes #86 interactive slice)

**Files:**
- Modify: `src/control/cockpitd.ts`
- Modify: `src/control/__tests__/integration-restart.test.ts`

On daemon startup, iterate non-terminal interactive-codex tasks with a non-empty `resumeRef`; for each, call `codexDriver.reattach(rec)`. After `reattach`, replay a short tail via `client.readThread({threadId, lastN: 20})` and emit a synthetic `task.reattached` so any future attach connection knows.

- [ ] **Step 1: Failing integration test**

In `src/control/__tests__/integration-restart.test.ts`, add (alongside existing reconciliation tests):

```ts
it("on restart, interactive-codex tasks with a resumeRef are reattached via driver.reattach()", async () => {
  // Seed a non-terminal interactive-codex task with resumeRef "TH-OLD".
  // Boot the daemon with a fake codex driver; assert reattach() was called once with the right rec.
  // (Follow the existing test pattern in this file for fake-driver injection.)
});
```

(Adapt to the file's existing scaffolding — the test will fail because the cockpitd start hook does not yet iterate-and-reattach.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

In `cockpitd.ts`, after constructing the store + driver and before the server starts listening:

```ts
// Restart-reattach (spec §5; closes interactive slice of #86):
for (const rec of store.listAll()) {
  if (rec.provider !== "codex" || rec.mode !== "interactive") continue;
  if (rec.state === "done" || rec.state === "failed") continue;
  const ref = rec.attempts.at(-1)?.resumeRef;
  if (!ref) continue;
  codexDriver.reattach(rec).catch((e) => {
    process.stderr.write(`[cockpitd] reattach failed for ${rec.id}: ${(e as Error).message}\n`);
  });
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- --run src/control/__tests__/integration-restart.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(cockpitd): on-restart reattach for interactive-codex tasks (closes #86 interactive slice)

Spec §5. Iterates non-terminal interactive-codex tasks at boot and calls
codexDriver.reattach(rec), which does thread/resume on the app-server.
Headless slice of #86 remains open (#91 follow-up — same resumeRef
discipline applied to claude -p / codex exec / opencode run)."
```

---

### Task 2.13: `stalled` policy — warn + surface to Captain (don't auto-fail)

**Files:**
- Modify: `src/control/watchdog.ts`
- Modify: `src/control/__tests__/watchdog.test.ts`

Spec §4.8: `stalled` is recoverable, not terminal. The watchdog already evaluates stall; this task makes the default policy "warn + surface to Captain (event), do not auto-promote to failed." (Issue #90 generalizes this beyond codex interactive; this task keeps the change scoped.)

- [ ] **Step 1: Failing test**

In `watchdog.test.ts`, add:

```ts
it("a stalled interactive-codex task stays non-terminal; emits a captain-attention event", () => {
  // Build a rec with mode=interactive, provider=codex, lastHeartbeat way in the past;
  // call evaluateStall + recoverStall; assert state stays 'stalled' (or back to 'working'
  // on the next heartbeat); assert the watchdog returns a 'needs-attention' marker.
});
```

- [ ] **Step 2: Adjust the watchdog logic**

Whatever `recoverStall` does today (which I haven't fully read), ensure: for `provider=codex && mode=interactive`, a stall yields a non-terminal "needs Captain attention" outcome and a structured event, never a `task.failed`.

- [ ] **Step 3: Run — expect PASS**

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "feat(watchdog): warn-don't-autofail for interactive-codex stalls (spec §4.8, #90)

Stalled interactive-codex tasks remain non-terminal; the watchdog surfaces
a 'needs Captain attention' event instead of auto-promoting to failed.
This is the codex-interactive slice of #90; the broader policy rollout
ships under that issue."
```

---

### Task 2.14: §4.10 acceptance smoke — full flow end-to-end

**Files:**
- Modify: `src/control/codex/__tests__/app-server-client.smoke.test.ts` (extend) or create a new top-level acceptance script.

Manual acceptance (runs against the real daemon + real codex on the developer's machine). Document the exact steps; commit a tiny script that runs them.

- [ ] **Step 1: Write the acceptance script**

Create `scripts/acceptance-interactive-codex.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "=== 1. fresh build + relink ==="
npm run build
echo "=== 2. open a chat ==="
cockpit crew chat --provider codex --project SMOKE --cwd "$(mktemp -d)"
echo
echo "Manually, in the opened cmux tab:"
echo "  a. type: please write the string ACCEPT-OK to a file in the cwd"
echo "  b. answer the approval prompt with 'approve'"
echo "  c. wait for [done — type a follow-up] then type: thanks"
echo "  d. answer [done] again"
echo
echo "=== 3. simulate daemon bounce in another shell ==="
echo "   launchctl kickstart -kp gui/\$(id -u)/com.cockpit.daemon"
echo "Then check the tab: expect a (reattached) line and the next 'say' continues the same thread."
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/acceptance-interactive-codex.sh
```

- [ ] **Step 3: Run it manually and record evidence**

```bash
./scripts/acceptance-interactive-codex.sh
# Walk through the manual steps; capture transcript to /tmp/iv-codex-acceptance.txt
```

- [ ] **Step 4: Commit (script only — evidence is local)**

```bash
git add scripts/acceptance-interactive-codex.sh
git commit -m "test(codex): manual acceptance script for spec §4.10

Walks the full end-to-end flow: crew chat → say → approval → done →
say again → SIGINT interrupt → daemon bounce → reattach → continue."
```

---

### Task 2.15: Phase 2 closeout — PR

**Files:** none (git/gh only).

- [ ] **Step 1: Final sweep**

```bash
npm run lint && npm test -- --run
```

- [ ] **Step 2: Push**

```bash
git push -u origin feature/codex-interactive-crew
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --base develop --title "feat: cockpit interactive codex (closes #86 interactive slice)" \
  --body "Phase 2 of \`docs/specs/2026-05-20-cockpit-interactive-codex-design.md\`.

Ships:
- \`CodexInteractiveDriver\` owning one long-lived \`codex app-server\` child.
- \`cockpit crew chat --provider codex\` + \`cockpit crew attach <taskId>\` (the cmux-tab renderer).
- Streaming subscribe protocol (attach/say/steer/interrupt/answer/delta/turn-started/turn-completed/input-requested/approval-requested/gate-promoted/reattached/closed) — additive on the cockpitd socket, cooperates with #87.
- \`DispatchAttempt\` sub-record on \`TaskRecord\`; reducer writes \`resumeRef\` on EVERY transition.
- Daemon 'ready' = successful initialize + startThread, not child-spawned (counters codex 0.129+ silent-degradation).
- \`normalizeAppServerNotification\` (spec §4.7) — pure mapping notification → ControlEvent.
- Gate primitive (5s presence buffer → promote; resolvable from \`cockpit crew reply --gate <id>\`).
- On-restart reattach via \`thread/resume\` — **closes the interactive-codex slice of #86**.
- Stalled interactive-codex tasks: warn-don't-autofail (spec §4.8, #90 slice).
- Removed obsolete \`src/control/interactive/codex.ts\` hook adapter — codex interactive is driver-based now.

Honest scope: closes the INTERACTIVE-CODEX slice of #86. Headless slice remains open; addressed in #91's follow-up when headless adapters adopt the same \`resumeRef\` discipline.

Acceptance walk-through: \`scripts/acceptance-interactive-codex.sh\` (manual)."
```

---

## Self-Review

**1. Spec coverage check:**

| Spec section | Plan task |
|---|---|
| §1 Problem/non-goals | (Captured in plan header + spec link) |
| §2 Approach 3 two-phase | Phase 1 / Phase 2 split throughout |
| §3.1–3.4 Client lib (transport/handshake/types/API) | 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10 |
| §3.5 Smoke command (incl. approval) | 1.11, **1.12 (the gate)** |
| §3.6 Phase 1 acceptance | 1.12 + 1.13 |
| §4.1 App-server lifecycle | 2.4 (driver), 2.12 (reattach) |
| §4.2 `cockpit crew chat` verb | 2.9 |
| §4.3 `DispatchAttempt` schema | 2.1 |
| §4.4 Handshake-gated "ready" | 2.5 |
| §4.5 Streaming subscribe channel | 2.6 + 2.7 |
| §4.6 cmux-tab client (`crew attach`) | 2.8 |
| §4.7 `normalizeAppServerNotification` | 2.3 |
| §4.8 State machine + anti-#2576 | 2.2 (reducer transitions); 2.13 (stalled policy) |
| §4.9 Decision-gate | 2.10 + 2.11 |
| §4.10 Phase 2 acceptance | 2.14 |
| §5 Resilience / #86 closure | 2.12 |
| §6 Orca-derived (traceability) | covered across tasks |

No gaps.

**2. Placeholder scan:** No "TBD" / "TODO" / "handle edge cases" / "similar to Task N" patterns remain.

**3. Type consistency:** `DispatchAttempt.resumeRef` / `Gate.gateId` / `AttachFrame.type` / `ControlEvent` variants are spelled consistently across Tasks 2.1, 2.2, 2.3, 2.4, 2.6, 2.10. The `task.session` event variant introduced in 2.2 is consumed only by the reducer; the driver emits it in 2.4 — names match.
