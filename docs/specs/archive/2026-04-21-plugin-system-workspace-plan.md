# Plugin System Phase 2 — Workspace Slot Implementation Plan

> **✅ Shipped** (PR #20 (workspace seam, @cockpit/workspaces), 2026-04-21). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abstract vault storage behind a `WorkspaceDriver` interface (mirroring `src/runtimes/`), expose filesystem ops via `cockpit workspace` CLI, and migrate all ~33 direct `fs.*` call-sites across 11 files to use the driver.

**Architecture:** New `src/workspaces/` directory parallel to `src/runtimes/`. `ObsidianDriver` implements `WorkspaceDriver` over `node:fs/promises`. `WorkspaceRegistry` resolves hub/project scopes from `config.workspace` + `projects[name].workspace`. Bash scripts call `cockpit workspace <op>` instead of `cat`/`path` directly.

**Tech Stack:** TypeScript, commander.js, vitest, Node 22 (`fs/promises`), bash.

**Spec:** `docs/specs/2026-04-21-plugin-system-workspace-design.md`

---

## File Structure

**Create:**
- `src/workspaces/types.ts` — `WorkspaceDriver`, `WorkspaceScope`, `WorkspaceProbeResult`, `WorkspaceFactory`
- `src/workspaces/obsidian.ts` — `createObsidianDriver(scope)` (fs-backed)
- `src/workspaces/registry.ts` — `WorkspaceRegistry`
- `src/workspaces/index.ts` — barrel
- `src/workspaces/__tests__/obsidian.test.ts`
- `src/workspaces/__tests__/registry.test.ts`
- `src/workspaces/__tests__/helpers/memory-driver.ts` — in-memory test driver
- `src/commands/workspace.ts` — `cockpit workspace read/write/list/exists/mkdir`
- `src/lib/vault-layout.ts` — `ensureSpokeLayout(workspace)` extracted helper

**Modify:**
- `src/config.ts` — add `workspace?: string` to `ProjectConfig` and `CockpitConfig`
- `src/index.ts` — register `workspaceCommand`
- `src/commands/init.ts` — use `WorkspaceDriver` for hub + spoke dir creation
- `src/commands/launch.ts` — use `ensureSpokeLayout` helper
- `src/commands/projects.ts` — use `WorkspaceDriver` on spoke add
- `src/commands/status.ts` — use `WorkspaceRegistry`
- `src/commands/standup.ts`, `retro.ts` — pass driver into daily-logs helpers
- `src/commands/doctor.ts` — probe workspace providers
- `src/lib/daily-logs.ts` — accept `WorkspaceDriver` argument
- `scripts/reactor-cycle.sh`, `scripts/read-status.sh` — call `cockpit workspace read`
- `README.md` — document `workspace` config field

---

## Task 1: Add `workspace?` field to config types

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add `workspace?: string` to `ProjectConfig` and `CockpitConfig`**

In `src/config.ts`, update both interfaces:

```typescript
export interface ProjectConfig {
  path: string;
  captainName: string;
  spokeVault: string;
  host: string;
  group?: string;
  groupRole?: string;
  runtime?: string;
  workspace?: string;  // NEW — overrides top-level workspace provider for this project
}

export interface CockpitConfig {
  commandName: string;
  hubVault: string;
  projects: Record<string, ProjectConfig>;
  agents?: Record<string, AgentEntry>;
  runtime?: string;
  workspace?: string;  // NEW — global default workspace provider ("obsidian" when absent)
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

- [ ] **Step 2: Verify lint**

Run: `npm run lint`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(workspace): add optional workspace field to config types"
```

---

## Task 2: Define WorkspaceDriver interface

**Files:**
- Create: `src/workspaces/types.ts`

- [ ] **Step 1: Write the types file**

Create `src/workspaces/types.ts`:

```typescript
export interface WorkspaceProbeResult {
  installed: boolean;   // provider dependencies present (fs driver always true)
  rootExists: boolean;  // this scope is reachable (dir exists / API auth valid)
}

export interface WorkspaceScope {
  root?: string;                // obsidian: absolute filesystem root
  [key: string]: unknown;       // provider-specific (loose per follow-up #23)
}

export interface WorkspaceDriver {
  name: string;                 // "obsidian"

  probe(): Promise<WorkspaceProbeResult>;

  // All paths are scope-relative (e.g., "daily-logs/2026-04-21.md"). Forward-slash.
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;   // entry names, not full paths
  mkdir(path: string): Promise<void>;     // always recursive
}

export type WorkspaceFactory = (scope: WorkspaceScope) => WorkspaceDriver;
```

- [ ] **Step 2: Verify lint**

Run: `npm run lint`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/workspaces/types.ts
git commit -m "feat(workspace): add WorkspaceDriver interface"
```

---

## Task 3: Write failing tests for ObsidianDriver

**Files:**
- Create: `src/workspaces/__tests__/obsidian.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/workspaces/__tests__/obsidian.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObsidianDriver } from "../obsidian.js";

