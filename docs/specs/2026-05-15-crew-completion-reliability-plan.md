# Crew Completion Reliability Implementation Plan (#64)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a finished/blocked Claude crew produce a deterministic cockpit sentinel that the always-on reactor reads — so completion is visible even when the crew never self-reports and the captain is idle/compacted.

**Architecture:** Three layers. (1) Detection adapter — a crew-scoped Claude `Stop`/`SubagentStop`/`Notification` hook (shipped via the cockpit plugin, no global pollution) runs `cockpit crew-signal`. (2) Sentinel — `cockpit crew-signal` writes a normalized JSON file under `~/.config/cockpit/state/<project>/<crew>.<state>.json`. (3) Reactor backstop — `runAutoStatus` scans sentinels each cycle, escalates project state to `blocked`, records crew signals into `status.md`, and best-effort nudges the captain. Layers 2–3 are agent-agnostic; only the hook wiring is Claude-specific (`AgentDriver.crewSignal`), with Codex/Gemini/Aider tracked in #68.

**Tech Stack:** TypeScript, Node ESM, Commander, vitest. Spec: `docs/specs/2026-05-15-crew-completion-reliability-design.md`.

---

## File Structure

**Create:**
- `src/lib/crew-sentinel.ts` — sentinel schema, paths, read/write, nudge markers (Layer 2)
- `src/lib/launch-command.ts` — pure `buildLaunchCommand` + `shQuote` for env-prefixing a crew spawn command
- `src/commands/crew-signal.ts` — `cockpit crew-signal` command + pure `handleCrewSignal` (Layer 1 entrypoint)
- `plugin/hooks/hooks.json` — Claude plugin hook registration (Layer 1 wiring; ships via existing `cockpit init`)
- Tests: `src/lib/__tests__/crew-sentinel.test.ts`, `src/lib/__tests__/launch-command.test.ts`, `src/commands/__tests__/crew-signal.test.ts`, `src/reactor/__tests__/auto-status-crew.test.ts`, `src/__tests__/plugin-hooks.test.ts`

**Modify:**
- `src/config.ts` — export `CONFIG_DIR` (currently private)
- `src/drivers/types.ts` — add `CrewSignalContext`, `CrewSignalWiring`, optional `crewSignal?` on `AgentDriver`
- `src/drivers/claude.ts` — implement `crewSignal`
- `src/commands/crew.ts` — env-prefix the spawn command via `buildLaunchCommand` + `agent.crewSignal`
- `src/index.ts` — register `crewSignalCommand`
- `src/reactor/auto-status.ts` — sentinel scan, state escalation, `status.md` crew section, captain nudge

---

## Task 1: Sentinel library + export CONFIG_DIR

**Files:**
- Modify: `src/config.ts` (the `const CONFIG_DIR` near line 136)
- Create: `src/lib/crew-sentinel.ts`
- Test: `src/lib/__tests__/crew-sentinel.test.ts`

- [ ] **Step 1: Export CONFIG_DIR**

In `src/config.ts`, change the private declaration:

```typescript
const CONFIG_DIR = path.join(os.homedir(), ".config", "cockpit");
```

to:

```typescript
export const CONFIG_DIR = path.join(os.homedir(), ".config", "cockpit");
```

(Leave `DEFAULT_CONFIG_PATH` and all other lines unchanged.)

- [ ] **Step 2: Write the failing test**

