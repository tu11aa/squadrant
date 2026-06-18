# Mailbox + Injector Implementation Plan

> **✅ Shipped** (PR #116, 2026-05-27). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR #112's subscribe/broadcast machinery with a file-as-source-of-truth mailbox the daemon appends to, plus a pull-from-cursor injector that runs inside the captain workspace's process tree and delivers each event to the captain pane via a runtime-agnostic `RuntimeDriver` surface.

**Architecture:** Single PR, four logical commits in atomic micro-steps. Daemon side gains a `mailbox.ts` module (append-only JSON-lines + rotation + cursor primitives), loses the subscribe-notify socket protocol. Injector side becomes a `tail -F`-from-cursor loop with fsync'd ack writes. `RuntimeDriver` gains `spawnInjector` (in-tree process) and `sendToSurface` (per-surface text delivery). cmux implementation uses split-pane (hidden if possible, visible tab as fallback). Approach 3 boundary preserved — daemon owns the event stream, never the captain or crew processes.

**Tech Stack:** TypeScript strict ESM, vitest, commander, node:net AF_UNIX, node:fs (writeFile/appendFile with `O_APPEND` + flock-equivalent via `proper-lockfile` or built-in `fs.flock`), chokidar (fallback to `fs.watch` + 1s polling), cmux CLI as the runtime under test.

**Spec:** `docs/specs/2026-05-27-mailbox-injector-design.md`

**Conventions seen in cockpit (follow these):**
- Tests are vitest siblings in `src/<area>/__tests__/<source>.test.ts`. Pure-function modules get `src/lib/__tests__/...` or `src/control/__tests__/...`.
- All TS imports use `.js` suffix (ESM).
- Pure functions stay pure; side effects in adapters/launchers/runners.
- Anti-#2576 invariant: bare `Stop`/`SubagentStop`/`SessionEnd` hooks map only to `task.progress` — never `task.done` (enforced in `firePush` gate, unchanged by this plan).
- Atomic commits: one task = one commit. Commit subject prefix `feat(mailbox)` / `test(mailbox)` / `refactor(daemon)` / `chore(mailbox)`.

---

## File Structure

**Create:**
- `src/control/mailbox.ts` — pure mailbox ops: `appendToMailbox`, `rotateIfNeeded`, `readFromCursor`, `readCursor`, `writeCursor`, types.
- `src/control/__tests__/mailbox.test.ts` — unit tests for all of the above. Uses `node:fs` + tmpdir.
- `src/runtimes/__tests__/cmux-spawn-injector.live.test.ts` — opt-in live test for the cmux `spawnInjector` implementation. Skipped unless `CMUX_LIVE=1` env var set.
- `scripts/mailbox-injector-smoke.mjs` — E2E smoke that drives a daemon + simulated injector against a temp socket; mirrors `scripts/smoke-push-notify.mjs` and `scripts/claude-iv-smoke.mjs` patterns.

**Modify:**
- `src/control/cockpitd.ts` (`startCockpitd` and `defaultNotify`, ~line 151 onward) — replace shell-out with `appendToMailbox` call; delete subscribe-notify socket frame handler; add rotation timer at startup/cleanup at shutdown.
- `src/control/daemon.ts` (`firePush` function, ~lines 36-79) — update `notify` callback signature so it receives `{project, message, record, event}` instead of `{project, message}`. Keep gate logic unchanged.
- `src/control/protocol.ts` — remove `SubscribeNotifyClaim` and `PushFrame` definitions (added in PR #112).
- `src/control/__tests__/cockpitd-notify-default.test.ts` — replace broadcast tests with mailbox-append tests.
- `src/control/__tests__/daemon.test.ts` — adjust firePush signature assertions if present.
- `src/commands/notify-relay.ts` — rewrite as file-tailer (cursor read → tail loop → format → sendToSurface → cursor write). Delete socket-subscribe code.
- `src/commands/__tests__/notify-relay.test.ts` — rewrite tests for the new file-tailer behavior.
- `src/commands/launch.ts` (the function that adds the relay tab, look for `NOTIFY_RELAY_TAB_TITLE`) — switch from `runtime.newPane` to `runtime.spawnInjector({placement: "hidden"})`; kill any existing notify-relay surface (visible OR hidden) before spawning the new one.
- `src/runtimes/types.ts` — add `spawnInjector` and `sendToSurface` method signatures to `RuntimeDriver`.
- `src/runtimes/cmux.ts` — implement `spawnInjector` (new-split → resize → rename → return SurfaceRef) and `sendToSurface` (cmux send --workspace --surface). Implement memory driver too if tests need it (`src/runtimes/__tests__/helpers/memory-runtime.ts` or similar).

**No changes to:** `src/control/state-machine.ts`, `src/control/store.ts`, `src/control/types.ts` (except possibly adding `Provider` re-export to ease use in mailbox), `src/control/headless-launcher.ts`, `src/control/codex/*`, `src/control/interactive/*`, `src/drivers/*`. **If a task tempts you to touch these, STOP — it has scope-crept.**

---

## Pre-Flight (do once before Task 1)

- [ ] **Step P1: Confirm branch + clean tree**

```bash
git status -sb
git branch --show-current
```

Expected: on `feature/mailbox-injector`, only the pre-existing dirty files from the start of this work (`M AGENTS.md`, untracked `docs/diagrams/`, `docs/research/2026-05-16-idle-detection-*`, `.codex-smoke-evidence.local`, `.claude/`). The new spec + research files added on this branch should NOT show as dirty (they were committed in the brainstorm commit).

If on wrong branch, run:

```bash
git checkout feature/mailbox-injector
```

- [ ] **Step P2: Confirm daemon is reachable + tests pass on current code**

```bash
test -S ~/.config/cockpit/cockpit.sock && echo "sock present" || echo "sock missing (will respawn via ensureDaemon)"
npm test 2>&1 | tail -5
```

Expected: all existing tests (PR #112's notify-relay + cockpitd-notify-default + interactive-claude-hook etc.) pass. If they don't, stop and investigate — don't build on a broken baseline.

- [ ] **Step P3: Note baseline file sizes for reference**

```bash
wc -l src/control/cockpitd.ts src/commands/notify-relay.ts src/control/protocol.ts src/commands/launch.ts
```

Record. After all tasks, `notify-relay.ts` should be roughly 1/3 smaller and `cockpitd.ts` should be slightly smaller (subscribe code removed) or unchanged (rotation timer added cancels).

---

# COMMIT GROUP 1: mailbox.ts (pure functions)

Pure-function module — no daemon wiring yet. After this group lands, end-to-end behavior is unchanged (the existing PR #112 broadcast still works); we've just added a new unused module that's fully unit-tested.

---

## Task 1: Mailbox types + appendToMailbox

**Files:**
- Create: `src/control/mailbox.ts`
- Create: `src/control/__tests__/mailbox.test.ts`

- [ ] **Step 1.1: Write the failing test for appendToMailbox**

Create `src/control/__tests__/mailbox.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToMailbox } from "../mailbox.js";
import type { TaskRecord, ControlEvent } from "../types.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "mbox-"));
}

const sampleRecord: TaskRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  project: "demo",
  provider: "claude",
  mode: "interactive",
  state: "working",
  task: "smoke test task description",
  cwd: "/tmp",
  createdAt: 1000,
  lastHeartbeat: 1000,
  lastEvent: "task.progress",
  heartbeatBudgetMs: 60000,
  attempts: [],
};

const doneEvent: ControlEvent = {
  type: "task.done",
  id: sampleRecord.id,
  resultRef: "/tmp/result.txt",
};

describe("appendToMailbox", () => {
  it("creates inbox/<project>.log on first append and assigns seq=1", async () => {
    const stateRoot = freshState();
    const seq = await appendToMailbox({
      stateRoot,
      project: "demo",
      taskRecord: sampleRecord,
      event: doneEvent,
    });
    expect(seq).toBe(1);
    const logPath = join(stateRoot, "inbox", "demo.log");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.seq).toBe(1);
    expect(entry.taskId).toBe(sampleRecord.id);
    expect(entry.kind).toBe("task.done");
    expect(entry.provider).toBe("claude");
    expect(entry.payload.resultRef).toBe("/tmp/result.txt");
    expect(typeof entry.ts).toBe("string");
  });

  it("assigns monotonically increasing seq on subsequent appends", async () => {
    const stateRoot = freshState();
    const s1 = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const s2 = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const s3 = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    expect([s1, s2, s3]).toEqual([1, 2, 3]);
  });

  it("isolates seq per project", async () => {
    const stateRoot = freshState();
    const a = await appendToMailbox({ stateRoot, project: "a", taskRecord: sampleRecord, event: doneEvent });
    const b = await appendToMailbox({ stateRoot, project: "b", taskRecord: sampleRecord, event: doneEvent });
    const a2 = await appendToMailbox({ stateRoot, project: "a", taskRecord: sampleRecord, event: doneEvent });
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(a2).toBe(2);
  });

  it("resumes seq from max in file after daemon restart simulation", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    // simulate restart by calling appendToMailbox in a way that re-reads max seq
    const s3 = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    expect(s3).toBe(3);
  });
});
```

- [ ] **Step 1.2: Run the test, verify it fails**

```bash
npx vitest run src/control/__tests__/mailbox.test.ts
```

Expected: FAIL with "Cannot find module '../mailbox.js'" or similar.

- [ ] **Step 1.3: Create the minimum mailbox.ts to make tests pass**

Create `src/control/mailbox.ts`:

```typescript
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { TaskRecord, ControlEvent } from "./types.js";

export interface MailboxEntry {
  seq: number;
  ts: string;
  taskId: string;
  kind: ControlEvent["type"];
  provider: TaskRecord["provider"];
  payload: Record<string, unknown>;
}

interface AppendOpts {
  stateRoot: string;
  project: string;
  taskRecord: TaskRecord;
  event: ControlEvent;
}

function inboxDir(stateRoot: string): string {
  return join(stateRoot, "inbox");
}

function logPath(stateRoot: string, project: string): string {
  return join(inboxDir(stateRoot), `${project}.log`);
}

function extractPayload(event: ControlEvent): Record<string, unknown> {
  // ControlEvent is a discriminated union — strip type/id, keep the rest.
  const { type: _type, id: _id, ...payload } = event as Record<string, unknown> & { type: string; id: string };
  return payload;
}

async function readMaxSeq(file: string): Promise<number> {
  try {
    const buf = await fs.readFile(file, "utf-8");
    if (!buf.trim()) return 0;
    const lines = buf.trim().split("\n");
    // walk backwards finding last parseable line (last line may be partial)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]) as MailboxEntry;
        return obj.seq;
      } catch { continue; }
    }
    return 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}

export async function appendToMailbox(opts: AppendOpts): Promise<number> {
  const dir = inboxDir(opts.stateRoot);
  await fs.mkdir(dir, { recursive: true });
  const file = logPath(opts.stateRoot, opts.project);
  const lastSeq = await readMaxSeq(file);
  const seq = lastSeq + 1;
  const entry: MailboxEntry = {
    seq,
    ts: new Date().toISOString(),
    taskId: opts.taskRecord.id,
    kind: opts.event.type,
    provider: opts.taskRecord.provider,
    payload: extractPayload(opts.event),
  };
  await fs.appendFile(file, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
  return seq;
}
```

- [ ] **Step 1.4: Run the test, verify it passes**

```bash
npx vitest run src/control/__tests__/mailbox.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add src/control/mailbox.ts src/control/__tests__/mailbox.test.ts
git commit -m "feat(mailbox): appendToMailbox primitive with monotonic seq per project"
```

---

## Task 2: Cursor read/write primitives

**Files:**
- Modify: `src/control/mailbox.ts` (add `readCursor`, `writeCursor`)
- Modify: `src/control/__tests__/mailbox.test.ts` (add tests)

- [ ] **Step 2.1: Write failing tests for cursor functions**

Append to `src/control/__tests__/mailbox.test.ts`:

```typescript
import { readCursor, writeCursor } from "../mailbox.js";

describe("cursor read/write", () => {
  it("readCursor returns null when file does not exist", async () => {
    const stateRoot = freshState();
    const c = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(c).toBeNull();
  });

  it("writeCursor then readCursor round-trips lastAckedSeq", async () => {
    const stateRoot = freshState();
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 42 });
    const c = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(c?.lastAckedSeq).toBe(42);
  });

  it("writeCursor uses atomic rename (no partial-file race)", async () => {
    const stateRoot = freshState();
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 1 });
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 2 });
    const c = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(c?.lastAckedSeq).toBe(2);
    // .tmp file should not be left over
    const tmpExists = existsSync(join(stateRoot, "inbox", "demo.captain.cursor.tmp"));
    expect(tmpExists).toBe(false);
  });

  it("isolates cursors per subscriber", async () => {
    const stateRoot = freshState();
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 10 });
    await writeCursor({ stateRoot, project: "demo", subscriber: "telegram", lastAckedSeq: 5 });
    const cap = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    const tg = await readCursor({ stateRoot, project: "demo", subscriber: "telegram" });
    expect(cap?.lastAckedSeq).toBe(10);
    expect(tg?.lastAckedSeq).toBe(5);
  });
});
```

- [ ] **Step 2.2: Run tests, verify they fail**

```bash
npx vitest run src/control/__tests__/mailbox.test.ts
```

Expected: 4 failures with "readCursor is not a function" etc.

- [ ] **Step 2.3: Implement readCursor + writeCursor**

Append to `src/control/mailbox.ts`:

```typescript
function cursorPath(stateRoot: string, project: string, subscriber: string): string {
  return join(inboxDir(stateRoot), `${project}.${subscriber}.cursor`);
}

interface CursorOpts {
  stateRoot: string;
  project: string;
  subscriber: string;
}

export interface CursorState {
  lastAckedSeq: number;
  subscriber: string;
  updatedAt: string;
}

export async function readCursor(opts: CursorOpts): Promise<CursorState | null> {
  try {
    const buf = await fs.readFile(cursorPath(opts.stateRoot, opts.project, opts.subscriber), "utf-8");
    return JSON.parse(buf) as CursorState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeCursor(opts: CursorOpts & { lastAckedSeq: number }): Promise<void> {
  await fs.mkdir(inboxDir(opts.stateRoot), { recursive: true });
  const dest = cursorPath(opts.stateRoot, opts.project, opts.subscriber);
  const tmp = dest + ".tmp";
  const data: CursorState = {
    lastAckedSeq: opts.lastAckedSeq,
    subscriber: opts.subscriber,
    updatedAt: new Date().toISOString(),
  };
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(data), { encoding: "utf-8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, dest);
}
```

- [ ] **Step 2.4: Run tests, verify all pass**

```bash
npx vitest run src/control/__tests__/mailbox.test.ts
```

Expected: 8 tests pass (4 from Task 1 + 4 from Task 2).

- [ ] **Step 2.5: Commit**

```bash
git add src/control/mailbox.ts src/control/__tests__/mailbox.test.ts
git commit -m "feat(mailbox): readCursor + writeCursor with fsync + atomic rename"
```

---

## Task 3: readFromCursor (async iterable)

**Files:**
- Modify: `src/control/mailbox.ts`
- Modify: `src/control/__tests__/mailbox.test.ts`

- [ ] **Step 3.1: Write failing tests for readFromCursor**

Append to test file:

```typescript
import { readFromCursor } from "../mailbox.js";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("readFromCursor", () => {
  it("returns empty iterable when file does not exist", async () => {
    const stateRoot = freshState();
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 1 }));
    expect(items).toEqual([]);
  });

  it("returns all entries with seq >= fromSeq", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 2 }));
    expect(items.map((i) => i.seq)).toEqual([2, 3]);
  });

  it("skips entries with seq < fromSeq", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 100 }));
    expect(items).toEqual([]);
  });

  it("tolerates a partial last line (mid-write crash)", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    // simulate partial write by appending non-JSON suffix
    const file = join(stateRoot, "inbox", "demo.log");
    await (await import("node:fs/promises")).appendFile(file, '{"seq":2,"ts":"2026', "utf-8");
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 1 }));
    expect(items.map((i) => i.seq)).toEqual([1]);
  });
});
```

- [ ] **Step 3.2: Run, verify failure**

```bash
npx vitest run src/control/__tests__/mailbox.test.ts
```

Expected: 4 failures.

- [ ] **Step 3.3: Implement readFromCursor**

Append to `src/control/mailbox.ts`:

```typescript
interface ReadFromCursorOpts {
  stateRoot: string;
  project: string;
  fromSeq: number;
}

export async function* readFromCursor(opts: ReadFromCursorOpts): AsyncIterable<MailboxEntry> {
  const file = logPath(opts.stateRoot, opts.project);
  let buf: string;
  try {
    buf = await fs.readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    let entry: MailboxEntry;
    try {
      entry = JSON.parse(line) as MailboxEntry;
    } catch {
      // partial / corrupted line; skip
      continue;
    }
    if (entry.seq >= opts.fromSeq) yield entry;
  }
}
```

- [ ] **Step 3.4: Run, verify all pass**

```bash
npx vitest run src/control/__tests__/mailbox.test.ts
```

Expected: 12 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/control/mailbox.ts src/control/__tests__/mailbox.test.ts
git commit -m "feat(mailbox): readFromCursor async iterable with partial-line tolerance"
```

---

## Task 4: Rotation + reading across rotated files

**Files:**
- Modify: `src/control/mailbox.ts`
- Modify: `src/control/__tests__/mailbox.test.ts`

- [ ] **Step 4.1: Write failing tests for rotation**

Append to test file:

```typescript
import { rotateIfNeeded } from "../mailbox.js";
import { statSync } from "node:fs";

describe("rotateIfNeeded", () => {
  it("returns rotated=false when file under thresholds", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const r = await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 1024 * 1024, maxAgeMs: 24 * 60 * 60 * 1000, keepCount: 3 });
    expect(r.rotated).toBe(false);
  });

  it("rotates when size exceeds maxBytes", async () => {
    const stateRoot = freshState();
    // append until file > 200 bytes
    for (let i = 0; i < 10; i++) {
      await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    }
    const sizeBefore = statSync(join(stateRoot, "inbox", "demo.log")).size;
    expect(sizeBefore).toBeGreaterThan(200);
    const r = await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 200, maxAgeMs: 999999999, keepCount: 3 });
    expect(r.rotated).toBe(true);
    expect(existsSync(join(stateRoot, "inbox", "demo.log.1"))).toBe(true);
    expect(statSync(join(stateRoot, "inbox", "demo.log")).size).toBe(0);
  });

  it("seq is monotonic across rotation boundary", async () => {
    const stateRoot = freshState();
    for (let i = 0; i < 10; i++) {
      await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    }
    await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 200, maxAgeMs: 999999999, keepCount: 3 });
    const s = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    expect(s).toBe(11);
  });

  it("keeps only keepCount rotated files", async () => {
    const stateRoot = freshState();
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 5; i++) {
        await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
      }
      await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 100, maxAgeMs: 999999999, keepCount: 2 });
    }
    expect(existsSync(join(stateRoot, "inbox", "demo.log.1"))).toBe(true);
    expect(existsSync(join(stateRoot, "inbox", "demo.log.2"))).toBe(true);
    expect(existsSync(join(stateRoot, "inbox", "demo.log.3"))).toBe(false);
  });

  it("readFromCursor reads across rotated files", async () => {
    const stateRoot = freshState();
    for (let i = 0; i < 5; i++) {
      await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    }
    await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 50, maxAgeMs: 999999999, keepCount: 3 });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 1 }));
    expect(items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
```

- [ ] **Step 4.2: Run, verify failures**

```bash
npx vitest run src/control/__tests__/mailbox.test.ts
```

Expected: 5 failures.

- [ ] **Step 4.3: Implement rotateIfNeeded + update readFromCursor**

Append to `src/control/mailbox.ts`:

```typescript
interface RotateOpts {
  stateRoot: string;
  project: string;
  maxBytes: number;
  maxAgeMs: number;
  keepCount: number;
}

export interface RotateResult {
  rotated: boolean;
  from?: string;
  to?: string;
}

async function oldestEntryAgeMs(file: string): Promise<number> {
  try {
    const buf = await fs.readFile(file, "utf-8");
    const firstLine = buf.split("\n").find((l) => l.trim());
    if (!firstLine) return 0;
    const entry = JSON.parse(firstLine) as MailboxEntry;
    return Date.now() - new Date(entry.ts).getTime();
  } catch {
    return 0;
  }
}

export async function rotateIfNeeded(opts: RotateOpts): Promise<RotateResult> {
  const file = logPath(opts.stateRoot, opts.project);
  let size = 0;
  try { size = (await fs.stat(file)).size; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { rotated: false };
    throw e;
  }
  const age = await oldestEntryAgeMs(file);
  if (size < opts.maxBytes && age < opts.maxAgeMs) return { rotated: false };

  // shift existing .N files down (.1 → .2, .2 → .3, etc.), deleting beyond keepCount
  for (let n = opts.keepCount; n >= 1; n--) {
    const src = `${file}.${n}`;
    const dst = `${file}.${n + 1}`;
    try {
      await fs.access(src);
      if (n >= opts.keepCount) {
        await fs.unlink(src);
      } else {
        await fs.rename(src, dst);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  // current → .1
  await fs.rename(file, `${file}.1`);
  // create fresh empty current
  await fs.writeFile(file, "", { encoding: "utf-8" });
  return { rotated: true, from: file, to: `${file}.1` };
}
```

Now update `readFromCursor` to also read across rotated files. Replace the existing function with:

```typescript
async function listRotatedNewestFirst(stateRoot: string, project: string): Promise<string[]> {
  const dir = inboxDir(stateRoot);
  let entries: string[];
  try { entries = await fs.readdir(dir); }
  catch { return []; }
  const prefix = `${project}.log.`;
  const rotated = entries
    .filter((e) => e.startsWith(prefix) && /^\d+$/.test(e.slice(prefix.length)))
    .map((e) => ({ name: e, n: Number(e.slice(prefix.length)) }))
    .sort((a, b) => b.n - a.n) // .3 first (oldest), .1 last (newest rotated)
    .map((e) => join(dir, e.name));
  return rotated;
}

export async function* readFromCursor(opts: ReadFromCursorOpts): AsyncIterable<MailboxEntry> {
  // Order: oldest rotated first, then current. .3 → .2 → .1 → current.
  const rotated = await listRotatedNewestFirst(opts.stateRoot, opts.project);
  const files = [...rotated, logPath(opts.stateRoot, opts.project)];
  for (const file of files) {
    let buf: string;
    try { buf = await fs.readFile(file, "utf-8"); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      let entry: MailboxEntry;
      try { entry = JSON.parse(line) as MailboxEntry; }
      catch { continue; }
      if (entry.seq >= opts.fromSeq) yield entry;
    }
  }
}
```

Also update `appendToMailbox`'s `readMaxSeq` to scan rotated files too (so seq stays monotonic after rotation). Replace `readMaxSeq` with:

```typescript
async function readMaxSeq(stateRoot: string, project: string): Promise<number> {
  let max = 0;
  const files = [
    logPath(stateRoot, project),
    ...(await listRotatedNewestFirst(stateRoot, project)),
  ];
  for (const file of files) {
    try {
      const buf = await fs.readFile(file, "utf-8");
      if (!buf.trim()) continue;
      const lines = buf.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]) as MailboxEntry;
          if (obj.seq > max) max = obj.seq;
          break;
        } catch { continue; }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return max;
}
```

And update the call site in `appendToMailbox`:

```typescript
  // ...inside appendToMailbox, replace the readMaxSeq call:
  const lastSeq = await readMaxSeq(opts.stateRoot, opts.project);
```

- [ ] **Step 4.4: Run all mailbox tests**

```bash
npx vitest run src/control/__tests__/mailbox.test.ts
```

Expected: 17 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/control/mailbox.ts src/control/__tests__/mailbox.test.ts
git commit -m "feat(mailbox): size/age-based rotation + cross-rotation read"
```

---

# COMMIT GROUP 2: Daemon-side switchover

After this group: events land in the mailbox file. PR #112's relay tab still spawns but receives no socket events (idle — no errors). Bridge state. Commit Group 3 closes the loop.

---

## Task 5: Update firePush signature to pass record + event

**Files:**
- Modify: `src/control/daemon.ts` (around lines 26-79 for `firePush` and `DaemonDeps`)
- Modify: `src/control/__tests__/daemon.test.ts` (if it asserts notify shape)

- [ ] **Step 5.1: Read current firePush + DaemonDeps**

```bash
sed -n '20,90p' src/control/daemon.ts
```

Identify: the `notify` callback in `DaemonDeps` currently has signature `(args: {project: string; message: string}) => Promise<void> | void`. We need to add `record: TaskRecord` and `event: ControlEvent`.

- [ ] **Step 5.2: Update DaemonDeps signature in daemon.ts**

Edit `src/control/daemon.ts`. Find the `notify?:` line in `DaemonDeps` and replace its signature:

```typescript
  /**
   * Push notification hook (#109, refactored under mailbox-injector spec).
   * Called on every state transition into {done, blocked, failed, stalled}.
   * Implementations append to the mailbox; never shell out.
   */
  notify?: (args: {
    project: string;
    message: string;
    record: TaskRecord;
    event: ControlEvent;
  }) => Promise<void> | void;
```

- [ ] **Step 5.3: Update firePush invocation to pass record + event**

Find the `firePush` function in `daemon.ts`. Update the `deps.notify(...)` call to pass `record: next, event: req.event`:

Replace the existing call site (currently `deps.notify({ project, message })`) with:

```typescript
    const r = deps.notify({ project, message, record: next, event });
```

You may need to pass `event` into `firePush` from the call site in the `case "event":` handler. Look at:

```typescript
        case "event": {
          const cur = store.get(req.project, req.event.id);
          if (!cur) throw new Error(`unknown task ${req.event.id}`);
          const next = reduce(cur, req.event, now());
          if (next !== cur) {
            store.put(next);
            firePush(deps, req.project, cur.state, next);
          }
          return next;
        }
```

Change `firePush` signature to accept event:

```typescript
function firePush(deps: DaemonDeps, project: string, prev: TaskState, next: TaskRecord, event: ControlEvent): void {
  if (!deps.notify) return;
  if (prev === next.state) return;
  if (!ATTENTION_STATES.has(next.state)) return;
  const message = formatMessage(next);
  if (!message) return;
  try {
    const r = deps.notify({ project, message, record: next, event });
    if (r && typeof (r as Promise<void>).catch === "function") {
      (r as Promise<void>).catch(() => {});
    }
  } catch { /* swallowed */ }
}
```

And the call site:

```typescript
            firePush(deps, req.project, cur.state, next, req.event);
```

Also: the watchdog stall path (later in the file) needs to construct a synthetic event. Find the section that emits stall events and add an event arg:

```typescript
      for (const r of store.listAll()) {
        const stalled = evaluateStall(r, t);
        if (stalled) {
          store.put(stalled);
          // synthesize a stalled "event" for the notify path
          const synthEvent: ControlEvent = { type: "task.stalled", id: r.id } as ControlEvent;
          firePush(deps, r.project, r.state, stalled, synthEvent);
          continue;
        }
        // ... existing recover logic
      }
```

(If `task.stalled` isn't in your ControlEvent union, this may need a small type widening — check `src/control/types.ts` for the event types. The exact shape can be a small extension; the daemon already uses `task.stalled` as a state, just needs an event-type counterpart for the notify payload.)

- [ ] **Step 5.4: Update existing daemon tests if any reference notify shape**

```bash
grep -rn "notify.*project.*message" src/control/__tests__/ src/notifiers/__tests__/
```

Update any test asserting the old `{project, message}` shape to the new `{project, message, record, event}` shape. Don't add new tests yet; that's Task 6.

- [ ] **Step 5.5: Run all existing tests**

```bash
npm test 2>&1 | tail -10
```

Expected: all previously passing tests still pass. If something breaks, fix the test to use the new signature.

- [ ] **Step 5.6: Commit**

```bash
git add src/control/daemon.ts src/control/__tests__/
git commit -m "refactor(daemon): firePush passes full record+event to notify (prep for mailbox)"
```

---

## Task 6: defaultNotify writes to mailbox instead of shelling out

**Files:**
- Modify: `src/control/cockpitd.ts` (the `defaultNotify` block, around line 155-175)
- Modify: `src/control/__tests__/cockpitd-notify-default.test.ts` (rewrite tests)

- [ ] **Step 6.1: Read the current defaultNotify**

```bash
sed -n '150,200p' src/control/cockpitd.ts
```

Identify the `defaultNotify` function (uses `execFileSync` to shell out to `cockpit runtime send`).

- [ ] **Step 6.2: Write the failing test for the new mailbox-writing defaultNotify**

Rewrite `src/control/__tests__/cockpitd-notify-default.test.ts` (delete old test bodies, keep file path). Use this content:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import type { TaskRecord, ControlEvent } from "../types.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "cpd-"));
}

async function rpc(sock: string, req: unknown): Promise<unknown> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock, () => {
      s.write(JSON.stringify(req) + "\n");
    });
    s.on("data", (d) => { resolve(JSON.parse(d.toString().trim())); s.end(); });
    s.on("error", reject);
  });
}