describe("ObsidianDriver", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("has name 'obsidian'", () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    expect(driver.name).toBe("obsidian");
  });

  it("probe returns installed=true and rootExists=true for a real dir", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.rootExists).toBe(true);
  });

  it("probe returns rootExists=false when scope root is missing", async () => {
    const missing = path.join(tmpRoot, "does-not-exist");
    const driver = createObsidianDriver({ root: missing });
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.rootExists).toBe(false);
  });

  it("write then read round-trips content", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.mkdir("daily-logs");
    await driver.write("daily-logs/2026-04-21.md", "hello world");
    const content = await driver.read("daily-logs/2026-04-21.md");
    expect(content).toBe("hello world");
  });

  it("exists returns true/false correctly", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.write("a.txt", "x");
    expect(await driver.exists("a.txt")).toBe(true);
    expect(await driver.exists("b.txt")).toBe(false);
  });

  it("list returns entry names only (not paths)", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.mkdir("crew");
    await driver.write("crew/one.md", "1");
    await driver.write("crew/two.md", "2");
    const entries = await driver.list("crew");
    expect(entries.sort()).toEqual(["one.md", "two.md"]);
  });

  it("list returns empty array for missing directory", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    const entries = await driver.list("nope");
    expect(entries).toEqual([]);
  });

  it("mkdir is always recursive", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.mkdir("a/b/c/d");
    expect(fs.existsSync(path.join(tmpRoot, "a/b/c/d"))).toBe(true);
  });

  it("write creates parent directories", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.write("deep/nested/file.txt", "data");
    expect(fs.readFileSync(path.join(tmpRoot, "deep/nested/file.txt"), "utf-8")).toBe("data");
  });

  it("scope-rooted paths never escape root (no path traversal via ../)", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await expect(driver.read("../../etc/passwd")).rejects.toThrow(/escapes workspace root/i);
    await expect(driver.write("../evil.txt", "x")).rejects.toThrow(/escapes workspace root/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workspaces/__tests__/obsidian.test.ts`
Expected: FAIL with "Cannot find module '../obsidian.js'"

---

## Task 4: Implement ObsidianDriver

**Files:**
- Create: `src/workspaces/obsidian.ts`

- [ ] **Step 1: Write the implementation**

Create `src/workspaces/obsidian.ts`:

```typescript
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  WorkspaceDriver,
  WorkspaceProbeResult,
  WorkspaceScope,
} from "./types.js";

function resolveInRoot(root: string, relative: string): string {
  const joined = path.resolve(root, relative);
  const normalized = path.resolve(root) + path.sep;
  if (joined !== path.resolve(root) && !joined.startsWith(normalized)) {
    throw new Error(`Path '${relative}' escapes workspace root`);
  }
  return joined;
}

export function createObsidianDriver(scope: WorkspaceScope): WorkspaceDriver {
  const root = scope.root;
  if (typeof root !== "string" || root === "") {
    throw new Error("ObsidianDriver requires scope.root (string)");
  }

  return {
    name: "obsidian",

    async probe(): Promise<WorkspaceProbeResult> {
      return {
        installed: true,
        rootExists: existsSync(root),
      };
    },

    async read(rel: string): Promise<string> {
      return fs.readFile(resolveInRoot(root, rel), "utf-8");
    },

    async write(rel: string, content: string): Promise<void> {
      const abs = resolveInRoot(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },

    async exists(rel: string): Promise<boolean> {
      try {
        await fs.access(resolveInRoot(root, rel));
        return true;
      } catch {
        return false;
      }
    },

    async list(rel: string): Promise<string[]> {
      try {
        return await fs.readdir(resolveInRoot(root, rel));
      } catch {
        return [];
      }
    },

    async mkdir(rel: string): Promise<void> {
      await fs.mkdir(resolveInRoot(root, rel), { recursive: true });
    },
  };
}
```

- [ ] **Step 2: Run tests to verify all pass**

Run: `npx vitest run src/workspaces/__tests__/obsidian.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 3: Commit**

```bash
git add src/workspaces/obsidian.ts src/workspaces/__tests__/obsidian.test.ts
git commit -m "feat(workspace): add ObsidianDriver implementing WorkspaceDriver"
```

---

## Task 5: Write failing tests for WorkspaceRegistry

**Files:**
- Create: `src/workspaces/__tests__/registry.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/workspaces/__tests__/registry.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { WorkspaceRegistry } from "../registry.js";
import type { WorkspaceDriver, WorkspaceScope } from "../types.js";
import type { CockpitConfig } from "../../config.js";

function stubFactory(name: string): (scope: WorkspaceScope) => WorkspaceDriver {
  return (scope) => ({
    name,
    probe: vi.fn(async () => ({ installed: true, rootExists: true })),
    read: vi.fn(async () => `read:${name}:${scope.root}`),
    write: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    list: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
  });
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

describe("WorkspaceRegistry", () => {
  it("returns obsidian driver by default for hub", () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    const driver = registry.hub(baseConfig());
    expect(driver.name).toBe("obsidian");
  });

  it("uses top-level workspace override for hub", () => {
    const registry = new WorkspaceRegistry({
      obsidian: stubFactory("obsidian"),
      notion: stubFactory("notion"),
    });
    const driver = registry.hub(baseConfig({ workspace: "notion" }));
    expect(driver.name).toBe("notion");
  });

  it("forProject returns obsidian by default", () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    const config = baseConfig({
      projects: {
        brove: { path: "/p", captainName: "brove-c", spokeVault: "~/s", host: "local" },
      },
    });
    const driver = registry.forProject("brove", config);
    expect(driver.name).toBe("obsidian");
  });

  it("project-level workspace overrides top-level", () => {
    const registry = new WorkspaceRegistry({
      obsidian: stubFactory("obsidian"),
      notion: stubFactory("notion"),
      plain: stubFactory("plain"),
    });
    const config = baseConfig({
      workspace: "notion",
      projects: {
        brove: { path: "/p", captainName: "brove-c", spokeVault: "~/s", host: "local", workspace: "plain" },
      },
    });
    const driver = registry.forProject("brove", config);
    expect(driver.name).toBe("plain");
  });

  it("throws when configured provider has no factory registered", () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    expect(() => registry.hub(baseConfig({ workspace: "unknown" }))).toThrowError(/unknown/i);
  });

  it("forProject throws for unknown project", () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    expect(() => registry.forProject("nope", baseConfig())).toThrowError(/not found/i);
  });

  it("hub passes resolved hubVault as scope.root", () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    const driver = registry.hub(baseConfig({ hubVault: "~/cockpit-hub" }));
    // The stub returns `read:obsidian:<scope.root>` — verify root was resolved (no ~)
    return driver.read("x.md").then((out) => {
      expect(out).toMatch(/^read:obsidian:\//);
      expect(out).not.toContain("~");
    });
  });

  it("probeAll returns results keyed by provider name", async () => {
    const registry = new WorkspaceRegistry({
      obsidian: stubFactory("obsidian"),
      notion: stubFactory("notion"),
    });
    const results = await registry.probeAll(baseConfig());
    expect(results.obsidian.installed).toBe(true);
    expect(results.notion.installed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/workspaces/__tests__/registry.test.ts`
Expected: FAIL with "Cannot find module '../registry.js'"

---

## Task 6: Implement WorkspaceRegistry

**Files:**
- Create: `src/workspaces/registry.ts`

- [ ] **Step 1: Write the implementation**

Create `src/workspaces/registry.ts`:

```typescript
import { resolveHome, type CockpitConfig } from "../config.js";
import type {
  WorkspaceDriver,
  WorkspaceFactory,
  WorkspaceProbeResult,
} from "./types.js";

const DEFAULT_WORKSPACE = "obsidian";

export class WorkspaceRegistry {
  constructor(private factories: Record<string, WorkspaceFactory>) {}

  hub(config: CockpitConfig): WorkspaceDriver {
    const name = config.workspace ?? DEFAULT_WORKSPACE;
    return this.get(name)({ root: resolveHome(config.hubVault) });
  }

  forProject(projectName: string, config: CockpitConfig): WorkspaceDriver {
    const proj = config.projects[projectName];
    if (!proj) throw new Error(`Project '${projectName}' not found`);
    const name = proj.workspace ?? config.workspace ?? DEFAULT_WORKSPACE;
    return this.get(name)({ root: resolveHome(proj.spokeVault) });
  }

  get(name: string): WorkspaceFactory {
    const factory = this.factories[name];
    if (!factory) {
      throw new Error(`Unknown workspace provider '${name}' — no factory registered`);
    }
    return factory;
  }

  async probeAll(config: CockpitConfig): Promise<Record<string, WorkspaceProbeResult>> {
    const results: Record<string, WorkspaceProbeResult> = {};
    for (const [name, factory] of Object.entries(this.factories)) {
      const scope = { root: resolveHome(config.hubVault) };
      results[name] = await factory(scope).probe();
    }
    return results;
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/workspaces/__tests__/registry.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 3: Commit**

```bash
git add src/workspaces/registry.ts src/workspaces/__tests__/registry.test.ts
git commit -m "feat(workspace): add WorkspaceRegistry with project-level override"
```

---

## Task 7: Add workspaces barrel file

**Files:**
- Create: `src/workspaces/index.ts`

- [ ] **Step 1: Write the barrel**

Create `src/workspaces/index.ts`:

```typescript
export { createObsidianDriver } from "./obsidian.js";
export { WorkspaceRegistry } from "./registry.js";
export type {
  WorkspaceDriver,
  WorkspaceFactory,
  WorkspaceProbeResult,
  WorkspaceScope,
} from "./types.js";
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/workspaces/index.ts
git commit -m "feat(workspace): add workspaces barrel export"
```

---

## Task 8: Add in-memory test driver helper

**Files:**
- Create: `src/workspaces/__tests__/helpers/memory-driver.ts`

- [ ] **Step 1: Write the helper**

Create `src/workspaces/__tests__/helpers/memory-driver.ts`:

```typescript
import type { WorkspaceDriver } from "../../types.js";

export function createMemoryDriver(initial: Record<string, string> = {}): WorkspaceDriver & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();

  // Seed dirs from keys
  for (const key of files.keys()) {
    const parts = key.split("/");
    for (let i = 1; i <= parts.length - 1; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }

  return {
    name: "memory",
    files,

    async probe() {
      return { installed: true, rootExists: true };
    },

    async read(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path)!;
    },

    async write(path, content) {
      files.set(path, content);
      const parts = path.split("/");
      for (let i = 1; i <= parts.length - 1; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    },

    async exists(path) {
      return files.has(path) || dirs.has(path);
    },

    async list(dir) {
      const prefix = dir === "" ? "" : `${dir}/`;
      const entries = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const first = rest.split("/")[0];
        if (first) entries.add(first);
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        const first = rest.split("/")[0];
        if (first && !rest.includes("/")) entries.add(first);
      }
      return Array.from(entries).sort();
    },

    async mkdir(path) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    },
  };
}
```

- [ ] **Step 2: Write a smoke test**

Create `src/workspaces/__tests__/helpers/memory-driver.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createMemoryDriver } from "./memory-driver.js";

