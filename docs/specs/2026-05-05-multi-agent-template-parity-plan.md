# Multi-Agent Template Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `captain.generic.md` and `crew.generic.md` actually usable for non-Claude agents (Codex / Gemini / Cursor) by:

1. **Auditing** both generic role templates to confirm zero Claude-specific tool references (`Skill`, `TaskCreate`, `TaskUpdate`, `Agent`, `TeamCreate`) — locked in by an automated test so regressions can't reintroduce them.
2. **Extending `cockpit projection`** so the user-scope projection includes the captain + crew role descriptions in the cockpit-marker block written to each agent's user-level config:
   - `~/.codex/AGENTS.md` (Codex)
   - `~/.gemini/GEMINI.md` (Gemini)
   - `~/.cursor/rules/cockpit-global.mdc` (Cursor)
3. **End-to-end verifying** the wiring with `cockpit projection emit --scope user` against a tmp `HOME` dir.
4. **Updating the README** so users know projection now ships role descriptions, not just skills.

**Architecture:** No new modules. The change is a surgical extension of `readUserLevelSource` in `src/lib/canonical-source.ts` — it gains a `pkgRoot` dep, reads `orchestrator/captain.generic.md` + `orchestrator/crew.generic.md`, and renders them as labeled sections in `ProjectionSource.instructions`. Every existing emitter (Codex / Gemini / Cursor) inherits the new content automatically, since they all consume `ProjectionSource.instructions` verbatim. No emitter code changes; no new flags.

**Tech Stack:** TypeScript, vitest (with `vi.hoisted` + `vi.mock`), Node 22, ES modules (imports end in `.js`).

