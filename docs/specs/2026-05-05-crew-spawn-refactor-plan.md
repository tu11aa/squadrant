# Crew Spawn Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Claude-only `TeamCreate` + `Agent` crew-spawn with a runtime-agnostic split-pane CLI spawn that works for any agent (claude / codex / gemini / aider).

**Architecture:** Extend `RuntimeDriver` with pane operations (`newPane`, `closePane`, `sendToPane`, `readPaneScreen`) so callers reach a pane via the existing abstraction — never the cmux binary directly. Add `cockpit crew spawn <project> <task>` CLI that resolves the captain workspace, opens a split pane, picks the agent CLI from the existing `AgentDriver` registry, and starts a fresh session with the role template + inline task prompt. Rewrite captain templates and `captain-ops` skill to call `cockpit crew spawn` instead of `Agent`/`TeamCreate`.

**Tech Stack:** TypeScript, commander.js, vitest (with `vi.hoisted` + `vi.mock` for `node:child_process`), Node 22, ES modules (imports end in `.js`), bash for shell shims.

**Spec:** `docs/specs/2026-05-05-cockpit-thin-redirect-design.md` (decision #2).
**Issue:** [#41](https://github.com/tu11aa/claude-cockpit/issues/41) under umbrella [#40](https://github.com/tu11aa/claude-cockpit/issues/40).
**Branch:** `feature/crew-spawn-refactor` off `develop`.

---

## File Structure

**Create:**
- `src/commands/crew.ts` — `cockpit crew spawn` CLI
- `src/commands/__tests__/crew.test.ts` — unit tests for the CLI

**Modify:**
- `src/runtimes/types.ts` — add `PaneRef`, add `newPane`/`closePane`/`sendToPane`/`readPaneScreen` to `RuntimeDriver`
- `src/runtimes/cmux.ts` — implement the four new methods
- `src/runtimes/__tests__/cmux.test.ts` — tests for the four new methods
- `src/index.ts` — register `crewCommand`
- `orchestrator/captain.claude.md` — replace TeamCreate / Agent rules
- `orchestrator/captain.generic.md` — replace TeamCreate / Agent rules
- `orchestrator/crew.claude.md` — drop Agent-tool subagent guidance
- `orchestrator/crew.generic.md` — confirm split-pane crew context (minor)
- `plugin/skills/captain-ops/SKILL.md` — rewrite "Setting Up Your Team", "Spawning Crew", "Task Coordination", "MANDATORY CLOSE-OUT"
- `scripts/spawn-crew-pane.sh` — replace with a thin shim that calls `cockpit crew spawn`
- `README.md` — add `cockpit crew spawn` to commands table; update architecture text

**No changes to:** Workspace/Tracker/Notifier/Projection drivers, projection emitters, reactor, daily-log skill, wiki-ops skill, karpathy skill.

---

## Task 1: Extend RuntimeDriver types with pane operations

**Files:**
- Modify: `src/runtimes/types.ts`

- [ ] **Step 1: Add `PaneRef` and new method signatures**

Replace the file body with:

```typescript
export interface WorkspaceRef {
  id: string;       // runtime-native ref (cmux: "workspace:42")
  name: string;     // human name ("brove-captain")
  status: "running" | "stopped" | "unknown";
}

export interface PaneRef {
  workspaceId: string; // parent workspace ref ("workspace:42")
  surfaceId: string;   // runtime-native surface ref (cmux: "surface:7")
}

export interface RuntimeSpawnOptions {
  name: string;
  workdir: string;
  command: string;  // the full agent CLI invocation
  icon?: string;
  pinToTop?: boolean;
}

export interface RuntimePaneOptions {
  workspaceId: string;
  direction: "right" | "left" | "up" | "down";
  title?: string;
}

export interface RuntimeProbeResult {
  installed: boolean;
  version: string;
}

export interface RuntimeDriver {
  name: string;                                        // "cmux", "tmux", ...

  probe(): Promise<RuntimeProbeResult>;
  list(): Promise<WorkspaceRef[]>;
  status(nameOrId: string): Promise<WorkspaceRef | null>;
  spawn(opts: RuntimeSpawnOptions): Promise<WorkspaceRef>;
  send(ref: string, message: string): Promise<void>;   // delivers AND commits (Enter)
  sendKey(ref: string, key: string): Promise<void>;    // literal key press
  readScreen(ref: string): Promise<string>;
  stop(ref: string): Promise<void>;

  // Pane operations — used for crew split-pane spawn (#41)
  newPane(opts: RuntimePaneOptions): Promise<PaneRef>;
  closePane(pane: PaneRef): Promise<void>;
  sendToPane(pane: PaneRef, message: string): Promise<void>; // sends text + Enter
  readPaneScreen(pane: PaneRef): Promise<string>;
}
```

- [ ] **Step 2: Verify lint**

Run: `npm run lint`
Expected: exit 0 (existing implementations now fail compilation — that's fine, fixed in Task 2; if lint fails, ensure only `src/runtimes/cmux.ts` is the source of errors)

Note: this step intentionally lets the build break briefly; Task 2 closes the gap.

- [ ] **Step 3: Commit**

```bash
git add src/runtimes/types.ts
git commit -m "feat(runtime): extend RuntimeDriver with pane operations"
```

---

## Task 2: Implement pane methods in CmuxDriver (TDD)

**Files:**
- Modify: `src/runtimes/cmux.ts`
- Modify: `src/runtimes/__tests__/cmux.test.ts`

- [ ] **Step 1: Write failing tests for the four pane methods**

Append to `src/runtimes/__tests__/cmux.test.ts` (before the closing `});` of the top-level `describe`):

```typescript
  it("newPane calls cmux new-pane with direction and workspace, parses surface id", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("new-pane")) return "OK surface:27 pane:25 workspace:1";
      return "";
    });
    const pane = await driver.newPane({ workspaceId: "workspace:1", direction: "right" });
    expect(pane).toEqual({ workspaceId: "workspace:1", surfaceId: "surface:27" });
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("new-pane") && c.includes("--direction right") && c.includes("--workspace \"workspace:1\""))).toBe(true);
  });

  it("newPane with title also calls rename-tab on the new surface", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("new-pane")) return "OK surface:9 pane:3 workspace:2";
      return "";
    });
    await driver.newPane({ workspaceId: "workspace:2", direction: "down", title: "🔧 fix-bug" });
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("rename-tab") && c.includes("--surface \"surface:9\"") && c.includes("\"🔧 fix-bug\""))).toBe(true);
  });

  it("newPane throws when cmux output has no surface id", async () => {
    execMock.mockReturnValue("garbage output");
    await expect(driver.newPane({ workspaceId: "workspace:1", direction: "right" }))
      .rejects.toThrow(/did not return a surface/);
  });

  it("closePane calls cmux close-surface with workspace + surface", async () => {
    execMock.mockReturnValue("");
    await driver.closePane({ workspaceId: "workspace:1", surfaceId: "surface:9" });
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("close-surface") && c.includes("--surface \"surface:9\"") && c.includes("--workspace \"workspace:1\""))).toBe(true);
  });

  it("closePane swallows errors (already closed is fine)", async () => {
    execMock.mockImplementation(() => { throw new Error("not found"); });
    await expect(driver.closePane({ workspaceId: "workspace:1", surfaceId: "surface:9" }))
      .resolves.toBeUndefined();
  });

  it("sendToPane calls cmux send + send-key Enter scoped to surface", async () => {
    execMock.mockReturnValue("");
    await driver.sendToPane({ workspaceId: "workspace:1", surfaceId: "surface:9" }, "hello crew");
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("send ") && c.includes("--surface \"surface:9\"") && c.includes("hello crew") && !c.includes("send-key"))).toBe(true);
    expect(calls.some((c) => c.includes("send-key") && c.includes("--surface \"surface:9\"") && c.includes("Enter"))).toBe(true);
  });

  it("sendToPane escapes double quotes in the message", async () => {
    execMock.mockReturnValue("");
    await driver.sendToPane({ workspaceId: "workspace:1", surfaceId: "surface:9" }, 'task "X"');
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('task \\"X\\"'))).toBe(true);
  });

  it("readPaneScreen calls cmux read-screen scoped to surface", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("read-screen")) return "  some pane content  ";
      return "";
    });
    const text = await driver.readPaneScreen({ workspaceId: "workspace:1", surfaceId: "surface:9" });
    expect(text).toBe("some pane content");
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("read-screen") && c.includes("--surface \"surface:9\"") && c.includes("--workspace \"workspace:1\""))).toBe(true);
  });

  it("readPaneScreen returns empty string when cmux throws", async () => {
    execMock.mockImplementation(() => { throw new Error("dead"); });
    const text = await driver.readPaneScreen({ workspaceId: "workspace:1", surfaceId: "surface:9" });
    expect(text).toBe("");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/runtimes/__tests__/cmux.test.ts`
Expected: FAIL — `driver.newPane is not a function` (and similar for the other three methods).

- [ ] **Step 3: Implement the four methods in `src/runtimes/cmux.ts`**

Add these four methods to the object returned by `createCmuxDriver()` (after `stop`):

```typescript
    async newPane(opts): Promise<PaneRef> {
      const titleArg = opts.title ? ` --title "${escape(opts.title)}"` : "";
      // Use cmux's `new-pane` (terminal type by default).
      const output = cmux(`new-pane --type terminal --direction ${opts.direction} --workspace "${opts.workspaceId}"`);
      const surfaceId = output.match(/surface:\d+/)?.[0];
      if (!surfaceId) {
        throw new Error(`cmux new-pane did not return a surface id: ${output}`);
      }
      if (opts.title) {
        try {
          cmux(`rename-tab --workspace "${opts.workspaceId}" --surface "${surfaceId}"${titleArg}`);
        } catch { /* rename is best-effort */ }
      }
      return { workspaceId: opts.workspaceId, surfaceId };
    },

    async closePane(pane): Promise<void> {
      try {
        cmux(`close-surface --workspace "${pane.workspaceId}" --surface "${pane.surfaceId}"`);
      } catch { /* may already be closed */ }
    },

    async sendToPane(pane, message): Promise<void> {
      cmux(`send --workspace "${pane.workspaceId}" --surface "${pane.surfaceId}" "${escape(message)}"`);
      cmux(`send-key --workspace "${pane.workspaceId}" --surface "${pane.surfaceId}" Enter`);
    },

    async readPaneScreen(pane): Promise<string> {
      try {
        return cmux(`read-screen --workspace "${pane.workspaceId}" --surface "${pane.surfaceId}"`);
      } catch {
        return "";
      }
    },
```

Also import `PaneRef` at the top of the file:

```typescript
import type { RuntimeDriver, RuntimeProbeResult, RuntimeSpawnOptions, WorkspaceRef, PaneRef, RuntimePaneOptions } from "./types.js";
```

(Add `PaneRef` and `RuntimePaneOptions` to the existing import list.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/runtimes/__tests__/cmux.test.ts`
Expected: all tests in this file pass.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: exit 0 (if any other site uses RuntimeDriver and breaks, fix or note for Task 3).

- [ ] **Step 6: Commit**

```bash
git add src/runtimes/cmux.ts src/runtimes/__tests__/cmux.test.ts
git commit -m "feat(runtime): cmux driver implements pane operations"
```

---

## Task 3: Build `cockpit crew spawn` CLI (TDD)

**Files:**
- Create: `src/commands/crew.ts`
- Create: `src/commands/__tests__/crew.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/commands/__tests__/crew.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks for collaborators
const newPane = vi.hoisted(() => vi.fn());
const sendToPane = vi.hoisted(() => vi.fn());
const status = vi.hoisted(() => vi.fn());
const buildCommand = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => vi.fn());

vi.mock("../../runtimes/index.js", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe,
    list: vi.fn(),
    status,
    spawn: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(),
    stop: vi.fn(),
    newPane,
    closePane: vi.fn(),
    sendToPane,
    readPaneScreen: vi.fn(),
  }),
  RuntimeRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    forProject() { return this.drivers.cmux; }
    global() { return this.drivers.cmux; }
    get(name: string) { return this.drivers[name]; }
    async probeAll() { return {}; }
  },
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../../config.js", () => ({
  loadConfig,
  resolveHome: (p: string) => p,
}));