Create `src/lib/__tests__/crew-sentinel.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  writeCrewSentinel,
  readCrewSentinels,
  alreadyNudged,
  markNudged,
  type CrewSentinel,
} from "../crew-sentinel.js";

function sentinel(over: Partial<CrewSentinel> = {}): CrewSentinel {
  return {
    project: "oneplan",
    crew: "crew-1",
    state: "done",
    event: "Stop",
    ts: "2026-05-15T10:00:00.000Z",
    excerpt: "finished the task",
    ...over,
  };
}

describe("crew-sentinel", () => {
  it("round-trips a sentinel through write/read", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-sent-"));
    try {
      writeCrewSentinel(tmp, sentinel());
      const got = readCrewSentinels(tmp, "oneplan");
      expect(got).toHaveLength(1);
      expect(got[0].crew).toBe("crew-1");
      expect(got[0].state).toBe("done");
      expect(got[0].excerpt).toBe("finished the task");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns [] when the project dir does not exist", () => {
    expect(readCrewSentinels("/no/such/dir", "x")).toEqual([]);
  });

  it("skips corrupt sentinel files", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-sent-"));
    try {
      writeCrewSentinel(tmp, sentinel());
      await fsp.writeFile(path.join(tmp, "oneplan", "broken.json"), "{not json");
      const got = readCrewSentinels(tmp, "oneplan");
      expect(got).toHaveLength(1);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("tracks nudge markers per sentinel ts", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-sent-"));
    try {
      const s = sentinel();
      expect(alreadyNudged(tmp, s)).toBe(false);
      markNudged(tmp, s);
      expect(alreadyNudged(tmp, s)).toBe(true);
      expect(alreadyNudged(tmp, { ...s, ts: "2026-05-15T11:00:00.000Z" })).toBe(false);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/crew-sentinel.test.ts`
Expected: FAIL — `Cannot find module '../crew-sentinel.js'`

- [ ] **Step 4: Implement `src/lib/crew-sentinel.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";

export type CrewSignalState = "done" | "blocked";

export interface CrewSentinel {
  project: string;
  crew: string;
  state: CrewSignalState;
  event: string;
  sessionId?: string;
  ts: string;
  excerpt: string;
}

export function crewStateDir(base: string = CONFIG_DIR): string {
  return path.join(base, "state");
}

export function sentinelPath(
  stateDir: string,
  project: string,
  crew: string,
  state: CrewSignalState,
): string {
  return path.join(stateDir, project, `${crew}.${state}.json`);
}

export function writeCrewSentinel(stateDir: string, s: CrewSentinel): void {
  const file = sentinelPath(stateDir, s.project, s.crew, s.state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

export function readCrewSentinels(stateDir: string, project: string): CrewSentinel[] {
  const dir = path.join(stateDir, project);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CrewSentinel[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")) as CrewSentinel;
      if (parsed && parsed.crew && (parsed.state === "done" || parsed.state === "blocked")) {
        out.push(parsed);
      }
    } catch {
      // skip corrupt sentinel
    }
  }
  return out;
}

function nudgeMarkerPath(
  stateDir: string,
  project: string,
  crew: string,
  state: CrewSignalState,
): string {
  return path.join(stateDir, project, `${crew}.${state}.nudged`);
}

export function alreadyNudged(stateDir: string, s: CrewSentinel): boolean {
  try {
    return fs.readFileSync(nudgeMarkerPath(stateDir, s.project, s.crew, s.state), "utf-8") === s.ts;
  } catch {
    return false;
  }
}

export function markNudged(stateDir: string, s: CrewSentinel): void {
  const file = nudgeMarkerPath(stateDir, s.project, s.crew, s.state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s.ts);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/crew-sentinel.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/lib/crew-sentinel.ts src/lib/__tests__/crew-sentinel.test.ts
git commit -m "feat(crew): sentinel schema + read/write helpers (#64)"
```

---

## Task 2: `cockpit crew-signal` command + pure handler

