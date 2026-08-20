# Captain Liveness Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stale, restart-volatile, title-sweep captain liveness with a hybrid ground-truth model — cmux store (via a `liveness()` runtime seam) preferred when present, backed by a squadrant-owned persisted registry — so open/close detection, dashboards, and the Telegram probe are correct and survive daemon restarts.

**Architecture:** A core-owned `LivenessRegistry` (persisted to `<stateRoot>/liveness.json`) is the single source of truth. On cmux it is reconciled from `DaemonSurfaceDriver.liveness()` (authoritative — reads the cmux store, distinguishing user-close from crash). A per-tick pid floor (`kill(pid,0)`) arbitrates liveness. Both dashboards and the Telegram boot-if-down probe read this one source. Provenance precedence `runtime ≥ agent > scan` guarantees the two signals never conflict.

**Tech Stack:** TypeScript (NodeNext ESM), Node `child_process`/`fs`, vitest. Monorepo packages: `shared ◄ core ◄ workspaces ◄ cli`, plus `web`.

## Global Constraints

- **Spec:** `docs/specs/2026-07-07-captain-liveness-redesign.md` — every task traces to a spec section.
- **NodeNext imports:** all relative imports use the `.js` extension (e.g. `./liveness-registry.js`). `tsc` + `vitest` miss omissions; the real gate is `node dist/index.js --help` after build.
- **GitNexus first:** before editing ANY existing function/method/class, run `gitnexus_impact({target, direction:"upstream"})` and report blast radius; run `gitnexus_detect_changes()` before each commit (repo CLAUDE.md mandate).
- **Karpathy discipline:** surgical changes only — every changed line traces to this plan; no drive-by refactors; no speculative abstraction.
- **macOS-only:** guard any OS-specific test with `it.skipIf(process.platform !== "darwin")`.
- **Pure-first:** derivation/reconciliation live in pure functions (no I/O, explicit `now`) — mirrors existing `liveness.ts` / `watchdog.ts`.
- **Health IPC shape is FROZEN:** the `health` request still returns `ComponentHealth[]` — do not change its shape; consumers depend on it.
- **Lifecycle testing:** any manual open/close/crash test runs on a **throwaway TEST project only** — never a real captain (a probe on real brove-mobile destroyed its session on 2026-07-07).
- **No new `HealthState` value:** reuse `alive | stale | gone | stopped | unknown`.

---

## File Structure

| File | Responsibility | New? |
|---|---|---|
| `packages/shared/src/types/liveness.ts` | `LivenessEntry`, `LivenessSource`, `RuntimeLivenessRecord`, `Role` types (leaf, zero deps) | **new** |
| `packages/core/src/liveness.ts` | pure derivation `deriveCaptainState` + reconciliation `reconcileLiveness` (extend existing file) | modify |
| `packages/core/src/daemon/liveness-registry.ts` | `LivenessRegistry` class: in-memory map + atomic JSON persistence + boot reconcile | **new** |
| `packages/shared/src/types/runtime.ts` | add optional `liveness()` to the daemon seam type | modify |
| `packages/core/src/interfaces.ts` | add `liveness()` to `DaemonSurfaceDriver` | modify |
| `packages/workspaces/src/cmux-daemon/daemon-cmux.ts` | implement `liveness()` — read store, correlate by template fingerprint | modify |
| `packages/workspaces/src/cmux-daemon/store-fingerprint.ts` | pure helpers: parse store record → `RuntimeLivenessRecord` (role by template, project by cwd) | **new** |
| `packages/core/src/daemon/context.ts` | swap `captainMissingStreak`+`stoppedProjects` → `livenessRegistry` | modify |
| `packages/core/src/daemon/delivery-loop.ts` | remove title-sweep authority; add liveness tick (runtime snapshot + pid floor) | modify |
| `packages/core/src/daemon/start.ts` | health handler derives captain state from the registry | modify |
| `packages/core/src/telegram/control.ts` | `createIsCaptainAlive` → fresh ground-truth at call time | modify |
| `packages/web/src/read-status.ts` | consume `health`; captain-liveness precedence | modify |

---

## Task 1: Pure liveness types + derivation + reconciliation

Spec: §4.2, §4.3, §7. Pure functions only — the testable foundation.

**Files:**
- Create: `packages/shared/src/types/liveness.ts`
- Modify: `packages/core/src/liveness.ts` (append)
- Test: `packages/core/src/__tests__/liveness-derive.test.ts`

**Interfaces:**
- Produces:
  - `type Role = "captain" | "crew" | "command"`
  - `type LivenessSource = "runtime" | "agent" | "scan"`
  - `interface LivenessEntry { project: string; role: Role; pid: number | null; sessionId: string; startedAt: number; lastState: "start" | "end"; lastSeenAt: number; pidAlive: boolean; source: LivenessSource }`
  - `deriveCaptainState(e: LivenessEntry | undefined): HealthState`
  - `reconcileLiveness(prev: LivenessEntry | undefined, next: LivenessEntry): LivenessEntry`