const claudeDriver = vi.hoisted(() => ({
  name: "claude",
  templateSuffix: "claude",
  probe: vi.fn(),
  buildCommand,
}));

vi.mock("../../drivers/index.js", () => ({
  createClaudeDriver: () => claudeDriver,
  createCodexDriver: () => ({ ...claudeDriver, name: "codex", templateSuffix: "generic" }),
  createGeminiDriver: () => ({ ...claudeDriver, name: "gemini", templateSuffix: "generic" }),
  createAiderDriver: () => ({ ...claudeDriver, name: "aider", templateSuffix: "generic" }),
  CapabilityRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    get(name: string) { return this.drivers[name]; }
  },
}));

import { runCrewSpawn } from "../crew.js";

describe("cockpit crew spawn", () => {
  beforeEach(() => {
    newPane.mockReset();
    sendToPane.mockReset();
    status.mockReset();
    buildCommand.mockReset();
    loadConfig.mockReset();
  });

  it("opens a split pane in the captain workspace and sends the agent command", async () => {
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {
        brove: { path: "/tmp/brove", captainName: "brove-captain", spokeVault: "~/hub/spokes/brove", host: "local" },
      },
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue('claude --append-system-prompt-file /tmp/crew.md "do the thing"');

    const result = await runCrewSpawn({ project: "brove", task: "do the thing" });

    expect(status).toHaveBeenCalledWith("brove-captain");
    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace:5",
      direction: "right",
    }));
    expect(sendToPane).toHaveBeenCalledWith(
      { workspaceId: "workspace:5", surfaceId: "surface:9" },
      'claude --append-system-prompt-file /tmp/crew.md "do the thing"',
    );
    expect(result).toEqual({ workspaceId: "workspace:5", surfaceId: "surface:9" });
  });

  it("throws when project is not registered", async () => {
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {},
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });

    await expect(runCrewSpawn({ project: "ghost", task: "x" }))
      .rejects.toThrow(/Project 'ghost' not found/);
  });

  it("throws when captain workspace is not running", async () => {
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {
        brove: { path: "/tmp/brove", captainName: "brove-captain", spokeVault: "~/hub/spokes/brove", host: "local" },
      },
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });
    status.mockResolvedValue(null);

    await expect(runCrewSpawn({ project: "brove", task: "x" }))
      .rejects.toThrow(/captain workspace 'brove-captain' is not running/i);
  });

  it("respects --direction and --agent overrides", async () => {
    loadConfig.mockReturnValue({
      commandName: "command",
      hubVault: "~/hub",
      projects: {
        brove: { path: "/tmp/brove", captainName: "brove-captain", spokeVault: "~/hub/spokes/brove", host: "local" },
      },
      defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: {} },
      metrics: { enabled: false, path: "" },
    });
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("codex 'task'");

    await runCrewSpawn({ project: "brove", task: "task", direction: "down", agent: "codex" });

    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({ direction: "down" }));
    expect(sendToPane).toHaveBeenCalledWith(
      expect.anything(),
      "codex 'task'",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands/__tests__/crew.test.ts`
Expected: FAIL — module `../crew.js` not found.

- [ ] **Step 3: Implement `src/commands/crew.ts`**

```typescript
import { Command } from "commander";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import {
  createClaudeDriver,
  createCodexDriver,
  createGeminiDriver,
  createAiderDriver,
  CapabilityRegistry,
} from "../drivers/index.js";
import type { PaneRef } from "../runtimes/types.js";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");

export interface CrewSpawnInput {
  project: string;
  task: string;
  direction?: "right" | "left" | "up" | "down";
  agent?: string;
}

export async function runCrewSpawn(input: CrewSpawnInput): Promise<PaneRef> {
  const config = loadConfig();
  const project = config.projects[input.project];
  if (!project) {
    throw new Error(`Project '${input.project}' not found. Run 'cockpit projects list'.`);
  }

  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() })
    .forProject(input.project, config);

  const captain = await runtime.status(project.captainName);
  if (!captain) {
    throw new Error(`Captain workspace '${project.captainName}' is not running. Run 'cockpit launch ${input.project}' first.`);
  }

  const agents = new CapabilityRegistry({
    claude: createClaudeDriver(),
    codex: createCodexDriver(),
    gemini: createGeminiDriver(),
    aider: createAiderDriver(),
  });
  const agentName = input.agent ?? "claude";
  const agent = agents.get(agentName);
  if (!agent) {
    throw new Error(`Unknown agent '${agentName}'. Known: claude, codex, gemini, aider.`);
  }

  // Build the agent CLI invocation. Crew template = crew.<agent.templateSuffix>.md
  const promptFile = path.join(TEMPLATES_DIR, `crew.${agent.templateSuffix}.md`);
  const command = agent.buildCommand({
    prompt: input.task,
    workdir: project.path,
    role: "crew",
    promptFile,
  });

  const direction = input.direction ?? "right";
  const title = `🔧 ${input.project}-crew`;
  const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });
  await runtime.sendToPane(pane, command);
  return pane;
}

