# #667 Slice 1 — Liveness via native agent self-report

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace two of squadrant's inferred crew-liveness signals with the agents' own self-reported status, by adding a `ClaudePeerRegistrySource` and putting the existing opencode SSE bridge behind the `LifecycleSource` port.

**Architecture:** Both agents already publish their own lifecycle state — Claude writes `~/.claude/sessions/<pid>.json` with a `status` field, opencode emits `session.idle` / `permission.asked` on its HTTP event bus. Slice 1 adds one new `LifecycleSource` (Claude, polled) and relocates one existing bridge (opencode, push) onto the same port, so both feed `reduceLifecycle` and the per-source health board. No delivery path changes. No behaviour changes.

**Tech Stack:** TypeScript (NodeNext ESM — **relative imports need the `.js` extension**), vitest, pnpm workspaces.

**Spec:** [`docs/specs/2026-08-13-agent-control-channel-design.md`](../../specs/2026-08-13-agent-control-channel-design.md) — this slice implements §3 (Liveness) and the stale-comment fix noted under §Design.

## Global Constraints

- **Package DAG is one-way:** `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`. `core` may **not** import from `agents`. The port lives in `core`; both implementations live in `agents`; wiring happens in `cli`.
- **NodeNext ESM:** every relative import must end in `.js` (e.g. `import { x } from "./foo.js"`). `tsc` and `vitest` both miss a missing extension; it fails at runtime. The real gate is `node dist/index.js --help`.
- **No test may depend on ambient state.** Anything touching the filesystem, a socket, or a port takes it as an injected dependency. A test that reads the real `~/.claude/sessions` is a test that lies on CI.
- **This slice changes no behaviour.** Registering a source is inert; it must not alter any existing notification, delivery, or state transition. If a reviewer can observe a behaviour change, the slice is wrong.
- **Terminal state still comes only from `squadrant crew signal`** (anti-#2576 invariant). No source in this slice may emit `task.done` / `task.blocked` / `task.cancelled`.
- macOS-only project. Guard any platform-specific test with `it.skipIf(process.platform !== "darwin")`.
- Commit messages follow the repo convention: `feat(#667): …`, `fix(#667): …`, `chore(#667): …`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/agents/src/claude/registry.ts` *(new)* | Pure: read + parse `~/.claude/sessions/*.json`, map one entry → `LifecycleSnapshot`. No I/O policy, no timers. |
| `packages/agents/src/claude/__tests__/registry.test.ts` *(new)* | Unit tests for the mapping and the three guards. |
| `packages/agents/src/claude/peer-registry-source.ts` *(new)* | The `LifecycleSource`: poll loop, correlation, health. Injects fs + clock. |
| `packages/agents/src/claude/__tests__/peer-registry-source.test.ts` *(new)* | Unit tests for polling, dedup, health. |
| `packages/agents/src/opencode/control-source.ts` *(new)* | `LifecycleSource` wrapper around the existing `OpencodeSseBridge` — `observe(ev)` in, snapshots out. Mirrors `CodexAppServerSource`. |
| `packages/agents/src/opencode/__tests__/control-source.test.ts` *(new)* | Unit tests for event → snapshot mapping. |
| `packages/agents/src/index.ts` *(modify)* | Export the two new sources. |
| `packages/core/src/lifecycle-source.ts:1-11` *(modify)* | Delete the stale "remains unwired until Phase 1" comment. |
| `packages/cli/src/squadrantd.ts:133-171` *(modify)* | Construct + register both sources; feed opencode events through the new source. |

**Why `claude/` is a new directory:** `packages/agents/src/` currently splits Claude across `drivers/claude.ts`, `interactive/claude.ts`, and `headless/claude.ts` — all *launch-time* concerns. Runtime control is a different responsibility and gets its own directory, matching `codex/` and `opencode/`. Slice 3 adds `peer-channel.ts` beside these files.

---

### Task 1: Claude registry reader — pure parsing and mapping

**Files:**
- Create: `packages/agents/src/claude/registry.ts`
- Test: `packages/agents/src/claude/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `LifecycleSnapshot` from `@squadrant/core`.
- Produces:
  - `interface ClaudeRegistryEntry` — fields listed below.
  - `function parseRegistryDir(files: string[], readFile: (name: string) => string): ClaudeRegistryEntry[]`
  - `function toLifecycleSnapshot(entry: ClaudeRegistryEntry, taskId: string, alive: boolean, now: number): LifecycleSnapshot`
  - `const CLAUDE_SESSIONS_DIR: string` — `join(homedir(), ".claude", "sessions")`

**Background — the live shape of a registry entry.** Confirmed by reading real files on 2026-08-15:

```jsonc
// ~/.claude/sessions/51712.json — an interactive CLI session mid-turn
{ "pid": 51712, "sessionId": "…", "cwd": "/Users/x/me/squadrant", "entrypoint": "cli",
  "status": "busy", "statusUpdatedAt": 1786807688097, "procStart": "Sat Aug 15 15:28:08 2026",
  "messagingSocketPath": "/tmp/cc-socks/51712.sock", "peerProtocol": 1, "version": "2.1.233" }

// ~/.claude/sessions/12242.json — an SDK session: NO `status` FIELD AT ALL
{ "pid": 12242, "sessionId": "…", "cwd": "…", "entrypoint": "sdk-cli",
  "procStart": "Sat Aug 15 15:28:08 2026", "messagingSocketPath": "/tmp/cc-socks/12242.sock" }
```

`status` has **four** values — `idle | busy | shell | waiting` — and `waiting` carries `waitingFor` (e.g. `"permission prompt"`). That last one is the whole point of this slice: "blocked on an approval prompt" has no observable signature from outside a terminal, and the registry states it outright.

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/claude/__tests__/registry.test.ts`:

```ts
// Tests for the Claude session-registry reader (#667 slice 1).
// Pure functions only — no real filesystem, no real ~/.claude/sessions.
import { describe, it, expect } from "vitest";
import { parseRegistryDir, toLifecycleSnapshot } from "../registry.js";
import type { ClaudeRegistryEntry } from "../registry.js";

const NOW = 1_786_807_700_000;

function entry(over: Partial<ClaudeRegistryEntry> = {}): ClaudeRegistryEntry {
  return { pid: 51712, sessionId: "sess-1", cwd: "/repo", entrypoint: "cli",
           status: "idle", statusUpdatedAt: NOW - 1000, ...over };
}

describe("parseRegistryDir", () => {
  it("keeps only <pid>.json files", () => {
    const files = ["51712.json", "51712.abc.key", "notes.txt", "12242.json"];
    const read = (n: string) => JSON.stringify({ pid: parseInt(n, 10), entrypoint: "cli" });
    expect(parseRegistryDir(files, read).map((e) => e.pid)).toEqual([51712, 12242]);
  });

  it("skips a torn write instead of throwing", () => {
    const read = (n: string) => (n === "1.json" ? "{ not json" : JSON.stringify({ pid: 2 }));
    expect(parseRegistryDir(["1.json", "2.json"], read).map((e) => e.pid)).toEqual([2]);
  });

  it("skips a file that disappears mid-read", () => {
    const read = (n: string) => {
      if (n === "1.json") throw new Error("ENOENT");
      return JSON.stringify({ pid: 2 });
    };
    expect(parseRegistryDir(["1.json", "2.json"], read).map((e) => e.pid)).toEqual([2]);
  });

  it("takes pid from the filename, not the body (body may be stale)", () => {
    const read = () => JSON.stringify({ pid: 999, entrypoint: "cli" });
    expect(parseRegistryDir(["51712.json"], read)[0].pid).toBe(51712);
  });
});

describe("toLifecycleSnapshot — status mapping", () => {
  it("busy maps to running", () => {
    expect(toLifecycleSnapshot(entry({ status: "busy" }), "t1", true, NOW).state).toBe("running");
  });

  it("shell maps to running", () => {
    expect(toLifecycleSnapshot(entry({ status: "shell" }), "t1", true, NOW).state).toBe("running");
  });

  it("idle maps to idle", () => {
    expect(toLifecycleSnapshot(entry({ status: "idle" }), "t1", true, NOW).state).toBe("idle");
  });

  it("waiting maps to needsInput and carries waitingFor as the reason", () => {
    const snap = toLifecycleSnapshot(
      entry({ status: "waiting", waitingFor: "permission prompt" }), "t1", true, NOW);
    expect(snap.state).toBe("needsInput");
    expect(snap.detail?.reason).toBe("permission prompt");
  });

  it("is origin 'agent', never 'scan' — a scan signal may not assert needsInput", () => {
    // The registry is the agent's OWN self-report; squadrant merely polls to read
    // it. origin describes trust in the SOURCE, not the transport. Marking this
    // "scan" would make reduceLifecycle silently discard every needsInput.
    expect(toLifecycleSnapshot(entry({ status: "waiting" }), "t1", true, NOW).origin).toBe("agent");
  });
});

describe("toLifecycleSnapshot — the three mandatory guards", () => {
  it("guard 3: a missing status field maps to unknown, NOT idle", () => {
    // sdk-cli sessions carry no status. Mapping absence to idle would announce
    // "ready for work" about a session squadrant does not understand.
    const snap = toLifecycleSnapshot(
      entry({ entrypoint: "sdk-cli", status: undefined, statusUpdatedAt: undefined }),
      "t1", true, NOW);
    expect(snap.state).toBe("unknown");
  });

  it("guard 3: an unrecognised status value maps to unknown", () => {
    expect(toLifecycleSnapshot(
      entry({ status: "hibernating" as never }), "t1", true, NOW).state).toBe("unknown");
  });

  it("guard 1: a dead pid reports alive:false and state unknown, not its frozen status", () => {
    // A crashed session's last status is frozen and looks fresh forever. This is
    // the exact mechanism behind today's phantom CREW STALLED.
    const snap = toLifecycleSnapshot(entry({ status: "busy" }), "t1", false, NOW);
    expect(snap.alive).toBe(false);
    expect(snap.state).toBe("unknown");
  });

  it("guard 2: `at` comes from statusUpdatedAt so a stale read cannot overwrite a newer state", () => {
    const snap = toLifecycleSnapshot(entry({ statusUpdatedAt: 12345 }), "t1", true, NOW);
    expect(snap.at).toBe(12345);
  });

  it("guard 2: falls back to now when statusUpdatedAt is absent", () => {
    expect(toLifecycleSnapshot(
      entry({ statusUpdatedAt: undefined, status: undefined }), "t1", true, NOW).at).toBe(NOW);
  });

  it("carries taskId and pid through", () => {
    const snap = toLifecycleSnapshot(entry(), "task-abc", true, NOW);
    expect(snap.taskId).toBe("task-abc");
    expect(snap.pid).toBe(51712);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/registry.test.ts`
Expected: FAIL — `Cannot find module '../registry.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/agents/src/claude/registry.ts`:

```ts
// packages/agents/src/claude/registry.ts
//
// Reader for Claude Code's session registry (#667 slice 1).
//
// Discovery is a DIRECTORY OF JSON FILES, not a service: ~/.claude/sessions/<pid>.json,
// one per live session, written by the session itself. Nobody maintains it — a
// SIGKILLed session never cleans up — so every reader does its own liveness check.
//
// This file is pure: parsing and mapping only. Polling, fs access, and the
// process-liveness check live in peer-registry-source.ts so both are testable
// without touching a real home directory.
import { homedir } from "node:os";
import { join } from "node:path";
import type { LifecycleSnapshot } from "@squadrant/core";

/** Where Claude Code writes one JSON file per live session. */
export const CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/** The subset of a registry entry squadrant reads. Claude writes more fields. */
export interface ClaudeRegistryEntry {
  pid: number;
  sessionId?: string;
  cwd?: string;
  /** "cli" for interactive sessions; "sdk-cli" sessions carry NO status field. */
  entrypoint?: string;
  /** Four values, not two. Absent on sdk-cli sessions. */
  status?: "idle" | "busy" | "shell" | "waiting";
  /** Only present alongside status:"waiting", e.g. "permission prompt". */
  waitingFor?: string;
  statusUpdatedAt?: number;
  messagingSocketPath?: string;
  /** Pins the entry to a process INSTANCE — guards against pid reuse. */
  procStart?: string;
}

/** Only `<pid>.json`; Claude Code applies the same filter to its own reads. */
const PID_JSON = /^(\d+)\.json$/;

/**
 * Parse a directory listing into entries, skipping anything unreadable.
 *
 * Torn writes are expected, not exceptional: a reader can catch a file mid-rewrite,
 * and a session can exit between readdir and readFile. Both yield "skip this entry",
 * never a throw — one bad file must not blind the source to every other session.
 *
 * The pid comes from the FILENAME, which is authoritative; the body may be stale.
 */
export function parseRegistryDir(
  files: string[],
  readFile: (name: string) => string,
): ClaudeRegistryEntry[] {
  const out: ClaudeRegistryEntry[] = [];
  for (const name of files) {
    const m = PID_JSON.exec(name);
    if (!m) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(readFile(name)) as Record<string, unknown>;
    } catch {
      continue; // torn write, or the file vanished — both are normal
    }
    out.push({ ...(json as object), pid: parseInt(m[1], 10) } as ClaudeRegistryEntry);
  }
  return out;
}

