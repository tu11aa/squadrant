# Plugin System Phase 1 — Runtime Slot Implementation Plan

> **✅ Shipped** (PR #20, 2026-04-20). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abstract cmux behind a `RuntimeDriver` interface (mirroring `src/drivers/`), expose runtime ops via `cockpit runtime` CLI, and migrate all hardcoded cmux call-sites in TS and bash.

**Architecture:** New `src/runtimes/` directory parallel to `src/drivers/`. `CmuxDriver` implements `RuntimeDriver`. `RuntimeRegistry` picks the driver based on `config.runtime` (global) with optional `projects.<name>.runtime` override. Bash scripts call `cockpit runtime <op>` instead of `cmux` directly.

**Tech Stack:** TypeScript, commander.js, vitest, Node 22, bash.

**Spec:** `docs/specs/2026-04-20-plugin-system-runtime-design.md`

---

## File Structure

**Create:**
- `src/runtimes/types.ts` — interfaces: `RuntimeDriver`, `WorkspaceRef`, `RuntimeSpawnOptions`, `RuntimeProbeResult`.
- `src/runtimes/cmux.ts` — `createCmuxDriver()` factory exporting cmux-backed `RuntimeDriver`.
- `src/runtimes/registry.ts` — `RuntimeRegistry` class.
- `src/runtimes/index.ts` — barrel file.
- `src/runtimes/__tests__/cmux.test.ts` — unit tests mocking `child_process.execSync`.
- `src/runtimes/__tests__/registry.test.ts` — unit tests for config-based resolution.
- `src/commands/runtime.ts` — `cockpit runtime <op>` CLI subcommand.

**Modify:**
- `src/config.ts` — add `runtime?: string` to `CockpitConfig` and `ProjectConfig`.
- `src/index.ts` — register `runtimeCommand`.
- `src/commands/launch.ts` — replace hardcoded `cmux(...)` helpers with `RuntimeRegistry` calls.
- `src/commands/shutdown.ts` — use registry for list/close.
- `src/commands/doctor.ts` — probe configured runtimes instead of hardcoded cmux check.
- `scripts/execute-reaction.sh` — replace `cmux send`/`list-workspaces` with `cockpit runtime`.
- `scripts/spawn-workspace.sh` — replace cmux invocations with `cockpit runtime spawn`/`status`.
- `README.md` — document `runtime` config field.

---

## Task 1: Add `runtime?` field to config types

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add `runtime?: string` to `ProjectConfig` and `CockpitConfig`**

In `src/config.ts`, update the two interfaces:

```typescript
export interface ProjectConfig {
  path: string;
  captainName: string;
  spokeVault: string;
  host: string;
  group?: string;
  groupRole?: string;
  runtime?: string;  // NEW — overrides top-level runtime for this project
}

export interface CockpitConfig {
  commandName: string;
  hubVault: string;
  projects: Record<string, ProjectConfig>;
  agents?: Record<string, AgentEntry>;
  runtime?: string;  // NEW — global default runtime ("cmux" when absent)
  defaults: {
    maxCrew: number;
    worktreeDir: string;
    teammateMode: string;
    permissions: PermissionConfig;
    models?: ModelRoutingConfig;
    roles?: RoleConfig;
  };
  metrics: {
    enabled: boolean;
    path: string;
  };
}
```

- [ ] **Step 2: Run build to verify no type errors**

Run: `npm run lint`
Expected: exits 0, no output

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(runtime): add optional runtime field to config types"
```

---

## Task 2: Define RuntimeDriver interface

**Files:**
- Create: `src/runtimes/types.ts`

- [ ] **Step 1: Write the types file**

Create `src/runtimes/types.ts`:

```typescript
export interface WorkspaceRef {
  id: string;       // runtime-native ref (cmux: "workspace:42")
  name: string;     // human name ("brove-captain")
  status: "running" | "stopped" | "unknown";
}

export interface RuntimeSpawnOptions {
  name: string;
  workdir: string;
  command: string;  // the full agent CLI invocation
  icon?: string;
  pinToTop?: boolean;
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
}
```

- [ ] **Step 2: Run lint to verify**

Run: `npm run lint`
Expected: exits 0

- [ ] **Step 3: Commit**

```bash
git add src/runtimes/types.ts
git commit -m "feat(runtime): add RuntimeDriver interface"
```

---

## Task 3: Write failing tests for CmuxDriver

**Files:**
- Create: `src/runtimes/__tests__/cmux.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/runtimes/__tests__/cmux.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCmuxDriver } from "../cmux.js";

const execMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execSync: execMock,
}));