**Spec:** `docs/specs/2026-05-05-cockpit-thin-redirect-design.md` decision section + non-goals (no role identity for non-Claude agents — that's deferred to #35; this plan only ships the role *descriptions*, not first-class role detection).
**Issue:** [#45](https://github.com/tu11aa/claude-cockpit/issues/45) under umbrella [#40](https://github.com/tu11aa/claude-cockpit/issues/40).
**Branch:** `feature/multi-agent-template-parity` off `develop`.

**Depends on:** #41 (merged — generic templates already use the split-pane spawn pattern), #42 (merged — slim Command + vault discipline), #43 / #44 (merged — auto-status + dashboard, unrelated but co-shipped in v0.3.0).

**Aider:** explicitly out of scope per umbrella spec non-goals (no `CONVENTIONS.md` projection target yet). The plan deliberately leaves the existing three projection targets unchanged in shape; only their *content* grows.

---

## File Structure

**Create:**
- `src/lib/__tests__/role-templates.test.ts` — guard test asserting `orchestrator/captain.generic.md` and `orchestrator/crew.generic.md` contain zero references to forbidden Claude-specific tool names.

**Modify:**
- `src/lib/canonical-source.ts` — extend `readUserLevelSource` to optionally accept a `pkgRoot` dep, read role templates from `<pkgRoot>/orchestrator/`, and render them as sections in `instructions`.
- `src/lib/__tests__/canonical-source.test.ts` — extend the in-memory driver tests to cover the new role-template reads.
- `src/commands/projection.ts` — pass the resolved `pkgRoot` through to `readUserLevelSource` so it can locate the role templates (mirrors `init.ts`'s `findPackageRoot()` pattern).
- `src/projection/__tests__/codex.test.ts`, `src/projection/__tests__/gemini.test.ts`, `src/projection/__tests__/cursor.test.ts` — append a test per emitter that confirms `instructions` containing role sections lands inside the cockpit-marker block.
- `README.md` — extend the existing **Multi-agent projection** paragraph and the commands table to document role descriptions being projected.

**No changes to:** `orchestrator/captain.generic.md`, `orchestrator/crew.generic.md` (audit only — they're already clean as of #41 and #42), `src/projection/codex.ts`, `src/projection/gemini.ts`, `src/projection/cursor.ts`, `src/projection/marker.ts`, `src/projection/registry.ts`, `src/projection/types.ts`, `.gitignore`, `.claude/`.

---

## Task 1: Lock the audit — guard test for forbidden tool names (TDD)

**Files:**
- Create: `src/lib/__tests__/role-templates.test.ts`

The audit can't be a one-shot manual scan; it has to be a regression test so a future drive-by edit can't reintroduce a Claude-only tool reference into the generic templates. The test reads the actual template files from disk (no mocks — these are repo-shipped artifacts) and asserts the forbidden patterns are absent.

The list of forbidden identifiers comes from issue #45: `Skill` (the tool, not the noun "skill"), `TaskCreate`, `TaskUpdate`, `Agent` (the tool), `TeamCreate`. We use word-boundary regexes so the noun "skill" inside e.g. `karpathy-principles/SKILL.md` reference doesn't trip the test, and so `cockpit:captain-ops` skill references survive.

The audit is **case-sensitive** and **CamelCase-only** because the forbidden set is the Claude tool registry's exported identifiers; lowercase use of "skill" or "agent" as English words is fine.

- [ ] **Step 1: Write failing test (file doesn't exist yet, no implementation needed because the templates are already clean — test should pass immediately, but we still TDD it: write the test, *expect it to pass on first run*, and verify by deliberately introducing a forbidden token in a scratch copy that we then revert.)**

Create `src/lib/__tests__/role-templates.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve repo root so the test runs from any cwd.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const ORCH_DIR = path.join(REPO_ROOT, "orchestrator");

// Forbidden Claude-only tool identifiers (CamelCase; whole-word match).
// Source: issue #45 scope checklist + design spec decision #2.
const FORBIDDEN: ReadonlyArray<string> = [
  "TaskCreate",
  "TaskUpdate",
  "TeamCreate",
];

// Words that are forbidden *only as standalone tool references*, not as
// English nouns. We match them as backticked-tool tokens (`Agent`, `Skill`)
// so prose like "the agent reads its instructions" or "skills directory" survives.
const FORBIDDEN_AS_TOOL_TOKEN: ReadonlyArray<string> = [
  "Agent",
  "Skill",
];

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(ORCH_DIR, name), "utf-8");
}

function findForbidden(body: string): string[] {
  const hits: string[] = [];
  for (const tok of FORBIDDEN) {
    const re = new RegExp(`\\b${tok}\\b`);
    if (re.test(body)) hits.push(tok);
  }
  for (const tok of FORBIDDEN_AS_TOOL_TOKEN) {
    // Match `Agent` or `Skill` as a tool token: backticked identifier.
    const re = new RegExp("`" + tok + "`");
    if (re.test(body)) hits.push("`" + tok + "`");
  }
  return hits;
}

describe("generic role templates — audit", () => {
  it("captain.generic.md exists and is non-empty", () => {
    const body = readTemplate("captain.generic.md");
    expect(body.length).toBeGreaterThan(100);
  });

  it("crew.generic.md exists and is non-empty", () => {
    const body = readTemplate("crew.generic.md");
    expect(body.length).toBeGreaterThan(50);
  });

  it("captain.generic.md contains zero Claude-specific tool references", () => {
    const body = readTemplate("captain.generic.md");
    expect(findForbidden(body)).toEqual([]);
  });

  it("crew.generic.md contains zero Claude-specific tool references", () => {
    const body = readTemplate("crew.generic.md");
    expect(findForbidden(body)).toEqual([]);
  });

  it("guard test catches a forbidden token if reintroduced (smoke)", () => {
    const fake = "If your task fails, call `TaskCreate` to escalate.";
    expect(findForbidden(fake)).toContain("TaskCreate");
  });

  it("captain.generic.md uses the cockpit crew spawn primitive", () => {
    const body = readTemplate("captain.generic.md");
    // Sanity check that #41's split-pane pattern is present, not the old TeamCreate flow.
    expect(body).toMatch(/cockpit crew spawn/);
  });
});
```

- [ ] **Step 2: Run the test to confirm it passes against the current templates**

Run: `npx vitest run src/lib/__tests__/role-templates.test.ts`
Expected: all 6 tests pass. (Templates were sanitized by #41 + #42 — this test locks that in.)

- [ ] **Step 3: Verify the guard works by introducing a fake violation**

Temporarily edit `orchestrator/captain.generic.md`, append a single line:

```
TODO: maybe call TaskCreate later
```

Run: `npx vitest run src/lib/__tests__/role-templates.test.ts`
Expected: the `captain.generic.md contains zero Claude-specific tool references` assertion **fails**, listing `TaskCreate`.

Revert with `git checkout orchestrator/captain.generic.md`. Re-run; all green again. (We're verifying the guard *would* catch a regression — this is the whole reason the test exists.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/__tests__/role-templates.test.ts
git commit -m "test(role-templates): audit-as-test for forbidden Claude-only tools (#45)"
```

---

## Task 2: Extend `readUserLevelSource` to inline role templates (TDD)

**Files:**
- Modify: `src/lib/canonical-source.ts`
- Modify: `src/lib/__tests__/canonical-source.test.ts`

`readUserLevelSource` currently returns `{ instructions: "", skills: [...] }`. We extend it to optionally take a `pkgRoot` (absolute path on disk where `orchestrator/captain.generic.md` and `orchestrator/crew.generic.md` live). When provided, the returned `instructions` becomes a labeled, two-section block:

```markdown
## Captain Role

<verbatim contents of captain.generic.md>

## Crew Role

<verbatim contents of crew.generic.md>
```

If `pkgRoot` is undefined OR a template is missing, the corresponding section is omitted (no error). This keeps the existing tests green and makes the new behaviour additive.

The reads are intentionally NOT routed through the `WorkspaceDriver`. The driver is the abstraction over the *user's vault* (read by the user, possibly via Obsidian); role templates are *cockpit's own source files*, conceptually closer to package assets than vault content. We use `fs.readFileSync` directly. (Tests inject `readFile` to keep them deterministic.)

- [ ] **Step 1: Extend tests in `src/lib/__tests__/canonical-source.test.ts`**

Open `src/lib/__tests__/canonical-source.test.ts` and append, *after* the existing `describe("canonical-source", ...)` block:

```typescript
describe("readUserLevelSource — role template inlining (#45)", () => {
  it("inlines captain.generic.md and crew.generic.md when pkgRoot is provided", async () => {
    const driver = memDriver({
      "plugin/skills/karpathy-principles/SKILL.md":
        "---\nname: karpathy-principles\ndescription: K\n---\n\nK body",
    });
    const reads: string[] = [];
    const readFile = (p: string): string => {
      reads.push(p);
      if (p.endsWith("captain.generic.md")) return "# Captain — Generic Agent\n\nrules...";
      if (p.endsWith("crew.generic.md"))    return "# Crew Member — Generic Agent\n\nrules...";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });

    expect(src.instructions).toContain("## Captain Role");
    expect(src.instructions).toContain("Captain — Generic Agent");
    expect(src.instructions).toContain("## Crew Role");
    expect(src.instructions).toContain("Crew Member — Generic Agent");
    // Skills still come through as before
    expect(src.skills.map((s) => s.name)).toEqual(["karpathy-principles"]);
    // Reads happen at the right paths
    expect(reads).toContain("/pkg/orchestrator/captain.generic.md");
    expect(reads).toContain("/pkg/orchestrator/crew.generic.md");
  });

  it("emits role sections in fixed order: captain then crew", async () => {
    const driver = memDriver({});
    const readFile = (p: string): string => {
      if (p.endsWith("captain.generic.md")) return "CAP";
      if (p.endsWith("crew.generic.md"))    return "CRW";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });
    const capIdx = src.instructions.indexOf("## Captain Role");
    const crwIdx = src.instructions.indexOf("## Crew Role");
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(crwIdx).toBeGreaterThan(capIdx);
  });

  it("returns instructions='' when pkgRoot is omitted (back-compat)", async () => {
    const driver = memDriver({
      "plugin/skills/karpathy-principles/SKILL.md":
        "---\nname: karpathy-principles\ndescription: K\n---\n\nK body",
    });
    const src = await readUserLevelSource(driver);
    expect(src.instructions).toBe("");
    expect(src.skills.map((s) => s.name)).toEqual(["karpathy-principles"]);
  });

  it("omits a role section when its template is missing on disk", async () => {
    const driver = memDriver({});
    const readFile = (p: string): string => {
      if (p.endsWith("captain.generic.md")) return "CAP only";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); // crew missing
    };
    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });
    expect(src.instructions).toContain("## Captain Role");
    expect(src.instructions).not.toContain("## Crew Role");
  });

  it("returns instructions='' when both templates are missing", async () => {
    const driver = memDriver({});
    const readFile = (): string => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });
    expect(src.instructions).toBe("");
  });

  it("trims trailing whitespace inside each role section", async () => {
    const driver = memDriver({});
    const readFile = (p: string): string => {
      if (p.endsWith("captain.generic.md")) return "captain body\n\n\n";
      if (p.endsWith("crew.generic.md"))    return "crew body\n";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });
    expect(src.instructions).not.toMatch(/\n{4,}/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/canonical-source.test.ts`
Expected: the new `describe("readUserLevelSource — role template inlining (#45)", ...)` block fails — the existing single-arg signature can't accept `{ pkgRoot, readFile }`. Existing tests still pass.

- [ ] **Step 3: Update `src/lib/canonical-source.ts`**

Apply this surgical edit. The existing `readSkills`, `parseSkill`, and `readProjectLevelSource` are untouched.

```typescript
import fs from "node:fs";
import path from "node:path";
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

async function readSkills(
  driver: WorkspaceDriver,
  skillsDir: string,
): Promise<ProjectionSource["skills"]> {
  if (!(await driver.exists(skillsDir))) return [];
  const names = await driver.list(skillsDir);
  const skills: ProjectionSource["skills"] = [];
  for (const name of names) {
    const skillPath = `${skillsDir}/${name}/SKILL.md`;
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

export interface UserSourceOptions {
  /**
   * Absolute path of the cockpit package root (the dir containing
   * `orchestrator/captain.generic.md` and `orchestrator/crew.generic.md`).
   * When provided, `readUserLevelSource` inlines the role templates into
   * `ProjectionSource.instructions` so non-Claude agents see them via
   * `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, and the cursor-global rules
   * file (#45).
   *
   * When omitted, instructions stay empty (preserving the pre-#45 contract).
   */
  pkgRoot?: string;
  /** Test seam — defaults to `fs.readFileSync(p, "utf-8")`. */
  readFile?: (p: string) => string;
}

const ROLE_TEMPLATES: ReadonlyArray<{ file: string; heading: string }> = [
  { file: "captain.generic.md", heading: "## Captain Role" },
  { file: "crew.generic.md",    heading: "## Crew Role" },
];

function readRoleTemplates(opts: UserSourceOptions): string {
  if (!opts.pkgRoot) return "";
  const reader = opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const sections: string[] = [];
  for (const { file, heading } of ROLE_TEMPLATES) {
    const full = path.join(opts.pkgRoot, "orchestrator", file);
    let body = "";
    try { body = reader(full); } catch { continue; } // ENOENT → skip section
    sections.push(`${heading}\n\n${body.trim()}`);
  }
  return sections.join("\n\n");
}

export async function readUserLevelSource(
  driver: WorkspaceDriver,
  opts: UserSourceOptions = {},
): Promise<ProjectionSource> {
  const skills = await readSkills(driver, "plugin/skills");
  const instructions = readRoleTemplates(opts);
  return { instructions, skills };
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/canonical-source.test.ts`
Expected: all tests pass — both the original block (back-compat: no opts → empty instructions) and the new role-template block.

- [ ] **Step 5: Commit**

```bash
git add src/lib/canonical-source.ts src/lib/__tests__/canonical-source.test.ts
git commit -m "feat(canonical-source): inline captain/crew generic templates into user-scope projection (#45)"
```

---

## Task 3: Wire `pkgRoot` through `cockpit projection` (TDD)

**Files:**
- Modify: `src/commands/projection.ts`
- Modify: `src/commands/__tests__/projection.test.ts`

`projection.ts` currently calls `readUserLevelSource(workspace)` with a single arg. We extend it to pass `{ pkgRoot }`, where `pkgRoot` is resolved the same way `init.ts` does it (`findPackageRoot()` walking up from `import.meta.url` until it hits a `package.json`). To keep the helper DRY, we extract `findPackageRoot` into `src/lib/canonical-source.ts` (next to its single new consumer here — `init.ts` will import it later if we choose to consolidate, but that's not needed for this issue).

To minimize blast radius, we **don't** move `findPackageRoot` out of `init.ts`. We duplicate the tiny helper inside `projection.ts` (it's six lines and the existing canonical-source already has plenty going on). A future janitorial PR can dedupe.

- [ ] **Step 1: Extend the projection command tests**

Open `src/commands/__tests__/projection.test.ts`. Update the `vi.mock("../../lib/canonical-source.js", ...)` block so the mock can capture the call args:

```typescript
const readUserLevelSourceMock = vi.hoisted(() => vi.fn(async () => ({ instructions: "", skills: [] })));
vi.mock("../../lib/canonical-source.js", () => ({
  readUserLevelSource: readUserLevelSourceMock,
  readProjectLevelSource: vi.fn(async () => null),
}));
```

(Replace the existing mock block. The existing tests don't read this mock's call args, so they'll still pass.)

Then append a new test inside the `describe("projectionCommand", ...)` block:

```typescript
it("emit --scope user passes pkgRoot to readUserLevelSource (#45)", async () => {
  readUserLevelSourceMock.mockClear();
  await projectionCommand.parseAsync(["node", "projection", "emit", "--target", "cursor", "--scope", "user"]);
  expect(readUserLevelSourceMock).toHaveBeenCalledTimes(1);
  const [, opts] = readUserLevelSourceMock.mock.calls[0];
  expect(opts).toBeDefined();
  expect(typeof opts.pkgRoot).toBe("string");
  // pkgRoot is the cockpit package root — guaranteed non-empty when running from the repo.
  expect(opts.pkgRoot.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands/__tests__/projection.test.ts`
Expected: the new test fails — `readUserLevelSource` is currently called with one argument.

- [ ] **Step 3: Modify `src/commands/projection.ts`**

Add the local helper (mirrors `init.ts`'s `findPackageRoot`):

```typescript
import { fileURLToPath } from "node:url";
import fs from "node:fs";

function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== "/" && dir !== "") {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
```

(Note: import `path` is already in scope through transitive imports; if not, add `import path from "node:path";`. Verify by running the build after editing.)

Then update the user-scope branch:

```typescript
  if (wantUser) {
    const source = await readUserLevelSource(workspace, { pkgRoot: findPackageRoot() });
    for (const name of targets) {
      await emitForTarget(registry.get(name), "user", source);
    }
  }
```

(Only the one line changes — the new options arg.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/commands/__tests__/projection.test.ts`
Expected: all tests pass, including the new `emit --scope user passes pkgRoot` assertion.

- [ ] **Step 5: Commit**

```bash
git add src/commands/projection.ts src/commands/__tests__/projection.test.ts
git commit -m "feat(projection): wire pkgRoot through to readUserLevelSource for role inlining (#45)"
```

---

## Task 4: Lock end-to-end behaviour through each emitter (TDD)

**Files:**
- Modify: `src/projection/__tests__/codex.test.ts`
- Modify: `src/projection/__tests__/gemini.test.ts`
- Modify: `src/projection/__tests__/cursor.test.ts`

The unit tests so far prove that `instructions` carries role content; the emitter tests prove the emitters render `instructions` verbatim. Adding one assertion per emitter — that role-section content survives the emitter → marker block → file write round-trip — closes the loop.

We're not changing the emitter implementations; we're locking their already-correct behaviour against future regressions.

- [ ] **Step 1: Append a role-content assertion to `src/projection/__tests__/codex.test.ts`**

Inside the `describe("CodexEmitter", ...)` block, after the `emit with dryRun` test:

```typescript
it("emit writes role-template sections inside the cockpit marker block (#45)", async () => {
  const roleSource: ProjectionSource = {
    instructions: "## Captain Role\n\nC body\n\n## Crew Role\n\nW body",
    skills: [],
  };
  const emitter = createCodexEmitter();
  const [dest] = emitter.destinations("user");
  await emitter.emit(roleSource, dest);
  const written = fsMock.writeFile.mock.calls[0][1] as string;
  // Marker block contains both role sections, in order.
  expect(written).toContain(MARKER_START);
  expect(written).toContain("## Captain Role");
  expect(written).toContain("## Crew Role");
  expect(written.indexOf("## Captain Role")).toBeLessThan(written.indexOf("## Crew Role"));
  expect(written).toContain(MARKER_END);
});
```

- [ ] **Step 2: Append the same shape of assertion to `gemini.test.ts`**

In `src/projection/__tests__/gemini.test.ts`, find the `describe("GeminiEmitter", ...)` block. Add the equivalent test (rename `createCodexEmitter` → `createGeminiEmitter`, the assertion body is identical).

- [ ] **Step 3: Append the same shape of assertion to `cursor.test.ts`**

For Cursor the marker block is **not** used — cursor.ts overwrites the entire `.mdc` file. The assertion shape changes:

```typescript
it("emit writes role-template sections inside the .mdc body (#45)", async () => {
  const roleSource: ProjectionSource = {
    instructions: "## Captain Role\n\nC body\n\n## Crew Role\n\nW body",
    skills: [],
  };
  const emitter = createCursorEmitter();
  const [dest] = emitter.destinations("user");
  await emitter.emit(roleSource, dest);
  const written = fsMock.writeFile.mock.calls[0][1] as string;
  // Frontmatter at top, then the body
  expect(written).toMatch(/^---\n[\s\S]*?\n---\n/);
  expect(written).toContain("## Captain Role");
  expect(written).toContain("## Crew Role");
  expect(written.indexOf("## Captain Role")).toBeLessThan(written.indexOf("## Crew Role"));
});
```

(Inspect the file before editing — if cursor.test.ts uses a different `fsMock` shape, adapt the mock-call indexing accordingly.)

- [ ] **Step 4: Run all three suites**

Run: `npx vitest run src/projection/__tests__/codex.test.ts src/projection/__tests__/gemini.test.ts src/projection/__tests__/cursor.test.ts`
Expected: all tests pass on first run. (Implementation already does the right thing — these are regression-locking tests.)

- [ ] **Step 5: Commit**

```bash
git add src/projection/__tests__/codex.test.ts src/projection/__tests__/gemini.test.ts src/projection/__tests__/cursor.test.ts
git commit -m "test(projection): lock role-section round-trip through each emitter (#45)"
```

---

## Task 5: End-to-end smoke test against a tmp HOME

**Files:** No source changes; this is a hand-run verification step that the issue's success criterion ("test by running `cockpit projection emit --scope user` against a tmp dir and verifying outputs") explicitly calls for.

The cockpit projection emitters use `os.homedir()` to compute user-scope destinations. Override `HOME` to redirect them into a sandbox.

- [ ] **Step 1: Build cockpit**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 2: Run projection emit against a tmp HOME**

```bash
TMP_HOME="$(mktemp -d -t cockpit-projection-XXXXXX)"
mkdir -p "$TMP_HOME"
HOME="$TMP_HOME" node dist/index.js projection emit --scope user
```

Expected output: three `✔ <target> → /…/.codex/AGENTS.md (…)` / `… .gemini/GEMINI.md` / `… .cursor/rules/cockpit-global.mdc` lines, then `Projection complete — 3 written, 0 skipped.`

- [ ] **Step 3: Verify each emitted file contains both role sections**

```bash
for f in "$TMP_HOME/.codex/AGENTS.md" "$TMP_HOME/.gemini/GEMINI.md" "$TMP_HOME/.cursor/rules/cockpit-global.mdc"; do
  echo "=== $f ==="
  grep -c "## Captain Role" "$f"   # expect: 1
  grep -c "## Crew Role"   "$f"   # expect: 1
  grep -c "cockpit crew spawn" "$f"   # expect: ≥1 (proves captain.generic.md body was inlined)
  grep -c "git worktree" "$f"      # expect: ≥1 (proves crew.generic.md body was inlined)
done
```

Each `grep -c` should print `1` (or higher for the body checks). Any `0` means the role wasn't projected.

- [ ] **Step 4: Verify diff command works the same way**

```bash
HOME="$TMP_HOME" node dist/index.js projection diff --scope user --target codex
```

Expected: no file is written; stdout shows a `MERGE` or `UNCHANGED` diff for `…/.codex/AGENTS.md`. If we re-emit immediately, the diff says `UNCHANGED` (idempotent).

- [ ] **Step 5: Cleanup**

```bash
rm -rf "$TMP_HOME"
```

- [ ] **Step 6: Optional — record the smoke test as a bash script for future verification**

(Skipped — the steps are short enough to copy-paste; adding a script would be drive-by per Karpathy principles.)

No commit for this task — it's verification only.

---

## Task 6: README — document role-template projection

**Files:**
- Modify: `README.md`

The existing **Multi-agent projection** paragraph (around line 133) already says "Cockpit rules (Karpathy principles, captain-ops) and per-project AGENTS.md emit to each supported agent's canonical path…". It needs a small extension to mention that *role descriptions* (captain + crew generic templates) now ride along too, so a Codex / Gemini / Cursor user gets a working captain-and-crew workflow without manually copying templates.

- [ ] **Step 1: Extend the projection paragraph**

In `README.md`, locate the line beginning:

```
Cockpit rules (Karpathy principles, captain-ops) and per-project AGENTS.md emit to each supported agent's canonical path via `cockpit projection emit`.
```

Append (in the same paragraph, after the existing sentence about user-level pushing skills to `~/.cursor/rules/cockpit-global.mdc`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`):

```
The user-level projection now also inlines `orchestrator/captain.generic.md` and `orchestrator/crew.generic.md` as `## Captain Role` / `## Crew Role` sections inside the cockpit marker block, so non-Claude agents (Codex, Gemini, Cursor) load the same role descriptions Claude Code loads via `--append-system-prompt-file`. See `docs/specs/2026-05-05-multi-agent-template-parity-plan.md` (#45).
```

- [ ] **Step 2: Refresh the multi-agent support table**

In `README.md`, locate the rows added by #16 / #36 (around lines 205–207):

```
| Codex CLI | ✅ via cockpit projection | Runtime driver (feature branch); instructions via `AGENTS.md` needed |
| Cursor    | ✅ via cockpit projection | Runtime driver; rules via `.cursor/rules/*.mdc` via [#31](https://github.com/tu11aa/claude-cockpit/issues/31) |
| Gemini CLI| ✅ via cockpit projection | Runtime driver; instructions via `GEMINI.md` |
```

Update the third column for each so it reflects post-#45 reality. Suggested copy:

```
| Codex CLI | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.codex/AGENTS.md` (#45). Live captain runtime is #35. |
| Cursor    | ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.cursor/rules/cockpit-global.mdc` (#45). |
| Gemini CLI| ✅ projection (skills + roles) | Captain/crew roles inlined into `~/.gemini/GEMINI.md` (#45). |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document captain/crew role projection for non-Claude agents (#45)"
```

---

## Task 7: Full-suite verification + PR

- [ ] **Step 1: Build clean**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass except the 2 pre-existing emoji-related `commandName` failures in `src/config.test.ts` (unrelated to #45 — present on `develop`). The new role-template guard test, the extended canonical-source tests, the projection command test, and the three emitter tests all pass.

- [ ] **Step 3: Lint check (if configured)**

Run: `npx tsc --noEmit`
Expected: no type errors. (`UserSourceOptions` is exported and `readUserLevelSource`'s second arg is optional, preserving back-compat for any callers we missed.)

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feature/multi-agent-template-parity
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base develop --title "Multi-agent template parity — captain/crew generic projected to non-Claude agents (#45)" --body "$(cat <<'EOF'
Closes #45 (final sub-issue under umbrella #40).

## Summary

Make `captain.generic.md` and `crew.generic.md` actually usable for non-Claude agents (Codex / Gemini / Cursor):

1. **Audit-as-test** — `src/lib/__tests__/role-templates.test.ts` asserts the generic templates contain zero references to forbidden Claude-specific tool tokens (`TaskCreate`, `TaskUpdate`, `TeamCreate`, backticked ``Agent`` / ``Skill``). Locks the cleanup work done by #41 / #42 against regressions.
2. **Projection extension** — `readUserLevelSource(driver, { pkgRoot })` now inlines `orchestrator/captain.generic.md` and `orchestrator/crew.generic.md` as `## Captain Role` / `## Crew Role` sections inside `ProjectionSource.instructions`. The Codex, Gemini, and Cursor emitters (unchanged) pick this up and write the role descriptions into `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, and `~/.cursor/rules/cockpit-global.mdc`.
3. **CLI wiring** — `cockpit projection emit --scope user` now resolves `pkgRoot` via `findPackageRoot()` and passes it through. Project-scope projection is unchanged (project AGENTS.md ≠ cockpit's role descriptions).
4. **Round-trip locks** — one new assertion per emitter (codex / gemini / cursor) confirms role sections survive into the emitted file in fixed Captain → Crew order.
5. **README** — multi-agent projection paragraph and support-table rows updated to reflect that roles now ride along with skills.

## What's new

- `src/lib/__tests__/role-templates.test.ts` — guard test for forbidden Claude-only tool tokens.
- `src/lib/canonical-source.ts` — new `UserSourceOptions { pkgRoot?, readFile? }`; new `readRoleTemplates` helper; existing `readSkills` / `readProjectLevelSource` untouched.
- `src/lib/__tests__/canonical-source.test.ts` — six new tests covering pkgRoot wiring, ordering, missing-file fall-through, back-compat.
- `src/commands/projection.ts` — local `findPackageRoot()` helper; one-line change passing `{ pkgRoot }` to `readUserLevelSource`.
- `src/commands/__tests__/projection.test.ts` — capturing mock for canonical-source so the `pkgRoot` arg is asserted.
- `src/projection/__tests__/{codex,gemini,cursor}.test.ts` — one new round-trip assertion per emitter.
- `README.md` — projection paragraph + multi-agent support table rows.

## Non-goals

- **No changes to the role templates themselves** — `captain.generic.md` and `crew.generic.md` are already clean (per #41 / #42); this PR only locks them in.
- **No first-class role identity** for non-Claude agents (deferred to #35).
- **No Aider projection target** — Aider's `CONVENTIONS.md` is explicitly out of scope per umbrella spec.
- **No new emitter logic** — the existing three emitters render `ProjectionSource.instructions` verbatim; we just feed them more.
- **No project-scope role inlining** — project AGENTS.md is the project's own content, not cockpit's role library.

## Test plan

- [x] `role-templates.test.ts` — 6 audit assertions (case-sensitive forbidden tokens, backticked tool tokens, file existence, smoke regression).
- [x] `canonical-source.test.ts` — 6 new tests covering: pkgRoot wiring, role-section ordering, back-compat (no opts → empty instructions), missing-template fall-through, double-missing → empty, whitespace trimming.
- [x] `projection.test.ts` — captures `pkgRoot` in the canonical-source mock to confirm the CLI passes it through.
- [x] `codex.test.ts` / `gemini.test.ts` / `cursor.test.ts` — one round-trip assertion per emitter.
- [x] Build + tsc clean.
- [x] Manual end-to-end:
      `HOME=$(mktemp -d) node dist/index.js projection emit --scope user`
      then `grep -c "## Captain Role"` and `grep -c "## Crew Role"` against each emitted file (expect 1 each).
- [x] Idempotent re-run: a second `emit` against the same HOME produces UNCHANGED diffs.
EOF
)"
```

- [ ] **Step 6: Verify CI is green and self-merge** (this is the final umbrella sub-issue; merging it unblocks cutting v0.3.0).

---

## Self-Review Checklist

Before declaring this plan complete, verify:

1. **Spec coverage** — every checkbox in #45 is covered:
   - [x] Audit current `captain.generic.md` / `crew.generic.md` — Task 1 (audit-as-test).
   - [x] Remove Claude-specific tool refs (`Skill`, `TaskCreate`, `TaskUpdate`, `Agent`, `TeamCreate`) — done by #41 / #42; locked in by Task 1.
   - [x] Use the split-pane crew-spawn pattern (post-#41) — present in `captain.generic.md`; Task 1 has a positive assertion (`cockpit crew spawn`).
   - [x] Document how each agent loads the template — Task 6 README updates note user-scope paths for codex / gemini / cursor; Aider deferred per non-goals.
   - [x] Update `cockpit projection` to project the generic templates correctly — Tasks 2 + 3.
   - [x] Test: spawn-equivalent (smoke against a tmp HOME) — Task 5 (full E2E without spawning real CLIs, since #45 is about projection, not runtime spawn — runtime spawn is exercised by #41).

2. **No drive-by refactoring** — Karpathy principles: every changed line traces to a checkbox in #45. The four plugin slots are not touched. The runtime driver is not touched. Project-scope projection is not touched. The role templates themselves are not touched.

3. **Cross-agent purity** — the only piece of Claude-specific logic that survives the projection layer is `--append-system-prompt-file`, which only the claude driver (`src/drivers/claude.ts`) emits. Codex / Gemini / Cursor get the *same* role descriptions through their own native config-file mechanism.

4. **All new code has tests** — `canonical-source.ts` extension is covered by 6 tests; `projection.ts` extension is covered by 1 new test; each emitter has a round-trip assertion.

5. **Hard rules respected** — no edits to `.gitignore`, no edits to `.claude/`, no destructive operations. PR is opened against `develop`, not `main`.
