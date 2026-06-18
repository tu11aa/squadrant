# Side-Sessions Framework Phase 1 Implementation Plan

> **✅ Shipped** (PR #284, #285, 2026-06-13). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `cockpit side spawn|send|list|close`, research role template, config entry, handoff script, and `cockpit:side-session` skill — entirely off the daemon lifecycle.

**Architecture:** New `src/commands/side.ts` mirrors `crew.ts` structure but skips all daemon dispatch (no `cockpitdCall`/`buildDispatchRequest`). `resolveCaptainWorkspace` exported from `crew.ts` as the minimal shared helper. Role templates in `orchestrator/` use the existing `mirrorFlat` sync pattern so they auto-deploy to `~/.config/cockpit/templates/`.

**Tech Stack:** TypeScript, Commander.js, vitest; existing `RuntimeRegistry`/`CapabilityRegistry`/`sendFirstTurnWhenReady` from `crew.ts`.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/drivers/types.ts` | Modify | Add `"side"` to `Role` union |
| `src/config.ts` | Modify | Add `"side"` to `RoleConfig`, add `defaults.roles.side` |
| `src/commands/crew.ts` | Modify | Export `resolveCaptainWorkspace` |
| `src/commands/side.ts` | Create | Full side command (spawn/send/list/close) |
| `src/index.ts` | Modify | Register `sideCommand` |
| `orchestrator/side.research.claude.md` | Create | Research role system prompt |
| `scripts/record-side-handoff.sh` | Create | Vault record write script |
| `plugin/skills/side-session/SKILL.md` | Create | Captain-facing skill docs |
| `src/commands/__tests__/side.test.ts` | Create | Unit tests |

---

### Task 1: Type foundations — Role union + RoleConfig

**Files:**
- Modify: `src/drivers/types.ts:11`
- Modify: `src/config.ts:59` (RoleConfig) and `src/config.ts:122` (getDefaultConfig roles)

- [ ] **Step 1: Add "side" to the Role union in types.ts**

Open `src/drivers/types.ts`. Line 11 currently reads:
```ts
export type Role = "command" | "captain" | "crew" | "exploration";
```
Change to:
```ts
export type Role = "command" | "captain" | "crew" | "exploration" | "side";
```

- [ ] **Step 2: Add "side" to RoleConfig and getDefaultConfig in config.ts**

In `src/config.ts`, the `RoleConfig` type (line ~59):
```ts
export type RoleConfig = Partial<Record<"command" | "captain" | "crew" | "exploration", RoleAssignment>>;
```
Change to:
```ts
export type RoleConfig = Partial<Record<"command" | "captain" | "crew" | "exploration" | "side", RoleAssignment>>;
```

In `getDefaultConfig()` (line ~122), inside the `roles` object, add after the `exploration` entry:
```ts
side: { agent: "claude", model: "opus" },
```
So `roles` becomes:
```ts
roles: {
  command: { agent: "claude", model: "opus" },
  captain: { agent: "claude", model: "opus" },
  crew: { agent: "claude", model: "opus" },
  exploration: { agent: "claude", model: "haiku" },
  side: { agent: "claude", model: "opus" },
},
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/q3labsadmin/me/claude-cockpit/.worktrees/cockpit-side-p1 && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors (or only pre-existing ones unrelated to these files).

- [ ] **Step 4: Commit**

```bash
git add src/drivers/types.ts src/config.ts
git commit -m "feat(side): add 'side' to Role union and RoleConfig defaults"
```

---

### Task 2: Export resolveCaptainWorkspace from crew.ts

**Files:**
- Modify: `src/commands/crew.ts:133` (function declaration)

- [ ] **Step 1: Add `export` to resolveCaptainWorkspace**

In `src/commands/crew.ts`, find the function starting at line ~133:
```ts
async function resolveCaptainWorkspace(project: string): Promise<{
```
Change to:
```ts
export async function resolveCaptainWorkspace(project: string): Promise<{
```
That's the only change — one word added. The callers within crew.ts are unaffected.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/q3labsadmin/me/claude-cockpit/.worktrees/cockpit-side-p1 && npx tsc --noEmit 2>&1 | head -20
```
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/crew.ts
git commit -m "feat(side): export resolveCaptainWorkspace for reuse in side command"
```

---

### Task 3: Implement src/commands/side.ts

**Files:**
- Create: `src/commands/side.ts`

- [ ] **Step 1: Write the tests FIRST (TDD)**

Create `src/commands/__tests__/side.test.ts` with the full test suite (see Task 4 below). Run them to confirm they fail before any implementation.

```bash
cd /Users/q3labsadmin/me/claude-cockpit/.worktrees/cockpit-side-p1 && npx vitest run src/commands/__tests__/side.test.ts 2>&1 | tail -20
```
Expected: FAIL — module not found or functions undefined.

- [ ] **Step 2: Create src/commands/side.ts**

```typescript
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import {
  createClaudeDriver,
  createCodexDriver,
  createGeminiDriver,
  createOpencodeDriver,
  CapabilityRegistry,
} from "../drivers/index.js";
import type { PaneRef, PanePlacement } from "../runtimes/types.js";
import { resolveCaptainWorkspace, sendFirstTurnWhenReady } from "./crew.js";
import { resolveTextInput } from "../lib/resolve-text-input.js";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");

const SIDE_ROLES = ["research", "debug"] as const;
type SideRole = (typeof SIDE_ROLES)[number];

// POSIX single-quote a path so it is safe to embed in a shell command even
// when the path contains spaces or special characters.
function shellQuote(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

function titleFor(project: string, name: string): string {
  return `🗒 ${project}:${name}`;
}

function isSideTitle(project: string, title: string): boolean {
  return title.startsWith(`🗒 ${project}:`);
}

function nameFromTitle(project: string, title: string): string {
  return title.slice(`🗒 ${project}:`.length);
}

function nextAutoName(existingTitles: string[], project: string): string {
  const used = new Set<number>();
  for (const title of existingTitles) {
    const n = nameFromTitle(project, title).match(/^side-(\d+)$/);
    if (n) used.add(Number(n[1]));
  }
  let i = 1;
  while (used.has(i)) i++;
  return `side-${i}`;
}

/** Builds the first-turn message: topic + injected context the agent needs
 *  for handoff (spokeVault, project, role). */
export function buildSideFirstTurn(
  topic: string,
  project: string,
  role: string,
  spokeVault: string,
): string {
  return [
    topic,
    "",
    "---",
    "Side-session context (for handoff use):",
    `Project: ${project}`,
    `Role: ${role}`,
    `Spoke vault: ${spokeVault}`,
  ].join("\n");
}

export interface SideSpawnInput {
  project: string;
  topic: string;
  role: string;
  name?: string;
  direction?: PanePlacement;
  agent?: string;
}

export async function runSideSpawn(input: SideSpawnInput): Promise<PaneRef> {
  const config = loadConfig();
  const proj = config.projects[input.project];
  if (!proj) {
    throw new Error(`Project '${input.project}' not found. Run 'cockpit projects list'.`);
  }

  if (input.role === "debug") {
    throw new Error(
      "Side role 'debug' is not yet implemented (Phase 2). Use --role research.",
    );
  }
  if (!SIDE_ROLES.includes(input.role as SideRole)) {
    throw new Error(
      `Unknown side role '${input.role}'. Valid roles: ${SIDE_ROLES.join(", ")}.`,
    );
  }

  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(
    input.project,
    config,
  );
  const captain = await runtime.status(proj.captainName);
  if (!captain) {
    throw new Error(
      `Captain workspace '${proj.captainName}' is not running. Run 'cockpit launch ${input.project}' first.`,
    );
  }

  const existing = await runtime.listSurfaces(captain.id);
  const existingTitles = existing
    .filter((s) => s.title && isSideTitle(input.project, s.title))
    .map((s) => s.title!);

  if (input.name) {
    const wantTitle = titleFor(input.project, input.name);
    if (existingTitles.includes(wantTitle)) {
      throw new Error(
        `Side session '${input.name}' already exists for ${input.project}.`,
      );
    }
  }
  const name = input.name ?? nextAutoName(existingTitles, input.project);

  const agents = new CapabilityRegistry({
    claude: createClaudeDriver(),
    codex: createCodexDriver(),
    gemini: createGeminiDriver(),
    opencode: createOpencodeDriver(),
  });
  const sideRole = config.defaults.roles?.side;
  const agentName = input.agent ?? sideRole?.agent ?? "claude";
  const agent = agents.get(agentName);
  if (!agent) {
    throw new Error(`Unknown agent '${agentName}'. Known: claude, codex, gemini, opencode.`);
  }

  const sideModel = sideRole?.model;
  const promptFile = path.join(
    TEMPLATES_DIR,
    `side.${input.role}.${agent.templateSuffix}.md`,
  );

  const direction: PanePlacement = input.direction ?? "tab";
  const title = titleFor(input.project, name);
  const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });

  const cliCommand = agent.buildCommand({
    prompt: input.topic,
    workdir: proj.path,
    role: "side",
    promptFile: fs.existsSync(promptFile) ? promptFile : undefined,
    interactive: true,
    permissionMode: config.defaults.permissions?.crew ?? "auto",
    ...(sideModel ? { model: sideModel } : {}),
  });

  await runtime.sendToPane(pane, `cd ${shellQuote(proj.path)} && ${cliCommand}`);
  const preLaunchScreen = (await runtime.readPaneScreen(pane)) ?? "";

  const firstTurn = buildSideFirstTurn(
    input.topic,
    input.project,
    input.role,
    proj.spokeVault ?? "",
  );
  await sendFirstTurnWhenReady(runtime, pane, firstTurn, preLaunchScreen);

  return { ...pane, title };
}

export async function runSideSend(
  project: string,
  name: string,
  message: string,
): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const want = titleFor(project, name);
  const surfaces = await runtime.listSurfaces(workspaceId);
  const pane = surfaces.find((s) => s.title === want) ?? null;
  if (!pane) {
    throw new Error(
      `Side session '${name}' not found for ${project}. Run 'cockpit side list ${project}'.`,
    );
  }
  await runtime.sendToPane(pane, message);
}

export async function runSideList(
  project: string,
): Promise<Array<{ name: string; surfaceId: string }>> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces
    .filter((s) => s.title && isSideTitle(project, s.title))
    .map((s) => ({
      name: nameFromTitle(project, s.title!),
      surfaceId: s.surfaceId,
    }));
}

export async function runSideClose(project: string, name: string): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const want = titleFor(project, name);
  const surfaces = await runtime.listSurfaces(workspaceId);
  const pane = surfaces.find((s) => s.title === want) ?? null;
  if (!pane) {
    throw new Error(
      `Side session '${name}' not found for ${project}. Run 'cockpit side list ${project}'.`,
    );
  }
  await runtime.closePane(pane);
}

export const sideCommand = new Command("side").description(
  "Spawn and manage side-sessions (research/debug) — fresh-context tabs off the daemon lifecycle",
);

sideCommand
  .command("spawn")
  .description(
    "Spawn a fresh-context side-session tab for research or debug (--role required)",
  )
  .argument("<project>", "Project name (must be registered)")
  .argument("[topic]", "Topic or question for the session (omit with --topic-file)")
  .requiredOption("--role <role>", "Session role: research | debug")
  .option("--name <name>", "Session name (default: auto-generated side-N)")
  .option(
    "--direction <dir>",
    "Placement: tab (default) or split direction (right|left|up|down)",
    "tab",
  )
  .option("--agent <name>", "Agent CLI to use (claude|opencode)", "claude")
  .option("--topic-file <path>", "Read topic from file instead of positional arg ('-' for stdin)")
  .action(
    async (
      project: string,
      topic: string | undefined,
      opts: { role: string; name?: string; direction: PanePlacement; agent: string; topicFile?: string },
    ) => {
      try {
        const resolvedTopic = await resolveTextInput({
          positional: topic,
          filePath: opts.topicFile,
          label: "topic",
        });
        const pane = await runSideSpawn({
          project,
          topic: resolvedTopic,
          role: opts.role,
          name: opts.name,
          direction: opts.direction,
          agent: opts.agent,
        });
        console.log(chalk.green(`✔ Side session '${pane.title}' spawned (${pane.surfaceId})`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    },
  );

sideCommand
  .command("list")
  .description("List live side-sessions for a project")
  .argument("<project>", "Project name")
  .action(async (project: string) => {
    try {
      const sessions = await runSideList(project);
      if (sessions.length === 0) {
        console.log(chalk.yellow(`No live side-sessions for ${project}.`));
        return;
      }
      for (const s of sessions) {
        console.log(`  ${s.name}  (${s.surfaceId})`);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

sideCommand
  .command("send")
  .description("Send a follow-up message to an existing side-session")
  .argument("<project>", "Project name")
  .argument("<name>", "Session name (e.g. side-1)")
  .argument("[message]", "Message to send (omit with --message-file)")
  .option("--message-file <path>", "Read message from file ('-' for stdin)")
  .action(
    async (
      project: string,
      name: string,
      message: string | undefined,
      opts: { messageFile?: string },
    ) => {
      try {
        const resolvedMessage = await resolveTextInput({
          positional: message,
          filePath: opts.messageFile,
          label: "message",
        });
        await runSideSend(project, name, resolvedMessage);
        console.log(chalk.green(`✔ Sent to ${project}:${name}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    },
  );

