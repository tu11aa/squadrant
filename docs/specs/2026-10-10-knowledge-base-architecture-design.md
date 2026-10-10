# Knowledge Base Architecture: Design

- **Status:** brainstormed with the operator 2026-10-10 (research side-session); sections 1–4 approved in chat; **awaiting operator spec review**
- **Epic:** #893 · **Supersedes parts of:** `docs/specs/2026-10-07-rules-kb-design.md` (D2 storage, §7 file naming; see §10)
- **Related:** #894 (profile), #885 (learnings), #886 (wiki), #865 (learnings reconcile), #555 (group knowledge), #896–#902 (rules KB), #662 / #717 (projection), #641 / #627 (boot brief), #556 (crew memory guard)
- **Research:**
  - spoke `reports/2026-10-10-knowledge-base-taxonomy-research.md` (≈25 systems surveyed)
  - `reports/2026-10-10-kb-gap-analysis.md`
  - `reports/2026-10-10-hub-spoke-structure.html`
  - `reports/2026-10-10-kb-repos-layout.html`

## 1. Goal

All durable knowledge squadrant keeps for its agents lives in **one Knowledge Base feature**, split into clearly separated **domains**, at clearly separated **scopes** (user, group/company, project), with **isolation between owners**: one company's knowledge never reaches another company's sessions.

**Success:**
- Every knowledge item has exactly one home, one domain, one owner, and a git history.
- No write path and no read path depends on a model *remembering* to do something. Every path has a named trigger.
- Every domain and every item is **logged and scored** (proposed → surfaced → cited → outcome), and a domain that stops being written or read is flagged within 30 days.
- Every domain is **reconciled** (cleanup, compression, dedup, staleness) against its own ground truth, proposal-only.
- Works for claude, codex, opencode and gemini. No agent reads files outside its cwd.

**Non-goals:**
- The profile's capture signals and confirm UX in detail (#894 spec).
- Rules extraction internals (rules spec §4–§5, unchanged).
- Multi-user / team permissions beyond "whoever can access the KB repo's remote".

## 2. Decisions made