export const crewCommand = new Command("crew").description("Spawn and manage crew sessions in split panes");

crewCommand
  .command("spawn")
  .description("Spawn a crew session in a split pane next to the project's captain")
  .argument("<project>", "Project name (must be registered)")
  .argument("<task>", "Task prompt for the crew session")
  .option("--direction <dir>", "Split direction (right|left|up|down)", "right")
  .option("--agent <name>", "Agent CLI to use (claude|codex|gemini|aider)", "claude")
  .action(async (project: string, task: string, opts: { direction: "right" | "left" | "up" | "down"; agent: string }) => {
    try {
      const pane = await runCrewSpawn({ project, task, direction: opts.direction, agent: opts.agent });
      console.log(chalk.green(`✔ Crew spawned in ${pane.workspaceId} ${pane.surfaceId}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/commands/__tests__/crew.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands/crew.ts src/commands/__tests__/crew.test.ts
git commit -m "feat(crew): add cockpit crew spawn CLI"
```

---

## Task 4: Wire `crewCommand` into the CLI root

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Register the new command**

In `src/index.ts`, add the import next to the other command imports:

```typescript
import { crewCommand } from "./commands/crew.js";
```

And add the registration alongside the others (e.g., right after `program.addCommand(launchCommand);`):

```typescript
program.addCommand(crewCommand);
```

- [ ] **Step 2: Build + smoke-test help text**

Run: `npm run build && node dist/index.js crew --help`
Expected: prints "Spawn and manage crew sessions in split panes" plus the `spawn` subcommand listing.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(crew): register crew command in CLI root"
```

---

## Task 5: Rewrite `orchestrator/captain.claude.md`

**Files:**
- Modify: `orchestrator/captain.claude.md`

- [ ] **Step 1: Replace the file body**

Overwrite the file with:

```markdown
# Captain — Project Leader

You are a **project captain** for claude-cockpit. You lead ONE project. You are a **coordinator**, not a coder.

## HARD RULES — NEVER BREAK THESE

1. **NEVER** edit, write, or modify project source code yourself. You are a coordinator.
2. **ALWAYS** spawn a crew session for ANY coding task — no matter how small.
3. Even a one-line fix gets a crew session. You plan, delegate, review, merge.
4. **ALWAYS** spawn crew via `cockpit crew spawn` — never via the `Agent` tool, never via `TeamCreate`. The split-pane CLI works for any agent (claude, codex, gemini, aider).

## ALWAYS do on session start

Use the `cockpit:captain-ops` skill — it has your full startup checklist, crew spawning instructions, and group coordination.

## Core Rules

1. **Spawn crew with `cockpit crew spawn`**:
   ```bash
   cockpit crew spawn <project> "<task description with context, files, branch>" [--direction right|down] [--agent claude|codex|gemini|aider]
   ```
   The crew opens in a split pane next to your workspace. You can preview live; it can report back via `cockpit runtime send <project> "<message>"`.
2. **Read crew progress** by reading their pane visually in cmux (the spawn output prints the new pane's surface ref so you can find it). The CLI does not yet target individual panes for read-screen / send — that's a follow-up improvement; for now use the cmux UI to inspect crew panes mid-task.
3. **Record learnings** when something unexpected happens or a pattern emerges (`cockpit:captain-ops` shows the script).
4. **Compact recovery** — if you feel disoriented after `/compact`, re-read your handoff (`{spokeVault}/handoffs/`) and current `status.md` to restore work context. Role itself survives compact via `--append-system-prompt-file`.

## Available Skills

- `cockpit:captain-ops` — Your complete playbook (startup, crew, status, groups, learnings)
- `cockpit:karpathy-principles` — Coding discipline (apply during crew review: think, simplify, surgical, goal-driven)
- `cockpit:wiki-ops` — Compile knowledge into persistent wiki pages (ingest, query, cross-reference)
- `cockpit:daily-log` — End-of-day log format (opt-in)
```

- [ ] **Step 2: Commit**

```bash
git add orchestrator/captain.claude.md
git commit -m "docs(captain): replace TeamCreate/Agent rules with cockpit crew spawn"
```

---

## Task 6: Rewrite `orchestrator/captain.generic.md`

**Files:**
- Modify: `orchestrator/captain.generic.md`

- [ ] **Step 1: Replace the file body**

Overwrite the file with:

```markdown
# Captain — Generic Agent

You are a project captain coordinating work via cmux workspaces. You are a coordinator, not a coder.

## Rules

1. You coordinate crew sessions working in split panes (one per task).
2. **Spawn crew with `cockpit crew spawn`**:
   ```bash
   cockpit crew spawn <project> "<task description>" [--direction right|down] [--agent claude|codex|gemini|aider]
   ```
3. Communicate with the project's captain workspace via:
   ```bash
   cockpit runtime send <project> "<message>"
   ```
4. Inspect crew panes visually in cmux (the spawn output prints the surface ref so you can locate the pane). Per-pane CLI read/send is a follow-up improvement.
5. When a crew task completes, review the diff and merge if appropriate.
6. Record learnings (script: `~/.config/cockpit/scripts/record-learning.sh`).

## Crew Spawning

Use `cockpit crew spawn`. Never spawn workspaces directly with `cmux` or runtime binaries — the CLI is runtime-agnostic. Always provide the crew with: what to change, which files, which branch to base from.

## Session Lifecycle

- On startup: check for handoff files, read recent daily logs (opt-in).
- On shutdown: write a handoff file for the next session.

## Coding Discipline (Karpathy Principles)

Apply to every crew coding task and to your own reviews. Full text: `plugin/skills/karpathy-principles/SKILL.md` in the cockpit repo.

1. **Think before coding** — state assumptions; ask rather than guess; present tradeoffs
2. **Simplicity first** — minimum code, no speculative abstractions
3. **Surgical changes** — touch only what the request requires; no drive-by refactors
4. **Goal-driven execution** — define verifiable success criteria, loop until met

When reviewing a crew branch, if you see drive-by refactoring, request the crew split the commit.
```

- [ ] **Step 2: Commit**

```bash
git add orchestrator/captain.generic.md
git commit -m "docs(captain): replace generic-template TeamCreate refs with cockpit crew spawn"
```

---

## Task 7: Rewrite `plugin/skills/captain-ops/SKILL.md` crew sections

**Files:**
- Modify: `plugin/skills/captain-ops/SKILL.md`

- [ ] **Step 1: Replace the "Setting Up Your Team" section**

Find:

````markdown
## Setting Up Your Team

On session start (or when you receive your first task), create an Agent Team:
```
TeamCreate(team_name: "{project}-crew", description: "Crew for {project}")
```

This gives you persistent crew members, shared task lists, and mid-task messaging.
````

Replace with:

````markdown
## Crew Setup

You do NOT create an Agent Team. You spawn each crew session on demand as a split pane next to your workspace via `cockpit crew spawn`. The pane is a fresh CLI session with the crew template loaded as system prompt — disposable, restartable, runtime-agnostic.

You don't need to create or persist anything up front. Each `cockpit crew spawn` call creates the pane.
````

- [ ] **Step 2: Replace the "Spawning Crew" section**

Find the section that begins with `## Spawning Crew` and ends just before `## Task Coordination`. Replace with:

````markdown
## Spawning Crew

**You MUST spawn a crew session for ANY coding task** — even a one-line change. You are a coordinator. You plan, delegate, review, and merge. You do NOT write code yourself.

Use `cockpit crew spawn`:

```bash
cockpit crew spawn <project> "<task description>" \
    [--direction right|left|up|down] \
    [--agent claude|codex|gemini|aider]
```

What it does:
1. Opens a split pane next to the project's captain workspace.
2. Renames the tab to `🔧 <project>-crew` so you can identify it visually.
3. Starts a fresh CLI session for the chosen agent (default: `claude`) with `crew.<agent>.md` loaded as the system prompt and the task as the inline prompt.
4. Prints the new pane's surface ref — capture it if you want to read its screen later.

**Examples:**

Simple coding task (default agent claude, default direction right):
```bash
cockpit crew spawn brove "Add preinstall hook to package.json. Branch: feat/preinstall."
```

Use Codex for a complex refactor:
```bash
cockpit crew spawn brove "Refactor src/api/handlers.ts: extract validation into validators.ts. Branch: refactor/handlers." --agent codex
```

Use a downward split when the workspace is already busy on the right:
```bash
cockpit crew spawn brove "Fix typo in README" --direction down
```

**Rules:**
- Do NOT manually run `git worktree add` (the captain may still create worktrees as part of branch hygiene, but crew operate in the captain's checkout — the CLI does not create worktrees by default; if the task requires isolation, ask the user before doing so).
- Do NOT edit source code yourself — always delegate to crew.
- Respect `maxCrew` — don't exceed the configured concurrent crew count.
- **Model routing is per-agent:** the agent driver decides; if you want a specific model, pass it through the agent's CLI flags inside the task prompt.
- **For complex multi-step tasks** (3+ steps, multiple files), tell the crew to use GSD inside the spawn prompt — add to the prompt: *"This is a complex task. Use `/gsd:plan-phase` and `/gsd:execute-phase` for wave-based execution with fresh context per step."*
- **For simple tasks**, don't mention GSD — the crew will handle it directly.

## Sending Follow-up Instructions

The crew session keeps running in its split pane until it exits. There is no per-pane CLI send yet — multi-turn follow-up is a follow-up improvement. For now, either:
- Send the entire context up front in the initial `cockpit crew spawn` task prompt, or
- Type follow-up instructions directly into the crew's pane via the cmux UI.
````

- [ ] **Step 3: Replace the "Task Coordination" section**

Find the `## Task Coordination` section. Replace with:

````markdown
## Task Coordination

You don't have an Agent Team or `TaskCreate`/`TaskUpdate` tools — those were Claude-specific. Track crew progress by:
1. Inspecting the crew pane visually in cmux (you have its surface ref from the spawn output).
2. Watching the auto-poller's `{spokeVault}/status.md` (written by the reactor — see issue #43).
3. Asking the user to check the dashboard if you need a cross-project view (see issue #44).

When a crew sends you a status message via `cockpit runtime send <project> "<message>"`, it lands in your captain pane. Acknowledge, then update your handoff if a meaningful decision was made.
````

- [ ] **Step 4: Replace the "MANDATORY CLOSE-OUT" section**

Find `## When Crew Finishes — MANDATORY CLOSE-OUT`. Replace with:

````markdown
## When Crew Finishes

After a crew task completes:

1. Review the work — read the diff, check the branch.
2. Merge their branch if appropriate.
3. Close the crew pane: it closes naturally when the agent session exits. If you need to force-close, use the cmux UI directly. (A `cockpit runtime close-pane` CLI is a follow-up improvement.)
4. Record learnings if any (see "Recording Learnings" below).
5. Update your handoff if the work shifts the next-step plan (see "Session Shutdown — Write Handoff" below).

The auto-poller updates `status.md` based on pane content; you don't need to write status manually after every event.
````

- [ ] **Step 5: Remove the explicit `cmux ...` invocations from the rest of the skill**

Find any remaining lines that hard-code `/Applications/cmux.app/Contents/Resources/bin/cmux` and rewrite them to use `cockpit runtime ...` (e.g., the "Report to command" block in close-out becomes optional now that command is on-demand — drop that block entirely).

- [ ] **Step 6: Commit**

```bash
git add plugin/skills/captain-ops/SKILL.md
git commit -m "docs(captain-ops): rewrite crew sections for cockpit crew spawn"
```

---

## Task 8: Update `orchestrator/crew.claude.md`

**Files:**
- Modify: `orchestrator/crew.claude.md`

- [ ] **Step 1: Replace rule 2 and the "Parallel Subagents" section**

In rule 2, change:

> 2. You CAN spawn subagents via the Agent tool for parallel work within your worktree (e.g., one on client code, one on server code). Ensure subagents work on non-overlapping files.

to:

> 2. You operate as a single fresh CLI session in a split pane. You do NOT spawn nested Agent Team subagents. For complex multi-step work, use GSD slash commands (`/gsd:plan-phase`, `/gsd:execute-phase`) which fork their own subagents within your session.

Delete the entire `## Parallel Subagents` section at the bottom.

- [ ] **Step 2: Commit**

```bash
git add orchestrator/crew.claude.md
git commit -m "docs(crew): drop Agent-tool subagent guidance, prefer GSD"
```

---

## Task 9: Update `orchestrator/crew.generic.md`

**Files:**
- Modify: `orchestrator/crew.generic.md`

- [ ] **Step 1: Drop status-write rule (handled by auto-poller, #43)**

Find rule 3:

```markdown
3. Write status updates via:
   ```bash
   ~/.config/cockpit/scripts/write-status.sh "{spokeVault}" "tasks_completed" "1" "Done: {description}"
   ```
```

Delete that rule entirely. Renumber rule 4 → rule 3.

- [ ] **Step 2: Add a single line above "Coding Discipline" noting split-pane spawn**

Insert this section right above `## Coding Discipline`:

```markdown
## How You Were Spawned

You were started by `cockpit crew spawn` as a split pane in the captain's workspace. Your task is in your initial prompt. When you finish, exit cleanly — the pane is disposable.
```

- [ ] **Step 3: Commit**

```bash
git add orchestrator/crew.generic.md
git commit -m "docs(crew): drop manual status-writing, add split-pane context"
```

---

## Task 10: Replace `scripts/spawn-crew-pane.sh` with a thin shim

**Files:**
- Modify: `scripts/spawn-crew-pane.sh`

- [ ] **Step 1: Replace file contents**

Overwrite with:

```bash
#!/bin/bash
# Deprecated direct script — use `cockpit crew spawn <project> <task>` instead.
# This shim forwards to the CLI for backward compat with existing call-sites.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: spawn-crew-pane.sh <project> <task> [direction] [agent]" >&2
  echo "Note: prefer 'cockpit crew spawn <project> \"<task>\"' directly." >&2
  exit 64
fi

PROJECT="$1"
TASK="$2"
DIRECTION="${3:-right}"
AGENT="${4:-claude}"

exec cockpit crew spawn "$PROJECT" "$TASK" --direction "$DIRECTION" --agent "$AGENT"
```

- [ ] **Step 2: Verify shim runs**

Run: `bash scripts/spawn-crew-pane.sh 2>&1 || true`
Expected: prints the usage line; exits 64.

- [ ] **Step 3: Commit**

```bash
git add scripts/spawn-crew-pane.sh
git commit -m "refactor(scripts): spawn-crew-pane.sh becomes a thin shim over cockpit crew spawn"
```

---

## Task 11: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `cockpit crew spawn` to the commands table**

In the commands table, after the `cockpit projection list` row, add:

```markdown
| `cockpit crew spawn <project> <task> [--direction <d>] [--agent <a>]` | Spawn a crew session in a split pane next to the project's captain |
```

- [ ] **Step 2: Update the "Roles" section**

Find the `### Roles` block. Replace the **Crew** bullet with:

```markdown
- **Crew** (Sonnet by default) — fresh CLI session in a split pane next to the captain. Spawned via `cockpit crew spawn`. Works with any agent CLI (claude, codex, gemini, aider). Disposable; uses GSD for complex tasks.
```

- [ ] **Step 3: Add a "Crew Spawn" subsection under Architecture**

Right after the "Notifier Abstraction" block, insert:

```markdown
### Crew Spawn (Split-Pane CLI)

Crew is no longer a Claude Agent Team member. The captain spawns a crew session via `cockpit crew spawn <project> "<task>"`, which opens a split pane in the captain's cmux workspace and starts a fresh CLI session for the chosen agent (`--agent claude|codex|gemini|aider`). The crew session loads `crew.<agent>.md` as its system prompt and the task as its inline prompt — exactly the OpenAI-Swarm "handoff = next prompt" pattern. State lives in the pane buffer + git; the pane is disposable. See [`docs/specs/2026-05-05-cockpit-thin-redirect-design.md`](docs/specs/2026-05-05-cockpit-thin-redirect-design.md).
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document cockpit crew spawn"
```

---

## Task 12: Full-suite verification + code review + PR

- [ ] **Step 1: Build clean**

Run: `npm run build`
Expected: exit 0, no tsc errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass except 2 known pre-existing emoji-related `commandName` failures in `src/config.test.ts` (these are unrelated to #41 and tracked by the user's icon-scheme preference; do not attempt to fix here).

- [ ] **Step 3: Re-link cockpit and smoke-test the new CLI inside cockpit's own cmux workspace**

Run:
```bash
npm link
cockpit --version          # expects "0.2.0"
cockpit crew --help        # expects "Spawn and manage crew sessions in split panes"
cockpit crew spawn --help  # shows --direction and --agent flags
```

If you have a registered project (`cockpit projects list`) and its captain is running, also smoke-test a real spawn:
```bash
cockpit crew spawn <project> "Acknowledge the role and run git status" --direction right
```
Expected: `✔ Crew spawned in workspace:N surface:M`. Visually verify the new pane opens and prints a captain-style acknowledgment.

- [ ] **Step 4: Audit for direct cmux-binary calls**

Run:
```bash
git grep -nE '/Applications/cmux\.app/Contents/Resources/bin/cmux|"cmux ' -- 'src/*.ts' 'plugin/' 'orchestrator/' 'scripts/'
```
Expected: zero hits in `src/*.ts`, `plugin/`, `orchestrator/`. The shim `scripts/spawn-crew-pane.sh` no longer invokes `cmux` directly. The runtime driver implementation file `src/runtimes/cmux.ts` is the only sanctioned place for the binary path.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin feature/crew-spawn-refactor
gh pr create --base develop --title "Crew spawn refactor: kill TeamCreate, use split-pane CLI (#41)" --body "$(cat <<'EOF'
Closes #41 (under umbrella #40).

## Summary

Replaces Claude-only TeamCreate/Agent crew-spawn with a runtime-agnostic split-pane CLI spawn that works for any agent (claude, codex, gemini, aider).

## Changes

- Extends `RuntimeDriver` with `newPane` / `closePane` / `sendToPane` / `readPaneScreen`
- New `cockpit crew spawn <project> <task>` CLI
- Captain templates and `captain-ops` skill rewritten — no more `TeamCreate` / `Agent` / `SendMessage` references
- Crew templates updated — drop Agent-tool subagent guidance; status-write rule removed (auto-poller covers it in #43)
- `scripts/spawn-crew-pane.sh` becomes a thin shim over the CLI
- README documents the new command + the crew-spawn architecture

## Test plan

- [x] Unit tests for new pane methods on cmux driver
- [x] Unit tests for `cockpit crew spawn` (project not found, captain not running, agent override, direction override, happy path)
- [x] Smoke-test via `cockpit crew spawn <project> "ack"` against a live captain
- [x] No direct cmux binary calls outside `src/runtimes/cmux.ts`
EOF
)"
```

- [ ] **Step 6: Verify CI is green and request review** (or self-review for solo).

---

## Self-Review Checklist

Before declaring this plan complete, the implementor should verify:

1. **Spec coverage** — every bullet in `#41` and decision #2 of the design spec is implemented:
   - [x] `RuntimeDriver` extended with pane ops (Task 1, 2)
   - [x] `cockpit crew spawn` CLI added (Task 3, 4)
   - [x] Captain templates remove TeamCreate/Agent (Task 5, 6)
   - [x] Captain-ops skill rewritten (Task 7)
   - [x] Crew templates updated (Task 8, 9)
   - [x] Existing `spawn-crew-pane.sh` becomes a shim (Task 10)
   - [x] README updated (Task 11)
2. **No direct cmux invocations** outside `src/runtimes/cmux.ts` (Task 12 step 4)
3. **All new code has tests** (Task 2, 3 each contain test + impl pairs)
4. **No nesting of Agent Teams** in any template

If any task ships with placeholder content (e.g., the "captain reports back to command" block was supposed to be removed but lingers), open a follow-up issue rather than blocking the PR — the umbrella #42 covers Command-related cleanup.