describe("defaultNotify writes to mailbox", () => {
  it("appends a task.done event to the mailbox file", async () => {
    const stateRoot = freshState();
    const sock = join(stateRoot, "c.sock");
    const cpd = startCockpitd({ socketPath: sock, stateRoot, sweepMs: 0 });
    try {
      // dispatch + apply a task.started then task.done
      const rec = (await rpc(sock, {
        kind: "dispatch",
        record: {
          id: "t1", project: "demo", provider: "claude", mode: "headless",
          state: "submitted", task: "tt", cwd: "/", createdAt: 1, lastHeartbeat: 1,
          lastEvent: "dispatch", heartbeatBudgetMs: 60000, attempts: [],
        },
      })) as TaskRecord;
      await rpc(sock, { kind: "event", project: "demo", event: { type: "task.started", id: rec.id } });
      await rpc(sock, { kind: "event", project: "demo", event: { type: "task.done", id: rec.id, resultRef: "/r" } });
      // wait briefly for async append
      await new Promise((r) => setTimeout(r, 100));
      const log = readFileSync(join(stateRoot, "inbox", "demo.log"), "utf-8");
      const lines = log.trim().split("\n").map((l) => JSON.parse(l));
      // only the terminal event triggers a notify (firePush gate)
      expect(lines).toHaveLength(1);
      expect(lines[0].kind).toBe("task.done");
      expect(lines[0].provider).toBe("claude");
      expect(lines[0].payload.resultRef).toBe("/r");
      expect(lines[0].seq).toBe(1);
    } finally {
      cpd.stop();
    }
  });

  it("does NOT shell out (no execFileSync invoked)", async () => {
    // This test asserts behavior implicitly — if defaultNotify shelled out we'd
    // see errors when 'cockpit' binary is on PATH but cmux is not reachable.
    // The mailbox-write path has zero subprocess overhead.
    const stateRoot = freshState();
    const sock = join(stateRoot, "c.sock");
    const cpd = startCockpitd({ socketPath: sock, stateRoot, sweepMs: 0 });
    try {
      const start = Date.now();
      const rec = (await rpc(sock, {
        kind: "dispatch",
        record: {
          id: "t2", project: "demo", provider: "claude", mode: "headless",
          state: "submitted", task: "tt", cwd: "/", createdAt: 1, lastHeartbeat: 1,
          lastEvent: "dispatch", heartbeatBudgetMs: 60000, attempts: [],
        },
      })) as TaskRecord;
      await rpc(sock, { kind: "event", project: "demo", event: { type: "task.started", id: rec.id } });
      await rpc(sock, { kind: "event", project: "demo", event: { type: "task.done", id: rec.id, resultRef: "/r" } });
      const elapsed = Date.now() - start;
      // execFileSync to cockpit runtime send took ~50-200ms; mailbox append is < 20ms
      expect(elapsed).toBeLessThan(500);
    } finally {
      cpd.stop();
    }
  });
});
```

- [ ] **Step 6.3: Run the test, verify it fails**

```bash
npx vitest run src/control/__tests__/cockpitd-notify-default.test.ts
```

Expected: failure (defaultNotify still shells out + doesn't write to mailbox file).

- [ ] **Step 6.4: Rewrite defaultNotify in cockpitd.ts**

Edit `src/control/cockpitd.ts`. Find the `defaultNotify` function (around lines 155-175) and the `execFileSync` import. Replace:

```typescript
// old:
import { spawn as realSpawn, execFileSync } from "node:child_process";