sideCommand
  .command("close")
  .description("Close a side-session (closes its tab)")
  .argument("<project>", "Project name")
  .argument("<name>", "Session name")
  .action(async (project: string, name: string) => {
    try {
      await runSideClose(project, name);
      console.log(chalk.green(`✔ Closed ${project}:${name}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/q3labsadmin/me/claude-cockpit/.worktrees/cockpit-side-p1 && npx tsc --noEmit 2>&1 | head -20
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/side.ts
git commit -m "feat(side): add cockpit side command (spawn/send/list/close) off daemon lifecycle"
```

---

### Task 4: Tests for side.ts

**Files:**
- Create: `src/commands/__tests__/side.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── mock setup (mirrors crew.test.ts pattern) ──────────────────────────────

const newPane = vi.hoisted(() => vi.fn());
const sendToPane = vi.hoisted(() => vi.fn());
const closePane = vi.hoisted(() => vi.fn());
const readPaneScreen = vi.hoisted(() => vi.fn());
const listSurfaces = vi.hoisted(() => vi.fn());
const status = vi.hoisted(() => vi.fn());
const buildCommand = vi.hoisted(() => vi.fn());

vi.mock("../../runtimes/index.js", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe: vi.fn(),
    list: vi.fn(),
    status,
    spawn: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(),
    stop: vi.fn(),
    newPane,
    closePane,
    sendToPane,
    readPaneScreen,
    listSurfaces,
  }),
  RuntimeRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    forProject() { return this.drivers.cmux; }
    global() { return this.drivers.cmux; }
    get(name: string) { return (this.drivers as Record<string, unknown>)[name]; }
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
  createOpencodeDriver: () => ({ ...claudeDriver, name: "opencode", templateSuffix: "opencode" }),
  CapabilityRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    get(name: string) { return (this.drivers as Record<string, unknown>)[name]; }
  },
}));

// cockpitdCall and buildDispatchRequest are the daemon dispatch path.
// side.ts MUST NOT call these — the mocks let us assert that invariant.
const cockpitdCall = vi.hoisted(() => vi.fn());
const buildDispatchRequest = vi.hoisted(() => vi.fn());
vi.mock("../crew-control.js", () => ({
  cockpitdCall,
  buildDispatchRequest,
  sendCodexFirstTurn: vi.fn().mockResolvedValue(undefined),
}));

const existsSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const merged = { ...actual, existsSync: existsSyncMock };
  return { ...merged, default: merged };
});

import { runSideSpawn, runSideSend, runSideList, runSideClose, buildSideFirstTurn } from "../side.js";

const baseConfig = {
  commandName: "command",
  hubVault: "~/hub",
  projects: {
    brove: {
      path: "/tmp/brove",
      captainName: "brove-captain",
      spokeVault: "~/hub/spokes/brove",
      host: "local",
    },
  },
  defaults: {
    maxCrew: 5,
    worktreeDir: ".worktrees",
    teammateMode: "in-process",
    permissions: { command: "auto", captain: "auto", crew: "auto" },
    roles: {
      side: { agent: "claude", model: "opus" },
    },
  },
  metrics: { enabled: false, path: "" },
};

describe("cockpit side spawn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    newPane.mockReset();
    sendToPane.mockReset();
    closePane.mockReset();
    readPaneScreen.mockReset();
    listSurfaces.mockReset();
    status.mockReset();
    buildCommand.mockReset();
    loadConfig.mockReset();
    cockpitdCall.mockReset();
    buildDispatchRequest.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);

    // Staged boot sequence matching crew.test.ts pattern
    let reads = 0;
    readPaneScreen.mockImplementation(async () => {
      reads++;
      if (reads === 1) return "booting…";
      if (reads <= 4) return "> ready";
      return "> ready\nworking…";
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("CRITICAL: does NOT call cockpitdCall or buildDispatchRequest (off daemon lifecycle)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --append-system-prompt-file /tmp/side.research.claude.md");

    const promise = runSideSpawn({ project: "brove", topic: "research oauth options", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(cockpitdCall).not.toHaveBeenCalled();
    expect(buildDispatchRequest).not.toHaveBeenCalled();
  });

  it("spawns with 🗒 title prefix and side-1 auto-name", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --append-system-prompt-file /tmp/side.research.claude.md");

    const promise = runSideSpawn({ project: "brove", topic: "research oauth", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(newPane).toHaveBeenCalledWith(expect.objectContaining({
      title: "🗒 brove:side-1",
    }));
    expect(result.title).toBe("🗒 brove:side-1");
  });

  it("wires the research template path (side.research.claude.md)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --template");

    const promise = runSideSpawn({ project: "brove", topic: "research oauth", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        promptFile: expect.stringContaining("side.research.claude.md"),
        role: "side",
        interactive: true,
      }),
    );
  });

  it("uses the side model from config (opus)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude --model opus");

    const promise = runSideSpawn({ project: "brove", topic: "research topic", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "opus" }),
    );
  });

  it("sends topic + context block as first turn (includes spokeVault)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "research oauth options", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    // Second sendToPane is the first-turn delivery
    const firstTurnCall = sendToPane.mock.calls[1];
    expect(firstTurnCall?.[1]).toContain("research oauth options");
    expect(firstTurnCall?.[1]).toContain("~/hub/spokes/brove");
    expect(firstTurnCall?.[1]).toContain("brove");
    expect(firstTurnCall?.[1]).toContain("research");
  });

  it("throws 'not yet implemented' for --role debug (Phase 2)", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);

    await expect(
      runSideSpawn({ project: "brove", topic: "debug the crash", role: "debug" }),
    ).rejects.toThrow("not yet implemented");
  });

  it("throws for unknown --role", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);

    await expect(
      runSideSpawn({ project: "brove", topic: "topic", role: "unknown-role" }),
    ).rejects.toThrow("Unknown side role");
  });

  it("auto-increments name avoiding existing side sessions", async () => {
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([
      { surfaceId: "s1", title: "🗒 brove:side-1" },
      { surfaceId: "s2", title: "🗒 brove:side-2" },
    ]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "topic", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result.title).toBe("🗒 brove:side-3");
  });

  it("uses promptFile=undefined when template file is absent", async () => {
    existsSyncMock.mockReturnValue(false);
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");

    const promise = runSideSpawn({ project: "brove", topic: "topic", role: "research" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({ promptFile: undefined }),
    );
  });
});

describe("buildSideFirstTurn", () => {
  it("includes topic, project, role, and spokeVault", () => {
    const result = buildSideFirstTurn(
      "research oauth options",
      "brove",
      "research",
      "~/hub/spokes/brove",
    );
    expect(result).toContain("research oauth options");
    expect(result).toContain("brove");
    expect(result).toContain("research");
    expect(result).toContain("~/hub/spokes/brove");
  });

  it("puts the topic first (before the context block)", () => {
    const result = buildSideFirstTurn("my topic", "proj", "research", "/vault");
    expect(result.indexOf("my topic")).toBeLessThan(result.indexOf("---"));
  });
});

describe("runSideList / runSideClose / runSideSend", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    listSurfaces.mockReset();
    status.mockReset();
    sendToPane.mockReset();
    closePane.mockReset();
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
  });

  it("runSideList returns only 🗒-prefixed sessions", async () => {
    listSurfaces.mockResolvedValue([
      { surfaceId: "s1", title: "🗒 brove:side-1" },
      { surfaceId: "s2", title: "🔧 brove:crew-1" },  // crew — must be excluded
      { surfaceId: "s3", title: "🗒 brove:side-2" },
    ]);

    const result = await runSideList("brove");

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual(["side-1", "side-2"]);
  });

  it("runSideClose closes the matching pane", async () => {
    listSurfaces.mockResolvedValue([{ surfaceId: "s1", title: "🗒 brove:side-1" }]);
    closePane.mockResolvedValue(undefined);

    await runSideClose("brove", "side-1");

    expect(closePane).toHaveBeenCalledWith(expect.objectContaining({ surfaceId: "s1" }));
  });

  it("runSideClose throws when session not found", async () => {
    listSurfaces.mockResolvedValue([]);

    await expect(runSideClose("brove", "side-99")).rejects.toThrow("not found");
  });

  it("runSideSend sends to the matching pane without touching daemon", async () => {
    listSurfaces.mockResolvedValue([{ surfaceId: "s1", title: "🗒 brove:side-1" }]);

    await runSideSend("brove", "side-1", "follow-up message");

    expect(sendToPane).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceId: "s1" }),
      "follow-up message",
    );
    expect(cockpitdCall).not.toHaveBeenCalled();
  });
});

describe("crew spawn regression — daemon path unchanged", () => {
  it("cockpit crew spawn still calls cockpitdCall (daemon path intact)", async () => {
    // Import crew lazily to avoid mock ordering issues
    const { runCrewSpawn } = await import("../crew.js");

    vi.useFakeTimers();
    loadConfig.mockReturnValue(baseConfig);
    status.mockResolvedValue({ id: "workspace:5", name: "brove-captain", status: "running" });
    listSurfaces.mockResolvedValue([]);
    newPane.mockResolvedValue({ workspaceId: "workspace:5", surfaceId: "surface:9" });
    buildCommand.mockReturnValue("claude");
    buildDispatchRequest.mockImplementation((o: unknown) => ({ kind: "dispatch", record: { ...(o as object), id: "task-cl1" } }));
    cockpitdCall.mockResolvedValue({ id: "task-cl1", project: "brove", provider: "claude", mode: "interactive" });

    const { writePerCrewSettingsLocal } = await import("../../lib/per-crew-settings.js");
    (writePerCrewSettingsLocal as ReturnType<typeof vi.fn>).mockReturnValue("/tmp/.claude/settings.local.json");

    const promise = runCrewSpawn({ project: "brove", task: "do the thing" });
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(cockpitdCall).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/q3labsadmin/me/claude-cockpit/.worktrees/cockpit-side-p1 && npx vitest run src/commands/__tests__/side.test.ts 2>&1 | tail -30
```
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/commands/__tests__/side.test.ts
git commit -m "test(side): unit tests for side command including no-daemon-dispatch invariant"
```

---

### Task 5: Research role template

**Files:**
- Create: `orchestrator/side.research.claude.md`

- [ ] **Step 1: Create the template**

```markdown
# Side-Session — Research Role

You are a **research assistant** running in a dedicated side-session alongside the primary captain. Your context is fresh and isolated from the captain's orchestration loop.

## Mandate

Research, discuss, and produce **artifacts** the primary captain can act on:

- GitHub issues (`gh issue create …`)
- Design specs and plans (markdown files in the project)
- Analysis and investigation documents

You operate at the **thinking and planning layer** — your job is to produce clear, actionable artifacts so the primary captain can dispatch a crew to implement.

## Capability Rules

| Capability | Allowed |
|-----------|:-------:|
| Read code, docs, git history | ✅ |
| Run read-only commands (`grep`, `find`, `cat`, `git log`) | ✅ |
| Run tests in read-only / diagnostic mode | ✅ |
| Create GitHub issues (`gh issue create`) | ✅ |
| Write spec/plan/doc files | ✅ |
| **Edit project source code** | ❌ |
| **Spawn crew sessions** (`cockpit crew spawn`) | ❌ |
| **Merge branches or push changes** | ❌ |

If you find yourself about to edit source code or run `cockpit crew spawn` — **stop**. Document the finding as an artifact instead and include it in the handoff.

## Handoff Protocol

When you have produced a result that deserves the primary captain's attention:

1. **Ask the user:** "Notify the primary captain now? (y/n)"

2. **On yes:**

   a. Write the durable vault record (replace `<spoke-vault>`, `<topic>`, `<summary>` with actual values from your first-turn context):
   ```bash
   ~/.config/cockpit/scripts/record-side-handoff.sh "<spoke-vault>" "<topic>" "<summary>"
   ```

   b. Send the structured handoff to the primary captain via relay:
   ```bash
   cockpit runtime send <project> "$(cat <<'HANDOFF'
🗒 Side handoff [research] — <topic>
Summary: <one-line summary>
Artifacts: <list: gh issue #NNN | spec: path/to/file.md | …>
Next: <recommended next action for the captain>
HANDOFF
)"
   ```

3. **On no:** keep working; you can trigger the handoff whenever you're ready.

The `<project>`, `<spoke-vault>` values are in the "Side-session context" block of your first turn.

## Karpathy Discipline

- **Think before researching** — surface your approach and assumptions
- **Simplicity first** — produce the minimal artifact that answers the question
- **Surgical** — stay on the research topic; don't go down tangents
- **Goal-driven** — define what "done" looks like before you start digging
```

The filename `side.research.claude.md` ends in `.claude.md`, which matches the `MANAGED_TARGETS` regex in `src/lib/runtime-sync.ts`: `/\.(claude\.md|generic\.md|opencode\.md|CLAUDE\.md)$/`. This means it will be automatically deployed to `~/.config/cockpit/templates/side.research.claude.md` on next CLI invocation.

- [ ] **Step 2: Commit**

```bash
git add orchestrator/side.research.claude.md
git commit -m "feat(side): add research role template (side.research.claude.md)"
```

---

### Task 6: Handoff vault record script

**Files:**
- Create: `scripts/record-side-handoff.sh`

Scripts ending in `.sh` in the `scripts/` dir are synced to `~/.config/cockpit/scripts/` with `chmod 755` by `mirrorFlat`.

- [ ] **Step 1: Create the script**

```bash
#!/bin/bash
# Usage: record-side-handoff.sh <spoke-vault-path> <topic> <summary>
# Writes a durable handoff record to {spokeVault}/side-handoffs/<topic>.md
set -euo pipefail

VAULT="${1:?Usage: record-side-handoff.sh <vault-path> <topic> <summary>}"
TOPIC="${2:?}"
SUMMARY="${3:?}"
DATE=$(date +"%Y-%m-%d")
SLUG=$(echo "$TOPIC" | head -c 60 | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g')
FILENAME="${VAULT}/side-handoffs/${SLUG}.md"

mkdir -p "${VAULT}/side-handoffs"

cat > "$FILENAME" << EOF
---
type: side-handoff
role: research
date: ${DATE}
topic: ${TOPIC}
---

## Summary
${SUMMARY}

## Full handoff

(Appended by side-session — see cockpit relay for the captain's copy.)
EOF

echo "Recorded side handoff: $FILENAME"
```

- [ ] **Step 2: Commit**

```bash
git add scripts/record-side-handoff.sh
git commit -m "feat(side): add record-side-handoff.sh vault record script"
```

---

### Task 7: Skill — cockpit:side-session

**Files:**
- Create: `plugin/skills/side-session/SKILL.md`

The `plugin/` tree is synced as a whole via `mirrorDir` in `MANAGED_TARGETS`. The skill will be auto-deployed to `~/.config/cockpit/plugin/skills/side-session/SKILL.md`.

- [ ] **Step 1: Create the skill file**

```markdown
---
name: side-session
description: Spawn and manage side-sessions (research/debug) — dedicated fresh-context tabs off the captain's daemon lifecycle. Use when you want to research a topic, discuss an idea, or debug without polluting captain context.
---

# Side-Sessions

A side-session is a dedicated tab with **fresh context** running the captain model (opus), loaded with a role-specific template. It runs **outside the crew/daemon lifecycle** — no `CREW IDLE/DONE` noise back to the primary captain. Its only upward signal is an explicit, user-confirmed structured handoff.

## Spawn a side-session

```bash
# Research a topic, discuss an idea, produce a spec or GH issue
cockpit side spawn <project> "<topic>" --role research

# Debug mode (Phase 2 — not yet available)
cockpit side spawn <project> "<topic>" --role debug
```

Options:
- `--name <name>` — custom tab name (default: auto `side-N`)
- `--direction <tab|right|down|left|up>` — placement (default: tab)
- `--agent <claude|opencode>` — agent to use (default: claude)
- `--topic-file <path>` — read topic from a file

## Manage side-sessions

```bash
cockpit side list <project>                              # see live side tabs
cockpit side send <project> <name> "<follow-up>"         # send a follow-up turn
cockpit side close <project> <name>                      # close when done
```

## Role: research

**Can:** Read code/docs, run read-only commands, create GH issues, write specs/plans.
**Cannot:** Edit source code, spawn crews, merge/ship changes.

The session works in fresh context and produces artifacts (specs, GH issues, analysis). When done, it asks the user to confirm before sending a structured handoff to the primary captain.

## Handoff workflow

```
1. Research session produces an artifact (spec, issue, analysis).
2. Session asks: "Notify the primary captain now? (y/n)"
3. On yes:
   - Writes durable record: {spokeVault}/side-handoffs/<topic>.md
   - Sends: cockpit runtime send <project> "🗒 Side handoff [research] — <topic> ..."
4. Primary captain receives handoff via relay.
5. Captain does NOT auto-spawn a crew — waits for user's go.
```

### Structured handoff format

```
🗒 Side handoff [research] — <topic>
Summary: <one-line summary>
Artifacts: <gh issue #NNN | spec: path/to/file.md | …>
Next: <recommended next action>
```

## Spawn by the primary captain

When the user asks you to start a side research session, spawn one:

```bash
cockpit side spawn <project> "<the research question or topic>" --role research
```

Then note the session name from the output (e.g. `side-1`) and tell the user they can steer it with:

```bash
cockpit side send <project> side-1 "<follow-up>"
cockpit side close <project> side-1
```

When the session completes, its handoff will arrive via relay with the `🗒 Side handoff` prefix.

## Key invariant

`cockpit side spawn` does **NOT** create a daemon task record. There is no `CREW IDLE/DONE` event for side-sessions. The only signal path is the explicit `cockpit runtime send` the side-session sends on user confirmation.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/skills/side-session/SKILL.md
git commit -m "feat(side): add cockpit:side-session skill"
```

---

### Task 8: Register sideCommand in src/index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import and registration**

In `src/index.ts`, add the import after the `crewCommand` import (line ~16):
```ts
import { sideCommand } from "./commands/side.js";
```

Add the `addCommand` call after `program.addCommand(crewCommand)` (line ~95):
```ts
program.addCommand(sideCommand);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/q3labsadmin/me/claude-cockpit/.worktrees/cockpit-side-p1 && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(side): register cockpit side command in CLI"
```

---

### Task 9: Full test suite run + build

- [ ] **Step 1: Run only the side tests to confirm they pass**

```bash
cd /Users/q3labsadmin/me/claude-cockpit/.worktrees/cockpit-side-p1 && npx vitest run src/commands/__tests__/side.test.ts 2>&1 | tail -20
```
Expected: All PASS, 0 failures.

- [ ] **Step 2: Run the full test suite (npm test)**

```bash
cd /Users/q3labsadmin/me/claude-cockpit/.worktrees/cockpit-side-p1 && npm test 2>&1 | tail -30
```
Expected: All tests pass. Zero failures. Suite exits cleanly.

- [ ] **Step 3: Build the package**

```bash
cd /Users/q3labsadmin/me/claude-cockpit/.worktrees/cockpit-side-p1 && npm run build 2>&1 | tail -10
```
Expected: No errors; `dist/` updated.

- [ ] **Step 4: Final commit if anything was adjusted**

```bash
git add -p  # stage only if there were any tweaks
git commit -m "chore(side): fix any test or compile issues after full suite run"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|-----------------|------|
| CLI noun `cockpit side spawn\|send\|list\|close` | Task 3 |
| `--role` REQUIRED; error if omitted | Task 3 (`requiredOption`) |
| `research` fully wired; `debug` stubbed with message | Task 3 |
| Off the daemon lifecycle (no TaskRecord/cockpitdCall) | Task 3 + Task 4 (critical test) |
| Extract shared helper (resolveCaptainWorkspace) | Task 2 |
| `orchestrator/side.research.claude.md` template | Task 5 |
| `defaults.roles.side` config (agent: claude, model: opus) | Task 1 |
| Offer+confirm handoff (runtime send + vault record) | Task 5 (template), Task 6 (script) |
| `cockpit:side-session` skill | Task 7 |
| Register in `src/index.ts` | Task 8 |
| Tests incl. no-daemon-dispatch invariant | Task 4 |
| `npm test` green | Task 9 |

### Placeholder scan
No TBD/TODO/placeholder items found in tasks. All code blocks are complete.

### Type consistency
- `SideRole = "research" | "debug"` used consistently in task 3 and tests
- `buildSideFirstTurn` exported and tested as pure function
- `SIDE_ROLES` const array used for validation
- `Role` union extended to include "side" in task 1 — all driver buildCommand calls use it correctly
