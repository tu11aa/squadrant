# Captain Prompt-Master Briefing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Equip Squadrant Captains with `nidhinjs/prompt-master` to formulate load-bearing task briefs for crew spawns across all supported agent runtimes.

**Architecture:** Vendor `prompt-master` (v1.8.0) into `plugin/skills/prompt-master/` so it syncs automatically to `~/.config/squadrant/plugin/skills/` via `runtime-sync.ts`. Add a threshold-based crew brief protocol to `captain-ops` and Captain role templates, guiding captains to construct structured briefs (Objective, Scope, Acceptance Criteria) for non-trivial tasks.

**Tech Stack:** TypeScript, Node.js fs/path, Vitest, Markdown/Skill specification.

---

### Task 1: Vendor prompt-master Skill Suite

**Files:**
- Create: `plugin/skills/prompt-master/SKILL.md`
- Create: `plugin/skills/prompt-master/references/templates.md`
- Create: `plugin/skills/prompt-master/references/patterns.md`

- [ ] **Step 1: Create directories**

Run: `mkdir -p plugin/skills/prompt-master/references`
Expected: Directory created.

- [ ] **Step 2: Write `plugin/skills/prompt-master/SKILL.md`**

Write the upstream `prompt-master` v1.8.0 SKILL.md defining identity, hard rules, intent extraction, tool routing (Claude, ChatGPT, Codex, Grok, Gemini, OpenCode, etc.), and diagnostic checklist.

- [ ] **Step 3: Write `plugin/skills/prompt-master/references/templates.md`**

Write the 13 prompt architectures (Templates A through M, including Template M for Current Claude Task Brief, Template G File-Scope, and Template H ReAct).

- [ ] **Step 4: Write `plugin/skills/prompt-master/references/patterns.md`**

Write the 37 credit-killing anti-pattern definitions with before/after fixes across Task, Context, Format, Scope, Reasoning, and Agentic categories.

- [ ] **Step 5: Verify files exist and are non-empty**

Run: `node -e "assert(fs.existsSync('plugin/skills/prompt-master/SKILL.md')); assert(fs.existsSync('plugin/skills/prompt-master/references/templates.md')); assert(fs.existsSync('plugin/skills/prompt-master/references/patterns.md')); console.log('All 3 files exist and are readable.');"`
Expected: "All 3 files exist and are readable."

- [ ] **Step 6: Commit**

```bash
git add plugin/skills/prompt-master
git commit -m "feat(skills): vendor prompt-master skill suite"
```

---

### Task 2: Add Role Template Audit Tests for prompt-master

**Files:**
- Modify: `packages/cli/src/lib/__tests__/role-templates.test.ts`

- [ ] **Step 1: Write failing test in `packages/cli/src/lib/__tests__/role-templates.test.ts`**

Add tests verifying that:
1. `plugin/skills/prompt-master/SKILL.md` exists and contains valid skill frontmatter with name `prompt-master`.
2. `templates/captain.claude.md` lists `squadrant:prompt-master` under Available Skills.
3. `templates/captain.generic.md` references `prompt-master` in its Crew Spawning section without containing forbidden tool tokens.

```typescript
  it("prompt-master skill exists with valid frontmatter", () => {
    const skillPath = path.join(REPO_ROOT, "plugin", "skills", "prompt-master", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, "utf-8");
    expect(content).toMatch(/^name:\s*prompt-master/m);
  });

  it("captain.claude.md lists prompt-master skill", () => {
    const body = readTemplate("captain.claude.md");
    expect(body).toMatch(/squadrant:prompt-master/);
  });

  it("captain.generic.md references prompt-master guidance and has no forbidden tokens", () => {
    const body = readTemplate("captain.generic.md");
    expect(body).toMatch(/prompt-master/);
    expect(findForbidden(body)).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/lib/__tests__/role-templates.test.ts`
Expected: FAIL on `captain.claude.md lists prompt-master skill` and `captain.generic.md references prompt-master guidance`.

---

### Task 3: Update Captain Role Templates

**Files:**
- Modify: `templates/captain.claude.md`
- Modify: `templates/captain.generic.md`

- [ ] **Step 1: Update `templates/captain.claude.md`**

Add `squadrant:prompt-master` to `## Available Skills` and update crew spawning guidelines:
```markdown
## Available Skills

- `squadrant:captain-ops` — Your complete playbook (startup, crew, status, groups, learnings)
- `squadrant:prompt-master` — Optimize load-bearing task briefs for any AI tool / crew
- `squadrant:karpathy-principles` — Coding discipline (apply during crew review: think, simplify, surgical, goal-driven)
- `squadrant:wiki-ops` — Compile knowledge into persistent wiki pages (ingest, query, cross-reference)
- `squadrant:daily-log` — End-of-day log format (opt-in)
```
And in `## Core Rules` / Crew Spawning:
*"For non-trivial tasks (3+ files, features, refactors), formulate a load-bearing brief (Objective, Scope, Acceptance Criteria) per `squadrant:captain-ops` and `squadrant:prompt-master` before spawning."*

