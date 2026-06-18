# Docs Cleanup & Refresh — archive shipped planning docs, refresh living docs post-reorg

**Date:** 2026-06-18
**Status:** Design — approved for planning
**Motivation:** The 7-step monorepo reorg (now complete) left the living docs (README,
architecture diagrams, CLAUDE/AGENTS) describing the **old flat `src/` layout**, and `docs/`
has accumulated ~95 files (74 md + 21 html) of mostly-shipped planning artifacts with no
index. Relates to issue **#349**.

## Guiding principle (HARD)

**Preserve details — never delete content.** Per the standing rule, completed/superseded docs
are **archived (moved + status-banner)**, not deleted. The only deletions allowed are true junk
(`.DS_Store`) and nothing else. Everything archived stays in-tree under `docs/archive/…` (or
`docs/<cat>/archive/…`) and remains linked from the index.

## Goal

1. **Refresh the living docs** to the 6-package monorepo reality.
2. **Archive shipped/superseded** planning docs + stale diagrams behind status banners, leaving
   `docs/specs` and `docs/plans` holding only ACTIVE work.
3. **Build a master `docs/README.md` index** so the doc set is navigable.

## Current inventory (2026-06-18)

| Dir | Count | Disposition |
|---|---|---|
| `docs/specs/` | 27 md | triage: shipped → `docs/specs/archive/`; active → stay |
| `docs/plans/` | 8 md | triage: done → `docs/plans/archive/`; active → stay |
| `docs/superpowers/specs/` | 11 md | all shipped (incl. reorg 1-7) → `docs/superpowers/specs/archive/` |
| `docs/superpowers/plans/` | 11 md | all shipped (incl. reorg 1-7) → `docs/superpowers/plans/archive/` |
| `docs/reports/` | 2 md, 4 html | pre-reorg structure reports → `docs/reports/archive/` (+ banner) |
| `docs/diagrams/` | 6 html | stale/dated → `docs/diagrams/archive/` (+ banner); ADD new current diagram |
| `docs/research/` | 13 md, 9 html | **keep in place** — inherently historical reference |
| `docs/decisions/` | 1 md | keep |
| `docs/testing/` | 1 md | keep (crew-lifecycle-checklist — living) |
| `docs/` (root) | `architecture.html`, `.vi.html`, `.DS_Store` | refresh the two; delete `.DS_Store` |

## Triage rule (shipped vs active)

A planning doc (`docs/specs/*`, `docs/plans/*`, `docs/superpowers/*`) is **shipped** (→ archive)
when its feature is merged / present in the codebase. Verify per-doc with `git log --oneline --all
--grep`, `gh pr list --search`, or by checking the feature exists in `packages/`. When in doubt,
**keep it active** (conservative — never archive something still in flight). Known-shipped buckets
(archive): multi-agent support, all `plugin-system-*`, dashboard, control-plane, interactive-codex,
claude-interactive-through-daemon, mailbox-injector, side-sessions, crew-done-lifecycle-fix,
cross-project-delegation, telegram-integration, cmux-socket-auth/daemon-direct, service-health,
config-drift, captain-managed-relay, and **all reorg docs (monorepo-reorg-design + steps 1-7)**.
Explicitly re-check these as possibly-active (do NOT assume shipped): `2026-06-14-302-nondestructive-
delivery-proposal.md` (a proposal), `2026-04-21-plugin-system-tracker-*` (tracker slot may be
unbuilt), `2026-05-05-auto-status-poller-plan.md` (reactor was REMOVED — mark superseded/archive).

Each archived file gets a one-line banner at the very top (below any existing H1), e.g.:
`> **✅ Shipped** (PR #NNN, <date>). Archived 2026-06-18. Historical — describes the design as
built; layout/paths may predate the monorepo reorg.` For superseded diagrams:
`> **⛔ Superseded** by [<new diagram>](../<file>). Archived 2026-06-18 — depicts the pre-reorg layout.`

## Living-doc refresh (the substance)