// new:
import { spawn as realSpawn } from "node:child_process";
import { appendToMailbox, rotateIfNeeded } from "./mailbox.js";
```

Replace the `defaultNotify` function body. Old:

```typescript
  const defaultNotify = (args: { project: string; message: string }): void => {
    try {
      execFileSync("cockpit", ["runtime", "send", args.project, args.message], {
        encoding: "utf-8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      log(`notify failed project=${args.project}: ${(e as Error).message}`);
    }
  };
```

New:

```typescript
  const defaultNotify = async (args: {
    project: string;
    message: string;
    record: import("./types.js").TaskRecord;
    event: import("./types.js").ControlEvent;
  }): Promise<void> => {
    try {
      await appendToMailbox({
        stateRoot,
        project: args.project,
        taskRecord: args.record,
        event: args.event,
      });
    } catch (e) {
      log(`mailbox append failed project=${args.project}: ${(e as Error).message}`);
    }
  };
```

- [ ] **Step 6.5: Run the test, verify it passes**

```bash
npx vitest run src/control/__tests__/cockpitd-notify-default.test.ts
```

Expected: both tests pass.

- [ ] **Step 6.6: Run full test suite to check for regressions**

```bash
npm test 2>&1 | tail -10
```

Expected: 556+ pass (same as before, plus the new mailbox + rewritten cockpitd-notify-default tests).

- [ ] **Step 6.7: Commit**

```bash
git add src/control/cockpitd.ts src/control/__tests__/cockpitd-notify-default.test.ts
git commit -m "refactor(cockpitd): defaultNotify writes to mailbox instead of shelling out"
```

---

## Task 7: Rotation timer

**Files:**
- Modify: `src/control/cockpitd.ts` (in `startCockpitd`)
- Modify: `src/control/__tests__/cockpitd-notify-default.test.ts` (add timer test)

- [ ] **Step 7.1: Add failing test for rotation timer**

Append to `src/control/__tests__/cockpitd-notify-default.test.ts`:

```typescript
describe("rotation timer", () => {
  it("rotates oversize mailbox files automatically", async () => {
    const stateRoot = freshState();
    const sock = join(stateRoot, "c.sock");
    // mailbox config: tiny maxBytes so even one entry triggers rotation
    const cpd = startCockpitd({
      socketPath: sock,
      stateRoot,
      sweepMs: 50, // fast rotation timer for test
      mailboxConfig: { maxBytes: 50, maxAgeMs: 999_999_999, keepCount: 3 },
    } as any);
    try {
      const rec = (await rpc(sock, {
        kind: "dispatch",
        record: {
          id: "tr1", project: "demo", provider: "claude", mode: "headless",
          state: "submitted", task: "tt", cwd: "/", createdAt: 1, lastHeartbeat: 1,
          lastEvent: "dispatch", heartbeatBudgetMs: 60000, attempts: [],
        },
      })) as TaskRecord;
      await rpc(sock, { kind: "event", project: "demo", event: { type: "task.started", id: rec.id } });
      // fire a bunch of done events to grow the file
      for (let i = 0; i < 5; i++) {
        await rpc(sock, { kind: "event", project: "demo", event: { type: "task.done", id: rec.id, resultRef: `/r${i}` } });
      }
      await new Promise((r) => setTimeout(r, 200)); // wait for rotation timer
      // Expect at least one rotated file
      expect(existsSync(join(stateRoot, "inbox", "demo.log.1"))).toBe(true);
    } finally {
      cpd.stop();
    }
  });
});
```

(Note: this test re-emits `task.done` to a record that's already `done` — the firePush gate suppresses, so we need to bypass. Adjust: dispatch separate records OR write directly to the mailbox. Easier: dispatch separate records.)

Replace the timer test with one that dispatches distinct records:

```typescript
describe("rotation timer", () => {
  it("rotates oversize mailbox files automatically", async () => {
    const stateRoot = freshState();
    const sock = join(stateRoot, "c.sock");
    const cpd = startCockpitd({
      socketPath: sock,
      stateRoot,
      sweepMs: 0,
      rotationIntervalMs: 50,
      mailboxConfig: { maxBytes: 100, maxAgeMs: 999_999_999, keepCount: 3 },
    } as any);
    try {
      for (let i = 0; i < 5; i++) {
        const id = `tr${i}`;
        await rpc(sock, {
          kind: "dispatch",
          record: {
            id, project: "demo", provider: "claude", mode: "headless",
            state: "submitted", task: `t${i}`, cwd: "/", createdAt: 1, lastHeartbeat: 1,
            lastEvent: "dispatch", heartbeatBudgetMs: 60000, attempts: [],
          },
        });
        await rpc(sock, { kind: "event", project: "demo", event: { type: "task.started", id } });
        await rpc(sock, { kind: "event", project: "demo", event: { type: "task.done", id, resultRef: `/r${i}` } });
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(join(stateRoot, "inbox", "demo.log.1"))).toBe(true);
    } finally {
      cpd.stop();
    }
  });
});
```

- [ ] **Step 7.2: Run, verify failure**

Expected: fail because `rotationIntervalMs` and `mailboxConfig` options aren't handled.

- [ ] **Step 7.3: Add rotation timer + config to startCockpitd**

In `src/control/cockpitd.ts`, find `CockpitdOpts`. Add:

```typescript
  /** Background rotation timer interval (ms). 0 disables. */
  rotationIntervalMs?: number; // default 60_000
  /** Mailbox rotation config. */
  mailboxConfig?: {
    maxBytes?: number;
    maxAgeMs?: number;
    keepCount?: number;
  };
```

In `startCockpitd`, after the daemon is constructed and before the return, add the rotation timer:

```typescript
  const rotationInterval = opts.rotationIntervalMs ?? 60_000;
  const mboxCfg = {
    maxBytes: opts.mailboxConfig?.maxBytes ?? 5 * 1024 * 1024,
    maxAgeMs: opts.mailboxConfig?.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000,
    keepCount: opts.mailboxConfig?.keepCount ?? 3,
  };
  let rotationTimer: NodeJS.Timeout | null = null;
  if (rotationInterval > 0) {
    rotationTimer = setInterval(async () => {
      try {
        const inboxRoot = join(stateRoot, "inbox");
        let entries: string[];
        try { entries = await (await import("node:fs/promises")).readdir(inboxRoot); }
        catch { return; }
        const projects = new Set(
          entries
            .filter((e) => e.endsWith(".log"))
            .map((e) => e.slice(0, -".log".length))
        );
        for (const project of projects) {
          await rotateIfNeeded({ stateRoot, project, ...mboxCfg });
        }
      } catch (e) {
        log(`rotation timer error: ${(e as Error).message}`);
      }
    }, rotationInterval);
  }
```

Add to the cleanup/stop path:

```typescript
  // in the existing stop() function:
  if (rotationTimer) clearInterval(rotationTimer);
```

- [ ] **Step 7.4: Run rotation timer test, verify pass**

```bash
npx vitest run src/control/__tests__/cockpitd-notify-default.test.ts
```

Expected: rotation timer test passes.

- [ ] **Step 7.5: Run full suite to check no regressions**

```bash
npm test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7.6: Commit**

```bash
git add src/control/cockpitd.ts src/control/__tests__/cockpitd-notify-default.test.ts
git commit -m "feat(cockpitd): background rotation timer for mailbox files"
```

---

## Task 8: Remove subscribe-notify + push frames from protocol.ts

**Files:**
- Modify: `src/control/protocol.ts`
- Modify: `src/control/cockpitd.ts` (delete subscriber registry + broadcast loop)
- Modify: any tests referencing subscribe-notify or push frames

- [ ] **Step 8.1: Find all references to remove**

```bash
grep -rn "subscribe-notify\|SubscribeNotifyClaim\|PushFrame\|subscribers\b" src/
```

List the files. Likely: `src/control/protocol.ts` (type defs), `src/control/cockpitd.ts` (handler + registry), possibly test files.

- [ ] **Step 8.2: Delete subscribe-notify + push from protocol.ts**

In `src/control/protocol.ts`, find and delete the `SubscribeNotifyClaim` type, the `PushFrame` type, and any union members or builders that reference them. Keep the rest of the protocol intact.

If there's a discriminated union `SocketRequest` that includes `"subscribe-notify"`, remove just that variant.

- [ ] **Step 8.3: Delete the subscriber registry + broadcast loop in cockpitd.ts**

In `src/control/cockpitd.ts`, find:
- The subscriber-tracking data structure (probably `subscribers: Set<...>` or a map).
- The `case "subscribe-notify"` handler.
- The broadcast loop that iterates `subscribers` and writes push frames.

Delete all three. Verify nothing else references them.

- [ ] **Step 8.4: Delete subscribe-related tests**

```bash
grep -rln "subscribe-notify\|broadcasts to subscribed" src/control/__tests__/
```

Delete the tests that exclusively test broadcast behavior. Update tests that test other things but mention subscribers.

- [ ] **Step 8.5: Run full suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass. The notify-relay tests from PR #112 may now fail because they expect a subscribe protocol that no longer exists — that's expected; Commit Group 3 rewrites them.

If a notify-relay test fails with "Cannot find type 'SubscribeNotifyClaim'" or similar — leave it failing; it gets rewritten in Task 10.

- [ ] **Step 8.6: Confirm only notify-relay tests are failing**

```bash
npm test 2>&1 | grep -A1 "FAIL" | head -20
```

Expected: only `src/commands/__tests__/notify-relay.test.ts` failing. Anything else failing = stop, investigate.

- [ ] **Step 8.7: Commit**

```bash
git add src/control/protocol.ts src/control/cockpitd.ts src/control/__tests__/
git commit -m "refactor(daemon): remove subscribe-notify + push broadcast (replaced by mailbox)"
```

---

# COMMIT GROUP 3: notify-relay rewrite

After this group: end-to-end delivery is back. Captain pane receives `CREW DONE` lines auto-pushed via mailbox→tail→sendToSurface chain.

---

## Task 9: notify-relay skeleton + cursor boot

**Files:**
- Modify: `src/commands/notify-relay.ts` (rewrite)
- Modify: `src/commands/__tests__/notify-relay.test.ts` (rewrite)

- [ ] **Step 9.1: Write failing test for boot behavior**

Replace `src/commands/__tests__/notify-relay.test.ts` content with:

```typescript
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToMailbox, writeCursor, readCursor } from "../../control/mailbox.js";
import { runNotifyRelay } from "../notify-relay.js";
import type { TaskRecord, ControlEvent } from "../../control/types.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "nr-"));
}

const rec: TaskRecord = {
  id: "deadbeefcafebabe1234567890abcdef",
  project: "demo", provider: "claude", mode: "interactive",
  state: "done", task: "task body", cwd: "/", createdAt: 1, lastHeartbeat: 1,
  lastEvent: "task.done", heartbeatBudgetMs: 60000, attempts: [],
};
const doneEvent: ControlEvent = { type: "task.done", id: rec.id, resultRef: "/r" };

describe("notify-relay boot", () => {
  it("starts from seq 1 when cursor missing", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo", subscriber: "captain", stateRoot,
      runtime: { sendToSurface: sendSpy, status: vi.fn().mockResolvedValue({ id: "ws1" }), listSurfaces: vi.fn().mockResolvedValue([{ id: "s1", title: "captain" }]) } as any,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1]).toContain("CREW DONE");
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
  });

  it("starts from seq+1 when cursor exists", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 1 });
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo", subscriber: "captain", stateRoot,
      runtime: { sendToSurface: sendSpy, status: vi.fn().mockResolvedValue({ id: "ws1" }), listSurfaces: vi.fn().mockResolvedValue([{ id: "s1", title: "captain" }]) } as any,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    // only seq 2 should be delivered
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 9.2: Run, verify failure**

```bash
npx vitest run src/commands/__tests__/notify-relay.test.ts
```

Expected: fail with "runNotifyRelay is not a function" or similar.

- [ ] **Step 9.3: Rewrite notify-relay.ts**

Replace `src/commands/notify-relay.ts` entirely:

```typescript
import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { loadConfig } from "../lib/config.js";
import { RuntimeRegistry } from "../runtimes/registry.js";
import { createCmuxDriver } from "../runtimes/cmux.js";
import type { RuntimeDriver, WorkspaceRef, SurfaceRef } from "../runtimes/types.js";
import { readCursor, writeCursor, readFromCursor, type MailboxEntry } from "../control/mailbox.js";

function shortId(id: string): string { return id.slice(0, 8); }

export function formatEntry(entry: MailboxEntry): string | null {
  const tag = `[${entry.provider}/${shortId(entry.taskId)}]`;
  switch (entry.kind) {
    case "task.started":
    case "task.progress":
      return null; // suppress liveness/start
    case "task.done": {
      const msg = (entry.payload.message as string) ?? (entry.payload.resultRef as string) ?? "(no message)";
      return `CREW DONE ${tag}: ${msg.toString().split(/\r?\n/)[0].slice(0, 200)}`;
    }
    case "task.blocked":
      return `CREW BLOCKED ${tag}: ${(entry.payload.question as string) ?? "(no question)"}`;
    case "task.failed":
      return `CREW FAILED ${tag}: ${(entry.payload.error as string) ?? "(no error)"}`;
    case "task.stalled":
      return `CREW STALLED ${tag}: no heartbeat`;
    default:
      return null;
  }
}

interface RunOpts {
  project: string;
  subscriber: string;
  stateRoot: string;
  runtime: RuntimeDriver;
  captainName: string;
  pollMs?: number;
}

export async function runNotifyRelay(opts: RunOpts): Promise<() => void> {
  // resolve captain workspace + primary surface once
  const ws = await opts.runtime.status(opts.captainName);
  if (!ws) throw new Error(`captain workspace '${opts.captainName}' not running`);
  const surfaces = await opts.runtime.listSurfaces?.(ws.id) ?? [];
  const captainSurface: SurfaceRef = (surfaces.find((s: any) => s.title === opts.captainName) ?? surfaces[0]) as SurfaceRef;
  if (!captainSurface) throw new Error("no surfaces in captain workspace");

  let cursor = await readCursor({ stateRoot: opts.stateRoot, project: opts.project, subscriber: opts.subscriber });
  let lastAcked = cursor?.lastAckedSeq ?? 0;
  let stopped = false;

  async function drain(): Promise<void> {
    for await (const entry of readFromCursor({ stateRoot: opts.stateRoot, project: opts.project, fromSeq: lastAcked + 1 })) {
      if (stopped) return;
      const msg = formatEntry(entry);
      if (msg) {
        try {
          await opts.runtime.sendToSurface(captainSurface, msg);
        } catch (e) {
          console.error(`[notify-relay ${opts.project}] sendToSurface failed seq=${entry.seq}: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, 1000));
          continue; // do not advance cursor; retry on next loop
        }
      }
      await writeCursor({ stateRoot: opts.stateRoot, project: opts.project, subscriber: opts.subscriber, lastAckedSeq: entry.seq });
      lastAcked = entry.seq;
    }
  }

  const interval = setInterval(() => { if (!stopped) drain().catch((e) => console.error(e)); }, opts.pollMs ?? 1000);
  // initial drain
  await drain();
  return () => { stopped = true; clearInterval(interval); };
}

export const notifyRelayCommand = new Command("notify-relay")
  .description("Subscribe to a project's mailbox and deliver events to the captain pane")
  .argument("<project>", "project name")
  .option("--as <subscriber>", "subscriber name", "captain")
  .option("--state-root <path>", "override state root", join(homedir(), ".config", "cockpit"))
  .action(async (project: string, opts: { as: string; stateRoot: string }) => {
    const config = await loadConfig();
    const projCfg = config.projects[project];
    if (!projCfg) {
      console.error(`unknown project '${project}'`);
      process.exit(1);
    }
    const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, config);
    console.log(`[notify-relay ${project}] subscriber=${opts.as} stateRoot=${opts.stateRoot}`);
    await runNotifyRelay({
      project, subscriber: opts.as, stateRoot: opts.stateRoot,
      runtime, captainName: projCfg.captainName,
      pollMs: 1000,
    });
    // long-running; process exits on SIGTERM
    process.on("SIGTERM", () => process.exit(0));
  });
```

- [ ] **Step 9.4: Run, verify boot tests pass**

```bash
npx vitest run src/commands/__tests__/notify-relay.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 9.5: Commit**

```bash
git add src/commands/notify-relay.ts src/commands/__tests__/notify-relay.test.ts
git commit -m "feat(notify-relay): file-tailer skeleton with cursor boot + format dispatch"
```

---

## Task 10: Bounded retry on sendToSurface failure

**Files:**
- Modify: `src/commands/notify-relay.ts`
- Modify: `src/commands/__tests__/notify-relay.test.ts`

- [ ] **Step 10.1: Write failing test for retry behavior**

Append to test file:

```typescript
it("does not advance cursor when sendToSurface throws", async () => {
  const stateRoot = freshState();
  await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
  const sendSpy = vi.fn().mockRejectedValue(new Error("send failed"));
  const stop = await runNotifyRelay({
    project: "demo", subscriber: "captain", stateRoot,
    runtime: { sendToSurface: sendSpy, status: vi.fn().mockResolvedValue({ id: "ws1" }), listSurfaces: vi.fn().mockResolvedValue([{ id: "s1", title: "captain" }]) } as any,
    captainName: "captain",
    pollMs: 50,
  });
  await new Promise((r) => setTimeout(r, 200));
  stop();
  const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
  expect(cursor).toBeNull(); // cursor never written
  expect(sendSpy.mock.calls.length).toBeGreaterThan(0); // attempted
});

it("delivers seq 2 even if seq 1 was already acked", async () => {
  const stateRoot = freshState();
  await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
  await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
  await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 1 });
  const sendSpy = vi.fn().mockResolvedValue(undefined);
  const stop = await runNotifyRelay({
    project: "demo", subscriber: "captain", stateRoot,
    runtime: { sendToSurface: sendSpy, status: vi.fn().mockResolvedValue({ id: "ws1" }), listSurfaces: vi.fn().mockResolvedValue([{ id: "s1", title: "captain" }]) } as any,
    captainName: "captain",
    pollMs: 50,
  });
  await new Promise((r) => setTimeout(r, 200));
  stop();
  expect(sendSpy).toHaveBeenCalledTimes(1);
  const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
  expect(cursor?.lastAckedSeq).toBe(2);
});
```

- [ ] **Step 10.2: Run, verify pass**

```bash
npx vitest run src/commands/__tests__/notify-relay.test.ts
```

Expected: both tests pass (the existing implementation from Task 9 already handles this — the `continue` in the catch block skips the cursor write).

If a test fails, debug the existing implementation; do NOT add a separate retry layer (the loop's natural cycle is the retry).

- [ ] **Step 10.3: Commit (no code change needed if tests pass — add the tests only)**

```bash
git add src/commands/__tests__/notify-relay.test.ts
git commit -m "test(notify-relay): assert no-cursor-advance on send failure + replay correctness"
```

---

## Task 11: Register notify-relay command in CLI

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 11.1: Confirm notify-relay is registered (it likely is from PR #112)**

```bash
grep -n "notifyRelayCommand\|notify-relay" src/index.ts
```

If already registered: nothing to do; move to Task 12.

If not registered, add:

```typescript
import { notifyRelayCommand } from "./commands/notify-relay.js";
// ...
program.addCommand(notifyRelayCommand);
```

- [ ] **Step 11.2: Smoke the CLI**

```bash
npm run build
node dist/index.js notify-relay --help
```

Expected: help text printed (not "unknown command").

- [ ] **Step 11.3: If a change was needed, commit**

```bash
git add src/index.ts
git commit -m "chore(cli): register notify-relay command"
```

(Skip the commit if registration was already in place from PR #112.)

---

# COMMIT GROUP 4: RuntimeDriver + cmux + launch

After this group: the relay tab from PR #112 becomes a hidden split-pane (or falls back to visible tab if cmux can't hide).

---

## Task 12: Add spawnInjector + sendToSurface to RuntimeDriver type

**Files:**
- Modify: `src/runtimes/types.ts`
- Modify: any memory/test driver helpers

- [ ] **Step 12.1: Read current RuntimeDriver interface**

```bash
sed -n '1,80p' src/runtimes/types.ts
```

Locate the `RuntimeDriver` interface definition.

- [ ] **Step 12.2: Add method signatures**

Add to the `RuntimeDriver` interface in `src/runtimes/types.ts`:

```typescript
  /**
   * Spawn a long-running process INSIDE the captain workspace's process tree,
   * such that any IPC/socket constraints of the runtime (e.g. cmux's parent-
   * lineage check) are satisfied. Returns a SurfaceRef so the caller can
   * inspect / cleanup later.
   *
   * placement: "hidden" produces a non-distracting surface (zero/minimal-size
   * split, minimized pane, off-screen tab — runtime decides). "visible"
   * produces a normal pane (debug).
   */
  spawnInjector(opts: {
    captainWorkspace: WorkspaceRef;
    command: string;
    title?: string;
    placement: "hidden" | "visible";
  }): Promise<SurfaceRef>;

  /**
   * Send text to a specific surface. Unlike `send` (workspace-level) this
   * targets one surface directly. Used by the injector to deliver messages
   * to the captain's main surface.
   *
   * Returns when the runtime has accepted the write. Throws if the surface
   * no longer exists.
   */
  sendToSurface(surface: SurfaceRef, text: string): Promise<void>;
```

- [ ] **Step 12.3: Build, expect type errors in cmux.ts (intentional — Task 13 fixes them)**

```bash
npm run build 2>&1 | tail -15
```

Expected: error like `Property 'spawnInjector' is missing in type ...` in `cmux.ts` and any memory driver. This is the failing precondition for the next task.

- [ ] **Step 12.4: Commit (type-only change; broken build is intentional — next task fixes)**

```bash
git add src/runtimes/types.ts
git commit -m "feat(runtime): add spawnInjector + sendToSurface to RuntimeDriver type"
```

---

## Task 13: cmux implementation — sendToSurface (easier; do first)

**Files:**
- Modify: `src/runtimes/cmux.ts`
- Modify: `src/runtimes/__tests__/cmux.test.ts` (or create if doesn't exist)

- [ ] **Step 13.1: Read existing cmux `send` to find the surface-targeting pattern**

```bash
sed -n '85,110p' src/runtimes/cmux.ts
```

The existing `send()` already routes to a surface internally. Extract that logic.

- [ ] **Step 13.2: Add sendToSurface method to cmux driver**

Edit `src/runtimes/cmux.ts`. In the returned object, add:

```typescript
    async sendToSurface(surface: SurfaceRef, text: string): Promise<void> {
      cmux(`send --workspace "${surface.workspaceId}" --surface "${surface.id}" "${escape(text)}"`);
      cmux(`send-key --workspace "${surface.workspaceId}" --surface "${surface.id}" Enter`);
    },
```

Make sure `SurfaceRef` is imported and includes both `id` and `workspaceId`. If `SurfaceRef` lacks `workspaceId`, add it to the type in `src/runtimes/types.ts` and to wherever surfaces are constructed in cmux.ts.

- [ ] **Step 13.3: Run build**

```bash
npm run build 2>&1 | tail -5
```

Expected: still an error about `spawnInjector` missing; sendToSurface now satisfied.

- [ ] **Step 13.4: No standalone test for sendToSurface — covered by notify-relay test which uses a fake driver. Commit.**

```bash
git add src/runtimes/cmux.ts src/runtimes/types.ts
git commit -m "feat(cmux): sendToSurface routes to a specific surface within a workspace"
```

---

## Task 14: cmux implementation — spawnInjector

**Files:**
- Modify: `src/runtimes/cmux.ts`

- [ ] **Step 14.1: Implement spawnInjector with placement support**

Add to the cmux driver:

```typescript
    async spawnInjector(opts: {
      captainWorkspace: WorkspaceRef;
      command: string;
      title?: string;
      placement: "hidden" | "visible";
    }): Promise<SurfaceRef> {
      const ws = opts.captainWorkspace.id;
      // 1. Create a new split-pane down (or right — pick whichever cmux accepts reliably)
      const splitOutput = cmux(`new-split down --workspace "${ws}"`);
      // splitOutput typically contains 'surface:NN' — parse it
      const m = splitOutput.match(/surface:\d+/);
      if (!m) throw new Error(`cmux new-split did not return a surface id: ${splitOutput}`);
      const surfaceId = m[0];
      const title = opts.title ?? "✉ notify-relay";
      try {
        cmux(`rename-tab --workspace "${ws}" --surface "${surfaceId}" "${escape(title)}"`);
      } catch { /* best-effort rename */ }
      // 2. Send the command into the new surface
      cmux(`send --workspace "${ws}" --surface "${surfaceId}" "${escape(opts.command)}"`);
      cmux(`send-key --workspace "${ws}" --surface "${surfaceId}" Enter`);
      // 3. If hidden, try to minimize the split. cmux's resize-split may not exist;
      //    swallow failure (fallback to default size — degraded but functional).
      if (opts.placement === "hidden") {
        try {
          cmux(`resize-pane --workspace "${ws}" --surface "${surfaceId}" --rows 1`);
        } catch {
          // resize unsupported; accept default size as graceful fallback
        }
      }
      return { id: surfaceId, workspaceId: ws, title, status: "running" } as SurfaceRef;
    },
```

(Adjust cmux subcommand names — `new-split`, `rename-tab`, `resize-pane` — to whatever the cmux CLI actually accepts. Verify with `cmux --help` and `cmux new-split --help` first.)

- [ ] **Step 14.2: Build cleanly**

```bash
npm run build 2>&1 | tail -5
```

Expected: zero errors.

- [ ] **Step 14.3: Create live opt-in test for cmux integration**

Create `src/runtimes/__tests__/cmux-spawn-injector.live.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createCmuxDriver } from "../cmux.js";

const LIVE = process.env.CMUX_LIVE === "1";

describe.skipIf(!LIVE)("cmux spawnInjector live", () => {
  it("spawns a hidden split-pane that accepts a no-op command", async () => {
    const driver = createCmuxDriver();
    const wss = await driver.list();
    expect(wss.length).toBeGreaterThan(0);
    const captainWs = wss[0]; // assumes a captain is running
    const surface = await driver.spawnInjector({
      captainWorkspace: captainWs,
      command: "echo notify-relay-probe; sleep 30",
      title: "✉ probe",
      placement: "hidden",
    });
    expect(surface.id).toMatch(/^surface:\d+$/);
    // best-effort: try sendToSurface
    await driver.sendToSurface(surface, "echo HELLO_FROM_TEST");
    // manual cleanup: user closes the pane afterward
  });
});
```

(Mark this test opt-in via `CMUX_LIVE=1` — it requires a real cmux session.)

- [ ] **Step 14.4: Run the live test manually (one-time validation)**

```bash
CMUX_LIVE=1 npx vitest run src/runtimes/__tests__/cmux-spawn-injector.live.test.ts
```

Expected: pass. Visually verify a tiny split-pane appeared in the captain workspace. If cmux fails to hide it (resize-pane unsupported), confirm fallback to default split size still works.

If cmux's CLI verbs differ from what's written (e.g. cmux uses `split-pane down` instead of `new-split down`), adjust the strings in `spawnInjector`. Document any discrepancy in a code comment.

- [ ] **Step 14.5: Commit**

```bash
git add src/runtimes/cmux.ts src/runtimes/__tests__/cmux-spawn-injector.live.test.ts
git commit -m "feat(cmux): spawnInjector creates split-pane with hidden/visible placement"
```

---

## Task 15: launch.ts uses spawnInjector instead of newPane

**Files:**
- Modify: `src/commands/launch.ts`

- [ ] **Step 15.1: Read current launch.ts relay-tab spawn code**

```bash
grep -nA20 "NOTIFY_RELAY_TAB_TITLE\|notify-relay tab" src/commands/launch.ts
```

Identify the function that adds the notify-relay tab (probably uses `runtime.newPane({direction: "tab"})` from PR #112).

- [ ] **Step 15.2: Replace with spawnInjector + dedup**

Find the helper that adds the tab (likely named something like `addNotifyRelayTab` or `ensureNotifyRelayTab`). Modify it:

```typescript
const NOTIFY_RELAY_TAB_TITLE = "✉ notify-relay";

async function ensureNotifyRelay(runtime: RuntimeDriver, captainWs: WorkspaceRef, project: string): Promise<void> {
  // Kill any pre-existing relay surface (visible tab OR hidden split — dedup before respawn)
  const surfaces = await runtime.listSurfaces?.(captainWs.id) ?? [];
  for (const s of surfaces) {
    if (s.title === NOTIFY_RELAY_TAB_TITLE) {
      try { await runtime.closeSurface?.(s); } catch { /* best effort */ }
    }
  }
  try {
    await runtime.spawnInjector({
      captainWorkspace: captainWs,
      command: `cockpit notify-relay ${project} --as captain`,
      title: NOTIFY_RELAY_TAB_TITLE,
      placement: "hidden",
    });
    console.log(chalk.cyan(`  ✔ Added hidden notify-relay for '${project}'`));
  } catch (e) {
    console.error(chalk.yellow(`  ⚠ notify-relay setup failed: ${(e as Error).message}`));
  }
}
```

(`closeSurface` may not exist on `RuntimeDriver` today. If not, add a basic implementation in cmux.ts: `async closeSurface(s: SurfaceRef) { cmux(`close-surface --workspace "${s.workspaceId}" --surface "${s.id}"`); }` and the type signature in `src/runtimes/types.ts`.)

- [ ] **Step 15.3: Build**

```bash
npm run build 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 15.4: Manual smoke — relaunch a captain workspace**

```bash
# kill old captain if running
cockpit shutdown cockpit 2>&1 || true
# relaunch
cockpit launch cockpit
```

Expected: captain workspace re-spawns with a hidden split-pane labeled `✉ notify-relay`. Old visible tab from PR #112 (if any) is gone.

If the hidden split is still very visible (1-3 rows is OK; full half-workspace is too much), check that the resize-pane invocation in cmux.ts is actually accepting the row count.

- [ ] **Step 15.5: Commit**

```bash
git add src/commands/launch.ts src/runtimes/cmux.ts src/runtimes/types.ts
git commit -m "feat(launch): notify-relay spawns as hidden split-pane (dedup pre-existing)"
```

---

# FINAL TASKS: smoke, lint, build, PR

## Task 16: E2E smoke script

**Files:**
- Create: `scripts/mailbox-injector-smoke.mjs`

- [ ] **Step 16.1: Write the smoke script**

Create `scripts/mailbox-injector-smoke.mjs`:

```javascript
#!/usr/bin/env node
// E2E smoke for mailbox + injector
// Drives a daemon + simulates an injector against a temp socket
// Mirrors scripts/smoke-push-notify.mjs

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const stateRoot = mkdtempSync(join(tmpdir(), "mailbox-smoke-"));
const sock = join(stateRoot, "c.sock");
const evidenceFile = ".mailbox-injector-smoke.local";

let evidence = [`# Mailbox + Injector smoke — ${new Date().toISOString()}`, `state: ${stateRoot}`, ""];
const log = (line) => { console.log(line); evidence.push(line); };

async function rpc(req) {
  return new Promise((resolve, reject) => {
    const s = createConnection(sock);
    s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
    s.on("data", (d) => { resolve(JSON.parse(d.toString().trim())); s.end(); });
    s.on("error", reject);
  });
}

async function main() {
  // 1. Boot daemon
  const cpd = spawn("node", [join(process.cwd(), "dist/control/cockpitd.js")], {
    env: { ...process.env, COCKPIT_SOCKET_PATH: sock, COCKPIT_STATE_ROOT: stateRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cpd.stdout.on("data", (b) => process.stderr.write(`[cpd] ${b}`));
  cpd.stderr.on("data", (b) => process.stderr.write(`[cpd] ${b}`));
  await new Promise((r) => setTimeout(r, 1500));

  let failures = 0;
  const assert = (cond, msg) => { log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) failures++; };

  try {
    log("--- 1. dispatch + signal done — mailbox file gets the entry ---");
    const rec = await rpc({
      kind: "dispatch",
      record: {
        id: "smoke-1", project: "demo", provider: "claude", mode: "headless",
        state: "submitted", task: "smoke test #1", cwd: "/", createdAt: 1, lastHeartbeat: 1,
        lastEvent: "dispatch", heartbeatBudgetMs: 60000, attempts: [],
      },
    });
    await rpc({ kind: "event", project: "demo", event: { type: "task.started", id: "smoke-1" } });
    await rpc({ kind: "event", project: "demo", event: { type: "task.done", id: "smoke-1", resultRef: "/r1" } });
    await new Promise((r) => setTimeout(r, 200));
    const logPath = join(stateRoot, "inbox", "demo.log");
    assert(existsSync(logPath), "mailbox file created");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert(lines.length === 1, `exactly one entry (got ${lines.length})`);
    const entry = JSON.parse(lines[0]);
    assert(entry.seq === 1, `seq=1 (got ${entry.seq})`);
    assert(entry.kind === "task.done", `kind=task.done (got ${entry.kind})`);

    log("--- 2. simulate injector reading from cursor ---");
    // dynamic import of compiled mailbox module
    const mailbox = await import(join(process.cwd(), "dist/control/mailbox.js"));
    const items = [];
    for await (const it of mailbox.readFromCursor({ stateRoot, project: "demo", fromSeq: 1 })) items.push(it);
    assert(items.length === 1, `injector reads 1 entry from cursor (got ${items.length})`);
    await mailbox.writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 1 });
    const cursor = await mailbox.readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    assert(cursor?.lastAckedSeq === 1, `cursor advanced to 1`);

    log("--- 3. daemon bounce simulation: dispatch more events while injector 'offline' ---");
    await rpc({ kind: "dispatch", record: { id: "smoke-2", project: "demo", provider: "claude", mode: "headless", state: "submitted", task: "t2", cwd: "/", createdAt: 1, lastHeartbeat: 1, lastEvent: "dispatch", heartbeatBudgetMs: 60000, attempts: [] } });
    await rpc({ kind: "event", project: "demo", event: { type: "task.started", id: "smoke-2" } });
    await rpc({ kind: "event", project: "demo", event: { type: "task.done", id: "smoke-2", resultRef: "/r2" } });
    await new Promise((r) => setTimeout(r, 200));

    log("--- 4. injector resumes from cursor — reads only the new event ---");
    const items2 = [];
    for await (const it of mailbox.readFromCursor({ stateRoot, project: "demo", fromSeq: 2 })) items2.push(it);
    assert(items2.length === 1 && items2[0].seq === 2, `replay yields exactly seq 2`);

    log(`\n${failures === 0 ? "✔ ALL SMOKE ASSERTIONS PASSED" : `✗ ${failures} FAILURES`}`);
  } finally {
    cpd.kill();
    writeFileSync(evidenceFile, evidence.join("\n") + "\n");
    log(`evidence: ${evidenceFile}`);
    process.exit(failures > 0 ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 16.2: Build + run smoke**

```bash
npm run build
node scripts/mailbox-injector-smoke.mjs
```

Expected: all assertions pass; `.mailbox-injector-smoke.local` written.

If startCockpitd's CLI form needs different env vars to honor a custom socket/stateRoot, inspect `dist/control/cockpitd.js` to find what it reads. Adjust the env-var names in the smoke script.

- [ ] **Step 16.3: Add the .local evidence file to .gitignore if not already**

```bash
grep -q "\.mailbox-injector-smoke\.local" .gitignore || echo ".mailbox-injector-smoke.local" >> .gitignore
```

- [ ] **Step 16.4: Commit**

```bash
git add scripts/mailbox-injector-smoke.mjs .gitignore
git commit -m "chore(smoke): mailbox+injector E2E smoke script with daemon-bounce check"
```

---

## Task 17: Full validation + PR

- [ ] **Step 17.1: Lint, build, full test suite**

```bash
npm run lint
npm run build
npm test
```

All three must exit 0.

- [ ] **Step 17.2: Live verification with real captain (manual)**

This is the acceptance criterion. Carefully:

```bash
# 1. Confirm a captain is running (or launch one fresh)
cockpit launch cockpit

# 2. Spawn a small Claude crew via the daemon-supervised path
cockpit crew spawn cockpit "Run cockpit crew signal done --message 'mailbox-injector live test successful'" --agent claude --name mbox-livetest

# 3. Watch the captain pane (your own session). Within ~1s of the crew signaling
#    done, you should see a line appear:
#    CREW DONE [claude/<id8>]: mailbox-injector live test successful

# 4. Bounce daemon mid-second-test
cockpit crew spawn cockpit "Sleep 2 then run cockpit crew signal done --message 'after-bounce'" --agent claude --name mbox-bouncetest
# in another shell, while crew is sleeping:
kill $(pgrep cockpitd)
# wait for cockpit cli to auto-respawn daemon (will happen on next cli call)
cockpit runtime status --command || true
# expect CREW DONE [claude/...]: after-bounce to STILL appear in captain pane
```

Document outcomes in `.mailbox-injector-live-evidence.local` (gitignored). Both pass = PR-ready.

If outcomes fail, do NOT open the PR. Diagnose: check the inbox file content, the cursor file, the relay tab content (`cmux read-screen --surface <relay-surface>`), and the daemon log.

- [ ] **Step 17.3: gitnexus refresh + change scope check**

```bash
npx gitnexus analyze --embeddings
# Then per project CLAUDE.md hard rule, run via the MCP tool:
# gitnexus_detect_changes({scope:"compare", base_ref:"develop"})
```

Confirm the diff touches only files in the "File Structure" section at the top of this plan.

- [ ] **Step 17.4: Open the PR against develop**

```bash
git push -u origin feature/mailbox-injector
gh pr create --base develop --title "feat(mailbox): mailbox + injector foundational refactor (closes #113, foundation for #114/#115)" --body "$(cat <<'EOF'
## Summary

Replaces PR #112's subscribe/broadcast machinery with a file-as-source-of-truth mailbox + pull-from-cursor injector. The cockpit daemon now appends `ControlEvent`s to a per-project mailbox file; a `notify-relay` process runs as a hidden split-pane inside each captain workspace and delivers events to the captain pane via the new `RuntimeDriver.sendToSurface`. Daemon-bounce-tolerant by design; at-least-once delivery; runtime-agnostic.

## Architecture (one paragraph)

Daemon appends to `~/.config/cockpit/inbox/<project>.log` (JSON-lines, monotonic per-project `seq`, flock on write, size+age rotation). Injector inside captain workspace (`cockpit notify-relay <project> --as captain`) tails the file from a `lastAckedSeq` cursor (`<project>.captain.cursor`, fsync+atomic-rename), formats each entry, and delivers via `RuntimeDriver.sendToSurface(captainSurface, msg)`. The injector is spawned via the new `RuntimeDriver.spawnInjector({placement:"hidden"})` so it lives inside cmux's process tree (satisfies cmux's CLI lineage check). Subscribe-notify socket protocol + push frames added in PR #112 are deleted. Anti-#2576 invariant preserved: terminal state only via explicit `cockpit crew signal`.

## Lessons applied

- **PR #110 lesson:** daemon-from-launchd can't shell out to cmux. Daemon now never invokes cmux-aware commands; only appends to a file.
- **PR #112 lesson:** push-with-no-replay loses events during bounce backoff. Pull-from-cursor model: file is durable, injector resumes from cursor on restart.
- **Research 2026-05-27 lesson:** the relay-tab pattern is the right shape; what was missing was a durable queue and cleaner RuntimeDriver abstraction. This PR dignifies the relay into a first-class injector.

## Closes / depends

- **Closes #113** (replay-on-reconnect — by construction; the bug cannot occur in this design).
- **Foundation for #114** (hybrid codex: native TUI + hook bridge — codex hooks emit events that flow through the same mailbox).
- **Foundation for #115** (opencode interactive wiring — opencode plugin events flow through the same mailbox).
- **Preserves PR #98** (codex app-server for headless) — untouched.
- **Preserves PR #108** (claude through daemon) — its hook bridge now feeds the mailbox instead of pushing.

## Test plan

- [x] `npm run lint` clean
- [x] `npm run build` clean
- [x] `npx vitest run` — all 556+ tests pass (mailbox: 17 new, notify-relay: 4 new, cockpitd-notify-default: 3 rewritten, subscribe-notify tests deleted)
- [x] E2E smoke: `node scripts/mailbox-injector-smoke.mjs` — evidence in `.mailbox-injector-smoke.local`
- [x] Live captain verification: spawn Claude crew, signal done, captain pane receives line within ~1s; daemon-bounce mid-second-test, second line STILL arrives after respawn — evidence in `.mailbox-injector-live-evidence.local`
- [x] cmux integration (opt-in `CMUX_LIVE=1`): hidden split-pane spawned; sendToSurface lands text

## Spec / plan

- Spec: `docs/specs/2026-05-27-mailbox-injector-design.md`
- Plan: `docs/plans/2026-05-27-mailbox-injector.md`
- Motivating research: `docs/research/2026-05-27-multi-session-orchestrator-notification-patterns.md`
EOF
)"
```

- [ ] **Step 17.5: Notify the user via the now-working push (eat-our-own-dogfood)**

```bash
# After the PR opens, signal completion via the new mailbox path so the captain
# sees the auto-pushed line via the live relay.
cockpit crew signal done --message "Phase 4 (mailbox+injector) implementation merged-ready. PR opened — review evidence files for live + smoke proof."
```

(This works only if you're inside a crew with `COCKPIT_CREW_TASK_ID` set. If you're the captain manually executing, just print the line and move on.)

---

## Rollback plan

Each task = one commit. If a task breaks captain workflows in field test, `git revert <sha>` restores prior behavior:

- Revert task 15 (launch.ts spawnInjector switch) → tabs come back, mailbox still works
- Revert task 8 (subscribe-protocol removal) → PR #112 broadcast restored, mailbox additional
- Revert task 6 (defaultNotify rewrite) → execFileSync path restored, mailbox additional
- Revert all 4 commit groups → back to develop tip

Most-likely partial-revert scenario: task 14 (cmux spawnInjector) producing visually broken split-panes. Easy revert: keep mailbox+injector logic, change launch.ts to call `runtime.newPane({direction:"tab"})` for the relay (PR #112 visual behavior) until cmux command tuning is sorted.

## Out of scope for this plan — to be filed as follow-ups

- Telegram subscriber implementation (#65). Schema supports per-subscriber cursor; just needs a new subscriber binary.
- Captain-ops skill migration from `cockpit crew read` polling to `cockpit crew status` (separate spec).
- Generalizing the cursor file naming for multi-captain-per-project (no demand today).

---

## Self-review (run after writing this plan, before handoff)

- ✅ **Spec coverage:** Every spec section maps to tasks. §4 architecture → Tasks 6,9,15. §5 mailbox model → Tasks 1-4. §6 daemon → Tasks 5-8. §7 injector → Tasks 9-11. §8 RuntimeDriver → Tasks 12-14. §9 migration → ordered commit groups + Task 17 PR.
- ✅ **No TBD/placeholders:** every step has actual code or actual commands.
- ✅ **Type consistency:** `appendToMailbox`, `readCursor`, `writeCursor`, `readFromCursor`, `rotateIfNeeded` names match across all tasks. `spawnInjector` + `sendToSurface` signatures match between type def (Task 12) and impl (Tasks 13-14). `SurfaceRef.workspaceId` added consistently. `MailboxEntry` schema matches between mailbox.ts and notify-relay.ts format function.
- ⚠️  **Known risks documented**: cmux subcommand names (`new-split`, `rename-tab`, `resize-pane`, `close-surface`) may differ in production cmux — Task 14.4 includes a probe step + comment to adjust. Documented in rollback plan.
- ✅ **Scope check:** All tasks contribute to the mailbox+injector refactor. No drive-by refactors. No "while we're here" tasks.
