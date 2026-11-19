# captain-ops reference: Crew briefs

_Read this before writing a non-trivial crew brief. Part of the `captain-ops` skill; the trigger table is in `SKILL.md`._


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