**Files:**
- Create: `src/commands/crew-signal.ts`
- Modify: `src/index.ts` (imports block ~line 23, registration block ~line 52)
- Test: `src/commands/__tests__/crew-signal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/commands/__tests__/crew-signal.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { handleCrewSignal } from "../crew-signal.js";
import { readCrewSentinels } from "../../lib/crew-sentinel.js";

const now = () => "2026-05-15T12:00:00.000Z";

describe("handleCrewSignal", () => {
  it("returns null and writes nothing when env identity is missing (no-op gate)", () => {
    const r = handleCrewSignal({ stdin: '{"hook_event_name":"Stop"}', now });
    expect(r).toBeNull();
  });

  it("writes a done sentinel for Stop", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-2",
        stateDir: tmp,
        stdin: '{"hook_event_name":"Stop","session_id":"abc"}',
        now,
      });
      expect(r?.state).toBe("done");
      const got = readCrewSentinels(tmp, "oneplan");
      expect(got).toHaveLength(1);
      expect(got[0].crew).toBe("crew-2");
      expect(got[0].sessionId).toBe("abc");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("writes a blocked sentinel for Notification", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-cs-"));
    try {
      const r = handleCrewSignal({
        project: "oneplan",
        crew: "crew-1",
        stateDir: tmp,
        stdin: '{"hook_event_name":"Notification"}',
        now,
      });
      expect(r?.state).toBe("blocked");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for unrelated events", () => {
    const r = handleCrewSignal({
      project: "p",
      crew: "c",
      stateDir: "/tmp",
      stdin: '{"hook_event_name":"PreToolUse"}',
      now,
    });
    expect(r).toBeNull();
  });

  it("tolerates non-JSON stdin", () => {
    const r = handleCrewSignal({
      project: "p",
      crew: "c",
      stateDir: "/tmp",
      stdin: "garbage",
      now,
    });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/__tests__/crew-signal.test.ts`
Expected: FAIL — `Cannot find module '../crew-signal.js'`

- [ ] **Step 3: Implement `src/commands/crew-signal.ts`**

