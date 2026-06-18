# Projection Slot (V1) Implementation Plan

> **✅ Shipped** (PR #36, 2026-04-24). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `cockpit projection` — emit cockpit's canonical content (AGENTS.md + skills) to each supported agent's expected path (Cursor, Codex, Gemini CLI) so multi-agent dev on cockpit-managed projects actually works.

**Architecture:** New plugin slot mirroring runtime/workspace/tracker/notifier. Driver-per-target (ProjectionEmitter), global registry, CLI subcommand. Two-tier (user-level vs project-level). Shared files use marker-merge pattern (`<!-- cockpit:start --> ... <!-- cockpit:end -->`); dedicated files overwrite. Reads through the existing workspace driver.

**Tech Stack:** TypeScript, Node 22 (fs/promises, node:path, node:os), commander.js, chalk, vitest.

**Spec:** [`docs/specs/2026-04-24-plugin-system-projection-design.md`](./2026-04-24-plugin-system-projection-design.md)

**Branch:** `feature/projection-slot` (already created, spec committed)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/projection/types.ts` | `ProjectionSource`, `ProjectionDestination`, `ProjectionEmitter`, `ProjectionEmitResult`, `ProjectionEmitterFactory` |
| `src/projection/marker.ts` | `mergeWithMarkers(existing, generated)` — shared by all emitters |
| `src/projection/cursor.ts` | CursorEmitter — emits `.cursor/rules/*.mdc` with frontmatter |
| `src/projection/codex.ts` | CodexEmitter — emits `AGENTS.md` (user-level + project-level) |
| `src/projection/gemini.ts` | GeminiEmitter — emits `GEMINI.md` (user-level + project-level) |
| `src/projection/registry.ts` | `ProjectionRegistry` — lookup by target name, list registered |
| `src/projection/index.ts` | Barrel re-exports |
| `src/projection/__tests__/` | Per-component vitest specs |
| `src/projection/__tests__/helpers/memory-fs.ts` | In-memory fs for tests |
| `src/lib/canonical-source.ts` | `readUserLevelSource`, `readProjectLevelSource` (reads AGENTS.md + SKILL.md files) |
| `src/commands/projection.ts` | `cockpit projection emit|diff|list` CLI |
| `src/config.ts` | Add optional `projection?: { targets?: string[] }` to `CockpitConfig` |
| `src/commands/doctor.ts` | Probe projection destinations |
| `src/index.ts` / `src/cli.ts` (wherever subcommands are registered) | Wire `projectionCommand` |
| `README.md` | Add projection rows to commands table; note per-project usage |

---

## Task 1 (P1): Config + types + barrel scaffolding

**Files:**
- Modify: `src/config.ts`
- Create: `src/projection/types.ts`
- Create: `src/projection/index.ts`
- Test: `src/projection/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test for config field**

Append to `src/projection/__tests__/types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { CockpitConfig } from "../../config.js";
import type {
  ProjectionSource,
  ProjectionDestination,
  ProjectionEmitter,
  ProjectionEmitResult,
  ProjectionEmitterFactory,
} from "../types.js";

describe("projection types", () => {
  it("CockpitConfig accepts optional projection.targets", () => {
    const cfg: CockpitConfig = {
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
      projection: { targets: ["cursor", "codex"] },
    };
    expect(cfg.projection?.targets).toEqual(["cursor", "codex"]);
  });

  it("ProjectionSource requires instructions and skills", () => {
    const src: ProjectionSource = {
      instructions: "# Rules",
      skills: [{ name: "x", description: "d", content: "c" }],
    };
    expect(src.skills).toHaveLength(1);
  });

  it("ProjectionDestination distinguishes shared vs dedicated", () => {
    const dest: ProjectionDestination = {
      path: "/tmp/x.md",
      shared: true,
      format: "markdown",
    };
    expect(dest.shared).toBe(true);
  });

  it("ProjectionEmitter has name + destinations + emit", () => {
    const emitter: ProjectionEmitter = {
      name: "stub",
      destinations: () => [],
      emit: async () => ({ written: false, path: "", bytesWritten: 0 }),
    };
    expect(emitter.name).toBe("stub");
  });

  it("ProjectionEmitterFactory produces an emitter with zero args", () => {
    const factory: ProjectionEmitterFactory = () => ({
      name: "stub",
      destinations: () => [],
      emit: async () => ({ written: false, path: "", bytesWritten: 0 }),
    });
    expect(factory().name).toBe("stub");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/projection/__tests__/types.test.ts`
Expected: FAIL — module not found (`src/projection/types.js` doesn't exist).

- [ ] **Step 3: Create `src/projection/types.ts`**

```typescript
export interface ProjectionSource {
  instructions: string;
  skills: Array<{ name: string; description: string; content: string }>;
}

export interface ProjectionDestination {
  path: string;
  shared: boolean;
  format: "markdown" | "mdc";
}

export interface ProjectionEmitResult {
  written: boolean;
  path: string;
  bytesWritten: number;
  diff?: string;
}

export interface ProjectionEmitter {
  name: string;
  destinations(scope: "user" | "project", projectRoot?: string): ProjectionDestination[];
  emit(
    source: ProjectionSource,
    dest: ProjectionDestination,
    opts?: { dryRun?: boolean },
  ): Promise<ProjectionEmitResult>;
}

export type ProjectionEmitterFactory = () => ProjectionEmitter;
```

- [ ] **Step 4: Modify `src/config.ts` — add `projection` field to `CockpitConfig`**

Find the `CockpitConfig` interface declaration and add `projection?: { targets?: string[] }` to it (keep all existing fields untouched). Find the one spot in the file — don't add duplicates.

```typescript
// Inside CockpitConfig:
projection?: {
  targets?: string[];
};
```

- [ ] **Step 5: Create `src/projection/index.ts`**

```typescript
export type {
  ProjectionSource,
  ProjectionDestination,
  ProjectionEmitter,
  ProjectionEmitResult,
  ProjectionEmitterFactory,
} from "./types.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/projection/__tests__/types.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Verify nothing else regressed**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/projection/types.ts src/projection/index.ts src/projection/__tests__/types.test.ts src/config.ts
git commit -m "feat(projection): scaffold types, config field, barrel"
```

---

## Task 2 (P2): Marker-merge helper (TDD)

**Files:**
- Create: `src/projection/marker.ts`
- Test: `src/projection/__tests__/marker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/projection/__tests__/marker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mergeWithMarkers, MARKER_START, MARKER_END } from "../marker.js";

describe("mergeWithMarkers", () => {
  it("wraps generated content in markers when existing is null", () => {
    const out = mergeWithMarkers(null, "hello");
    expect(out).toBe(`${MARKER_START}\nhello\n${MARKER_END}\n`);
  });

  it("wraps generated content in markers when existing is empty string", () => {
    const out = mergeWithMarkers("", "hello");
    expect(out).toBe(`${MARKER_START}\nhello\n${MARKER_END}\n`);
  });

  it("appends marker block when existing has no markers", () => {
    const existing = "# User notes\n\nunrelated.\n";
    const out = mergeWithMarkers(existing, "generated");
    expect(out).toBe(`# User notes\n\nunrelated.\n\n${MARKER_START}\ngenerated\n${MARKER_END}\n`);
  });

  it("replaces content between markers while preserving surrounding text", () => {
    const existing =
      `# User notes\n\nbefore\n${MARKER_START}\nOLD GENERATED\n${MARKER_END}\nafter\n`;
    const out = mergeWithMarkers(existing, "NEW");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD GENERATED");
  });

  it("is idempotent — re-merging the same content produces identical output", () => {
    const existing = "preamble\n";
    const once = mergeWithMarkers(existing, "body");
    const twice = mergeWithMarkers(once, "body");
    expect(twice).toBe(once);
  });

  it("throws on start marker without end marker (corrupted)", () => {
    const bad = `prefix\n${MARKER_START}\nbody without end\n`;
    expect(() => mergeWithMarkers(bad, "x")).toThrow(/corrupted|end/i);
  });

  it("throws on end marker without start marker (corrupted)", () => {
    const bad = `prefix\nbody\n${MARKER_END}\n`;
    expect(() => mergeWithMarkers(bad, "x")).toThrow(/corrupted|start/i);
  });

  it("trims trailing whitespace in generated content", () => {
    const out = mergeWithMarkers(null, "hello\n\n\n");
    expect(out).toBe(`${MARKER_START}\nhello\n${MARKER_END}\n`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/projection/__tests__/marker.test.ts`
Expected: FAIL — `../marker.js` not found.

- [ ] **Step 3: Implement `src/projection/marker.ts`**

```typescript
export const MARKER_START = "<!-- cockpit:start -->";
export const MARKER_END = "<!-- cockpit:end -->";

export function mergeWithMarkers(existing: string | null, generated: string): string {
  const body = generated.replace(/\s+$/, "");
  const block = `${MARKER_START}\n${body}\n${MARKER_END}\n`;

  if (!existing) return block;

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx === -1 && endIdx === -1) {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${sep}${block}`;
  }

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `Corrupted cockpit markers — found only ${startIdx === -1 ? "end" : "start"} marker. ` +
      `Remove the stray marker or delete the file and re-run projection emit.`,
    );
  }

  if (endIdx < startIdx) {
    throw new Error(`Corrupted cockpit markers — end appears before start. Manual repair needed.`);
  }

  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + MARKER_END.length);
  const trimmedAfter = after.startsWith("\n") ? after.slice(1) : after;
  return `${before}${block}${trimmedAfter}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/projection/__tests__/marker.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/projection/marker.ts src/projection/__tests__/marker.test.ts
git commit -m "feat(projection): marker-merge helper with idempotency + corruption detection"
```

---

## Task 3 (P3): Canonical source reader (TDD)

**Files:**
- Create: `src/lib/canonical-source.ts`
- Test: `src/lib/__tests__/canonical-source.test.ts`

Assumption: the existing `WorkspaceDriver` interface has `read(path)` returning file contents, `list(path)` returning entries, and `exists(path)` returning boolean. If any of those are named differently, adapt the implementation to the actual driver — keep the public API of `readUserLevelSource` / `readProjectLevelSource` stable.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/canonical-source.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readUserLevelSource, readProjectLevelSource } from "../canonical-source.js";
import type { WorkspaceDriver } from "../../workspaces/types.js";

function memDriver(files: Record<string, string>): WorkspaceDriver {
  return {
    name: "memory",
    async probe() { return { installed: true, reachable: true }; },
    async read(p: string) {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    async write(p: string, c: string) { files[p] = c; },
    async exists(p: string) { return p in files; },
    async list(p: string) {
      const prefix = p.endsWith("/") ? p : p + "/";
      const entries = new Set<string>();
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          entries.add(rest.split("/")[0]);
        }
      }
      return Array.from(entries).map((name) => ({
        name,
        isDirectory: Object.keys(files).some((k) => k.startsWith(`${prefix}${name}/`)),
      }));
    },
    async mkdir() {},
  } as unknown as WorkspaceDriver;
}

describe("canonical-source", () => {
  it("readUserLevelSource inlines every plugin/skills/*/SKILL.md", async () => {
    const driver = memDriver({
      "plugin/skills/karpathy-principles/SKILL.md":
        "---\nname: karpathy-principles\ndescription: K desc\n---\n\nK body",
      "plugin/skills/captain-ops/SKILL.md":
        "---\nname: captain-ops\ndescription: C desc\n---\n\nC body",
    });
    const src = await readUserLevelSource(driver);
    expect(src.skills.map((s) => s.name).sort()).toEqual(["captain-ops", "karpathy-principles"]);
    const k = src.skills.find((s) => s.name === "karpathy-principles")!;
    expect(k.description).toBe("K desc");
    expect(k.content).toContain("K body");
  });

  it("readUserLevelSource does NOT include cockpit's own AGENTS.md", async () => {
    const driver = memDriver({
      "AGENTS.md": "# Cockpit-specific content\ngitnexus stuff",
      "plugin/skills/karpathy-principles/SKILL.md":
        "---\nname: karpathy-principles\ndescription: K\n---\n\nK body",
    });
    const src = await readUserLevelSource(driver);
    expect(src.instructions).toBe("");
    expect(src.skills.map((s) => s.name)).toEqual(["karpathy-principles"]);
  });

  it("readUserLevelSource returns empty skills when plugin/skills is missing", async () => {
    const driver = memDriver({});
    const src = await readUserLevelSource(driver);
    expect(src.skills).toEqual([]);
    expect(src.instructions).toBe("");
  });

  it("readProjectLevelSource returns null when AGENTS.md is absent", async () => {
    const driver = memDriver({});
    const src = await readProjectLevelSource(driver, "/brove");
    expect(src).toBeNull();
  });

  it("readProjectLevelSource reads AGENTS.md when present", async () => {
    const driver = memDriver({
      "/brove/AGENTS.md": "# Brove rules\nuse design tokens",
    });
    const src = await readProjectLevelSource(driver, "/brove");
    expect(src).not.toBeNull();
    expect(src!.instructions).toContain("Brove rules");
  });

  it("readProjectLevelSource inlines project-local plugin/skills if present", async () => {
    const driver = memDriver({
      "/brove/AGENTS.md": "# Brove",
      "/brove/plugin/skills/brove-style/SKILL.md":
        "---\nname: brove-style\ndescription: BS\n---\n\nBS body",
    });
    const src = await readProjectLevelSource(driver, "/brove");
    expect(src!.skills.map((s) => s.name)).toEqual(["brove-style"]);
  });

  it("skips SKILL.md files with missing frontmatter", async () => {
    const driver = memDriver({
      "plugin/skills/broken/SKILL.md": "no frontmatter here\njust body",
    });
    const src = await readUserLevelSource(driver);
    expect(src.skills).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/canonical-source.test.ts`
Expected: FAIL — `../canonical-source.js` not found.

- [ ] **Step 3: Implement `src/lib/canonical-source.ts`**

```typescript
import type { WorkspaceDriver } from "../workspaces/types.js";
import type { ProjectionSource } from "../projection/types.js";

interface SkillFrontmatter {
  name: string;
  description: string;
}

function parseSkill(raw: string): { frontmatter: SkillFrontmatter; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const [, fmBlock, body] = match;
  const fm: Partial<SkillFrontmatter> = {};
  for (const line of fmBlock.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) (fm as Record<string, string>)[kv[1]] = kv[2].trim();
  }
  if (!fm.name || !fm.description) return null;
  return { frontmatter: fm as SkillFrontmatter, body: body.trim() };
}

async function readSkills(driver: WorkspaceDriver, skillsDir: string) {
  if (!(await driver.exists(skillsDir))) return [];
  const entries = await driver.list(skillsDir);
  const skills = [] as ProjectionSource["skills"];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const skillPath = `${skillsDir}/${entry.name}/SKILL.md`;
    if (!(await driver.exists(skillPath))) continue;
    const raw = await driver.read(skillPath);
    const parsed = parseSkill(raw);
    if (!parsed) continue;
    skills.push({
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      content: parsed.body,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export async function readUserLevelSource(driver: WorkspaceDriver): Promise<ProjectionSource> {
  const skills = await readSkills(driver, "plugin/skills");
  return { instructions: "", skills };
}

export async function readProjectLevelSource(
  driver: WorkspaceDriver,
  projectRoot: string,
): Promise<ProjectionSource | null> {
  const agentsPath = `${projectRoot}/AGENTS.md`;
  if (!(await driver.exists(agentsPath))) return null;
  const instructions = await driver.read(agentsPath);
  const skills = await readSkills(driver, `${projectRoot}/plugin/skills`);
  return { instructions, skills };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/canonical-source.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/canonical-source.ts src/lib/__tests__/canonical-source.test.ts
git commit -m "feat(projection): canonical source reader for user + project tiers"
```

---

## Task 4 (P4): Cursor emitter (TDD)

**Files:**
- Create: `src/projection/cursor.ts`
- Test: `src/projection/__tests__/cursor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/projection/__tests__/cursor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCursorEmitter } from "../cursor.js";
import type { ProjectionSource } from "../types.js";

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }),
  writeFile: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", () => fsMock);

const source: ProjectionSource = {
  instructions: "# Project rules\nuse design tokens",
  skills: [
    { name: "karpathy-principles", description: "K", content: "1. Think\n2. Simplify" },
  ],
};

describe("CursorEmitter", () => {
  beforeEach(() => {
    fsMock.mkdir.mockReset().mockResolvedValue(undefined);
    fsMock.readFile.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    fsMock.writeFile.mockReset().mockResolvedValue(undefined);
  });

  it("has name 'cursor'", () => {
    expect(createCursorEmitter().name).toBe("cursor");
  });

  it("destinations(user) targets ~/.cursor/rules/cockpit-global.mdc as dedicated", () => {
    const dests = createCursorEmitter().destinations("user");
    expect(dests).toHaveLength(1);
    expect(dests[0].path).toMatch(/\.cursor\/rules\/cockpit-global\.mdc$/);
    expect(dests[0].shared).toBe(false);
    expect(dests[0].format).toBe("mdc");
  });

  it("destinations(project, root) targets {root}/.cursor/rules/cockpit.mdc as dedicated", () => {
    const dests = createCursorEmitter().destinations("project", "/brove");
    expect(dests).toHaveLength(1);
    expect(dests[0].path).toBe("/brove/.cursor/rules/cockpit.mdc");
    expect(dests[0].shared).toBe(false);
  });

  it("emit writes .mdc with frontmatter and inlined skill content", async () => {
    const emitter = createCursorEmitter();
    const [dest] = emitter.destinations("project", "/brove");
    const result = await emitter.emit(source, dest);

    expect(result.written).toBe(true);
    expect(fsMock.mkdir).toHaveBeenCalledWith("/brove/.cursor/rules", { recursive: true });
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written.startsWith("---\n")).toBe(true);
    expect(written).toContain("description:");
    expect(written).toContain("globs:");
    expect(written).toContain("alwaysApply: true");
    expect(written).toContain("Project rules");
    expect(written).toContain("karpathy-principles");
    expect(written).toContain("1. Think");
  });

  it("emit overwrites existing dedicated file without marker-merge", async () => {
    fsMock.readFile.mockResolvedValueOnce("STALE CONTENT");
    const emitter = createCursorEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).not.toContain("STALE CONTENT");
    expect(written).not.toContain("cockpit:start");
  });

  it("emit with dryRun returns diff and does not write", async () => {
    const emitter = createCursorEmitter();
    const [dest] = emitter.destinations("project", "/brove");
    const result = await emitter.emit(source, dest, { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.diff).toBeDefined();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("emit returns bytesWritten on write", async () => {
    const emitter = createCursorEmitter();
    const [dest] = emitter.destinations("user");
    const result = await emitter.emit(source, dest);
    expect(result.bytesWritten).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/projection/__tests__/cursor.test.ts`
Expected: FAIL — `../cursor.js` not found.

- [ ] **Step 3: Implement `src/projection/cursor.ts`**

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  ProjectionDestination,
  ProjectionEmitResult,
  ProjectionEmitter,
  ProjectionSource,
} from "./types.js";

function renderMdc(source: ProjectionSource): string {
  const skillSections = source.skills
    .map(
      (s) =>
        `## Skill: ${s.name}\n\n*${s.description}*\n\n${s.content}`,
    )
    .join("\n\n");

  const body = [source.instructions.trim(), skillSections]
    .filter((s) => s.length > 0)
    .join("\n\n");

  const frontmatter = [
    "---",
    "description: Cockpit-projected rules and skills",
    "globs: ['**/*']",
    "alwaysApply: true",
    "---",
    "",
  ].join("\n");

  return `${frontmatter}${body}\n`;
}

export function createCursorEmitter(): ProjectionEmitter {
  return {
    name: "cursor",

    destinations(scope, projectRoot) {
      if (scope === "user") {
        return [
          {
            path: path.join(os.homedir(), ".cursor/rules/cockpit-global.mdc"),
            shared: false,
            format: "mdc",
          },
        ];
      }
      if (!projectRoot) return [];
      return [
        {
          path: path.join(projectRoot, ".cursor/rules/cockpit.mdc"),
          shared: false,
          format: "mdc",
        },
      ];
    },

    async emit(source, dest, opts): Promise<ProjectionEmitResult> {
      const generated = renderMdc(source);
      const existing = await readExisting(dest.path);

      if (opts?.dryRun) {
        return {
          written: false,
          path: dest.path,
          bytesWritten: 0,
          diff: buildDiff(existing, generated),
        };
      }

      await mkdir(path.dirname(dest.path), { recursive: true });
      await writeFile(dest.path, generated, "utf-8");

      return {
        written: true,
        path: dest.path,
        bytesWritten: Buffer.byteLength(generated, "utf-8"),
      };
    },
  };
}

async function readExisting(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

function buildDiff(existing: string | null, generated: string): string {
  if (existing === null) return `NEW FILE\n---\n${generated}`;
  if (existing === generated) return "UNCHANGED";
  return `OVERWRITE\n--- old\n${existing}\n--- new\n${generated}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/projection/__tests__/cursor.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/projection/cursor.ts src/projection/__tests__/cursor.test.ts
git commit -m "feat(projection): cursor emitter — .cursor/rules/*.mdc with frontmatter"
```

---

## Task 5 (P5): Codex emitter (TDD)

**Files:**
- Create: `src/projection/codex.ts`
- Test: `src/projection/__tests__/codex.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/projection/__tests__/codex.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCodexEmitter } from "../codex.js";
import type { ProjectionSource } from "../types.js";
import { MARKER_START, MARKER_END } from "../marker.js";

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }),
  writeFile: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", () => fsMock);

const source: ProjectionSource = {
  instructions: "# Project rules",
  skills: [{ name: "karpathy-principles", description: "K", content: "body" }],
};

describe("CodexEmitter", () => {
  beforeEach(() => {
    fsMock.mkdir.mockReset().mockResolvedValue(undefined);
    fsMock.readFile.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    fsMock.writeFile.mockReset().mockResolvedValue(undefined);
  });

  it("has name 'codex'", () => {
    expect(createCodexEmitter().name).toBe("codex");
  });

  it("destinations(user) targets ~/.codex/AGENTS.md as shared", () => {
    const [dest] = createCodexEmitter().destinations("user");
    expect(dest.path).toMatch(/\.codex\/AGENTS\.md$/);
    expect(dest.shared).toBe(true);
    expect(dest.format).toBe("markdown");
  });

  it("destinations(project, root) targets {root}/AGENTS.md as shared", () => {
    const [dest] = createCodexEmitter().destinations("project", "/brove");
    expect(dest.path).toBe("/brove/AGENTS.md");
    expect(dest.shared).toBe(true);
  });

  it("emit wraps content in cockpit markers when file is new", async () => {
    const emitter = createCodexEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain(MARKER_START);
    expect(written).toContain(MARKER_END);
    expect(written).toContain("Project rules");
    expect(written).toContain("karpathy-principles");
  });

  it("emit preserves surrounding content when file exists", async () => {
    fsMock.readFile.mockResolvedValueOnce("# My personal notes\n\nhello\n");
    const emitter = createCodexEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain("My personal notes");
    expect(written).toContain(MARKER_START);
  });

  it("emit updates marker block without duplicating it", async () => {
    fsMock.readFile.mockResolvedValueOnce(
      `preamble\n${MARKER_START}\nOLD\n${MARKER_END}\nepilog\n`,
    );
    const emitter = createCodexEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain("preamble");
    expect(written).toContain("epilog");
    expect(written).not.toContain("OLD");
    const starts = (written.match(new RegExp(MARKER_START, "g")) ?? []).length;
    expect(starts).toBe(1);
  });

  it("emit with dryRun returns diff and does not write", async () => {
    const emitter = createCodexEmitter();
    const [dest] = emitter.destinations("project", "/brove");
    const result = await emitter.emit(source, dest, { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.diff).toBeDefined();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/projection/__tests__/codex.test.ts`
Expected: FAIL — `../codex.js` not found.

- [ ] **Step 3: Implement `src/projection/codex.ts`**

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mergeWithMarkers } from "./marker.js";
import type {
  ProjectionDestination,
  ProjectionEmitResult,
  ProjectionEmitter,
  ProjectionSource,
} from "./types.js";

function renderMarkdown(source: ProjectionSource): string {
  const skillSections = source.skills
    .map((s) => `## Skill: ${s.name}\n\n*${s.description}*\n\n${s.content}`)
    .join("\n\n");
  return [source.instructions.trim(), skillSections]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

async function readExisting(p: string): Promise<string | null> {
  try { return await readFile(p, "utf-8"); }
  catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

export function createCodexEmitter(): ProjectionEmitter {
  return {
    name: "codex",

    destinations(scope, projectRoot) {
      if (scope === "user") {
        return [{
          path: path.join(os.homedir(), ".codex/AGENTS.md"),
          shared: true,
          format: "markdown",
        }];
      }
      if (!projectRoot) return [];
      return [{
        path: path.join(projectRoot, "AGENTS.md"),
        shared: true,
        format: "markdown",
      }];
    },

    async emit(source, dest, opts): Promise<ProjectionEmitResult> {
      const body = renderMarkdown(source);
      const existing = await readExisting(dest.path);
      const generated = mergeWithMarkers(existing, body);

      if (opts?.dryRun) {
        return {
          written: false,
          path: dest.path,
          bytesWritten: 0,
          diff: existing === generated ? "UNCHANGED" : `MERGE\n--- old\n${existing ?? ""}\n--- new\n${generated}`,
        };
      }

      await mkdir(path.dirname(dest.path), { recursive: true });
      await writeFile(dest.path, generated, "utf-8");

      return {
        written: true,
        path: dest.path,
        bytesWritten: Buffer.byteLength(generated, "utf-8"),
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/projection/__tests__/codex.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/projection/codex.ts src/projection/__tests__/codex.test.ts
git commit -m "feat(projection): codex emitter — AGENTS.md via marker-merge"
```

---

## Task 6 (P6): Gemini emitter (TDD)

**Files:**
- Create: `src/projection/gemini.ts`
- Test: `src/projection/__tests__/gemini.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/projection/__tests__/gemini.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGeminiEmitter } from "../gemini.js";
import type { ProjectionSource } from "../types.js";
import { MARKER_START, MARKER_END } from "../marker.js";

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }),
  writeFile: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", () => fsMock);

const source: ProjectionSource = {
  instructions: "# Project rules",
  skills: [{ name: "karpathy-principles", description: "K", content: "body" }],
};

describe("GeminiEmitter", () => {
  beforeEach(() => {
    fsMock.mkdir.mockReset().mockResolvedValue(undefined);
    fsMock.readFile.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    fsMock.writeFile.mockReset().mockResolvedValue(undefined);
  });

  it("has name 'gemini'", () => {
    expect(createGeminiEmitter().name).toBe("gemini");
  });

  it("destinations(user) targets ~/.gemini/GEMINI.md as shared", () => {
    const [dest] = createGeminiEmitter().destinations("user");
    expect(dest.path).toMatch(/\.gemini\/GEMINI\.md$/);
    expect(dest.shared).toBe(true);
  });

  it("destinations(project, root) targets {root}/GEMINI.md as shared", () => {
    const [dest] = createGeminiEmitter().destinations("project", "/brove");
    expect(dest.path).toBe("/brove/GEMINI.md");
    expect(dest.shared).toBe(true);
  });

  it("emit wraps body in cockpit markers", async () => {
    const emitter = createGeminiEmitter();
    const [dest] = emitter.destinations("project", "/brove");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain(MARKER_START);
    expect(written).toContain(MARKER_END);
    expect(written).toContain("Project rules");
    expect(written).toContain("karpathy-principles");
  });

  it("emit preserves existing content outside markers", async () => {
    fsMock.readFile.mockResolvedValueOnce("# Gemini personal notes\n");
    const emitter = createGeminiEmitter();
    const [dest] = emitter.destinations("user");
    await emitter.emit(source, dest);
    const written = fsMock.writeFile.mock.calls[0][1] as string;
    expect(written).toContain("Gemini personal notes");
  });

  it("emit with dryRun returns diff and does not write", async () => {
    const emitter = createGeminiEmitter();
    const [dest] = emitter.destinations("user");
    const result = await emitter.emit(source, dest, { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.diff).toBeDefined();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/projection/__tests__/gemini.test.ts`
Expected: FAIL — `../gemini.js` not found.

- [ ] **Step 3: Implement `src/projection/gemini.ts`**

Implementation is structurally identical to `codex.ts` — only differences are the `name` field ("gemini") and the destination paths (`~/.gemini/GEMINI.md` user-level, `{root}/GEMINI.md` project-level).

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mergeWithMarkers } from "./marker.js";
import type {
  ProjectionDestination,
  ProjectionEmitResult,
  ProjectionEmitter,
  ProjectionSource,
} from "./types.js";

function renderMarkdown(source: ProjectionSource): string {
  const skillSections = source.skills
    .map((s) => `## Skill: ${s.name}\n\n*${s.description}*\n\n${s.content}`)
    .join("\n\n");
  return [source.instructions.trim(), skillSections]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

async function readExisting(p: string): Promise<string | null> {
  try { return await readFile(p, "utf-8"); }
  catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

export function createGeminiEmitter(): ProjectionEmitter {
  return {
    name: "gemini",

    destinations(scope, projectRoot) {
      if (scope === "user") {
        return [{
          path: path.join(os.homedir(), ".gemini/GEMINI.md"),
          shared: true,
          format: "markdown",
        }];
      }
      if (!projectRoot) return [];
      return [{
        path: path.join(projectRoot, "GEMINI.md"),
        shared: true,
        format: "markdown",
      }];
    },

    async emit(source, dest, opts): Promise<ProjectionEmitResult> {
      const body = renderMarkdown(source);
      const existing = await readExisting(dest.path);
      const generated = mergeWithMarkers(existing, body);

      if (opts?.dryRun) {
        return {
          written: false,
          path: dest.path,
          bytesWritten: 0,
          diff: existing === generated ? "UNCHANGED" : `MERGE\n--- old\n${existing ?? ""}\n--- new\n${generated}`,
        };
      }

      await mkdir(path.dirname(dest.path), { recursive: true });
      await writeFile(dest.path, generated, "utf-8");

      return {
        written: true,
        path: dest.path,
        bytesWritten: Buffer.byteLength(generated, "utf-8"),
      };
    },
  };
}
```

Follow-up reminder: if `renderMarkdown` and `readExisting` end up duplicated across codex + gemini, extract to `src/projection/shared-markdown.ts` in a later cleanup pass — but not this task, keep the change scoped.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/projection/__tests__/gemini.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/projection/gemini.ts src/projection/__tests__/gemini.test.ts
git commit -m "feat(projection): gemini emitter — GEMINI.md via marker-merge"
```

---

## Task 7 (P7): ProjectionRegistry + barrel (TDD)

**Files:**
- Create: `src/projection/registry.ts`
- Modify: `src/projection/index.ts`
- Test: `src/projection/__tests__/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/projection/__tests__/registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ProjectionRegistry } from "../registry.js";
import type { ProjectionEmitter } from "../types.js";

function stub(name: string): () => ProjectionEmitter {
  return () => ({
    name,
    destinations: () => [],
    emit: async () => ({ written: false, path: "", bytesWritten: 0 }),
  });
}

describe("ProjectionRegistry", () => {
  it("get returns the registered emitter by name", () => {
    const reg = new ProjectionRegistry({
      cursor: stub("cursor"),
      codex: stub("codex"),
    });
    expect(reg.get("cursor").name).toBe("cursor");
    expect(reg.get("codex").name).toBe("codex");
  });

  it("get throws on unknown name with helpful message", () => {
    const reg = new ProjectionRegistry({ cursor: stub("cursor") });
    expect(() => reg.get("slack")).toThrowError(/unknown projection target 'slack'/i);
  });

  it("list returns registered target names", () => {
    const reg = new ProjectionRegistry({
      cursor: stub("cursor"),
      codex: stub("codex"),
      gemini: stub("gemini"),
    });
    expect(reg.list().sort()).toEqual(["codex", "cursor", "gemini"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/projection/__tests__/registry.test.ts`
Expected: FAIL — `../registry.js` not found.

- [ ] **Step 3: Implement `src/projection/registry.ts`**

```typescript
import type { ProjectionEmitter, ProjectionEmitterFactory } from "./types.js";

export class ProjectionRegistry {
  constructor(private factories: Record<string, ProjectionEmitterFactory>) {}

  get(name: string): ProjectionEmitter {
    const factory = this.factories[name];
    if (!factory) {
      const available = Object.keys(this.factories).join(", ") || "(none)";
      throw new Error(
        `Unknown projection target '${name}'. Available: ${available}.`,
      );
    }
    return factory();
  }

  list(): string[] {
    return Object.keys(this.factories);
  }
}
```

- [ ] **Step 4: Update `src/projection/index.ts`**

Replace the file with:

```typescript
export { createCursorEmitter } from "./cursor.js";
export { createCodexEmitter } from "./codex.js";
export { createGeminiEmitter } from "./gemini.js";
export { ProjectionRegistry } from "./registry.js";
export { mergeWithMarkers, MARKER_START, MARKER_END } from "./marker.js";
export type {
  ProjectionSource,
  ProjectionDestination,
  ProjectionEmitter,
  ProjectionEmitResult,
  ProjectionEmitterFactory,
} from "./types.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/projection/__tests__/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/projection/registry.ts src/projection/index.ts src/projection/__tests__/registry.test.ts
git commit -m "feat(projection): registry with unknown-target error + barrel updates"
```

---

## Task 8 (P8): `cockpit projection` CLI subcommand

**Files:**
- Create: `src/commands/projection.ts`
- Modify: `src/index.ts` (or wherever subcommands are registered — check via `grep -n 'notifyCommand\|trackerCommand' src/`)
- Test: `src/commands/__tests__/projection.test.ts`

- [ ] **Step 1: Locate command registration point**

Run: `grep -rn "notifyCommand\|trackerCommand" src/ --include='*.ts' | grep -v __tests__`

Find the file that imports and `.addCommand(notifyCommand)` / `.addCommand(trackerCommand)` — that's the file to modify in Step 6.

- [ ] **Step 2: Write the failing tests**

Create `src/commands/__tests__/projection.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { projectionCommand } from "../projection.js";

const emitMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());

vi.mock("../../projection/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../projection/index.js")>(
    "../../projection/index.js",
  );
  return {
    ...actual,
    ProjectionRegistry: class {
      get = getMock;
      list = listMock;
    },
    createCursorEmitter: () => ({
      name: "cursor",
      destinations: () => [{ path: "/tmp/a.mdc", shared: false, format: "mdc" }],
      emit: emitMock,
    }),
    createCodexEmitter: () => ({
      name: "codex",
      destinations: () => [{ path: "/tmp/b.md", shared: true, format: "markdown" }],
      emit: emitMock,
    }),
    createGeminiEmitter: () => ({
      name: "gemini",
      destinations: () => [{ path: "/tmp/c.md", shared: true, format: "markdown" }],
      emit: emitMock,
    }),
  };
});

vi.mock("../../lib/canonical-source.js", () => ({
  readUserLevelSource: vi.fn(async () => ({ instructions: "", skills: [] })),
  readProjectLevelSource: vi.fn(async () => null),
}));

vi.mock("../../config.js", async () => ({
  loadConfig: () => ({
    commandName: "cmd",
    hubVault: "~/hub",
    projects: {
      brove: { path: "/tmp/brove", captainName: "b", spokeVault: "~/hub/brove", host: "local" },
    },
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: { command: "default", captain: "acceptEdits" },
    },
    metrics: { enabled: false, path: "" },
    projection: { targets: ["cursor", "codex", "gemini"] },
  }),
}));

describe("projectionCommand", () => {
  beforeEach(() => {
    emitMock.mockReset().mockResolvedValue({ written: true, path: "/tmp/x", bytesWritten: 10 });
    listMock.mockReset().mockReturnValue(["cursor", "codex", "gemini"]);
    getMock.mockReset();
  });

  it("is a commander Command named 'projection'", () => {
    expect(projectionCommand.name()).toBe("projection");
  });

  it("has subcommands emit, diff, list", () => {
    const names = projectionCommand.commands.map((c) => c.name());
    expect(names).toContain("emit");
    expect(names).toContain("diff");
    expect(names).toContain("list");
  });

  it("emit --target cursor --scope user calls cursor emitter for user scope", async () => {
    await projectionCommand.parseAsync(["node", "projection", "emit", "--target", "cursor", "--scope", "user"]);
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it("emit --project brove calls emitters for brove project scope", async () => {
    await projectionCommand.parseAsync(["node", "projection", "emit", "--project", "brove"]);
    expect(emitMock).toHaveBeenCalled();
  });

  it("emit --all runs user-level + every managed project", async () => {
    await projectionCommand.parseAsync(["node", "projection", "emit", "--all"]);
    // 3 emitters × (1 user-level + 1 brove project) = 6 emit calls (readProjectLevelSource returns null for brove
    // in the mock so project emission is skipped — but user-level still fires for each of 3 targets)
    expect(emitMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("diff --target cursor forwards dryRun:true to emit", async () => {
    await projectionCommand.parseAsync(["node", "projection", "diff", "--target", "cursor", "--scope", "user"]);
    const [, , opts] = emitMock.mock.calls[0];
    expect(opts?.dryRun).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/commands/__tests__/projection.test.ts`
Expected: FAIL — `../projection.js` not found.

- [ ] **Step 4: Implement `src/commands/projection.ts`**

```typescript
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import {
  createCursorEmitter,
  createCodexEmitter,
  createGeminiEmitter,
  ProjectionRegistry,
  type ProjectionEmitter,
  type ProjectionSource,
} from "../projection/index.js";
import { createObsidianWorkspace } from "../workspaces/index.js";
import {
  readUserLevelSource,
  readProjectLevelSource,
} from "../lib/canonical-source.js";

type Opts = {
  scope?: "user" | "project";
  project?: string;
  target?: string;
  all?: boolean;
};

function buildRegistry() {
  return new ProjectionRegistry({
    cursor: createCursorEmitter,
    codex: createCodexEmitter,
    gemini: createGeminiEmitter,
  });
}

function resolveTargets(cfg: ReturnType<typeof loadConfig>, opts: Opts): string[] {
  if (opts.target) return [opts.target];
  return cfg.projection?.targets ?? ["cursor", "codex", "gemini"];
}

async function runEmit(opts: Opts & { dryRun?: boolean }) {
  const cfg = loadConfig();
  const registry = buildRegistry();
  const workspace = createObsidianWorkspace({ root: process.cwd() });
  const targets = resolveTargets(cfg, opts);

  const emittedCount = { written: 0, skipped: 0 };

  async function emitForTarget(
    emitter: ProjectionEmitter,
    scope: "user" | "project",
    source: ProjectionSource,
    projectRoot?: string,
  ) {
    for (const dest of emitter.destinations(scope, projectRoot)) {
      const result = await emitter.emit(source, dest, { dryRun: opts.dryRun });
      if (opts.dryRun) {
        console.log(chalk.cyan(`[${emitter.name}] ${dest.path}`));
        console.log(result.diff ?? "(no diff)");
      } else if (result.written) {
        console.log(chalk.green(`✔ ${emitter.name} → ${dest.path} (${result.bytesWritten} bytes)`));
        emittedCount.written++;
      } else {
        console.log(chalk.gray(`- ${emitter.name} → ${dest.path} (skipped)`));
        emittedCount.skipped++;
      }
    }
  }

  const wantUser = opts.scope === "user" || opts.all || (!opts.project && !opts.scope);
  const wantProject = opts.scope === "project" || opts.all || !!opts.project;

  if (wantUser) {
    const source = await readUserLevelSource(workspace);
    for (const name of targets) {
      await emitForTarget(registry.get(name), "user", source);
    }
  }

  if (wantProject) {
    const projectNames = opts.project ? [opts.project] : Object.keys(cfg.projects);
    for (const projectName of projectNames) {
      const proj = cfg.projects[projectName];
      if (!proj) {
        console.error(chalk.yellow(`⚠ unknown project: ${projectName}`));
        continue;
      }
      const source = await readProjectLevelSource(workspace, proj.path);
      if (!source) {
        console.log(chalk.gray(`- ${projectName}: no AGENTS.md, skipping`));
        continue;
      }
      for (const name of targets) {
        await emitForTarget(registry.get(name), "project", source, proj.path);
      }
    }
  }

  if (!opts.dryRun) {
    console.log(
      chalk.bold(`\nProjection complete — ${emittedCount.written} written, ${emittedCount.skipped} skipped.`),
    );
  }
}

export const projectionCommand = new Command("projection")
  .description("Project cockpit instructions and skills to supported agent formats");

projectionCommand
  .command("emit")
  .description("Emit projections to disk")
  .option("--scope <scope>", "user or project", (v) => {
    if (v !== "user" && v !== "project") throw new Error("--scope must be 'user' or 'project'");
    return v;
  })
  .option("--project <name>", "managed project name")
  .option("--target <name>", "single target (cursor, codex, gemini)")
  .option("--all", "emit user-level + every managed project")
  .action(async (opts: Opts) => {
    try {
      await runEmit({ ...opts, dryRun: false });
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

projectionCommand
  .command("diff")
  .description("Preview changes without writing")
  .option("--scope <scope>", "user or project")
  .option("--project <name>", "managed project name")
  .option("--target <name>", "single target (cursor, codex, gemini)")
  .option("--all", "dry-run across user-level + every managed project")
  .action(async (opts: Opts) => {
    try {
      await runEmit({ ...opts, dryRun: true });
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

projectionCommand
  .command("list")
  .description("List registered projection targets")
  .action(() => {
    const registry = buildRegistry();
    for (const name of registry.list()) {
      const emitter = registry.get(name);
      const userDests = emitter.destinations("user").map((d) => d.path);
      const projectDests = emitter.destinations("project", "<project>").map((d) => d.path);
      console.log(chalk.bold(name));
      console.log(`  user:    ${userDests.join(", ") || "(none)"}`);
      console.log(`  project: ${projectDests.join(", ") || "(none)"}`);
    }
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/commands/__tests__/projection.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Register the command**

Edit the file located in Step 1 (whichever assembles `Command`s — often `src/index.ts` or `src/cli.ts`). Add the import alongside `notifyCommand` / `trackerCommand`:

```typescript
import { projectionCommand } from "./commands/projection.js";
```

And register it:

```typescript
program.addCommand(projectionCommand);
```

- [ ] **Step 7: Verify build + full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all green.

- [ ] **Step 8: Smoke-test against dry-run**

Run: `npm run build && node dist/cli.js projection list`
Expected: prints three targets (cursor, codex, gemini) with their destination paths.

Run: `node dist/cli.js projection diff --scope user --target cursor`
Expected: prints a diff for `~/.cursor/rules/cockpit-global.mdc` without writing.

- [ ] **Step 9: Commit**

```bash
git add src/commands/projection.ts src/commands/__tests__/projection.test.ts <index-file-from-step-1>
git commit -m "feat(projection): cockpit projection emit/diff/list CLI"
```

---

## Task 9 (P9): Doctor probe + README update

**Files:**
- Modify: `src/commands/doctor.ts`
- Modify: `README.md`

- [ ] **Step 1: Read current doctor.ts**

Run: `cat src/commands/doctor.ts | sed -n '1,80p'`

Find where the notifier probe is called (`probeAll()` on NotifierRegistry, or similar). The projection probe follows the same pattern.

- [ ] **Step 2: Add projection probe to doctor.ts**

After the notifier probe output, add:

```typescript
// Projection
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createCursorEmitter,
  createCodexEmitter,
  createGeminiEmitter,
  ProjectionRegistry,
} from "../projection/index.js";

const projectionRegistry = new ProjectionRegistry({
  cursor: createCursorEmitter,
  codex: createCodexEmitter,
  gemini: createGeminiEmitter,
});

console.log(chalk.bold("\nProjection"));
for (const name of projectionRegistry.list()) {
  const emitter = projectionRegistry.get(name);
  const [userDest] = emitter.destinations("user");
  if (!userDest) continue;
  const dir = dirname(userDest.path);
  let status: string;
  try {
    await stat(dir);
    status = chalk.green("✓ dir writable");
  } catch {
    status = chalk.yellow("! dir missing (will be created on emit)");
  }
  console.log(`  ${name.padEnd(10)} ${userDest.path} — ${status}`);
}
```

Keep the imports at the top with the rest of the existing imports — don't inline them. The code snippet above shows imports inline only for readability; consolidate in the actual file.

- [ ] **Step 3: Update README.md — commands table**

Find the commands table in `README.md` (search for `cockpit notify`) and add three rows immediately after it:

```markdown
| `cockpit projection emit [--scope user\|project] [--project <name>] [--target <name>] [--all]` | Emit cockpit rules + skills to Cursor/Codex/Gemini config files |
| `cockpit projection diff [same flags]` | Preview projection changes without writing |
| `cockpit projection list` | Show registered projection targets and their destinations |
```

- [ ] **Step 4: Update README.md — Architecture section**

Find the `### Notifier Abstraction` block and add a matching section after it:

```markdown
### Projection (Cross-Agent Config Sync)

Cockpit rules (Karpathy principles, captain-ops) and per-project AGENTS.md emit to each supported agent's canonical path via `cockpit projection emit`. User-level projection pushes cockpit's skills to `~/.cursor/rules/cockpit-global.mdc`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`. Project-level projection pushes a managed project's own `AGENTS.md` into `{project}/CLAUDE.md`, `{project}/.cursor/rules/cockpit.mdc`, `{project}/GEMINI.md` — zero cockpit-global content leaks into the project repo. Shared files use `<!-- cockpit:start --> ... <!-- cockpit:end -->` markers; dedicated files overwrite. See `docs/specs/2026-04-24-plugin-system-projection-design.md`.
```

- [ ] **Step 5: Update Supported Agents table statuses**

In `README.md`, update the Supported Agents table rows:

- `Cursor`: change "🚧 Driver only" → "✅ via `cockpit projection`"
- `Codex CLI`: change "🚧 Driver only" → "✅ via `cockpit projection`"
- `Gemini CLI`: change "🚧 Driver only" → "✅ via `cockpit projection`"

Leave `Aider` at "📋 Planned".

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build && node dist/cli.js doctor | grep -A 5 Projection`
Expected: projection section prints with three targets.

- [ ] **Step 7: Commit**

```bash
git add src/commands/doctor.ts README.md
git commit -m "feat(projection): doctor probe + README docs"
```

---

## Task 10 (P10): End-to-end verification + code review + PR

**Files:** No code changes — this task is verification + PR creation.

- [ ] **Step 1: Full test suite + typecheck + build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all three green.

- [ ] **Step 2: Dry-run against user's real environment**

Run: `node dist/cli.js projection diff --all`
Expected: prints diffs for every target × (user + each managed project with an AGENTS.md). No writes. No errors.

- [ ] **Step 3: Real emit — user-level only**

Run: `node dist/cli.js projection emit --scope user`
Expected: writes 3 files (`~/.cursor/rules/cockpit-global.mdc`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`). Prints success lines.

Verify with: `ls -la ~/.cursor/rules/cockpit-global.mdc ~/.codex/AGENTS.md ~/.gemini/GEMINI.md`
Expected: all three files exist with non-zero size.

- [ ] **Step 4: Real emit — one managed project**

If brove has an `AGENTS.md`: run `node dist/cli.js projection emit --project brove`.
Expected: writes `{brove.path}/CLAUDE.md`, `{brove.path}/.cursor/rules/cockpit.mdc`, `{brove.path}/GEMINI.md`.

If brove does NOT have an `AGENTS.md`: expected output is `- brove: no AGENTS.md, skipping` for each target.

- [ ] **Step 5: Idempotency check**

Run `projection emit --scope user` twice. After the second run, diff the outputs:

```bash
node dist/cli.js projection emit --scope user
md5 ~/.codex/AGENTS.md > /tmp/once.md5
node dist/cli.js projection emit --scope user
md5 ~/.codex/AGENTS.md > /tmp/twice.md5
diff /tmp/once.md5 /tmp/twice.md5
```

Expected: identical hashes — marker-merge is idempotent.

- [ ] **Step 6: Marker corruption handling**

Create a broken file: `printf '<!-- cockpit:start -->\nno end\n' > /tmp/corrupt-agents.md`.

Then manually invoke marker merge via a quick node REPL or by setting an emitter destination to the corrupt file. Expected: emit throws with a "corrupted markers" error and exits with a non-zero code.

Clean up: `rm /tmp/corrupt-agents.md`.

- [ ] **Step 7: Doctor still green**

Run: `node dist/cli.js doctor`
Expected: all sections green or with informational-only warnings.

- [ ] **Step 8: Code review**

Invoke the `superpowers:requesting-code-review` skill (or dispatch a review subagent). Review focus:
- Marker-merge correctness (the emitter most likely to have edge cases)
- No direct `fs` calls in emitters should bypass mocking in tests
- Handling of missing `~/.cursor/rules` / `~/.codex/` dirs (mkdir recursive must not fail on pre-existing)
- Destination path resolution uses `os.homedir()` (not a hardcoded path)

Apply any fixes surfaced; re-run Step 1.

- [ ] **Step 9: Update issue + open PR**

```bash
git push origin feature/projection-slot
gh pr create --base develop --title "feat: projection slot V1 — cross-agent config sync (#31)" --body "$(cat <<'EOF'
## Summary

Ships `cockpit projection` — emits cockpit's canonical content (skills at user level, AGENTS.md at project level) to each supported agent's expected path. Completes the multi-agent direction from 50c63b3 by fixing the "missing many things" experience when opening cockpit-managed projects in Cursor/Codex/Gemini CLI.

Closes #31. Follow-ups: #34 (MCP sync), #35 (role identity).

## What's in V1

- Two-tier projection: user-level (from `plugin/skills/*/SKILL.md`) vs project-level (from `{project}/AGENTS.md`)
- Three targets: Cursor (`.cursor/rules/*.mdc`), Codex (`AGENTS.md`), Gemini CLI (`GEMINI.md`)
- Marker-merge for shared files (`<!-- cockpit:start --> ... <!-- cockpit:end -->`), overwrite for dedicated files
- CLI: `emit`, `diff` (dry-run), `list`
- Doctor probe for destination writability
- README + Supported Agents table updated

## Test plan

- [x] All unit tests pass (marker, canonical-source, each emitter, registry, CLI)
- [x] `npx tsc --noEmit` green
- [x] Dry-run against real env: `projection diff --all`
- [x] Emit user-level, verify files at `~/.cursor/rules/`, `~/.codex/`, `~/.gemini/`
- [x] Emit project-level for a managed project with AGENTS.md
- [x] Idempotency: emit twice, files identical
- [x] Marker-corruption detection works
EOF
)"
```

- [ ] **Step 10: Mark #31 as ready for close after merge**

Comment on #31: "V1 shipping in PR <url>. Close after merge."

---

## Self-review checklist (complete before handoff)

- [x] Spec coverage — every section of the design spec maps to a task above (types, marker, canonical source, 3 emitters, registry, CLI, doctor, docs, verify)
- [x] Placeholder scan — no TBD/TODO; all code blocks are complete
- [x] Type consistency — `ProjectionEmitter.emit(source, dest, opts)` signature is identical across Tasks 4/5/6/7/8
- [x] Idempotency explicitly tested (marker test + Step 5 of final task)
- [x] Corruption detection explicitly tested (marker test + Step 6 of final task)
- [x] Every task produces a commit — 10 tasks, 10 commits minimum
- [x] Branch is already created and spec committed (feature/projection-slot @ 8eebb16)
