# Event Architecture — Phases 0–1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `core/src/events/` fact pipeline (vocabulary, flight recorder, invariants, conformance suite), then move opencode onto it and delete `OpencodeControlSource`.

**Architecture:** Raw agent signals are translated by per-source `FactAdapter`s into a single typed `AgentFact` stream. The facade stamps identity, appends to an in-memory ring buffer, runs pure invariants, feeds the existing `reduceLifecycle`, and maps facts to `ControlEvent`s. Flow is one-way: nothing reads a `ControlEvent` to produce a fact.

**Tech Stack:** TypeScript (NodeNext — **relative imports MUST end in `.js`**), vitest, pnpm workspaces.

**Spec:** [`docs/specs/2026-08-29-event-architecture-design.md`](../../specs/2026-08-29-event-architecture-design.md)

## Global Constraints

- **NodeNext module resolution.** Every relative import ends in `.js` (e.g. `import { x } from "./fact.js"`). `tsc` and vitest both tolerate a missing extension; the built artifact does not. This has bitten the repo before (#344).
- **Package DAG is one-way:** `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`. `core/src/events/` may import from `@squadrant/shared` only. It must **not** import from `agents`, `workspaces`, or `cli`.
- **Run a single test file:** `pnpm vitest run <path>`
- **Full gate before any phase is called done:** `pnpm build && pnpm test`
- **`invariant.ts` and the fact→event mapping are PURE.** No `Date.now()`, no `fs`, no `process`. Time enters as the fact's `at` field. This is what makes fixture replay deterministic.
- **Adapters MUST NOT throw and MUST NOT return null.** Unrecognised input yields `{ kind: "unknown", name }`.
- **Do not change behaviour in Phase 0.** No wiring into `squadrantd.ts` until Task 10.
- **Never emit `task.blocked` from the pipeline** — not in shadow, not after cutover. Its existing producers keep that job permanently (spec §3).
- Baseline test count before starting: run `pnpm test` once and record it. Every task must leave the suite green.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/events/fact.ts` | `AgentFact` union, `FactAdapter` interface, `stampFact()`. No behaviour. |
| `packages/core/src/events/log.ts` | Flight recorder: per-crew ring buffer, dump-to-JSONL, full-log flag. |
| `packages/core/src/events/invariant.ts` | PURE. `CrewTrace` + `checkFact()` → violations. Depth tracking. |
| `packages/core/src/events/to-control-event.ts` | PURE. `AgentFact` → `ControlEvent[]`. Where existing behaviour lives. |
| `packages/core/src/events/conformance.ts` | Exported adapter conformance suite + fixture registry. |
| `packages/core/src/events/source.ts` | The one `LifecycleSource` facade. Wires adapters → log → invariants → `reduceLifecycle` → `toControlEvent`. |
| `packages/agents/src/opencode/fact-adapter.ts` | Opencode SSE frame → facts. |

Tests live in `__tests__/` beside the code, matching repo convention.

---

## Task 1: Fact vocabulary

**Files:**
- Create: `packages/core/src/events/fact.ts`
- Test: `packages/core/src/events/__tests__/fact.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentFact`, `RawFact`, `FactAdapter`, `FactSource`, `FactOrigin`, `stampFact(raw, ctx) => AgentFact`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/events/__tests__/fact.test.ts
import { describe, it, expect } from "vitest";
import { stampFact } from "../fact.js";

describe("stampFact", () => {
  it("stamps identity fields the adapter must not set", () => {
    const out = stampFact(
      { kind: "turn.ended", turnId: "ses_1" },
      { seq: 7, taskId: "t-42", source: "opencode-sse", origin: "agent", at: 1000 },
    );
    expect(out).toEqual({
      kind: "turn.ended", turnId: "ses_1",
      seq: 7, taskId: "t-42", source: "opencode-sse", origin: "agent", at: 1000,
    });
  });

  it("does not let a raw fact override stamped identity", () => {
    const sneaky = { kind: "activity", origin: "agent", taskId: "hacked" } as never;
    const out = stampFact(sneaky, {
      seq: 1, taskId: "t-1", source: "pane", origin: "inferred", at: 5,
    });
    expect(out.origin).toBe("inferred");
    expect(out.taskId).toBe("t-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/events/__tests__/fact.test.ts`
Expected: FAIL — `Failed to resolve import "../fact.js"`

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/events/fact.ts
/**
 * The one vocabulary every observed agent signal is translated into.
 * Adapters translate; they never classify-and-discard. An unrecognised frame
 * becomes { kind: "unknown" } and is counted — see spec §5.
 */

export type FactSource =
  | "cmux-events" | "claude-hook" | "claude-peer"
  | "cmux-scan"   | "pane"        | "opencode-sse";

/** Trust rank. Declared once per adapter so an adapter cannot lie about it. */
export type FactOrigin = "agent" | "scan" | "inferred";

/** The identity fields the facade owns. An adapter never sets these. */
export interface FactIdentity {
  seq: number;
  taskId: string;
  at: number;
  source: FactSource;
  origin: FactOrigin;
}

/** The payload half — what an adapter produces. */
export type RawFact =
  | { kind: "session.started";      pid?: number; sessionId?: string }
  | { kind: "session.ended" }
  | { kind: "prompt.submitted" }
  | { kind: "turn.ended";           turnId?: string }
  | { kind: "tool.opened";          tool: string }
  | { kind: "tool.closed";          tool?: string }
  | { kind: "input.requested";      question: string; requestId: number }
  | { kind: "permission.requested"; question: string; requestId: number; tool: string }
  | { kind: "activity" }
  | { kind: "process.observed";     alive: boolean; pid?: number }
  | { kind: "unknown";              name: string };

export type AgentFact = RawFact & FactIdentity;
export type FactKind = RawFact["kind"];

/**
 * The seam. One file per signal source; that file is all a new agent needs.
 */
export interface FactAdapter {
  readonly name: FactSource;
  /** Trust rank for every fact this adapter produces. */
  readonly origin: FactOrigin;
  /**
   * Translate one raw frame into zero or more facts.
   * MUST NOT throw. MUST NOT return null/undefined.
   * An unrecognised frame MUST yield [{ kind: "unknown", name }].
   */
  translate(raw: unknown): RawFact[];
}

/** Attach facade-owned identity. Identity always wins over anything on `raw`. */
export function stampFact(raw: RawFact, id: FactIdentity): AgentFact {
  return { ...raw, ...id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/events/__tests__/fact.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/fact.ts packages/core/src/events/__tests__/fact.test.ts
git commit -m "feat(events): AgentFact vocabulary and FactAdapter seam"
```

---

## Task 2: Flight recorder

**Files:**
- Create: `packages/core/src/events/log.ts`
- Test: `packages/core/src/events/__tests__/log.test.ts`

**Interfaces:**
- Consumes: `AgentFact` from Task 1.
- Produces: `class FactLog` with `push(fact)`, `recent(taskId)`, `serialize(taskId)`, `drop(taskId)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/events/__tests__/log.test.ts
import { describe, it, expect } from "vitest";
import { FactLog } from "../log.js";
import type { AgentFact } from "../fact.js";

const f = (seq: number, taskId = "t1"): AgentFact => ({
  kind: "activity", seq, taskId, at: 1000 + seq, source: "pane", origin: "inferred",
});

describe("FactLog", () => {
  it("keeps facts per crew, newest last", () => {
    const log = new FactLog({ capacity: 4 });
    log.push(f(0)); log.push(f(1));
    expect(log.recent("t1").map((x) => x.seq)).toEqual([0, 1]);
  });

  it("drops the oldest fact once capacity is exceeded", () => {
    const log = new FactLog({ capacity: 3 });
    for (let i = 0; i < 5; i++) log.push(f(i));
    expect(log.recent("t1").map((x) => x.seq)).toEqual([2, 3, 4]);
  });

  it("keeps crews isolated from each other", () => {
    const log = new FactLog({ capacity: 2 });
    log.push(f(0, "a")); log.push(f(1, "b"));
    expect(log.recent("a").map((x) => x.seq)).toEqual([0]);
    expect(log.recent("b").map((x) => x.seq)).toEqual([1]);
  });

  it("serializes to newline-delimited JSON, one fact per line", () => {
    const log = new FactLog({ capacity: 4 });
    log.push(f(0)); log.push(f(1));
    const lines = log.serialize("t1").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).seq).toBe(0);
  });

  it("returns an empty array for an unknown crew", () => {
    expect(new FactLog({ capacity: 2 }).recent("nope")).toEqual([]);
  });

  it("frees a crew's buffer on drop", () => {
    const log = new FactLog({ capacity: 2 });
    log.push(f(0));
    log.drop("t1");
    expect(log.recent("t1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/events/__tests__/log.test.ts`
Expected: FAIL — `Failed to resolve import "../log.js"`

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/events/log.ts
import type { AgentFact } from "./fact.js";

export interface FactLogOptions {
  /** Facts retained per crew. Spec §6 default: 256. */
  capacity?: number;
}

/**
 * Flight recorder. Bounded in-memory history per crew; the facade dumps it to
 * disk only when something interesting happens (spec §6). Deliberately has no
 * fs dependency — the caller owns writing, this owns remembering.
 */
export class FactLog {
  private readonly capacity: number;
  private readonly buffers = new Map<string, AgentFact[]>();

  constructor(opts: FactLogOptions = {}) {
    this.capacity = opts.capacity ?? 256;
  }

  push(fact: AgentFact): void {
    let buf = this.buffers.get(fact.taskId);
    if (!buf) { buf = []; this.buffers.set(fact.taskId, buf); }
    buf.push(fact);
    // Ring semantics via shift: capacity is small (256) so the copy cost is
    // irrelevant next to the clarity of keeping a plain ordered array.
    while (buf.length > this.capacity) buf.shift();
  }

  /** Oldest-first snapshot. A fresh array; later pushes never grow it. */
  recent(taskId: string): AgentFact[] {
    return [...(this.buffers.get(taskId) ?? [])];
  }

  /** Newline-delimited JSON, one fact per line, oldest first. */
  serialize(taskId: string): string {
    return this.recent(taskId).map((f) => JSON.stringify(f)).join("\n") + "\n";
  }

  /** Release a finished crew's buffer. */
  drop(taskId: string): void {
    this.buffers.delete(taskId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/events/__tests__/log.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/log.ts packages/core/src/events/__tests__/log.test.ts
git commit -m "feat(events): flight-recorder ring buffer"
```

---

## Task 3: Invariants — depth tracking (I1, I2, I3)

**Files:**
- Create: `packages/core/src/events/invariant.ts`
- Test: `packages/core/src/events/__tests__/invariant.test.ts`

**Interfaces:**
- Consumes: `AgentFact` from Task 1.
- Produces: `CrewTrace`, `freshTrace()`, `checkFact(trace, fact, opts) => Violation[]` (mutates `trace`), `Violation { code, message, taskId, at }`.

**Why depth, not ids:** no tool call id exists in any payload squadrant receives (spec §5). `tool.opened` increments, `tool.closed` decrements. `depth > 0` at turn end is a lost close (#542); `depth < 0` is a lost open.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/events/__tests__/invariant.test.ts
import { describe, it, expect } from "vitest";
import { freshTrace, checkFact } from "../invariant.js";
import type { AgentFact, RawFact } from "../fact.js";

const at0 = 1_000_000;
const mk = (raw: RawFact, at = at0): AgentFact =>
  ({ ...raw, seq: 0, taskId: "t1", at, source: "cmux-events", origin: "agent" });

const codes = (v: { code: string }[]) => v.map((x) => x.code);

describe("depth invariants", () => {
  it("I1: a close with depth 0 is a violation", () => {
    const t = freshTrace();
    expect(codes(checkFact(t, mk({ kind: "tool.closed" }), {}))).toEqual(["I1"]);
  });

  it("balanced open/close produces no violation", () => {
    const t = freshTrace();
    expect(checkFact(t, mk({ kind: "tool.opened", tool: "Bash" }), {})).toEqual([]);
    expect(checkFact(t, mk({ kind: "tool.closed" }), {})).toEqual([]);
  });

  it("tracks parallel tools by depth, not by a single slot", () => {
    const t = freshTrace();
    for (const tool of ["Read", "Grep", "Bash"]) {
      checkFact(t, mk({ kind: "tool.opened", tool }), {});
    }
    checkFact(t, mk({ kind: "tool.closed" }), {});
    // Two still open — a turn end here is still a violation.
    expect(codes(checkFact(t, mk({ kind: "turn.ended" }), {}))).toEqual(["I2"]);
  });

  it("I2: turn end with tools still open is a violation — this is #542", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Edit" }), {});
    const v = checkFact(t, mk({ kind: "turn.ended" }), {});
    expect(codes(v)).toEqual(["I2"]);
    expect(v[0]!.message).toContain("1");
  });

  it("I2: turn end with everything closed is clean, and resets depth", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Edit" }), {});
    checkFact(t, mk({ kind: "tool.closed" }), {});
    expect(checkFact(t, mk({ kind: "turn.ended" }), {})).toEqual([]);
    expect(t.depth).toBe(0);
  });

  it("I2 resets depth so one lost close does not poison every later turn", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Edit" }), {});
    checkFact(t, mk({ kind: "turn.ended" }), {});      // violation, depth reset
    checkFact(t, mk({ kind: "tool.opened", tool: "Read" }), {});
    checkFact(t, mk({ kind: "tool.closed" }), {});
    expect(checkFact(t, mk({ kind: "turn.ended" }), {})).toEqual([]);
  });

  it("I3: an open older than the stall budget is a violation", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Bash" }, at0), {});
    const v = checkFact(t, mk({ kind: "activity" }, at0 + 61_000), { stallBudgetMs: 60_000 });
    expect(codes(v)).toEqual(["I3"]);
  });

  it("I3 does not fire before the budget elapses", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Bash" }, at0), {});
    const v = checkFact(t, mk({ kind: "activity" }, at0 + 59_000), { stallBudgetMs: 60_000 });
    expect(v).toEqual([]);
  });

  it("I3 reports at most once per open window", () => {
    const t = freshTrace();
    checkFact(t, mk({ kind: "tool.opened", tool: "Bash" }, at0), {});
    const opts = { stallBudgetMs: 60_000 };
    expect(codes(checkFact(t, mk({ kind: "activity" }, at0 + 61_000), opts))).toEqual(["I3"]);
    expect(checkFact(t, mk({ kind: "activity" }, at0 + 62_000), opts)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/events/__tests__/invariant.test.ts`
Expected: FAIL — `Failed to resolve import "../invariant.js"`

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/events/invariant.ts
/**
 * PURE relational checks over one crew's fact stream. No clock, no fs — time
 * arrives as fact.at, which is what makes fixture replay deterministic.
 *
 * Deliberately NOT checked: "seq strictly increases". The facade stamps seq, so
 * it always does — the invariant would be vacuous (spec §7).
 */
import type { AgentFact } from "./fact.js";

export type ViolationCode = "I1" | "I2" | "I3" | "I4" | "I5" | "I6";

export interface Violation {
  code: ViolationCode;
  message: string;
  taskId: string;
  at: number;
}

export interface CrewTrace {
  /** Open tool calls. No call id exists in any payload, so we count (spec §5). */
  depth: number;
  /** `at` of the oldest currently-open tool, for I3. */
  oldestOpenAt: number | null;
  /** Suppresses repeat I3 reports for one open window. */
  stallReported: boolean;
}

export interface CheckOptions {
  /** I3 threshold. Omitted disables I3. */
  stallBudgetMs?: number;
}

export function freshTrace(): CrewTrace {
  return { depth: 0, oldestOpenAt: null, stallReported: false };
}

const v = (code: ViolationCode, message: string, f: AgentFact): Violation =>
  ({ code, message, taskId: f.taskId, at: f.at });

/** Advance `trace` by one fact and return any violations that fact caused. */
export function checkFact(
  trace: CrewTrace,
  fact: AgentFact,
  opts: CheckOptions,
): Violation[] {
  const out: Violation[] = [];

  switch (fact.kind) {
    case "tool.opened":
      if (trace.depth === 0) {
        trace.oldestOpenAt = fact.at;
        trace.stallReported = false;
      }
      trace.depth += 1;
      break;

    case "tool.closed":
      if (trace.depth === 0) {
        out.push(v("I1", `tool.closed from ${fact.source} with no open tool`, fact));
      } else {
        trace.depth -= 1;
        if (trace.depth === 0) {
          trace.oldestOpenAt = null;
          trace.stallReported = false;
        }
      }
      break;

    case "turn.ended":
      if (trace.depth > 0) {
        out.push(v("I2", `turn.ended with ${trace.depth} tool call(s) still open`, fact));
        // Reset so one lost close does not poison every later turn.
        trace.depth = 0;
        trace.oldestOpenAt = null;
        trace.stallReported = false;
      }
      break;

    default:
      break;
  }

  // I3 is time-based and evaluated on every fact, not only tool facts.
  if (
    opts.stallBudgetMs !== undefined &&
    trace.depth > 0 &&
    trace.oldestOpenAt !== null &&
    !trace.stallReported &&
    fact.at - trace.oldestOpenAt > opts.stallBudgetMs
  ) {
    trace.stallReported = true;
    out.push(v("I3", `tool open for ${fact.at - trace.oldestOpenAt}ms, past the stall budget`, fact));
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/events/__tests__/invariant.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/invariant.ts packages/core/src/events/__tests__/invariant.test.ts
git commit -m "feat(events): depth-based tool pairing invariants I1-I3"
```

---

## Task 4: Invariants — trust, unknown, and disagreement (I4, I5, I6)

**Files:**
- Modify: `packages/core/src/events/invariant.ts`
- Modify: `packages/core/src/events/__tests__/invariant.test.ts`

**Interfaces:**
- Consumes: `CrewTrace`, `checkFact` from Task 3.
- Produces: extends `CrewTrace` with `unknownSeen: number`, `liveness: Map<FactSource, {alive, at}>`; extends `CheckOptions` with `disagreeWindowMs?: number`.

**Note on I4:** the type system already prevents an `inferred` adapter from claiming `agent` rank, because `origin` is declared on the adapter (Task 1). The runtime check here is the second half: an `inferred` fact must not be the *sole* basis of a terminal event. That is enforced in `to-control-event.ts` (Task 5), and I4 here records the attempt.

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```ts
// append to packages/core/src/events/__tests__/invariant.test.ts

describe("trust, unknown, and disagreement invariants", () => {
  it("I4: an inferred fact that would terminalise is recorded", () => {
    const t = freshTrace();
    const f: AgentFact = {
      kind: "session.ended", seq: 0, taskId: "t1", at: at0,
      source: "pane", origin: "inferred",
    };
    expect(codes(checkFact(t, f, {}))).toEqual(["I4"]);
  });

  it("I4 does not fire for an agent-origin session.ended", () => {
    const t = freshTrace();
    const f: AgentFact = {
      kind: "session.ended", seq: 0, taskId: "t1", at: at0,
      source: "claude-hook", origin: "agent",
    };
    expect(checkFact(t, f, {})).toEqual([]);
  });

  it("I5: any unknown fact is a violation, naming source and event", () => {
    const t = freshTrace();
    const f: AgentFact = {
      kind: "unknown", name: "agent.hook.Wat", seq: 0, taskId: "t1", at: at0,
      source: "cmux-events", origin: "agent",
    };
    const out = checkFact(t, f, {});
    expect(codes(out)).toEqual(["I5"]);
    expect(out[0]!.message).toContain("agent.hook.Wat");
    expect(out[0]!.message).toContain("cmux-events");
  });

  it("I6: two sources disagreeing on liveness inside the window", () => {
    const t = freshTrace();
    const opts = { disagreeWindowMs: 5000 };
    const alive: AgentFact = {
      kind: "process.observed", alive: true, seq: 0, taskId: "t1", at: at0,
      source: "cmux-scan", origin: "scan",
    };
    const dead: AgentFact = {
      kind: "process.observed", alive: false, seq: 1, taskId: "t1", at: at0 + 1000,
      source: "claude-peer", origin: "agent",
    };
    expect(checkFact(t, alive, opts)).toEqual([]);
    expect(codes(checkFact(t, dead, opts))).toEqual(["I6"]);
  });

  it("I6 does not fire once the window has passed", () => {
    const t = freshTrace();
    const opts = { disagreeWindowMs: 5000 };
    checkFact(t, {
      kind: "process.observed", alive: true, seq: 0, taskId: "t1", at: at0,
      source: "cmux-scan", origin: "scan",
    }, opts);
    expect(checkFact(t, {
      kind: "process.observed", alive: false, seq: 1, taskId: "t1", at: at0 + 6000,
      source: "claude-peer", origin: "agent",
    }, opts)).toEqual([]);
  });

  it("I6 does not fire when one source reports twice", () => {
    const t = freshTrace();
    const opts = { disagreeWindowMs: 5000 };
    checkFact(t, {
      kind: "process.observed", alive: true, seq: 0, taskId: "t1", at: at0,
      source: "cmux-scan", origin: "scan",
    }, opts);
    expect(checkFact(t, {
      kind: "process.observed", alive: false, seq: 1, taskId: "t1", at: at0 + 1000,
      source: "cmux-scan", origin: "scan",
    }, opts)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run packages/core/src/events/__tests__/invariant.test.ts`
Expected: the 9 Task-3 tests PASS; the 6 new tests FAIL (no I4/I5/I6 produced)

- [ ] **Step 3: Extend the implementation**

Replace the `CrewTrace`, `freshTrace`, `CheckOptions`, and add to `checkFact`:

```ts
// packages/core/src/events/invariant.ts — replace the interfaces and freshTrace

import type { AgentFact, FactSource } from "./fact.js";

export interface CrewTrace {
  depth: number;
  oldestOpenAt: number | null;
  stallReported: boolean;
  /** Count of unrecognised frames seen, for operator-facing metrics. */
  unknownSeen: number;
  /** Last liveness claim per source, for I6. */
  liveness: Map<FactSource, { alive: boolean; at: number }>;
}

export interface CheckOptions {
  stallBudgetMs?: number;
  /** I6 window. Omitted disables I6. Spec §7 default: 5000. */
  disagreeWindowMs?: number;
}

export function freshTrace(): CrewTrace {
  return {
    depth: 0,
    oldestOpenAt: null,
    stallReported: false,
    unknownSeen: 0,
    liveness: new Map(),
  };
}

/** Facts that would terminalise a crew if acted on alone (spec §7, I4). */
const TERMINALISING: ReadonlySet<string> = new Set(["session.ended"]);
```

Then add these three blocks to `checkFact`'s switch and tail:

```ts
    // inside the switch, before `default:`
    case "unknown":
      trace.unknownSeen += 1;
      out.push(v("I5", `unrecognised frame "${fact.name}" from ${fact.source}`, fact));
      break;

    case "process.observed": {
      const prior = [...trace.liveness.entries()].find(
        ([src, s]) =>
          src !== fact.source &&
          s.alive !== fact.alive &&
          fact.at - s.at <= (opts.disagreeWindowMs ?? -1),
      );
      if (prior) {
        out.push(v(
          "I6",
          `liveness disagreement: ${prior[0]} said alive=${prior[1].alive}, ` +
          `${fact.source} says alive=${fact.alive}`,
          fact,
        ));
      }
      trace.liveness.set(fact.source, { alive: fact.alive, at: fact.at });
      break;
    }
```

```ts
  // at the top of checkFact, before the switch
  if (fact.origin === "inferred" && TERMINALISING.has(fact.kind)) {
    out.push(v("I4", `inferred fact "${fact.kind}" from ${fact.source} cannot terminalise alone`, fact));
  }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm vitest run packages/core/src/events/__tests__/invariant.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/invariant.ts packages/core/src/events/__tests__/invariant.test.ts
git commit -m "feat(events): trust, unknown-rate, and liveness-disagreement invariants I4-I6"
```

---

## Task 5: Fact → ControlEvent mapping

**Files:**
- Create: `packages/core/src/events/to-control-event.ts`
- Test: `packages/core/src/events/__tests__/to-control-event.test.ts`

**Interfaces:**
- Consumes: `AgentFact` from Task 1.
- Produces: `toControlEvent(fact) => ControlEvent[]`.

**This is the critical path.** It must reproduce exactly what today's producers emit, or shadow mode reports disagreements everywhere and cannot distinguish improvement from regression. In Phase 1 it only needs to cover the opencode fact kinds; claude kinds arrive in Phase 2.

**Never emits `task.blocked`** (spec §3) — its existing producers keep that job permanently.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/events/__tests__/to-control-event.test.ts
import { describe, it, expect } from "vitest";
import { toControlEvent } from "../to-control-event.js";
import type { AgentFact, RawFact } from "../fact.js";

const mk = (raw: RawFact): AgentFact =>
  ({ ...raw, seq: 0, taskId: "t1", at: 1000, source: "opencode-sse", origin: "agent" });

describe("toControlEvent", () => {
  it("turn.ended reproduces task.turn.completed with the carried turnId", () => {
    expect(toControlEvent(mk({ kind: "turn.ended", turnId: "ses_9" }))).toEqual([
      { type: "task.turn.completed", id: "t1", turnId: "ses_9" },
    ]);
  });

  it("turn.ended without a turnId falls back to the source name", () => {
    expect(toControlEvent(mk({ kind: "turn.ended" }))).toEqual([
      { type: "task.turn.completed", id: "t1", turnId: "opencode-sse" },
    ]);
  });

  it("permission.requested reproduces task.approval.requested verbatim", () => {
    const out = toControlEvent(mk({
      kind: "permission.requested",
      question: "opencode requests permission to run bash: ls",
      requestId: 7,
      tool: "bash",
    }));
    expect(out).toEqual([{
      type: "task.approval.requested",
      id: "t1",
      requestId: 7,
      question: "opencode requests permission to run bash: ls",
      kind: "bash",
    }]);
  });

  it("activity and unknown emit nothing — they are liveness only", () => {
    expect(toControlEvent(mk({ kind: "activity" }))).toEqual([]);
    expect(toControlEvent(mk({ kind: "unknown", name: "wat" }))).toEqual([]);
  });

  it("an inferred fact never produces a terminal event (I4)", () => {
    const inferred: AgentFact = {
      kind: "session.ended", seq: 0, taskId: "t1", at: 1000,
      source: "pane", origin: "inferred",
    };
    expect(toControlEvent(inferred)).toEqual([]);
  });

  it("an agent-origin session.ended does terminalise", () => {
    const agent: AgentFact = {
      kind: "session.ended", seq: 0, taskId: "t1", at: 1000,
      source: "claude-hook", origin: "agent",
    };
    expect(toControlEvent(agent)).toEqual([{ type: "task.session.ended", id: "t1" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/events/__tests__/to-control-event.test.ts`
Expected: FAIL — `Failed to resolve import "../to-control-event.js"`

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/events/to-control-event.ts
/**
 * PURE. The one place a fact becomes a ControlEvent.
 *
 * CRITICAL: this must reproduce exactly what today's direct producers emit.
 * Any divergence shows up as a shadow-mode disagreement and hides real
 * regressions. Correlation ids (turnId, requestId) travel ON the fact for
 * exactly this reason — regenerating them would differ every run.
 *
 * NEVER emits task.blocked: its existing producers keep that job (spec §3).
 */
import type { ControlEvent } from "@squadrant/shared";
import type { AgentFact } from "./fact.js";

/** Facts that would terminalise. An inferred fact may never do this alone. */
const TERMINALISING: ReadonlySet<string> = new Set(["session.ended"]);

export function toControlEvent(fact: AgentFact): ControlEvent[] {
  // I4 enforced at the boundary, not merely reported: a pane-scraped fact
  // cannot terminalise a live crew (#704).
  if (fact.origin === "inferred" && TERMINALISING.has(fact.kind)) return [];

  switch (fact.kind) {
    case "turn.ended":
      return [{ type: "task.turn.completed", id: fact.taskId, turnId: fact.turnId ?? fact.source }];

    case "permission.requested":
      return [{
        type: "task.approval.requested",
        id: fact.taskId,
        requestId: fact.requestId,
        question: fact.question,
        kind: fact.tool,
      }];

    case "input.requested":
      return [{
        type: "task.input.requested",
        id: fact.taskId,
        requestId: fact.requestId,
        question: fact.question,
      }];

    case "session.ended":
      return [{ type: "task.session.ended", id: fact.taskId }];

    case "session.started":
      return [{
        type: "task.started",
        id: fact.taskId,
        ...(fact.pid === undefined ? {} : { pid: fact.pid }),
        ...(fact.sessionId === undefined ? {} : { sessionId: fact.sessionId }),
      }];

    case "prompt.submitted":
      return [{ type: "task.first-turn.confirmed", id: fact.taskId }];

    // Liveness-only. The facade still feeds these to reduceLifecycle; they
    // simply carry no ControlEvent of their own.
    case "tool.opened":
    case "tool.closed":
    case "activity":
    case "process.observed":
    case "unknown":
      return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/events/__tests__/to-control-event.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/to-control-event.ts packages/core/src/events/__tests__/to-control-event.test.ts
git commit -m "feat(events): pure fact-to-ControlEvent mapping"
```

---

## Task 6: Conformance suite

**Files:**
- Create: `packages/core/src/events/conformance.ts`
- Test: `packages/core/src/events/__tests__/conformance.test.ts`

**Interfaces:**
- Consumes: `FactAdapter` from Task 1.
- Produces: `runAdapterConformance(adapter, samples) => ConformanceCase[]`, where `ConformanceCase = { name: string; run(): void }`.

**This is the entire governance layer** (spec §9): every adapter runs this suite, and Task 10 adds the test that fails the build if an adapter has no registration.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/events/__tests__/conformance.test.ts
import { describe, it, expect } from "vitest";
import { runAdapterConformance } from "../conformance.js";
import type { FactAdapter } from "../fact.js";

const good: FactAdapter = {
  name: "opencode-sse",
  origin: "agent",
  translate(raw) {
    const t = (raw as { type?: string } | null)?.type;
    if (t === "session.idle") return [{ kind: "turn.ended" }];
    return [{ kind: "unknown", name: typeof t === "string" ? t : "non-object" }];
  },
};

const throws: FactAdapter = {
  name: "pane", origin: "inferred",
  translate() { throw new Error("boom"); },
};

const returnsNull: FactAdapter = {
  name: "pane", origin: "inferred",
  translate() { return null as never; },
};

const swallows: FactAdapter = {
  name: "pane", origin: "inferred",
  translate(raw) {
    return (raw as { type?: string } | null)?.type === "session.idle"
      ? [{ kind: "turn.ended" }]
      : [];   // silently drops — the #542 shape
  },
};

const run = (a: FactAdapter) =>
  runAdapterConformance(a, [{ type: "session.idle" }]).map((c) => {
    try { c.run(); return { name: c.name, ok: true }; }
    catch { return { name: c.name, ok: false }; }
  });

describe("adapter conformance", () => {
  it("a well-behaved adapter passes every case", () => {
    expect(run(good).every((r) => r.ok)).toBe(true);
  });

  it("fails an adapter that throws on garbage", () => {
    expect(run(throws).some((r) => !r.ok)).toBe(true);
  });

  it("fails an adapter that returns null", () => {
    expect(run(returnsNull).some((r) => !r.ok)).toBe(true);
  });

  it("fails an adapter that silently drops an unrecognised frame", () => {
    const results = run(swallows);
    expect(results.find((r) => r.name.includes("unknown"))!.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/events/__tests__/conformance.test.ts`
Expected: FAIL — `Failed to resolve import "../conformance.js"`

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/events/conformance.ts
/**
 * The properties EVERY FactAdapter must satisfy, shipped with the seam so a new
 * adapter proves itself WITHOUT the daemon (spec §9).
 *
 * Runner-independent: returns named cases the caller drives with its own
 * `it()`. Assertions use plain throws so this file stays test-framework-free.
 */
import type { FactAdapter } from "./fact.js";

export interface ConformanceCase {
  name: string;
  run(): void;
}

/** Inputs no adapter may choke on. */
const GARBAGE: unknown[] = [
  null, undefined, 0, "", "not json", [], {}, { type: 42 },
  { type: "definitely-not-a-real-event-name" },
];

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`conformance: ${msg}`);
}

/**
 * @param adapter the adapter under test
 * @param samples raw frames this adapter IS expected to recognise
 */
export function runAdapterConformance(
  adapter: FactAdapter,
  samples: unknown[],
): ConformanceCase[] {
  const call = (raw: unknown) => adapter.translate(raw);

  return [
    {
      name: `${adapter.name}: never throws on garbage`,
      run: () => {
        for (const g of GARBAGE) {
          try { call(g); }
          catch (e) { throw new Error(`threw on ${JSON.stringify(g)}: ${String(e)}`); }
        }
      },
    },
    {
      name: `${adapter.name}: never returns null or undefined`,
      run: () => {
        for (const g of [...GARBAGE, ...samples]) {
          const out = call(g);
          assert(Array.isArray(out), `returned a non-array for ${JSON.stringify(g)}`);
        }
      },
    },
    {
      name: `${adapter.name}: an unrecognised frame yields unknown, not an empty array`,
      run: () => {
        const out = call({ type: "definitely-not-a-real-event-name" });
        assert(out.length > 0, "silently dropped an unrecognised frame (the #542 shape)");
        assert(
          out.every((f) => f.kind === "unknown"),
          "an unrecognised frame must translate to kind 'unknown'",
        );
      },
    },
    {
      name: `${adapter.name}: recognises its own samples`,
      run: () => {
        for (const s of samples) {
          const out = call(s);
          assert(out.length > 0, `produced nothing for its own sample ${JSON.stringify(s)}`);
          assert(
            out.some((f) => f.kind !== "unknown"),
            `failed to recognise its own sample ${JSON.stringify(s)}`,
          );
        }
      },
    },
    {
      name: `${adapter.name}: declares a constant origin`,
      run: () => {
        assert(
          adapter.origin === "agent" || adapter.origin === "scan" || adapter.origin === "inferred",
          `invalid origin "${String(adapter.origin)}"`,
        );
      },
    },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/events/__tests__/conformance.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/conformance.ts packages/core/src/events/__tests__/conformance.test.ts
git commit -m "feat(events): adapter conformance suite"
```

---

## Task 7: The facade

**Files:**
- Create: `packages/core/src/events/source.ts`
- Test: `packages/core/src/events/__tests__/source.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6, plus `LifecycleSource` / `LifecycleSourceDeps` from `packages/core/src/lifecycle-source.ts`.
- Produces: `createEventsSource(opts) => EventsSource`, where `EventsSource extends LifecycleSource` and adds `ingest(source, raw, hint)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/events/__tests__/source.test.ts
import { describe, it, expect, vi } from "vitest";
import { createEventsSource } from "../source.js";
import type { FactAdapter } from "../fact.js";
import type { ControlEvent } from "@squadrant/shared";

const sse: FactAdapter = {
  name: "opencode-sse",
  origin: "agent",
  translate(raw) {
    const t = (raw as { type?: string } | null)?.type;
    if (t === "session.idle") return [{ kind: "turn.ended", turnId: "ses_1" }];
    return [{ kind: "unknown", name: typeof t === "string" ? t : "non-object" }];
  },
};

const boom: FactAdapter = {
  name: "pane", origin: "inferred",
  translate() { throw new Error("adapter exploded"); },
};

function harness(adapters: FactAdapter[]) {
  const emitted: ControlEvent[] = [];
  const violations: { code: string }[] = [];
  const src = createEventsSource({
    adapters,
    emit: (ev) => emitted.push(ev),
    onViolation: (v) => violations.push(v),
    now: () => 5000,
  });
  src.start({ resolve: () => ({ id: "t1" }), report: () => {} });
  return { src, emitted, violations };
}

describe("events facade", () => {
  it("translates a raw frame into a ControlEvent", () => {
    const { src, emitted } = harness([sse]);
    src.ingest("opencode-sse", { type: "session.idle" }, { taskId: "t1" });
    expect(emitted).toEqual([{ type: "task.turn.completed", id: "t1", turnId: "ses_1" }]);
  });

  it("stamps a contiguous seq per crew", () => {
    const { src } = harness([sse]);
    src.ingest("opencode-sse", { type: "session.idle" }, { taskId: "t1" });
    src.ingest("opencode-sse", { type: "session.idle" }, { taskId: "t1" });
    expect(src.recent("t1").map((f) => f.seq)).toEqual([0, 1]);
  });

  it("stamps the adapter's origin, never the frame's", () => {
    const { src } = harness([sse]);
    src.ingest("opencode-sse", { type: "session.idle" }, { taskId: "t1" });
    expect(src.recent("t1")[0]!.origin).toBe("agent");
  });

  it("records an unrecognised frame as unknown and reports I5", () => {
    const { src, violations } = harness([sse]);
    src.ingest("opencode-sse", { type: "wat" }, { taskId: "t1" });
    expect(src.recent("t1")[0]).toMatchObject({ kind: "unknown", name: "wat" });
    expect(violations.map((v) => v.code)).toEqual(["I5"]);
  });

  it("contains a throwing adapter: no rethrow, a synthetic unknown, a violation", () => {
    const { src, violations } = harness([boom]);
    expect(() => src.ingest("pane", {}, { taskId: "t1" })).not.toThrow();
    expect(src.recent("t1")[0]).toMatchObject({ kind: "unknown" });
    expect(violations.map((v) => v.code)).toEqual(["I5"]);
  });

  it("drops a frame it cannot correlate to a crew", () => {
    const emitted: ControlEvent[] = [];
    const src = createEventsSource({
      adapters: [sse], emit: (ev) => emitted.push(ev), onViolation: () => {}, now: () => 1,
    });
    src.start({ resolve: () => undefined, report: () => {} });
    src.ingest("opencode-sse", { type: "session.idle" }, {});
    expect(emitted).toEqual([]);
  });

  it("ignores a frame for an unregistered source", () => {
    const { src, emitted } = harness([sse]);
    src.ingest("cmux-events", { type: "session.idle" }, { taskId: "t1" });
    expect(emitted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/events/__tests__/source.test.ts`
Expected: FAIL — `Failed to resolve import "../source.js"`

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/events/source.ts
/**
 * The single LifecycleSource facade. Owns identity stamping, the flight
 * recorder, invariant evaluation, and the fact-to-ControlEvent boundary.
 *
 * Adapters know nothing about crews, seq numbers, or the daemon. They translate.
 */
import type { ControlEvent } from "@squadrant/shared";
import type {
  CorrelationHint, LifecycleSource, LifecycleSourceDeps, LifecycleSnapshot,
} from "../lifecycle-source.js";
import type { AgentFact, FactAdapter, FactSource, RawFact } from "./fact.js";
import { stampFact } from "./fact.js";
import { FactLog } from "./log.js";
import { checkFact, freshTrace } from "./invariant.js";
import type { CheckOptions, CrewTrace, Violation } from "./invariant.js";
import { toControlEvent } from "./to-control-event.js";

export interface EventsSourceOptions {
  adapters: FactAdapter[];
  /** Ingress into the daemon's event pipeline. */
  emit: (ev: ControlEvent) => void;
  onViolation: (v: Violation) => void;
  /** Injected for determinism in tests. */
  now?: () => number;
  capacity?: number;
  check?: CheckOptions;
  log?: (msg: string) => void;
}

export interface EventsSource extends LifecycleSource {
  /** Feed one raw frame from a named adapter. Never throws. */
  ingest(source: FactSource, raw: unknown, hint: CorrelationHint): void;
  /** Flight-recorder read-out for one crew. */
  recent(taskId: string): AgentFact[];
  /** Newline-delimited JSON dump for one crew. */
  dump(taskId: string): string;
}

export function createEventsSource(opts: EventsSourceOptions): EventsSource {
  const now = opts.now ?? (() => Date.now());
  const log = new FactLog({ capacity: opts.capacity });
  const adapters = new Map(opts.adapters.map((a) => [a.name, a]));
  const traces = new Map<string, CrewTrace>();
  const seqs = new Map<string, number>();
  const lastState = new Map<string, LifecycleSnapshot>();
  let deps: LifecycleSourceDeps | undefined;

  const traceFor = (taskId: string): CrewTrace => {
    let t = traces.get(taskId);
    if (!t) { t = freshTrace(); traces.set(taskId, t); }
    return t;
  };

  const nextSeq = (taskId: string): number => {
    const n = seqs.get(taskId) ?? 0;
    seqs.set(taskId, n + 1);
    return n;
  };

  return {
    name: "events",

    start(d) { deps = d; },
    stop() { deps = undefined; },

    snapshot(taskId) { return lastState.get(taskId); },

    health() { return { active: deps !== undefined, error: null }; },

    recent(taskId) { return log.recent(taskId); },
    dump(taskId) { return log.serialize(taskId); },

    ingest(source, raw, hint) {
      const adapter = adapters.get(source);
      if (!adapter || !deps) return;

      const rec = deps.resolve(hint);
      if (!rec) return;
      const taskId = rec.id;
      const at = now();

      // Containment: a broken adapter never kills the source (spec §8).
      let produced: RawFact[];
      try {
        const out = adapter.translate(raw);
        produced = Array.isArray(out) ? out : [{ kind: "unknown", name: `${source} returned non-array` }];
      } catch (e) {
        opts.log?.(`events: adapter ${source} threw: ${String(e)}`);
        produced = [{ kind: "unknown", name: `${source} threw` }];
      }

      for (const rawFact of produced) {
        const fact = stampFact(rawFact, {
          seq: nextSeq(taskId), taskId, at, source, origin: adapter.origin,
        });
        log.push(fact);
        for (const v of checkFact(traceFor(taskId), fact, opts.check ?? {})) {
          opts.onViolation(v);
        }
        for (const ev of toControlEvent(fact)) opts.emit(ev);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/events/__tests__/source.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Export from the package barrel**

Add to `packages/core/src/index.ts`, beside the existing `export * from "./lifecycle-source.js";`:

```ts
export * from "./events/fact.js";
export * from "./events/log.js";
export * from "./events/invariant.js";
export * from "./events/to-control-event.js";
export * from "./events/conformance.js";
export * from "./events/source.js";
```

- [ ] **Step 6: Verify the whole workspace still builds and the suite is green**

Run: `pnpm build && pnpm test`
Expected: build clean, test count = baseline + 47 new tests, zero failures

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/events/source.ts packages/core/src/events/__tests__/source.test.ts packages/core/src/index.ts
git commit -m "feat(events): LifecycleSource facade wiring adapters to the pipeline"
```

**Phase 0 is complete at this commit.** Nothing is wired into `squadrantd.ts`; behaviour is unchanged.

---

## Task 8: Opencode fact adapter

**Files:**
- Create: `packages/agents/src/opencode/fact-adapter.ts`
- Test: `packages/agents/src/opencode/__tests__/fact-adapter.test.ts`

**Interfaces:**
- Consumes: `FactAdapter`, `RawFact`, `runAdapterConformance` from `@squadrant/core`.
- Produces: `createOpencodeFactAdapter(deps) => FactAdapter`, where `deps = { nextRequestId: () => number }`.

**Frames opencode actually sends** (verified in `sse-bridge.ts:198-228`, opencode 1.15.13):

| Frame | Payload | Fact |
|---|---|---|
| `session.idle` | `{ sessionID }` | `turn.ended` with `turnId = sessionID` |
| `permission.asked` | `{ id, sessionID, permission, patterns[] }` | `permission.requested` |
| `permission.replied` | — | `activity` |
| anything else | — | `unknown` |

`requestId` is injected rather than generated internally so the bridge's existing counter stays the single source (spec §5).

- [ ] **Step 1: Write the failing test**

```ts
// packages/agents/src/opencode/__tests__/fact-adapter.test.ts
import { describe, it, expect } from "vitest";
import { runAdapterConformance } from "@squadrant/core";
import { createOpencodeFactAdapter } from "../fact-adapter.js";

const make = () => {
  let n = 1;
  return createOpencodeFactAdapter({ nextRequestId: () => n++ });
};

describe("opencode fact adapter", () => {
  it("declares its identity and trust rank", () => {
    const a = make();
    expect(a.name).toBe("opencode-sse");
    expect(a.origin).toBe("agent");
  });

  it("session.idle becomes turn.ended carrying the session id", () => {
    expect(make().translate({ type: "session.idle", properties: { sessionID: "ses_7" } }))
      .toEqual([{ kind: "turn.ended", turnId: "ses_7" }]);
  });

  it("session.idle without a sessionID still ends the turn", () => {
    expect(make().translate({ type: "session.idle" }))
      .toEqual([{ kind: "turn.ended", turnId: undefined }]);
  });

  it("permission.asked becomes permission.requested with the same wording as today", () => {
    const out = make().translate({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls -la"] },
    });
    expect(out).toEqual([{
      kind: "permission.requested",
      question: "opencode requests permission to run bash: ls -la",
      requestId: 1,
      tool: "bash",
    }]);
  });

  it("permission.asked without patterns omits the command suffix", () => {
    const out = make().translate({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1", permission: "bash" },
    });
    expect(out[0]).toMatchObject({ question: "opencode requests permission to run bash" });
  });

  it("permission.asked missing id or sessionID is unknown, not a silent drop", () => {
    const out = make().translate({ type: "permission.asked", properties: { permission: "bash" } });
    expect(out).toEqual([{ kind: "unknown", name: "permission.asked:incomplete" }]);
  });

  it("permission.replied is liveness only", () => {
    expect(make().translate({ type: "permission.replied" })).toEqual([{ kind: "activity" }]);
  });

  it("an unrecognised frame becomes unknown carrying its type", () => {
    expect(make().translate({ type: "session.error" }))
      .toEqual([{ kind: "unknown", name: "session.error" }]);
  });

  it("does not consume a requestId for frames that are not permission requests", () => {
    const a = make();
    a.translate({ type: "session.idle" });
    const out = a.translate({
      type: "permission.asked",
      properties: { id: "p", sessionID: "s", permission: "bash" },
    });
    expect(out[0]).toMatchObject({ requestId: 1 });
  });
});

describe("opencode fact adapter — conformance", () => {
  for (const c of runAdapterConformance(make(), [
    { type: "session.idle", properties: { sessionID: "ses_1" } },
    { type: "permission.asked", properties: { id: "p", sessionID: "s", permission: "bash" } },
    { type: "permission.replied" },
  ])) {
    it(c.name, () => c.run());
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/fact-adapter.test.ts`
Expected: FAIL — `Failed to resolve import "../fact-adapter.js"`

- [ ] **Step 3: Write the implementation**

```ts
// packages/agents/src/opencode/fact-adapter.ts
/**
 * Opencode SSE frame → AgentFact. Replaces OpencodeControlSource, which read
 * already-translated ControlEvents and translated them back (spec §1, problem 2).
 *
 * Frame shapes verified live against opencode 1.15.13 — see sse-bridge.ts:198.
 */
import type { FactAdapter, RawFact } from "@squadrant/core";

export interface OpencodeFactAdapterDeps {
  /** The bridge's existing counter. Ids must not be regenerated downstream. */
  nextRequestId: () => number;
}

interface Frame {
  type?: unknown;
  properties?: {
    sessionID?: unknown;
    id?: unknown;
    permission?: unknown;
    patterns?: unknown;
  };
}

export function createOpencodeFactAdapter(deps: OpencodeFactAdapterDeps): FactAdapter {
  return {
    name: "opencode-sse",
    origin: "agent",

    translate(raw: unknown): RawFact[] {
      const f = (typeof raw === "object" && raw !== null ? raw : {}) as Frame;
      const type = typeof f.type === "string" ? f.type : undefined;
      if (type === undefined) return [{ kind: "unknown", name: "non-object" }];

      const p = f.properties ?? {};

      if (type === "session.idle") {
        return [{
          kind: "turn.ended",
          turnId: typeof p.sessionID === "string" ? p.sessionID : undefined,
        }];
      }

      if (type === "permission.asked") {
        // The bridge requires both ids to POST an answer later; without them
        // this frame is unusable — record it rather than drop it.
        if (typeof p.id !== "string" || typeof p.sessionID !== "string") {
          return [{ kind: "unknown", name: "permission.asked:incomplete" }];
        }
        const tool = typeof p.permission === "string" ? p.permission : "a tool";
        const cmd = Array.isArray(p.patterns) && p.patterns.length
          ? `: ${p.patterns.join(" ")}`
          : "";
        return [{
          kind: "permission.requested",
          question: `opencode requests permission to run ${tool}${cmd}`,
          requestId: deps.nextRequestId(),
          tool,
        }];
      }

      if (type === "permission.replied") return [{ kind: "activity" }];

      return [{ kind: "unknown", name: type }];
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/fact-adapter.test.ts`
Expected: PASS (9 unit tests + 5 conformance cases = 14)

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/opencode/fact-adapter.ts packages/agents/src/opencode/__tests__/fact-adapter.test.ts
git commit -m "feat(opencode): FactAdapter reading SSE frames directly"
```

---

## Task 9: Route the bridge through facts

**Files:**
- Modify: `packages/agents/src/opencode/sse-bridge.ts:198-228`
- Modify: `packages/agents/src/opencode/__tests__/sse-bridge.test.ts`

**Interfaces:**
- Consumes: `createOpencodeFactAdapter` from Task 8.
- Produces: `OpencodeSseBridge` gains an optional `ingest?: (raw: unknown, taskId: string) => void`. When supplied, the bridge routes lifecycle output through it instead of calling `deps.emit` for `session.idle` and `permission.asked`.

**What must NOT move:** `pendingPermByTask` and `nextRequestId` stay in the bridge. `answer()` depends on the former; the latter is passed into the adapter (spec §5).

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/agents/src/opencode/__tests__/sse-bridge.test.ts

describe("OpencodeSseBridge — fact routing", () => {
  it("routes session.idle through ingest and stops emitting it directly", () => {
    const emitted: unknown[] = [];
    const ingested: unknown[] = [];
    const bridge = new OpencodeSseBridge({
      emit: (ev) => emitted.push(ev),
      ingest: (raw) => ingested.push(raw),
    });
    bridge.handleLineForTest('{"type":"session.idle","properties":{"sessionID":"ses_1"}}', "t1");
    expect(ingested).toHaveLength(1);
    expect(emitted).toEqual([]);
  });

  it("still records pendingPerm on permission.asked so answer() keeps working", () => {
    const bridge = new OpencodeSseBridge({ emit: () => {}, ingest: () => {} });
    bridge.handleLineForTest(
      '{"type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"bash"}}',
      "t1",
    );
    expect(bridge.pendingPermForTest("t1")).toEqual({ permID: "per_1", sessionID: "ses_1" });
  });

  it("falls back to direct emit when no ingest is supplied", () => {
    const emitted: { type: string }[] = [];
    const bridge = new OpencodeSseBridge({ emit: (ev) => emitted.push(ev) });
    bridge.handleLineForTest('{"type":"session.idle","properties":{"sessionID":"ses_1"}}', "t1");
    expect(emitted.map((e) => e.type)).toEqual(["task.turn.completed"]);
  });
});
```

> If `handleLineForTest` / `pendingPermForTest` do not already exist, add them as thin test seams next to the private members they expose. Do not widen the public API beyond these two.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/sse-bridge.test.ts`
Expected: the new block FAILS — `ingest` is not an accepted option

- [ ] **Step 3: Modify the bridge**

In the options interface add:

```ts
  /**
   * When supplied, lifecycle frames are routed here instead of being emitted
   * directly as ControlEvents. Side-effect bookkeeping (pendingPermByTask)
   * still happens in this class — see spec §5.
   */
  ingest?: (raw: unknown, taskId: string) => void;
```

Then in the frame handler, keep the bookkeeping and gate the emission:

```ts
    if (json?.type === "session.idle") {
      if (this.deps.ingest) { this.deps.ingest(json, taskId); return; }
      this.deps.emit({
        type: "task.turn.completed",
        id: taskId,
        turnId: json.properties?.sessionID ?? "opencode",
      });
    } else if (json?.type === "permission.asked") {
      const p = json.properties;
      if (p?.id && p?.sessionID) {
        // Bookkeeping happens on BOTH paths — answer() depends on it.
        this.pendingPermByTask.set(taskId, { permID: p.id, sessionID: p.sessionID });
        if (this.deps.ingest) { this.deps.ingest(json, taskId); return; }
        const tool = p.permission ?? "a tool";
        const cmd = Array.isArray(p.patterns) && p.patterns.length ? `: ${p.patterns.join(" ")}` : "";
        this.deps.emit({
          type: "task.approval.requested",
          id: taskId,
          requestId: this.nextRequestId++,
          question: `opencode requests permission to run ${tool}${cmd}`,
          kind: tool,
        });
      } else if (this.deps.ingest) {
        this.deps.ingest(json, taskId);
      }
    } else if (json?.type === "permission.replied") {
      this.pendingPermByTask.delete(taskId);
      this.deps.ingest?.(json, taskId);
    } else {
      // Previously fell through silently — now recorded (spec §1, problem 5).
      this.deps.ingest?.(json, taskId);
    }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/sse-bridge.test.ts`
Expected: PASS — existing tests unchanged (they supply no `ingest`), 3 new tests green

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/opencode/sse-bridge.ts packages/agents/src/opencode/__tests__/sse-bridge.test.ts
git commit -m "feat(opencode): route SSE lifecycle frames through the fact pipeline"
```

---

## Task 10: Wire the daemon and retire `OpencodeControlSource`

**Files:**
- Modify: `packages/cli/src/squadrantd.ts:176-190` (construction), `:222-225` (source list)
- Delete: `packages/agents/src/opencode/control-source.ts` and its `__tests__/control-source.test.ts`
- Modify: `packages/agents/src/index.ts` (drop the export)
- Modify: `packages/workspaces/src/native-hooks/native-hook-source.ts` (deferred marker only)
- Create: `packages/core/src/events/__tests__/adapter-registry.test.ts`
- Test: `packages/cli/src/__tests__/squadrantd-lifecycle-sources.test.ts`

**Interfaces:**
- Consumes: `createEventsSource` (Task 7), `createOpencodeFactAdapter` (Task 8), the bridge's `ingest` option (Task 9).
- Produces: no new exports. `ctx.lifecycleSources` ends at 3 entries.

- [ ] **Step 1: Write the enforcement test — the entire governance layer**

```ts
// packages/core/src/events/__tests__/adapter-registry.test.ts
import { describe, it, expect } from "vitest";
import { runAdapterConformance } from "../conformance.js";
import { createOpencodeFactAdapter } from "@squadrant/agents";
import type { FactAdapter, FactSource } from "../fact.js";

/**
 * THE enforcement rule (spec §9): every adapter registers a conformance fixture
 * here, or the build fails. This is the whole governance layer — keep it small.
 */
const REGISTRY: Array<{ adapter: FactAdapter; samples: unknown[] }> = [
  {
    adapter: createOpencodeFactAdapter({ nextRequestId: () => 1 }),
    samples: [
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { type: "permission.asked", properties: { id: "p", sessionID: "s", permission: "bash" } },
      { type: "permission.replied" },
    ],
  },
];

/** Adapters wired into the daemon today. Grow this as phases land. */
const WIRED: FactSource[] = ["opencode-sse"];

describe("adapter registry", () => {
  it("every wired adapter has a conformance fixture", () => {
    const registered = REGISTRY.map((r) => r.adapter.name);
    const missing = WIRED.filter((w) => !registered.includes(w));
    expect(missing).toEqual([]);
  });

  for (const { adapter, samples } of REGISTRY) {
    for (const c of runAdapterConformance(adapter, samples)) {
      it(c.name, () => c.run());
    }
  }
});
```

- [ ] **Step 2: Run it to verify it passes already**

Run: `pnpm vitest run packages/core/src/events/__tests__/adapter-registry.test.ts`
Expected: PASS. (This test guards future work; it is green now by construction.)

- [ ] **Step 3: Wire the daemon**

In `packages/cli/src/squadrantd.ts`, replace the `OpencodeControlSource` construction with the events source, and give the bridge its `ingest`:

```ts
  // The one fact pipeline. Adapters are registered here; the facade owns
  // identity, the flight recorder, invariants, and the ControlEvent boundary.
  const opencodeRequestIds = { n: 1 };
  const eventsSource = createEventsSource({
    adapters: [createOpencodeFactAdapter({ nextRequestId: () => opencodeRequestIds.n++ })],
    emit: (ev) => {
      const found = store.listAll().find((r) => r.id === ev.id);
      if (!found) return;
      void ctx.d.handle({ kind: "event", project: found.project, event: ev });
    },
    onViolation: (v) => log(`[events] ${v.code} ${v.taskId}: ${v.message}`),
    check: { stallBudgetMs: 60_000, disagreeWindowMs: 5_000 },
  });

  const opencodeBridge = opts.opencodeBridge ?? new OpencodeSseBridge({
    emit: (ev) => {
      const found = store.listAll().find((r) => r.id === ev.id);
      if (!found) return;
      void ctx.d.handle({ kind: "event", project: found.project, event: ev });
      if (ev.type === "task.approval.requested")
        ctx.schedulePromotion(ev.id, ev.requestId, "approval", ev.question);
    },
    ingest: (raw, taskId) => eventsSource.ingest("opencode-sse", raw, { taskId }),
    log,
  });
```

Then the source list:

```ts
  ctx.lifecycleSources = [
    eventsSource,
    cmuxStoreSource, nativeHookSource, codexAppServerSource,
    claudePeerRegistrySource,
  ];
```

> **Note the promotion gap.** The old direct path called `ctx.schedulePromotion` on `task.approval.requested`. The facade's `emit` above does not. Add the same call inside the facade's `emit` closure, keyed on `ev.type === "task.approval.requested"`, so a gated opencode tool still surfaces to the captain.

- [ ] **Step 4: Update the source-list test**

```ts
// packages/cli/src/__tests__/squadrantd-lifecycle-sources.test.ts
it("registers the events facade and no longer registers OpencodeControlSource", () => {
  const names = ctx.lifecycleSources.map((s) => s.name);
  expect(names).toContain("events");
  expect(names).not.toContain("opencode-control");
});
```

- [ ] **Step 5: Delete the retired source**

```bash
git rm packages/agents/src/opencode/control-source.ts \
       packages/agents/src/opencode/__tests__/control-source.test.ts
```

Remove its export from `packages/agents/src/index.ts` and its import from `packages/cli/src/squadrantd.ts`.

- [ ] **Step 6: Add the deferred marker to NativeHookSource**

At the class doc in `packages/workspaces/src/native-hooks/native-hook-source.ts`, append:

```
 * DEFERRED (2026-08-29): the LifecycleSource half of this class is INERT.
 * handleHook() — the only method that populates `cache` and calls deps.report()
 * — has no caller in shipped code; every reference is in this package's own
 * tests. snapshot() therefore always returns undefined and this source
 * contributes zero lifecycle signals. install() is real and load-bearing (#615).
 * The live claude hook path is: `squadrant hooks claude <sub>` → mapHookSub()
 * → socket → applyEvent. Kept as-is by operator decision; do not delete or
 * wire up without revisiting docs/specs/2026-08-29-event-architecture-design.md.
```

- [ ] **Step 7: Full gate**

Run: `pnpm build && pnpm test`
Expected: build clean; suite green; the deleted `control-source.test.ts` cases gone from the count

- [ ] **Step 8: Verify the success criterion by inspection**

```bash
git diff --name-only <phase-0-final-sha>..HEAD -- packages/core/src/
```

Expected: **only** `packages/core/src/events/__tests__/adapter-registry.test.ts`. Task 8's adapter and Task 9's bridge change touched zero `core/src/` production files. That is the spec §2 bar: a new agent is one adapter file plus one registry entry.

- [ ] **Step 9: Commit**

```bash
git add -A packages/cli/src/squadrantd.ts packages/agents/src packages/workspaces/src/native-hooks packages/core/src/events
git commit -m "feat(events): move opencode onto the fact pipeline, retire OpencodeControlSource"
```

**Phase 1 is complete at this commit.**

---

## Self-review notes

**Spec coverage.** §4 architecture → Tasks 1–7. §5 vocabulary → Task 1, with `turnId`/`requestId`/`tool` carried as the spec's amended note requires. §6 flight recorder → Task 2 (ring buffer) — **disk dump and the `SQUADRANT_FACT_LOG` flag are deliberately NOT in this plan**; `dump()` returns the serialized string and the daemon-side file write lands in Phase 2, when there is a shadow run worth recording. §7 invariants → Tasks 3–4, all six. §8 error handling → Task 7 containment test; **degraded passthrough is not implemented** — it only matters after claude cutover (Phase 3), and building it now would be untested speculation. §9 testing → Tasks 6, 8, 10. §10 phases 0–1 → Tasks 1–10.

**Deferred out of this plan, on purpose:** disk dump + fixture flag (§6), degraded passthrough (§8), the `parallel-tools` fixture capture (§11 — needs a live claude crew, which Phase 2 provides), the three zombie variants (§11), and the `CLAUDE.md:51` doc fix (§11).

**Type consistency check.** `RawFact` (adapter output) vs `AgentFact` (stamped) are used consistently: adapters return `RawFact[]`, `stampFact` produces `AgentFact`, `checkFact`/`toControlEvent` consume `AgentFact`. `FactSource` is the adapter key everywhere. `Violation.code` is the same `ViolationCode` union in Tasks 3, 4, and 7.

**Known risk in Task 9.** The test seams `handleLineForTest` / `pendingPermForTest` may not exist yet. If they do not, add them as the narrowest possible accessors; do not restructure the bridge to make it testable, since Phase 1's whole value is that it is a small, reversible change.
