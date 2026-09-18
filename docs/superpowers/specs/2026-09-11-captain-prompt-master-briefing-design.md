# Design: Captain Prompt Enhancement with Prompt-Master

**Date:** 2026-09-11  
**Status:** Approved  
**Topic:** Load-Bearing Task Briefs for Squadrant Crew Spawns via `prompt-master`

---

## 1. Context & Motivation

Squadrant operates on a coordinator-worker model where the **Captain** plans, delegates, reviews, and merges, while **Crews** execute tasks in isolated git worktrees across multiple AI runtimes (`claude`, `codex`, `opencode`, `gemini`).

Currently, when a Captain spawns a crew (`squadrant crew spawn <project> "<task>"`), the task description is often passed verbatim or with minimal ad-hoc instructions (e.g. `squadrant crew spawn brove "Refactor src/api/handlers.ts"`).

This informal prompting triggers known agent failure modes ("credit-killing patterns" documented by `nidhinjs/prompt-master`):
- **Vague task verbs & undefined done state**: agents guess what completion looks like or explore open-ended changes.
- **Missing scope boundaries**: agents modify unrelated files, package configurations, or formatting (violating Karpathy principles).
- **Lack of starting/target state**: agents spend tokens rediscovering context already known to the Captain.
- **Uncalibrated agent behavior**: failing to exploit model strengths (e.g. Claude Opus 5 adaptive thinking vs Codex explicit tool commands vs OpenCode flat instructions).

By integrating `nidhinjs/prompt-master` (12.6k+ stars, v1.8.0) into Squadrant, we equip Captains with a two-tier prompt enhancement system:
1. A full, portable `prompt-master` skill in `plugin/skills/prompt-master/` capable of optimizing prompts for any AI tool.
2. An opinionated crew briefing standard inside `captain-ops` and Captain role templates that applies load-bearing task briefs to all non-trivial crew tasks.

---

## 2. Goals & Non-Goals

### Goals
- **Two-tier integration**: Provide the full `prompt-master` skill suite as a registered Squadrant plugin skill, while baking a concise, load-bearing crew brief workflow directly into `captain-ops`.
- **Threshold-based enhancement**: Keep simple, one-line tasks (typos, identifier renames, version bumps) lightweight and direct; require structured briefs for multi-file, refactoring, or feature tasks.
- **Cross-agent calibration**: Tailor briefs to the target crew agent runtime (`claude`, `codex`, `opencode`, `gemini`).
- **Memory & handoff preservation**: Carry forward stack constraints, architectural decisions, and previous pitfalls recorded in handoff files into the crew brief.
- **Zero breaking changes**: Retain exact CLI compatibility for `squadrant crew spawn`, `crew send`, and routing.

### Non-Goals
- Adding mandatory CLI middleware flags or blocking CLI execution if a brief is not used.
- Modifying crew templates to require structured prompt schemas from the input turn.
- Removing non-coding AI tool profiles from the upstream `prompt-master` skill (retaining full upstream versatility).

---

## 3. Architecture & Components

```
plugin/
└── skills/
    ├── prompt-master/             <-- Full upstream skill suite
    │   ├── SKILL.md               <-- Main prompt engineer persona & tool routing
    │   └── references/
    │       ├── templates.md       <-- 13 architectures (incl. Template M, G, H)
    │       └── patterns.md        <-- 37 credit-killing anti-patterns
    └── captain-ops/
        └── SKILL.md               <-- Enhanced with "Crafting Load-Bearing Crew Briefs"

templates/
├── captain.claude.md              <-- Lists prompt-master skill & brief standard
└── captain.generic.md             <-- Generic captain parity for codex/gemini/opencode

packages/
├── shared/src/lib/runtime-sync.ts <-- Mirrors plugin/ in tree mode to ~/.config/squadrant/
└── cli/src/lib/__tests__/         <-- Asserts template and skill parity
```

---

## 4. Detailed Design