describe("createMemoryDriver", () => {
  it("round-trips write/read", async () => {
    const d = createMemoryDriver();
    await d.write("a/b.md", "x");
    expect(await d.read("a/b.md")).toBe("x");
  });

  it("list returns immediate children only", async () => {
    const d = createMemoryDriver({ "a/b.md": "1", "a/c/d.md": "2" });
    expect((await d.list("a")).sort()).toEqual(["b.md", "c"]);
  });

  it("exists tracks both files and mkdir-created dirs", async () => {
    const d = createMemoryDriver();
    await d.mkdir("x/y");
    expect(await d.exists("x/y")).toBe(true);
    expect(await d.exists("x/z")).toBe(false);
  });
});
```

- [ ] **Step 3: Run both**

Run: `npx vitest run src/workspaces/__tests__/helpers/memory-driver.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 4: Commit**

```bash
git add src/workspaces/__tests__/helpers/
git commit -m "test(workspace): add in-memory WorkspaceDriver for test fixtures"
```

---

## Task 9: Create `cockpit workspace` CLI subcommand

**Files:**
- Create: `src/commands/workspace.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the command file**

Create `src/commands/workspace.ts`:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, type CockpitConfig } from "../config.js";
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";
import type { WorkspaceDriver } from "../workspaces/types.js";

function buildRegistry(): WorkspaceRegistry {
  return new WorkspaceRegistry({
    obsidian: createObsidianDriver,
  });
}

function resolveTarget(
  registry: WorkspaceRegistry,
  config: CockpitConfig,
  target: string | undefined,
  useHub: boolean,
): WorkspaceDriver {
  if (useHub) return registry.hub(config);
  if (!target) throw new Error("Missing target: pass a project name or use --hub");
  return registry.forProject(target, config);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const workspaceCommand = new Command("workspace")
  .description("Interact with the workspace layer (vault storage). Bridges bash scripts to the WorkspaceDriver.");

workspaceCommand
  .command("read")
  .description("Print the contents of a scope-relative path to stdout")
  .argument("<target>", "Project name")
  .argument("<path>", "Scope-relative path")
  .option("--hub", "Target the hub workspace instead of a project spoke")
  .action(async (target: string, relPath: string, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const driver = resolveTarget(registry, config, opts.hub ? undefined : target, !!opts.hub);
      const path = opts.hub ? target : relPath;  // --hub shifts positional
      const content = await driver.read(path);
      process.stdout.write(content);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

workspaceCommand
  .command("write")
  .description("Write content to a scope-relative path. Pass '-' as content to read from stdin.")
  .argument("<target>", "Project name")
  .argument("<path>", "Scope-relative path")
  .argument("<content>", "Content, or '-' to read from stdin")
  .option("--hub", "Target the hub workspace")
  .action(async (target: string, relPath: string, content: string, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      let actualTarget = target;
      let actualPath = relPath;
      let actualContent = content;
      if (opts.hub) {
        // --hub shifts positionals: target becomes path, path becomes content
        actualTarget = "";
        actualPath = target;
        actualContent = relPath;
      }
      const driver = resolveTarget(registry, config, opts.hub ? undefined : actualTarget, !!opts.hub);
      const payload = actualContent === "-" ? await readStdin() : actualContent;
      await driver.write(actualPath, payload);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

workspaceCommand
  .command("list")
  .description("List entries in a scope-relative directory")
  .argument("<target>", "Project name")
  .argument("<dir>", "Scope-relative directory")
  .option("--hub", "Target the hub workspace")
  .action(async (target: string, dir: string, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const driver = resolveTarget(registry, config, opts.hub ? undefined : target, !!opts.hub);
      const actualDir = opts.hub ? target : dir;
      const entries = await driver.list(actualDir);
      for (const entry of entries) console.log(entry);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

workspaceCommand
  .command("exists")
  .description("Exit 0 if path exists, 1 if not")
  .argument("<target>", "Project name")
  .argument("<path>", "Scope-relative path")
  .option("--hub", "Target the hub workspace")
  .action(async (target: string, relPath: string, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const driver = resolveTarget(registry, config, opts.hub ? undefined : target, !!opts.hub);
      const actualPath = opts.hub ? target : relPath;
      const ok = await driver.exists(actualPath);
      process.exit(ok ? 0 : 1);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(2);
    }
  });

workspaceCommand
  .command("mkdir")
  .description("Recursively create a scope-relative directory")
  .argument("<target>", "Project name")
  .argument("<path>", "Scope-relative path")
  .option("--hub", "Target the hub workspace")
  .action(async (target: string, relPath: string, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const driver = resolveTarget(registry, config, opts.hub ? undefined : target, !!opts.hub);
      const actualPath = opts.hub ? target : relPath;
      await driver.mkdir(actualPath);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Register command in src/index.ts**

In `src/index.ts`:
- Add import after `runtimeCommand`: `import { workspaceCommand } from "./commands/workspace.js";`
- Register after `program.addCommand(runtimeCommand);`: `program.addCommand(workspaceCommand);`

- [ ] **Step 3: Build and smoke-test**

Run:
```
npm run build
node dist/index.js workspace --help
```
Expected: shows 5 subcommands (read/write/list/exists/mkdir).

- [ ] **Step 4: Commit**

```bash
git add src/commands/workspace.ts src/index.ts
git commit -m "feat(workspace): add 'cockpit workspace' CLI subcommand"
```

---

## Task 10: Extract vault-layout helper + migrate init.ts

**Files:**
- Create: `src/lib/vault-layout.ts`
- Modify: `src/commands/init.ts`

- [ ] **Step 1: Create the layout helper**

Create `src/lib/vault-layout.ts`:

```typescript
import type { WorkspaceDriver } from "../workspaces/types.js";