- [ ] **Step 2: Update `templates/captain.generic.md`**

Under `## Crew Spawning`:
```markdown
## Crew Spawning

Use `squadrant crew spawn`. Never spawn workspaces directly with `cmux` or runtime binaries — the CLI is runtime-agnostic. Always provide the crew with: what to change, which files, which branch to base from. For non-trivial tasks (3+ files, features, refactors), formulate a load-bearing brief (Objective, Scope, Acceptance Criteria) per captain-ops and prompt-master before spawning.
```

- [ ] **Step 3: Run role-templates tests to verify they pass**

Run: `pnpm test packages/cli/src/lib/__tests__/role-templates.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/__tests__/role-templates.test.ts templates/captain.claude.md templates/captain.generic.md
git commit -m "feat(templates): add prompt-master to captain role templates"
```

---

### Task 4: Integrate Load-Bearing Crew Briefs into `captain-ops`

**Files:**
- Modify: `plugin/skills/captain-ops/SKILL.md`

- [ ] **Step 1: Update `plugin/skills/captain-ops/SKILL.md`**

In the `## Spawning Crew` section of `plugin/skills/captain-ops/SKILL.md`, insert the `### Crafting Load-Bearing Crew Briefs` subsection before `### Rules`:

```markdown
### Crafting Load-Bearing Crew Briefs

When spawning crew, the quality of the first turn prompt determines whether the agent succeeds on attempt 1 or wastes tokens wandering. Follow `squadrant:prompt-master` principles:

#### 1. Threshold Gate
- **Trivial / 1-liner tasks** (e.g. typos, single-variable rename, version bump):
  Direct imperative prompt: `squadrant crew spawn <project> "Fix typo in README.md"`
- **Non-trivial tasks** (3+ files, features, bug fixes, refactoring):
  You MUST synthesize a structured brief before invoking `squadrant crew spawn`.

#### 2. Squadrant Task Brief Grammar (Template M)
Structure non-trivial task prompts into load-bearing markdown sections:

```markdown
## Objective
[Clear 1-sentence goal + why it matters]

## Context & State
[Relevant files, current behavior, stack decisions carried forward from handoff/git]

## Target State
[Exact changes expected: files modified, behavior verified, tests passing]

## Scope
- Work ONLY in: [specific paths/directories]
- Do NOT touch: [forbidden configs, .env, unrelated modules, lockfiles]

## Constraints
- Karpathy principles: surgical changes only, no drive-by refactors
- [Stack version, dependencies, test runner requirements]

## Acceptance Criteria
- [ ] [Binary verifiable check 1]
- [ ] [Binary verifiable check 2]
```

#### 3. Agent-Specific Brief Tuning
- **Claude (`claude/opus`, `claude/sonnet`)**: Front-load scope and acceptance criteria in the first 30%. Never request hidden chain-of-thought. State explicit stop conditions for irreversible operations.
- **Codex (`codex`)**: Define exact file list, explicit function contracts, and concrete verification commands (e.g. `pnpm test path/to/file.test.ts`).
- **OpenCode (`opencode`)**: Use flat, unnested instructions with explicit paths and binary criteria.
- **Gemini (`gemini`)**: Anchor in provided files, forbid citations or assumptions outside provided context.
```

- [ ] **Step 2: Verify `plugin/skills/captain-ops/SKILL.md` content**

Run: `node -e "const text = fs.readFileSync('plugin/skills/captain-ops/SKILL.md', 'utf8'); assert(text.includes('Crafting Load-Bearing Crew Briefs')); assert(text.includes('prompt-master')); console.log('captain-ops brief section verified.');"`
Expected: "captain-ops brief section verified."

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/captain-ops/SKILL.md
git commit -m "docs(captain-ops): add load-bearing crew brief guidelines"
```

---

### Task 5: Full Test Suite Verification & Runtime Sync Check

**Files:**
- Test all packages via pnpm

- [ ] **Step 1: Run runtime-sync test**

Run: `pnpm --filter @squadrant/shared test`
Expected: PASS (confirms `plugin/` tree mirroring works without error).

- [ ] **Step 2: Run core & cli tests**

Run: `pnpm --filter @squadrant/core test && pnpm --filter @squadrant/cli test`
Expected: PASS (all tests green, 0 regressions).

- [ ] **Step 3: Verify git status is clean and structured**

Run: `git status`
Expected: Clean working tree on branch develop (or only expected untracked/staged files).