```typescript
import { Command } from "commander";
import fs from "node:fs";
import {
  writeCrewSentinel,
  type CrewSentinel,
  type CrewSignalState,
} from "../lib/crew-sentinel.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function stateForEvent(event: string): CrewSignalState | null {
  if (event === "Stop" || event === "SubagentStop") return "done";
  if (event === "Notification") return "blocked";
  return null;
}

function excerptFromTranscript(transcriptPath: unknown): string {
  if (typeof transcriptPath !== "string" || !transcriptPath) return "";
  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8").trim();
    const lines = raw.split("\n").filter((l) => l.trim().startsWith("{"));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const msg = obj?.message?.content ?? obj?.content ?? obj?.text;
        if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 280);
        if (Array.isArray(msg)) {
          const t = msg
            .map((p: { text?: unknown }) => (typeof p?.text === "string" ? p.text : ""))
            .join(" ")
            .trim();
          if (t) return t.slice(0, 280);
        }
      } catch {
        // try previous line
      }
    }
  } catch {
    // no/unreadable transcript
  }
  return "";
}

export interface CrewSignalInput {
  project?: string;
  crew?: string;
  stateDir?: string;
  stdin: string;
  now?: () => string;
}

/** Pure, testable core. Returns the sentinel written, or null on no-op. */
export function handleCrewSignal(i: CrewSignalInput): CrewSentinel | null {
  // No-op for any session that is not a cockpit-spawned crew.
  if (!i.project || !i.crew || !i.stateDir) return null;

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(i.stdin || "{}");
  } catch {
    return null;
  }
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const state = stateForEvent(event);
  if (!state) return null;

  const sentinel: CrewSentinel = {
    project: i.project,
    crew: i.crew,
    state,
    event,
    sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
    ts: (i.now ?? (() => new Date().toISOString()))(),
    excerpt: excerptFromTranscript(payload.transcript_path),
  };
  writeCrewSentinel(i.stateDir, sentinel);
  return sentinel;
}

export const crewSignalCommand = new Command("crew-signal")
  .description("Internal: Claude hook entrypoint; records crew done/blocked sentinels")
  .action(async () => {
    // Hooks must never fail the agent — swallow everything.
    try {
      handleCrewSignal({
        project: process.env.COCKPIT_PROJECT,
        crew: process.env.COCKPIT_CREW,
        stateDir: process.env.COCKPIT_STATE_DIR,
        stdin: await readStdin(),
      });
    } catch {
      // intentional no-op
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/commands/__tests__/crew-signal.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Register the command in `src/index.ts`**

In the imports block (near the other `./commands/*.js` imports, ~line 23) add:

```typescript
import { crewSignalCommand } from "./commands/crew-signal.js";
```

In the registration block (near the other `program.addCommand(...)` calls, ~line 52) add:

```typescript
program.addCommand(crewSignalCommand);
```

- [ ] **Step 6: Verify the build**

Run: `npm run lint`
Expected: exits 0, no type errors

- [ ] **Step 7: Commit**

```bash
git add src/commands/crew-signal.ts src/commands/__tests__/crew-signal.test.ts src/index.ts
git commit -m "feat(crew): cockpit crew-signal command + pure handler (#64)"
```

---

## Task 3: AgentDriver crew-signal contract + Claude implementation

**Files:**
- Modify: `src/drivers/types.ts` (add types + optional method on `AgentDriver`)
- Modify: `src/drivers/claude.ts` (implement `crewSignal`)
- Test: `src/drivers/__tests__/claude.test.ts` (append a test)

- [ ] **Step 1: Write the failing test**

Append to `src/drivers/__tests__/claude.test.ts` (inside the existing top-level `describe` for the claude driver; if it imports the factory differently, match the existing import of `createClaudeDriver`):

```typescript
  it("crewSignal returns the identity env for a crew", () => {
    const d = createClaudeDriver();
    const wiring = d.crewSignal!({
      project: "oneplan",
      crew: "crew-3",
      stateDir: "/home/u/.config/cockpit/state",
    });
    expect(wiring.env).toEqual({
      COCKPIT_PROJECT: "oneplan",
      COCKPIT_CREW: "crew-3",
      COCKPIT_STATE_DIR: "/home/u/.config/cockpit/state",
    });
    expect(wiring.argsSuffix).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/drivers/__tests__/claude.test.ts`
Expected: FAIL — `d.crewSignal is not a function` (or a type error if run via lint)

- [ ] **Step 3: Add the contract types in `src/drivers/types.ts`**

Add these interfaces (place them just above the `AgentDriver` interface):

```typescript
export interface CrewSignalContext {
  project: string;
  crew: string;
  stateDir: string;
}

export interface CrewSignalWiring {
  /** Env vars injected into the crew process so its completion hook can self-identify. */
  env: Record<string, string>;
  /** Extra CLI args appended to the spawn command (non-Claude adapters, #68). */
  argsSuffix?: string;
}
```

Then add this optional member to the `AgentDriver` interface (after `stop(pid: number): Promise<void>;`):

```typescript
  /**
   * Optional crew-completion-signal contract (#64). Declares how this agent is
   * wired so a finished/blocked crew turn produces a cockpit sentinel.
   * Claude: env only — hooks ship via the cockpit plugin's hooks.json.
   * Codex/Gemini/Aider: implemented in #68.
   */
  crewSignal?(ctx: CrewSignalContext): CrewSignalWiring;