export const SPOKE_SUBDIRS = [
  "crew",
  "learnings",
  "daily-logs",
  "skills",
  "meta",
  "templates",
  "wiki",
  "wiki/pages",
];

export async function ensureSpokeLayout(workspace: WorkspaceDriver): Promise<void> {
  for (const sub of SPOKE_SUBDIRS) {
    await workspace.mkdir(sub);
  }
}
```

- [ ] **Step 2: Migrate init.ts hub-create block**

In `src/commands/init.ts`, replace the hub-vault-create block (the `if (fs.existsSync(hubPath))` block for hub scaffolding). The existing `copyDirRecursive` template logic stays — it copies the whole `obsidian/hub` template tree, which is semantically equivalent to a filesystem copy. This stays as-is because it's a provider-specific bootstrap (Obsidian template files).

However, also wire in the workspace driver so a future provider's init path is discoverable. Add this import at the top:

```typescript
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";
```

And add a workspace probe before the scaffold attempt:

```typescript
// Probe the configured workspace provider; for obsidian the scaffold
// continues to use the Obsidian-specific template tree copy below.
const registry = new WorkspaceRegistry({ obsidian: createObsidianDriver });
const workspaceName = (fs.existsSync(DEFAULT_CONFIG_PATH) ? JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf-8")).workspace : null) ?? "obsidian";
if (!registry.get(workspaceName)) {
  console.log(chalk.red(`  ✘ Unknown workspace provider '${workspaceName}'`));
  return;
}
```

**Important:** the obsidian-specific `copyDirRecursive(hubTemplate, hubPath)` stays because it copies Obsidian app-specific template files (`.obsidian/` config, starter md files). A future Notion driver would skip this step entirely and use its own bootstrap.

- [ ] **Step 3: Build and verify**

Run: `npm run build && node dist/index.js init --help`
Expected: exit 0, help renders.

- [ ] **Step 4: Commit**

```bash
git add src/lib/vault-layout.ts src/commands/init.ts
git commit -m "refactor(init): add vault-layout helper and workspace-provider probe"
```

---

## Task 11: Migrate launch.ts spoke-init + projects.ts

**Files:**
- Modify: `src/commands/launch.ts`
- Modify: `src/commands/projects.ts`

- [ ] **Step 1: Replace launch.ts spoke-init block**

In `src/commands/launch.ts`, find the inline block (appears twice — once in `--all` loop, once in the project branch):

```typescript
if (!fs.existsSync(spokePath)) {
  fs.mkdirSync(spokePath, { recursive: true });
  for (const sub of ["crew", "learnings", "daily-logs", "skills", "meta", "templates", "wiki", "wiki/pages"]) {
    fs.mkdirSync(path.join(spokePath, sub), { recursive: true });
  }
  console.log(chalk.cyan(`  ✔ Created spoke vault at ${spokePath}`));
}
```

Replace BOTH occurrences with:

```typescript
const spokeExists = fs.existsSync(spokePath);
if (!spokeExists) {
  const spokeDriver = new WorkspaceRegistry({ obsidian: createObsidianDriver }).forProject(name, config);
  await ensureSpokeLayout(spokeDriver);
  console.log(chalk.cyan(`  ✔ Created spoke vault at ${spokePath}`));
}
```

Add imports at the top of `launch.ts`:

```typescript
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";
import { ensureSpokeLayout } from "../lib/vault-layout.js";
```

In the `--all` loop the variable name is `name` (project iteration key). In the project-arg branch the variable name is `project`. Use the correct one in each location.

- [ ] **Step 2: Migrate projects.ts spoke init**

Read `src/commands/projects.ts`. Find the spoke-vault initialization (if any — on `projects add`).

If `projects.ts` creates the spoke dir + subdirs on add, replace that block with:

```typescript
const spokeDriver = new WorkspaceRegistry({ obsidian: createObsidianDriver }).forProject(name, config);
await ensureSpokeLayout(spokeDriver);
```

And add imports:

```typescript
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";
import { ensureSpokeLayout } from "../lib/vault-layout.js";
```

If projects.ts does NOT initialize the spoke layout, skip this step (leave a comment noting launch.ts handles lazy creation).

- [ ] **Step 3: Build + smoke test**

Run: `npm run build && node dist/index.js launch --help`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/commands/launch.ts src/commands/projects.ts
git commit -m "refactor(launch,projects): use ensureSpokeLayout helper"
```

---

## Task 12: Migrate daily-logs.ts to take WorkspaceDriver

**Files:**
- Modify: `src/lib/daily-logs.ts`

- [ ] **Step 1: Replace the file**

Replace `src/lib/daily-logs.ts` with:

```typescript
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { resolveHome } from "../config.js";
import type { WorkspaceDriver } from "../workspaces/types.js";

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

export function enumerateDays(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    out.push(iso(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export interface DailyLog {
  content: string;
  blockers: string[];
}

export async function readDailyLog(
  workspace: WorkspaceDriver,
  dateStr: string,
): Promise<DailyLog | null> {
  const relPath = `daily-logs/${dateStr}.md`;
  if (!(await workspace.exists(relPath))) return null;

  const raw = await workspace.read(relPath);
  const { content } = matter(raw);

  const blockers: string[] = [];
  const blockerMatch = content.match(/## Blocked\n([\s\S]*?)(?=\n##|$)/);
  if (blockerMatch) {
    const lines = blockerMatch[1].trim().split("\n");
    for (const line of lines) {
      const trimmed = line.replace(/^[-*]\s*/, "").trim();
      if (trimmed && trimmed !== "(none)" && trimmed !== "None") {
        blockers.push(trimmed);
      }
    }
  }
  return { content, blockers };
}

export function parseSection(content: string, section: string): string[] {
  const match = content.match(new RegExp(`## ${section}\\n([\\s\\S]*?)(?=\\n##|$)`));
  if (!match) return [];
  return match[1]
    .trim()
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l && l !== "(none)" && l !== "None");
}