/**
 * Map one registry entry to a normalized snapshot.
 *
 * origin is ALWAYS "agent". The registry is the session's own self-report;
 * squadrant happens to read it by polling, but `origin` describes how far the
 * SOURCE is trusted, not the transport used to fetch it. Marking it "scan" would
 * make reduceLifecycle rule 2 silently discard every `waitingFor: "permission
 * prompt"` — the single most valuable signal in this design.
 *
 * Three guards, each of which manufactures a new class of false signal if omitted:
 *   1. `alive` (caller's kill(pid,0)) — a crashed session's status is frozen and
 *      looks fresh forever. This is today's phantom CREW STALLED, relocated.
 *   2. `statusUpdatedAt` becomes `at`, so reduceLifecycle can reject a stale read.
 *   3. Absence ≠ idle. No status field ⇒ "unknown".
 */
export function toLifecycleSnapshot(
  entry: ClaudeRegistryEntry,
  taskId: string,
  alive: boolean,
  now: number,
): LifecycleSnapshot {
  const at = entry.statusUpdatedAt ?? now;
  const base = { taskId, alive, origin: "agent" as const, at, pid: entry.pid };

  // Guard 1: a dead process has no current state, whatever its file still says.
  if (!alive) return { ...base, state: "unknown" };

  switch (entry.status) {
    case "busy":
    case "shell":
      return { ...base, state: "running" };
    case "idle":
      return { ...base, state: "idle" };
    case "waiting":
      return {
        ...base,
        state: "needsInput",
        detail: { reason: entry.waitingFor, note: entry.waitingFor },
      };
    default:
      // Guard 3: sdk-cli sessions (no status) and any future value squadrant
      // does not recognise. Never guess "idle" here.
      return { ...base, state: "unknown" };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/registry.test.ts`
Expected: PASS — 15 tests

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/claude/registry.ts packages/agents/src/claude/__tests__/registry.test.ts
git commit -m "feat(#667): claude session-registry reader with the three liveness guards"
```

---

### Task 2: `ClaudePeerRegistrySource` — the polling LifecycleSource

**Files:**
- Create: `packages/agents/src/claude/peer-registry-source.ts`
- Test: `packages/agents/src/claude/__tests__/peer-registry-source.test.ts`

**Interfaces:**
- Consumes: `parseRegistryDir`, `toLifecycleSnapshot`, `ClaudeRegistryEntry`, `CLAUDE_SESSIONS_DIR` from Task 1; `LifecycleSource`, `LifecycleSourceDeps`, `LifecycleSnapshot` from `@squadrant/core`.
- Produces:
  - `class ClaudePeerRegistrySource implements LifecycleSource` with `readonly name = "claude-peer-registry"`.
  - `interface ClaudePeerRegistrySourceDeps { readdir?; readFile?; isAlive?; now?; pollMs?; log? }` — every one injectable so tests never touch a real home directory.

**Correlation.** The port's `deps.resolve(hint)` maps a raw signal back to a crew, trying `taskId > pid > cwd > sessionId`. Registry entries carry `pid`, `cwd`, and `sessionId` but no taskId, so this source passes all three and lets the daemon decide. Entries that resolve to nothing (the operator's own Claude windows, other projects' captains) are skipped silently — that is the normal case, not an error.

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/claude/__tests__/peer-registry-source.test.ts`:

```ts
// Tests for ClaudePeerRegistrySource (#667 slice 1).
// Every dependency is injected: no real ~/.claude/sessions, no real timers,
// no real process.kill. A test that reads the real registry lies on CI.
import { describe, it, expect, vi } from "vitest";
import { ClaudePeerRegistrySource } from "../peer-registry-source.js";
import type { LifecycleSnapshot, LifecycleSourceDeps } from "@squadrant/core";

const NOW = 1_786_807_700_000;

function harness(opts: {
  files?: string[];
  bodies?: Record<string, object>;
  alive?: (pid: number) => boolean;
  resolve?: LifecycleSourceDeps["resolve"];
} = {}) {
  const reports: LifecycleSnapshot[] = [];
  const files = opts.files ?? ["51712.json"];
  const bodies = opts.bodies ?? {
    "51712.json": { pid: 51712, cwd: "/repo", entrypoint: "cli", status: "busy", statusUpdatedAt: NOW },
  };
  const deps: LifecycleSourceDeps = {
    resolve: opts.resolve ?? (() => ({ id: "task-1" })),
    report: (s) => reports.push(s),
  };
  const source = new ClaudePeerRegistrySource({
    readdir: () => files,
    readFile: (n) => JSON.stringify(bodies[n] ?? {}),
    isAlive: opts.alive ?? (() => true),
    now: () => NOW,
    pollMs: 0, // 0 disables the interval; tests drive poll() directly
  });
  return { source, deps, reports };
}

describe("ClaudePeerRegistrySource — port conformance", () => {
  it("has name 'claude-peer-registry'", () => {
    expect(harness().source.name).toBe("claude-peer-registry");
  });

  it("reports inactive health before start and active after", () => {
    const { source, deps } = harness();
    expect(source.health()).toEqual({ active: false, error: null });
    source.start(deps);
    expect(source.health()).toEqual({ active: true, error: null });
    source.stop();
    expect(source.health()).toEqual({ active: false, error: null });
  });

  it("start() is inert until a poll runs — registering must not do I/O", () => {
    const readdir = vi.fn(() => []);
    const source = new ClaudePeerRegistrySource({ readdir, pollMs: 0 });
    source.start({ resolve: () => undefined, report: () => {} });
    expect(readdir).not.toHaveBeenCalled();
  });
});

describe("ClaudePeerRegistrySource — polling", () => {
  it("reports a snapshot for a session that resolves to a crew", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.poll();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ taskId: "task-1", state: "running", origin: "agent", pid: 51712 });
  });

  it("skips sessions that resolve to no crew (operator's own windows)", () => {
    const { source, deps, reports } = harness({ resolve: () => undefined });
    source.start(deps);
    source.poll();
    expect(reports).toHaveLength(0);
  });

  it("passes pid, cwd and sessionId as correlation hints", () => {
    const resolve = vi.fn(() => ({ id: "task-1" }));
    const { source, deps } = harness({
      resolve,
      bodies: { "51712.json": { pid: 51712, cwd: "/repo", sessionId: "s-9", entrypoint: "cli", status: "idle" } },
    });
    source.start(deps);
    source.poll();
    expect(resolve).toHaveBeenCalledWith({ pid: 51712, cwd: "/repo", sessionId: "s-9" });
  });

  it("runs a dead pid through the guard: alive:false, state unknown", () => {
    const { source, deps, reports } = harness({ alive: () => false });
    source.start(deps);
    source.poll();
    expect(reports[0]).toMatchObject({ alive: false, state: "unknown" });
  });

  it("does not report an unchanged state twice", () => {
    // The registry is polled; without dedup every tick would re-report the same
    // state and flood the reducer with no new information.
    const { source, deps, reports } = harness();
    source.start(deps);
    source.poll();
    source.poll();
    expect(reports).toHaveLength(1);
  });

  it("reports again when the state changes", () => {
    const bodies: Record<string, object> = {
      "51712.json": { pid: 51712, cwd: "/repo", entrypoint: "cli", status: "busy", statusUpdatedAt: NOW },
    };
    const reports: LifecycleSnapshot[] = [];
    const source = new ClaudePeerRegistrySource({
      readdir: () => ["51712.json"],
      readFile: (n) => JSON.stringify(bodies[n]),
      isAlive: () => true,
      now: () => NOW,
      pollMs: 0,
    });
    source.start({ resolve: () => ({ id: "task-1" }), report: (s) => reports.push(s) });
    source.poll();
    bodies["51712.json"] = { pid: 51712, cwd: "/repo", entrypoint: "cli", status: "waiting",
                             waitingFor: "permission prompt", statusUpdatedAt: NOW + 10 };
    source.poll();
    expect(reports.map((r) => r.state)).toEqual(["running", "needsInput"]);
  });

  it("survives an unreadable registry directory and records the error in health", () => {
    const source = new ClaudePeerRegistrySource({
      readdir: () => { throw new Error("EACCES"); },
      pollMs: 0,
    });
    source.start({ resolve: () => undefined, report: () => {} });
    expect(() => source.poll()).not.toThrow();
    expect(source.health().error).toContain("EACCES");
  });

  it("clears a previous error once a poll succeeds", () => {
    let boom = true;
    const source = new ClaudePeerRegistrySource({
      readdir: () => { if (boom) throw new Error("EACCES"); return []; },
      pollMs: 0,
    });
    source.start({ resolve: () => undefined, report: () => {} });
    source.poll();
    expect(source.health().error).toContain("EACCES");
    boom = false;
    source.poll();
    expect(source.health().error).toBeNull();
  });
});

