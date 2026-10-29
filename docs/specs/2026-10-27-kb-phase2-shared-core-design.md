# KB Phase 2: Shared Core (#979): Design

- **Status:** brainstormed with the operator 2026-10-26/27 (research side-session); all decisions below were made by the operator in chat unless marked *builder's call* or *side-session call*.
- **Issue:** #979 (kb phase 2: shared core) · **Epic:** #893 (knowledge base) · **Unblocks:** #980 (phase 3: decisions), #981 (phase 4: distill + wiki), #984 (phase 7: export), #991 (profile S2: situational tier + scoring), #992 (profile S3: shared writer + gate registry + `_user` reconcile)
- **Parent specs:** [`2026-10-10-knowledge-base-architecture-design.md`](2026-10-10-knowledge-base-architecture-design.md) (called "arch spec" below; K1–K12 are its decision table §2) · [`2026-10-15-user-profile-design.md`](2026-10-15-user-profile-design.md) ("profile spec"; P1–P15 are its decisions) · [`2026-10-13-kb-raw-lifecycle-design.md`](2026-10-13-kb-raw-lifecycle-design.md) · [`2026-10-15-rule-outcome-signals-research.md`](2026-10-15-rule-outcome-signals-research.md) (#945)
- **Supersedes:** the #979 issue body where they differ (see §9).

## 1. Why

Phase 1 built the knowledge base for one domain (rules). Profile S1 (#982, PR #993) then built a second, separate stack for `_user/profile`. Three more domains are waiting (decisions, wiki, the rest of profile), and each needs the same plumbing: an item model, home resolution, merged read, matching and injection, scoring, a safe write path and propose/review. Phase 2 builds that once.

What hurts today, measured on 2026-10-26/27:

1. **KB repos are left dirty.** Rules writes (`knowledge apply`, `review --apply`, the escalation resolve path, `sources --remove`) change files and never commit. The live <company> KB has a modified `index.json` and untracked `_proposed/` files. Only profile (`commitProfilePaths`, `packages/core/src/knowledge/profile.ts:226`) and `reconcile --finish` (#1002) commit.
2. **Proposals pile up as duplicates.** `_user/profile/_proposed/` held 17 proposals (27 by 2026-10-27), all from the native-memory bridge. Many restate an active trait. Example: "early UI screens go on one tmp branch" exists as active `prof.early-ui-one-tmp-branch` plus proposals `early-ui-single-branch` and `one-tmp-branch-early-ui`. Cause: the captain applies a correction with `profile add --apply` *and* writes native memory, and the bridge re-imports the memory an hour later; two projects' memory dirs carried the same fact. Only exact-id dedup exists (`profile-write.ts:139`).
3. **Effectiveness can't be read off.** `knowledge stats` shows only <company>. The audit log holds 2,879 `item.surfaced` events for `_user/profile` that no report shows. The audit `domain` field holds rule categories (`coding`, `authz`, `pr`, `domain`), 128 events have `kb: ""` (project-level rules, never scored because `scoreKb` filters on kb, `scores.ts:234`), and 181 events have `kb: "t"` (test runs leaking into the real audit log, the #972 class of bug).
4. **Five issues are blocked on this one.**

## 2. Goals (operator)

Phase 2 is done when all four hold:

1. **A KB repo is never dirty after a squadrant write.** Every file in a KB repo is either committed by the write that changed it or git-ignored.
2. **No duplicate proposals.** A proposal that restates an existing item becomes an update to that item or is not written.
3. **Every blocked issue is unblocked.** #980, #981, #984, #991 and #992 can start without adding shared plumbing of their own (contract in §7).
4. **Every KB item is logged, tracked and scored, so the operator can tell whether it is useful.** One `knowledge stats` covers every KB including `_user`, every domain, with correct numbers.

**Non-goals:** domain-specific formats and gates (phases 3–5); automatic outcome signals (#945 decides; phase 2 only makes room); non-Claude delivery (#900); a visual dashboard (correct numbers first; a view can come later); T1/T2 match tiers (#902); state/workspace path moves (#983).

**Anti-goals (would be a failure even if it "works"):** a second write path that must be kept in sync with the first; a cross-company item reaching a session; any change to the rule file format or to the 191 live <company> rule files; a dedup step that silently drops content.

## 3. Decisions made

| # | Decision | Replaces |
|---|---|---|
| D1 | **Writer = one shared commit function, called directly.** Generalize `commitProfilePaths` into `commitKbPaths(kbRoot, paths, {message, trailers})`: `git add -- <paths>` + `git commit --only -- <paths>`, `-c commit.gpgsign=false`, bounded timeout, 3× retry on `index.lock`, refuses any `_proposed/` path, five trailers `Domain:` `Item:` `Level:` `Session:` `Approved-by:`. **No daemon socket method.** `--only` plus git's own `index.lock` already serializes concurrent writers; a daemon path would be a second write path to keep in sync. | arch spec K9 + §5.4 (daemon single writer + bypass); #979 2b "daemon socket method"; `write.daemon-bypass` event |
| D2 | **Dedup is three-way and judged by the proposing agent.** A local, deterministic prefilter (token overlap of summary + body) returns the top 3 candidates among active and proposed items of the same domain in the target KB. The agent that is proposing (already an LLM) decides: **duplicate** (writes nothing), **extends** (writes an update proposal against the existing id with a merged body), **new** (writes a new proposal with a stated reason). The bridge has no agent: when a candidate passes the threshold it always writes an **update proposal** carrying both texts, merged at review. **No external model (Jev) in phase 2**: the operator judges the category immature (research parked 2026-10-20), and it stores inputs by default. When #945 picks a judge, dedup may reuse it. Dedup is generic and lives in 2b-2, not in profile S3. | profile spec §7 "similar existing traits hint" (moved here) |
| D3 | **The folder decides the KB domain.** A file under `…/rules/` is a rule, under `…/decisions/` a decision, and so on. Rules keep frontmatter `domain:` as their **category** (no file changes). For other domains, a frontmatter `domain:` must equal the folder or validation fails. In code: `kbDomain` for the KB domain, `category` for a rule's category. CLI: `--domain` means KB domain (`rules|decisions|wiki|profile`); the rule category flag becomes `--category`. For one version, a `--domain` value outside the four domains is treated as a category with a deprecation line. | #979 "domain-field collision (needs an operator call)" |
| D4 | **Reserved id prefixes.** `dec.` = decisions, `wiki.` = wiki, `prof.` = profile; rules keep `<category>.<slug>`. A rule category may not be `dec`, `wiki` or `prof`. Each non-rules domain requires its prefix. Ids are therefore globally unique and the domain is readable from the id; the cite scan and scores need no `(domain, id)` key. No existing file is renamed. | #979 "pick one prefix rule per domain" |
| D5 | **Home resolution, four rules (arch §3), writes create, reads never do.** (1) `projects.p.knowledgeHome` (`kb:<name>` or `repo:docs`); (2) group mapped to a KB → `<kb>/projects/<p>/`; (3) group with no KB → on first write `git init` a local KB named after the group, write `groups.<g>.kb` to config, log `kb.created`; (4) no group → `personal/projects/<p>/`, and the `personal` KB is created on first write by the same mechanism. `personal/shared/` is the shared home for personal projects, as `<company>/shared/` is for company projects. `squadrant doctor` suggests (never writes) `knowledgeHome: "repo:docs"` for the squadrant project, which lacks it in the live config. | `homeKb` / `projectRulesHome` (`shared/src/knowledge.ts:219,234`) which return `undefined` for rules 3–4 |
| D6 | **`repo:docs` writes files only, never commits.** The project repo is a code repo with branches, worktrees and PR review; a knowledge write there is a working-tree diff that goes through a PR like any docs change. Goal 1 applies to KB repos. | — |
| D7 | **What lives in a KB repo.** Committed: item files, `sources.yaml`, `errata.yaml`, `REPORT.md`, `_archive/`, `_dropped.yaml`. Git-ignored in every KB: `**/_proposed/`, `scores.json`, `escalations.json`. Moved out: `index.json` → `~/.cache/squadrant/index/<kb>.json` (K8); `verdicts.jsonl` → per-machine file under the state dir (it is append-only and conflicts across machines, lifecycle spec). Proposals are never committed in any domain (profile P15 extended to all domains); the audit log keeps `item.proposed`. Cost accepted: a proposal is reviewed on the machine that created it. | rules `_proposed/` untracked-not-ignored; tracked `index.json` / `verdicts.jsonl` |
| D8 | **Three PRs, two in parallel.** 2a (read side + observability) and 2b-1 (writer + clean KB) start now in parallel crews; 2b-2 (propose / review / promote + dedup + auto-create) starts after both merge. | #979 "2a then 2b" |
| D9 | **Observability is a phase 2 goal** (goal 4), scoped to correct numbers, not a dashboard (§4.6). | — |
| D10 | **Two gate modes, one `confirmed` field.** The gate registry supports (a) *propose → approve* and (b) *apply now, confirm later*: the item is live at once with `confirmed: false` and sits in a shared "unconfirmed" queue in `knowledge review` until the operator confirms, edits or drops it. Profile corrections already work this way. **Decisions move to mode (b):** a decision recorded by the captain or operator is `accepted` immediately with `confirmed: false`; crews still only propose. An unconfirmed decision is injected with an `(unreviewed)` label and **ranks below the operator's live instruction** in the precedence line; once confirmed it takes its normal place (above it). The field is named `confirmed` in every domain (not `reviewed`). Phase 2 builds the two modes and the shared queue; #980 registers the decisions gate. | arch spec K10 decisions row ("only the operator sets `accepted`"); #980 `knowledge accept` as the only path to accepted |

## 4. 2a: read side + observability

Touches: `packages/shared/src/knowledge.ts`, `packages/core/src/knowledge/{store,layers,search,match,inject,scores,reconcile,cite,audit,index-file}.ts`, a new `packages/core/src/knowledge/items.ts`, CLI `knowledge` / `rules` commands, `doctor`.

### 4.1 Item model
- `KbItem` in `shared/src/knowledge.ts`: `id, kbDomain, kb, level (shared|project), project?, status, sources (string refs), created, updated, summary?, body, triggers?, path, origin`. Rules keep their own `Rule` type and adapt onto `KbItem` (category, `RuleSourceRef` objects); **the rule file format does not change**.
- One loader per `<level>/<domain>/` folder; loaders recurse (rules sit in `shared/rules/<category>/*.md`), skip `_proposed/` and `_archive/`, and use `git ls-files` for repo scans (#971).
- Profile adapts its existing `Trait` (`profile.ts:29`) onto `KbItem`; it already has the §4.1 shape. Do not duplicate its parser or validator.
- Decisions get a loader now (the 19 live `<company>/shared/decisions/dec.*.md` must load), but no injection or gate (phase 3).
- `sources:` refs (`artifact:` `issue:` `commit:` `file:` `raw:` `memory:`) go through one normalizer (#970 lesson).
- Validation of the common fields + D3 + D4 for every domain folder, in `knowledge doctor`.

### 4.2 Home resolution and read set
- `resolveKnowledgeHome(cfg, p)` → `{ kind: "kb", kb, dir(domain) } | { kind: "repo", dir(domain) } | { kind: "pending-create", kb, dir(domain) }` implementing D5. `homeKb` / `projectRulesHome` become thin wrappers.
- **Read set** (arch §3): `_user/profile` → group KB `shared/` → home → each `projects.p.knowledge[]` KB's `shared/`. `_user` resolves via `userKbDir` (`SQUADRANT_USER_KB_DIR` > `knowledgeBases._user.path` > default). `_user` is a reserved name accepted by the registry even though `KB_NAME_RE` (`shared/src/knowledge.ts:16`) rejects it for `knowledge init`.
- A `pending-create` home contributes nothing to reads.

### 4.3 Merged view
- `knowledge list --project <p> [--domain] [--level]`, `knowledge search`, `knowledge show <id>`. Each item carries an origin label (`[<company>/shared]`, `[… → overridden by projA]`).
- `squadrant rules list|search|show` keep working unchanged, as `--domain rules`.

### 4.4 Generic matcher and injection (Claude delivery)
- `searchRules` / `matchPaths` / `applyBudget` / `computeRulesInjection` take `KbItem`. Phase 1 thresholds stay (`PROMPT_MIN_SCORE` 8, single-term 13, `inject.ts:14,16`), as does the once-per-session seen set.
- Session start: must/must-not rules + a one-line index (`[id] summary`) of the read set's other domains, **excluding `_user/profile`** (delivered by its own hook, #982) and, for now, decisions (phase 3 adds accepted ones) and wiki (phase 4). ≈800 tokens, overflow → `+N more: squadrant knowledge list`. The arch §6 precedence line is injected with the block.
- Prompt start / after Read: any item with `triggers` can match (this is what #991 and phases 3–4 plug into). Domains opt in to injection; in 2a only rules are opted in.

### 4.5 Scoring for every domain
- The `known` set (`reconcile.ts:25` `finishReconcile`) comes from every domain's loader, including `_user`. Keep the known-only filter (#964).
- The dead-domain alarm uses a fixed list of the four domains, so a domain with zero events in 30 days alarms (today `scores.ts:207` only sees domains that have events or known items).
- New audit writes carry `domain` = KB domain and a separate `category` for rules; `level` is `shared|project`; project-level events carry the home KB (fixes `kb: ""`, `audit.ts:84` `ruleAuditScope`, `extract.ts:119`, `review.ts:191`).
- Drop the #979 bullet "add `source` to `item.outcome`": done in #945 Phase A (`audit.ts:30,39`).

### 4.6 Observability (goal 4)
- **One view:** `knowledge stats` with no `--kb` covers every configured KB plus `_user`, grouped by KB then domain; `--domain profile` works. Scores for `_user` are computed even though it has no reconcile/home captain.
- **Normalize legacy audit lines on read** (never rewrite the log): `domain` not in the four domains → `kbDomain: rules` with that value as `category`; `level: "group"` → `shared`; `kb: ""` with a project → that project's home KB; events whose `kb` is neither a configured KB nor `_user` (e.g. `"t"`) are ignored and counted in a `doctor` line.
- **Find and close the test leak** that writes `kb: "t"` to the real audit log (every test path must honour `SQUADRANT_AUDIT_DIR`). Add a guard test.
- **Cite scan for every domain:** `cite.ts` scans for any delivered id, including `prof.*` (surfaced by the profile hook). D4 makes the bare-id map safe.
- **Index → cache (K8):** compile to `~/.cache/squadrant/index/<kb>.json` (overridable by env for tests), stop writing `<kb>/index.json`, print a one-line `git rm --cached index.json` hint; `doctor` rebuilds it.

## 5. 2b-1: writer + clean KB (parallel with 2a)

Touches: `profile.ts` (extract the function), a new `packages/core/src/knowledge/write.ts`, the rules write call sites, `.gitignore` handling, `doctor`. Does not touch loaders, matcher or scores.

- `commitKbPaths` per D1, with an env override for the KB root in tests. Profile S1 switches to it with no change in commit format.
- **Route every existing KB write through it:** `knowledge apply` (one commit per run, repeated `Item:` trailer), `review --apply`, escalation resolve, `sources --remove`, `knowledge init`, `reconcile --finish` (already `--only`; switch to the shared function). Single-item operations: one commit per item.
- **On commit failure** the file write stands (files are the source of truth) and a warning is printed; `knowledge doctor` lists uncommitted KB files and `--fix` commits them (same contract as `profile list --check --fix`).
- **D7 layout:** `knowledge init` and `doctor --fix` ensure the KB `.gitignore`; `verdicts.jsonl` moves to the state dir with a one-version fallback read of the old path.
- **D6:** writes whose home is `repo:docs` never call `commitKbPaths`.
- **Live cleanup:** after 2a + 2b-1 land, `knowledge doctor --fix` on <company> leaves `git status` clean (operator runs it; the PR must not touch the live KB).

## 6. 2b-2: propose / review / promote + dedup + auto-create (after 2a and 2b-1)

- **`knowledge propose --domain <d> --level auto|shared|project --evidence <ref> [--file body.md] [--updates <id> | --new --reason "<text>"]`.** Body from file or stdin, never argv (#865). Writes to `<home>/<level>/<domain>/_proposed/`, or `_user/profile/_proposed/` for profile. `--level auto` → project home (arch §3).
- **Dedup (D2):** without `--updates` / `--new`, if the prefilter finds candidates above the threshold, the command writes nothing, prints the candidates (id, summary, score) and how to rerun, exits non-zero, and logs `item.suppressed` with `reason: "duplicate-candidate"`. `--updates <id>` writes `<slug>.update.md` with `updates: <id>` (the profile S1 update-proposal form, generalized). `--new` writes a new proposal and records the reason.
- **Bridge:** above-threshold candidate against an active trait → update proposal with both texts; never a silent drop.
- **Threshold:** *builder's call*, tuned on a fixture copy of the live `_user/profile/_proposed/` (the known restatements in §1 must be caught; unrelated traits must not).
- **The old rules-only form** (`--kb`, statement as argv, `--domain <category>`) keeps working for one version with a deprecation line.
- **`knowledge review`, generalized:** a per-domain gate registry (K10) with `validate(item, previous?)`, `apply(...)` and a mode (D10: propose→approve or apply-now/confirm-later); the shared unconfirmed queue lists `confirmed: false` items of every domain; **fails closed** on a missing or broken gate config (#965). Rules plug in unchanged. Proposals of a domain with no registered gate are listed and never applied. `knowledge review _user` is accepted.
- **`knowledge promote <id>`:** project → `shared/` in the same KB, via the writer; logs `item.promoted`.
- **Auto-create (D5 rules 3–4):** group KB and `personal`, `git init`, config write, `kb.created` (added to `AuditEventName`, `audit.ts:8`). Env override for tests. **Trigger (operator, 2026-10-27):** any write (propose included) from a **non-crew** session may auto-create; a crew write to a not-yet-created home is refused with "home not created yet: signal the captain". Config is never written from a crew session.

## 7. Contract: what each blocked issue gets

| Issue | Needs from phase 2 | Provided by |
|---|---|---|
| #991 profile S2 | `KbItem` for traits; generic matcher with `triggers`; seen set; profile in `known`; `knowledge stats --domain profile` | 2a |
| #992 profile S3 | shared writer (`commitKbPaths`); gate registry; `knowledge propose --domain profile` / `knowledge review _user` plumbing; dedup + update proposals (so S3's "similar traits hint" is already done) | 2b-1, 2b-2 |
| #980 decisions | decisions loader (`dec.` ids, folder domain); index line + matcher opt-in hook; gate registry with `validate(item, previous)` and the apply-now/confirm-later mode + shared unconfirmed queue (D10); `(unreviewed)` label support in injection; writer; scoring/cite | 2a, 2b-2 |
| #981 wiki (4a) | wiki loader (`wiki.` ids); matcher by topic and path; index line opt-in; writer; gate registry; `item.outcome` `source: reconcile` (exists) | 2a, 2b-1, 2b-2 |
| #984 export | merged read set with origin labels; status filter per domain; `repo:docs` home detection (export is a no-op there) | 2a (+ phases 3, 4a) |

## 8. Acceptance criteria

**2a**
- [ ] Unit: home resolution covers all four rules, returns `pending-create` for 3–4, and `repo:docs`.
- [ ] Unit: read-set order; **isolation**: with two company KBs, no cross-company item in `list`, `search`, `show`, injection or stats.
- [ ] Unit: loaders recurse rule categories, skip `_proposed/`/`_archive/`, load the 19 <company> decision records (fixture copy) and the live trait shape.
- [ ] Unit: D3 (folder vs frontmatter `domain`) and D4 (reserved prefixes) validation.
- [ ] Unit: scores from a fixture with events from ≥2 domains including `_user`; legacy lines (`level: "group"`, category in `domain`, `kb: ""`) count correctly; `kb: "t"` is ignored.
- [ ] Unit: the dead-domain alarm fires for a domain with zero events in 30 days.
- [ ] Unit: a `prof.*` id in a DONE message after it was surfaced logs `item.cited`.
- [ ] Guard: no test writes to the real audit dir.
- [ ] `<kb>/index.json` is no longer written; the index rebuilds after `rm -rf` of the cache dir.
- [ ] `squadrant rules search|list|show` and all Phase 1 rules tests pass unchanged.

**2b-1**
- [ ] Integration: each rules write command leaves the fixture KB's `git status` clean, with the expected commit count and five trailers.
- [ ] Integration: concurrent writers (two processes) both commit their own paths; neither sweeps the other's.
- [ ] Unit: `_proposed/` paths are refused; `.gitignore` is ensured; `verdicts.jsonl` written to state dir, old path still read.
- [ ] Unit: a `repo:docs` write produces files and no commit.
- [ ] Integration: two-machine simulation (two clones, per-machine audit + verdicts, both push/pull) with no conflicts.
- [ ] Profile S1 tests pass unchanged.

**2b-2**
- [ ] Unit: dedup on the live-proposal fixture: restatements stop with candidates; `--updates` writes an update proposal; `--new` writes a new one with its reason; the bridge writes update proposals, never drops.
- [ ] Unit: gate registry fails closed; an ungated domain's proposals are listed, never applied.
- [ ] Unit: a fixture gate in apply-now/confirm-later mode makes the item live with `confirmed: false`, lists it in the shared queue, and confirm/edit/drop each produce one commit.
- [ ] Unit: `propose --level auto` → project home; `promote` moves to `shared/` and logs `item.promoted`.
- [ ] Unit: auto-create for a group KB and for `personal`, with config write and `kb.created`.
- [ ] Integration: propose → review → apply = exactly one commit with five trailers.
- [ ] Unit: the old `propose --kb … --domain <category>` form still works with a deprecation line.

**All PRs:** `docs/reference.md` knowledge section and the KB architecture diagram updated in the same PR; the captain runs its own isolated e2e on a dev daemon before asking to merge.

## 9. Changes to other documents and issues (apply in the PRs, or by the captain)

- **Arch spec:** K9 and §5.4 amended by D1 (no daemon writer, no `write.daemon-bypass`); §4 layout amended by D7; §3 note for D6. Status line links this spec.
- **Profile spec:** §7 "similar existing traits hint" moved to phase 2 (D2); §8 S3 row: "writes through the daemon single writer" → "through `commitKbPaths`".
- **#979 body:** replace the 2a/2b split with 2a / 2b-1 / 2b-2 (D8); drop the daemon socket, `write.daemon-bypass` and `item.outcome source` bullets; add goal 4 and the observability bullets. (Captain posts a comment; ask the operator first.)
- **#992:** drop "exactly one daemon commit … with the daemon down, the direct commit runs and logs `write.daemon-bypass`"; replace with "one commit via `commitKbPaths` with all five trailers". The similar-traits hint is delivered by 2b-2.
- **#980:** "the phase 2 writer refuses a body change" → "the decisions gate's `validate` refuses …". Rewrite the gate per D10: captain/operator records are `accepted` + `confirmed: false` at once; `knowledge accept` becomes the operator's confirm (or is replaced by the shared review queue); unconfirmed decisions are injected with `(unreviewed)` below the live instruction; body immutability applies once `confirmed: true`.
- **Arch spec K10 and §6 precedence line:** amend per D10.

## 9a. Side-session calls (from the builder check; operator to confirm while reading)

- **C1: every proposal writer goes through one core `proposeItem()`** with dedup: `knowledge propose`, `profile add` (with or without `--apply`; an applied correction that matches an existing trait also needs `--updates`/`--new`, which is where #992's `violated` signal hooks in) and the bridge. `profile add` becomes a thin wrapper over the same core function, so there is no second write path. Source extraction (`knowledge apply`) keeps its existing reviewer pair-dedup (`review.ts` `pairs`); reconcile outputs are themselves merge proposals and are exempt.
- **C2: bridge vs a pending proposal.** If the best match is a pending (uncommitted) proposal, the bridge appends the new source and text to that proposal instead of writing a second one (one proposal per fact). A proposal holding more than one text cannot be kept as-is: `review --keep` refuses it and asks for `--edit` with the merged body, so trait bodies never grow by concatenation.
- **C3: `knowledge doctor --fix` scope.** Mechanical fixes run without asking: ensure `.gitignore`, `git rm --cached index.json verdicts.jsonl`, commit that. Item files changed outside a squadrant write (today in <company>: three modified items, two untracked rules) are **listed, never committed silently**; on a TTY the operator may commit them with a y/n (`Approved-by: operator`, `Session: -`); refused in crew sessions and with no TTY. 2b-1 owns the untracking for both files; 2a only stops writing `index.json`.
- **C4: stats labels for non-KB homes.** Events and items of a `repo:docs` home are labeled `repo:<project>` and shown in `knowledge stats`. Events whose project has no resolvable home are grouped under `(no home)`, shown, and reported by `doctor`. Nothing is silently dropped except events whose `kb` is a value no config or project ever had (the `"t"` test leak).
- **C5: verdicts across machines.** Verdicts follow the audit log exactly: per-machine file `verdicts/YYYY-MM.<machine-id>.jsonl` under the same state root, and scoring reads every machine's file it can see. Cross-machine numbers are therefore exactly as complete as the audit log's.

## 10. Left to the builder

- Exact `KbItem` field names beyond those listed, file/module boundaries, and how `Rule` adapts.
- The token-overlap formula and dedup threshold (tuned on the fixture).
- Env var names for the index cache, verdicts state path and auto-create root (one per new state path, #972 lesson).
- Whether `item.suppressed` for dedup gets its own `reason` enum or a free string.

## 11. Side notes (not phase 2 code)

- Three active profile traits are <company>-specific and by P1 belong in the <company> KB: `prof.early-ui-one-tmp-branch`, `prof.core-merge-pin-pr`, `prof.ui-only-screens-draft-prs`. They landed in the profile because only `profile add` existed. Route them at the next `squadrant profile review` (no code).
- The current proposal queue can be cleaned with one `squadrant profile review` pass before 2b-2 lands.
- #982's issue is still open although S1 merged (PR #993); close it or retitle it to point at #991 / #992.
