# Docs Cleanup & Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Archive shipped/superseded planning docs + stale diagrams behind status banners, refresh the living docs (README, architecture diagrams, CLAUDE/AGENTS) to the 6-package monorepo, and build a master `docs/README.md` index — with **zero content deletion** (only `.DS_Store`).

**Spec:** `docs/superpowers/specs/2026-06-18-docs-cleanup-and-refresh-design.md` (read it first — triage rule + banner formats + living-doc targets).

## Global Constraints

- **NEVER delete a content doc.** All archiving is `git mv` into `docs/<cat>/archive/`. Only `docs/.DS_Store` may be `git rm`'d. `git log --stat` for the PR must show zero deleted content files.
- **When unsure if a doc is shipped → keep it ACTIVE** (don't archive in-flight work).
- **Don't rewrite historical prose** — archived docs get a one-line status banner at top only; never path-rewrite their body. Living docs (README/architecture/CLAUDE/AGENTS) DO get path fixes.
- **Docs-only change** — `pnpm build` + suite must stay green (1298/3 #353). Do not touch `packages/` source.
- Branch `crew/docs-cleanup` off develop; isolated worktree; `pnpm install --frozen-lockfile` before any build check.
- Keep all `.vi.*` translations. Update internal cross-doc links when a target moves.

---

## Task 1: Triage manifest (shipped vs active)

**Files:** Create `docs/_triage-manifest.md` (temporary working doc; deleted in Task 6).

- [ ] **Step 1: List every planning doc** under `docs/specs/`, `docs/plans/`, `docs/superpowers/specs/`, `docs/superpowers/plans/`.
- [ ] **Step 2: Classify each** as `shipped` or `active`. For each, run a quick check: `git log --oneline --all --grep "<feature-keyword>"` and/or `gh pr list --state merged --search "<keyword>"` and/or confirm the feature exists in `packages/`. Record the verdict + evidence (PR # or code path) in the manifest. Apply the spec's known-shipped buckets. Force-recheck (do NOT assume): `2026-06-14-302-nondestructive-delivery-proposal.md`, `2026-04-21-plugin-system-tracker-*`, `2026-05-05-auto-status-poller-plan.md` (reactor was REMOVED → superseded/archive). All `monorepo-reorg*` + `reorg-*` + `step5/6/7*` docs = shipped.
- [ ] **Step 3: Produce the move list** — manifest table: `path | shipped/active | PR/evidence | → archive path or KEEP`.
- [ ] **Step 4: Commit the manifest** so the captain can review the triage before the moves land.
```bash
git add docs/_triage-manifest.md && git commit -m "docs: triage manifest (shipped vs active) for cleanup"
```

---

## Task 2: Archive shipped planning docs (git mv + banners)

**Files:** create `docs/specs/archive/`, `docs/plans/archive/`, `docs/superpowers/specs/archive/`, `docs/superpowers/plans/archive/`; `git mv` shipped docs in; prepend banner.

- [ ] **Step 1: Create archive dirs** (with a `.gitkeep` if empty until moves land).
- [ ] **Step 2: `git mv` each `shipped` doc** from the manifest into its category's `archive/`.
- [ ] **Step 3: Prepend the status banner** to each archived file (below its existing H1 title, blank line around it):
  `> **✅ Shipped** (<PR # if known>, <orig date>). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.`
  (Use `⛔ Superseded by <x>` form for the reactor/auto-status-poller and any proposal that was replaced.)
- [ ] **Step 4: Update cross-links** — grep the repo for links to any moved file (`grep -rn "<oldpath>" docs README.md CLAUDE.md AGENTS.md`) and repoint to the new `archive/` path.
- [ ] **Step 5: Verify no content lost** — `git status` shows only `R` (renames) + the banner edits. Commit.
```bash
git add -A && git commit -m "docs: archive shipped specs/plans with status banners (preserve-details)"
```

---

## Task 3: Archive stale diagrams + reports

**Files:** create `docs/diagrams/archive/`, `docs/reports/archive/`; move the stale ones.

- [ ] **Step 1: `git mv` into `docs/diagrams/archive/`:** `2026-06-01-{claude,codex,opencode}-architecture-vi.html`, `cockpit-vs-orca-architecture.html`, and the pre-reorg `2026-06-17-cockpit-architecture-overview.html` + `.vi.html` (after Task 4 produces the replacement).
- [ ] **Step 2: `git mv` into `docs/reports/archive/`:** `2026-06-17-src-and-control-relation-graphs.html` (obsolete), `2026-06-16-cockpitd-structure.html` (split proposal — now executed), and the other dated daemon/captain-crew reports. Keep `docs/reports/*.md` per triage.
- [ ] **Step 3: Add a superseded banner** — for HTML, insert a visible top banner `<div>` (inline-styled) near the opening `<body>`: `⛔ Superseded — depicts the pre-reorg layout. Current: ../diagrams/2026-06-18-cockpit-monorepo-architecture.html · Archived 2026-06-18`. (Do not restructure the diagram itself.)
- [ ] **Step 4: Commit.**
```bash
git add -A && git commit -m "docs: archive stale/pre-reorg diagrams + reports with superseded banners"
```

---

## Task 4: New architecture diagram + refresh living arch docs

**Files:** Create `docs/diagrams/2026-06-18-cockpit-monorepo-architecture.html` (+ `.vi.html`); modify `docs/architecture.html` + `docs/architecture.vi.html`.

- [ ] **Step 1: Author the new diagram** — self-contained HTML + inline CSS, matching the style of the (now-archived) `2026-06-17-cockpit-architecture-overview.html`. Depict: the six packages and the one-way DAG `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`; the two driver seams (agents = claude/codex/opencode/gemini behind `AgentDriver`; workspaces = cmux `RuntimeDriver` + obsidian `WorkspaceDriver` + cmux `NotifierDriver`); the two bundled entries (`dist/index.js` bin from `@cockpit/cli`, `dist/cockpitd.js` daemon — core logic + cli host); and the Captain→Crew runtime model. Provide a `.vi.html` Vietnamese companion.
- [ ] **Step 2: Refresh `docs/architecture.html` + `.vi.html`** — replace any `src/control`-era structure description with the package layout (or embed/point to the new diagram). Grep them for `src/`/`orchestrator/` and fix.
- [ ] **Step 3: Open the new HTML** to confirm it renders (valid, no external deps). Commit.
```bash
git add -A && git commit -m "docs: add post-reorg monorepo architecture diagram; refresh architecture.html"
```

---

## Task 5: Refresh README + CLAUDE/AGENTS + build master index

**Files:** Modify `README.md`, `CLAUDE.md`, `AGENTS.md`; create `docs/README.md`.

- [ ] **Step 1: README path fixes** — `src/runtimes/` → `packages/workspaces/src/runtimes/`; `src/workspaces/` → `packages/workspaces/src/workspaces/`; grep README for any other `src/…` and fix.
- [ ] **Step 2: README "## Monorepo structure" section** — add after the intro: the 6 packages (one line each: shared=config/types/leaf-lib; core=daemon/state/protocol + interfaces; agents=AI driver seam; workspaces=cmux/obsidian/notifier seam; web=dashboard; cli=commands+bin+daemon host), the DAG, and the two bundled entries. Link the new diagram.
- [ ] **Step 3: CLAUDE.md + AGENTS.md "Repository layout"** — a short section: the 6 packages + DAG + `dist/index.js`/`dist/cockpitd.js`. Thin; AGENTS.md canonical.
- [ ] **Step 4: Create `docs/README.md` master index** — sections: Living docs · Active specs · Active plans · Decisions · Research (historical) · Archive (links to each archive subdir). Per-row: `[file](path) | one-line purpose | status`. Ensure every active doc + every archive subdir is linked.
- [ ] **Step 5: Link-check** — grep `docs/README.md` + `README.md` for `](` links; verify each target path exists. Fix any dangling. Commit.
```bash
git add -A && git commit -m "docs: refresh README + CLAUDE/AGENTS to monorepo layout; add docs/README.md index"
```

---

## Task 6: Junk cleanup + final validation

- [ ] **Step 1: Remove junk** — `git rm docs/.DS_Store`; ensure `.DS_Store` is in root `.gitignore` (add if missing). Remove the temporary `docs/_triage-manifest.md` (`git rm`).
- [ ] **Step 2: No-content-lost gate** — `git diff --stat origin/develop...HEAD | grep -E "^\s*delete"` should list ONLY `.DS_Store` and `_triage-manifest.md`. Every other change is rename/add/modify. Report the deletion list.
- [ ] **Step 3: Stale-ref gate** — `grep -rnE "src/(control|commands|dashboard|runtimes|drivers|workspaces)/|orchestrator/" README.md CLAUDE.md AGENTS.md docs/architecture.html docs/architecture.vi.html docs/README.md` → zero hits (living docs only; archived bodies may still contain old paths — that's fine).
- [ ] **Step 4: Link gate** — every link in `docs/README.md` resolves to an existing file.
- [ ] **Step 5: Build/test untouched** — `pnpm build && npx vitest run` → green, 1298/3 #353 (proves docs-only, no source touched).
- [ ] **Step 6: Report** — summary: # archived (by category), # living docs refreshed, new diagram path, deletion list (just the 2 junk files), gate results. Open PR `crew/docs-cleanup` base develop, then signal done. Do NOT merge.

---

## Self-Review (planner)

- **Preserve-details:** every move is `git mv`; deletions limited to `.DS_Store` + the temp manifest (Task 6 Step 2 gate enforces). ✓
- **Diagrams covered:** Task 3 archives stale, Task 4 produces the new current one + refreshes architecture.html. ✓
- **Living-doc accuracy:** Task 5 fixes README paths + adds structure section; Task 6 Step 3 grep-gates zero stale refs. ✓
- **Triage safety:** Task 1 manifest is committed for captain review before moves; "when unsure → keep active." ✓
- **No placeholders:** banner text, exact paths, exact grep gates all given. ✓
