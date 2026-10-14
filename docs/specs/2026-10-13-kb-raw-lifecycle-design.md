# KB Raw → Rules Lifecycle: Design

- **Status:** decided 2026-10-13 (§12). Phases 1–3 built; see the phase table in §8.
- **Epic:** #893 · **Builds on:** [`2026-10-07-rules-kb-design.md`](2026-10-07-rules-kb-design.md) (D3, D4, §4, §5) and [`2026-10-10-knowledge-base-architecture-design.md`](2026-10-10-knowledge-base-architecture-design.md) (K10, §4.1)
- **Diagram:** [`docs/diagrams/2026-10-13-kb-raw-lifecycle.html`](../diagrams/2026-10-13-kb-raw-lifecycle.html)

## 1. Goal

The KB should own the whole path from a raw company document to a live rule. Today the saitex KB depends on a hand-made middle layer, `~/saitex/kb/extracted/`. When this design is built:

- `extracted/` is removed from the saitex `sources.yaml` and archived.
- No live rule cites `extracted/`.
- Raw extraction runs on `main`. No throwaway branch.
- Every operator decision about a conflict is stored in the KB, in git, and used by `apply`.
- Nothing here is Claude-only (§9).

## 2. Today, measured

All numbers are from the saitex KB at `main` = `dd29c45` and `~/saitex/kb/extracted/` on 2026-10-13.

| What | Count |
|---|---|
| Live rules | 81 (all `active`, 0 in `_proposed/`) |
| Rules that cite `extracted/` | **65** (75 citations: `coding-rules.md` 33, `pr-rules.md` 26, `clickup-ticket-rules.md` 16) |
| …that cite only `extracted/` | 58 (the other 7 also cite flooros `CLAUDE.md` or a repo file) |
| Rules with a `decision` block | 0 |
| `verdicts.jsonl` lines | 9 (the operator approvals of 13 Oct, incl. the amended testing rule) |
| `RECONCILE-LOG.md` rows | 33 on extracted files (26 corrected, 2 added, 5 kept), 35 on raw files (26 errata, 9 kept), 17 "repo docs that are stale" |
| Operator decisions | 8 rows marked "developer decision" in `RECONCILE-LOG.md`; 7 `[USER]` tags in `pr-rules.md` |
| `raw-errata.md` | 7 raw files, 37 bullets (stale items plus "still right" notes) |
| Branch `extract/raw-2026-10-12` | one commit off `12108f4`: 69 new rules, 2 proposals, 44 live rules changed (raw ref merged in) |

What the 65 rules rest on (tag scan of the quoted `extracted/` passage; ±2, Phase 4 dry run confirms):

| Basis | Rules | Where the rule can be sourced after migration |
|---|---|---|
| raw passage (`[ONB]`, `[BR]`, `[PERM]`, `[EVT]`, `[DB]`, `[CORE]`) | 26 | the same raw file |
| raw passage corrected by code (`[REPO]`) | 22 | flooros `CLAUDE.md` / handbook, or an operator decision |
| ClickUp survey (observed practice, no document) | 7 | an operator decision |
| `[USER]` only (the operator said so) | 9 | an operator decision |
| unmatched | 2 | checked by hand |

### 2.1 Current flow

```
sources.yaml ─► knowledge ingest ─► .converted/ ─► knowledge-extract skill ─► candidates.json
   ─► knowledge apply  (quote must be found verbatim; offset overlap picks the id)
        new rule                 → active  (D4: auto-live)
        same id, new meaning     → _proposed/
        model says "contradicts" → _proposed/ + conflictsWith
   ─► knowledge review (reviewer agent; operator only on escalation; verdicts.jsonl; code-vs-doc decision block)
```

The operator built the missing pieces by hand:

```
raw/ ─(operator + agent, 7–8 Oct)─► extracted/*.md ─► (listed as a project source) ─► rules
        corrections vs code        → RECONCILE-LOG.md
        stale raw passages         → raw-errata.md
        operator rulings           → [USER] tags, RECONCILE-LOG "developer decision"
```