1. **`README.md`** — fix stale paths: `src/runtimes/` → `packages/workspaces/src/runtimes/`,
   `src/workspaces/` → `packages/workspaces/src/workspaces/` (lines ~110/114). Add a new
   **"## Monorepo structure"** section: the six packages (`shared · core · agents · workspaces ·
   web · cli`), one line each on what each owns, and the one-way DAG
   `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`, plus the single bundled bin (`dist/index.js`)
   + daemon (`dist/cockpitd.js`). Re-grep README for any other `src/…` path refs and fix.
2. **NEW diagram** `docs/diagrams/2026-06-18-cockpit-monorepo-architecture.html` (+ `.vi.html`) —
   the current architecture: the 6-package DAG, the two driver seams (agents: claude/codex/
   opencode/gemini; workspaces: cmux runtime + obsidian + notifier), the daemon (`@cockpit/core`
   logic, `dist/cockpitd.js` host) ↔ cli (`@cockpit/cli`, `dist/index.js` bin), and the
   Captain→Crew model. Match the visual style of the existing `2026-06-17-cockpit-architecture-
   overview.html` (self-contained HTML + inline CSS).
3. **`docs/architecture.html` + `docs/architecture.vi.html`** — refresh to the package layout, or
   replace their structural section with a pointer to the new diagram. Remove `src/control`-era
   structure claims.
4. **`CLAUDE.md` + `AGENTS.md`** — add a short **"Repository layout"** section: the 6 packages +
   DAG + the two bin entries. Keep it thin (AGENTS.md is canonical per the multi-agent direction).

## Master index `docs/README.md` (NEW)

A navigable map of the doc set. Sections: **Living docs** (README, architecture, CLAUDE/AGENTS,
testing checklist, current diagram); **Active specs/plans** (only the un-archived); **Decisions**;
**Research** (historical reference); **Archive** (link to each archive subdir). A short table per
section: `file | one-line purpose | status`. This is the entry point a new reader hits first.

## Junk

Delete `docs/.DS_Store`; add `.DS_Store` to root `.gitignore` if absent. Keep all `.vi.*`
translations (intentional Vietnamese companions). No `git rm` of any content doc.

## Out of scope

- Rewriting historical research/plan **bodies** to new paths — they are dated snapshots; only a
  status banner is added where archived, never a path-rewrite of the prose.
- The deferred thin-wrapper refactor (#367) and other code work.

## Validation

1. **No content lost** — `git status` shows only moves (R) + the new index/diagram + banners +
   `.DS_Store` deletion. `git log --stat` diff has zero deleted content files (only `.DS_Store`).
2. **No dangling links** — grep the new `docs/README.md` + README.md for links; every linked path
   resolves (no 404 to a moved file). Internal cross-doc links updated for moved files.
3. **Living docs accurate** — README "Monorepo structure" matches `ls packages/`; no `src/…` path
   refs remain in README/architecture/CLAUDE/AGENTS (grep clean).
4. **New diagram renders** — valid self-contained HTML; opens without external deps.
5. **Active set is real** — every doc left in `docs/specs/` + `docs/plans/` (not archived) is
   genuinely active/unshipped (spot-check the triage).
6. Build/test untouched (docs-only change) — `pnpm build` + suite still green (1298/3 #353).

## PR shape & workflow

Single PR `crew/docs-cleanup`, isolated worktree, one **claude/sonnet** crew (docs work — could
route opencode, but the triage needs judgment; use claude/sonnet). Crew uses `/gsd:plan-phase` +
`/gsd:execute-phase`. Captain reviews: spot-check the triage (nothing active archived), verify the
index links resolve, eyeball the new diagram + refreshed README, confirm no content deletions.
Squash-merge `--admin`, realign develop. Close issue #349.

## Success criteria

- `docs/README.md` master index exists and links everything.
- README / architecture / CLAUDE / AGENTS describe the 6-package monorepo; zero stale `src/…` refs.
- A new current architecture diagram exists; stale diagrams archived with banners.
- Shipped specs/plans (incl. reorg 1-7) archived with ✅ banners; `docs/specs` + `docs/plans` hold
  only active work. Research kept in place.
- Zero content deleted (only `.DS_Store`); all moves are `git mv`. Build/test green.
