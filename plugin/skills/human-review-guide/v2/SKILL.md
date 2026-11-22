---
name: human-review-guide-v2-draft
description: DRAFT, pending operator approval, NOT YET ACTIVE. v2 of human-review-guide (#1136 part 3). A core-logic-only review page driven by the risk map and local verify evidence. Do not invoke until the operator approves and this replaces plugin/skills/human-review-guide/SKILL.md.
---

# human-review-guide v2 (DRAFT, pending operator approval)

> Lives in `v2/` so v1 stays untouched. On approval, this file replaces `../SKILL.md` and `guide.v2.template.html` replaces the v1 templates. Samples: `docs/review-samples/pr-1099-high.html` (high), `docs/review-samples/pr-1162-med.html` (med).

## Policy (operator-approved 2026-11-22)

The page's tier is the PR's risk label from `squadrant verify risk`. The tier decides how much human attention the PR gets.

| Tier | Meaning | Page says |
|---|---|---|
| **high** | a high-tier path in `.squadrant/risk-map.json` is touched | Human review needed. Shows ONLY the changed core-logic hunks. |
| **med** | no high path; captain reviews | "No human review needed (captain-reviewed)" plus the evidence. |
| **low** | only low paths | "No human review needed" plus the evidence. |

## Kept from v1

- **Local only, never posted.** Never put the page, or any part, on a PR, issue, ticket or chat. Write it under `<workspace>/artifacts/review-guides/`, not in a code repo. (The samples in `docs/review-samples/` are the one exception: they are drafts for operator approval of this design.)
- **Written by the driving session** (normally the captain), which holds the context. Never hand it to a crew, side session or fresh subagent.
- **Anchors pinned to the SHA.** Every `file:line` is at the PR head SHA shown on the page.
- **Bilingual VI/EN toggle** and **interactive HTML**, not a wall of text.

## Dropped from v1

Gate-coverage section, 8-field points, severity table, stack/collapse sections, size budgets, split advice.

## Inputs

1. `squadrant verify risk --base <base> [--repo <path>]` gives `label`, `files`, and `invariants` as `{file, glob, invariant}`.
2. `.squadrant/evidence/<head-sha>.json` (steps, counts, `green`, `metaFailures`). Not CI.
3. The PR diff of each file listed in `invariants[].file`.

For a PR already merged, point `--base` at `<merge>^1` and `--repo` at a worktree at `<merge>^2`, with the current `.squadrant/risk-map.json` copied in first.

## Steps

1. Get head SHA, run `verify risk`, read the evidence file for that exact SHA.
2. **Evidence chip:**
   - no file for the head SHA: **MISSING**;
   - file SHA differs from the PR head: **STALE** (show both SHAs);
   - `green: false` or any `metaFailures`: **RED**;
   - otherwise **GREEN**.
3. **med / low:** `hunks: []`. The page shows the verdict, the evidence table and the file list. Stop.
4. **high:** for each `invariants[].file`, take the diff of that file and split it per hunk (`git diff -U2 <base> <head> -- <file>`). Only these hunks go on the page. Tests, docs and non-high files appear only in the file list. Per hunk:
   - `invariant`: the text from `verify risk`, copied verbatim;
   - `tests`: names of tests that claim to cover it. Search the PR's test diff and the existing test file for `it(...)` names that exercise the changed behaviour, and write `file › describe › it`. If none, leave `[]`; the page flags it as uncovered;
   - `question`: ONE question a machine cannot answer (intent, a contract choice, whether the test checks the right thing), as `{en, vi}`. Ground it in the diff; never ask what lint or tests already prove.
5. Fill `guide.v2.template.html` by replacing `__PAGE_JSON__` (escape `<` as `<`). Page fields: `pr`, `title`, `sha`, `tier`, `files`, `evidence` (or `null`), `hunks[{id,file,lines,diff,invariant,tests,question}]`.
6. Write it locally and `open` it. Do not post it.

## Buttons

- **OK / Concern / Note** per hunk, with a free-text note.
- **Ask for explainer** copies a prompt for the owning session (hunk id, `file:line`, PR, SHA, invariant).
- **Copy findings** copies one line per hunk: id, anchor, verdict, note.

## Rule

If the evidence is MISSING, STALE or RED, say so at the top and do not suggest the PR is ready to merge, whatever the tier.
