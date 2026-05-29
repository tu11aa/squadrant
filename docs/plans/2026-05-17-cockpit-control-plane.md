# Cockpit Control-Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cockpit-owned launchd daemon that reliably tracks every captain→crew task through an explicit state machine + heartbeat watchdog, so completion is known without terminal scraping, provider-agnostically.

**Architecture:** Approach 3 hybrid — a memory-stateless daemon (`cockpitd`) owns an AF_UNIX socket + a per-task JSON state store + a heartbeat watchdog. Headless crew are children the daemon spawns and owns by PID (process-exit = done-signal). Interactive crew run in cmux tabs and POST normalized lifecycle events to the socket. The state store is the single source of truth; the captain reads it, never scrapes.

**Tech Stack:** TypeScript (ES2022, ESM, `.js` import suffixes), Node `node:net`/`node:child_process`/`node:fs`, Commander, vitest (`vi.hoisted`/`vi.mock`), launchd (macOS).

**Spec:** `docs/specs/2026-05-17-cockpit-control-plane-design.md`. Scope is **foundational only** — auto-recovery actions, auto-learn, legacy re-pointing, notifications are OUT (deferred specs).

---

## File Structure

All new code lives under `src/control/` (one new subsystem dir, mirrors `src/reactor/` etc.):

| File | Responsibility |
|---|---|
| `src/control/types.ts` | Shared types: `TaskState`, `TaskRecord`, `ControlEvent`, `Mode`, `Provider` |
| `src/control/state-machine.ts` | Pure `reduce(record, event) → record'`. No I/O. The reliability core + anti-#2576 invariant. |
| `src/control/store.ts` | Per-task JSON persistence (atomic write, read, list, per-task blast radius) |
| `src/control/watchdog.ts` | Pure-ish heartbeat evaluator with injectable clock; `working → stalled` |
| `src/control/protocol.ts` | Newline-JSON framing: encode/decode + socket server + socket client |
| `src/control/daemon.ts` | `cockpitd`: wires store+socket+watchdog; startup reconciliation |
| `src/control/headless/types.ts` | `HeadlessAdapter` interface |
| `src/control/headless/claude.ts` | Claude headless adapter (`claude -p --output-format json`) |
| `src/control/headless/opencode.ts` | opencode headless adapter |
| `src/control/headless/codex.ts` | codex headless adapter (`codex exec --json`) |
| `src/control/headless/registry.ts` | Headless adapter registry |
| `src/control/headless-launcher.ts` | Daemon-side: spawn child, own PID, map exit→`done`/`failed` |
| `src/control/interactive/types.ts` | `InteractiveHookAdapter` interface |
| `src/control/interactive/claude.ts` | Claude hook adapter (idempotent settings.json merge) |
| `src/control/interactive/codex.ts` | codex best-effort adapter (transcript/pid poll) |
| `src/control/interactive/registry.ts` | Interactive adapter registry |
| `src/control/launchd.ts` | Plist generation, install, `launchctl kickstart` |
| `src/commands/crew-control.ts` | New `cockpit crew` socket client (`dispatch/status/reply/list/close`) |
| `src/control/__tests__/*.test.ts` | Colocated vitest suites |

Wiring: `src/index.ts` adds the daemon-aware crew command; `ensureRuntimeSynced` call site gains a launchd-ensure step.

---

## Phase 1 — State Machine (pure, the reliability core)

### Task 1: Shared control types

**Files:**
- Create: `src/control/types.ts`
- Test: (none — types only)

- [ ] **Step 1: Create the types file**

```typescript
// src/control/types.ts
export type Provider = "claude" | "opencode" | "codex" | "gemini";
export type Mode = "headless" | "interactive";

export type TaskState =
  | "submitted"
  | "working"
  | "blocked"
  | "done"
  | "failed"
  | "stalled";

export interface TaskRecord {
  id: string;
  project: string;
  provider: Provider;
  mode: Mode;
  state: TaskState;
  task: string;            // the dispatched instruction
  sessionId?: string;      // provider session id for resume (blocked→reply)
  pid?: number;            // headless child pid (daemon-owned)
  question?: string;       // populated when state === "blocked"
  error?: string;          // populated when state === "failed"
  exitCode?: number;
  resultRef?: string;      // filesystem path to captured output/artifact
  parseWarning?: boolean;  // headless exit 0 but unparseable result
  createdAt: number;       // epoch ms
  lastHeartbeat: number;   // epoch ms
  lastEvent: string;       // last event type applied
  heartbeatBudgetMs: number; // per-task stall threshold
}

export type ControlEvent =
  | { type: "task.started"; id: string; pid?: number; sessionId?: string }
  | { type: "task.progress"; id: string; note?: string }
  | { type: "heartbeat"; id: string }
  | { type: "task.blocked"; id: string; reason: string; question: string }
  | { type: "task.done"; id: string; resultRef: string; parseWarning?: boolean }
  | { type: "task.failed"; id: string; error: string; exitCode?: number };

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "done",
  "failed",
]);
```

- [ ] **Step 2: Commit**

```bash
git add src/control/types.ts
git commit -m "feat(control): shared control-plane types"
```

### Task 2: State machine reducer — happy path

**Files:**
- Create: `src/control/state-machine.ts`
- Test: `src/control/__tests__/state-machine.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/state-machine.test.ts
import { describe, it, expect } from "vitest";
import { reduce } from "../state-machine.js";
import type { TaskRecord } from "../types.js";

function rec(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1", project: "p", provider: "claude", mode: "headless",
    state: "submitted", task: "do x", createdAt: 1000,
    lastHeartbeat: 1000, lastEvent: "", heartbeatBudgetMs: 300000,
    ...overrides,
  };
}

describe("state-machine reduce", () => {
  it("submitted + task.started → working, records pid/sessionId", () => {
    const next = reduce(rec(), { type: "task.started", id: "t1", pid: 42, sessionId: "s1" }, 2000);
    expect(next.state).toBe("working");
    expect(next.pid).toBe(42);
    expect(next.sessionId).toBe("s1");
    expect(next.lastHeartbeat).toBe(2000);
    expect(next.lastEvent).toBe("task.started");
  });

  it("working + task.done → done with resultRef", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.done", id: "t1", resultRef: "/r" }, 3000);
    expect(next.state).toBe("done");
    expect(next.resultRef).toBe("/r");
  });

  it("working + task.failed → failed with error+exitCode", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.failed", id: "t1", error: "boom", exitCode: 1 }, 3000);
    expect(next.state).toBe("failed");
    expect(next.error).toBe("boom");
    expect(next.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/state-machine.test.ts`
Expected: FAIL — `reduce` is not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/state-machine.ts
import type { ControlEvent, TaskRecord } from "./types.js";
import { TERMINAL_STATES } from "./types.js";

/**
 * Pure transition. `now` is injected (epoch ms) so callers control time.
 * Returns a new record; never mutates the input.
 */