| # | Decision |
|---|---|
| K1 | **Four domains:** Profile, Rules, Wiki, Decisions. Handoff (working state) and Recall (claude-mem, native memory) are adjacent and not owned. **Procedures fold into Profile** (personal workflows) and the wiki's how-to section (project workflows). Plugin skills are product code, not KB. **Learnings are a step, not a store** (§5). Glossary, entities and stakeholders are wiki page types. |
| K2 | **Wiki = the project's current state** (descriptive, rewritten in place). **Decisions = decision records** (ADR-style, append-only, `superseded-by`). They are separate domains. |
| K3 | **Scopes via named KBs + subscription.** Every scope is a named KB: user (`_user`), group/company (e.g. `saitex`), personal projects (`personal`), external libraries. A **group maps to a KB and its projects inherit it** (option C); projects may subscribe to extra KBs read-only. |
| K4 | **Isolation = one git repo per owner.** `~/squadrant/kb/` is a plain directory of independent repos (like `~/code/`), never one repo. A remote is optional: `git init` locally is the default. |
| K5 | **Each project has exactly one home** where its knowledge is written: (a) its company KB under `projects/<p>/` (B1, default for client work); (b) the `personal` KB (private personal projects); or (c) **in-repo** `repo:docs` for the operator's open-source projects (e.g. squadrant itself). **An opt-in export** copies decisions and wiki into a project repo on request. |
| K6 | **Profile lives only in `_user`.** It is read into every session and never written anywhere else, including in-repo homes of public projects. |
| K7 | **Storage by lifecycle:** KB repos in `~/squadrant/kb/`; exchange in `~/squadrant/workspace/<project>/` (replaces spokes); state in `~/.local/state/squadrant/`; cache in `~/.cache/squadrant/`. Obsidian is dropped (it was only a viewer). |
| K8 | **Markdown + YAML frontmatter is the source of truth.** The SQLite/FTS index is derived, lives in cache, and can be rebuilt at any time. |
| K9 | **The daemon is the single writer** for KB commits and the audit log. The CLI and hooks talk to it over the socket. |
| K10 | **Write gates per domain:** wiki = captain applies (citations required); decisions = captain records `proposed`, **only the operator sets `accepted`**; rules = rules spec D3/D4; profile = operator confirms in batches, except **explicit corrections ("don't do X"), which apply immediately** and are listed at the next checkpoint for removal. Crews only propose (#556). |
| K11 | **Logging, scoring and reconcile apply to every domain**, with one shared event schema and one shared scheduler. Each domain has its own ground truth for reconcile. |
| K12 | **Unused-expiry: 60 days** without being surfaced or cited → archive proposal (wiki, profile). Decisions never expire. Rules follow source hash. |

## 3. Scope model

```
_user  (profile)                    ← every session, every project
  │
  ├─ group KB  (e.g. saitex/shared) ← every project in the group
  │    └─ project home (saitex/projects/flooros)
  └─ extra subscribed KBs (read-only, e.g. solidity-conventions)
```

**Home resolution** for project `p`:
1. `projects.p.knowledgeHome` if set: `"kb:<name>"` or `"repo:docs"`.
2. Else, if `p` has a `group` mapped to a KB (`groups.<g>.kb`): `<kb>/projects/<p>/`.
3. Else, if `p` has a `group` with no KB mapping: auto-create a **local** KB named after the group on first write (`git init`, no remote), map it, and log `kb.created`. Isolation holds by default.
4. Else: `personal/projects/<p>/`.

**Read set** for a session in `p`, in this order: `_user/profile` → `<groupKB>/shared` → home → each `projects.p.knowledge[]` KB's `shared/`.

**Level routing on write:**
- An item that affects more than one project goes to `<kb>/shared/`; anything else goes to the project home.
- When unsure, use the project home. `squadrant knowledge promote <id>` moves it to `shared/` later (narrow → wide, never guessed up front).

## 4. Storage layout

```
~/squadrant/kb/                         # NOT a repo: a directory of KB repos
  _user/            (git)               # private
    profile/<trait>.md
  personal/         (git)               # private personal projects
    shared/{rules,wiki,decisions}/
    projects/<p>/{rules,wiki,decisions}/
  <company>/        (git)               # e.g. saitex, lumilabs
    sources.yaml  raw/  .converted/     # rules spec §3, now under the KB root
    shared/{rules,wiki,decisions}/
    projects/<p>/{rules,wiki,decisions}/
    REPORT.md                           # latest reconcile + scores, per KB
  # each {domain}/ may contain _proposed/ and _archive/

<project repo>/docs/{decisions,wiki,rules}/   # home = repo:docs (open-source projects)

~/squadrant/workspace/<project>/        # exchange (was hub/spokes/<p>/)
  handoffs/ side-handoffs/ inbox/ artifacts/   # artifacts = reports, research, findings, recaps, plans (dated, immutable)

~/.local/state/squadrant/
  audit/YYYY-MM.<machine-id>.jsonl      # append-only, daemon-written
  scores.json                           # derived from audit
  daemon.db, sessions, logs             # moved from ~/.config/squadrant

~/.cache/squadrant/index.db             # derived FTS (+ optional embeddings); safe to delete
~/.config/squadrant/config.json         # config only
```

- **Per-machine log files** and **one file per decision** (no sequence numbers; ids are slugs) avoid git conflicts between two machines.
- SQLite never sits in a KB repo or a synced folder.
- **Artifacts are raw sources for wiki and decisions.** A wiki claim or decision cites them (`sources: [artifact:2026-10-10-kb-taxonomy.md, issue:#893, commit:ad2f689]`). This gives the non-rules domains a raw layer to reconcile against.

### 4.1 Item formats (frontmatter)

Common to all domains:

```yaml
id: <stable slug>          # never re-minted
domain: wiki|decisions|rules|profile
level: shared|project
status: <domain-specific>
sources: [ ... ]           # artifact:, issue:, commit:, file:, raw: refs
created: 2026-10-10
updated: 2026-10-10
```

Per domain:

| Domain | Format details |
|---|---|
| **Rules** | Unchanged from rules spec §3, plus `level` and `decidedBy: <decision id>` when a decision justifies the rule. |
| **Decisions** | MADR-lite body: Context · Decision · Options considered · Consequences. `status: proposed\|accepted\|rejected\|superseded`, `supersededBy`, `decidedBy: operator`, `decidedAt`. **The body is immutable after `accepted`.** Only `status` and `supersededBy` change. |
| **Wiki** | `topic`, `summary` (one line, used in the index), `last_verified`, optional `verify:` probe commands. Every claim paragraph cites a source. |
| **Profile** | `trait`, `kind: preference\|correction\|procedure`, `confirmed: true\|false`, `last_confirmed`. Hard cap: the profile snapshot is ≤ 1,500 characters; over the cap, reconcile must merge before anything new applies. |

## 5. Write flow

**Capture → Propose → Gate → Commit → Log**

1. **Capture triggers.** None relies on the model remembering.

   | Event | Mechanism | Typical domains |
   |---|---|---|
   | Crew DONE / captain close-out | Daemon enqueues a `knowledge.distill` mailbox request to the captain, with the task summary and artifact paths. Same pattern as rules D11 | wiki, decisions |
   | Side-session handoff | `record-side-handoff` triggers the same distill request | decisions, wiki |
   | Raw-doc hash change | Daemon rotation tick (rules spec §4) | rules |
   | Spec approval / human-review checkpoint | Captain at the checkpoint | decisions |
   | Operator correction, Telegram reply | Captain at close-out; explicit corrections apply immediately (K10) | profile |

2. **Propose.** `squadrant knowledge propose --domain <d> --level auto|shared|project --evidence <ref> [--file body.md]` is plain CLI and works for any agent.
   - It writes to `<home>/<level>/<domain>/_proposed/`, or to `_user/profile/_proposed/` for profile items.
   - The body comes from a file or stdin, never argv (#865 lesson).
   - It prints "similar existing items" before writing.

3. **Gate.** Per K10.

4. **Commit.**
   - The daemon applies the change and makes one git commit per item in the KB repo, with trailers `Domain:`, `Item:`, `Level:`, `Session:`, `Approved-by:`.
   - `git log` is the full write history.
   - **If the daemon is down**, the CLI commits directly under git's own `index.lock`, retries 3 times, and logs `write.daemon-bypass`.

5. **Log.** `item.proposed|approved|rejected|applied` goes to the audit log (§7).

**Learnings migration path:**
- `record-learning.sh` becomes a thin wrapper over `knowledge propose --domain auto`. The captain routes the item.
- The `learnings/` store is frozen and then migrated (§10).

## 6. Read flow (delivery)

Only the injection points shared by all four agents are used (rules spec §6): session start, prompt start, after a tool runs. The pull fallback is `squadrant knowledge search|show|list`.

| When | Injected | Budget |
|---|---|---|
| Session start | profile snapshot (frozen per session) · active must/must-not rules · **one-line index** of wiki pages and accepted decisions for the read set | profile ≤ 1.5k chars; the rest ≈ 800 tokens, overflow collapsed to "+N more: `squadrant knowledge list`" |
| Prompt start | topic-matched rules, decisions and wiki summaries | ≤ 5 items, each shown once per session |
| After Read | path-matched rules and wiki pages | same |

- **One matcher for all domains.** Generalize the rules matcher (T0 glob/anchor/BM25, optional T1) to every domain. Wiki and decisions emit `triggers` like rules do: keywords, globs, `when`.
- **Every injected item carries its id** (`[dec:flooros-redis-cache]`). The block footer asks: "If you apply an item, cite its id in your DONE / handoff."
- **The precedence line is injected with the block:** Rules (must) > Decisions (accepted) > the operator's live instruction > Profile > Wiki > Recall.
- **The merged view** (`knowledge list --project p`) labels each item with its origin (`[saitex/shared]`, `[… → overridden by flooros]`).
- Non-Claude agents get the same text through their adapters (#900). Until then they get the AGENTS.md pointer to the CLI, which is visible in coverage scores.

## 7. Logging and scoring

**Audit event schema**, one line per event, written by the daemon:

```json
{"ts":"…","kb":"saitex","level":"project","project":"flooros","domain":"decisions","itemId":"flooros-redis-cache",
 "event":"item.surfaced","trigger":"prompt","tier":"T0","score":11.2,"chars":180,"agent":"claude","session":"…","task":"…"}
```

| Stage | Events |
|---|---|
| Write | `item.proposed` `item.approved` `item.rejected` `item.applied` `item.promoted` `item.superseded` `item.archived` `kb.created` `write.daemon-bypass` |
| Called | `item.surfaced` (push) · `item.suppressed` (budget/dedup/threshold) · `item.searched` / `item.shown` (pull) |
| Used | `item.cited`: the id appears in a DONE / handoff / commit message after it was surfaced or shown in that session |
| Outcome | `item.outcome` = followed / violated / noise / wrong, via `squadrant knowledge feedback <id> --followed\|--violated\|--noise\|--wrong` (operator or agent), plus the domain signals below |

**Domain outcome signals:**
- **Profile:** the operator repeats a correction that is already in the profile → `violated`.
- **Decisions:** the topic is re-litigated → `violated`.
- **Wiki:** the citation check fails at read time → `wrong`.
- **Rules:** rules spec §7.

**Scores**, computed by code (no LLM) into each KB's `REPORT.md`, `scores.json`, and `squadrant knowledge stats [--kb] [--project] [--domain] [--item]`:

| Level | Metrics |
|---|---|
| Item | fire rate · pull rate · **use rate = cited ÷ surfaced** · noise rate · violation rate · `last_surfaced` / `last_used` · never-fired 30d |
| Domain | **writes/month and reads/month, with a dead-domain alarm** (0 for 30 days) · chars injected per citation · per-agent coverage · proposal backlog age |
| Rules-only | tier contribution and reviewer agreement (rules spec §7) |

**Privacy** (from rules spec §7):
- Prompt text in the log is truncated to 200 characters.
- Notifications carry counts only.
- Logs rotate monthly and are compacted into stats by the full pass.

## 8. Reconcile

There is one scheduler (rules spec D7): an incremental pass 7 days after the first change, a full pass every 30 days, and a manual trigger. It runs at checkpoints and enqueues to the home captain (D11).

**Output is always a proposal.** The operator approves it, then the daemon commits it.

| Domain | Ground truth | Cleanup and compression | Never |
|---|---|---|---|
| Rules | raw-doc hash + code (#898 decision) | dedup, domain cap 150, stale → retired | auto-supersede on a code-vs-doc conflict |
| Wiki | current repo/git + cited artifacts | merge duplicate pages, compress long pages, re-verify citations and `verify:` probes, orphans | keep a claim with a broken citation unmarked (it is injected with ⚠ until fixed) |
| Decisions | itself (append-only) + whether code and wiki still match | link `superseded-by`, detect same-topic duplicates, escalate drift | edit or delete a record |
| Profile | operator confirmation | merge duplicate traits, compress to the cap, re-ask about traits unconfirmed for 60 days | rewrite a contradicted trait without asking |

**Score-driven actions:**
- unused for 60 days → archive proposal
- high noise → narrow triggers or demote to pull-only
- high violation → escalate
- dead domain → tell the operator that domain's trigger is broken

**Cross-domain lint:**
- A wiki page or decision that contradicts a rule or an accepted decision is escalated, never silently resolved.
- A project-level item that contradicts a `shared/` item is escalated.

## 9. Config and CLI

```json
{
  "knowledgeBases": {
    "_user":    { "path": "~/squadrant/kb/_user" },
    "personal": { "path": "~/squadrant/kb/personal" },
    "saitex":   { "path": "~/squadrant/kb/saitex", "homeProject": "flooros", "domainCap": 150 }
  },
  "groups":   { "saitex": { "kb": "saitex" } },
  "projects": {
    "flooros":   { "group": "saitex", "knowledge": ["solidity-conventions"] },
    "squadrant": { "knowledgeHome": "repo:docs" }
  }
}
```

The existing `knowledge.<kb>` (rules spec) moves under `knowledgeBases.<kb>`, and `path` defaults to `~/squadrant/kb/<kb>`.

**CLI:**

| Command | Purpose |
|---|---|
| `knowledge init <kb> [--remote <url>]` | create a KB (`git init`; remote optional) |
| `knowledge map --group <g> <kb>` | map a group to a KB |
| `knowledge propose` · `review` · `accept <decision-id>` (operator only) · `promote <id>` | write path |
| `knowledge search` · `show` · `list --project <p> [--domain]` | read path; merged view with origin labels |
| `knowledge feedback <id> --followed\|--violated\|--noise\|--wrong` · `stats` | outcomes and scores |
| `knowledge reconcile [--full] [--dry-run]` | run a reconcile pass |
| `knowledge export <project> --decisions\|--wiki` | write into the project repo, inside markers; respects the #662 opt-out |
| `knowledge doctor` | validate frontmatter and rebuild the index |
| `squadrant migrate kb` | §10 |

`squadrant rules …` stays as an alias for `knowledge … --domain rules`.

## 10. Migration and changes to existing work

**Changes to the rules KB spec (before #897 merges):**
- D2 storage moves to `~/squadrant/kb/<kb>/`.
- The project overlay moves from `<spokeVault>/knowledge/rules/` to the project home `<kb>/projects/<p>/rules/` (or `docs/rules/` for `repo:docs`).
- `audit.jsonl` moves to `~/.local/state/squadrant/audit/` with `kb` as a field.
- §7 `decisions.jsonl` is renamed **`verdicts.jsonl`** (reviewer verdicts), so it doesn't collide with the Decisions domain.
- #898's code-vs-doc rulings are stored as the `decision` block on the rule, as the 2026-10-09 operator comment specifies. Phase 3 (Decisions) migrates them into Decision records, and the rule keeps a `decidedBy` link.

**Path moves.** One version reads both old and new paths; `squadrant migrate kb` moves files and prints a report; nothing is deleted, only archived.

| From | To |
|---|---|
| `hub/spokes/<p>/{handoffs,side-handoffs}` | `workspace/<p>/…` |
| `hub/spokes/<p>/{reports,findings,recaps,plans}` | `workspace/<p>/artifacts/` |
| `~/.config/squadrant/{daemon.db,state,*.log}` | `~/.local/state/squadrant/` |
| hub `CLAUDE.md`, `projects/*.md`, `daily-logs`, empty `wiki`/`learnings` | archive |

**Knowledge migration** is one routing side-session per KB:
- 537 learnings, 32 wiki pages, and native-memory `user/feedback/project/reference` entries are routed into profile, wiki and decisions with sources.
- Anything left over is archived.
- The 2026-09-29 reconcile reports are inputs.

**Native-memory bridge.** Claude native memory stays (Claude-only, used as recall). At reconcile time a read-only import offers its typed entries as `propose` candidates.

**Issues:**
- Close #885 and #886 with verdicts.
- Re-scope #865 to the migration.
- #555 is resolved by group KBs.
- #901 stays rules-scoped, but its event schema includes `domain` from day one, so phase 2 extends it without migration.
- Comment on #899 with the v0 status.

## 11. Build plan: rules first, then the other domains

**Operator priority (2026-10-10):** finish **all of rules** before starting any other domain. Rules are built **forward-compatible**: paths, config names and the audit schema follow this spec from the start, so later phases add domains without migrating rules.

### Phase 1: Rules (epic #893, existing children)

| Step | Issue | Change vs the current issue |
|---|---|---|
| 1.0 | **new:** log the live rules injection (`rule.surfaced/suppressed/searched/shown`) | shipped in v0.26.2 with no telemetry; do first |
| 1.1 | **new:** amend the rules spec to the forward-compatible bits of this spec | storage `~/squadrant/kb/<kb>/`; config `knowledgeBases` + `groups.<g>.kb` (group→KB inheritance, option C); project overlay at the project home `<kb>/projects/<p>/rules/` (or `docs/rules/` for `repo:docs`); audit in `~/.local/state/squadrant/audit/YYYY-MM.<machine>.jsonl` with a `domain` field; `decisions.jsonl` → `verdicts.jsonl`; migrate any existing `<hubVault>/knowledge/<kb>/` |
| 1.2 | #897 ingest, extract, verify, classify, anchor | uses the 1.1 paths |
| 1.3 | #898 reconcile, scheduler, reviewer, escalations | code-vs-doc rulings stored as the rule's `decision` block (operator comment 2026-10-09); scheduler written domain-agnostic (it takes a list of passes) |
| 1.4 | #899 rest: daemon matcher, PostToolUse(Read), T1, eval, crew live check | comment on the issue with what v0 already shipped |
| 1.5 | #900 delivery for codex/gemini/opencode + AGENTS.md fallback | needs #662 / #717 for the fallback |
| 1.6 | #901 audit, scoring, REPORT.md, feedback | rules-scoped, plus `item.cited` (id citation in DONE/handoff) so "used" is measured from v1, not deferred to #902 |
| — | #902 deferred follow-ups | unchanged, data-gated |

**Phase 1 is done when** rules are extracted, reconciled, delivered to all four agents, logged and scored, at the new paths.

### Phase 2+: the other domains (new children, opened after phase 1)

| Phase | Scope |
|---|---|
| 2. Shared core | generalize from rules: KB registry + home resolution (all four rules of §3, including auto-create local group KB), daemon single-writer git commits with trailers, `knowledge propose/review/accept/promote`, merged `knowledge list/search`, matcher and scoring extended to any `domain` |
| 3. Decisions | format, operator-only `accept`, index injection; seeded from the #898 `decision` blocks and spec "Decisions made" tables |
| 4. Distill trigger + Wiki | `knowledge.distill` at crew DONE / side handoff; wiki redefinition, citations, lint; learnings migration (closes #885, #886, re-scopes #865, resolves #555) |
| 5. Profile | #894 spec; snapshot injection, correction capture, native-memory bridge |
| 6. Workspace / state / cache moves | spokes → `~/squadrant/workspace/`, `~/.config` state → `~/.local/state/`, `squadrant migrate kb` |
| 7. Export to repo | `knowledge export` (respects #662) |

## 12. Testing

- **Unit:**
  - home resolution, covering all four rules of §3
  - read-set ordering and isolation: a flooros session never resolves a lumilabs item
  - level routing and promote
  - each domain's gate (decisions `accept` is refused unless invoked by the operator)
  - frontmatter validation
  - score computation from an audit fixture
  - dead-domain alarm
- **Integration:**
  - propose → gate → daemon commit produces a git commit with trailers
  - daemon-down bypass
  - two-machine simulation (two clones, per-machine logs, no conflicts)
- **Live:**
  - injected ids are cited in a crew DONE and produce `item.cited`
  - per-agent smoke tests (#900)
- **Isolation regression:** a fixture with two company KBs; assert no cross-company item appears in `list`, in injection, or in `search`.

## 13. Open items

- How profile corrections are captured agent-agnostically, beyond the captain noting them at close-out: #894.
- Classification of `auto-gate` (published publicly → `repo:docs`?) and of other personal projects: an operator call at migration time.
- Phase 2+ issues are opened only after phase 1 is done, so they reflect what rules taught us.
- Whether the derived index needs T1 embeddings for wiki and decisions, or T0 is enough: decide from tier-contribution scores.

## Prior art

Andrej Karpathy (LLM wiki: raw → wiki, index, lint) · Michael Nygard / MADR / log4brains (ADRs, slug filenames, status-only mutation) · Letta MemFS (git-backed memory, commit per edit) · Basic Memory (files as truth, derived SQLite) · Hermes (frozen snapshot, char-capped USER.md, write approval) · GitHub Copilot Memory (citation validation, use-based expiry) · Claude Code memory (repo-keyed external memory, layered CLAUDE.md) · git config / Cursor / Kiro (owner-named layers, explicit precedence) · XDG Base Directory spec (config/data/state/cache split) · CoALA, LangMem (semantic/episodic/procedural vocabulary).