```

- [ ] **Step 4: Implement `crewSignal` in `src/drivers/claude.ts`**

Add the import to the existing type import line:

```typescript
import type { AgentDriver, AgentProbeResult, SpawnOptions, AgentResult, CrewSignalContext, CrewSignalWiring } from "./types.js";
```

Add this method to the returned driver object (after `stop`):

```typescript
    crewSignal(ctx: CrewSignalContext): CrewSignalWiring {
      return {
        env: {
          COCKPIT_PROJECT: ctx.project,
          COCKPIT_CREW: ctx.crew,
          COCKPIT_STATE_DIR: ctx.stateDir,
        },
      };
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/drivers/__tests__/claude.test.ts`
Expected: PASS (existing tests + the new one)

- [ ] **Step 6: Commit**

```bash
git add src/drivers/types.ts src/drivers/claude.ts src/drivers/__tests__/claude.test.ts
git commit -m "feat(driver): crewSignal contract + Claude impl (#64; non-Claude #68)"
```

---

## Task 4: Env-prefix the crew spawn command

**Files:**
- Create: `src/lib/launch-command.ts`
- Test: `src/lib/__tests__/launch-command.test.ts`
- Modify: `src/commands/crew.ts` (the `runCrewSpawn` body, around the `cliCommand` build / `sendToPane` call)

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/launch-command.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildLaunchCommand } from "../launch-command.js";

describe("buildLaunchCommand", () => {
  it("returns the command unchanged when there is no wiring", () => {
    expect(buildLaunchCommand("claude --plugin-dir /p", undefined)).toBe("claude --plugin-dir /p");
  });

  it("prefixes single-quoted env assignments", () => {
    const out = buildLaunchCommand("claude -p", {
      env: { COCKPIT_PROJECT: "oneplan", COCKPIT_CREW: "crew-1", COCKPIT_STATE_DIR: "/a/b" },
    });
    expect(out).toBe(
      "COCKPIT_PROJECT='oneplan' COCKPIT_CREW='crew-1' COCKPIT_STATE_DIR='/a/b' claude -p",
    );
  });

  it("escapes single quotes in values", () => {
    const out = buildLaunchCommand("claude", { env: { X: "a'b" } });
    expect(out).toBe("X='a'\\''b' claude");
  });

  it("appends argsSuffix when present", () => {
    const out = buildLaunchCommand("aider", { env: { X: "1" }, argsSuffix: "--notifications" });
    expect(out).toBe("X='1' aider --notifications");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/launch-command.test.ts`
Expected: FAIL — `Cannot find module '../launch-command.js'`

- [ ] **Step 3: Implement `src/lib/launch-command.ts`**

```typescript
import type { CrewSignalWiring } from "../drivers/types.js";

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildLaunchCommand(
  cliCommand: string,
  wiring: CrewSignalWiring | undefined,
): string {
  if (!wiring) return cliCommand;
  const envPrefix = Object.entries(wiring.env)
    .map(([k, v]) => `${k}=${shQuote(v)}`)
    .join(" ");
  const suffix = wiring.argsSuffix ? ` ${wiring.argsSuffix}` : "";
  return `${envPrefix} ${cliCommand}${suffix}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/launch-command.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire it into `src/commands/crew.ts`**

Add imports at the top of `src/commands/crew.ts` (with the other imports):

```typescript
import { buildLaunchCommand } from "../lib/launch-command.js";
import { crewStateDir } from "../lib/crew-sentinel.js";
```

In `runCrewSpawn`, find the two existing lines that build and send the command (the agent command is assigned to `cliCommand` from `agent.buildCommand({...})`, and shortly after it is delivered with `await runtime.sendToPane(pane, cliCommand);`). Replace **only** the `sendToPane` delivery so the command is env-prefixed first. Use the spawn's existing project identifier and resolved crew-name local (the same values passed to `titleFor(...)` for the pane title — typically `input.project` and the resolved `name`):

```typescript
    const wiring = agent.crewSignal?.({
      project: input.project,
      crew: name,
      stateDir: crewStateDir(),
    });
    const launchCommand = buildLaunchCommand(cliCommand, wiring);
    await runtime.sendToPane(pane, launchCommand);
```

(Delete the old `await runtime.sendToPane(pane, cliCommand);` line it replaces. Do not change pane creation or any other logic. If the local crew-name variable is not literally `name`, use whatever identifier `titleFor` is called with — they must be the same crew name.)

- [ ] **Step 6: Verify the build**

Run: `npm run lint`
Expected: exits 0

- [ ] **Step 7: Commit**

```bash
git add src/lib/launch-command.ts src/lib/__tests__/launch-command.test.ts src/commands/crew.ts
git commit -m "feat(crew): env-prefix crew spawn for crew-signal identity (#64)"
```

---

## Task 5: Reactor backstop — sentinel scan, escalation, status.md, captain nudge

**Files:**
- Modify: `src/reactor/auto-status.ts`
- Test: `src/reactor/__tests__/auto-status-crew.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/reactor/__tests__/auto-status-crew.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { runAutoStatus } from "../auto-status.js";
import { writeCrewSentinel } from "../../lib/crew-sentinel.js";
import type { RuntimeDriver } from "../../runtimes/types.js";

function fakeRuntime(sent: string[]): RuntimeDriver {
  return {
    name: "fake",
    async send(_ref: string, message: string) { sent.push(message); },
    async sendKey() {},
    async readScreen() { return ""; }, // captain offline/idle
    async sendToPane() {},
    async readPaneScreen() { return ""; },
  } as unknown as RuntimeDriver;
}

describe("runAutoStatus crew backstop", () => {
  it("escalates project state to blocked from a crew sentinel with captain offline, and nudges once", async () => {
    const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-as-state-"));
    const vault = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-as-vault-"));
    const sent: string[] = [];
    try {
      writeCrewSentinel(stateDir, {
        project: "oneplan",
        crew: "crew-1",
        state: "blocked",
        event: "Notification",
        ts: "2026-05-15T09:00:00.000Z",
        excerpt: "which auth lib?",
      });

      const deps = {
        config: { projects: { oneplan: { captainName: "oneplan-captain", spokeVault: vault } } },
        reactions: { auto_status: { enabled: true, lines: 50, excerpt_lines: 15 } },
        runtime: () => fakeRuntime(sent),
        stateDir,
        now: () => "2026-05-15T10:00:00.000Z",
      } as unknown as Parameters<typeof runAutoStatus>[0];

      const r1 = await runAutoStatus(deps);
      expect(r1[0].state).toBe("blocked");
      expect(r1[0].crewSignals).toHaveLength(1);
      expect(r1[0].crewSignals[0].crew).toBe("crew-1");
      const md = await fsp.readFile(path.join(vault, "status.md"), "utf-8");
      expect(md).toContain("## Crew signals");
      expect(md).toContain("crew-1");
      expect(sent.filter((m) => m.includes("crew-1"))).toHaveLength(1);

      // second cycle: same sentinel ts → no duplicate nudge
      await runAutoStatus(deps);
      expect(sent.filter((m) => m.includes("crew-1"))).toHaveLength(1);
    } finally {
      await fsp.rm(stateDir, { recursive: true, force: true });
      await fsp.rm(vault, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/reactor/__tests__/auto-status-crew.test.ts`
Expected: FAIL — `r1[0].crewSignals` is undefined / no `## Crew signals` in status.md

- [ ] **Step 3: Implement the changes in `src/reactor/auto-status.ts`**

Add imports at the top (with the existing imports):

```typescript
import {
  readCrewSentinels,
  crewStateDir,
  alreadyNudged,
  markNudged,
  type CrewSignalState,
} from "../lib/crew-sentinel.js";
```

Extend `AutoStatusResult`:

```typescript
export interface AutoStatusResult {
  project: string;
  state: ScreenState;
  vaultPath: string;
  crewSignals: { crew: string; state: CrewSignalState; ts: string; excerpt: string }[];
}
```

Add an optional `stateDir` to `AutoStatusDeps` (after `mkdir?`):

```typescript
  stateDir?: string;
```

Change `buildStatusMarkdown` to take crew signals and render them. Replace the `buildStatusMarkdown` function signature/body with:

```typescript
function buildStatusMarkdown(input: {
  project: string;
  captainWorkspace: string;
  state: ScreenState;
  lastChecked: string;
  excerpt: string;
  crewSignals: { crew: string; state: CrewSignalState; ts: string; excerpt: string }[];
}): string {
  const fenced = "```";
  const crewLines =
    input.crewSignals.length === 0
      ? ["_none_"]
      : input.crewSignals.map(
          (c) => `- **${c.crew}** — ${c.state} @ ${c.ts}: ${c.excerpt || "(no detail)"}`,
        );
  return [
    "---",
    `project: ${input.project}`,
    `auto_state: ${input.state}`,
    `auto_last_checked: "${input.lastChecked}"`,
    `captain_workspace: ${input.captainWorkspace}`,
    `crew_signals: ${input.crewSignals.length}`,
    "---",
    "",
    "# Status (auto-derived)",
    "",
    "> Written by `cockpit reactor poll-status`. Manual writes (`write-status.sh`) are opt-in and may be clobbered on the next poll.",
    "",
    "## Last activity excerpt",
    "",
    fenced,
    input.excerpt,
    fenced,
    "",
    "## Crew signals",
    "",
    ...crewLines,
    "",
  ].join("\n");
}
```

In `runAutoStatus`, add a resolved state dir near the other defaults (after the `mkdir` default line):

```typescript
  const stateDir = deps.stateDir ?? crewStateDir();
