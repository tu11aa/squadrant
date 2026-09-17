# Opencode captain delivery — native HTTP channel (#786) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opencode captain launched by squadrant receives captain-bound lifecycle notifications over opencode's HTTP control API (no pane scraping); a captain that cannot be delivered to produces one actionable alert instead of an unbounded `no-box` deferral.

**Architecture:** Captain launch becomes agent-aware: an opencode captain boots as an interactive TUI on a chosen `--port` (never `-c`), the startup prompt goes through the pane (which is what *creates and displays* the session), and the CLI then resolves the session id by **realpath-exact directory** and persists a captain-address record at `<stateRoot>/<project>/captain.json`. The daemon reads that record to pick a per-agent `ControlChannel` (claude peer socket, opencode HTTP) and target a deterministic session id, with a one-shot re-resolve on a stale id. When no channel/address exists for a captain whose agent *has* a control channel, delivery defers with a new `no-channel` reason that alerts immediately and re-checks on a slow cadence — the mailbox entry is never dropped.

**Tech Stack:** TypeScript (ESM, vitest), pnpm workspaces, node `fs`/`net`/`fetch`, cmux runtime.

**Spec:** [`docs/specs/2026-09-17-opencode-captain-delivery-design.md`](../specs/2026-09-17-opencode-captain-delivery-design.md) — §2 holds the 13 live verification results this plan is built on. **Read §2 first**; three of its findings are load-bearing and non-obvious:

1. `-c` resumes the newest session **project-wide**, so inside one repo a crew worktree session can win over the captain's. Never use `-c`.
2. On a cold start there is **no** session until a turn is started — the startup prompt through the pane is what creates it.
3. opencode returns `directory` as a **realpath**; string-comparing the config path matches nothing.