### 4.1. Full Skill: `plugin/skills/prompt-master/`
Vendored from `nidhinjs/prompt-master` v1.8.0:
- **`SKILL.md`**: Implements the 9 intent dimensions (Task, Target tool, Output format, Constraints, Input, Context, Audience, Success criteria, Examples), 3-question clarifying gate, credential sanitization, and model-specific profiles (Claude 5/4.8, Codex, OpenAI GPT-5.6, OpenCode, Gemini, etc.).
- **`references/templates.md`**: 13 templates including:
  - **Template M**: Current Claude Task Brief (Outcome, Context, Target State, Scope, Constraints, Acceptance Criteria, Action Boundaries, Progress Evidence).
  - **Template G**: File-Scope Template (exact file, current behavior, desired change, do-not-touch, done when).
  - **Template H**: ReAct + Stop Conditions (starting/target state, allowed/forbidden actions, stop conditions).
- **`references/patterns.md`**: 37 credit-killing anti-patterns with bad examples and concrete fixes across Task, Context, Format, Scope, Reasoning, and Agentic categories.

### 4.2. Captain Playbook: `captain-ops` Briefing Protocol
Add a dedicated section to `plugin/skills/captain-ops/SKILL.md` under **Spawning Crew**:

#### Threshold Gate
- **Trivial / 1-liner tasks** (e.g. typos, single rename, dep bump):
  Direct imperative prompt: `squadrant crew spawn <proj> "Fix typo in README.md"`
- **Non-trivial tasks** (3+ files, multi-step features, bug fixes, refactoring):
  The Captain must synthesize a structured brief before invoking `squadrant crew spawn`.

#### Squadrant Template M (Task Brief Structure)
```markdown
## Objective
[Clear 1-sentence goal + why it matters]

## Context & State
[Relevant files, current behavior, stack decisions carried forward from handoff/git]

## Target State
[Exact changes expected: files modified, behavior verified, tests passing]

## Scope
- Work ONLY in: [specific paths/directories]
- Do NOT touch: [forbidden configs, .env, unrelated modules, lockfiles unless prompted]

## Constraints
- Karpathy principles: surgical changes only, no drive-by refactors
- [Stack version, dependencies, test runner requirements]

## Acceptance Criteria
- [ ] [Binary verifiable check 1]
- [ ] [Binary verifiable check 2]
- [ ] [Binary verifiable check 3]
```

#### Agent-Specific Brief Adjustments
- **Claude (`claude/opus`, `claude/sonnet`)**: Front-load scope and acceptance criteria in the first 30%. Never request hidden chain-of-thought. State explicit stop conditions for irreversible operations.
- **Codex (`codex`)**: Define exact file list, explicit function contracts, and concrete verification commands (e.g. `pnpm test path/to/file.test.ts`).
- **OpenCode (`opencode`)**: Use flat, unnested instructions with explicit paths and binary criteria.
- **Gemini (`gemini`)**: Anchor in provided files, forbid hallucinations/citations outside provided context.

### 4.3. Role Templates Update
Update `templates/captain.claude.md` and `templates/captain.generic.md`:
- Add `squadrant:prompt-master` to `## Available Skills`.
- Under `## Spawning Crew`, instruct the Captain:
  *"For non-trivial tasks (3+ files, features, refactors), formulate a load-bearing brief (Objective, Scope, Acceptance Criteria) per `captain-ops` and `squadrant:prompt-master` before spawning."*

### 4.4. Runtime Synchronization & Projection
- `runtime-sync.ts`: Already mirrors `plugin/` in `tree` mode, ensuring `~/.config/squadrant/plugin/skills/prompt-master/` is populated automatically on CLI run.
- `canonical-source.ts`: Template tests ensure `captain.generic.md` stays synchronized with `captain.claude.md`.

---

## 5. Testing & Verification

1. **Static & Lint Checks**: Verify Markdown formatting and skill metadata headers across `plugin/skills/prompt-master/`.
2. **Template Assertions**: Run existing test suite (`pnpm test`) across `@squadrant/shared`, `@squadrant/core`, and `@squadrant/cli` to verify no regressions.
3. **Role Template Test**: Verify `packages/cli/src/lib/__tests__/role-templates.test.ts` passes with the updated templates.
4. **Runtime Sync Test**: Verify `packages/shared/src/lib/__tests__/runtime-sync.test.ts` confirms plugin skills are properly mirrored.