- [ ] **Step 1: Write the failing test** — `packages/core/src/__tests__/liveness-derive.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { deriveCaptainState, reconcileLiveness } from "../liveness.js";
import type { LivenessEntry } from "@squadrant/shared";

const base = (o: Partial<LivenessEntry> = {}): LivenessEntry => ({
  project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000,
  lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime", ...o,
});

describe("deriveCaptainState", () => {
  it("undefined entry → unknown", () => expect(deriveCaptainState(undefined)).toBe("unknown"));
  it("lastState=end → stopped (before pid check)", () =>
    expect(deriveCaptainState(base({ lastState: "end", pidAlive: false }))).toBe("stopped"));
  it("pid dead + record present (crash) → gone", () =>
    expect(deriveCaptainState(base({ lastState: "start", pidAlive: false }))).toBe("gone"));
  it("pid alive → alive", () => expect(deriveCaptainState(base())).toBe("alive"));
});

describe("reconcileLiveness — runtime ≥ agent > scan", () => {
  it("scan may set pidAlive=false but not override runtime presence", () => {
    const prev = base({ source: "runtime", lastState: "start", pidAlive: true });
    const scan = base({ source: "scan", pidAlive: false, lastSeenAt: 2_000 });
    const out = reconcileLiveness(prev, scan);
    expect(out.pidAlive).toBe(false);      // liveness axis updated
    expect(out.lastState).toBe("start");   // presence/intent unchanged by scan
    expect(out.source).toBe("runtime");
  });
  it("scan cannot resurrect a dead pid; only a newer runtime/agent open does", () => {
    const prev = base({ pidAlive: false, startedAt: 1_000 });
    const staleScan = base({ source: "scan", pidAlive: true, startedAt: 1_000, lastSeenAt: 900 });
    expect(reconcileLiveness(prev, staleScan).pidAlive).toBe(false);
    const reopen = base({ source: "runtime", pid: 200, startedAt: 3_000, pidAlive: true });
    expect(reconcileLiveness(prev, reopen).pidAlive).toBe(true);
  });
  it("runtime record end → lastState=end, entry kept (not dropped)", () => {
    const prev = base({ source: "runtime", lastState: "start" });
    const closed = base({ source: "runtime", lastState: "end", lastSeenAt: 2_000 });
    expect(reconcileLiveness(prev, closed).lastState).toBe("end");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/liveness-derive.test.ts`
Expected: FAIL — `deriveCaptainState`/`reconcileLiveness` not exported.

- [ ] **Step 3: Create the types** — `packages/shared/src/types/liveness.ts`

```ts
export type Role = "captain" | "crew" | "command";
export type LivenessSource = "runtime" | "agent" | "scan";

/** Persisted per-component liveness fact. */
export interface LivenessEntry {
  project: string;
  role: Role;
  pid: number | null;
  sessionId: string;
  startedAt: number;
  /** intent: process opened vs cleanly closed. */
  lastState: "start" | "end";
  lastSeenAt: number;
  /** liveness axis — written only by the pid floor. */
  pidAlive: boolean;
  source: LivenessSource;
}

/** One ground-truth record from a runtime's own session store (§5.4). */
export interface RuntimeLivenessRecord {
  role: Role | "unknown";
  project: string;
  pid: number | null;
  sessionId: string;
  present: boolean;
  isRestorable?: boolean;
}
```

Then export from the shared barrel — add to `packages/shared/src/index.ts` (or the `types` re-export used by the repo; confirm the existing pattern, e.g. `export * from "./types/liveness.js";`).

- [ ] **Step 4: Append pure functions** — `packages/core/src/liveness.ts`

```ts
import type { LivenessEntry } from "@squadrant/shared";

/**
 * Pure. Derive a captain HealthState from its registry entry.
 * First match wins — order matters (a clean close reads `stopped` even though
 * its pid also dies).
 */
export function deriveCaptainState(e: LivenessEntry | undefined): HealthState {
  if (!e) return "unknown";
  if (e.lastState === "end") return "stopped"; // clean close — magenta, not a fault (#324)
  if (!e.pidAlive) return "gone";              // pid dead, record present → crash
  return "alive";
}

/**
 * Pure. Reconcile an incoming signal against the prior entry.
 * Precedence: runtime ≥ agent (authoritative for presence/intent) > scan
 * (liveness-only). A `scan` updates `pidAlive` but never presence/intent, and
 * never resurrects a dead pid — only a newer runtime/agent open (greater
 * startedAt) does.
 */
export function reconcileLiveness(
  prev: LivenessEntry | undefined,
  next: LivenessEntry,
): LivenessEntry {
  if (!prev) return next;
  if (next.source === "scan") {
    // liveness-only: adopt pidAlive (and lastSeenAt) onto prev; keep presence/intent.
    // A stale scan (older than prev) must not flip a dead pid back to alive.
    const pidAlive = next.startedAt >= prev.startedAt ? next.pidAlive : prev.pidAlive;
    return { ...prev, pidAlive, lastSeenAt: Math.max(prev.lastSeenAt, next.lastSeenAt) };
  }
  // runtime/agent authoritative. A newer open (or any end) wins; a stale one is ignored.
  if (next.startedAt >= prev.startedAt || next.lastState === "end") return next;
  return prev;
}
```