describe("cmux driver", () => {
  const driver = createCmuxDriver();

  beforeEach(() => {
    execMock.mockReset();
  });

  it("has name 'cmux'", () => {
    expect(driver.name).toBe("cmux");
  });

  it("probe returns installed=true with version when cmux responds", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("--version")) return "cmux 0.12.3\n";
      return "";
    });
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("cmux 0.12.3");
  });

  it("probe returns installed=false when cmux throws", async () => {
    execMock.mockImplementation(() => { throw new Error("not found"); });
    const result = await driver.probe();
    expect(result.installed).toBe(false);
    expect(result.version).toBe("");
  });

  it("list parses list-workspaces output into WorkspaceRefs", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("list-workspaces")) {
        return [
          "workspace:1  🏛️ command  (running)",
          "workspace:2  brove-captain  [selected]",
          "workspace:3  ⚡ reactor  (running)",
        ].join("\n");
      }
      return "";
    });
    const refs = await driver.list();
    expect(refs).toHaveLength(3);
    expect(refs[1]).toEqual({ id: "workspace:2", name: "brove-captain", status: "running" });
  });

  it("status returns null when name not in list", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("list-workspaces")) return "workspace:1  other-ws  (running)";
      return "";
    });
    const ref = await driver.status("brove-captain");
    expect(ref).toBeNull();
  });

  it("status returns WorkspaceRef when name matches", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("list-workspaces")) return "workspace:5  brove-captain  (running)";
      return "";
    });
    const ref = await driver.status("brove-captain");
    expect(ref).toEqual({ id: "workspace:5", name: "brove-captain", status: "running" });
  });

  it("send calls cmux send THEN cmux send-key Enter", async () => {
    execMock.mockReturnValue("");
    await driver.send("workspace:2", "hello world");
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("send") && c.includes("hello world") && !c.includes("send-key"))).toBe(true);
    expect(calls.some((c) => c.includes("send-key") && c.includes("Enter"))).toBe(true);
  });

  it("send escapes double-quotes in message", async () => {
    execMock.mockReturnValue("");
    await driver.send("workspace:2", 'say "hi"');
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('\\"hi\\"'))).toBe(true);
  });

  it("sendKey sends literal key without Enter", async () => {
    execMock.mockReturnValue("");
    await driver.sendKey("workspace:2", "Escape");
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("send-key");
    expect(calls[0]).toContain("Escape");
  });

  it("stop calls close-workspace", async () => {
    execMock.mockReturnValue("");
    await driver.stop("workspace:2");
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain("close-workspace");
    expect(calls[0]).toContain("workspace:2");
  });

  it("readScreen calls read-screen and returns output", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("read-screen")) return "screen contents\n";
      return "";
    });
    const out = await driver.readScreen("workspace:2");
    expect(out).toBe("screen contents");
  });

  it("spawn creates workspace, renames it, optionally pins, returns WorkspaceRef", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("new-workspace")) return "Created workspace:7\n";
      return "";
    });
    const ref = await driver.spawn({ name: "test-ws", workdir: "/tmp", command: "echo hi", pinToTop: true });
    expect(ref.id).toBe("workspace:7");
    expect(ref.name).toBe("test-ws");
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("new-workspace"))).toBe(true);
    expect(calls.some((c) => c.includes("rename-workspace") && c.includes("test-ws"))).toBe(true);
    expect(calls.some((c) => c.includes("workspace-action") && c.includes("--action pin"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/runtimes/__tests__/cmux.test.ts`
Expected: FAIL with "Cannot find module '../cmux.js'"

---

## Task 4: Implement CmuxDriver

**Files:**
- Create: `src/runtimes/cmux.ts`

- [ ] **Step 1: Write the implementation**

Create `src/runtimes/cmux.ts`:

```typescript
import { execSync } from "node:child_process";
import type { RuntimeDriver, RuntimeProbeResult, RuntimeSpawnOptions, WorkspaceRef } from "./types.js";

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

function cmux(args: string): string {
  return execSync(`"${CMUX_BIN}" ${args}`, { encoding: "utf-8" }).trim();
}

function parseList(output: string): WorkspaceRef[] {
  const refs: WorkspaceRef[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/(workspace:\d+)\s+(.+?)(?:\s+\(.*\))?(?:\s+\[selected\])?$/);
    if (match) {
      refs.push({
        id: match[1],
        name: match[2].trim(),
        status: "running",
      });
    }
  }
  return refs;
}

function escape(s: string): string {
  return s.replace(/"/g, '\\"');
}

export function createCmuxDriver(): RuntimeDriver {
  return {
    name: "cmux",

    async probe(): Promise<RuntimeProbeResult> {
      try {
        const version = cmux("--version");
        return { installed: true, version };
      } catch {
        return { installed: false, version: "" };
      }
    },

    async list(): Promise<WorkspaceRef[]> {
      try {
        return parseList(cmux("list-workspaces"));
      } catch {
        return [];
      }
    },

    async status(nameOrId: string): Promise<WorkspaceRef | null> {
      const refs = await this.list();
      const hit = refs.find((r) => r.name === nameOrId || r.id === nameOrId);
      return hit ?? null;
    },

    async spawn(opts: RuntimeSpawnOptions): Promise<WorkspaceRef> {
      const cwdFlag = opts.workdir ? ` --cwd "${opts.workdir}"` : "";
      const output = cmux(`new-workspace --command "${escape(opts.command)}"${cwdFlag}`);
      const id = output.match(/workspace:\d+/)?.[0] || output.split(/\s+/).pop() || "";
      if (!id) {
        throw new Error(`cmux spawn did not return a workspace id: ${output}`);
      }
      cmux(`rename-workspace --workspace "${id}" "${escape(opts.name)}"`);
      if (opts.pinToTop) {
        try {
          cmux(`workspace-action --workspace "${id}" --action pin`);
        } catch { /* pin is best-effort */ }
      }
      return { id, name: opts.name, status: "running" };
    },

    async send(ref: string, message: string): Promise<void> {
      cmux(`send --workspace "${ref}" "${escape(message)}"`);
      cmux(`send-key --workspace "${ref}" Enter`);
    },

    async sendKey(ref: string, key: string): Promise<void> {
      cmux(`send-key --workspace "${ref}" ${key}`);
    },

    async readScreen(ref: string): Promise<string> {
      try {
        return cmux(`read-screen --workspace "${ref}"`);
      } catch {
        return "";
      }
    },

    async stop(ref: string): Promise<void> {
      try {
        cmux(`close-workspace --workspace "${ref}"`);
      } catch { /* may already be closed */ }
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/runtimes/__tests__/cmux.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 3: Commit**

```bash
git add src/runtimes/cmux.ts src/runtimes/__tests__/cmux.test.ts
git commit -m "feat(runtime): add CmuxDriver implementing RuntimeDriver"
```

---

## Task 5: Write failing tests for RuntimeRegistry

**Files:**
- Create: `src/runtimes/__tests__/registry.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/runtimes/__tests__/registry.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { RuntimeRegistry } from "../registry.js";
import type { RuntimeDriver } from "../types.js";
import type { CockpitConfig } from "../../config.js";

function stubDriver(name: string): RuntimeDriver {
  return {
    name,
    probe: vi.fn(async () => ({ installed: true, version: `${name} 1.0` })),
    list: vi.fn(async () => []),
    status: vi.fn(async () => null),
    spawn: vi.fn(async () => ({ id: "workspace:1", name: "x", status: "running" as const })),
    send: vi.fn(async () => {}),
    sendKey: vi.fn(async () => {}),
    readScreen: vi.fn(async () => ""),
    stop: vi.fn(async () => {}),
  };
}

function baseConfig(overrides: Partial<CockpitConfig> = {}): CockpitConfig {
  return {
    commandName: "cmd",
    hubVault: "~/hub",
    projects: {},
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: { command: "default", captain: "acceptEdits" },
    },
    metrics: { enabled: false, path: "" },
    ...overrides,
  };
}

describe("RuntimeRegistry", () => {
  it("returns cmux driver when no runtime set anywhere (default)", () => {
    const registry = new RuntimeRegistry({ cmux: stubDriver("cmux") });
    const driver = registry.forProject("nonexistent", baseConfig());
    expect(driver.name).toBe("cmux");
  });

  it("returns top-level runtime when set", () => {
    const registry = new RuntimeRegistry({
      cmux: stubDriver("cmux"),
      tmux: stubDriver("tmux"),
    });
    const driver = registry.forProject("any", baseConfig({ runtime: "tmux" }));
    expect(driver.name).toBe("tmux");
  });

  it("project-level runtime overrides top-level", () => {
    const registry = new RuntimeRegistry({
      cmux: stubDriver("cmux"),
      tmux: stubDriver("tmux"),
      docker: stubDriver("docker"),
    });
    const config = baseConfig({
      runtime: "tmux",
      projects: {
        brove: {
          path: "/p",
          captainName: "brove-captain",
          spokeVault: "~/s",
          host: "local",
          runtime: "docker",
        },
      },
    });
    const driver = registry.forProject("brove", config);
    expect(driver.name).toBe("docker");
  });

  it("throws when configured runtime has no driver registered", () => {
    const registry = new RuntimeRegistry({ cmux: stubDriver("cmux") });
    const config = baseConfig({ runtime: "unknown" });
    expect(() => registry.forProject("any", config)).toThrowError(/unknown/i);
  });

  it("global() returns the driver for the top-level runtime", () => {
    const registry = new RuntimeRegistry({
      cmux: stubDriver("cmux"),
      tmux: stubDriver("tmux"),
    });
    expect(registry.global(baseConfig({ runtime: "tmux" })).name).toBe("tmux");
    expect(registry.global(baseConfig()).name).toBe("cmux");
  });

  it("probeAll returns probe results keyed by driver name", async () => {
    const registry = new RuntimeRegistry({
      cmux: stubDriver("cmux"),
      tmux: stubDriver("tmux"),
    });
    const results = await registry.probeAll();
    expect(results.cmux.installed).toBe(true);
    expect(results.tmux.installed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/runtimes/__tests__/registry.test.ts`
Expected: FAIL with "Cannot find module '../registry.js'"

---

## Task 6: Implement RuntimeRegistry

**Files:**
- Create: `src/runtimes/registry.ts`

- [ ] **Step 1: Write the implementation**

Create `src/runtimes/registry.ts`:

```typescript
import type { CockpitConfig } from "../config.js";
import type { RuntimeDriver, RuntimeProbeResult } from "./types.js";

const DEFAULT_RUNTIME = "cmux";

export class RuntimeRegistry {
  constructor(private drivers: Record<string, RuntimeDriver>) {}

  forProject(projectName: string, config: CockpitConfig): RuntimeDriver {
    const projectRuntime = config.projects[projectName]?.runtime;
    const runtimeName = projectRuntime ?? config.runtime ?? DEFAULT_RUNTIME;
    return this.get(runtimeName);
  }

  global(config: CockpitConfig): RuntimeDriver {
    const runtimeName = config.runtime ?? DEFAULT_RUNTIME;
    return this.get(runtimeName);
  }

  get(name: string): RuntimeDriver {
    const driver = this.drivers[name];
    if (!driver) {
      throw new Error(`Unknown runtime '${name}' — no driver registered`);
    }
    return driver;
  }

  async probeAll(): Promise<Record<string, RuntimeProbeResult>> {
    const results: Record<string, RuntimeProbeResult> = {};
    for (const [name, driver] of Object.entries(this.drivers)) {
      results[name] = await driver.probe();
    }
    return results;
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/runtimes/__tests__/registry.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 3: Commit**

```bash
git add src/runtimes/registry.ts src/runtimes/__tests__/registry.test.ts
git commit -m "feat(runtime): add RuntimeRegistry with project-level override"
```

---

## Task 7: Add runtimes barrel file

**Files:**
- Create: `src/runtimes/index.ts`

- [ ] **Step 1: Write the file**

Create `src/runtimes/index.ts`:

```typescript
export { createCmuxDriver } from "./cmux.js";
export { RuntimeRegistry } from "./registry.js";
export type {
  RuntimeDriver,
  RuntimeProbeResult,
  RuntimeSpawnOptions,
  WorkspaceRef,
} from "./types.js";
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: exits 0, generates `dist/runtimes/*.js`

- [ ] **Step 3: Commit**

```bash
git add src/runtimes/index.ts
git commit -m "feat(runtime): add runtimes barrel export"
```

---

## Task 8: Create `cockpit runtime` CLI subcommand

**Files:**
- Create: `src/commands/runtime.ts`

- [ ] **Step 1: Write the command file**

Create `src/commands/runtime.ts`:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import type { RuntimeDriver } from "../runtimes/types.js";
import type { CockpitConfig } from "../config.js";

function buildRegistry(): RuntimeRegistry {
  return new RuntimeRegistry({
    cmux: createCmuxDriver(),
  });
}

// Resolve <target> → { driver, workspaceName }.
// --command flag takes precedence; otherwise target is a project name.
interface ResolvedTarget {
  driver: RuntimeDriver;
  workspaceName: string;
}

function resolveTarget(
  registry: RuntimeRegistry,
  config: CockpitConfig,
  target: string | undefined,
  useCommand: boolean,
): ResolvedTarget {
  if (useCommand) {
    return {
      driver: registry.global(config),
      workspaceName: config.commandName,
    };
  }
  if (!target) {
    throw new Error("Missing target: pass a project name or use --command");
  }
  const proj = config.projects[target];
  if (!proj) {
    throw new Error(`Project '${target}' not found. Run 'cockpit projects list'.`);
  }
  return {
    driver: registry.forProject(target, config),
    workspaceName: proj.captainName,
  };
}

async function needRef(resolved: ResolvedTarget): Promise<string> {
  const ref = await resolved.driver.status(resolved.workspaceName);
  if (!ref) {
    throw new Error(`Workspace '${resolved.workspaceName}' is not running`);
  }
  return ref.id;
}

export const runtimeCommand = new Command("runtime")
  .description("Interact with the runtime layer (workspaces). Bridges bash scripts to the RuntimeDriver.");

runtimeCommand
  .command("status")
  .description("Print 'running' or 'stopped' for a target; exit 0 if running, 1 if not")
  .argument("[target]", "Project name")
  .option("--command", "Target the command workspace instead of a project captain")
  .action(async (target: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await resolved.driver.status(resolved.workspaceName);
      if (ref) {
        console.log("running");
        process.exit(0);
      } else {
        console.log("stopped");
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(2);
    }
  });

runtimeCommand
  .command("send")
  .description("Send a message to a target workspace AND commit with Enter. With --command, the first positional is the message.")
  .argument("<arg1>", "Project name, or the message when --command is used")
  .argument("[arg2]", "Message (when target is a project). Omit when using --command.")
  .option("--command", "Target the command workspace")
  .action(async (arg1: string, arg2: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const target = opts.command ? undefined : arg1;
      const message = opts.command ? arg1 : arg2;
      if (!message) throw new Error("Message is required");
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await needRef(resolved);
      await resolved.driver.send(ref, message);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

runtimeCommand
  .command("send-key")
  .description("Send a literal key press (e.g. Enter, Escape) to a target workspace. With --command, the first positional is the key.")
  .argument("<arg1>", "Project name, or the key when --command is used")
  .argument("[arg2]", "Key name (when target is a project). Omit when using --command.")
  .option("--command", "Target the command workspace")
  .action(async (arg1: string, arg2: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const target = opts.command ? undefined : arg1;
      const key = opts.command ? arg1 : arg2;
      if (!key) throw new Error("Key is required");
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await needRef(resolved);
      await resolved.driver.sendKey(ref, key);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

runtimeCommand
  .command("list")
  .description("List all workspaces from the global runtime")
  .option("-j, --json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    const driver = registry.global(config);
    const refs = await driver.list();
    if (opts.json) {
      console.log(JSON.stringify(refs, null, 2));
    } else {
      for (const r of refs) {
        console.log(`${r.id}\t${r.name}\t${r.status}`);
      }
    }
  });

runtimeCommand
  .command("read-screen")
  .description("Print a terminal snapshot of a target workspace")
  .argument("[target]", "Project name")
  .option("--command", "Target the command workspace")
  .action(async (target: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await needRef(resolved);
      const screen = await resolved.driver.readScreen(ref);
      process.stdout.write(screen);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

runtimeCommand
  .command("stop")
  .description("Stop a target workspace")
  .argument("[target]", "Project name")
  .option("--command", "Target the command workspace")
  .action(async (target: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await resolved.driver.status(resolved.workspaceName);
      if (!ref) {
        console.log(chalk.yellow(`Workspace '${resolved.workspaceName}' already stopped`));
        return;
      }
      await resolved.driver.stop(ref.id);
      console.log(chalk.green(`✔ Stopped ${resolved.workspaceName}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Register the command in src/index.ts**

Edit `src/index.ts` — add the import and registration:

```typescript
import { retroCommand } from "./commands/retro.js";
import { runtimeCommand } from "./commands/runtime.js";
```

And register it (matching the existing pattern after `retroCommand`):

```typescript
program.addCommand(retroCommand);
program.addCommand(runtimeCommand);
```

- [ ] **Step 3: Build and smoke-test**

Run: `npm run build && node dist/index.js runtime --help`
Expected: shows `runtime` subcommand help with `status`, `send`, `send-key`, `list`, `read-screen`, `stop` subcommands listed.

- [ ] **Step 4: Commit**

```bash
git add src/commands/runtime.ts src/index.ts
git commit -m "feat(runtime): add 'cockpit runtime' CLI subcommand"
```

---

## Task 9: Migrate launch.ts to use RuntimeRegistry

**Files:**
- Modify: `src/commands/launch.ts`

- [ ] **Step 1: Replace imports and helpers**

In `src/commands/launch.ts`:

Replace the top-of-file imports block:

```typescript
import { Command } from "commander";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig, resolveHome, type ModelRoutingConfig } from "../config.js";
import { createClaudeDriver, createCodexDriver, createGeminiDriver, createAiderDriver, CapabilityRegistry } from "../drivers/index.js";
import type { AgentDriver, Role } from "../drivers/types.js";

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const CMUX_APP = "/Applications/cmux.app";
```

With:

```typescript
import { Command } from "commander";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig, resolveHome, type ModelRoutingConfig, type CockpitConfig } from "../config.js";
import { createClaudeDriver, createCodexDriver, createGeminiDriver, createAiderDriver, CapabilityRegistry } from "../drivers/index.js";
import type { AgentDriver, Role } from "../drivers/types.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import type { RuntimeDriver } from "../runtimes/types.js";

const CMUX_APP = "/Applications/cmux.app";
```

(Removed `CMUX_BIN` constant — it now lives in the CmuxDriver.)

- [ ] **Step 2: Delete the `cmux()` and `findWorkspaceRef()` helpers**

Delete these functions from `launch.ts`:

```typescript
function cmux(args: string): string { ... }
function findWorkspaceRef(name: string): string | null { ... }
```

They're replaced by driver calls.

- [ ] **Step 3: Refactor `launchWorkspace` to accept a runtime driver**

Replace the `launchWorkspace` function with:

```typescript
async function launchWorkspace(
  runtime: RuntimeDriver,
  name: string,
  agentCmd: string,
  cwd?: string,
  navigate = false,
  forceFresh = false,
  pinToTop = false,
  initialPrompt?: string,
): Promise<void> {
  ensureCmuxReady();

  const existing = await runtime.status(name);
  if (existing && forceFresh) {
    console.log(chalk.yellow(`  Closing stale workspace '${name}' for fresh start`));
    await runtime.stop(existing.id);
  } else if (existing) {
    console.log(chalk.yellow(`  Workspace '${name}' already exists — switching to it`));
    // Runtime-specific: select is still a cmux detail; keep direct execSync for now via agnostic path.
    // For cmux, select-workspace is invoked through a runtime-agnostic 'focus' we haven't added yet —
    // so we call through execSync to cmux here as a transitional step. See Task 10 for further migration.
    execSync(`"/Applications/cmux.app/Contents/Resources/bin/cmux" select-workspace --workspace "${existing.id}"`);
    return;
  }

  const ref = await runtime.spawn({
    name,
    workdir: cwd ?? process.cwd(),
    command: agentCmd,
    pinToTop,
  });

  if (initialPrompt) {
    setTimeout(() => {
      runtime.send(ref.id, initialPrompt).catch(() => { /* best-effort */ });
    }, 3000);
  }

  if (navigate) {
    execSync(`"/Applications/cmux.app/Contents/Resources/bin/cmux" select-workspace --workspace "${ref.id}"`);
  }

  console.log(chalk.green(`  ✔ Workspace '${name}' created`));
}
```

- [ ] **Step 4: Build the runtime registry in the action and pass through**

In the `launchCommand` action, after `const config = loadConfig();`, build the registry:

```typescript
const runtimes = new RuntimeRegistry({ cmux: createCmuxDriver() });
```

And change `launchOne` to resolve the runtime per-project:

```typescript
async function launchOne(
  workspaceName: string,
  role: string,
  cwd: string,
  permissionMode: string,
  navigate: boolean,
  pinToTop = false,
  projectName?: string,
): Promise<void> {
  let forceFresh = !!opts.fresh;
  if (!forceFresh) {
    const auto = shouldStartFresh(workspaceName, role);
    if (auto.fresh) {
      console.log(chalk.cyan(`  ↻ ${auto.reason}`));
      forceFresh = true;
    }
  }

  const roleConfig = config.defaults.roles?.[role as keyof NonNullable<typeof config.defaults.roles>];
  const agentName = roleConfig?.agent || "claude";
  const model = roleConfig?.model || config.defaults.models?.[role as keyof ModelRoutingConfig];
  const agentCmd = buildAgentCmd(agentName, registry, role, forceFresh, permissionMode, model);
  recordSession(workspaceName, role);

  let initialPrompt: string | undefined;
  if (role === "captain") {
    initialPrompt = "Run your startup checklist: use the cockpit:captain-ops skill, complete all startup steps, then report ready.";
  } else if (role === "command") {
    initialPrompt = "Run your startup checklist: use the cockpit:command-ops skill, complete your daily briefing, then report ready.";
  } else if (role === "reactor") {
    initialPrompt = "Run your startup checklist: use the cockpit:reactor-ops skill, verify gh auth, read reactions.json, then start your poll loop.";
  }

  const runtime = projectName
    ? runtimes.forProject(projectName, config)
    : runtimes.global(config);

  try {
    await launchWorkspace(runtime, workspaceName, agentCmd, cwd, navigate, forceFresh, pinToTop, initialPrompt);
  } catch (err) {
    console.error(chalk.red(`  ✘ Failed: ${(err as Error).message}`));
  }
}
```

- [ ] **Step 5: Make the action `async` and `await` the `launchOne` calls**

Change the action signature and all `launchOne(...)` calls to `await launchOne(...)`. Update the project-loop invocation to pass `name` as `projectName`:

```typescript
.action(async (project: string | undefined, opts: { fresh?: boolean; all?: boolean; reactor?: boolean }) => {
  // ... existing code ...

  if (opts.all) {
    // ...
    await launchOne(workspaceName, "command", hubPath, config.defaults.permissions?.command || "default", true, true);
    await launchOne(reactorName, "reactor", hubPath, config.defaults.permissions?.reactor || "default", false, true);
    for (const [name, proj] of Object.entries(config.projects)) {
      // ... existing spoke vault setup ...
      await launchOne(proj.captainName, "captain", projPath, config.defaults.permissions?.captain || "acceptEdits", false, true, name);
    }
  } else if (!project) {
    await launchOne(workspaceName, "command", hubPath, config.defaults.permissions?.command || "default", true, true);
    if (opts.reactor) {
      await launchOne(reactorName, "reactor", hubPath, config.defaults.permissions?.reactor || "default", false, true);
    }
  } else {
    // ... existing captain branch ...
    await launchOne(proj.captainName, "captain", projPath, config.defaults.permissions?.captain || "acceptEdits", false, true, project);
  }
});
```

- [ ] **Step 6: Build and smoke-test**

Run: `npm run build`
Expected: exits 0

Run: `node dist/index.js launch --help`
Expected: shows launch help (existing behavior preserved)

- [ ] **Step 7: Commit**

```bash
git add src/commands/launch.ts
git commit -m "refactor(launch): use RuntimeRegistry instead of hardcoded cmux helpers"
```

---

## Task 10: Migrate shutdown.ts to use RuntimeRegistry

**Files:**
- Modify: `src/commands/shutdown.ts`

- [ ] **Step 1: Replace the whole file**

Replace `src/commands/shutdown.ts` with:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";

export const shutdownCommand = new Command("shutdown")
  .description(
    "Shutdown command + all captain workspaces (no args) or one captain workspace",
  )
  .argument("[project]", "Project name to shut down captain for")
  .action(async (project: string | undefined) => {
    const config = loadConfig();
    const runtimes = new RuntimeRegistry({ cmux: createCmuxDriver() });

    if (!project) {
      const globalRuntime = runtimes.global(config);
      const workspaces = await globalRuntime.list();
      const captainNames = Object.values(config.projects).map((p) => p.captainName);
      const commandName = config.commandName || "command";
      const cockpitWorkspaces = workspaces.filter(
        (w) => w.name === commandName || captainNames.includes(w.name),
      );

      if (cockpitWorkspaces.length === 0) {
        console.log(chalk.yellow("\nNo cockpit workspaces found to close.\n"));
        return;
      }

      console.log(chalk.bold(`\nShutting down ${cockpitWorkspaces.length} workspace(s)...\n`));
      for (const ws of cockpitWorkspaces) {
        try {
          await globalRuntime.stop(ws.id);
          console.log(chalk.green(`  ✔ Closed: ${ws.name}`));
        } catch {
          console.log(chalk.red(`  ✘ Failed to close: ${ws.name}`));
        }
      }
      console.log("");
      return;
    }

    if (!config.projects[project]) {
      console.error(
        chalk.red(
          `\n  ✘ Project '${project}' not found. Run 'cockpit projects list' to see registered projects.\n`,
        ),
      );
      process.exit(1);
    }

    const captainName = config.projects[project].captainName;
    const runtime = runtimes.forProject(project, config);
    console.log(chalk.bold(`\nShutting down captain workspace for '${project}'...\n`));

    const ref = await runtime.status(captainName);
    if (!ref) {
      console.log(chalk.yellow(`  ⚠ Workspace '${captainName}' not found — already closed?\n`));
      return;
    }

    try {
      await runtime.stop(ref.id);
      console.log(chalk.green(`  ✔ Closed: ${captainName}\n`));
    } catch {
      console.error(chalk.red(`  ✘ Failed to close workspace '${captainName}'\n`));
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0

- [ ] **Step 3: Commit**

```bash
git add src/commands/shutdown.ts
git commit -m "refactor(shutdown): use RuntimeRegistry instead of direct cmux calls"
```

---

## Task 11: Migrate doctor.ts to probe configured runtimes

**Files:**
- Modify: `src/commands/doctor.ts`

- [ ] **Step 1: Read the full current file first**

Run: `cat src/commands/doctor.ts`

Note the existing cmux check: `results.push(check("cmux installed", commandExists("cmux") || fs.existsSync("/Applications/cmux.app")));`

- [ ] **Step 2: Replace the cmux check with runtime-registry probe**

Import at the top of `src/commands/doctor.ts`:

```typescript
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
```

Inside the action, replace the cmux check line with:

```typescript
const runtimes = new RuntimeRegistry({ cmux: createCmuxDriver() });
const config = loadConfig();
const probeResults = await runtimes.probeAll();

// Global runtime must be installed
const globalRuntimeName = config.runtime ?? "cmux";
const globalProbe = probeResults[globalRuntimeName];
results.push(check(
  `Runtime '${globalRuntimeName}' installed`,
  !!globalProbe?.installed,
));

// Any project-level override must also be installed
const overrides = new Set<string>();
for (const proj of Object.values(config.projects)) {
  if (proj.runtime && proj.runtime !== globalRuntimeName) overrides.add(proj.runtime);
}
for (const runtimeName of overrides) {
  const probe = probeResults[runtimeName];
  results.push(check(
    `Runtime '${runtimeName}' installed (project override)`,
    !!probe?.installed,
  ));
}
```

- [ ] **Step 3: Build and run doctor**

Run: `npm run build && node dist/index.js doctor`
Expected: shows "Runtime 'cmux' installed ✔ PASS" line replacing old "cmux installed" line.

- [ ] **Step 4: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "refactor(doctor): probe configured runtimes via RuntimeRegistry"
```

---

## Task 12: Migrate scripts/execute-reaction.sh to `cockpit runtime`

**Files:**
- Modify: `scripts/execute-reaction.sh`

- [ ] **Step 1: Replace `get_captain_ws`**

In `scripts/execute-reaction.sh`, replace the entire `get_captain_ws` function:

```bash
# Check whether a project's captain workspace is running.
# Returns "running" (stdout "running", exit 0) or "stopped" (stdout "stopped", exit 1).
get_captain_ws() {
  local proj="$1"
  cockpit runtime status "$proj" 2>/dev/null
}
```

- [ ] **Step 2: Replace `get_command_ws`**

Replace the `get_command_ws` function:

```bash
# Check whether the command workspace is running.
get_command_ws() {
  cockpit runtime status --command 2>/dev/null
}
```

- [ ] **Step 3: Update all `$CMUX send ... ; $CMUX send-key Enter` pairs**

Replace every occurrence of the pattern:

```bash
"$CMUX" send --workspace "$WS" "$MESSAGE"
"$CMUX" send-key --workspace "$WS" Enter
```

With:

```bash
cockpit runtime send "$PROJECT" "$MESSAGE"
```

For the command-workspace path:

```bash
"$CMUX" send --workspace "$CMD_WS" "$MESSAGE"
"$CMUX" send-key --workspace "$CMD_WS" Enter
```

Becomes:

```bash
cockpit runtime send --command "$MESSAGE"
```

- [ ] **Step 4: Update the OFFLINE-check pattern**

The previous pattern was `WS=$(get_captain_ws ...)` followed by `if [ "$WS" = "OFFLINE" ]`. The new pattern:

```bash
if ! get_captain_ws "$PROJECT" >/dev/null; then
  echo "⚠️  Captain for '$PROJECT' is offline. Spawning..."
  cockpit launch "$PROJECT" 2>/dev/null || true
  sleep 5
fi

# Deliver (errors from send are surfaced; no ref handling needed)
cockpit runtime send "$PROJECT" "$MESSAGE" || {
  echo "✘ Could not reach captain for '$PROJECT'" >&2
  exit 1
}
```

Apply this pattern to the `delegate-to-captain`, `send-to-captain`, and `auto-fix-ci` cases. Remove the `"$CMUX"` binary reference entirely — the top-of-file `CMUX=...` line is no longer needed.

- [ ] **Step 5: Remove the CMUX binary path**

Delete line 7 of the old file: `CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"`.

- [ ] **Step 6: Manual smoke test**

Run (with a running captain):

```bash
bash -n scripts/execute-reaction.sh   # syntax check
```

Expected: no output, exit 0.

Then construct a minimal `/tmp/test-action.json`:

```json
{"action":"send-to-captain","project":"brove","message":"smoke test","rule":"plan-smoke"}
```

Run: `scripts/execute-reaction.sh /tmp/test-action.json`
Expected: Either "✔ Sent message to brove captain" (if brove is running) or an error — NOT a crash in bash syntax.

- [ ] **Step 7: Commit**

```bash
git add scripts/execute-reaction.sh
git commit -m "refactor(reactor): migrate execute-reaction.sh to 'cockpit runtime'"
```

---

## Task 13: Migrate scripts/spawn-workspace.sh to `cockpit runtime`

**Files:**
- Modify: `scripts/spawn-workspace.sh`

- [ ] **Step 1: Replace cmux existence + close block**

Replace this block near line 170:

```bash
EXISTING_REF=$("$CMUX" list-workspaces 2>&1 | grep -F "$NAME" | awk '{print $1}' || true)
if [ -n "$EXISTING_REF" ] && [ "$FRESH" = "true" ]; then
  echo "Closing stale workspace: $NAME"
  "$CMUX" close-workspace --workspace "$EXISTING_REF" 2>/dev/null || true
  EXISTING_REF=""
fi

if [ -n "$EXISTING_REF" ]; then
  echo "Workspace '$NAME' already exists — switching to it"
  "$CMUX" select-workspace --workspace "$EXISTING_REF" 2>&1
  exit 0
fi
```

With:

```bash
# Find existing workspace via runtime abstraction
EXISTING_JSON=$(cockpit runtime list --json 2>/dev/null || echo "[]")
EXISTING_ID=$(echo "$EXISTING_JSON" | python3 -c "
import json,sys
try:
    for w in json.load(sys.stdin):
        if w.get('name') == '$NAME':
            print(w['id']); break
except: pass
")

if [ -n "$EXISTING_ID" ] && [ "$FRESH" = "true" ]; then
  echo "Closing stale workspace: $NAME"
  # Use cmux directly here only to preserve the select-workspace-after behavior;
  # Runtime.stop() is exposed but we need raw ref for select. Use cockpit stop by project when possible.
  "/Applications/cmux.app/Contents/Resources/bin/cmux" close-workspace --workspace "$EXISTING_ID" 2>/dev/null || true
  EXISTING_ID=""
fi

if [ -n "$EXISTING_ID" ]; then
  echo "Workspace '$NAME' already exists — switching to it"
  "/Applications/cmux.app/Contents/Resources/bin/cmux" select-workspace --workspace "$EXISTING_ID" 2>&1
  exit 0
fi
```

Note: `select-workspace` has no runtime abstraction yet (deferred — it's cmux-focus-specific and not called from the reactor). Keeping a single direct cmux call here is the bounded exception. Document this in comments.

- [ ] **Step 2: Leave the new-workspace/rename/pin block as-is for this phase**

The spawn path in `spawn-workspace.sh` is only called by `cockpit launch` for legacy compatibility and by the command-session captain-spawn skill. Fully migrating it requires the driver to accept role-specific `initialPrompt` + pinning logic, which `spawn()` already supports. But rewriting the bash spawn flow is a larger change — defer to a follow-up task. Leave lines 184-202 of the original file unchanged.

- [ ] **Step 3: Remove the top-of-file `CMUX=` constant only if unused**

Run: `grep '"$CMUX"' scripts/spawn-workspace.sh`

If any matches remain (they will, from the spawn block), KEEP the `CMUX=...` line.

- [ ] **Step 4: Syntax check**

Run: `bash -n scripts/spawn-workspace.sh`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/spawn-workspace.sh
git commit -m "refactor(spawn-workspace): use 'cockpit runtime list' for existence check"
```

---

## Task 14: Update README to document runtime config

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add runtime to the Commands table**

In `README.md`, after the `cockpit reactor status` row in the commands table, insert:

```markdown
| `cockpit runtime status <project>` | Check if a project's captain workspace is running |
| `cockpit runtime send <project> <msg>` | Send a message to a captain workspace (auto-Enter) |
| `cockpit runtime list` | List all workspaces from the active runtime |
```

- [ ] **Step 2: Add the `runtime` field to the Config example**

Update the JSON example under the Config section — add `runtime` at the top level and as an optional project field:

```json
{
  "commandName": "command",
  "hubVault": "~/cockpit-hub",
  "runtime": "cmux",
  "projects": {
    "brove": {
      "path": "~/projects/brove",
      "captainName": "brove-captain",
      "spokeVault": "~/cockpit-hub/spokes/brove",
      "host": "local",
      "runtime": "cmux"
    }
  },
  "defaults": {
    "maxCrew": 5,
    "worktreeDir": ".worktrees",
    "teammateMode": "in-process",
    "permissions": {
      "command": "default",
      "captain": "acceptEdits"
    },
    "models": {
      "command": "opus",
      "captain": "opus",
      "crew": "sonnet",
      "reactor": "sonnet",
      "exploration": "haiku",
      "review": "opus"
    }
  }
}
```

- [ ] **Step 3: Add a short Architecture note**

Under the Architecture section, after the "Model Routing" subsection, add:

```markdown
### Runtime Abstraction

Workspaces run on a pluggable **runtime driver** (currently only `cmux`). Each project may override the global default via its `runtime` field. Bash scripts call `cockpit runtime <op>` to talk to the configured runtime instead of any specific binary. New runtimes (tmux, Docker, SSH) are added as driver files in `src/runtimes/` — see `docs/specs/2026-04-20-plugin-system-runtime-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document runtime config field and CLI subcommand"
```

---

## Task 15: Full-suite verification

**Files:** none — just run everything.

- [ ] **Step 1: Run the full test suite**

Run: `npm run test -- --run`
Expected: all tests pass, including new `cmux.test.ts` (11 tests) and `registry.test.ts` (6 tests), plus all existing driver + other tests.

- [ ] **Step 2: Run lint/build**

Run: `npm run lint && npm run build`
Expected: exits 0 on both.

- [ ] **Step 3: Run doctor end-to-end**

Run: `node dist/index.js doctor`
Expected: new "Runtime 'cmux' installed" line replaces old "cmux installed" line; all checks pass.

- [ ] **Step 4: Runtime CLI smoke test**

Run: `node dist/index.js runtime list`
Expected: prints running cmux workspaces (or empty output if none).

Run: `node dist/index.js runtime status --command`
Expected: prints "running" (exit 0) if command workspace exists, else "stopped" (exit 1).

- [ ] **Step 5: No commit — verification only**

If anything fails, fix in place and commit as `fix(runtime): ...`.

---

## Self-Review Notes

- **Spec coverage:** Every section of the design spec (§1 Interface, §2 Registry + Config, §3 CLI, §4 Refactor Surface, §5 Testing, §6 Rollout) has at least one implementing task. §6 is spread across Tasks 9-14.
- **Type consistency:** `RuntimeDriver` method names (`probe`, `list`, `status`, `spawn`, `send`, `sendKey`, `readScreen`, `stop`) are identical across types.ts, cmux.ts, registry tests, and CLI subcommand. `WorkspaceRef` shape (`id`, `name`, `status`) is identical across all uses.
- **Deferred scope** (explicitly out, per design §Non-Goals): select-workspace / focus abstraction (Task 13 keeps a bounded direct-cmux call), full bash→TS rewrite of spawn-workspace.sh, workspace/tracker/notifier slots, external plugin loading.
- **Commit discipline:** 14 atomic commits across 15 tasks; Task 15 is verify-only (no commit unless fix needed).