### 2.2 The three gaps

1. **No errata.** `apply` only compares a candidate with existing rules. It cannot know that a raw passage is out of date. Source `priority` does not help: `apply` never reads it (only `review` does). `raw-errata.md` was already a listed source and `raw/**` was already lowered to `agent` (`12108f4`), yet on 2026-10-12 the operator still dropped 11 of 131 raw candidates by hand.
2. **Auto-live (D4).** A grounded candidate from any listed source goes live. To review raw extraction, it had to run on `extract/raw-2026-10-12` and wait unmerged.
3. **Decisions outside the KB.** The `[USER]` rulings and the code corrections live only in `extracted/`. Nothing in `verdicts.jsonl` or in a `decision` block records them.

## 3. Target flow

```
raw/** (review: required) ──┐
CLAUDE.md, handbook ────────┼─► ingest ─► extract ─► apply ──► errata.yaml hit?  → rejected (errata:<id>), logged
shared/decisions/** ────────┘                          │        review: required? → _proposed/ → operator
                                                       │        otherwise        → today's rules (D4, D5)
                                                       ▼
                                          knowledge review (operator walks the gated items)
```

The operator's mental model maps onto KB parts like this:

| Operator's layer | Target home | Read by |
|---|---|---|
| raw company docs | `raw/**`, `priority: agent`, **`review: required`** | ingest / extract |
| `extracted/*.md` restatements | gone: rules come from raw directly, reviewed once | none |
| `raw-errata.md` + code corrections | **`<kb>/errata.yaml`**: one entry per stale passage | `apply`, `validate` |
| `[USER]` rulings, "developer decision" rows | **`shared/decisions/<id>.md`** (decision records, K2/K10), listed as a `company` source | ingest / extract |
| keep-doc / supersede-with-code rulings on a live rule | `decision` block (exists, #898) | `review` |
| "repo docs that are stale" list | not KB data: flooros tickets, or errata if a stale line produces candidates | none |

## 4. Errata

### 4.1 Options

| Option | Verdict |
|---|---|
| A. Errata as a high-priority source; the extractor flags `contradicts` | **No.** Already tried (raw-errata.md was a source) and failed. It depends on the model, and `contradicts` can only name rules. A stale fact with no rule behind it goes live. |
| B. "Negative" rules (a rule saying "ignore section 12") | **No.** They would be delivered to agents as rules. |
| C. Edit `raw/` or `.converted/` | **No.** Raw is never edited. `.converted/` is a cache and is rebuilt. |
| D. Exclude whole sections in `sources.yaml` | **No.** Too coarse. Most stale sections also hold lines that are still right ("Still right: port table…"). |
| E. **Quote-anchored errata file, checked by `apply`** | **Yes.** Same grounding (`findQuote`) and overlap test (`spansOverlap`) that `apply` already uses. Fully mechanical. |

### 4.2 Recommended: `<kb>/errata.yaml`

A git-tracked file at the KB root, next to `sources.yaml`. Only the operator (or a crew on the operator's instruction) edits it. It is not a source: it never produces rules.

```yaml
- id: onb.pre-commit-tools
  ref: "raw/floorOS Onboarding.html"
  quote: "Runs ESLint/Ruff on staged files, typecheck on affected workspaces, commitlint, secret scan."
  reason: "The hook runs lint-staged and regeneration only."
  evidence: [".husky/pre-commit:35-97", "package.json:65-73"]
  checked: "flooros@a951f6996"
  by: operator
  at: 2026-10-08
  decision: dec.branch-naming      # optional: the decision record behind it
```

`apply` behaviour:

1. Load `errata.yaml`. If it is absent, nothing changes.
2. For each erratum whose `ref` has candidates in this file, find its `quote` in the current converted text.
3. A candidate whose grounded offset overlaps an erratum span in the same `ref` is **rejected** with reason `errata:<id>` and logged as `item.rejected`. It does not go live and does not go to `_proposed/`.
4. An erratum whose quote is no longer found is reported as **orphaned** (the raw file changed; re-check it). It shows in the apply output and in `REPORT.md`.

`validate` adds one check: a live rule grounded in an erratum passage is a warning. That catches errata added after a rule went live.

**Why reject, not `_proposed/`.** A stale passage is extracted again on every full pass. Sending it to `_proposed/` would re-ask a settled question each time, against the 2026-10-09 rule that a recorded decision is not re-asked. The 11 candidates dropped by hand on 10-12 were dropped, not deferred. Errata can target any source, including a stale handbook line (e.g. `11-dev-loop.md:62`, commitlint). This is open question Q1.

## 5. Per-source review gating

### 5.1 Options

| Option | Verdict |
|---|---|
| A. Reuse `priority: agent` to mean "needs review" (agent proposals already wait, D3) | **No.** `priority` answers "who wins a conflict". Gating answers "who lets it go live". A new company policy has top priority and may still need a first review. Mixing them makes `sources.yaml` harder to read. |
| B. **`review: required` on a `sources.yaml` entry** | **Yes.** One optional field, one validator line. Absent means today's D4. |
| C. Keep extracting on a branch | **No.** It cannot merge cleanly (§7) and leaves no verdicts. |

### 5.2 Recommended: `review: required`

```yaml
- path: raw/**
  priority: agent
  domain: process
  review: required
```

- `apply`: a candidate from a gated source that would be **created** goes to `_proposed/<id>@<sha12>.md` instead. Today's meaning-change and contradiction routing are unchanged.
- A candidate that only **merges** (same id, same meaning: adds the raw ref to a live rule) still merges. It changes provenance, not the obligation.
- `review`: a proposal from a gated source **always escalates**, at any confidence. It joins the "always escalated" list in rules spec §5. The reviewer still writes its suggestion, which the operator sees.
- The operator resolves through `squadrant knowledge review <kb>` or `--resolve`. Each answer goes to `verdicts.jsonl`, so the reviewer-agreement score now covers raw extraction too.

## 6. Migrating `extracted/`

### 6.1 Operator decisions

| `extracted/` content | Count | Goes to |
|---|---|---|
| `[USER]` rulings + "developer decision" rows | 15 mentions, about 10 distinct rulings after merging overlaps (e.g. P16 = "lead merges [USER 2026-10-08]") | one decision record each in `shared/decisions/` with `status: accepted`, `decidedBy: operator`, `decidedAt` = the original date. Statements are copied verbatim so the quotes ground. |
| ClickUp survey practice the operator relies on | 7 rules | the same kind of decision record ("we follow observed practice X"). OPEN items stay out until Hau answers. |
| RECONCILE `errata` rows (raw stale) | 26 | `errata.yaml` entries, with `evidence` and `checked` from the log |
| RECONCILE `corrected` rows (code wins over raw) | 26 | an `errata.yaml` entry on the raw quote that was wrong. The right rule comes from `CLAUDE.md`/handbook if it says so, otherwise from a decision record that cites the code evidence. |
| "kept as a team rule, not configured" (P4, P13, P14) | 3 | no new data. If a later pass raises code-vs-doc on these rules, the operator answers `keep-doc` once and the existing #898 `decision` block records it. |
| `kept` / `added` rows | 16 | nothing: the rule already exists or comes from raw/decisions |

We do **not** write `decision` blocks or `verdicts.jsonl` lines from the log. A `decision` block needs the `docRev`/`codeRev` of a real code-vs-doc escalation; values copied from a log could not be checked. The decision records and errata are git-tracked, so `git log` keeps the history.

`shared/decisions/` is the KB architecture spec's home for decision records (K2, K10, §4.1). That domain's tooling is Phase 2+ and not built. This design uses only its folder and frontmatter, read as a normal rule source. When the domain ships, the records are already in place.

### 6.2 Re-sourcing the 65 rules

1. Add `shared/decisions/**` (`priority: company`) and set `review: required` on `raw/**`.
2. Extract `shared/decisions/**` and `raw/**` on `main`. The plan lists live rules, so the extractor reuses their ids. Same-meaning candidates **merge**: the new ref is added and the rule stays live (the branch shows this works: 44 merges).
3. `squadrant knowledge sources <kb> --remove '~/saitex/kb/extracted/**' --dry-run` lists every rule that would lose its last source. Then without `--dry-run`: the entry leaves `sources.yaml`, every `extracted/` ref is stripped, and rules left with no source become `stale`. Stale rules are still delivered until the reviewer retires them, and retiring a `must`/`must-not` already escalates. (Built: a `stale` or `retired` rule may now have an empty `sources` list; the validator still requires one for every other status, and a source-less rule cannot be kept active: keep decisions escalate or are refused.)
4. Expected after step 2, from §2: 48 rules re-sourced from raw or `CLAUDE.md`, 16 from decision records, 2 by hand. Target: zero rules stale at step 3.
5. Move `~/saitex/kb/extracted/` to `~/saitex/kb/archive/extracted-2026-10-13/`, next to the existing `archive/2026-10-07/`. Nothing reads it after that.

## 7. Branch `extract/raw-2026-10-12`

It forks at `12108f4`, before the operator's two 13 Oct commits (`6127047` approved 8 proposals, `dd29c45` amended a testing rule). Merging it means conflicts in `verdicts.jsonl`, `index.json` and that rule. Its anchors also hold noise: `anchor.ts` walked `.venv/` (fixed in 0.28.1: it now lists files via `git ls-files -co --exclude-standard`, with the walk as non-git fallback) (e.g. `.venv/lib/python3.13/site-packages/huggingface_hub/_oidc.py`), and one `loc` is `'ON'`.

| Option | Cost | Verdict |
|---|---|---|
| Review and merge the branch | conflicts; no verdicts; errata not applied | No |
| Re-extract raw on `main` after Phases 1–2 | one full extraction pass of model tokens | Fallback |
| **Replay the branch on `main`**: build `candidates.json` from the branch's 71 added files (statement, quote, ref, loc, triggers already there) and run `apply` | no model call; errata and gating apply | **Recommended** |

The replay is a short script a crew writes and runs once. It is not a new CLI command. The raw files have not changed since 10-12, so the quotes still ground. The 71 items become gated proposals for the operator to walk. Keep the branch until the replay is reviewed, then delete it (Q3).

## 8. Phases

| # | Phase | Repo | Effort | Status |
|---|---|---|---|---|
| 0 | This spec + diagram | squadrant | - | done |
| 1 | `review: required`: shared type + validator, `apply` routing, always-escalate in `review`, tests, docs | squadrant | S, ~0.5 day | **built** (feat/kb-review-required) |
| 2 | `errata.yaml`: shared type + validator, loader, `apply` filter, orphan report (apply + `REPORT.md`), `validate` check, tests, docs | squadrant | M, ~1 day | **built** (feat/kb-errata) |
| 3 | `knowledge sources <kb> --remove <path> [--dry-run]`: strip refs, mark source-less rules stale, tests, docs | squadrant | S, ~0.5 day | **built** (feat/kb-sources-remove) |
| 4 | saitex migration: write `errata.yaml` (from 26 errata + 26 corrected rows) and about 10–15 decision records; edit `sources.yaml`; replay the branch; extract decisions; operator review | saitex KB | crew ~1 day + operator ~1–2 h for ~70 escalations | planned |
| 5 | `--remove` extracted, archive the folder, delete the branch, `validate` green | saitex KB | ~0.5 h | planned |

**Ops hazard (Phase 4):** never check out a review branch in the live KB checkout. Inject serves whatever is checked out (10-12 incident, ~10 min). Use a separate worktree or clone.

Phases 1–3 are independent (one crew each, or one crew in sequence). Phase 4 needs 1–3 released. Not in scope: the anchor walk skipping `.venv/` and gitignored dirs (found in §7; fixed separately in 0.28.1).

## 9. Multi-agent

Everything is plain files plus CLI: `sources.yaml`, `errata.yaml`, decision records in markdown, `squadrant knowledge …`. Extraction and review stay in the portable `knowledge-extract` / `knowledge-review` skills. No hook, tool or setting is Claude-only, so codex, opencode and gemini crews run every phase the same way.

## 10. Test plan

Unit tests (Phases 1–3), next to the existing ones in `packages/core/src/__tests__/knowledge-*.test.ts` and `packages/shared/src/__tests__/knowledge.test.ts`:

- `validateSourceEntry` accepts `review: required` and rejects other values.
- Gated source: a new candidate lands in `_proposed/`; a same-meaning candidate still merges; an ungated source behaves as today.
- Review: a gated proposal at confidence 0.95 still escalates.
- Errata: an overlapping candidate is rejected with `errata:<id>`; a candidate in another part of the same file passes; an erratum on a non-raw source works; a missing quote is reported as orphaned; no `errata.yaml` means no change.
- `validate` warns on a live rule grounded in an erratum passage.
- `sources --remove`: dry run writes nothing; the real run strips refs, marks source-less rules `stale`, and leaves rules with another source `active`.

Acceptance on saitex (Phase 4–5):

- `grep -r "extracted/" shared projects` finds nothing; `extracted/**` is gone from `sources.yaml`.
- `squadrant knowledge validate saitex` passes. Live count is 81 plus approved proposals, minus rules the operator retired.
- Re-extracting `raw/**` drops the 11 candidates the operator dropped by hand on 10-12, each with an `errata:` reason.
- A test raw candidate never goes live without an operator verdict in `verdicts.jsonl`.

## 11. Docs to update

Each phase updates its docs in the same PR. Docs and diagrams never trail the code.

| Phase | Files |
|---|---|
| 1 | `docs/reference.md` knowledge section (`sources.yaml` fields, always-escalated list); rules spec §3 `sources.yaml` + D4 note + §5 always-escalated; `plugin/skills/knowledge-review/SKILL.md` "Always escalated"; `plugin/skills/knowledge-extract/SKILL.md` (gated sources land in `_proposed/`); `SOURCES_TEMPLATE` comment in `sources.ts`; this spec's diagram (mark built) |
| 2 | `docs/reference.md` (errata file, apply output, `validate` check); rules spec §3 store layout + §4 step 4/5 table; KB architecture spec §4 layout (`errata.yaml`); `knowledge-extract` skill (errata rejections in the report); diagram |
| 3 | `docs/reference.md` command table; rules spec §5 manual commands; `knowledge-review` skill if stale-from-removal needs a note; diagram |
| 4–5 | saitex KB only (no squadrant docs); this spec's status line → "migrated" with final counts |

## 12. Decided 2026-10-13

The operator answered the open questions on PR #963.

| # | Question | Decision |
|---|---|---|
| Q1 | A candidate that hits an erratum | **Rejected** as `errata:<id>`. It is not sent to `_proposed/`. |
| Q2 | Who approves gated proposals | **Always the operator.** The reviewer agent may not approve them. |
| Q3 | Branch `extract/raw-2026-10-12` | **Replay it on `main`** as a candidates file. Do not merge the branch. |
| Q4 | The 7 ClickUp-survey rules | OBSERVED practice becomes decision records now ("we follow observed practice X"). OPEN items (awaiting Hau) stay out of the KB until answered. |
| Q5 | The 17 "repo docs that are stale" rows | They become `errata.yaml` entries. No flooros tickets. |
| Q6 | Who edits `errata.yaml` and `shared/decisions/` | A crew, on the operator's instruction. The operator approves the diff. |