- [ ] **Step 5: Build shared + run tests**

Run: `npm run build -w @squadrant/shared && cd packages/core && npx vitest run src/__tests__/liveness-derive.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/liveness.ts packages/shared/src/index.ts \
  packages/core/src/liveness.ts packages/core/src/__tests__/liveness-derive.test.ts
git commit -m "feat(liveness): pure captain-state derivation + reconciliation (runtime≥agent>scan)"
```

---

## Task 2: LivenessRegistry with atomic persistence

Spec: §4.1 (persistence), §5.3 (restart survival).

**Files:**
- Create: `packages/core/src/daemon/liveness-registry.ts`
- Test: `packages/core/src/daemon/__tests__/liveness-registry.test.ts`

**Interfaces:**
- Consumes: `LivenessEntry`, `reconcileLiveness` (Task 1).
- Produces:
  - `class LivenessRegistry` with:
    - `constructor(opts: { path: string; readFile?: (p:string)=>string|undefined; writeFile?: (p:string,c:string)=>void })`
    - `load(): void` — seed from disk (missing/corrupt → empty).
    - `get(project: string): LivenessEntry | undefined`
    - `all(): LivenessEntry[]`
    - `apply(next: LivenessEntry): void` — reconcile + persist.
    - `markEnded(project: string, at: number): void` — set `lastState:"end"`, keep entry, persist.
    - `setPidAlive(project: string, alive: boolean, at: number): void` — scan update, persist.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { LivenessRegistry } from "../liveness-registry.js";
import type { LivenessEntry } from "@squadrant/shared";

function memFs() {
  const store = new Map<string, string>();
  return {
    store,
    readFile: (p: string) => store.get(p),
    writeFile: (p: string, c: string) => void store.set(p, c),
  };
}
const cap = (o: Partial<LivenessEntry> = {}): LivenessEntry => ({
  project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000,
  lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime", ...o,
});