describe("ClaudePeerRegistrySource — snapshot() for the liveness floor", () => {
  it("returns undefined for an unknown crew", () => {
    const { source, deps } = harness();
    source.start(deps);
    expect(source.snapshot("nope")).toBeUndefined();
  });

  it("returns the last poll result downgraded to origin 'scan'", () => {
    // The port requires a poll result to be origin:"scan" and forbids it from
    // asserting needsInput. report() carries the trusted "agent" signal; this
    // read-back path is only the liveness floor and must not smuggle needsInput in.
    const { source, deps } = harness({
      bodies: { "51712.json": { pid: 51712, cwd: "/repo", entrypoint: "cli",
                                status: "waiting", waitingFor: "permission prompt" } },
    });
    source.start(deps);
    source.poll();
    const snap = source.snapshot("task-1");
    expect(snap?.origin).toBe("scan");
    expect(snap?.state).not.toBe("needsInput");
    expect(snap?.alive).toBe(true);
  });

  it("stops reporting and clears its cache on stop()", () => {
    const { source, deps } = harness();
    source.start(deps);
    source.poll();
    source.stop();
    expect(source.snapshot("task-1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/peer-registry-source.test.ts`
Expected: FAIL — `Cannot find module '../peer-registry-source.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/agents/src/claude/peer-registry-source.ts`:

```ts
// packages/agents/src/claude/peer-registry-source.ts
//
// LifecycleSource over Claude Code's own session registry (#667 slice 1).
//
// Claude publishes its state to ~/.claude/sessions/<pid>.json. Reading it replaces
// two inferred signals with the agent's self-report:
//   - CREW IDLE fired during a live tool call  → status:"busy" is stated, not guessed
//   - CREW STALLED for a process that is gone  → kill(pid, 0)
//
// This source is READ-ONLY and changes no behaviour. It runs alongside the
// existing v0.15.0 liveness floor; retiring that floor is a later decision made
// on data, not part of this slice.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleSource, LifecycleSourceDeps, LifecycleSnapshot } from "@squadrant/core";
import { CLAUDE_SESSIONS_DIR, parseRegistryDir, toLifecycleSnapshot } from "./registry.js";

export interface ClaudePeerRegistrySourceDeps {
  /** Injectable for tests. Defaults to reading CLAUDE_SESSIONS_DIR. */
  readdir?: () => string[];
  readFile?: (name: string) => string;
  /** signal 0 = "does a process with this pid exist?" Injectable for tests. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** Poll interval in ms. Default 2000. Pass 0 to disable the timer (tests). */
  pollMs?: number;
  log?: (msg: string) => void;
}

/** EPERM means the process exists but belongs to another user — still alive. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ClaudePeerRegistrySource implements LifecycleSource {
  readonly name = "claude-peer-registry";

  private deps?: LifecycleSourceDeps;
  private timer?: NodeJS.Timeout;
  private active = false;
  private lastError: string | null = null;
  /** taskId → last snapshot reported, for dedup and the liveness floor. */
  private cache = new Map<string, LifecycleSnapshot>();

  private readonly readdir: () => string[];
  private readonly readFile: (name: string) => string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly log?: (msg: string) => void;

  constructor(o: ClaudePeerRegistrySourceDeps = {}) {
    this.readdir = o.readdir ?? (() => readdirSync(CLAUDE_SESSIONS_DIR));
    this.readFile = o.readFile ?? ((n) => readFileSync(join(CLAUDE_SESSIONS_DIR, n), "utf8"));
    this.isAlive = o.isAlive ?? defaultIsAlive;
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? 2000;
    this.log = o.log;
  }

  start(deps: LifecycleSourceDeps): void {
    this.deps = deps;
    this.active = true;
    // Registering must be inert — no I/O until the first tick fires. Matches the
    // "registering is inert" contract the other sources rely on (squadrantd.ts).
    if (this.pollMs > 0) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.deps = undefined;
    this.active = false;
    this.cache.clear();
  }

  health(): { active: boolean; error: string | null } {
    return { active: this.active, error: this.lastError };
  }

  /**
   * Liveness-floor read-back. The port REQUIRES a poll result to be
   * origin:"scan" and forbids it from asserting needsInput — report() already
   * delivered the trusted origin:"agent" signal, and this path must not smuggle
   * a second copy of needsInput past the reducer's precedence rules.
   */
  snapshot(taskId: string): LifecycleSnapshot | undefined {
    const s = this.cache.get(taskId);
    if (!s) return undefined;
    return {
      ...s,
      origin: "scan",
      state: s.state === "needsInput" ? "running" : s.state,
    };
  }

  /** One pass over the registry. Public so tests can drive it without timers. */
  poll(): void {
    if (!this.deps) return;
    let files: string[];
    try {
      files = this.readdir();
    } catch (e) {
      // A missing directory is normal (no Claude sessions / feature off) but is
      // still worth surfacing on the health board rather than swallowing.
      this.lastError = (e as Error).message;
      return;
    }
    this.lastError = null;

    const now = this.now();
    for (const entry of parseRegistryDir(files, this.readFile)) {
      const crew = this.deps.resolve({
        pid: entry.pid,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      });
      // No crew: the operator's own Claude windows, other projects' captains.
      // This is the common case, not an error — stay silent.
      if (!crew) continue;

      const snap = toLifecycleSnapshot(entry, crew.id, this.isAlive(entry.pid), now);
      const prev = this.cache.get(crew.id);
      // Polling re-reads the same file every tick; only transitions carry news.
      if (prev && prev.state === snap.state && prev.alive === snap.alive) continue;
      this.cache.set(crew.id, snap);
      this.deps.report(snap);
      this.log?.(`claude-peer-registry: ${crew.id} → ${snap.state}${snap.alive ? "" : " (dead)"}`);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/peer-registry-source.test.ts`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/claude/peer-registry-source.ts packages/agents/src/claude/__tests__/peer-registry-source.test.ts
git commit -m "feat(#667): ClaudePeerRegistrySource — self-reported crew liveness"
```

---

### Task 3: `OpencodeControlSource` — put the SSE bridge behind the port

**Files:**
- Create: `packages/agents/src/opencode/control-source.ts`
- Test: `packages/agents/src/opencode/__tests__/control-source.test.ts`

**Interfaces:**
- Consumes: `LifecycleSource`, `LifecycleSourceDeps`, `LifecycleSnapshot` from `@squadrant/core`; `ControlEvent` from `@squadrant/shared`.
- Produces: `class OpencodeControlSource implements LifecycleSource` with `readonly name = "opencode-control"` and `observe(ev: ControlEvent): void`.

**Why this is required, not a drive-by refactor.** `OpencodeSseBridge` is production-wired (constructed at `packages/cli/src/squadrantd.ts:133`, started per crew at `packages/core/src/daemon/start.ts:78` and `:189`) but it is **not** a `LifecycleSource`. It therefore bypasses `reduceLifecycle` entirely — opencode signals never receive the `agent > scan` precedence rules — and it is absent from the per-source health board aggregated at `packages/core/src/daemon/start.ts:153`. The 4-state model in §3 of the spec cannot hold while one of the two in-scope agents routes around it.

This task deliberately **does not** modify `sse-bridge.ts`. The bridge keeps emitting the same `ControlEvent`s to the same daemon pipeline; the new source is a second, parallel observer — exactly the shape `CodexAppServerSource` already uses at `packages/agents/src/codex/codex-app-server-source.ts`. That is what makes this slice behaviour-neutral.

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/opencode/__tests__/control-source.test.ts`:

```ts
// Tests for OpencodeControlSource (#667 slice 1).
// Mirrors codex-app-server-source.test.ts: all deps injected, no real SSE stream.
import { describe, it, expect } from "vitest";
import { OpencodeControlSource } from "../control-source.js";
import type { LifecycleSnapshot, LifecycleSourceDeps } from "@squadrant/core";
import type { ControlEvent } from "@squadrant/shared";

const TASK_ID = "task-abc123";

function harness() {
  const reports: LifecycleSnapshot[] = [];
  const deps: LifecycleSourceDeps = { resolve: () => undefined, report: (s) => reports.push(s) };
  const source = new OpencodeControlSource();
  return { source, deps, reports };
}

describe("OpencodeControlSource — port conformance", () => {
  it("has name 'opencode-control'", () => {
    expect(harness().source.name).toBe("opencode-control");
  });

  it("reports health active only between start and stop", () => {
    const { source, deps } = harness();
    expect(source.health()).toEqual({ active: false, error: null });
    source.start(deps);
    expect(source.health()).toEqual({ active: true, error: null });
    source.stop();
    expect(source.health()).toEqual({ active: false, error: null });
  });

  it("ignores events before start()", () => {
    const { source, reports } = harness();
    source.observe({ type: "task.started", id: TASK_ID } as ControlEvent);
    expect(reports).toHaveLength(0);
  });
});

describe("OpencodeControlSource — event mapping", () => {
  it("task.turn.completed maps to idle (turn ended, crew alive)", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.turn.completed", id: TASK_ID, turnId: "ses_1" } as ControlEvent);
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, state: "idle", alive: true, origin: "agent" });
  });

  it("task.approval.requested maps to needsInput with the question as detail", () => {
    // This is the row that matters: opencode STATES it is stuck on a permission
    // prompt. Today squadrant guesses this from pane content (#484 / #590 class).
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.approval.requested", id: TASK_ID, requestId: 1,
                     question: "opencode requests permission to run bash: ls", kind: "bash" } as ControlEvent);
    expect(reports[0]).toMatchObject({ state: "needsInput", origin: "agent" });
    expect(reports[0].detail?.note).toContain("permission to run bash");
    expect(reports[0].detail?.reason).toBe("bash");
  });

  it("task.started maps to running (permission answered, turn resumes)", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.started", id: TASK_ID } as ControlEvent);
    expect(reports[0]).toMatchObject({ state: "running", alive: true });
  });

  it("origin is always 'agent' — these are the agent's own event bus", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.turn.completed", id: TASK_ID, turnId: "x" } as ControlEvent);
    expect(reports[0].origin).toBe("agent");
  });

  it("ignores terminal signals — those come only from `squadrant crew signal`", () => {
    // anti-#2576: session.idle is liveness, NOT completion. A source must never
    // terminalize a task; that stays with the explicit crew signal.
    const { source, deps, reports } = harness();
    source.start(deps);
    for (const type of ["task.done", "task.blocked", "task.cancelled"] as const) {
      source.observe({ type, id: TASK_ID } as ControlEvent);
    }
    expect(reports).toHaveLength(0);
  });

  it("ignores notify-only events", () => {
    const { source, deps, reports } = harness();
    source.start(deps);
    source.observe({ type: "task.stalled", id: TASK_ID } as ControlEvent);
    expect(reports).toHaveLength(0);
  });
});

describe("OpencodeControlSource — snapshot() for the liveness floor", () => {
  it("returns undefined for an unseen crew", () => {
    const { source, deps } = harness();
    source.start(deps);
    expect(source.snapshot("nope")).toBeUndefined();
  });

  it("returns the last state as origin 'scan', never asserting needsInput", () => {
    const { source, deps } = harness();
    source.start(deps);
    source.observe({ type: "task.approval.requested", id: TASK_ID, requestId: 1,
                     question: "q", kind: "bash" } as ControlEvent);
    const snap = source.snapshot(TASK_ID);
    expect(snap?.origin).toBe("scan");
    expect(snap?.state).not.toBe("needsInput");
  });

  it("clears its cache on stop()", () => {
    const { source, deps } = harness();
    source.start(deps);
    source.observe({ type: "task.turn.completed", id: TASK_ID, turnId: "x" } as ControlEvent);
    source.stop();
    expect(source.snapshot(TASK_ID)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/control-source.test.ts`
Expected: FAIL — `Cannot find module '../control-source.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/agents/src/opencode/control-source.ts`:

```ts
// packages/agents/src/opencode/control-source.ts
//
// LifecycleSource adapter for opencode's HTTP event bus (#667 slice 1).
//
// OpencodeSseBridge is production-wired but is NOT a LifecycleSource: it emits
// ControlEvents straight into the daemon pipeline, bypassing reduceLifecycle's
// agent-over-scan precedence rules and the per-source health board. This adapter
// puts opencode behind the same port claude and codex use, which the 4-state
// model requires.
//
// Deliberately does not touch sse-bridge.ts: the bridge keeps emitting exactly
// what it emits today, and this source observes the same stream in parallel —
// the shape CodexAppServerSource already uses. That is what keeps slice 1
// behaviour-neutral.
import type { LifecycleSource, LifecycleSourceDeps, LifecycleSnapshot } from "@squadrant/core";
import type { ControlEvent } from "@squadrant/shared";

export class OpencodeControlSource implements LifecycleSource {
  readonly name = "opencode-control";

  private deps?: LifecycleSourceDeps;
  private active = false;
  private cache = new Map<string, LifecycleSnapshot>();

  start(deps: LifecycleSourceDeps): void {
    this.deps = deps;
    this.active = true;
  }

  stop(): void {
    this.deps = undefined;
    this.active = false;
    this.cache.clear();
  }

  /** Push-only source — no fallible startup of its own. */
  health(): { active: boolean; error: string | null } {
    return { active: this.active, error: null };
  }

  /** Liveness floor: origin must be "scan" and must not assert needsInput. */
  snapshot(taskId: string): LifecycleSnapshot | undefined {
    const s = this.cache.get(taskId);
    if (!s) return undefined;
    return { ...s, origin: "scan", state: s.state === "needsInput" ? "running" : s.state };
  }

  /**
   * Feed one ControlEvent from OpencodeSseBridge into the port.
   * Wired in squadrantd.ts as: emit = (ev) => { source.observe(ev); …existing… }
   */
  observe(ev: ControlEvent): void {
    if (!this.deps) return;
    const snap = toSnapshot(ev);
    if (!snap) return;
    this.cache.set(snap.taskId, snap);
    this.deps.report(snap);
  }
}

// ── private: ControlEvent → LifecycleSnapshot ────────────────────────────────

function toSnapshot(ev: ControlEvent): LifecycleSnapshot | null {
  const now = Date.now();
  switch (ev.type) {
    // A permission was answered on the bus and the turn resumed.
    case "task.started":
      return { taskId: ev.id, state: "running", alive: true, origin: "agent", at: now };

    // session.idle — the turn finished. Liveness, NOT completion (anti-#2576).
    case "task.turn.completed":
      return { taskId: ev.id, state: "idle", alive: true, origin: "agent", at: now };

    // permission.asked — opencode STATES it is gated. No guessing from pixels.
    case "task.approval.requested":
      return {
        taskId: ev.id, state: "needsInput", alive: true, origin: "agent", at: now,
        detail: { note: ev.question, reason: ev.kind },
      };

    // Terminal (task.done/blocked/cancelled) and notify-only events are ignored:
    // terminal state comes exclusively from `squadrant crew signal`.
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/control-source.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/opencode/control-source.ts packages/agents/src/opencode/__tests__/control-source.test.ts
git commit -m "feat(#667): OpencodeControlSource — opencode lifecycle behind the port"
```

---

### Task 4: Wire both sources into the daemon and correct the stale comment

**Files:**
- Modify: `packages/core/src/lifecycle-source.ts:1-11` (delete the stale wiring claim)
- Modify: `packages/agents/src/index.ts` (export the two new sources)
- Modify: `packages/cli/src/squadrantd.ts:133-171` (construct, observe, register)
- Test: `packages/cli/src/__tests__/squadrantd-lifecycle-sources.test.ts` *(new)*

**Interfaces:**
- Consumes: `ClaudePeerRegistrySource` (Task 2), `OpencodeControlSource` (Task 3).
- Produces: nothing new — this task only connects existing pieces.

**The stale comment.** `packages/core/src/lifecycle-source.ts` lines 10-11 currently read *"nothing in this file is imported by the live daemon or delivery path. It compiles and tests but remains unwired until Phase 1."* That has been false since #333 Phase 1 shipped: `cmuxStoreSource`, `nativeHookSource`, and `codexAppServerSource` are registered at `packages/cli/src/squadrantd.ts:171` and health-aggregated at `packages/core/src/daemon/start.ts:153`. A future reader trusting that comment would conclude the port is dead code.

- [ ] **Step 1: Fix the stale header comment**

In `packages/core/src/lifecycle-source.ts`, replace lines 1-11 with:

```ts
// packages/core/src/lifecycle-source.ts
//
// LifecycleSource port (issue #333).
//
// Defines the abstraction for normalizing agent lifecycle events from
// heterogeneous sources (cmux store file, native hooks, SSE, app-server, the
// claude session registry) into a single 4-state model. NO concrete
// implementation lives here; this is the interface + types + pure reducer only.
//
// WIRING: live. Sources are constructed and registered in
// packages/cli/src/squadrantd.ts (ctx.lifecycleSources) and health-aggregated
// into the daemon snapshot at packages/core/src/daemon/start.ts.
```

- [ ] **Step 2: Export the new sources**

In `packages/agents/src/index.ts`, add alongside the existing exports (keep the `.js` extensions — NodeNext):

```ts
export { ClaudePeerRegistrySource } from "./claude/peer-registry-source.js";
export type { ClaudePeerRegistrySourceDeps } from "./claude/peer-registry-source.js";
export { parseRegistryDir, toLifecycleSnapshot, CLAUDE_SESSIONS_DIR } from "./claude/registry.js";
export type { ClaudeRegistryEntry } from "./claude/registry.js";
export { OpencodeControlSource } from "./opencode/control-source.js";
```

- [ ] **Step 3: Write the failing wiring test**

Create `packages/cli/src/__tests__/squadrantd-lifecycle-sources.test.ts`:

```ts
// Wiring guard for #667 slice 1: both new sources must be registered on the
// daemon context so they reach reduceLifecycle and the per-source health board.
// Registering is inert (no I/O) — this test asserts registration, not behaviour.
import { describe, it, expect } from "vitest";
import { ClaudePeerRegistrySource, OpencodeControlSource } from "@squadrant/agents";

describe("#667 slice 1 — lifecycle source registration", () => {
  it("both sources satisfy the LifecycleSource port", () => {
    for (const s of [new ClaudePeerRegistrySource({ pollMs: 0 }), new OpencodeControlSource()]) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.start).toBe("function");
      expect(typeof s.stop).toBe("function");
      expect(typeof s.health).toBe("function");
      expect(typeof s.snapshot).toBe("function");
    }
  });

  it("source names are unique and stable — the health board keys on them", () => {
    const names = ["cmux-store", "native-hook", "codex-appserver", "claude-peer-registry", "opencode-control"];
    expect(new Set(names).size).toBe(names.length);
    expect(new ClaudePeerRegistrySource({ pollMs: 0 }).name).toBe("claude-peer-registry");
    expect(new OpencodeControlSource().name).toBe("opencode-control");
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/squadrantd-lifecycle-sources.test.ts`
Expected: FAIL — the exports do not exist yet if Step 2 was skipped; otherwise PASS once Step 2 landed. If it passes here, that is fine — the substantive wiring assertion is Step 5.

- [ ] **Step 5: Wire the sources in `squadrantd.ts`**

In `packages/cli/src/squadrantd.ts`, extend the import on line 24:

```ts
import { runHeadless, CodexInteractiveDriver, OpencodeSseBridge, CodexAppServerSource,
         ClaudePeerRegistrySource, OpencodeControlSource } from "@squadrant/agents";
```

Construct the opencode source **before** the bridge (the bridge's `emit` closure references it). Replace the `opencodeBridge` block at lines 133-142 with:

```ts
  // #667 slice 1: opencode lifecycle behind the LifecycleSource port. The bridge
  // keeps emitting exactly what it emits today; this source observes the same
  // stream in parallel so opencode signals finally reach reduceLifecycle and the
  // health board. Behaviour-neutral by construction.
  const opencodeControlSource = new OpencodeControlSource();

  const opencodeBridge = opts.opencodeBridge ?? new OpencodeSseBridge({
    emit: (ev) => {
      const found = store.listAll().find((r) => r.id === ev.id);
      if (!found) return;
      void ctx.d.handle({ kind: "event", project: found.project, event: ev });
      if (ev.type === "task.approval.requested")
        ctx.schedulePromotion(ev.id, ev.requestId, "approval", ev.question);
      opencodeControlSource.observe(ev);
    },
    log,
  });
```

Then, next to the existing source construction at lines 160-163, add:

```ts
  // #667 slice 1: claude's own session registry (~/.claude/sessions/<pid>.json).
  // Polled, but origin:"agent" — see the note in registry.ts on why.
  const claudePeerRegistrySource = new ClaudePeerRegistrySource({ log });
```

And extend the registration at line 171:

```ts
  ctx.lifecycleSources = [
    cmuxStoreSource, nativeHookSource, codexAppServerSource,
    claudePeerRegistrySource, opencodeControlSource,
  ];
```

> **Note on `start()`:** the existing sources are started under a `VITEST` guard further down the same file. Follow that pattern exactly for the two new sources — registering is inert, only `start()` does work, so `health()` correctly reports inactive under test.

- [ ] **Step 6: Build and run the full suite**

```bash
pnpm build && pnpm test
```

Expected: build clean, full suite green. **If `pnpm test` passes locally, that is not yet evidence** — the 2026-08-13 incident was a suite that was green only because that machine had a live daemon. Confirm CI is green on the PR before claiming this step done.

- [ ] **Step 7: Verify the runtime gate (NodeNext extension trap)**

```bash
node dist/index.js --help && node dist/squadrantd.js --help
```

Expected: both print usage. `tsc` and `vitest` both miss a missing `.js` in a relative import; this is the only check that catches it.

- [ ] **Step 8: Verify the sources appear on the health board**

```bash
squadrant heal status
```

Expected: `claude-peer-registry` and `opencode-control` are listed among the lifecycle sources. Do **not** treat a green board as proof the sources work — it proves only that they are registered. Behavioural proof is Task 5.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/lifecycle-source.ts packages/agents/src/index.ts \
        packages/cli/src/squadrantd.ts packages/cli/src/__tests__/squadrantd-lifecycle-sources.test.ts
git commit -m "feat(#667): register claude + opencode lifecycle sources; correct stale port comment"
```

---

### Task 5: Live smoke on a throwaway TEST project

**Files:**
- Modify: `docs/testing/crew-lifecycle-checklist.md` (add the re-smoke-on-agent-upgrade rule)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: recorded evidence; no code.

**Why this task exists.** On 2026-08-13 a captain reported "independent gate, 2486/2486 passing" and the conclusion was wrong — the suite was green because that machine had a live daemon; CI did not. A test's status code is not evidence. This task is the gate.

> **HARD CONSTRAINT — never smoke against the real config.** Crews must not boot a daemon against `~/.config/squadrant`; one did exactly that on 2026-08-13 and **seized the production socket**. Export `SQUADRANT_CONFIG` to a throwaway directory (honoured since #668) and use a throwaway TEST project. `isMonorepoCheckout` is a second guard, not a substitute for the first.

- [ ] **Step 1: Prepare an isolated environment**

```bash
export SQUADRANT_CONFIG="$(mktemp -d)/squadrant"
echo "$SQUADRANT_CONFIG"   # confirm it is NOT ~/.config/squadrant before continuing
```

- [ ] **Step 2: Confirm the Claude registry reports a real status transition**

With a claude crew running in the TEST project, read the registry directly and watch `status` flip as the crew takes a turn:

```bash
for f in ~/.claude/sessions/*.json; do
  python3 -c "
import json;d=json.load(open('$f'))
print(d.get('pid'), d.get('entrypoint'), repr(d.get('status')), repr(d.get('waitingFor')))"
done
```

Expected: at least one `cli` entry flips `idle` → `busy` while a turn runs. An `sdk-cli` entry shows `None` for status — that is the case Guard 3 maps to `unknown`.

- [ ] **Step 3: Close the needsInput case — the row that justifies the slice**

Trigger a permission prompt in the crew (e.g. a gated `bash` tool call), then re-read the registry.

Expected: `status: "waiting"`, `waitingFor: "permission prompt"`, and the daemon log shows `claude-peer-registry: <taskId> → needsInput`.

**If `needsInput` never appears in the log, stop.** The most likely cause is the `origin` trap: if the snapshot were built with `origin: "scan"`, `reduceLifecycle` rule 2 would silently discard it. Check `registry.ts` sets `origin: "agent"`.

- [ ] **Step 4: Close the dead-process case**

`kill -9` the crew's pid, then confirm the next poll reports `alive:false` / `unknown` rather than the frozen `busy` the file still contains.

Expected: log line `claude-peer-registry: <taskId> → unknown (dead)`. This is the phantom-`CREW STALLED` mechanism, caught.

- [ ] **Step 5: Confirm no behaviour changed**

Run one normal crew task end-to-end in the TEST project: spawn → work → `squadrant crew signal done`.

Expected: identical notifications to before this slice — same CREW DONE, same timing, no new or missing signals. **Slice 1 is read-only; any observable difference is a defect in this slice, not an improvement.**

- [ ] **Step 6: Record the agent versions used**

```bash
claude --version && opencode --version
```

Neither wire format is a promised-stable contract (Claude advertises `peerProtocol: 1`; opencode 1.18.18 is mid-migration from `/session/*` to `/api/session/*`). Record both versions in the PR description.

- [ ] **Step 7: Add the re-smoke rule to the checklist**

Append to `docs/testing/crew-lifecycle-checklist.md`:

```markdown
## Agent upgrades (#667)

Squadrant reads two agent-internal surfaces that are **not** promised-stable public
contracts:

- claude: `~/.claude/sessions/<pid>.json` (`status`, `waitingFor`, `statusUpdatedAt`)
- opencode: the HTTP event bus and `/session/*` routes (mid-migration to `/api/session/*`)

**Upgrading either agent requires re-running the live smoke in this checklist.**
Probe for capability — does the file parse, does `connect()` succeed — and never
compare version strings.
```

- [ ] **Step 8: Commit and open the PR**

```bash
git add docs/testing/crew-lifecycle-checklist.md
git commit -m "docs(#667): require a re-smoke of the lifecycle checklist on agent upgrade"
gh pr create --base develop --title "feat(#667): slice 1 — native agent liveness" \
  --body "Implements §3 of docs/specs/2026-08-13-agent-control-channel-design.md.

Read-only slice: adds ClaudePeerRegistrySource, puts OpencodeSseBridge behind the
LifecycleSource port, corrects the stale port comment. No behaviour changes.

Removes two of the five false signals recorded on 2026-08-13:
- CREW IDLE during a live tool call → claude reports status:\"busy\" itself
- CREW STALLED with no process     → kill(pid, 0)

Smoke evidence and agent versions below."
```

---

## Success Criteria

Slice 1 is done when **all** of these hold:

1. `pnpm build && pnpm test` green **and CI green on the PR** (not just locally).
2. `node dist/index.js --help` and `node dist/squadrantd.js --help` both run.
3. `squadrant heal status` lists `claude-peer-registry` and `opencode-control`.
4. Live smoke shows a real `idle → busy` transition read from the Claude registry.
5. Live smoke shows `waitingFor: "permission prompt"` reaching the daemon as `needsInput` — the signal with no observable signature from outside a terminal.
6. Live smoke shows a `kill -9`'d crew reported `unknown`/`alive:false`, not its frozen status.
7. A normal crew task produces **byte-identical notification behaviour** to before the slice.

## Explicit Non-Goals

- Retiring the v0.15.0 `LivenessRegistry` or pid floor. The new sources run **alongside** them. Removal is a later decision made on data — retiring early is the fastest way to replace one layer of false signals with another.
- Any delivery-path change. `confirmedSendToPane` is untouched (that is slices 2 and 3).
- Modifying `sse-bridge.ts` internals.
- Fixing #514/#657. This slice does not touch them.