```

Inside the `for (const [name, project] of Object.entries(deps.config.projects))` loop, **after** the line `const { state, excerpt } = classifyScreen(screen, { lines, excerptLines });` and **before** the `try { mkdir(vaultDir); ... }` block, insert:

```typescript
    const sentinels = readCrewSentinels(stateDir, name);
    const crewSignals = sentinels.map((s) => ({
      crew: s.crew,
      state: s.state,
      ts: s.ts,
      excerpt: s.excerpt,
    }));
    const hasBlockedCrew = sentinels.some((s) => s.state === "blocked");
    const projectState: ScreenState = hasBlockedCrew ? "blocked" : state;

    for (const s of sentinels) {
      if (alreadyNudged(stateDir, s)) continue;
      try {
        await deps.runtime(name).send(
          captain,
          `crew ${s.crew} is ${s.state}: ${s.excerpt || "(no detail)"} — collect/unblock it`,
        );
        markNudged(stateDir, s);
      } catch {
        // best-effort: captain may be down; reactor record is the guarantee
      }
    }
```

Change the `writeFile(statusPath, buildStatusMarkdown({...}))` call to pass `projectState` and `crewSignals`:

```typescript
      writeFile(statusPath, buildStatusMarkdown({
        project: name,
        captainWorkspace: captain,
        state: projectState,
        lastChecked: now,
        excerpt,
        crewSignals,
      }));
