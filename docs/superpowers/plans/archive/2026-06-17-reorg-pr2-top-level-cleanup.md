# Reorg PR2 — Top-Level Cleanup Implementation Plan

> **✅ Shipped** (reorg Step 2 PRs (#352+), 2026-06-17). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dead top-level `core/` dir and rename the misleadingly-named `orchestrator/` (role-prompt templates) to `templates/`, updating every reader, so the repo's top level stops being a source of confusion — de-risking the `pkgRoot`-relative-reads landmine before any package moves.

**Architecture:** Pure structure refactor, no behavior change. `orchestrator/` holds role-prompt `.md` templates that `canonical-source.ts` (inlines into the user-level projection) and `runtime-sync.ts` (mirrors into `~/.config/cockpit/templates/`) read relative to the package root. Rename the source dir and repoint those two readers + their tests + the README. Delete the stale `core/` (2 files, unreferenced).

**Tech Stack:** TypeScript (NodeNext ESM), vitest, plain `tsc` build, git.

## Global Constraints

- Platform: macOS-only. Don't add cross-platform shims.
- NodeNext ESM: relative imports need `.js` extensions. The real runtime gate is `node dist/index.js --help`, not just tests (tsc + vitest miss missing-extension breakage).
- No behavior change — this PR is structure-only. No feature work rides along.
- Do NOT rewrite historical design docs under `docs/specs/` that mention `orchestrator/` — those describe past states and stay as-is. Only update **production code, tests, and `README.md`**.
- Branch off `develop`. Open a PR to `develop`; do not self-merge (captain reviews).
- Each task ends green: `npm test` passes AND `node dist/index.js --help` works.

**Reference — the complete set of `orchestrator` references to update (verified 2026-06-17):**
- Prod: `src/lib/canonical-source.ts:62`, `src/lib/runtime-sync.ts:103` (+ comments at :54, :86, :110)
- Tests: `src/lib/__tests__/role-templates.test.ts:8`, `src/lib/__tests__/canonical-source.test.ts:155-156`, `src/lib/__tests__/runtime-sync.test.ts:152-154,170`
- Docs: `README.md:130`

---

### Task 1: Remove the stale top-level `core/` directory

**Files:**
- Delete: `core/settings.json`, `core/plugins.md` (the whole `core/` dir)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. (Pure deletion; verified unreferenced by `src/`, `package.json`, `tsconfig`, `scripts/`.)

- [ ] **Step 1: Prove `core/` is unreferenced (safety check)**

Run:
```bash
git grep -nE "core/(settings|plugins)|[\"'/]core[\"'/]" -- src package.json 'tsconfig*.json' scripts | grep -v node_modules
```
Expected: **no output**. If anything prints, STOP and report — do not delete.

- [ ] **Step 2: Inspect the files before deleting (don't delete blind)**

Run:
```bash
cat core/settings.json core/plugins.md
```
Expected: stale content (last touched 2026-03-30). If either looks live/needed, STOP and report instead of deleting.

- [ ] **Step 3: Delete the directory**

Run:
```bash
git rm -r core
```
Expected: `rm 'core/plugins.md'` / `rm 'core/settings.json'`.

- [ ] **Step 4: Build + CLI smoke + tests still green**

Run:
```bash
npm run build && node dist/index.js --help && npm test
```
Expected: build succeeds, `--help` prints the cockpit usage, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove stale top-level core/ (unreferenced, dead since 2026-03)"
```

---

### Task 2: Rename `orchestrator/` → `templates/` and repoint all readers

**Files:**
- Rename: `orchestrator/` → `templates/` (9 `.md` files) via `git mv`
- Modify: `src/lib/canonical-source.ts:62`
- Modify: `src/lib/runtime-sync.ts:103` (+ comments :54, :86, :110)
- Modify (tests): `src/lib/__tests__/role-templates.test.ts:8`, `src/lib/__tests__/canonical-source.test.ts:155-156`, `src/lib/__tests__/runtime-sync.test.ts:152-154,170`
- Modify: `README.md:130`

**Interfaces:**
- Consumes: nothing new.
- Produces: source role templates now live at `<pkgRoot>/templates/*.md`; `MANAGED_TARGETS` entry `{ name: "templates", srcRel: "templates" }`; `readRoleTemplates` reads from `path.join(pkgRoot, "templates", file)`. Runtime target path `~/.config/cockpit/templates/` is unchanged.

- [ ] **Step 1: Update the test expectations FIRST (red)**

In `src/lib/__tests__/role-templates.test.ts` line 8, change:
```typescript
const ORCH_DIR = path.join(REPO_ROOT, "orchestrator");
```
to:
```typescript
const ORCH_DIR = path.join(REPO_ROOT, "templates");
```

In `src/lib/__tests__/canonical-source.test.ts` lines 155-156, change:
```typescript
    expect(reads).toContain("/pkg/orchestrator/captain.generic.md");
    expect(reads).toContain("/pkg/orchestrator/crew.generic.md");
```
to:
```typescript
    expect(reads).toContain("/pkg/templates/captain.generic.md");
    expect(reads).toContain("/pkg/templates/crew.generic.md");
```

In `src/lib/__tests__/runtime-sync.test.ts` lines 152-154 and 170, change the three `orchestrator` occurrences to `templates`:
```typescript
    // templates: flat target sourced from templates/, filtered by extension
    write(path.join(sourceRoot, "templates", "captain.claude.md"), "tmpl");
    write(path.join(sourceRoot, "templates", "notes.txt"), "ignore me");
```
and (line ~170 comment):
```typescript
    // templates sourced from templates/, filtered
```

- [ ] **Step 2: Run tests to verify they fail (red)**

Run:
```bash
npx vitest run src/lib/__tests__/role-templates.test.ts src/lib/__tests__/canonical-source.test.ts src/lib/__tests__/runtime-sync.test.ts
```
Expected: FAIL — `role-templates` fails reading `templates/` (dir not renamed yet), `canonical-source` fails because prod still joins `"orchestrator"`, `runtime-sync` fails because `MANAGED_TARGETS.srcRel` is still `"orchestrator"`.

- [ ] **Step 3: Rename the directory**

Run:
```bash
git mv orchestrator templates
```
Expected: 9 files moved (`captain.claude.md`, `captain.generic.md`, `command.claude.md`, `crew.claude.md`, `crew.generic.md`, `crew.opencode.md`, `learnings.claude.md`, `side.debug.claude.md`, `side.research.claude.md`).

- [ ] **Step 4: Repoint the production readers**

In `src/lib/canonical-source.ts` line 62, change:
```typescript
    const full = path.join(opts.pkgRoot, "orchestrator", file);
```
to:
```typescript
    const full = path.join(opts.pkgRoot, "templates", file);
```

In `src/lib/runtime-sync.ts`, change the `MANAGED_TARGETS` entry (line ~103) from:
```typescript
  {
    name: "templates",
    srcRel: "orchestrator",
    mode: "flat",
    match: /\.(claude\.md|generic\.md|opencode\.md|CLAUDE\.md)$/,
  },
```
to:
```typescript
  {
    name: "templates",
    srcRel: "templates",
    mode: "flat",
    match: /\.(claude\.md|generic\.md|opencode\.md|CLAUDE\.md)$/,
  },
```
Then update the two stale comments for accuracy:
- line ~54: `* mixed directory (templates ← orchestrator/, scripts).` → `* mixed directory (templates ← templates/, scripts).`
- line ~86: `* runtime \`templates/\` is sourced from \`orchestrator/\`).` → `* runtime \`templates/\` is sourced from \`templates/\`).`
- line ~110: ``/** Package root containing the source dirs (`plugin/`, `orchestrator/`, …). */`` → ``/** Package root containing the source dirs (`plugin/`, `templates/`, …). */``

- [ ] **Step 5: Update the README**

In `README.md` line 130, change `orchestrator/captain.generic.md` and `orchestrator/crew.generic.md` to `templates/captain.generic.md` and `templates/crew.generic.md`.

- [ ] **Step 6: Run the targeted tests to verify they pass (green)**

Run:
```bash
npx vitest run src/lib/__tests__/role-templates.test.ts src/lib/__tests__/canonical-source.test.ts src/lib/__tests__/runtime-sync.test.ts
```
Expected: PASS — all three.

- [ ] **Step 7: Verify no stragglers in code/tests/README**

Run:
```bash
git grep -in "orchestrator" -- src README.md
```
Expected: **no output**. (Historical `docs/specs/` mentions are intentionally left untouched and are excluded here.)

- [ ] **Step 8: Full build + CLI smoke + full test suite**

Run:
```bash
npm run build && node dist/index.js --help && npm test
```
Expected: build succeeds, `--help` works, full suite green.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: rename orchestrator/ -> templates/ (role-prompt templates) + repoint readers"
```

---

### Task 3: Open the PR

- [ ] **Step 1: Push and open PR to develop**

Run:
```bash
git push -u origin HEAD
gh pr create --base develop --title "Reorg PR2: top-level cleanup (remove core/, orchestrator->templates)" \
  --body "Part of the monorepo reorg (docs/superpowers/specs/2026-06-17-monorepo-reorg-design.md), rollout step 2.

- Remove stale top-level core/ (2 files, dead since 2026-03, unreferenced).
- Rename orchestrator/ -> templates/ (it holds role-prompt templates, not orchestration logic).
- Repoint canonical-source.ts + runtime-sync.ts + their tests + README.
- No behavior change. Runtime target ~/.config/cockpit/templates/ unchanged.

Verified: npm test green, node dist/index.js --help works."
```
Expected: PR URL printed. Do NOT merge — captain reviews.

- [ ] **Step 2: Signal done**

```bash
cockpit crew signal done
```

---

## Self-Review

**Spec coverage** (against the "Top-level cleanup" section of the design spec):
- Remove stale `core/` → Task 1. ✓
- Rename `orchestrator/`→`templates/` + update every `pkgRoot`-relative reader (`canonical-source.ts`, `runtime-sync.ts`, tests) → Task 2. ✓
- Landmine #2 (`pkgRoot` reads) de-risked early → this IS rollout step 2, before package moves. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after; every command has expected output. ✓

**Type consistency:** `MANAGED_TARGETS` entry keeps `name: "templates"` (runtime target) and changes only `srcRel` to `"templates"` (source). `readRoleTemplates` join path changes `"orchestrator"`→`"templates"`. Test path constants and expectation strings match the new `templates/` source. No signature changes. ✓

**Out of scope (correctly deferred):** package.json has no `files` allowlist, so publish ships the renamed dir automatically — no publish-config change. tsconfig builds only `src/`, so the rename doesn't affect the build. The broader monorepo packaging is rollout steps 3-7, not here.