describe("LivenessRegistry", () => {
  it("persists and reloads across a simulated restart", () => {
    const fs = memFs();
    const r1 = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    r1.apply(cap());
    const r2 = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    r2.load();
    expect(r2.get("p")?.pid).toBe(100);
  });
  it("markEnded keeps the entry (→ stopped, not forgotten)", () => {
    const fs = memFs();
    const r = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    r.apply(cap());
    r.markEnded("p", 2_000);
    expect(r.get("p")?.lastState).toBe("end");
  });
  it("setPidAlive updates liveness only", () => {
    const fs = memFs();
    const r = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    r.apply(cap());
    r.setPidAlive("p", false, 2_000);
    expect(r.get("p")?.pidAlive).toBe(false);
    expect(r.get("p")?.lastState).toBe("start");
  });
  it("corrupt file loads as empty (no throw)", () => {
    const fs = memFs(); fs.store.set("/x/liveness.json", "{not json");
    const r = new LivenessRegistry({ path: "/x/liveness.json", ...fs });
    expect(() => r.load()).not.toThrow();
    expect(r.all()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/daemon/__tests__/liveness-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry** — `packages/core/src/daemon/liveness-registry.ts`

```ts
import { writeFileSync, readFileSync, renameSync } from "node:fs";
import type { LivenessEntry } from "@squadrant/shared";
import { reconcileLiveness } from "../liveness.js";

export interface LivenessRegistryOpts {
  path: string;
  readFile?: (p: string) => string | undefined;
  writeFile?: (p: string, content: string) => void;
}

/** Core-owned, disk-persisted registry — the single liveness source of truth. */
export class LivenessRegistry {
  private readonly path: string;
  private readonly readFile: (p: string) => string | undefined;
  private readonly writeFile: (p: string, content: string) => void;
  private map = new Map<string, LivenessEntry>();

  constructor(opts: LivenessRegistryOpts) {
    this.path = opts.path;
    this.readFile = opts.readFile ?? ((p) => { try { return readFileSync(p, "utf-8"); } catch { return undefined; } });
    this.writeFile = opts.writeFile ?? ((p, c) => { writeFileSync(`${p}.tmp`, c); renameSync(`${p}.tmp`, p); });
  }

  load(): void {
    const raw = this.readFile(this.path);
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as LivenessEntry[];
      this.map = new Map(arr.map((e) => [e.project, e]));
    } catch { this.map = new Map(); }
  }

  get(project: string): LivenessEntry | undefined { return this.map.get(project); }
  all(): LivenessEntry[] { return [...this.map.values()]; }

  apply(next: LivenessEntry): void {
    this.map.set(next.project, reconcileLiveness(this.map.get(next.project), next));
    this.persist();
  }

  markEnded(project: string, at: number): void {
    const e = this.map.get(project);
    if (!e) return;
    this.map.set(project, { ...e, lastState: "end", lastSeenAt: at });
    this.persist();
  }

  setPidAlive(project: string, alive: boolean, at: number): void {
    const e = this.map.get(project);
    if (!e) return;
    this.map.set(project, { ...e, pidAlive: alive, lastSeenAt: at });
    this.persist();
  }

  private persist(): void {
    try { this.writeFile(this.path, JSON.stringify(this.all(), null, 2)); } catch { /* best-effort */ }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/daemon/__tests__/liveness-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/daemon/liveness-registry.ts packages/core/src/daemon/__tests__/liveness-registry.test.ts
git commit -m "feat(liveness): disk-persisted LivenessRegistry (survives daemon restart)"
```

---

## Task 3: `liveness()` seam + cmux implementation (template-fingerprint correlation)

Spec: §5.2, §5.4, §7. This is where the cmux store becomes ground-truth.

**Files:**
- Create: `packages/workspaces/src/cmux-daemon/store-fingerprint.ts`
- Modify: `packages/shared/src/types/runtime.ts` (or `packages/core/src/interfaces.ts` — see below)
- Modify: `packages/core/src/interfaces.ts` — add `liveness?()` to `DaemonSurfaceDriver`
- Modify: `packages/workspaces/src/cmux-daemon/daemon-cmux.ts` — implement it
- Test: `packages/workspaces/src/cmux-daemon/__tests__/store-fingerprint.test.ts`

**Interfaces:**
- Consumes: `RuntimeLivenessRecord` (Task 1).
- Produces:
  - `parseStoreRecords(fileContent: string, projects: Record<string,{path:string}>, captainTemplate?: string): RuntimeLivenessRecord[]`
  - `DaemonSurfaceDriver.liveness?(): Promise<RuntimeLivenessRecord[]>`

**GitNexus:** run `gitnexus_impact({target:"DaemonSurfaceDriver", direction:"upstream"})` before editing `interfaces.ts`.

- [ ] **Step 1: Write the failing test** — `store-fingerprint.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseStoreRecords } from "../store-fingerprint.js";

const projects = { squadrant: { path: "/Users/me/squadrant" } };

const file = JSON.stringify({
  sessions: {
    a: { sessionId: "a", pid: 41030, cwd: "/Users/me/squadrant", isRestorable: true,
         launchCommand: { arguments: ["claude","--append-system-prompt-file","/x/templates/captain.claude.md"] } },
    b: { sessionId: "b", pid: 74497, cwd: "/Users/me/squadrant", isRestorable: true,
         launchCommand: { arguments: ["claude","--append-system-prompt-file","/x/templates/side.research.claude.md"] } },
    c: { sessionId: "c", pid: null, cwd: "/Users/me/other",
         launchCommand: { arguments: ["claude"] } },
  },
});

describe("parseStoreRecords", () => {
  it("identifies the captain by template, not cwd (captain+side share cwd)", () => {
    const recs = parseStoreRecords(file, projects);
    const cap = recs.find((r) => r.role === "captain");
    expect(cap?.project).toBe("squadrant");
    expect(cap?.pid).toBe(41030);
    expect(cap?.present).toBe(true);
  });
  it("classifies a sibling side-session as role 'command'/'unknown', not captain", () => {
    const recs = parseStoreRecords(file, projects);
    expect(recs.filter((r) => r.role === "captain")).toHaveLength(1);
  });
  it("handles pid:null (hibernated) without dropping the record", () => {
    const recs = parseStoreRecords(file, projects);
    expect(recs.some((r) => r.pid === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/workspaces && npx vitest run src/cmux-daemon/__tests__/store-fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fingerprint parser** — `store-fingerprint.ts`

```ts
import type { RuntimeLivenessRecord, Role } from "@squadrant/shared";

interface RawSession {
  sessionId?: string; pid?: number | null; cwd?: string; isRestorable?: boolean;
  launchCommand?: { arguments?: string[]; workingDirectory?: string };
}

/** template basename → role (captain.claude.md → captain, crew.claude.md → crew, …). */
function roleFromTemplate(args: string[] | undefined): Role | "unknown" {
  const i = args?.indexOf("--append-system-prompt-file") ?? -1;
  const tmpl = i >= 0 && args ? (args[i + 1] ?? "").split("/").pop() ?? "" : "";
  if (tmpl.startsWith("captain")) return "captain";
  if (tmpl.startsWith("crew")) return "crew";
  if (tmpl.startsWith("command")) return "command";
  return "unknown"; // side.research.* etc. — not a captain
}

function projectFromCwd(cwd: string, projects: Record<string, { path: string }>): string | undefined {
  for (const [name, p] of Object.entries(projects)) {
    if (cwd === p.path || cwd.startsWith(`${p.path}/`)) return name;
  }
  return undefined;
}

export function parseStoreRecords(
  fileContent: string,
  projects: Record<string, { path: string }>,
): RuntimeLivenessRecord[] {
  let parsed: { sessions?: Record<string, RawSession> };
  try { parsed = JSON.parse(fileContent); } catch { return []; }
  const out: RuntimeLivenessRecord[] = [];
  for (const s of Object.values(parsed.sessions ?? {})) {
    const cwd = s.cwd ?? s.launchCommand?.workingDirectory ?? "";
    const project = projectFromCwd(cwd, projects);
    if (!project || !s.sessionId) continue;
    out.push({
      role: roleFromTemplate(s.launchCommand?.arguments),
      project,
      pid: typeof s.pid === "number" ? s.pid : null,
      sessionId: s.sessionId,
      present: true,
      isRestorable: s.isRestorable,
    });
  }
  return out;
}
```

- [ ] **Step 4: Add `liveness()` to the daemon seam** — `packages/core/src/interfaces.ts`

Inside `interface DaemonSurfaceDriver`, add (after `readPaneScreen`):

```ts
  /** Ground-truth liveness from the runtime's own session store (§5.4).
   *  Optional — a runtime with no such store omits it. */
  liveness?(): Promise<RuntimeLivenessRecord[]>;
```

Add the import at the top of `interfaces.ts`: `import type { RuntimeLivenessRecord } from "@squadrant/shared";`

- [ ] **Step 5: Implement it in the cmux driver** — `packages/workspaces/src/cmux-daemon/daemon-cmux.ts`

Add a method that reads the store dir and delegates to `parseStoreRecords`. Reuse the store dir resolution from `CmuxStoreSource` (`process.env.CMUX_AGENT_HOOK_STATE_DIR ?? ~/.cmuxterm`), glob `*-hook-sessions.json`, and pass `loadConfig().projects`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "@squadrant/shared";
import { parseStoreRecords } from "./store-fingerprint.js";
import type { RuntimeLivenessRecord } from "@squadrant/shared";

// …inside the daemon-cmux driver object/class…
async liveness(): Promise<RuntimeLivenessRecord[]> {
  const dir = process.env.CMUX_AGENT_HOOK_STATE_DIR ?? join(homedir(), ".cmuxterm");
  const projects = loadConfig().projects as Record<string, { path: string }>;
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith("-hook-sessions.json") && !f.endsWith(".lock")); } catch { return []; }
  const out: RuntimeLivenessRecord[] = [];
  for (const f of files) {
    try { out.push(...parseStoreRecords(readFileSync(join(dir, f), "utf-8"), projects)); } catch { /* skip */ }
  }
  return out;
}
```

(If the config `path` values are `~`-relative, resolve with the repo's `resolveHome` before comparing — check how `read-status.ts` / `launch.ts` resolve `proj.path` and match that.)

- [ ] **Step 6: Run tests + build**

Run: `cd packages/workspaces && npx vitest run src/cmux-daemon/__tests__/store-fingerprint.test.ts && npm run build -w @squadrant/shared -w @squadrant/core -w @squadrant/workspaces`
Expected: PASS + clean build.

- [ ] **Step 7: Commit**

```bash
git add packages/workspaces/src/cmux-daemon/store-fingerprint.ts \
  packages/workspaces/src/cmux-daemon/__tests__/store-fingerprint.test.ts \
  packages/core/src/interfaces.ts packages/workspaces/src/cmux-daemon/daemon-cmux.ts \
  packages/shared/src/types/runtime.ts
git commit -m "feat(liveness): DaemonSurfaceDriver.liveness() + cmux store fingerprint correlation"
```

---

## Task 4: Wire the registry into the daemon — boot reconcile, pid floor, health

Spec: §4.5, §5.3, §6 (pane path). This replaces the streak model.

**Files:**
- Modify: `packages/core/src/daemon/context.ts` (~lines 113-115, 183-184)
- Modify: `packages/core/src/daemon/delivery-loop.ts` (add liveness tick)
- Modify: `packages/core/src/daemon/start.ts` (~lines 100-115 health handler)
- Test: `packages/core/src/daemon/__tests__/liveness-tick.test.ts`

**Interfaces:**
- Consumes: `LivenessRegistry` (Task 2), `DaemonSurfaceDriver.liveness()` (Task 3), `deriveCaptainState` (Task 1).
- Produces: `runLivenessTick(deps): Promise<void>` — one reconcile+floor pass.

**GitNexus:** `gitnexus_impact` on `projectHealth`, `deliveryTick`, and `createDaemonContext` before editing.

- [ ] **Step 1: Write the failing test** — `liveness-tick.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { LivenessRegistry } from "../liveness-registry.js";
import { runLivenessTick } from "../delivery-loop.js";
import type { RuntimeLivenessRecord } from "@squadrant/shared";

const memReg = () => new LivenessRegistry({ path: "/x/l.json", readFile: () => undefined, writeFile: () => {} });

describe("runLivenessTick", () => {
  it("registers a captain from the runtime snapshot and marks it alive", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true };
    await runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => true, now: () => 5_000 });
    expect(reg.get("p")?.pidAlive).toBe(true);
    expect(reg.get("p")?.lastState).toBe("start");
  });
  it("captain absent from snapshot → markEnded (stopped), entry kept", async () => {
    const reg = memReg();
    reg.apply({ project: "p", role: "captain", pid: 100, sessionId: "s", startedAt: 1_000, lastState: "start", lastSeenAt: 1_000, pidAlive: true, source: "runtime" });
    await runLivenessTick({ registry: reg, liveness: async () => [], isPidAlive: () => true, now: () => 5_000 });
    expect(reg.get("p")?.lastState).toBe("end");
  });
  it("present record + dead pid → pidAlive false (→ gone)", async () => {
    const reg = memReg();
    const rec: RuntimeLivenessRecord = { role: "captain", project: "p", pid: 100, sessionId: "s", present: true, isRestorable: true };
    await runLivenessTick({ registry: reg, liveness: async () => [rec], isPidAlive: () => false, now: () => 5_000 });
    expect(reg.get("p")?.pidAlive).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/daemon/__tests__/liveness-tick.test.ts`
Expected: FAIL — `runLivenessTick` not exported.

- [ ] **Step 3: Implement `runLivenessTick`** — export from `packages/core/src/daemon/delivery-loop.ts`

```ts
import type { RuntimeLivenessRecord, LivenessEntry } from "@squadrant/shared";
import type { LivenessRegistry } from "./liveness-registry.js";

export interface LivenessTickDeps {
  registry: LivenessRegistry;
  liveness: () => Promise<RuntimeLivenessRecord[]>;
  isPidAlive: (pid: number) => boolean;
  now: () => number;
}

/** One reconcile+floor pass over captain records. Runtime snapshot is authoritative;
 *  the pid floor arbitrates liveness; a captain absent from the snapshot is marked
 *  cleanly-closed (stopped) but NOT dropped. */
export async function runLivenessTick(deps: LivenessTickDeps): Promise<void> {
  const now = deps.now();
  let records: RuntimeLivenessRecord[] = [];
  try { records = await deps.liveness(); } catch { return; } // runtime unreachable → leave registry as-is
  const seen = new Set<string>();

  for (const r of records) {
    if (r.role !== "captain") continue;
    seen.add(r.project);
    const entry: LivenessEntry = {
      project: r.project, role: "captain", pid: r.pid, sessionId: r.sessionId,
      startedAt: now, lastState: "start", lastSeenAt: now,
      pidAlive: r.pid != null ? deps.isPidAlive(r.pid) : true, // pid:null hibernated → alive-unknown
      source: "runtime",
    };
    // Preserve original startedAt if we already knew this captain (avoid churn):
    const prev = deps.registry.get(r.project);
    if (prev && prev.lastState === "start") entry.startedAt = prev.startedAt;
    deps.registry.apply(entry);
    if (r.pid != null) deps.registry.setPidAlive(r.project, deps.isPidAlive(r.pid), now);
  }

  // Captains we knew but the snapshot no longer lists → clean close.
  for (const e of deps.registry.all()) {
    if (e.role === "captain" && e.lastState === "start" && !seen.has(e.project)) {
      deps.registry.markEnded(e.project, now);
    }
  }
}
```

- [ ] **Step 4: Swap context fields** — `packages/core/src/daemon/context.ts`

Run `gitnexus_impact({target:"createDaemonContext"})`. Replace the two fields (lines ~113-115) and their init (lines ~183-184):

```ts
// remove: captainMissingStreak: Map<string, number>;  stoppedProjects: Set<string>;
// add:
livenessRegistry: LivenessRegistry;
```
```ts
// remove: captainMissingStreak: new Map(), stoppedProjects: new Set(),
// add (construct + load so it survives restart):
livenessRegistry: (() => {
  const r = new LivenessRegistry({ path: join(stateRoot, "liveness.json") });
  r.load();
  return r;
})(),
```
Add imports: `import { LivenessRegistry } from "./liveness-registry.js";` and `join` from `node:path` if not present.

- [ ] **Step 5: Rewrite the health handler** — `packages/core/src/daemon/start.ts` (~lines 100-115)

Replace the streak-derivation block with registry-derived state. Since `projectHealth` currently takes `captainStopped: boolean|null`, extend it minimally to accept a precomputed captain `HealthState` OR translate: pass a mapped boolean-null is lossy (can't express `gone`). Cleanest: add an optional `captainState?: HealthState` param to `projectHealth` that, when provided, wins over `captainStopped`. Then:

```ts
import { deriveCaptainState } from "../liveness.js";
// …
const capEntry = ctx.livenessRegistry.get(project);
out.push(
  ...projectHealth({
    project, now, captainName,
    captainStopped: null,
    captainState: deriveCaptainState(capEntry), // new optional param, wins when present
    commandPresent: null,
    crews: store.list(project),
  }),
);
```
In `liveness.ts projectHealth`, honor `captainState` when supplied (falls back to the existing `captainStopped` mapping otherwise). Update the captain-row `detail` for `gone` → `"captain process died (crash) — crews reaped"`.

- [ ] **Step 6: Call the tick from the delivery loop**

In `createDelivery`'s `deliveryCore` (or a sibling interval), before/after the existing per-project loop, call:
```ts
await runLivenessTick({
  registry: ctx.livenessRegistry,
  liveness: () => (cmux.liveness ? cmux.liveness() : Promise.resolve([])),
  isPidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  now: () => Date.now(),
});
```
Remove the title-sweep authority (the `captainMissingStreak`/`stoppedProjects` mutation block, lines ~129-152) — the registry now owns captain presence. Keep surface discovery ONLY for the delivery target (finding where to `cmux.send`), driven by the registry's alive captains.

- [ ] **Step 7: Run tests + build + real gate**

Run: `cd packages/core && npx vitest run src/daemon/__tests__/liveness-tick.test.ts && cd ../.. && npm run build && node dist/index.js --help`
Expected: PASS + build ok + `--help` prints (NodeNext `.js` import gate).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/daemon/context.ts packages/core/src/daemon/delivery-loop.ts \
  packages/core/src/daemon/start.ts packages/core/src/liveness.ts \
  packages/core/src/daemon/__tests__/liveness-tick.test.ts
git commit -m "feat(liveness): registry-driven captain health via runtime snapshot + pid floor; retire streak"
```

---

## Task 5: Telegram ground-truth-on-demand (#517 fix)

Spec: §4.5. Direct regression fix.

**Files:**
- Modify: `packages/core/src/telegram/control.ts` (`createIsCaptainAlive`, lines 50-65)
- Test: `packages/core/src/telegram/__tests__/is-captain-alive.test.ts`

**Interfaces:**
- Consumes: the daemon `health` reply (`ComponentHealth[]`) which now reflects the registry (Task 4). `createIsCaptainAlive` signature is unchanged (still `(sock) => (project) => Promise<boolean>`), but "alive" now means a live pid, not a stale streak.

**GitNexus:** `gitnexus_impact({target:"createIsCaptainAlive"})`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isCaptainAliveFromHealth } from "../control.js";
import type { ComponentHealth } from "../../liveness.js";

const row = (state: string): ComponentHealth =>
  ({ kind: "captain", project: "p", ref: "c", state: state as any, lastSeenMs: null });

describe("isCaptainAliveFromHealth", () => {
  it("alive → true", () => expect(isCaptainAliveFromHealth([row("alive")], "p")).toBe(true));
  it("gone (crash) → false → boot", () => expect(isCaptainAliveFromHealth([row("gone")], "p")).toBe(false));
  it("stopped (closed) → false → boot", () => expect(isCaptainAliveFromHealth([row("stopped")], "p")).toBe(false));
  it("unknown/missing → false", () => expect(isCaptainAliveFromHealth([], "p")).toBe(false));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/telegram/__tests__/is-captain-alive.test.ts`
Expected: FAIL — `isCaptainAliveFromHealth` not exported.

- [ ] **Step 3: Extract the pure predicate + keep the request wrapper** — `control.ts`

```ts
import type { ComponentHealth } from "../liveness.js";

/** Pure: a captain counts alive ONLY in state "alive". gone/stopped/unknown → boot. */
export function isCaptainAliveFromHealth(rows: ComponentHealth[], project: string): boolean {
  return rows.some((h) => h.kind === "captain" && h.project === project && h.state === "alive");
}

export function createIsCaptainAlive(sock: string): (project: string) => Promise<boolean> {
  return async (project: string) => {
    try {
      const health = (await sendRequest(sock, { kind: "health", project }, 5000)) as ComponentHealth[];
      return isCaptainAliveFromHealth(health ?? [], project);
    } catch { return false; }
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/telegram/__tests__/is-captain-alive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/telegram/control.ts packages/core/src/telegram/__tests__/is-captain-alive.test.ts
git commit -m "fix(telegram): captain alive check reads fresh pid-verified health (#517)"
```

---

## Task 6: Web dashboard consumes the health source

Spec: §6.

**Files:**
- Modify: `packages/web/src/read-status.ts`
- Test: `packages/web/src/__tests__/read-status.test.ts` (extend)

**Interfaces:**
- Consumes: the `health` IPC (`ComponentHealth[]`) alongside `list`.
- Produces: `deriveState(tasks, captainState)` — captain liveness dominates.

**GitNexus:** `gitnexus_impact({target:"readAllStatuses"})`.

- [ ] **Step 1: Write the failing test** (extend existing)

```ts
import { deriveRowState } from "../read-status.js";

it("captain gone → offline regardless of working tasks", () => {
  expect(deriveRowState([{ state: "working" } as any], "gone")).toBe("offline");
});
it("captain stopped → offline", () => {
  expect(deriveRowState([], "stopped")).toBe("offline");
});
it("captain alive → task-derived", () => {
  expect(deriveRowState([{ state: "working" } as any], "alive")).toBe("busy");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/__tests__/read-status.test.ts`
Expected: FAIL — `deriveRowState` not exported.

- [ ] **Step 3: Implement precedence** — `read-status.ts`

```ts
import type { HealthState } from "@squadrant/core";

/** Captain liveness dominates task activity (§6). */
export function deriveRowState(tasks: TaskRecord[], captainState: HealthState): DashboardState {
  if (captainState === "gone" || captainState === "stopped") return "offline";
  return deriveState(tasks); // existing task-derived busy/blocked/errored/idle
}
```
In `readAllStatuses`, fetch health once (`await deps.call({ kind: "health" })`), index captain state by project, and use `deriveRowState(tasks, capState)`. Keep the `catch → offline` fallback.

- [ ] **Step 4: Run tests + build web**

Run: `cd packages/web && npx vitest run src/__tests__/read-status.test.ts && npm run build -w @squadrant/web`
Expected: PASS + build ok.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/read-status.ts packages/web/src/__tests__/read-status.test.ts
git commit -m "feat(web): dashboard reflects captain liveness (one health source, captain dominates)"
```

---

## Task 7: Retire the old sweep + component logs + full verification

Spec: §4.4 (logs), §10 (sequencing step 6).

**Files:**
- Modify: `packages/core/src/daemon/delivery-loop.ts` (remove dead `discoverCaptainSurface` authority usage, `CAPTAIN_GONE_STREAK_K`)
- Modify: `packages/core/src/daemon/context.ts` (remove any lingering streak refs)
- Grep-sweep: `captainMissingStreak`, `stoppedProjects`, `CAPTAIN_GONE_STREAK_K`

- [ ] **Step 1: Find every remaining reference**

Run: `grep -rn "captainMissingStreak\|stoppedProjects\|CAPTAIN_GONE_STREAK_K" packages --include="*.ts" | grep -v __tests__`
Expected: only definitions left to delete (delivery targets keep using surface discovery, but not for liveness authority).

- [ ] **Step 2: Delete the dead code**

Remove the streak constant, the missing-streak increment block, and `reapOrphanedCrews` invocation tied to the streak — reaping now triggers on captain→`stopped`/`gone` transition in `runLivenessTick` (fold the existing `reapOrphanedCrews(store, project)` call into the `markEnded` branch and the pid-dead branch of Task 4's tick). Keep `reapOrphanedCrews` itself.

- [ ] **Step 3: Add role/source to liveness log lines**

Where the tick applies a record, log: `log(`[${e.role}/${e.source}] ${project} pid=${e.pid} → ${deriveCaptainState(e)}`)`. Keep it one line, grep-able (matches §4.4 examples).

- [ ] **Step 4: Full clean-room build + test + real gate**

Run:
```bash
npm run build && npm test && node dist/index.js --help && node dist/squadrantd.js --help
```
Expected: build clean, all tests pass, both bins print help (NodeNext `.js` import invariant holds for BOTH entry points).

- [ ] **Step 5: `gitnexus_detect_changes` + manual smoke on a THROWAWAY project**

Register a throwaway test project, `squadrant launch <test>`, confirm `squadrant status --detailed` shows the captain `alive`; press workspace-X, confirm it flips to `stopped` within ~1 tick; `kill -9` a fresh captain's pid, confirm `gone`. **Never** run this on a real captain.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(liveness): retire streak-based sweep; role/source logs; final verification"
```

---

## Self-Review (completed)

- **Spec coverage:** §4.1→T2/T4, §4.2/4.3→T1, §4.4→T7, §4.5→T5, §5.1/§7→T1+T3+T4(+T7 smoke), §5.2→T3, §5.3→T2+T4, §5.4→T3, §6→T4(pane)+T6(web). ✅ all sections mapped.
- **Placeholder scan:** no TBD/TODO; every code step carries real code.
- **Type consistency:** `LivenessEntry`, `RuntimeLivenessRecord`, `deriveCaptainState`, `reconcileLiveness`, `runLivenessTick`, `parseStoreRecords`, `isCaptainAliveFromHealth`, `deriveRowState` used consistently across tasks.
- **Open detail for the implementer:** confirm `proj.path` home-resolution in Task 3 Step 5 (match `read-status.ts`); confirm the shared barrel export path in Task 1 Step 3; extend `projectHealth` with the optional `captainState` param in Task 4 Step 5 (verify its current signature with `gitnexus_context({name:"projectHealth"})` first).