```

Change the final `results.push({...})` to include `projectState` and `crewSignals`:

```typescript
    results.push({ project: name, state: projectState, vaultPath: statusPath, crewSignals });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/reactor/__tests__/auto-status-crew.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Run the full reactor test suite for regressions**

Run: `npx vitest run src/reactor`
Expected: PASS — existing auto-status / classifier tests still green (any pre-existing test asserting `AutoStatusResult` shape now also sees `crewSignals: []`; if a pre-existing test constructs an expected object with `toEqual`, update it to include `crewSignals: []`).

- [ ] **Step 6: Commit**

```bash
git add src/reactor/auto-status.ts src/reactor/__tests__/auto-status-crew.test.ts
git commit -m "feat(reactor): crew-sentinel backstop — escalate, record, nudge (#64)"
```

---

## Task 6: Claude plugin hook registration

**Files:**
- Create: `plugin/hooks/hooks.json`
- Test: `src/__tests__/plugin-hooks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/plugin-hooks.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("plugin hooks.json", () => {
  it("registers cockpit crew-signal for Stop, SubagentStop, Notification", () => {
    const p = path.join(process.cwd(), "plugin", "hooks", "hooks.json");
    const json = JSON.parse(fs.readFileSync(p, "utf-8"));
    for (const ev of ["Stop", "SubagentStop", "Notification"]) {
      const entries = json.hooks[ev];
      expect(Array.isArray(entries)).toBe(true);
      const cmds = entries.flatMap(
        (e: { hooks: { type: string; command: string }[] }) => e.hooks,
      );
      expect(cmds.some((h) => h.type === "command" && h.command === "cockpit crew-signal")).toBe(
        true,
      );
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/plugin-hooks.test.ts`
Expected: FAIL — `ENOENT ... plugin/hooks/hooks.json`

- [ ] **Step 3: Create `plugin/hooks/hooks.json`**