**Out of scope (deliberate):** the crew-side resolver misroute (`OpencodeHttpChannel.resolveSession` is still project-wide for crews — separate follow-up), captain turn-end/SSE (belongs to #628), `opencode` interactive ignoring `model` (separate issue), the `command` role.

---

## File structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `packages/core/src/captain-record.ts` | **create** | Pure/fs: `CaptainAddress` shape, path, atomic read/write, realpath-equality, and `resolveAndPersistOpencodeCaptain` (bounded poll → write) |
| `packages/core/src/opencode-session.ts` | **create** | Pure + fetch: list sessions over HTTP, newest-in-directory, deadline poll |
| `packages/core/src/delivery/defer-delivery.ts` | modify | `DeferReason` gains `"no-channel"` |
| `packages/core/src/daemon/context.ts` | modify | `captainChannels` + `captainAgentFor` injected surface |
| `packages/core/src/daemon/delivery-loop.ts` | modify | Pick the channel by agent; `no-channel` verdict, immediate alert, slow backoff |
| `packages/core/src/index.ts` | modify | Export the two new modules |
| `packages/agents/src/drivers/types.ts` | modify | `SpawnOptions.sessionId?` |
| `packages/agents/src/drivers/opencode.ts` | modify | Interactive command honours `sessionId` |
| `packages/agents/src/drivers/launch-cmd.ts` | modify | Captain role passes `interactive`/`port`/`sessionId` to non-claude drivers |
| `packages/agents/src/opencode/http-channel.ts` | modify | Optional `sessionFor(taskId)` (deterministic ids for captains) |
| `packages/workspaces/src/runtimes/cmux.ts` | modify | `classifyOpencodeStartupSurface` (splash-based readiness) |
| `packages/cli/src/lib/captain-channel-factory.ts` | modify | `buildCaptainChannels()` — claude + opencode from the record, plus `agentFor` |
| `packages/cli/src/commands/launch.ts` | modify | Free port, record read for `--session`, non-repo guard, post-spawn record write, opencode classifier |
| `packages/cli/src/commands/ping.ts` | modify | Use `buildCaptainChannels()` |
| `packages/cli/src/squadrantd.ts` | modify | Build + inject `captainChannels`/`captainAgentFor` |
| `docs/reference.md` | modify | How to run an opencode captain so delivery works |
| `docs/plans/2026-09-17-opencode-captain-delivery-plan.md` | this file | Plan |

**Not modified (verified):** `packages/core/src/captain-channel.ts` (`deliverToCaptain` is unchanged — the loop picks the channel), `packages/core/src/control-channel.ts` (`DeliveryOutcome`/`fallsBackToPane` already model this), `packages/core/src/delivery/captain-delivery.ts` (a new `DeferReason` flows through unchanged), the claude peer channel.

---

## Task 0: Branch + baseline

**Files:** none

- [ ] **Step 1: Branch**

```bash
git fetch origin && git checkout -b feat/786-opencode-captain-delivery origin/develop
git status -sb && git log --oneline -1
```

Expected: on `feat/786-opencode-captain-delivery`, based on `origin/develop`.

- [ ] **Step 2: Record the failing-test baseline**

Run: `pnpm test 2>&1 | tail -40`
Expected: capture the summary line. Known baseline: the relay-proxy tests are flaky (do **not** chase them). Save the failing test names so later tasks are a diff, not a guess.

- [ ] **Step 3: Build once so later `node` probes use fresh `dist/`**

Run: `pnpm build 2>&1 | tail -20` → Expected: exit 0.

---

## Task 1: Captain-address record (core)

**Files:**
- Create: `packages/core/src/captain-record.ts`
- Test: `packages/core/src/__tests__/captain-record.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/captain-record.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captainRecordPath, readCaptainAddress, writeCaptainAddress, sameDirectory,
} from "../captain-record.js";

function stateRoot() { return mkdtempSync(join(tmpdir(), "cap-rec-")); }

describe("captain-address record", () => {
  it("round-trips an opencode address", () => {
    const root = stateRoot();
    const addr = { agent: "opencode", port: 51220, sessionId: "ses_x", directory: "/tmp/p", launchedAt: "2026-09-17T00:00:00.000Z" };
    writeCaptainAddress(root, "demo", addr);
    expect(readCaptainAddress(root, "demo")).toEqual(addr);
  });

  it("returns null for a missing or malformed record", () => {
    const root = stateRoot();
    expect(readCaptainAddress(root, "nope")).toBeNull();
    const p = captainRecordPath(root, "bad");
    mkdirSync(join(root, "bad"), { recursive: true });
    writeFileSync(p, "{not json");
    expect(readCaptainAddress(root, "bad")).toBeNull();
    writeFileSync(p, JSON.stringify({ sessionId: "ses_x" }));  // no agent
    expect(readCaptainAddress(root, "bad")).toBeNull();
  });

  it("sameDirectory compares realpaths, not literal strings", () => {
    const base = mkdtempSync(join(tmpdir(), "cap-dir-"));
    const real = join(base, "real"); const link = join(base, "link");
    mkdirSync(real); symlinkSync(real, link);
    expect(realpathSync(link)).not.toBe(link);            // guard: the test is meaningful
    expect(sameDirectory(realpathSync(real), link)).toBe(true);
    expect(sameDirectory("/tmp/a", "/tmp/b")).toBe(false);
    expect(sameDirectory(undefined, real)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/captain-record.test.ts`
Expected: FAIL — cannot resolve `../captain-record.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/captain-record.ts`:

```ts
// Captain-address record (#786). The captain is not a TaskRecord, so its
// addressable transport (port + session id for opencode) lives in a small
// per-project file that the CLI writes at launch and the daemon reads.
//
// Verified constraints this module encodes (docs/specs/2026-09-17-…-design.md §2):
//  - opencode reports `directory` as a realpath; comparisons must normalize both sides.
//  - `-c` resume is project-wide, so a persisted session id is the only safe resume.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CaptainAddress {
  /** The agent that was ACTUALLY launched (post `--agent` override). */
  agent: string;
  /** opencode embedded HTTP port. Absent for claude. */
  port?: number;
  /** opencode session id, resolved after boot. Absent for claude / pre-resolution. */
  sessionId?: string;
  /** realpath of the project directory the captain runs in. */
  directory: string;
  launchedAt: string;
}

export function captainRecordPath(stateRoot: string, project: string): string {
  return join(stateRoot, project, "captain.json");
}

export function readCaptainAddress(stateRoot: string, project: string): CaptainAddress | null {
  try {
    const parsed = JSON.parse(readFileSync(captainRecordPath(stateRoot, project), "utf-8")) as CaptainAddress;
    return parsed && typeof parsed.agent === "string" ? parsed : null;
  } catch {
    return null;   // absent or malformed both mean "no recorded address"
  }
}

export function writeCaptainAddress(stateRoot: string, project: string, addr: CaptainAddress): void {
  const p = captainRecordPath(stateRoot, project);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(addr, null, 2) + "\n");
}

/** realpath when it resolves, the input otherwise (a not-yet-existing dir is not fatal). */
export function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** True when both paths name the same directory after realpath normalization. */
export function sameDirectory(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const strip = (s: string) => realpathOrSelf(s).replace(/\/+$/, "");
  return strip(a) === strip(b);
}
```

- [ ] **Step 4: Export from core**

In `packages/core/src/index.ts`, after `export * from "./captain-channel.js";` add:

```ts
export * from "./captain-record.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/core/src/__tests__/captain-record.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/captain-record.ts packages/core/src/__tests__/captain-record.test.ts packages/core/src/index.ts
git commit -m "feat(#786): captain-address record + realpath directory equality"
```

---

## Task 2: opencode session resolver (core)

**Files:**
- Create: `packages/core/src/opencode-session.ts`
- Test: `packages/core/src/__tests__/opencode-session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/opencode-session.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { newestSessionInDirectory, listSessions } from "../opencode-session.js";

const rows = [
  { id: "ses_crew", directory: "/tmp/proj/.worktrees/wt1", time: { updated: 300 } },
  { id: "ses_cap_old", directory: "/tmp/proj", time: { updated: 100 } },
  { id: "ses_cap_new", directory: "/tmp/proj", time: { updated: 200 } },
];

describe("newestSessionInDirectory", () => {
  it("takes the newest session IN the exact directory, ignoring newer siblings", () => {
    expect(newestSessionInDirectory(rows, "/tmp/proj")).toBe("ses_cap_new");
  });
  it("returns null when nothing matches", () => {
    expect(newestSessionInDirectory(rows, "/tmp/other")).toBeNull();
  });
});

describe("listSessions", () => {
  it("falls back from /session to /api/session", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes("/session?") === false && url.endsWith("/session")) throw new Error("boom");
      return { ok: url.endsWith("/api/session"), json: async () => rows } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await listSessions(1234, fetchImpl)).toEqual(rows);
    expect(calls).toEqual(["http://127.0.0.1:1234/session", "http://127.0.0.1:1234/api/session"]);
  });
  it("returns [] when the transport fails", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await listSessions(1234, fetchImpl)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/opencode-session.test.ts`
Expected: FAIL — cannot resolve `../opencode-session.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/opencode-session.ts`:

```ts
// opencode HTTP session lookup (#786). Mirrors the route handling already proven in
// packages/agents/src/opencode/http-channel.ts (legacy /session and /api/session),
// but resolves by DIRECTORY — the one thing that channel deliberately does not do.
//
// Why directory-exact: opencode scopes GET /session by project (the repo's root commit
// hash), which every worktree shares, so "newest session" can be a crew worktree's.
// Verified live — docs/specs/2026-09-17-…-design.md §2 tests 9/10.
import { sameDirectory, writeCaptainAddress } from "./captain-record.js";

export interface OpencodeSessionRow {
  id: string;
  directory?: string;
  time?: { updated?: number };
}

/** GET the session list, trying the legacy route then the /api route. Never throws. */
export async function listSessions(
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<OpencodeSessionRow[]> {
  for (const path of ["/session", "/api/session"]) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, { signal: ac.signal });
      if (!res.ok) continue;
      const rows = (await res.json()) as unknown;
      if (Array.isArray(rows)) return rows as OpencodeSessionRow[];
    } catch {
      // transport failure or bad JSON — try the next route
    } finally {
      clearTimeout(t);
    }
  }
  return [];
}

/** Newest session whose directory is the exact same directory. null when none. */
export function newestSessionInDirectory(
  rows: OpencodeSessionRow[],
  directory: string,
): string | null {
  const hits = rows.filter((r) => sameDirectory(r.directory, directory));
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => ((b.time?.updated ?? 0) > (a.time?.updated ?? 0) ? b : a)).id;
}

/**
 * Poll until a session exists in `directory`. Cold starts have NO session until the
 * first turn is started (§2 test 8), so this is expected to return null for a while.
 */
export async function pollNewestSessionInDirectory(opts: {
  port: number;
  directory: string;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = newestSessionInDirectory(await listSessions(opts.port, opts.fetchImpl), opts.directory);
    if (id) return id;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}
```

- [ ] **Step 4: Add the post-spawn persist helper (same module)**

Append to `packages/core/src/opencode-session.ts`:

```ts
/**
 * Resolve the freshly-booted captain's session id and persist the captain address.
 * Bounded: on timeout nothing is written, which reads downstream as "not deliverable"
 * — the honest outcome (§5.2).
 */
export async function resolveAndPersistOpencodeCaptain(opts: {
  stateRoot: string;
  project: string;
  port: number;
  directory: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const sessionId = await pollNewestSessionInDirectory({
    port: opts.port, directory: opts.directory, timeoutMs: opts.timeoutMs,
    sleep: opts.sleep, fetchImpl: opts.fetchImpl,
  });
  if (!sessionId) return null;
  writeCaptainAddress(opts.stateRoot, opts.project, {
    agent: "opencode", port: opts.port, sessionId,
    directory: opts.directory, launchedAt: new Date().toISOString(),
  });
  return sessionId;
}
```

- [ ] **Step 5: Export from core**

In `packages/core/src/index.ts`, add:

```ts
export * from "./opencode-session.js";
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run packages/core/src/__tests__/opencode-session.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/opencode-session.ts packages/core/src/__tests__/opencode-session.test.ts packages/core/src/index.ts
git commit -m "feat(#786): directory-exact opencode session resolver + captain persist helper"
```

---

## Task 3: opencode driver honours `sessionId`

**Files:**
- Modify: `packages/agents/src/drivers/types.ts:27-65`
- Modify: `packages/agents/src/drivers/opencode.ts:22-34`
- Test: `packages/agents/src/drivers/__tests__/opencode.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agents/src/drivers/__tests__/opencode.test.ts`:

```ts
describe("opencode driver — interactive captain command (#786)", () => {
  const d = createOpencodeDriver();

  it("binds the port and resumes an explicit session", () => {
    expect(d.buildCommand({ prompt: "x", workdir: "/tmp", role: "captain", interactive: true, port: 51220, sessionId: "ses_abc" }))
      .toBe("opencode --session ses_abc --port 51220");
  });

  it("omits --session on a fresh start", () => {
    expect(d.buildCommand({ prompt: "x", workdir: "/tmp", role: "captain", interactive: true, port: 51220 }))
      .toBe("opencode --port 51220");
  });

  it("never uses -c (project-wide resume is unsafe — spec §2 test 9)", () => {
    expect(d.buildCommand({ prompt: "x", workdir: "/tmp", role: "captain", interactive: true, port: 1, sessionId: "ses_a" }))
      .not.toContain(" -c");
  });
});
```

If `createOpencodeDriver` is not already imported in that file, add it to the existing import from `../opencode.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agents/src/drivers/__tests__/opencode.test.ts`
Expected: FAIL on the first assertion — the command is currently `opencode --port 51220` (no `--session`).

- [ ] **Step 3: Add the field to `SpawnOptions`**

In `packages/agents/src/drivers/types.ts`, after the `port?: number;` field:

```ts
  // opencode: an explicit session to resume (`--session <id>`). Absent ⇒ a fresh
  // session. `-c` is deliberately NOT used — inside one repo it resumes the newest
  // session project-wide, so a crew worktree session can win (spec §2 test 9).
  sessionId?: string;
```

- [ ] **Step 4: Update the driver**

In `packages/agents/src/drivers/opencode.ts`, replace the interactive branch of `buildCommand`:

```ts
      // Interactive captains/crews: boot the TUI; the caller delivers turns over the
      // embedded HTTP server bound to --port. Resume is always explicit (--session),
      // never -c (spec §2 test 9).
      if (opts.interactive) {
        let cmd = "opencode";
        if (opts.sessionId) cmd += ` --session ${opts.sessionId}`;
        if (opts.port) cmd += ` --port ${opts.port}`;
        return cmd;
      }
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/agents/src/drivers/__tests__/opencode.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/drivers/types.ts packages/agents/src/drivers/opencode.ts packages/agents/src/drivers/__tests__/opencode.test.ts
git commit -m "feat(#786): opencode interactive command binds --port and resumes --session"
```

---

## Task 4: Captain role boots interactive for non-claude drivers

**Files:**
- Modify: `packages/agents/src/drivers/launch-cmd.ts:26-112`
- Test: `packages/agents/src/drivers/__tests__/launch-cmd.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agents/src/drivers/__tests__/launch-cmd.test.ts`:

```ts
describe("buildAgentCmd — opencode captain interactive boot (#786)", () => {
  const registry = new CapabilityRegistry({ opencode: createOpencodeDriver() });

  it("passes interactive + port, and resumes by session id", () => {
    const cmd = buildAgentCmd("opencode", registry, "captain", false, "auto", undefined, undefined, undefined, undefined, undefined,
      { port: 51220, sessionId: "ses_abc" });
    expect(cmd).toBe("opencode --session ses_abc --port 51220");
  });

  it("stays headless for a non-captain role when no interactive boot is requested", () => {
    const cmd = buildAgentCmd("opencode", registry, "crew", true, "auto");
    expect(cmd).toBe('opencode run "You are a squadrant crew. Read your instructions from crew and begin."');
  });
});
```

Add `createOpencodeDriver` / `buildAgentCmd` / `CapabilityRegistry` to that file's imports if missing. **Note:** the exact positional list must match the final signature after Step 3 — if you add the new options bag as the 11th parameter, the first call above has 11 args and the second has 5. Adjust the arity in the test to match, keeping both behaviours asserted.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agents/src/drivers/__tests__/launch-cmd.test.ts`
Expected: FAIL — the command is the headless `opencode run "…"` form.

- [ ] **Step 3: Extend `buildAgentCmd`**

In `packages/agents/src/drivers/launch-cmd.ts`, add a final parameter after `thinking`:

```ts
  /** #786: interactive boot for the captain role on agents that support it
   *  (opencode). Absent ⇒ today's headless delegate behaviour, unchanged. */
  captainBoot?: { port?: number; sessionId?: string },
```

Then in the non-claude delegate block (currently the object literal passed to `driver.buildCommand`), add:

```ts
    ...(captainBoot && role === "captain"
      ? { interactive: true, ...(captainBoot.port ? { port: captainBoot.port } : {}),
          ...(captainBoot.sessionId ? { sessionId: captainBoot.sessionId } : {}) }
      : {}),
```

Leave the claude branch above it byte-for-byte unchanged.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agents/src/drivers/__tests__/launch-cmd.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/drivers/launch-cmd.ts packages/agents/src/drivers/__tests__/launch-cmd.test.ts
git commit -m "feat(#786): captain role boots interactive for non-claude drivers"
```

---

## Task 5: opencode startup readiness classifier

**Files:**
- Modify: `packages/workspaces/src/runtimes/cmux.ts` (add export near `classifyStartupSurface`, line ~386)
- Test: `packages/workspaces/src/runtimes/__tests__/cmux.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/workspaces/src/runtimes/__tests__/cmux.test.ts` (the file that already tests this module's pure parsers), adding `classifyOpencodeStartupSurface` to its existing import from `../cmux.js`:

```ts
describe("classifyOpencodeStartupSurface (#786)", () => {
  it("is loading while the opencode splash marker is present", () => {
    expect(classifyOpencodeStartupSurface("  Ask anything, / for commands, @ for context...  "))
      .toBe("loading");
  });
  it("is idle once the splash is gone", () => {
    expect(classifyOpencodeStartupSurface("Build · DeepSeek V4.1 Flash\n  ~/me/squadrant:develop"))
      .toBe("idle");
  });
  it("never reports working (opencode has no reliable working marker)", () => {
    expect(classifyOpencodeStartupSurface("anything")).not.toBe("working");
  });
  it("treats an empty screen as loading", () => {
    expect(classifyOpencodeStartupSurface("")).toBe("loading");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/workspaces/src/runtimes/__tests__/cmux.test.ts`
Expected: FAIL — `classifyOpencodeStartupSurface` is not exported.

- [ ] **Step 3: Implement**

In `packages/workspaces/src/runtimes/cmux.ts`, add near the top-level imports:

```ts
import { screenHasSplashMarker } from "@squadrant/core";
```

(`@squadrant/core` is already a dependency of this package — `DeferDelivery` is imported at the top of this same file.)

Then add below `classifyStartupSurface`:

```ts
/**
 * #786: startup readiness for an opencode TUI. The claude classifier above reads a
 * live opencode pane as "loading" forever (no ⏵⏵/Ctx Used chrome), so
 * deliverStartupPrompt would send blind after its 30s timeout and never confirm.
 * opencode has no reliable "working" marker, so this reports only loading/idle;
 * deliverStartupPrompt's phase 3 then confirms the turn by screen change.
 * Marker reuse mirrors the crew path (#499/#656): a stable substring, matched
 * case/whitespace/ellipsis-insensitively.
 */
export function classifyOpencodeStartupSurface(screen: string): "loading" | "idle" {
  if (!screen) return "loading";
  return screenHasSplashMarker(screen, "Ask anything") ? "loading" : "idle";
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/workspaces/src/runtimes/__tests__/cmux.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workspaces/src/runtimes/cmux.ts <that test file>
git commit -m "feat(#786): opencode splash-based startup readiness classifier"
```

---

## Task 6: Launch wiring — port, resume, guard, record write

**Files:**
- Modify: `packages/cli/src/commands/launch.ts`
- Test: `packages/cli/src/commands/__tests__/launch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/src/commands/__tests__/launch.test.ts`:

```ts
describe("opencode captain launch helpers (#786)", () => {
  it("resolves a resume id only from a record of the same agent", () => {
    expect(pickResumeSessionId({ agent: "opencode", sessionId: "ses_a" }, "opencode")).toBe("ses_a");
    expect(pickResumeSessionId({ agent: "claude" }, "opencode")).toBeUndefined();
    expect(pickResumeSessionId(null, "opencode")).toBeUndefined();
  });

  it("treats a non-git project dir as not launchable as an opencode captain", () => {
    expect(isOpencodeCaptainDir("/tmp/definitely-not-a-repo-xyz")).toBe(false);
    expect(isOpencodeCaptainDir(process.cwd())).toBe(true);   // the repo running these tests
  });
});
```

Add `pickResumeSessionId` / `isOpencodeCaptainDir` to the existing import from `../launch.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/commands/__tests__/launch.test.ts`
Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Implement the helpers in `launch.ts`**

Add (keeping the existing `shouldWireCaptainChannel` socket gate untouched — claude only):

```ts
import { execFileSync } from "node:child_process";
import { readCaptainAddress, realpathOrSelf, resolveAndPersistOpencodeCaptain, type CaptainAddress } from "@squadrant/core";

/** #786: resume is explicit and agent-matched — never `-c` (spec §2 test 9). */
export function pickResumeSessionId(
  record: Pick<CaptainAddress, "agent" | "sessionId"> | null,
  agentName: string,
): string | undefined {
  if (!record || record.agent !== agentName) return undefined;
  return record.sessionId;
}

/** #786: opencode puts a commit-less directory in the shared `global` project
 *  (resume spike §T1), so such a directory is not a valid opencode captain home. */
export function isOpencodeCaptainDir(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Wire it into `launchOne`**

Inside `launchOne`, before `await launchOneWorkspace({...})`:

```ts
      const stateRoot = path.join(os.homedir(), ".config", "squadrant", "state");
      const isOpencodeCaptain = role === "captain" && agentName === "opencode" && !!projectName;

      if (isOpencodeCaptain && !isOpencodeCaptainDir(cwd)) {
        console.error(chalk.red(`\n  ✘ '${projectName}' is not a git repo with a commit — an opencode captain needs a stable project identity. Run 'git commit' first.\n`));
        hadFailure = true;
        return;
      }

      const priorRecord = projectName ? readCaptainAddress(stateRoot, projectName) : null;
      const captainPort = isOpencodeCaptain ? await getFreePort() : undefined;
      const captainBoot = isOpencodeCaptain
        ? { port: captainPort, sessionId: pickResumeSessionId(priorRecord, "opencode") }
        : undefined;
```

Add `getFreePort` to the `@squadrant/workspaces` import in this file. In the `agentCmdFactory`, pass the new final argument:

```ts
            return buildAgentCmd(agentName, registry, role, forceFresh, permissionMode, model, TEMPLATES_DIR,
              resolveCaptainSocketPath(captainChannelEnabled, projectName, workspaceName),
              resolveCaptainSessionName(agentName, projectName),
              thinking,
              captainBoot);
```

Wire the agent-aware classifier:

```ts
          classifyScreen: agentName === "opencode" ? classifyOpencodeStartupSurface : classifyStartupSurface,
```

(`classifyOpencodeStartupSurface` comes from `@squadrant/workspaces`.)

Add the record write to the existing `onCreated` callback (it currently is not passed — add it):

```ts
          onCreated: () => {
            if (!projectName) return;
            if (isOpencodeCaptain && captainPort) {
              // Fire-and-forget: the session does not exist until the startup prompt
              // starts a turn (spec §2 test 8), so this waits for it. Timeout ⇒ no
              // record ⇒ the daemon reports "not deliverable", never a silent no-box.
              void resolveAndPersistOpencodeCaptain({
                stateRoot, project: projectName, port: captainPort, directory: realpathOrSelf(cwd),
              }).catch(() => {});
            } else if (role === "captain") {
              // Claude (and any other agent): mark the launch so the daemon knows the
              // captain was squadrant-launched.
              writeCaptainAddress(stateRoot, projectName, {
                agent: agentName, directory: realpathOrSelf(cwd), launchedAt: new Date().toISOString(),
              });
            }
          },
```

`writeCaptainAddress` comes from `@squadrant/core`. Note `onCreated` runs inside the spawn path in `bootWorkspace` (`packages/core/src/launch-workspace.ts:170`), after a real spawn only.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run packages/cli/src/commands/__tests__/launch.test.ts && pnpm -r typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/launch.ts packages/cli/src/commands/__tests__/launch.test.ts
git commit -m "feat(#786): opencode captain launch — port, --session resume, guard, record write"
```

---

## Task 7: `OpencodeHttpChannel.sessionFor`

**Files:**
- Modify: `packages/agents/src/opencode/http-channel.ts`
- Test: `packages/agents/src/opencode/__tests__/http-channel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agents/src/opencode/__tests__/http-channel.test.ts`:

```ts
describe("OpencodeHttpChannel — sessionFor (#786)", () => {
  it("uses the injected session id instead of the project-wide newest heuristic", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("/session")) {
        // a crew worktree session is NEWER — the heuristic would pick it
        return { ok: true, json: async () => [
          { id: "ses_crew", directory: "/p/.worktrees/wt1", time: { updated: 999 } },
          { id: "ses_captain", directory: "/p", time: { updated: 1 } },
        ] } as unknown as Response;
      }
      return { status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    const ch = new OpencodeHttpChannel({ portFor: () => 1234, sessionFor: () => "ses_captain", fetchImpl });
    expect(await ch.send("proj", "hi")).toEqual({ status: "accepted", via: "opencode-http" });
    expect(seen.some((u) => u.includes("/session/ses_crew/"))).toBe(false);
    expect(seen.some((u) => u.includes("/session/ses_captain/prompt_async"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/http-channel.test.ts`
Expected: FAIL — `sessionFor` is not a recognized dep; the request goes to `ses_crew`.

- [ ] **Step 3: Implement**

In `packages/agents/src/opencode/http-channel.ts`:

Add to `OpencodeHttpChannelDeps`:

```ts
  /** Optional deterministic session id for this task. Captains supply one from the
   *  captain-address record; without it the channel falls back to resolveSession's
   *  project-wide "newest" heuristic, which is unsafe across worktrees (#786 §2). */
  sessionFor?: (taskId: string) => string | undefined;
```

Store it in the constructor (`this.sessionFor = deps.sessionFor;`, plus a private field), and in both `send` and `probe`:

```ts
    const sessionId = this.sessionFor?.(taskId) ?? await this.resolveSession(taskId, port);
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agents/src/opencode/__tests__/http-channel.test.ts`
Expected: PASS (existing + 1 new).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/opencode/http-channel.ts packages/agents/src/opencode/__tests__/http-channel.test.ts
git commit -m "feat(#786): OpencodeHttpChannel accepts a deterministic sessionFor"
```

---

## Task 8: `buildCaptainChannels()` (CLI edge)

**Files:**
- Modify: `packages/cli/src/lib/captain-channel-factory.ts`
- Test: `packages/cli/src/commands/__tests__/launch-captain-socket.test.ts` (or a new `captain-channels.test.ts` beside it)

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/lib/__tests__/captain-channels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCaptainAddress } from "@squadrant/core";
import { resolveCaptainAgent } from "../captain-channel-factory.js";

describe("resolveCaptainAgent (#786)", () => {
  const root = () => mkdtempSync(join(tmpdir(), "cap-agent-"));

  it("prefers the launch record over config", () => {
    const r = root();
    writeCaptainAddress(r, "demo", { agent: "opencode", port: 1, directory: "/p", launchedAt: "x" });
    expect(resolveCaptainAgent(r, "demo", "claude")).toBe("opencode");
  });

  it("falls back to config when there is no record", () => {
    expect(resolveCaptainAgent(root(), "demo", "opencode")).toBe("opencode");
    expect(resolveCaptainAgent(root(), "demo", undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/lib/__tests__/captain-channels.test.ts`
Expected: FAIL — `resolveCaptainAgent` is not exported.

- [ ] **Step 3: Implement in `captain-channel-factory.ts`**

Add imports and the new surface (leave `buildCaptainChannel` exactly as it is):

```ts
import { OpencodeHttpChannel } from "@squadrant/agents";
import { readCaptainAddress, type CaptainAddress } from "@squadrant/core";
import type { ControlChannel } from "@squadrant/core";

/** #786: the record wins — `--agent` is a CLI flag that never reaches config. */
export function resolveCaptainAgent(
  stateRoot: string,
  project: string,
  configAgent: string | undefined,
): string | undefined {
  return readCaptainAddress(stateRoot, project)?.agent ?? configAgent;
}

/** #786: one channel per agent that has one. `agentFor` lets the daemon choose. */
export async function buildCaptainChannels(opts: {
  stateRoot: string;
  configAgent?: string;
}): Promise<{ channels: Record<string, ControlChannel>; agentFor: (project: string) => string | undefined }> {
  const claude = await buildCaptainChannel();
  const opencode = new OpencodeHttpChannel({
    portFor: (project) => readCaptainAddress(opts.stateRoot, project)?.port,
    sessionFor: (project) => readCaptainAddress(opts.stateRoot, project)?.sessionId,
  });
  return {
    channels: { claude, opencode },
    agentFor: (project) => resolveCaptainAgent(opts.stateRoot, project, opts.configAgent),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/cli/src/lib/__tests__/captain-channels.test.ts && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/captain-channel-factory.ts packages/cli/src/lib/__tests__/captain-channels.test.ts
git commit -m "feat(#786): buildCaptainChannels — claude + opencode resolved from the captain record"
```

---

## Task 9: Daemon picks the channel by agent

**Files:**
- Modify: `packages/core/src/daemon/context.ts:164-168`
- Modify: `packages/core/src/daemon/delivery-loop.ts:397-443`
- Test: `packages/core/src/daemon/__tests__/delivery-loop-channel.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/daemon/__tests__/delivery-loop-channel.test.ts`, modelling it on
`packages/core/src/daemon/__tests__/delivery-loop.captain-channel.test.ts` (its `makeCtx` helper at
lines ~60-75 builds `captainChannelMode` + `captainChannel` and captures `deliv.deliveryTick`).
Reuse that harness shape: a **fake** `daemonCmux` whose `send` **throws** if called, a
`captainChannels` map whose `opencode.send` records the call, and `captainAgentFor: () => "opencode"`.
Assert:

```ts
it("delivers over the opencode channel and never touches the pane", async () => {
  // … arrange a mailbox entry + project config exactly as the sibling tests do …
  await deliveryTick();
  expect(paneSend).not.toHaveBeenCalled();
  expect(opencodeSend).toHaveBeenCalled();
});

it("defers with reason no-channel (never the pane) when the captain has no channel", async () => {
  // captainAgentFor: () => "opencode", captainChannels: {}
  await deliveryTick();
  expect(paneSend).not.toHaveBeenCalled();
  expect(deliveryStats("demo")?.reason).toBe("no-channel");
  expect(deliveryStats("demo")?.stuck).toBe(true);   // immediate, not after maxDefers
});
```

Copy the arrange/teardown scaffolding verbatim from the sibling delivery-loop tests — do not invent a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/daemon/__tests__/delivery-loop-channel.test.ts`
Expected: FAIL — the pane send is called (current code only ever uses `ctx.captainChannel`).

- [ ] **Step 3: Extend the daemon context**

In `packages/core/src/daemon/context.ts`, beside `captainChannel`:

```ts
  /** #786: per-agent captain channels (claude peer / opencode http). When absent,
   *  behaviour is exactly as before: `captainChannel` only. */
  captainChannels?: Record<string, import("../control-channel.js").ControlChannel>;
  /** #786: the captain's agent for a project (launch record, else config). */
  captainAgentFor?: (project: string) => string | undefined;
```

- [ ] **Step 4: Add `"no-channel"` to `DeferReason`**

In `packages/core/src/delivery/defer-delivery.ts`:

```ts
 *  "probe-failed": the screen probe itself failed (dead surface, cmux down,
 *  bad ref, #714) — an infrastructure failure, never a UI condition.
 *  "no-channel" (#786): this captain's delivery transport is missing — no launch
 *  record / no control channel for its agent. Distinct from every UI condition:
 *  no amount of pane probing can clear it, so it alerts instead of scraping.
 */
export type DeferReason = "no-box" | "modal" | "draft" | "probe-failed" | "no-channel";
```

- [ ] **Step 5: Select the channel and the verdict in the send callback**

In `packages/core/src/daemon/delivery-loop.ts`, replace the body of the `send` callback (currently lines ~397-443) with:

```ts
          const result = await d.deliver(deliverEntry, async (text, sendOpts) => {
            const agent = ctx.captainAgentFor?.(project);
            // #786: with no agent resolver, fall back to the legacy single channel —
            // byte-for-byte the pre-#786 behaviour (existing tests rely on it).
            const picked = ctx.captainAgentFor
              ? (agent ? ctx.captainChannels?.[agent] : undefined)
              : ctx.captainChannel;
            const mode = ctx.captainChannelMode?.() ?? "off";

            if (picked) {
              try {
                const r = await deliverToCaptain(project, text, { channel: picked, mode, log });
                if (r.handled) return;
              } catch (e) {
                log(`captain-channel ${project}: threw, falling back — ${(e as Error).message}`);
              }
              // Addressable but the channel reports gone/unsupported / is off.
              if (agent === "opencode" && mode !== "off") {
                // #786: the record's session id can go stale (captain relaunched).
                // Re-resolve ONCE from the live server; if the address is unchanged
                // there is nothing left to try — report it instead of scraping a
                // pane whose box the claude-tuned detector can never see.
                const rec = readCaptainAddress(stateRoot, project);
                if (rec?.port) {
                  const fresh = newestSessionInDirectory(await listSessions(rec.port), rec.directory);
                  if (fresh && fresh !== rec.sessionId) {
                    writeCaptainAddress(stateRoot, project, { ...rec, sessionId: fresh });
                    return;   // retry on the next tick with the refreshed id
                  }
                }
                throw new DeferDelivery(null, "no-channel");
              }
              // claude with a channel: fall through to the pane, unchanged.
            } else if (ctx.captainAgentFor && (agent === "claude" || agent === "opencode")) {
              // #786: the daemon knows the agent, and it needs a channel it does not
              // have. Never guess at a pane.
              if (mode !== "off") throw new DeferDelivery(null, "no-channel");
            }

            try {
              return await cmux.send(surface!, text, sendOpts);
            } catch (e) {
              // … existing #713 probe-failed re-resolution block, unchanged …
            }
          });
```

Import `readCaptainAddress` / `writeCaptainAddress` from `../captain-record.js` and `listSessions` / `newestSessionInDirectory` from `../opencode-session.js`.

- [ ] **Step 6: Add the alert text and the immediate-stuck path**

In `STUCK_ALERT_TEXT` (`packages/core/src/daemon/delivery-loop.ts:31`), add:

```ts
  "no-channel": (n) =>
    `⚠️ CAPTAIN NOT DELIVERABLE: this project's captain has no control channel (missing launch record, or a manually opened session). Crew notifications are queued and not lost, but cannot be delivered until the captain is launched by squadrant. Run \`squadrant launch <project>\` — a manually opened \`opencode -c\` cannot receive lifecycle notifications. (blocked for ${n}+ retries)`,
```

Then change the stuck condition (line ~499):

```ts
        const stats = d.stats();
        // #786: no-channel is not a UI condition — nothing the operator does in the
        // pane can clear it, so alert on the FIRST defer instead of after maxDefers.
        const stuck = stats.stuck || stats.reason === "no-channel";
        if (stuck && !stuckNotified.has(project)) {
          stuckNotified.add(project);
          const { maxDeferCount, reason } = stats;
          // … existing body unchanged, using maxDeferCount/reason …
        } else if (!stuck && stuckNotified.has(project)) {
          stuckNotified.delete(project);
        }
```

- [ ] **Step 7: Slow the retry cadence for `no-channel`**

In the backoff block (line ~467), cap lower for other reasons but higher for this one:

```ts
            if (stuck) {
              const streak = (projectBackoff.get(project)?.streak ?? 0) + 1;
              const cap = d.stats().reason === "no-channel" ? 300_000 : 60_000;
              const backoffMs = Math.min(cap, 1000 * 2 ** streak);
              projectBackoff.set(project, { nextAttemptAt: Date.now() + backoffMs, streak });
            }
```

- [ ] **Step 8: Run tests**

Run: `pnpm vitest run packages/core/src/daemon/__tests__/delivery-loop-channel.test.ts && pnpm vitest run packages/core/src`
Expected: new tests PASS; the existing delivery-loop tests still PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/daemon/context.ts packages/core/src/daemon/delivery-loop.ts packages/core/src/delivery/defer-delivery.ts packages/core/src/daemon/__tests__/delivery-loop-channel.test.ts
git commit -m "feat(#786): agent-aware captain delivery + explicit no-channel verdict"
```

---

## Task 10: Wire the daemon and `ping`

**Files:**
- Modify: `packages/cli/src/squadrantd.ts:296-314`
- Modify: `packages/cli/src/commands/ping.ts:43-45`

- [ ] **Step 1: Daemon**

In `packages/cli/src/squadrantd.ts`, replace the `captainChannel` build block with:

```ts
  if (!process.env.VITEST) {
    ctx.captainChannelMode = () => loadConfig().defaults.captainChannel ?? "off";
    if (ctx.captainChannelMode() !== "off") {
      const stateRootForCaptains = join(homedir(), ".config", "squadrant", "state");
      void buildCaptainChannelsWithRetry({
        stateRoot: stateRootForCaptains,
        configAgent: loadConfig().defaults.roles?.captain?.agent,
        log,
      })
        .then(({ channels, agentFor }) => {
          ctx.captainChannels = channels;
          ctx.captainAgentFor = agentFor;
          // Keep the claude channel on the legacy field so any other consumer of
          // ctx.captainChannel keeps working.
          ctx.captainChannel = channels.claude;
        })
        .catch((e) => log(`captain-channel: unexpected retry-loop error: ${(e as Error).message}`));
    }
  }
```

Extract the existing backoff loop so both builders share it — do **not** duplicate the policy. In
`captain-channel-factory.ts`, replace the body of `buildCaptainChannelWithRetry` with a call to a new
generic, then add the channels variant:

```ts
/** #712: shared capped-exponential retry. Never gives up — giving up re-enters the
 *  permanent pane-only degradation this exists to remove. */
async function retryForever<T>(build: () => Promise<T>, opts: CaptainChannelRetryOpts = {}): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); }));
  const log = opts.log ?? ((m: string) => console.error(chalk.dim(m)));
  const initialDelayMs = opts.initialDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 60_000;
  let delay = initialDelayMs;
  for (;;) {
    try { return await build(); } catch (e) {
      log(`captain-channel init failed (retrying in ${delay}ms), pane delivery only for now: ${(e as Error).message}`);
      await sleep(delay); delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

export function buildCaptainChannelWithRetry(opts: CaptainChannelRetryOpts = {}): Promise<ClaudePeerChannel> {
  return retryForever(opts.build ?? buildCaptainChannel, opts);
}

export function buildCaptainChannelsWithRetry(
  opts: CaptainChannelRetryOpts & { stateRoot: string; configAgent?: string },
): Promise<{ channels: Record<string, ControlChannel>; agentFor: (project: string) => string | undefined }> {
  return retryForever(
    () => buildCaptainChannels({ stateRoot: opts.stateRoot, configAgent: opts.configAgent }),
    opts,
  );
}
```

Keep `CaptainChannelRetryOpts.build` typed as before; the existing
`buildCaptainChannelWithRetry` tests must stay green.

- [ ] **Step 2: ping**

In `packages/cli/src/commands/ping.ts`, replace the direct `buildCaptainChannel()` call with `buildCaptainChannels(...)` and send through the agent selected by `agentFor(project)`:

```ts
  const stateRoot = join(homedir(), ".config", "squadrant", "state");
  const mode = resolveCaptainChannelMode(config.defaults);
  const { channels, agentFor } = mode === "off"
    ? { channels: {} as Record<string, ControlChannel>, agentFor: () => undefined }
    : await buildCaptainChannels({ stateRoot, configAgent: config.defaults.roles?.captain?.agent });
  const channel = channels[agentFor(project) ?? ""];
```

Add the `homedir`/`join`/`ControlChannel` imports if the file lacks them. Pass `channel` into the
existing `deliverToCaptain` call exactly as before (when `channel` is `undefined`,
`deliverToCaptain` returns not-handled, which is correct for an unknown agent).

- [ ] **Step 3: Typecheck + tests**

Run: `pnpm -r typecheck && pnpm vitest run packages/cli`
Expected: PASS. If existing `ping` tests stub `buildCaptainChannel`, update those stubs to `buildCaptainChannels` in the same commit.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/squadrantd.ts packages/cli/src/commands/ping.ts packages/cli/src/lib/captain-channel-factory.ts
git commit -m "feat(#786): daemon and ping route captain delivery by agent"
```

---

## Task 11: Docs

**Files:**
- Modify: `docs/reference.md` (control/captain channel section)
- Modify: `AGENTS.md` (Captain/Control Channel paragraph)

- [ ] **Step 1: `docs/reference.md`**

In the captain-channel section, add a short subsection:

```markdown
### Running an opencode captain

An opencode captain must be **launched by squadrant** — a manually opened
`opencode -c` has no reachable control API (it binds no TCP port), so lifecycle
notifications cannot be delivered to it. squadrant then:

1. boots the captain as `opencode --session <id> --port <N>` (resume is explicit;
   `-c` is never used — inside one repo it also resumes crew-worktree sessions), and
2. records its address (`port` + `sessionId`) in
   `~/.config/squadrant/state/<project>/captain.json`, which the daemon uses to
   deliver over opencode's HTTP API (`POST /session/<id>/prompt_async`).

If a captain is not deliverable, the daemon raises a single actionable
`CAPTAIN NOT DELIVERABLE` alert (notifier + Telegram + dashboard) and keeps the
notifications queued. Relaunch with `squadrant launch <project>` to clear it.
```

- [ ] **Step 2: `AGENTS.md`**

Extend the Captain/Control Channel bullet with one sentence:

```markdown
- **opencode captains (#786)** are addressable too: squadrant launches them with `--port` and resumes by explicit `--session <id>` (never `-c`), persisting the address in `<stateRoot>/<project>/captain.json`. A captain without a control channel produces one actionable `no-channel` alert instead of an unbounded `no-box` deferral.
```

- [ ] **Step 3: Commit**

```bash
git add docs/reference.md AGENTS.md
git commit -m "docs(#786): how to run an opencode captain so delivery works"
```

---

## Task 12: Live smoke test (the real gate)

Unit tests cannot prove this feature — the whole point is a live TUI. Run all steps against a
**disposable** project so no real captain is disturbed.

- [ ] **Step 0: Create the disposable project**

```bash
mkdir -p /tmp/smoke786 && cd /tmp/smoke786 && git init -q \
  && echo smoke > README.md && git add . && git commit -qm init
squadrant projects add smoke786 /tmp/smoke786 --captain "⚓ smoke786-captain"
```

Expected: `squadrant projects list` shows `smoke786`.

- [ ] **Step 1: Cold launch**

```bash
squadrant launch smoke786 --agent opencode
```

Expected: the `⚓ smoke786-captain` workspace opens an opencode TUI;
`cat ~/.config/squadrant/state/smoke786/captain.json` shows `"agent": "opencode"` with a `port`
and a `sessionId`, and `"directory"` equal to the **realpath** of `/tmp/smoke786`
(on macOS likely `/private/tmp/smoke786`).

- [ ] **Step 2: Verify the delivery path**

```bash
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.config/squadrant/state/smoke786/captain.json'))['port'])")
lsof -nP -iTCP:$PORT -sTCP:LISTEN          # must show a listener
squadrant ping smoke786 "smoke: reply with the single word PONG"
```

Expected: `PONG` (or the message) **appears in the captain pane**; the daemon log shows
`captain-channel smoke786: accepted via opencode-http` and no `no-box` for this project.

- [ ] **Step 3: End-to-end lifecycle event**

```bash
squadrant crew spawn smoke786 "Reply with the single word OK, then run the completion protocol." --agent opencode
```

Expected: when the crew signals done, the captain pane receives the CREW DONE-class notification
**without** any pane scrape (daemon log `outcome=delivered`).

- [ ] **Step 4: Warm relaunch**

Close the `⚓ smoke786-captain` workspace, then `squadrant launch smoke786` again.
Expected: the pane's launch command contains `--session <same id from Step 1>`; a new `ping` still
lands. (`--session`, never `-c`.)

- [ ] **Step 5: The negative case (acceptance #2)**

In the `⚓ smoke786-captain` workspace, stop the squadrant-launched TUI, run `opencode -c` in it by
hand (no `--port`), then:

```bash
squadrant ping smoke786 "smoke: should alert"
```

Expected: within seconds a `CAPTAIN NOT DELIVERABLE` alert fires through the notifier (and Telegram
if configured); the daemon log shows `reason=no-channel`, **not** a `no-box` flood; the message is
still queued (the Step 6 relaunch delivers it).

- [ ] **Step 6: Clean up**

```bash
squadrant crew close smoke786 <any-crew-name>
squadrant runtime stop smoke786
squadrant projects remove smoke786      # if the CLI lacks `remove`, delete the entry from
                                        # ~/.config/squadrant/config.json and rm -rf the state dir
rm -rf /tmp/smoke786
pgrep -fl opencode                      # must show no process you started
```

- [ ] **Step 7: Final verification**

```bash
pnpm test 2>&1 | tail -40
```

Expected: same failure set as Task 0's baseline (relay-proxy flakiness excepted), no new failures.

---

## Self-review notes

- **Spec coverage:** §5.1 → Tasks 3/4/5/6; §5.2 → Tasks 1/2/6; §5.3 → Tasks 7/8/10; §5.4 → Task 9; §5.5 → Task 9 (steps 4–7); §8 acceptance → Task 12; §9 follow-ups intentionally not implemented.
- **Type consistency:** `CaptainAddress` (Task 1) is the only record shape; `sessionFor` (Task 7) matches the `portFor` convention; `captainChannels`/`captainAgentFor` (Task 9) are consumed unchanged in Task 10.
- **Known soft spots to watch during execution:** (a) the exact positional arity of `buildAgentCmd` in Task 4's test must match the final signature (11 args after the new options bag); (b) Task 9's test harness must be copied from `delivery-loop.captain-channel.test.ts`, and its legacy `ctx.captainChannel` fallback must stay green; (c) Task 6's `onCreated` hook only fires on a real spawn (`packages/core/src/launch-workspace.ts:170`), so the record write never runs for an already-existing workspace.
- **Verified during planning:** all `file:line` references in this plan and in the spec resolve to the cited symbol (checked with `sed -n` against `develop` @ `2e347b8`); `squadrant projects remove`, `squadrant runtime stop`, and `squadrant crew close` all exist in the CLI.