export function getGitCommits(projectPath: string, dateStr: string): string[] {
  return getGitCommitsInRange(projectPath, `${dateStr} 00:00:00`, `${dateStr} 23:59:59`);
}

export function getGitCommitsInRange(projectPath: string, since: string, until?: string): string[] {
  const resolved = resolveHome(projectPath);
  if (!fs.existsSync(path.join(resolved, ".git"))) return [];

  const untilArg = until ? ` --until="${until}"` : "";
  try {
    const output = execSync(
      `git -C "${resolved}" log --since="${since}"${untilArg} --oneline --no-merges 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (!output) return [];
    return output.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function getMergedPRsInRange(projectPath: string, since: string, until?: string): string[] {
  const resolved = resolveHome(projectPath);
  if (!fs.existsSync(path.join(resolved, ".git"))) return [];

  const untilArg = until ? ` --until="${until}"` : "";
  try {
    const output = execSync(
      `git -C "${resolved}" log --merges --since="${since}"${untilArg} --pretty=format:%s 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (!output) return [];
    return output.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
```

**Change summary:** `readDailyLog(spokeVault, dateStr)` → `readDailyLog(workspace, dateStr)` where `workspace: WorkspaceDriver`. Everything else unchanged.

- [ ] **Step 2: Write a test for the new signature**

Create `src/lib/__tests__/daily-logs.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readDailyLog, parseSection } from "../daily-logs.js";
import { createMemoryDriver } from "../../workspaces/__tests__/helpers/memory-driver.js";

describe("readDailyLog", () => {
  it("returns null when the daily log does not exist", async () => {
    const ws = createMemoryDriver();
    const log = await readDailyLog(ws, "2026-04-21");
    expect(log).toBeNull();
  });

  it("parses content and extracts blockers", async () => {
    const ws = createMemoryDriver({
      "daily-logs/2026-04-21.md": `---
date: 2026-04-21
---

## Completed
- shipped phase 1

## Blocked
- waiting on code review
- needs approval
`,
    });
    const log = await readDailyLog(ws, "2026-04-21");
    expect(log).not.toBeNull();
    expect(log!.blockers).toEqual(["waiting on code review", "needs approval"]);
  });

  it("returns empty blockers when Blocked section is (none)", async () => {
    const ws = createMemoryDriver({
      "daily-logs/2026-04-21.md": `## Blocked\n- (none)\n`,
    });
    const log = await readDailyLog(ws, "2026-04-21");
    expect(log!.blockers).toEqual([]);
  });
});

describe("parseSection", () => {
  it("extracts list items from a named section", () => {
    const content = `## Completed
- a
- b

## Other
- c`;
    expect(parseSection(content, "Completed")).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/lib/__tests__/daily-logs.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 4: Commit**

```bash
git add src/lib/daily-logs.ts src/lib/__tests__/
git commit -m "refactor(daily-logs): accept WorkspaceDriver instead of vault path"
```

---

## Task 13: Migrate standup.ts + retro.ts to use the registry

**Files:**
- Modify: `src/commands/standup.ts`
- Modify: `src/commands/retro.ts`

- [ ] **Step 1: Update standup.ts**

In `src/commands/standup.ts`:

Replace imports block:

```typescript
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import matter from "gray-matter";
import { loadConfig, resolveHome, type ProjectConfig } from "../config.js";
import { readDailyLog, getGitCommits, iso, daysAgo } from "../lib/daily-logs.js";
```

With:

```typescript
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import matter from "gray-matter";
import { loadConfig, resolveHome, type ProjectConfig } from "../config.js";
import { readDailyLog, getGitCommits, iso, daysAgo } from "../lib/daily-logs.js";
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";
```

In the `getProjectStandup` function, change the signature and body:

```typescript
async function getProjectStandup(
  name: string,
  project: ProjectConfig,
  dateStr: string,
  registry: WorkspaceRegistry,
  config: import("../config.js").CockpitConfig,
): Promise<ProjectStandup> {
  const spokeVault = resolveHome(project.spokeVault);
  const statusFile = path.join(spokeVault, "status.md");

  let status: StatusFrontmatter = {};
  if (fs.existsSync(statusFile)) {
    try {
      status = matter(fs.readFileSync(statusFile, "utf-8")).data as StatusFrontmatter;
    } catch { /* empty */ }
  }

  const workspace = registry.forProject(name, config);
  const log = await readDailyLog(workspace, dateStr);
  const gitCommits = getGitCommits(project.path, dateStr);

  return {
    name,
    status,
    dailyLog: log?.content ?? null,
    gitCommits,
    blockers: log?.blockers ?? [],
  };
}
```

In the action, make it async and instantiate the registry:

```typescript
.action(async (opts) => {
    const config = loadConfig();
    const projects = Object.entries(config.projects);
    const registry = new WorkspaceRegistry({ obsidian: createObsidianDriver });
    // ... existing guards ...
    const standups = await Promise.all(
      targets.map(([name, proj]) => getProjectStandup(name, proj, dateStr, registry, config)),
    );
    const output = formatStandup(standups, dateStr, raw);
    console.log(output);
  });
```

**Note:** `status.md` reading stays on `fs.readFileSync` temporarily — a full migration of status.md to the driver happens in Task 14 (status.ts). Keeping this transitional is fine because it doesn't block the standup refactor.

- [ ] **Step 2: Update retro.ts**

Apply the equivalent changes to `src/commands/retro.ts`: add imports, pass registry/config into helpers that call `readDailyLog`, await the async call.

Read retro.ts first to find the correct call-sites; the same pattern as standup applies.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 4: Full suite**

Run: `npm run test -- --run`
Expected: same baseline (2 pre-existing config.test.ts failures, rest green + 4 new daily-logs tests, + workspace tests all pass)

- [ ] **Step 5: Commit**

```bash
git add src/commands/standup.ts src/commands/retro.ts
git commit -m "refactor(standup,retro): use WorkspaceRegistry for daily logs"
```

---

## Task 14: Migrate status.ts

**Files:**
- Modify: `src/commands/status.ts`

- [ ] **Step 1: Replace the whole file**

Replace `src/commands/status.ts` with:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import matter from "gray-matter";
import { loadConfig } from "../config.js";
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";

interface StatusFrontmatter {
  project?: string;
  captain_session?: string;
  last_updated?: string;
  active_crew?: number;
  tasks_total?: number;
  tasks_completed?: number;
  tasks_in_progress?: number;
  tasks_pending?: number;
}

function timeAgo(dateStr: string | undefined): string {
  if (!dateStr) return chalk.dim("—");
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return chalk.dim("—");

  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function progressBar(completed: number, total: number): string {
  if (total === 0) return chalk.dim("no tasks");
  const pct = Math.round((completed / total) * 100);
  const filled = Math.round(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `${bar} ${pct}%`;
}

export const statusCommand = new Command("status")
  .description("Show status of all projects from spoke vault status files")
  .action(async () => {
    const config = loadConfig();
    const projects = Object.entries(config.projects);
    const registry = new WorkspaceRegistry({ obsidian: createObsidianDriver });

    if (projects.length === 0) {
      console.log(chalk.yellow("\nNo projects registered. Use: cockpit projects add <name> <path>\n"));
      return;
    }

    console.log(chalk.bold("\nProject Status\n"));
    console.log(
      chalk.dim(
        `  ${"PROJECT".padEnd(18)} ${"CAPTAIN".padEnd(12)} ${"CREW".padEnd(6)} ${"PROGRESS".padEnd(25)} LAST UPDATE`,
      ),
    );
    console.log(chalk.dim("  " + "─".repeat(85)));

    for (const [name, project] of projects) {
      const workspace = registry.forProject(name, config);

      if (!(await workspace.exists("status.md"))) {
        console.log(`  ${name.padEnd(18)} ${chalk.dim("no status.md")}`);
        continue;
      }

      let fm: StatusFrontmatter = {};
      try {
        const raw = await workspace.read("status.md");
        fm = matter(raw).data as StatusFrontmatter;
      } catch {
        console.log(`  ${name.padEnd(18)} ${chalk.red("error reading status.md")}`);
        continue;
      }

      const sessionIndicator =
        fm.captain_session === "active"
          ? chalk.green("●")
          : chalk.dim("○");
      const captainDisplay = `${project.captainName.padEnd(11)} ${sessionIndicator}`;
      const crew = String(fm.active_crew ?? 0).padEnd(6);
      const progress = progressBar(
        fm.tasks_completed ?? 0,
        fm.tasks_total ?? 0,
      ).padEnd(25);
      const updated = timeAgo(fm.last_updated);

      console.log(
        `  ${name.padEnd(18)} ${captainDisplay}  ${crew} ${progress} ${updated}`,
      );
    }

    console.log("");
  });
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/commands/status.ts
git commit -m "refactor(status): use WorkspaceDriver for status.md reads"
```

---

## Task 15: Migrate doctor.ts to probe workspace providers

**Files:**
- Modify: `src/commands/doctor.ts`

- [ ] **Step 1: Read the file first**

Run: `cat src/commands/doctor.ts`

Note the existing hub-vault check line: `results.push(check(\`Hub vault exists...\`, ...));`

- [ ] **Step 2: Add workspace probing**

At the top of `src/commands/doctor.ts`, add import:

```typescript
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";
```

Inside the action (which already loads `config`), after the runtime probe block add:

```typescript
// Probe workspace providers
const workspaces = new WorkspaceRegistry({ obsidian: createObsidianDriver });
const hubDriver = workspaces.hub(config);
const hubProbe = await hubDriver.probe();
results.push(check(
  `Workspace '${config.workspace ?? "obsidian"}' — hub reachable`,
  hubProbe.installed && hubProbe.rootExists,
));

for (const [name, proj] of Object.entries(config.projects)) {
  const spokeDriver = workspaces.forProject(name, config);
  const probe = await spokeDriver.probe();
  results.push(check(
    `Workspace — spoke '${name}' reachable`,
    probe.installed && probe.rootExists,
  ));
}
```

Keep the existing `Hub vault exists` check OR delete it if redundant. Delete the old `Hub vault exists` check since the new probe supersedes it.

- [ ] **Step 3: Build + run doctor**

Run: `npm run build && node dist/index.js doctor`
Expected: shows new "Workspace 'obsidian' — hub reachable" line; spoke checks for each project.

- [ ] **Step 4: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "refactor(doctor): probe workspace providers via WorkspaceRegistry"
```

---

## Task 16: Migrate bash scripts (reactor-cycle.sh + read-status.sh)

**Files:**
- Modify: `scripts/reactor-cycle.sh`
- Modify: `scripts/read-status.sh`

- [ ] **Step 1: Read the current scripts**

Run: `cat scripts/reactor-cycle.sh scripts/read-status.sh`

- [ ] **Step 2: Migrate every `cat "$SPOKE_VAULT/..."` to `cockpit workspace read`**

Pattern to replace:
```bash
cat "$HUB_VAULT/some/path.md"
```
With:
```bash
cockpit workspace read --hub "some/path.md"
```

And:
```bash
cat "$SPOKE_VAULT/some/path.md"
```
With:
```bash
cockpit workspace read "$PROJECT" "some/path.md"
```

Similarly for `[ -f "$SPOKE_VAULT/..." ]`:
```bash
if cockpit workspace exists "$PROJECT" "some/path.md"; then
```

- [ ] **Step 3: Syntax check both**

Run: `bash -n scripts/reactor-cycle.sh scripts/read-status.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/reactor-cycle.sh scripts/read-status.sh
git commit -m "refactor(scripts): migrate reactor-cycle and read-status to 'cockpit workspace'"
```

---

## Task 17: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add workspace CLI rows to Commands table**

After the existing `cockpit runtime list` row, insert:

```markdown
| `cockpit workspace read <project> <path>` | Read a scope-relative file from the project's spoke vault |
| `cockpit workspace list <project> <dir>` | List entries in a spoke vault directory |
| `cockpit workspace read --hub <path>` | Read from the hub vault |
```

- [ ] **Step 2: Add `workspace` fields to the Config JSON example**

Top-level, alongside `runtime`:

```json
"workspace": "obsidian",
```

Per-project in brove:

```json
"workspace": "obsidian"
```

- [ ] **Step 3: Add Architecture subsection**

After "Runtime Abstraction", add:

```markdown
### Workspace Abstraction

Vault storage (hub + per-project spokes) runs behind a pluggable **workspace driver** (currently only `obsidian`). Filesystem operations — `read`, `write`, `list`, `exists`, `mkdir` — go through the driver instead of `fs` directly. Each project may override the global default via its `workspace` field. Bash scripts call `cockpit workspace <op>` to read/write vault data without hardcoding paths. New backends (Notion, plain-md, S3) are added as driver files in `src/workspaces/` — see `docs/specs/2026-04-21-plugin-system-workspace-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document workspace config field and CLI subcommand"
```

---

## Task 18: Full-suite verification

**Files:** none — just run everything.

- [ ] **Step 1: Test suite**

Run: `npm run test -- --run`
Expected: all new tests pass (obsidian 10, registry 8, memory-driver 3, daily-logs 4 = 25 new); existing tests preserve baseline (2 pre-existing config.test.ts failures acceptable).

- [ ] **Step 2: Lint + build**

Run: `npm run lint && npm run build`
Expected: exits 0 on both.

- [ ] **Step 3: CLI smoke**

Run:
- `node dist/index.js workspace --help` — shows 5 subcommands
- `node dist/index.js workspace list --hub .` — lists hub vault entries
- `node dist/index.js doctor` — shows new Workspace checks

- [ ] **Step 4: No commit — verification only**

If anything fails, fix in place and commit as `fix(workspace): ...`.

---

## Self-Review Notes

- **Spec coverage:** Every section of the design spec (§1 Interface, §2 Registry + Config, §3 CLI, §4 Refactor Surface, §5 Testing, §6 Rollout) has implementing tasks. Rollout §6 is covered by the task order (Tasks 10-17).
- **Type consistency:** `WorkspaceDriver` methods (`probe`, `read`, `write`, `exists`, `list`, `mkdir`) are identical across types.ts, obsidian.ts, memory-driver.ts, and all migrated callers. `WorkspaceRegistry` methods (`hub`, `forProject`, `get`, `probeAll`) consistent.
- **Deferred scope** (per spec §Non-Goals): no additional providers beyond obsidian; no domain abstraction; no tracker/notifier; no external plugin loading; learnings/wiki bash scripts stay as-is.
- **Commit discipline:** 17 atomic commits across 18 tasks (Task 18 is verify-only unless fixes needed).
- **Status.md reads:** Task 14 migrates status.ts; standup.ts in Task 13 temporarily keeps raw fs reads for status.md to let the two migrations be atomic.