```json
{
  "description": "Cockpit crew-completion signals: report crew done/blocked to the reactor (#64). No-op unless COCKPIT_CREW is set, so normal Claude sessions are unaffected.",
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "cockpit crew-signal" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "cockpit crew-signal" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "cockpit crew-signal" }] }
    ]
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/plugin-hooks.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/hooks.json src/__tests__/plugin-hooks.test.ts
git commit -m "feat(plugin): crew-signal Stop/SubagentStop/Notification hooks (#64)"
```

---

## Task 7: Full suite, build, docs note

**Files:**
- Modify: `AGENTS.md` (add a short note under the multi-agent section)

- [ ] **Step 1: Run the entire test suite**

Run: `npx vitest run`
Expected: PASS — all tests green (no regressions to existing driver/reactor/lib tests).

- [ ] **Step 2: Typecheck and build**

Run: `npm run lint && npm run build`
Expected: both exit 0.

- [ ] **Step 3: Document the mechanism and the non-Claude gap**

In `AGENTS.md`, add this paragraph at the end of the "Project Direction: Multi-Agent" section (or the nearest multi-agent/limitations section):

```markdown
### Crew completion signals (#64)

Cockpit-spawned Claude crews report turn-done/blocked to the reactor via a
plugin hook (`plugin/hooks/hooks.json` → `cockpit crew-signal`), which writes a
sentinel under `~/.config/cockpit/state/<project>/<crew>.<state>.json`. The
reactor (`runAutoStatus`) reads these every cycle, so completion is visible even
if the crew never self-reports or the captain is idle/compacted. The hook is a
strict no-op unless `COCKPIT_CREW` is set, so it never affects normal Claude
sessions. Non-Claude detection adapters (Codex/Gemini/Aider) are tracked in #68;
the sentinel + reactor layers are already agent-agnostic.
```

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): document crew-signal mechanism + #68 gap (#64)"
```

- [ ] **Step 5: Run `gitnexus detect_changes` and re-index**

Run: `npx gitnexus analyze`
Expected: index refreshed at the new HEAD (project rule: re-index before considering done).

---

## Self-Review

**1. Spec coverage:**
- Layer 1 detection adapter (Claude): Task 6 (hooks.json) + Task 2 (crew-signal) + Task 3 (driver contract) + Task 4 (env injection). ✔
- Layer 2 sentinel schema: Task 1. ✔
- Layer 3 reactor backstop (scan, escalate, record, nudge): Task 5. ✔
- No-op outside cockpit (COCKPIT_CREW gate): Task 2 Step 1 test "no-op gate" + Task 6 description; the gate is `!project || !crew || !stateDir`. ✔
- AgentDriver contract + #68 seam: Task 3 (`crewSignal?` + doc comment), #68 already filed. ✔
- Acceptance "reactor emits transition with captain absent": Task 5 test uses `readScreen() => ""` (offline captain) and asserts `state==="blocked"` + status.md. ✔
- Sibling #18/#19: Task 5 Step 5 runs full reactor suite for regressions; nudge uses existing `runtime.send` (#18 path) best-effort; #19 neutralized because reactor (not captain) records — covered by the offline-captain test. ✔
- Excerpt from transcript: Task 2 `excerptFromTranscript` (best-effort, try/catch). ✔

**2. Placeholder scan:** No "TBD/TODO/handle edge cases". One conditional instruction in Task 4 Step 5 (use the existing crew-name local if not literally `name`) — this is disambiguation against live code, with exact code provided, not a placeholder.

**3. Type consistency:** `CrewSentinel`, `CrewSignalState`, `crewStateDir`, `readCrewSentinels`, `writeCrewSentinel`, `alreadyNudged`, `markNudged` defined in Task 1 and used identically in Tasks 2/5. `CrewSignalContext`/`CrewSignalWiring`/`crewSignal?` defined Task 3, consumed in Task 4 (`buildLaunchCommand(cliCommand, wiring)`) and `claude.ts`. `AutoStatusResult.crewSignals` shape defined Task 5 and asserted by its test. `handleCrewSignal` signature consistent between impl and test. Consistent.

**Scope check:** Single subsystem (crew-completion reliability). One plan. Non-Claude adapters explicitly excluded (#68).