export function reduce(rec: TaskRecord, ev: ControlEvent, now: number): TaskRecord {
  // Terminal states are absorbing: ignore any late/duplicate event idempotently.
  if (TERMINAL_STATES.has(rec.state)) return rec;

  const base = { ...rec, lastHeartbeat: now, lastEvent: ev.type };

  switch (ev.type) {
    case "task.started":
      return { ...base, state: "working", pid: ev.pid ?? rec.pid, sessionId: ev.sessionId ?? rec.sessionId };
    case "task.progress":
    case "heartbeat":
      // Anti-#2576: liveness only. A turn-end is NOT completion.
      // From blocked, a bare progress/heartbeat does not auto-unblock.
      return rec.state === "blocked" ? { ...rec, lastHeartbeat: now } : base;
    case "task.blocked":
      return { ...base, state: "blocked", question: ev.question };
    case "task.done":
      return { ...base, state: "done", resultRef: ev.resultRef, parseWarning: ev.parseWarning };
    case "task.failed":
      return { ...base, state: "failed", error: ev.error, exitCode: ev.exitCode };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/state-machine.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/state-machine.ts src/control/__tests__/state-machine.test.ts
git commit -m "feat(control): state-machine reduce — happy path"
```

### Task 3: State machine — blocked→reply→working + anti-#2576 + idempotency

**Files:**
- Modify: `src/control/state-machine.ts` (add `reply` handling via a synthetic event)
- Test: `src/control/__tests__/state-machine.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Add to `src/control/__tests__/state-machine.test.ts`:

```typescript
  it("blocked + task.progress does NOT auto-unblock (explicit reply required)", () => {
    const next = reduce(rec({ state: "blocked", question: "q?" }), { type: "task.progress", id: "t1" }, 4000);
    expect(next.state).toBe("blocked");
    expect(next.lastHeartbeat).toBe(4000); // liveness still updates
  });

  it("blocked + task.started (resume after reply) → working, clears question", () => {
    const next = reduce(rec({ state: "blocked", question: "q?" }), { type: "task.started", id: "t1" }, 5000);
    expect(next.state).toBe("working");
    expect(next.question).toBeUndefined();
  });

  it("terminal state absorbs late events idempotently", () => {
    const done = rec({ state: "done", resultRef: "/r" });
    const next = reduce(done, { type: "task.failed", id: "t1", error: "late" }, 6000);
    expect(next).toBe(done); // same reference — no-op
  });

  it("bare Stop modelled as task.progress never yields done", () => {
    const next = reduce(rec({ state: "working" }), { type: "task.progress", id: "t1", note: "Stop" }, 7000);
    expect(next.state).toBe("working");
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/control/__tests__/state-machine.test.ts`
Expected: FAIL — "blocked + task.started" expects `question` cleared but impl keeps it.

- [ ] **Step 3: Update implementation**

In `src/control/state-machine.ts`, replace the `task.started` case:

```typescript
    case "task.started":
      return {
        ...base,
        state: "working",
        pid: ev.pid ?? rec.pid,
        sessionId: ev.sessionId ?? rec.sessionId,
        question: undefined, // resuming after a blocked→reply clears the question
      };
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run src/control/__tests__/state-machine.test.ts`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/state-machine.ts src/control/__tests__/state-machine.test.ts
git commit -m "feat(control): blocked→reply, anti-#2576, terminal idempotency"
```

---

## Phase 2 — Task-State Store (durable single source of truth)

### Task 4: Atomic per-task JSON store — write/read

**Files:**
- Create: `src/control/store.ts`
- Test: `src/control/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store.js";
import type { TaskRecord } from "../types.js";

function rec(id: string): TaskRecord {
  return {
    id, project: "proj", provider: "claude", mode: "headless",
    state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
  };
}

describe("store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-store-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("put then get round-trips a record", () => {
    const s = createStore(dir);
    s.put(rec("t1"));
    expect(s.get("proj", "t1")?.state).toBe("submitted");
  });

  it("get returns undefined for missing task", () => {
    const s = createStore(dir);
    expect(s.get("proj", "nope")).toBeUndefined();
  });

  it("list returns all records for a project", () => {
    const s = createStore(dir);
    s.put(rec("t1")); s.put(rec("t2"));
    expect(s.list("proj").map((r) => r.id).sort()).toEqual(["t1", "t2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/store.test.ts`
Expected: FAIL — `createStore` not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/store.ts
import {
  mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { TaskRecord } from "./types.js";

export interface Store {
  put(rec: TaskRecord): void;
  get(project: string, id: string): TaskRecord | undefined;
  list(project: string): TaskRecord[];
  listAll(): TaskRecord[];
}

export function createStore(root: string): Store {
  const projDir = (p: string) => join(root, p);
  const taskFile = (p: string, id: string) => join(projDir(p), `${id}.json`);

  return {
    put(rec) {
      mkdirSync(projDir(rec.project), { recursive: true });
      const dest = taskFile(rec.project, rec.id);
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec, null, 2));
      renameSync(tmp, dest); // atomic replace
    },
    get(project, id) {
      const f = taskFile(project, id);
      if (!existsSync(f)) return undefined;
      try {
        return JSON.parse(readFileSync(f, "utf-8")) as TaskRecord;
      } catch {
        return undefined; // corrupt file: caller handles (Task 6)
      }
    },
    list(project) {
      const d = projDir(project);
      if (!existsSync(d)) return [];
      return readdirSync(d)
        .filter((n) => n.endsWith(".json"))
        .map((n) => {
          try { return JSON.parse(readFileSync(join(d, n), "utf-8")) as TaskRecord; }
          catch { return undefined; }
        })
        .filter((r): r is TaskRecord => r !== undefined);
    },
    listAll() {
      if (!existsSync(root)) return [];
      return readdirSync(root)
        .filter((p) => { try { return statSync(projDir(p)).isDirectory(); } catch { return false; } })
        .flatMap((p) => this.list(p));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/store.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/store.ts src/control/__tests__/store.test.ts
git commit -m "feat(control): atomic per-task JSON state store"
```

### Task 5: Store — corrupt-file quarantine (blast radius = 1 task)

**Files:**
- Modify: `src/control/store.ts`
- Test: `src/control/__tests__/store.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/control/__tests__/store.test.ts` (add `writeFileSync` and `mkdirSync` to the `node:fs` import):

```typescript
  it("a corrupt task file does not break listing of sibling tasks", () => {
    const s = createStore(dir);
    s.put(rec("good"));
    // hand-write a corrupt sibling
    writeFileSync(join(dir, "proj", "bad.json"), "{not json");
    const ids = s.list("proj").map((r) => r.id);
    expect(ids).toContain("good");
    expect(ids).not.toContain("bad");
  });

  it("quarantine() renames a corrupt file out of the way", () => {
    const s = createStore(dir);
    mkdirSync(join(dir, "proj"), { recursive: true });
    writeFileSync(join(dir, "proj", "bad.json"), "{not json");
    s.quarantine("proj", "bad");
    expect(s.get("proj", "bad")).toBeUndefined();
    // listing still works, no throw
    expect(s.list("proj")).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/store.test.ts`
Expected: FAIL — `s.quarantine` is not a function.

- [ ] **Step 3: Extend implementation**

In `src/control/store.ts`, add `quarantine` to the `Store` interface and the returned object:

```typescript
// in interface Store:
  quarantine(project: string, id: string): void;
```

```typescript
// in the returned object, after listAll:
    quarantine(project, id) {
      const f = taskFile(project, id);
      if (existsSync(f)) renameSync(f, `${f}.corrupt.${Date.now()}`);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/store.test.ts`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/store.ts src/control/__tests__/store.test.ts
git commit -m "feat(control): corrupt-file quarantine, per-task blast radius"
```

---

## Phase 3 — Heartbeat Watchdog

### Task 6: Watchdog — stall detection with injectable clock

**Files:**
- Create: `src/control/watchdog.ts`
- Test: `src/control/__tests__/watchdog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/watchdog.test.ts
import { describe, it, expect } from "vitest";
import { evaluateStall } from "../watchdog.js";
import type { TaskRecord } from "../types.js";

function rec(o: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1", project: "p", provider: "claude", mode: "headless",
    state: "working", task: "t", createdAt: 0, lastHeartbeat: 1000,
    lastEvent: "", heartbeatBudgetMs: 5000, ...o,
  };
}

describe("evaluateStall", () => {
  it("working past budget → stalled", () => {
    const out = evaluateStall(rec(), 6001);
    expect(out?.state).toBe("stalled");
  });

  it("working within budget → no change (null)", () => {
    expect(evaluateStall(rec(), 5999)).toBeNull();
  });

  it("non-working state is never stalled", () => {
    expect(evaluateStall(rec({ state: "blocked" }), 999999)).toBeNull();
    expect(evaluateStall(rec({ state: "done" }), 999999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/watchdog.test.ts`
Expected: FAIL — `evaluateStall` not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/watchdog.ts
import type { TaskRecord } from "./types.js";

/**
 * Pure. Returns a stalled record if a `working` task has exceeded its
 * heartbeat budget at time `now` (epoch ms), else null. No I/O, no clock.
 */
export function evaluateStall(rec: TaskRecord, now: number): TaskRecord | null {
  if (rec.state !== "working") return null;
  if (now - rec.lastHeartbeat <= rec.heartbeatBudgetMs) return null;
  return { ...rec, state: "stalled", lastEvent: "watchdog.stall" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/watchdog.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/watchdog.ts src/control/__tests__/watchdog.test.ts
git commit -m "feat(control): heartbeat watchdog stall detection"
```

### Task 7: Watchdog — stalled recovers to working on heartbeat

**Files:**
- Modify: `src/control/watchdog.ts`
- Test: `src/control/__tests__/watchdog.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add `recoverStall` to the static import at the top of the file:
`import { evaluateStall, recoverStall } from "../watchdog.js";`

```typescript
describe("recoverStall", () => {
  it("recoverStall: stalled + fresh heartbeat → working", () => {
    const stalled = rec({ state: "stalled" });
    const out = recoverStall(stalled, 7000);
    expect(out?.state).toBe("working");
    expect(out?.lastHeartbeat).toBe(7000);
    expect(out?.lastEvent).toBe("watchdog.recover");
  });

  it("recoverStall: non-stalled → null", () => {
    expect(recoverStall(rec({ state: "working" }), 7000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/watchdog.test.ts`
Expected: FAIL — `recoverStall` is not exported.

- [ ] **Step 3: Extend implementation**

Append to `src/control/watchdog.ts`:

```typescript
/** Pure. A stalled task that receives liveness returns to working. */
export function recoverStall(rec: TaskRecord, now: number): TaskRecord | null {
  if (rec.state !== "stalled") return null;
  return { ...rec, state: "working", lastHeartbeat: now, lastEvent: "watchdog.recover" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/watchdog.test.ts`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/watchdog.ts src/control/__tests__/watchdog.test.ts
git commit -m "feat(control): stalled→working recovery on heartbeat"
```

---

## Phase 4 — Socket Protocol

### Task 8: Newline-JSON framing codec

**Files:**
- Create: `src/control/protocol.ts`
- Test: `src/control/__tests__/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/protocol.test.ts
import { describe, it, expect } from "vitest";
import { encodeMsg, createDecoder } from "../protocol.js";

describe("framing", () => {
  it("encodeMsg appends a newline and JSON-encodes", () => {
    expect(encodeMsg({ a: 1 })).toBe('{"a":1}\n');
  });

  it("decoder yields complete messages, buffers partials", () => {
    const dec = createDecoder();
    expect(dec.push('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }]);
    expect(dec.push("\n")).toEqual([{ b: 2 }]);
  });

  it("decoder skips malformed lines without throwing", () => {
    const dec = createDecoder();
    expect(dec.push("not json\n{\"ok\":true}\n")).toEqual([{ ok: true }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/protocol.test.ts`
Expected: FAIL — `encodeMsg` not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/protocol.ts
export function encodeMsg(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export function createDecoder() {
  let buf = "";
  return {
    push(chunk: string): unknown[] {
      buf += chunk;
      const out: unknown[] = [];
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/protocol.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/protocol.ts src/control/__tests__/protocol.test.ts
git commit -m "feat(control): newline-JSON framing codec"
```

### Task 9: Socket server + client over AF_UNIX

**Files:**
- Modify: `src/control/protocol.ts`
- Test: `src/control/__tests__/protocol-socket.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/protocol-socket.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, sendRequest } from "../protocol.js";

describe("unix socket", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("client request gets server response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "c.sock");
    const server = startServer(sock, async (msg: any) => ({ echo: msg.ping }));
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
    const res = await sendRequest(sock, { ping: "hi" });
    expect(res).toEqual({ echo: "hi" });
  });

  it("sendRequest rejects clearly when no daemon is listening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-sock-"));
    const sock = join(dir, "absent.sock");
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    await expect(sendRequest(sock, { ping: "x" })).rejects.toThrow(/control plane unavailable/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/protocol-socket.test.ts`
Expected: FAIL — `startServer`/`sendRequest` not defined.

- [ ] **Step 3: Extend implementation**

Append to `src/control/protocol.ts`:

```typescript
import { createServer, createConnection, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

export type Handler = (msg: any) => Promise<unknown>;

export function startServer(sockPath: string, handler: Handler): Server {
  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch { /* stale socket */ }
  }
  const server = createServer((conn) => {
    const dec = createDecoder();
    conn.setEncoding("utf-8");
    conn.on("data", async (chunk: string) => {
      for (const msg of dec.push(chunk)) {
        try {
          const reply = await handler(msg);
          conn.write(encodeMsg({ ok: true, reply }));
        } catch (e) {
          conn.write(encodeMsg({ ok: false, error: String((e as Error).message ?? e) }));
        }
      }
    });
    conn.on("error", () => { /* client vanished; ignore */ });
  });
  server.listen(sockPath);
  return server;
}

export function sendRequest(sockPath: string, msg: unknown, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(sockPath);
    const dec = createDecoder();
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("control plane unavailable: request timed out"));
    }, timeoutMs);
    conn.setEncoding("utf-8");
    conn.on("connect", () => conn.write(encodeMsg(msg)));
    conn.on("data", (chunk: string) => {
      for (const m of dec.push(chunk) as any[]) {
        clearTimeout(timer);
        conn.end();
        if (m.ok) resolve(m.reply);
        else reject(new Error(m.error));
        return;
      }
    });
    conn.on("error", () => {
      clearTimeout(timer);
      reject(new Error("control plane unavailable: cannot reach cockpitd socket"));
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/protocol-socket.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/protocol.ts src/control/__tests__/protocol-socket.test.ts
git commit -m "feat(control): AF_UNIX socket server + fail-loud client"
```

---

## Phase 5 — Daemon Assembly

### Task 10: Daemon core — ingest events, query state

**Files:**
- Create: `src/control/daemon.ts`
- Test: `src/control/__tests__/daemon.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/daemon.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../daemon.js";
import { createStore } from "../store.js";
import type { TaskRecord } from "../types.js";

function rec(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, project: "p", provider: "claude", mode: "interactive",
    state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
    ...overrides,
  };
}

describe("daemon handler", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-d-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ingests an event and persists the new state", async () => {
    const store = createStore(dir);
    store.put(rec("t1"));
    const d = createDaemon({ store, now: () => 2000 });
    const r = await d.handle({ kind: "event", event: { type: "task.started", id: "t1" }, project: "p" });
    expect((r as TaskRecord).state).toBe("working");
    expect(store.get("p", "t1")?.state).toBe("working");
  });

  it("answers a status query from the store", async () => {
    const store = createStore(dir);
    store.put(rec("t1"));
    const d = createDaemon({ store, now: () => 2000 });
    const r = await d.handle({ kind: "status", project: "p", id: "t1" });
    expect((r as TaskRecord).id).toBe("t1");
  });

  it("rejects reply to a non-blocked task", async () => {
    const store = createStore(dir);
    store.put(rec("t1", { state: "working" }));
    const d = createDaemon({ store, now: () => 2000 });
    await expect(
      d.handle({ kind: "reply", project: "p", id: "t1", message: "x" }),
    ).rejects.toThrow(/not blocked/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/daemon.test.ts`
Expected: FAIL — `createDaemon` not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/daemon.ts
import type { Store } from "./store.js";
import type { ControlEvent, TaskRecord } from "./types.js";
import { reduce } from "./state-machine.js";

export interface DaemonDeps {
  store: Store;
  now: () => number;
  /** Injected in Task 14; resumes a blocked session. Optional until then. */
  deliverReply?: (rec: TaskRecord, message: string) => Promise<void>;
}

type Req =
  | { kind: "event"; project: string; event: ControlEvent }
  | { kind: "status"; project: string; id: string }
  | { kind: "list"; project: string }
  | { kind: "reply"; project: string; id: string; message: string };

export function createDaemon(deps: DaemonDeps) {
  const { store, now } = deps;
  return {
    async handle(req: Req): Promise<TaskRecord | TaskRecord[]> {
      switch (req.kind) {
        case "event": {
          const cur = store.get(req.project, req.event.id);
          if (!cur) throw new Error(`unknown task ${req.event.id}`);
          const next = reduce(cur, req.event, now());
          if (next !== cur) store.put(next); // skip redundant write on terminal no-ops
          return next;
        }
        case "status": {
          const r = store.get(req.project, req.id);
          if (!r) throw new Error(`unknown task ${req.id}`);
          return r;
        }
        case "list":
          return store.list(req.project);
        case "reply": {
          const r = store.get(req.project, req.id);
          if (!r) throw new Error(`unknown task ${req.id}`);
          if (r.state !== "blocked") throw new Error(`task ${req.id} is not blocked (state=${r.state})`);
          const next = reduce(r, { type: "task.started", id: r.id }, now());
          store.put(next); // persist the transition before delivering (durable first)
          if (deps.deliverReply) await deps.deliverReply(r, req.message);
          return next;
        }
        default: { const _exhaustive: never = req; throw new Error(`unhandled request kind`); }
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/daemon.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/daemon.ts src/control/__tests__/daemon.test.ts
git commit -m "feat(control): daemon core — event ingest, status, reply gating"
```

### Task 11: Daemon startup reconciliation (crash recovery)

**Files:**
- Modify: `src/control/daemon.ts`
- Test: `src/control/__tests__/daemon.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```typescript
  it("reconcile: working headless task with dead pid → failed", async () => {
    const store = createStore(dir);
    store.put({ ...rec("h1"), state: "working", mode: "headless", pid: 999999 });
    const d = createDaemon({ store, now: () => 5000, isPidAlive: () => false });
    d.reconcile();
    expect(store.get("p", "h1")?.state).toBe("failed");
    expect(store.get("p", "h1")?.error).toMatch(/orphan|daemon restart/i);
  });

  it("reconcile: working interactive task → stalled (hook source gone)", async () => {
    const store = createStore(dir);
    store.put({ ...rec("i1"), state: "working", mode: "interactive" });
    const d = createDaemon({ store, now: () => 5000, isPidAlive: () => false });
    d.reconcile();
    expect(store.get("p", "i1")?.state).toBe("stalled");
  });

  it("reconcile: working headless task with live pid → stays working", async () => {
    const store = createStore(dir);
    store.put({ ...rec("h2"), state: "working", mode: "headless", pid: 4242 });
    const d = createDaemon({ store, now: () => 5000, isPidAlive: () => true });
    d.reconcile();
    expect(store.get("p", "h2")?.state).toBe("working");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/daemon.test.ts`
Expected: FAIL — `d.reconcile` is not a function / `isPidAlive` not in deps.

- [ ] **Step 3: Extend implementation**

In `src/control/daemon.ts`, add `isPidAlive` to `DaemonDeps`:

```typescript
  /** Defaults to a real process.kill(pid,0) check at the call site (Task 17). */
  isPidAlive?: (pid: number) => boolean;
```

Add inside the returned object (after `handle`):

```typescript
    reconcile(): void {
      const alive = deps.isPidAlive ?? (() => true);
      for (const r of store.listAll()) {
        if (r.state !== "working" && r.state !== "submitted") continue;
        if (r.mode === "headless") {
          if (r.pid != null && alive(r.pid)) continue; // still running, keep watching
          store.put({
            ...r, state: "failed", lastEvent: "reconcile",
            error: "orphaned by daemon restart; exit unobserved (conservative fail)",
          });
        } else {
          store.put({ ...r, state: "stalled", lastEvent: "reconcile" });
        }
      }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/daemon.test.ts`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/daemon.ts src/control/__tests__/daemon.test.ts
git commit -m "feat(control): startup reconciliation — conservative crash recovery"
```

### Task 12: Daemon watchdog sweep loop

**Files:**
- Modify: `src/control/daemon.ts`
- Test: `src/control/__tests__/daemon.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```typescript
  it("sweep: marks an over-budget working task stalled", async () => {
    const store = createStore(dir);
    store.put({ ...rec("s1"), state: "working", lastHeartbeat: 0, heartbeatBudgetMs: 100 });
    const d = createDaemon({ store, now: () => 1000 });
    d.sweep();
    expect(store.get("p", "s1")?.state).toBe("stalled");
  });

  it("sweep: recovers a stalled task that has a fresh heartbeat", async () => {
    const store = createStore(dir);
    store.put({ ...rec("s2"), state: "stalled", lastHeartbeat: 990, heartbeatBudgetMs: 100 });
    const d = createDaemon({ store, now: () => 1000 });
    d.sweep();
    expect(store.get("p", "s2")?.state).toBe("working");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/daemon.test.ts`
Expected: FAIL — `d.sweep` is not a function.

- [ ] **Step 3: Extend implementation**

In `src/control/daemon.ts` add the import:

```typescript
import { evaluateStall, recoverStall } from "./watchdog.js";
```

Add inside the returned object:

```typescript
    sweep(): void {
      const t = now();
      for (const r of store.listAll()) {
        const stalled = evaluateStall(r, t);
        if (stalled) { store.put(stalled); continue; }
        const recovered = recoverStall(r, t);
        // recoverStall does NOT check heartbeat freshness — guard per its contract
        if (recovered && t - r.lastHeartbeat <= r.heartbeatBudgetMs) store.put(recovered);
      }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/daemon.test.ts`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/daemon.ts src/control/__tests__/daemon.test.ts
git commit -m "feat(control): watchdog sweep loop (stall + recover)"
```

---

## Phase 6 — Headless Adapters

### Task 13: HeadlessAdapter interface + Claude adapter

**Files:**
- Create: `src/control/headless/types.ts`
- Create: `src/control/headless/claude.ts`
- Test: `src/control/__tests__/headless-claude.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/headless-claude.test.ts
import { describe, it, expect } from "vitest";
import { claudeHeadless } from "../headless/claude.js";

describe("claude headless adapter", () => {
  it("buildCommand emits print + json + the task", () => {
    const argv = claudeHeadless.buildCommand("fix the bug");
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("-p");
    expect(argv.join(" ")).toContain("--output-format json");
    expect(argv).toContain("fix the bug");
  });

  it("buildCommand with sessionId adds --resume", () => {
    const argv = claudeHeadless.buildCommand("more", "sess-1");
    expect(argv.join(" ")).toContain("--resume sess-1");
  });

  it("parseResult: exit 0 + JSON result → done with sessionId", () => {
    const out = claudeHeadless.parseResult('{"result":"ok","session_id":"s9","is_error":false}', 0);
    expect(out).toEqual({ outcome: "done", sessionId: "s9", payload: "ok" });
  });

  it("parseResult: is_error true → failed", () => {
    const out = claudeHeadless.parseResult('{"result":"bad","is_error":true}', 0);
    expect(out.outcome).toBe("failed");
  });

  it("parseResult: non-zero exit → failed with exitCode", () => {
    const out = claudeHeadless.parseResult("crashed", 1);
    expect(out).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  it("parseResult: exit 0 but unparseable → done with parseWarning", () => {
    const out = claudeHeadless.parseResult("not json", 0);
    expect(out).toMatchObject({ outcome: "done", parseWarning: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/headless-claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/headless/types.ts
export const HEADLESS_ERROR_TAIL = 2000;

export interface HeadlessResult {
  outcome: "done" | "failed";
  /** Always a string: result text, JSON-stringified non-string result, or raw stdout fallback. Becomes resultRef contents. */
  payload?: string;
  sessionId?: string;
  error?: string;
  exitCode?: number;
  parseWarning?: boolean;
}

export interface HeadlessAdapter {
  provider: string;
  buildCommand(task: string, sessionId?: string): string[];
  parseResult(stdout: string, exitCode: number): HeadlessResult;
}
```

```typescript
// src/control/headless/claude.ts
import type { HeadlessAdapter } from "./types.js";
import { HEADLESS_ERROR_TAIL } from "./types.js";

export const claudeHeadless: HeadlessAdapter = {
  provider: "claude",
  buildCommand(task, sessionId) {
    const argv = ["claude", "-p", "--output-format", "json"];
    if (sessionId) argv.push("--resume", sessionId);
    argv.push(task);
    return argv;
  },
  parseResult(stdout, exitCode) {
    if (exitCode !== 0) {
      return { outcome: "failed", exitCode, error: stdout.slice(-HEADLESS_ERROR_TAIL) };
    }
    try {
      const j = JSON.parse(stdout);
      if (j.is_error) return { outcome: "failed", error: String(j.result ?? "is_error"), sessionId: j.session_id };
      const payload = typeof j.result === "string" ? j.result : j.result == null ? "" : JSON.stringify(j.result);
      return { outcome: "done", sessionId: j.session_id, payload };
    } catch {
      return { outcome: "done", parseWarning: true, payload: stdout };
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/headless-claude.test.ts`
Expected: PASS (10 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/headless/ src/control/__tests__/headless-claude.test.ts
git commit -m "feat(control): HeadlessAdapter interface + Claude adapter"
```

### Task 14: opencode + codex headless adapters + registry

**Files:**
- Create: `src/control/headless/opencode.ts`
- Create: `src/control/headless/codex.ts`
- Create: `src/control/headless/registry.ts`
- Test: `src/control/__tests__/headless-registry.test.ts`
- Test: `src/control/__tests__/headless-opencode.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/headless-registry.test.ts
import { describe, it, expect } from "vitest";
import { getHeadlessAdapter } from "../headless/registry.js";

describe("headless registry", () => {
  it("resolves claude/opencode/codex adapters", () => {
    expect(getHeadlessAdapter("claude").provider).toBe("claude");
    expect(getHeadlessAdapter("opencode").provider).toBe("opencode");
    expect(getHeadlessAdapter("codex").provider).toBe("codex");
  });

  it("codex buildCommand uses `codex exec --json`", () => {
    const argv = getHeadlessAdapter("codex").buildCommand("do x");
    expect(argv.join(" ")).toContain("codex exec");
    expect(argv.join(" ")).toContain("--json");
  });

  it("codex parseResult: exit 0 → done; exit≠0 → failed", () => {
    const a = getHeadlessAdapter("codex");
    expect(a.parseResult("{}", 0).outcome).toBe("done");
    expect(a.parseResult("err", 3)).toMatchObject({ outcome: "failed", exitCode: 3 });
  });

  it("codex parseResult: exit 0 success → sessionId is undefined", () => {
    const a = getHeadlessAdapter("codex");
    const out = a.parseResult("{}", 0);
    expect(out.outcome).toBe("done");
    expect(out.sessionId).toBeUndefined();
  });

  it("unknown provider throws", () => {
    expect(() => getHeadlessAdapter("aider")).toThrow(/no headless adapter/i);
  });
});
```

```typescript
// src/control/__tests__/headless-opencode.test.ts
import { describe, it, expect } from "vitest";
import { opencodeHeadless } from "../headless/opencode.js";

describe("opencode headless adapter", () => {
  it("parseResult: non-zero exit → failed with exitCode", () => {
    const out = opencodeHeadless.parseResult("some error", 1);
    expect(out).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  it("parseResult: clean JSON string result → done + string payload + sessionId from sessionID", () => {
    const out = opencodeHeadless.parseResult('{"result":"done text","sessionID":"oc-1"}', 0);
    expect(out.outcome).toBe("done");
    expect(out.payload).toBe("done text");
    expect(out.sessionId).toBe("oc-1");
  });

  it("parseResult: object result → JSON-stringified payload", () => {
    const out = opencodeHeadless.parseResult('{"result":{"files":["a.ts"]},"sessionID":"oc-2"}', 0);
    expect(out.outcome).toBe("done");
    expect(out.payload).toBe('{"files":["a.ts"]}');
  });

  it("parseResult: session_id fallback key works", () => {
    const out = opencodeHeadless.parseResult('{"result":"ok","session_id":"oc-3"}', 0);
    expect(out.outcome).toBe("done");
    expect(out.sessionId).toBe("oc-3");
  });

  it("parseResult: unparseable + exit 0 → done with parseWarning + payload=stdout", () => {
    const raw = "not valid json";
    const out = opencodeHeadless.parseResult(raw, 0);
    expect(out.outcome).toBe("done");
    expect(out.parseWarning).toBe(true);
    expect(out.payload).toBe(raw);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/headless-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementations**

```typescript
// src/control/headless/opencode.ts
import type { HeadlessAdapter } from "./types.js";
import { HEADLESS_ERROR_TAIL } from "./types.js";

// opencode `run` is used for one-shot; serve-session wiring is a later spec.
// Process-exit is the done-signal here (foundational scope).
export const opencodeHeadless: HeadlessAdapter = {
  provider: "opencode",
  buildCommand(task, sessionId) {
    const argv = ["opencode", "run", "--format", "json"];
    if (sessionId) argv.push("--session", sessionId);
    argv.push(task);
    return argv;
  },
  parseResult(stdout, exitCode) {
    if (exitCode !== 0) return { outcome: "failed", exitCode, error: stdout.slice(-HEADLESS_ERROR_TAIL) };
    try {
      const j = JSON.parse(stdout);
      const payload = typeof j.result === "string" ? j.result : JSON.stringify(j.result ?? stdout);
      return { outcome: "done", sessionId: j.sessionID ?? j.session_id, payload };
    } catch {
      return { outcome: "done", parseWarning: true, payload: stdout };
    }
  },
};
```

```typescript
// src/control/headless/codex.ts
import type { HeadlessAdapter } from "./types.js";
import { HEADLESS_ERROR_TAIL } from "./types.js";

export const codexHeadless: HeadlessAdapter = {
  provider: "codex",
  buildCommand(task, sessionId) {
    // RECONCILED (verify-on-implement closed vs codex-cli 0.130.0 in real
    // prod use): --skip-git-repo-check is REQUIRED (daemon cwd under launchd
    // is not a git repo → codex aborts otherwise); resume is a SUBCOMMAND,
    // there is no `--session` flag.
    // ENHANCED (post-PR-#85, "enable codex to do real work"): codex exec
    // defaults to a READ-ONLY sandbox → a crew could spec but never edit code
    // (real prod: codex bailed "workspace is mounted read-only"). Added
    // `--sandbox workspace-write` (NOT danger-full-access). This pairs with a
    // new per-task working dir spanning several files (a single coherent
    // feature; reconciliation note here covers all): TaskRecord gains
    // `cwd?: string` (types.ts); `cockpit crew dispatch` gains `--cwd <dir>`
    // (crew-control.ts buildDispatchRequest); RunHeadlessOpts gains `cwd?`
    // and runHeadless passes `{ cwd }` to spawn (headless-launcher.ts) —
    // headless previously inherited the daemon's launchd `/` cwd, wrong for
    // every provider; cockpitd launchHeadless passes `rec.cwd`.
    const opts = ["--json", "--skip-git-repo-check", "--sandbox", "workspace-write"];
    if (sessionId) return ["codex", "exec", "resume", sessionId, ...opts, task];
    return ["codex", "exec", ...opts, task];
  },
  parseResult(stdout, exitCode) {
    if (exitCode !== 0) return { outcome: "failed", exitCode, error: stdout.slice(-HEADLESS_ERROR_TAIL) };
    // codex result format undocumented; keep raw, never guess failure.
    return { outcome: "done", payload: stdout };
  },
};
```

```typescript
// src/control/headless/registry.ts
import type { HeadlessAdapter } from "./types.js";
import { claudeHeadless } from "./claude.js";
import { opencodeHeadless } from "./opencode.js";
import { codexHeadless } from "./codex.js";

const ADAPTERS: Record<string, HeadlessAdapter> = {
  claude: claudeHeadless,
  opencode: opencodeHeadless,
  codex: codexHeadless,
};

export function getHeadlessAdapter(provider: string): HeadlessAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`no headless adapter for provider '${provider}'`);
  return a;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/headless-registry.test.ts src/control/__tests__/headless-opencode.test.ts`
Expected: PASS (5 + 5 = 10 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/headless/ src/control/__tests__/headless-registry.test.ts
git commit -m "feat(control): opencode + codex headless adapters + registry"
```

---

## Phase 7 — Headless Launcher (daemon owns the PID)

### Task 15: Headless launcher — spawn, own pid, map exit → events

**Files:**
- Create: `src/control/headless-launcher.ts`
- Test: `src/control/__tests__/headless-launcher.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/headless-launcher.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runHeadless } from "../headless-launcher.js";

function fakeChild() {
  const ee: any = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.pid = 7777;
  return ee;
}

describe("runHeadless", () => {
  it("emits task.started with pid, then task.done on exit 0", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const events: any[] = [];
    const writeResult = vi.fn(() => "/tmp/result/t1.txt");
    const p = runHeadless({
      provider: "claude", task: "x", id: "t1",
      spawn: spawn as any, emit: (e) => events.push(e),
      writeResult,
    });
    expect(events[0]).toMatchObject({ type: "task.started", id: "t1", pid: 7777 });
    child.stdout.emit("data", '{"result":"ok","session_id":"s1"}');
    child.emit("close", 0);
    await p;
    const done = events.find((e) => e.type === "task.done");
    expect(done).toBeTruthy();
    expect(events.some((e) => e.type === "task.progress")).toBe(true);
    expect(writeResult).toHaveBeenCalledWith("t1", "ok");
    expect(done).toMatchObject({ resultRef: "/tmp/result/t1.txt" });
  });

  it("emits task.failed on non-zero exit", async () => {
    const child = fakeChild();
    const events: any[] = [];
    const p = runHeadless({
      provider: "claude", task: "x", id: "t2",
      spawn: (() => child) as any, emit: (e) => events.push(e),
    });
    child.stderr.emit("data", "explode");
    child.emit("close", 2);
    await p;
    expect(events.find((e) => e.type === "task.failed")).toMatchObject({ exitCode: 2 });
  });

  it("emits task.failed and resolves when spawn emits error (ENOENT)", async () => {
    const child = fakeChild();
    const events: any[] = [];
    const p = runHeadless({ provider: "claude", task: "x", id: "t3",
      spawn: (() => child) as any, emit: (e) => events.push(e) });
    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await p; // must not hang
    expect(events.find((e) => e.type === "task.failed")).toMatchObject({ id: "t3" });
    expect(events.find((e) => e.type === "task.failed")?.error).toMatch(/spawn error/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/headless-launcher.test.ts`
Expected: FAIL — `runHeadless` not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/headless-launcher.ts
import type { spawn as nodeSpawn } from "node:child_process";
import type { ControlEvent } from "./types.js";
import { getHeadlessAdapter } from "./headless/registry.js";

export interface RunHeadlessOpts {
  provider: string;
  task: string;
  id: string;
  sessionId?: string;
  spawn: typeof nodeSpawn;
  emit: (e: ControlEvent) => void;
  /** Where to persist captured payload; defaults handled by caller (Task 17). */
  writeResult?: (id: string, payload: string) => string;
}

export function runHeadless(opts: RunHeadlessOpts): Promise<void> {
  const adapter = getHeadlessAdapter(opts.provider);
  const argv = adapter.buildCommand(opts.task, opts.sessionId);
  const child = opts.spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  opts.emit({ type: "task.started", id: opts.id, pid: child.pid ?? undefined });

  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
    opts.emit({ type: "task.progress", id: opts.id }); // stdout activity = liveness
  });
  child.stderr?.on("data", (d) => { err += String(d); });

  return new Promise<void>((resolve) => {
    child.once("error", (e: Error) => {
      opts.emit({ type: "task.failed", id: opts.id, error: `spawn error: ${e.message}`, exitCode: undefined });
      resolve(); // never hang the daemon; resolve() is idempotent
    });
    child.on("close", (code) => {
      const parseInput = (code !== 0 && err) ? err : (out || err);
      const res = adapter.parseResult(parseInput, code ?? 0);
      if (res.outcome === "failed") {
        opts.emit({ type: "task.failed", id: opts.id, error: res.error ?? "non-zero exit", exitCode: res.exitCode });
      } else {
        const ref = opts.writeResult ? opts.writeResult(opts.id, res.payload ?? "") : "";
        opts.emit({ type: "task.done", id: opts.id, resultRef: ref, parseWarning: res.parseWarning });
      }
      resolve();
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/headless-launcher.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/headless-launcher.ts src/control/__tests__/headless-launcher.test.ts
git commit -m "feat(control): headless launcher — daemon-owned child lifecycle"
```

---

## Phase 8 — Interactive Hook Adapters

### Task 16: InteractiveHookAdapter interface + Claude idempotent settings merge

**Files:**
- Create: `src/control/interactive/types.ts`
- Create: `src/control/interactive/claude.ts`
- Test: `src/control/__tests__/interactive-claude.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/interactive-claude.test.ts
import { describe, it, expect } from "vitest";
import { mergeClaudeHooks } from "../interactive/claude.js";

const HOOK_CMD = "cockpit crew _hook";

describe("claude interactive hook merge", () => {
  it("adds Stop+SubagentStop+SessionEnd hooks to empty settings", () => {
    const out = mergeClaudeHooks({}, HOOK_CMD);
    expect(out.hooks.Stop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SubagentStop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SessionEnd[0].hooks[0].command).toContain(HOOK_CMD);
  });

  it("is idempotent — merging twice yields one cockpit entry per event", () => {
    const once = mergeClaudeHooks({}, HOOK_CMD);
    const twice = mergeClaudeHooks(once, HOOK_CMD);
    const cockpitEntries = twice.hooks.Stop.flatMap((m: any) => m.hooks)
      .filter((h: any) => h.command.includes(HOOK_CMD));
    expect(cockpitEntries).toHaveLength(1);
  });

  it("preserves a user's pre-existing unrelated Stop hook", () => {
    const existing = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "user-thing" }] }] } };
    const out = mergeClaudeHooks(existing, HOOK_CMD);
    const cmds = out.hooks.Stop.flatMap((m: any) => m.hooks).map((h: any) => h.command);
    expect(cmds).toContain("user-thing");
    expect(cmds.some((c: string) => c.includes(HOOK_CMD))).toBe(true);
  });

  // Robustness: ~/.claude/settings.json is hand-edited and may be malformed.
  it("tolerates hooks.Stop being an object {}", () => {
    const out = mergeClaudeHooks({ hooks: { Stop: {} } }, HOOK_CMD);
    expect(Array.isArray(out.hooks.Stop)).toBe(true);
    const cmds = out.hooks.Stop.flatMap((m: any) => m.hooks).map((h: any) => h.command);
    expect(cmds.filter((c: string) => c.includes(HOOK_CMD))).toHaveLength(1);
  });

  it("tolerates hooks.Stop being a string or number", () => {
    for (const bad of ["x", 42]) {
      const out = mergeClaudeHooks({ hooks: { Stop: bad } }, HOOK_CMD);
      expect(Array.isArray(out.hooks.Stop)).toBe(true);
      const cmds = out.hooks.Stop.flatMap((m: any) => m.hooks).map((h: any) => h.command);
      expect(cmds.filter((c: string) => c.includes(HOOK_CMD))).toHaveLength(1);
    }
  });

  it("tolerates a null element and empty-hooks group inside hooks.Stop", () => {
    const out = mergeClaudeHooks({ hooks: { Stop: [null, { matcher: "", hooks: [] }] } }, HOOK_CMD);
    const cmds = out.hooks.Stop.flatMap((m: any) => m?.hooks ?? []).map((h: any) => h.command);
    expect(cmds.some((c: string) => c.includes(HOOK_CMD))).toBe(true);
  });

  it("tolerates a non-array m.hooks inside the array", () => {
    const out = mergeClaudeHooks({ hooks: { Stop: [{ matcher: "", hooks: {} }] } }, HOOK_CMD);
    const cmds = out.hooks.Stop.flatMap((m: any) => (Array.isArray(m?.hooks) ? m.hooks : [])).map((h: any) => h.command);
    expect(cmds.some((c: string) => c.includes(HOOK_CMD))).toBe(true);
  });

  it("adds cockpit hooks when settings has no hooks key at all", () => {
    const out = mergeClaudeHooks({ other: 1 }, HOOK_CMD);
    expect(out.hooks.Stop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SubagentStop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SessionEnd[0].hooks[0].command).toContain(HOOK_CMD);
  });

  it("handles hooks being null", () => {
    const out = mergeClaudeHooks({ hooks: null }, HOOK_CMD);
    expect(out.hooks.Stop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SubagentStop[0].hooks[0].command).toContain(HOOK_CMD);
    expect(out.hooks.SessionEnd[0].hooks[0].command).toContain(HOOK_CMD);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/interactive-claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/interactive/types.ts
export interface InteractiveHookAdapter {
  provider: string;
  tier: "strong" | "best-effort";
  /** Returns the env/flags/launch mutation needed to wire the hook. */
  injectHook(launchSpec: string[], hookCmd: string): string[];
}
```

```typescript
// src/control/interactive/claude.ts
import type { InteractiveHookAdapter } from "./types.js";

const EVENTS = ["Stop", "SubagentStop", "SessionEnd"] as const;

/** Pure, idempotent merge of cockpit hooks into a Claude settings object. */
export function mergeClaudeHooks(settings: any, hookCmd: string): any {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  for (const ev of EVENTS) {
    if (!Array.isArray(next.hooks[ev])) next.hooks[ev] = [];
    const already = next.hooks[ev].some((m: any) =>
      Array.isArray(m?.hooks) && m.hooks.some((h: any) => typeof h.command === "string" && h.command.includes(hookCmd)),
    );
    if (!already) {
      next.hooks[ev].push({ matcher: "", hooks: [{ type: "command", command: `${hookCmd} ${ev}`, timeout: 10 }] });
    }
  }
  return next;
}

export const claudeInteractive: InteractiveHookAdapter = {
  provider: "claude",
  tier: "strong",
  injectHook(launchSpec) {
    // Claude reads merged ~/.config settings; nothing to add to argv here.
    // The settings merge is performed by the launcher (Task 18) before spawn.
    return launchSpec;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/interactive-claude.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/interactive/ src/control/__tests__/interactive-claude.test.ts
git commit -m "feat(control): interactive adapter iface + idempotent Claude hook merge"
```

### Task 17: codex best-effort interactive adapter + registry

**Files:**
- Create: `src/control/interactive/codex.ts`
- Create: `src/control/interactive/registry.ts`
- Test: `src/control/__tests__/interactive-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/interactive-registry.test.ts
import { describe, it, expect } from "vitest";
import { getInteractiveAdapter } from "../interactive/registry.js";

describe("interactive registry", () => {
  it("claude is strong tier", () => {
    expect(getInteractiveAdapter("claude").tier).toBe("strong");
  });
  it("codex is best-effort tier", () => {
    expect(getInteractiveAdapter("codex").tier).toBe("best-effort");
  });
  it("unknown provider throws", () => {
    expect(() => getInteractiveAdapter("gemini")).toThrow(/no interactive adapter/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/interactive-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/interactive/codex.ts
import type { InteractiveHookAdapter } from "./types.js";

// Codex hook surface is thin; reliable liveness for interactive codex needs a
// transcript/pid poll fallback. Foundational scope ships the adapter shell +
// tier marker; the poll fallback is wired by the launcher (Task 18) using pid.
export const codexInteractive: InteractiveHookAdapter = {
  provider: "codex",
  tier: "best-effort",
  injectHook(launchSpec) {
    return launchSpec; // no native hook injection; launcher adds pid poll
  },
};
```

```typescript
// src/control/interactive/registry.ts
import type { InteractiveHookAdapter } from "./types.js";
import { claudeInteractive } from "./claude.js";
import { codexInteractive } from "./codex.js";

const ADAPTERS: Record<string, InteractiveHookAdapter> = {
  claude: claudeInteractive,
  codex: codexInteractive,
};

export function getInteractiveAdapter(provider: string): InteractiveHookAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`no interactive adapter for provider '${provider}'`);
  return a;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/interactive-registry.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/interactive/ src/control/__tests__/interactive-registry.test.ts
git commit -m "feat(control): codex best-effort interactive adapter + registry"
```

---

## Phase 9 — launchd Lifecycle

### Task 18: Plist generation + kickstart

**Files:**
- Create: `src/control/launchd.ts`
- Test: `src/control/__tests__/launchd.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/launchd.test.ts
import { describe, it, expect } from "vitest";
import { renderPlist, LABEL } from "../launchd.js";

describe("launchd plist", () => {
  it("renders a KeepAlive RunAtLoad plist pointing at the daemon entry", () => {
    const xml = renderPlist("/usr/local/bin/node", "/opt/cockpit/dist/control/cockpitd.js");
    expect(xml).toContain(`<string>${LABEL}</string>`);
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("/opt/cockpit/dist/control/cockpitd.js");
  });

  it("XML-escapes interpolated values so a special-char home dir stays well-formed", () => {
    const xml = renderPlist("/Users/O&M/bin/node", "/x/<y>/cockpitd.js");
    expect(xml).toContain("/Users/O&amp;M/bin/node");
    expect(xml).toContain("/x/&lt;y&gt;/cockpitd.js");
    // No raw &/< from interpolation should survive inside <string> values.
    expect(xml).not.toContain("/Users/O&M/bin/node");
    expect(xml).not.toContain("/x/<y>/cockpitd.js");
    // The only `&` occurrences are well-formed entities.
    expect(xml.replace(/&(amp|lt|gt|quot);/g, "")).not.toContain("&");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/launchd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/launchd.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LABEL = "com.cockpit.daemon";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderPlist(nodeBin: string, daemonEntry: string): string {
  const logPath = join(homedir(), ".config", "cockpit", "cockpitd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(nodeBin)}</string><string>${xmlEscape(daemonEntry)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

// NOTE (PR #85 real-env reconciliation): also `import { fileURLToPath } from "node:url";`.
// The daemon entry is resolved HERE (single source of truth), not at call sites —
// a hardcoded ~/.config/cockpit/dist path crash-loops the agent (MODULE_NOT_FOUND;
// runtime-sync never mirrors compiled output there).
export function daemonEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cockpitd.js");
}

/** Idempotent: (re)write plist and (re)load it. Never throws fatally. */
export function ensureDaemon(nodeBin: string = process.execPath): void {
  try {
    const p = plistPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, renderPlist(nodeBin, daemonEntryPath()));
    const uid = process.getuid?.() ?? 0;
    try { execFileSync("launchctl", ["bootstrap", `gui/${uid}`, p], { stdio: "ignore" }); }
    catch { /* already bootstrapped */ }
    execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
  } catch (e) {
    // daemon ensure is best-effort (still don't throw); CLI fails loud on socket miss
    process.stderr.write(`[cockpit] warn: ensureDaemon failed (${e instanceof Error ? e.message : e})\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/launchd.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/launchd.ts src/control/__tests__/launchd.test.ts
git commit -m "feat(control): launchd plist render + idempotent ensureDaemon"
```

### Task 19: Daemon entrypoint binary (cockpitd)

**Files:**
- Create: `src/control/cockpitd.ts`
- Test: `src/control/__tests__/cockpitd-smoke.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/cockpitd-smoke.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd, defaultIsPidAlive } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";

describe("defaultIsPidAlive", () => {
  it("treats the current process as alive", () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
  });
  it("treats an almost-certainly-free pid as dead (ESRCH path)", () => {
    expect(defaultIsPidAlive(2147483646)).toBe(false);
  });
});

describe("cockpitd smoke", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("starts, accepts an event for a pre-seeded task, persists state", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cd-"));
    const sock = join(dir, "c.sock");
    const handle = startCockpitd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0 });
    stop = handle.stop;
    await sendRequest(sock, { kind: "seed", record: {
      id: "t1", project: "p", provider: "claude", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000 } });
    const r: any = await sendRequest(sock, { kind: "event", project: "p", event: { type: "task.started", id: "t1" } });
    expect(r.state).toBe("working");
  });

  it("honors an injected isPidAlive on boot reconcile (dead pid → failed)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cd-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const working = {
      id: "h1", project: "p", provider: "claude", mode: "headless",
      state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, pid: 4242,
    };

    // Seed a working headless task via a first daemon instance, then stop it.
    const seeder = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    await sendRequest(sock, { kind: "seed", record: working });
    seeder.stop();

    // Restart with injected dead-pid checker: boot reconcile must fail it.
    const dead = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, isPidAlive: () => false });
    stop = dead.stop;
    const failed: any = await sendRequest(sock, { kind: "status", project: "p", id: "h1" });
    expect(failed.state).toBe("failed");
    dead.stop();

    // Restart with alive checker on a fresh seed: boot reconcile must keep it working.
    const seeder2 = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    await sendRequest(sock, { kind: "seed", record: working });
    seeder2.stop();
    const aliveD = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0, isPidAlive: () => true });
    stop = aliveD.stop;
    const stillWorking: any = await sendRequest(sock, { kind: "status", project: "p", id: "h1" });
    expect(stillWorking.state).toBe("working");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/cockpitd-smoke.test.ts`
Expected: FAIL — `startCockpitd` not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/control/cockpitd.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { createDaemon } from "./daemon.js";
import { startServer } from "./protocol.js";
import type { TaskRecord } from "./types.js";

export interface CockpitdOpts {
  stateRoot?: string;
  sockPath?: string;
  sweepMs?: number; // 0 disables the interval (tests)
  isPidAlive?: (pid: number) => boolean; // injectable for the headless reconcile path (tests)
}

export function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; } // EPERM = alive but not ours; ESRCH = dead
}

export function startCockpitd(opts: CockpitdOpts = {}) {
  const stateRoot = opts.stateRoot ?? join(homedir(), ".config", "cockpit", "state");
  const sockPath = opts.sockPath ?? join(homedir(), ".config", "cockpit", "cockpit.sock");
  const store = createStore(stateRoot);
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const d = createDaemon({ store, now: () => Date.now(), isPidAlive });

  d.reconcile(); // crash recovery on boot

  const server = startServer(sockPath, async (msg: any) => {
    if (msg.kind === "seed") { store.put(msg.record as TaskRecord); return { ok: true }; }
    return d.handle(msg);
  });

  let timer: NodeJS.Timeout | undefined;
  if (opts.sweepMs && opts.sweepMs > 0) {
    timer = setInterval(() => d.sweep(), opts.sweepMs);
    timer.unref?.();
  }

  return {
    stop() { if (timer) clearInterval(timer); server.close(); },
  };
}

// Executed by launchd (ProgramArguments → this file's compiled .js).
if (process.argv[1] && process.argv[1].endsWith("cockpitd.js")) {
  const h = startCockpitd({ sweepMs: 30000 });
  process.on("SIGTERM", () => { h.stop(); process.exit(0); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/cockpitd-smoke.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/cockpitd.ts src/control/__tests__/cockpitd-smoke.test.ts
git commit -m "feat(control): cockpitd daemon entrypoint (launchd target)"
```

---

## Phase 10 — Captain CLI + Wiring

### Task 20: `cockpit crew` socket client command

**Files:**
- Create: `src/commands/crew-control.ts`
- Test: `src/control/__tests__/crew-control.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/crew-control.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildDispatchRequest, buildStatusRequest } from "../../commands/crew-control.js";

describe("crew-control request builders", () => {
  it("dispatch request carries project/provider/mode/task and a generated id", () => {
    const r = buildDispatchRequest({ project: "p", provider: "codex", mode: "headless", task: "fix x" });
    expect(r.kind).toBe("dispatch");
    expect(r.record.project).toBe("p");
    expect(r.record.provider).toBe("codex");
    expect(r.record.mode).toBe("headless");
    expect(r.record.task).toBe("fix x");
    expect(r.record.state).toBe("submitted");
    expect(typeof r.record.id).toBe("string");
    expect(r.record.id.length).toBeGreaterThan(0);
  });

  it("status request targets a task id", () => {
    expect(buildStatusRequest("p", "t9")).toEqual({ kind: "status", project: "p", id: "t9" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/crew-control.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/commands/crew-control.ts
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendRequest } from "../control/protocol.js";
import { ensureDaemon } from "../control/launchd.js";
import type { Mode, Provider, TaskRecord } from "../control/types.js";

const SOCK = join(homedir(), ".config", "cockpit", "cockpit.sock");

export function buildDispatchRequest(o: {
  project: string; provider: Provider; mode: Mode; task: string; budgetMs?: number;
}): { kind: "dispatch"; record: TaskRecord } {
  const now = Date.now();
  return {
    kind: "dispatch",
    record: {
      id: randomUUID(), project: o.project, provider: o.provider, mode: o.mode,
      state: "submitted", task: o.task, createdAt: now, lastHeartbeat: now,
      lastEvent: "dispatch", heartbeatBudgetMs: o.budgetMs ?? 300000,
    },
  };
}

export function buildStatusRequest(project: string, id: string) {
  return { kind: "status" as const, project, id };
}

async function call(req: unknown): Promise<unknown> {
  try {
    return await sendRequest(SOCK, req);
  } catch {
    ensureDaemon(); // resolves its own entrypoint — never pass a path here (PR #85)
    // one retry after kickstart; if still down, fail loud (no scrape fallback)
    return sendRequest(SOCK, req);
  }
}

export const crewControlCommand = new Command("crew")
  .description("Dispatch and track crew via the cockpit control plane");

crewControlCommand
  .command("dispatch <project> <task>")
  .requiredOption("--provider <p>", "claude|opencode|codex|gemini")
  .option("--mode <m>", "headless|interactive", "interactive")
  .action(async (project: string, task: string, opts: { provider: Provider; mode: Mode }) => {
    const req = buildDispatchRequest({ project, task, provider: opts.provider, mode: opts.mode });
    const r = await call(req);
    process.stdout.write(JSON.stringify(r) + "\n");
  });

crewControlCommand
  .command("status <project> <id>")
  .action(async (project: string, id: string) => {
    const r = await call(buildStatusRequest(project, id));
    process.stdout.write(JSON.stringify(r) + "\n");
  });

crewControlCommand
  .command("list <project>")
  .action(async (project: string) => {
    const r = await call({ kind: "list", project });
    process.stdout.write(JSON.stringify(r) + "\n");
  });

crewControlCommand
  .command("reply <project> <id> <message>")
  .action(async (project: string, id: string, message: string) => {
    const r = await call({ kind: "reply", project, id, message });
    process.stdout.write(JSON.stringify(r) + "\n");
  });

crewControlCommand
  .command("_hook <event>")
  .description("internal: invoked by injected agent hooks")
  .action(async (event: string) => {
    // hook payload arrives on stdin (Claude hook JSON); minimal: emit progress.
    process.stdout.write(`hook:${event}\n`);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/crew-control.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/commands/crew-control.ts src/control/__tests__/crew-control.test.ts
git commit -m "feat(control): cockpit crew socket client (fail-loud, kickstart retry)"
```

### Task 21: Daemon `dispatch` handler + headless auto-launch

**Files:**
- Modify: `src/control/daemon.ts`
- Test: `src/control/__tests__/daemon.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```typescript
  it("dispatch persists submitted then (headless) triggers launch hook", async () => {
    const store = createStore(dir);
    const launched: string[] = [];
    const d = createDaemon({
      store, now: () => 1, isPidAlive: () => true,
      launchHeadless: async (r) => { launched.push(r.id); },
    });
    const r: any = await d.handle({ kind: "dispatch", record: {
      id: "h9", project: "p", provider: "claude", mode: "headless",
      state: "submitted", task: "go", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 1000 } });
    expect(r.state).toBe("submitted");
    expect(store.get("p", "h9")).toBeTruthy();
    expect(launched).toEqual(["h9"]);
  });

  it("dispatch interactive does NOT auto-launch headless", async () => {
    const store = createStore(dir);
    const launched: string[] = [];
    const d = createDaemon({
      store, now: () => 1, launchHeadless: async (r) => { launched.push(r.id); },
    });
    await d.handle({ kind: "dispatch", record: {
      id: "i9", project: "p", provider: "claude", mode: "interactive",
      state: "submitted", task: "go", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 1000 } });
    expect(launched).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/daemon.test.ts`
Expected: FAIL — `dispatch` kind unhandled / `launchHeadless` not in deps.

- [ ] **Step 3: Extend implementation**

In `src/control/daemon.ts`, add to `DaemonDeps`:

```typescript
  /** Wired in cockpitd to runHeadless; absent in pure unit tests. */
  launchHeadless?: (rec: TaskRecord) => Promise<void>;
```

Add `dispatch` to the `Req` union:

```typescript
  | { kind: "dispatch"; record: TaskRecord }
```

Add the case in `handle` (before `default`/end of switch):

```typescript
        case "dispatch": {
          store.put(req.record);
          if (req.record.mode === "headless" && deps.launchHeadless) {
            // A missing adapter (e.g. gemini) makes launchHeadless reject;
            // never let that become an unhandled rejection that kills the
            // daemon — drive the task to `failed` instead.
            deps.launchHeadless(req.record).catch((e: unknown) => {
              const error = e instanceof Error ? e.message : String(e);
              store.put({ ...req.record, state: "failed", lastEvent: "launch-error", error });
            });
          }
          return req.record;
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/daemon.test.ts`
Expected: PASS (10 passed).

- [ ] **Step 5: Commit**

```bash
git add src/control/daemon.ts src/control/__tests__/daemon.test.ts
git commit -m "feat(control): daemon dispatch handler + headless auto-launch hook"
```

### Task 22: Wire headless launch into cockpitd + register CLI command

**Files:**
- Modify: `src/control/cockpitd.ts`
- Modify: `src/index.ts`
- Test: `src/control/__tests__/cockpitd-headless.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/cockpitd-headless.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";

describe("cockpitd headless wiring", () => {
  let stop: (() => void) | undefined; let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("dispatch headless → child spawned → exit drives state to done", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-h-"));
    const sock = join(dir, "c.sock");
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4321;
    const spawn = vi.fn(() => child);
    const h = startCockpitd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0, spawn: spawn as any });
    stop = h.stop;
    const disp: any = await sendRequest(sock, { kind: "dispatch", record: {
      id: "h1", project: "p", provider: "claude", mode: "headless",
      state: "submitted", task: "go", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 10000 } });
    expect(disp.state).toBe("submitted");
    child.stdout.emit("data", '{"result":"done","session_id":"s1"}');
    child.emit("close", 0);
    await new Promise((r) => setTimeout(r, 20));
    const st: any = await sendRequest(sock, { kind: "status", project: "p", id: "h1" });
    expect(st.state).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/cockpitd-headless.test.ts`
Expected: FAIL — `startCockpitd` ignores `spawn`; no headless wiring.

- [ ] **Step 3: Extend implementation**

In `src/control/cockpitd.ts` add `spawn` to `CockpitdOpts` and wire `launchHeadless`:

```typescript
import { spawn as realSpawn } from "node:child_process";
import { runHeadless } from "./headless-launcher.js";
import { writeFileSync, mkdirSync } from "node:fs";
```

Add to `CockpitdOpts`:

```typescript
  spawn?: typeof realSpawn;
```

Replace the `createDaemon` construction with a launch-wired daemon:

```typescript
  const spawn = opts.spawn ?? realSpawn;
  const resultsDir = join(stateRoot, "_results");
  mkdirSync(resultsDir, { recursive: true }); // created once at init, not per write
  const writeResult = (id: string, payload: string) => {
    const p = join(resultsDir, `${id}.txt`);
    writeFileSync(p, payload);
    return p;
  };
  const ingest = (project: string) => (e: import("./types.js").ControlEvent) =>
    void d.handle({ kind: "event", project, event: e });

  const d = createDaemon({
    store, now: () => Date.now(), isPidAlive,
    launchHeadless: async (rec) => {
      await runHeadless({
        provider: rec.provider, task: rec.task, id: rec.id, sessionId: rec.sessionId,
        spawn, emit: ingest(rec.project), writeResult,
      });
    },
  });
```

(Remove the previous `const d = createDaemon({ store, now: () => Date.now(), isPidAlive });` line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/cockpitd-headless.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Register the command in the CLI**

**RECONCILED (PR #85 real-env fix):** the original "swap `crewCommand`→`crewControlCommand`" instruction broke every live captain (the real legacy surface is `spawn/send/read/close/list`, which captain-ops still invokes — not `dispatch/status/reply`). Do NOT swap. Instead **compose**: keep the legacy `crewCommand` registered verbatim and attach the control-plane verbs onto it.

In `src/index.ts`:
```typescript
import { crewCommand } from "./commands/crew.js";
import { addControlPlaneCrewCommands } from "./commands/crew-control.js";
// ...
addControlPlaneCrewCommands(crewCommand); // adds dispatch/status/tasks/reply/_hook
program.addCommand(crewCommand);
```
`crew-control.ts` exports `addControlPlaneCrewCommands(crew: Command)` (control-plane listing is `tasks`, not `list`, to avoid colliding with legacy `list`). Both verb sets coexist on `cockpit crew` — the deferred-legacy state. Retiring `crew.ts` + migrating captain-ops is the deferred legacy-re-pointing spec.

Also replace `program.parse();` with a clean fail-loud handler so async
action errors print one line to stderr instead of a raw unhandled rejection:

```typescript
program.parseAsync().catch((e) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
```

**Code-review reconciliation (applied post-Phase-10):**

- `crew-control.ts` `call()`: after `ensureDaemon`, the single retry is a
  bounded backoff — up to 3 `sendRequest` attempts ~200ms apart; if all fail,
  throw the last error (still fail-loud, now clean via the `parseAsync().catch`).
- `crew-control.ts` `--provider` help: `claude|opencode|codex (gemini: experimental, headless not supported)`
  (`gemini` stays in the `Provider` type — experimental per spec).
- `crew-control.ts` deferred surfaces made loud, not silent: `_hook` is a
  commander `{ hidden: true }` no-op stub with a `TODO(downstream
  interactive-wiring spec)` comment; `reply` prints
  `reply delivery is not yet wired (deferred); state transitioned only` to
  stderr (no `deliverReply` is wired in cockpitd yet).

- [ ] **Step 6: Build + full suite + commit**

Run: `npm run build && npx vitest run`
Expected: build OK; all control tests green; pre-existing `config.test.ts` 2 failures unchanged (#70/#76 — not introduced here).

```bash
git add src/control/cockpitd.ts src/index.ts src/control/__tests__/cockpitd-headless.test.ts
git commit -m "feat(control): wire headless launch into cockpitd; swap crew command"
```

---

## Phase 11 — Integration: the success criterion

### Task 23: End-to-end daemon restart reconciliation test

**Files:**
- Test: `src/control/__tests__/integration-restart.test.ts`

- [ ] **Step 1: Write the test (this is the spec's success criterion)**

```typescript
// src/control/__tests__/integration-restart.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";

describe("integration: daemon restart mid-task (success criterion)", () => {
  let stop: (() => void) | undefined; let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("a working interactive task survives a daemon restart as 'stalled' (no false done)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-int-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");

    let h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    await sendRequest(sock, { kind: "dispatch", record: {
      id: "t1", project: "p", provider: "claude", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 999999 } });
    await sendRequest(sock, { kind: "event", project: "p", event: { type: "task.started", id: "t1" } });

    // crash the daemon mid-task
    h.stop();

    // restart — reconcile() must run on boot
    h = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    stop = h.stop;

    const st: any = await sendRequest(sock, { kind: "status", project: "p", id: "t1" });
    expect(st.state).toBe("stalled");          // surfaced deterministically
    expect(st.state).not.toBe("done");          // never fabricated success
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/integration-restart.test.ts`
Expected: PASS (1 passed). If it fails, the reconcile-on-boot wiring (Task 11/19) is the defect — fix there, not here.

- [ ] **Step 3: Commit**

```bash
git add src/control/__tests__/integration-restart.test.ts
git commit -m "test(control): success-criterion integration — restart reconciliation"
```

---

## Phase 12 — launchd self-heal integration

### Task 24: Ensure daemon on CLI invocation (reuse runtime-sync site)

**Files:**
- Modify: `src/index.ts`
- Test: `src/control/__tests__/ensure-daemon-callsite.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/ensure-daemon-callsite.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Guard test: index.ts must call ensureDaemon so the daemon self-heals
// on every cockpit invocation (mirrors ensureRuntimeSynced philosophy).
it("index.ts wires ensureDaemon after ensureRuntimeSynced", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const idx = readFileSync(join(here, "..", "..", "index.ts"), "utf-8");
  expect(idx).toMatch(/ensureDaemon/);
  expect(idx.indexOf("ensureRuntimeSynced")).toBeLessThan(idx.indexOf("ensureDaemon"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/ensure-daemon-callsite.test.ts`
Expected: FAIL — `ensureDaemon` not referenced in `index.ts`.

- [ ] **Step 3: Wire it**

In `src/index.ts`, add the import near the other control imports:

```typescript
import { ensureDaemon } from "./control/launchd.js";
```

Immediately after the existing `ensureRuntimeSynced({ ... });` call, add:

```typescript
// Self-heal the control-plane daemon the same way we self-heal the runtime:
// best-effort, never throws; the CLI fails loud later if the socket is unreachable.
// ensureDaemon resolves its own entrypoint (launchd.daemonEntryPath) so no
// call site can get the path wrong (PR #85 real-env fix).
ensureDaemon();
```

- [ ] **Step 4: Run test + full suite**

Run: `npx vitest run src/control/__tests__/ensure-daemon-callsite.test.ts && npm run build`
Expected: PASS; build OK.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/control/__tests__/ensure-daemon-callsite.test.ts
git commit -m "feat(control): self-heal daemon on every cockpit invocation"
```

### Task 25: Final verification sweep

**Files:** (none — verification only)

- [ ] **Step 1: Full suite + build**

Run: `npm run build && npx vitest run`
Expected: All `src/control/**` suites green. Pre-existing failures limited to `src/config.test.ts` (2, tracked #70/#76). No new failures.

- [ ] **Step 2: Doctor still works**

Run: `node dist/index.js doctor`
Expected: runs without throwing; control-plane does not regress existing checks.

- [ ] **Step 3: Commit any build artifacts if the repo tracks dist**

```bash
git status --short
# if dist/ is tracked and changed:
git add dist/ && git commit -m "build: compile control-plane"
```

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin feature/control-plane-design
gh pr create --base develop --title "feat: cockpit control-plane (foundational)" \
  --body "Implements docs/specs/2026-05-17-cockpit-control-plane-design.md. Foundational scope: daemon + socket + state machine + watchdog + provider-tiered crew loop. Deferred: auto-recovery actions, auto-learn, legacy re-pointing, notifications."
```

---

## Self-Review (against the spec)

**Spec coverage:** daemon ✔(T19,22) · socket ✔(T8,9) · event vocabulary + state machine ✔(T1–3) · task-state store ✔(T4,5) · heartbeat detection ✔(T6,7,12) · headless ownership Claude/opencode/codex ✔(T13–15,22) · interactive hook Claude-strong/codex-best-effort ✔(T16,17) · captain CLI fail-loud ✔(T20) · launchd lifecycle + crash reconciliation ✔(T11,18,19,23) · anti-#2576 invariant ✔(T3) · conservative crash recovery (never fabricate done) ✔(T11,23) · gemini stub: intentionally OUT (registry throws clearly; experimental, deferred) — matches spec scope line.

**Deferred (OUT) — no tasks, by design:** auto-recovery actions, auto-learn, legacy re-pointing, notifications, gemini-full/aider/cursor, non-cmux runtime, non-macOS supervisor.

**Placeholder scan:** no TBD/TODO; every code step is complete and runnable.

**Type consistency:** `TaskRecord`/`ControlEvent`/`TaskState` defined once (T1) and used unchanged; `reduce(rec,ev,now)` signature stable T2→T21; `HeadlessAdapter.parseResult` shape stable T13→T22; `createDaemon` deps grow additively (`isPidAlive` T11, `launchHeadless` T21) without breaking earlier callers (all optional).

**Known seam to verify during execution:** opencode/codex/gemini exact `--format/--json` flag spelling and result-payload shape are marked verify-on-implement in the spec; adapters isolate this — a wrong flag is a one-file fix in `src/control/headless/<provider>.ts`, not a substrate change.
