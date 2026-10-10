# Rules Knowledge Base: Design

- **Status:** brainstormed with the operator 2026-10-07 → 08; Fable review applied (ready-with-fixes → fixed); awaiting operator spec review
- **Epic:** #893 (knowledge architecture)
- **Related:** #555, #885, #886, #894, #662, #615, #31
- **Amended 2026-10-10 (#936):** storage, config, project overlay, audit location and `verdicts.jsonl` follow [`2026-10-10-knowledge-base-architecture-design.md`](2026-10-10-knowledge-base-architecture-design.md) §3, §4, §9, §10. Those sections win where they differ from the original text below.
- **Prior art:** [`docs/research/2026-10-07-rules-kb-prior-art.md`](../research/2026-10-07-rules-kb-prior-art.md)

## 1. Goal

Operators onboard companies (e.g. **Saitex**) and projects (e.g. **Flooros**, **flooros-core**). These come with many coding, system and business rules, stored in docx/pptx/pdf/html/md documents. This system has four goals:

1. **Reduce rule-breaking.** An agent sees the relevant rules at the moment it needs them, and only those.
2. **Let agents keep learning.** What agents notice flows back as *proposed* rules, never as direct writes.
3. **Make outside information easy to take in, through the operator's perspective.** The operator chooses the trusted sources; the system digests them.
4. **Reconcile periodically.** Dedup, conflicts, staleness and usage scoring run on a schedule.

**Success:**
- Every live rule traces to a document the operator trusted, through a quote that is found verbatim.
- A document change updates rules in place, without duplicating them.
- Nobody has to remember to run anything.
- Delivery works for claude, codex, gemini and opencode.
- Every rule surfaced, every decision and every outcome is auditable.

**Non-goals (separate brainstorms under #893):**
- the operator work-style profile (#894)
- the project wiki (#886)
- retiring learnings (#885)
- Jev/Quyet decision-model backends (follow-up; v1 is LLM-driven)

## 2. Decisions made

| # | Decision |
|---|---|
| D1 | **Approach: push via hooks + pull via squadrant tool, stored in the vault.** Rejected: compiling into native rule files (Claude `paths:` is buggy, it pollutes repos (#662), and gives no audit); pull-only (relies on the agent remembering to look). |
| D2 | **Storage:** a named KB at `~/squadrant/kb/<kb>/`, its own git repo (`git init` on create; a remote is optional). A project inherits the KB mapped to its `group` (`groups.<g>.kb`) and adds more with `"knowledge": ["conventions"]`; its own overlay overrides by `id` or disables via `rulesDisabled`. *(Amended #936: was `<hubVault>/knowledge/<kb>/`, not tied to `group`.)* |
| D3 | **Trust:** only sources listed in `sources.yaml` can produce rules. An agent proposal stays `proposed` until it is reviewed. |
| D4 | **Review = option B.** A grounded rule from a trusted source goes live automatically. Exceptions go to a **reviewer agent**, which decides with a justification; the operator is reached only on escalation. |
| D5 | **A meaning change goes to the reviewer first.** The old version stays active while the change is pending. |
| D6 | **v1 is LLM-driven.** Every decision is phrased as a typed question behind a `decider` seam, so Jev (cloud) or Quyet-Large (local) can replace individual questions later, evaluated against the audit log. |
| D7 | **Two-tier reconcile:** an incremental pass at a fixed 7 days after the first change, plus a full pass every 30 days, plus manual. **Exception:** a KB with zero active rules extracts immediately (first ingest). |
| D8 | **Delivery points shared by all four agents:** turn/prompt start and after a tool runs. Delivery never blocks. Pre-tool injection (Claude PreToolUse on Edit) is **cut from v1**: its context arrives after the edit is already chosen, and rules already arrive on Read. |
| D9 | **Matching v1:** T0 glob/anchor/keyword computed in-process (T1 static embeddings are deferred to #902). Anchors are computed at extraction time, per project. **T2 (an async LLM/Jev rerank) is deferred** until the tier-contribution score shows a need. |
| D10 | **An agent never reads files outside its cwd** to obtain a rule, because that triggers a permission prompt. Rule text is injected, and pull goes through the allowlisted `squadrant rules` CLI. An MCP tool is deferred. |
| D11 | **Execution:** the daemon never spawns crews. A due pass enqueues a mailbox request to the KB's `homeProject` captain, who spawns the extraction or review crew. |
| D12 | **Source privacy:** client documents are sent to the extraction model. A source marked `sensitivity: local-only` is extracted only by a local model (router backend); if none is available it is skipped and reported. |

## 3. Store and rule format

```
~/squadrant/kb/<kb>/               # its own git repo
  sources.yaml            # trusted sources: the only way in
  raw/                    # operator drops files here; free-form subfolders
  .converted/<src>.md     # markitdown output + .sha (regenerable cache)
  shared/rules/<domain>/<id>.md   # coding | system | business | security | … (applies to every project in the KB)
  shared/rules/_proposed/         # awaiting reviewer / operator
  projects/<p>/rules/             # project overlay (§3 Project layer)
  index.json              # compiled: triggers, anchors, embeddings ref
  REPORT.md               # latest reconcile report + pending escalations
```

**`sources.yaml`:**

```yaml
- path: raw/finance/**                       # dropped files
  priority: company
- path: ~/work/flooros/docs/handbook/**      # referenced in place, hash-tracked
  priority: project
  domain: coding                             # optional hint
- path: raw/contracts/**
  priority: company
  sensitivity: local-only                    # D12: never sent to a hosted model
```

**KB config** goes in `config.json` under `knowledgeBases.<kb>` (`path` defaults to `~/squadrant/kb/<kb>`). The old `knowledge.<kb>` key is still read as a deprecated alias; `squadrant doctor` reports it as config drift.

```json
{
  "knowledgeBases": { "saitex": { "path": "~/squadrant/kb/saitex", "homeProject": "flooros", "domainCap": 150 } },
  "groups": { "saitex": { "kb": "saitex" } },
  "projects": { "flooros": { "group": "saitex", "knowledge": ["conventions"] } }
}
```

`homeProject` defaults to the first subscribing project and is required when no project subscribes. If no project subscribes, extraction still runs but anchors are skipped.

**Project layer:**
- It lives at the project home `<kb>/projects/<p>/rules/`, or `<repo>/docs/rules/` when `projects.<p>.knowledgeHome` is `"repo:docs"`, uses the same file format, and follows the same trust rules (D3).
- An override **replaces the whole rule** with the same `id`. `rulesDisabled: [id]` in the project config turns a KB rule off.
- When the base rule of an override changes, the full pass escalates `override.base-changed`.

- `priority` takes `company` > `project` > `agent`. It decides which source wins in a conflict.
- Globs expand to one tracked entry per file.

**A rule** is one markdown file. The body is the statement plus the rationale. Frontmatter:

```yaml
id: biz.invoice.vnd-rounding     # stable, never re-minted
domain: business
modality: must                   # must | must-not | should | may
status: active                   # proposed | active | stale | retired
triggers:
  globs: ["src/billing/**"]
  keywords: ["invoice", "VND", "rounding"]
  expanded: ["total", "subtotal", "amount", "tax"]   # LLM-expanded at extraction
  when: "Computing or displaying monetary amounts in VND"
anchors:                          # per project: found by searching that project's repo
  flooros: { paths: ["billing/**"], symbols: ["computeTotal", "Money"] }
sources:
  - { ref: raw/finance/Policy-v3.pdf, sha: 9f2c…, loc: "p.12 §4.2",
      offset: [18234, 18289],     # char span in .converted/ — mechanical id matching
      quote: "All VND amounts shall be rounded half-up to the unit." }
approvedBy: auto                  # auto | reviewer-agent | human
justification: ""
supersedes: []
conflictsWith: []
```

**Domain cap:** 150 active rules per domain by default. When a domain is over the cap, the full pass must merge or retire rules.

## 4. Ingest and extraction

1. **Detect.** The daemon's existing 60s rotation tick (`packages/core/src/daemon/start.ts`) checks every source in `sources.yaml`. It compares mtime and size first and computes a sha only when one of them differs. A new or changed hash opens the incremental window (§5). A KB with zero active rules is due immediately (D7).
2. **Convert.**
   - `markitdown` (an optional Python dependency; `squadrant doctor` reports when it is missing) converts the file to `.converted/`.
   - md/txt pass through unconverted.
   - On failure, the source is marked failed in `REPORT.md`, skipped, and the run continues.
3. **Extract.** The homeProject captain spawns a crew task that runs the `knowledge-extract` skill (D11). The crew receives the changed sources (split by section) and a compact index of the existing rules in the relevant domains (id + statement). For each candidate rule it proposes an id, either reusing an existing one or minting a new one. It also emits `expanded` terms and the `when` sentence.
   - **First-ingest cost guard:** `knowledge reconcile --dry-run` prints a token estimate, and `maxSectionsPerPass` bounds a single pass. Any remainder carries over to the next pass.
4. **Verify mechanically** (code, no LLM):
   - **Quote verification.** Normalize both sides: collapse whitespace, rejoin line-break hyphenation, fold smart quotes and dashes, expand ligatures, then search. If the quote is not found, the candidate is dropped and `rule.rejected.ungrounded` is logged. If the quote is found, its `offset` is recorded. When more than 20% of a source's candidates are dropped, `REPORT.md` flags the source as "conversion likely poor, try docling".
   - The schema is valid, the modality is in the allowed set, and the globs parse.
   - **Mechanical id matching overrides the LLM.** A candidate whose quote span overlaps an existing rule's `offset` in the same source takes that rule's id. This prevents id churn from LLM non-determinism.
5. **Classify the change:**

   | Candidate | Result |
   |---|---|
   | New rule | `active` |
   | Same id, same meaning | add the source to `sources[]` and update `offset` |
   | Same id, **meaning changed** | written to `_proposed/<id>@<sha>.md`; the old version stays active (D5) |
   | A previous rule from this source is missing | `stale`, still delivered until retired |
   | Contradicts an active rule | goes to `_proposed/` with `conflictsWith` set |

   **Meaning-change lifecycle:**
   - If the source changes again while a proposal is pending, the older proposal closes as `superseded` and the new one is classified afresh.
   - Approving a proposal overwrites the active file and logs `rule.updated`.
   - Rejecting a proposal keeps the active version.

6. **Anchor (per project).**
   - For each subscribed project, search its repo for `keywords + expanded` and record the matching `paths/symbols` under `anchors.<project>`.
   - If T1 is enabled, compute the rule embedding over `statement + when + expanded`.
7. **Compile** `index.json`, then append the audit entries.

## 5. Reconcile and review

**Config:**

```json
{
  "knowledge": {
    "reconcile": {
      "incrementalAfterDays": 7,
      "fullEveryDays": 30,
      "autoApproveConfidence": 0.8
    }
  }
}
```

State lives in `stateRoot/knowledge-schedule.json` as `{ <kb>: { firstChangeAt, incrementalDueAt, lastFullAt, running?: {pass, startedAt, sourceSnapshot} } }`. The incremental window is **fixed**: later changes do not push it back.

**When a pass is due:**
- The daemon enqueues a mailbox request (the same pattern as Telegram-inbound `captain.message`) to the KB's `homeProject` captain, who spawns the crew (D11).

**Concurrency:**
- Only one pass runs per KB at a time.
- A `running` entry older than 6h is treated as dead and cleared.
- When a full pass and an incremental pass are both due, the full pass absorbs the incremental one.
- Source hashes are snapshotted at the start of a pass. Changes that arrive during the pass open the next window.

**Incremental pass** (changed sources only):
- extraction (§4)
- the reviewer handles `_proposed/` items
- decisions on `stale` rules: if the source still supports the rule elsewhere, update its `loc`; otherwise retire it (escalate if the rule is `must` or `must-not`)
- usage stats

**Full pass** (all sources), which adds:
- **cross-source dedup:** candidate pairs come from trigger/anchor overlap and, if T1 is enabled, embedding similarity; the reviewer classifies each pair as `duplicate | refines | conflicts | unrelated`
- **usage review:**
  - never-surfaced rules → re-check their triggers
  - noisy rules → narrow their triggers
  - rules with violation feedback → reword
- enforcing the domain cap
- refreshing anchors
- escalating `override.base-changed` for project overrides

Deferred until there is usage data: automated diff sampling for outcomes, and spot-checks of past reviewer approvals.

**Reviewer agent** (crew task, `knowledge-review` skill). It makes one typed decision per item:

```
{ decision: approve | reject | merge-into:<id> | escalate, confidence: 0..1, justification }
```

- If `confidence ≥ autoApproveConfidence`, the decision is applied and logged.
- Otherwise the item is escalated.
- These items **always escalate**:
  - a conflict between two `company`-priority sources
  - retiring a `must` or `must-not` rule
  - any item the reviewer flags itself

**Escalations reach the operator through:**
- `REPORT.md`
- `squadrant knowledge review`, an interactive walk-through with approve / reject / edit
- a one-line captain message, e.g. "saitex KB: 3 items need you"
- Telegram, if configured (counts only)

Unanswered items stay `proposed` and never go live by default.

**Agent learning.** Any captain or crew can run `squadrant knowledge propose --kb <kb> "<statement>" --evidence "<where seen>"`. This writes to `_proposed/` with `priority: agent`.

**Manual run:** `squadrant knowledge reconcile <kb> [--full] [--now]`.

## 6. Delivery

**Core command:** `squadrant rules match --project <p> --event prompt|read|session --path <f> --text <t> --session <id>`

- **In-process-first (captain decision, #899):** matching runs inside the hook / CLI process, under a 1.5s budget (`INJECT_BUDGET_MS`); a throw, timeout or overrun injects nothing and never blocks. Rules are read from the KB files on every call (no warm daemon state), which is fast enough for T0. A daemon-warm matcher (socket round-trip, `index.json` held in memory) is a **deferred option**, to be revisited only if T1 or a large KB makes in-process too slow.
- KBs are resolved from the project config, using cwd or `SQUADRANT_CREW_PROJECT`.
- It covers crews, captains and plain sessions. `rules match` runs the same code the hooks run, for testing and for agents without hooks.

**Matching (v1):**

| Tier | Budget | What | When |
|---|---|---|---|
| T0 | in-process, within the 1.5s hook budget | glob + anchor path/symbol (current project's anchors only) + a field-weighted lexical score over `keywords + expanded + when` (the `searchRules` scorer) | every event |
| T1 (deferred, #902) | <5ms | static model2vec embedding cosine, fused with T0 via RRF. Not built: no new dependency in v1, and no `knowledge.matcher.t1` config key yet | every event |
| T2 (deferred) | 0.2–2.5s | async rerank of the shortlist by an LLM or a Jev/Quyet decision model | added only if tier-contribution and recall data show a need |

**Injection rules:**
- **Order:** `must`/`must-not` first, then project layer before KB, then anchor/glob before keyword before T1.
- **Budget:** about 800 tokens per injection, at most 5 rules.
- **Each rule is shown once per session.**
- **Overflow** collapses to a single line: `+N more: squadrant rules show <ids>`.
- **Format:** `MUST round VND half-up to whole đồng [Policy-v3 p.12] (biz.invoice.vnd-rounding)`.

**Adapters:**

| Agent | Prompt | After a read | Session | Ships |
|---|---|---|---|---|
| claude | `UserPromptSubmit` | `PostToolUse`(Read). New: PostToolUse is currently excluded at `native-hook-source.ts:18` and must be added | `SessionStart` (one-line KB summary) | first (hooks managed via #615) |
| codex | `UserPromptSubmit` | `PostToolUse` | `SessionStart` | after a live check |
| gemini | `BeforeAgent` | `AfterTool` | `SessionStart` | after a live check |
| opencode | `chat.message` plugin | `tool.execute.after` plugin | plugin init | after a live check (the APIs are experimental) |

**Fallback:** an agent without working hooks gets a pointer in its projected AGENTS.md/GEMINI.md that tells it to use `squadrant rules search`.
- The pointer is written only inside the existing projection markers, and only for projects that subscribe to a KB (#662).
- The audit log shows which agents are running on the fallback.

**Pull:** `squadrant rules search|show` as an allowlisted CLI. It does not read paths outside cwd (D10). An MCP tool is deferred.

**Failure behavior:**
- The hook never blocks. On an error or timeout of the in-process matcher (1.5s) it injects nothing.
- If the index is missing or corrupt, nothing is injected and `doctor` flags it.

## 7. Audit and scoring

The audit log is append-only, one JSON line per event, at `~/.local/state/squadrant/audit/YYYY-MM.<machine-id>.jsonl` (one file per machine, shared by all KBs and domains). Each entry has `{ts, kb, level, project, domain, itemId, event, …}` (events are named `item.*`; see `packages/core/src/knowledge/audit.ts`).

| Group | Events |
|---|---|
| Lifecycle | `rule.extracted`, `rule.updated`, `rule.status`, `rule.rejected.ungrounded` |
| Decisions | `decision`: question type, input, answer, confidence, justification, applied or escalated, operator override. Stored in a separate `verdicts.jsonl` (renamed from `decisions.jsonl`; "decisions" is reserved for the Decisions domain) that is **never compacted**. This is the future eval set for Jev/Quyet. |
| Delivery | `rule.surfaced`, `rule.suppressed` (budget / dedup / threshold), `match.error`, each with tier, score and tokens |
| Pull | `rule.searched`, `rule.shown` |
| Outcome | `rule.outcome` (followed / violated / n-a). In v1 its only source is `squadrant knowledge feedback <id> --violated\|--noise\|--wrong`, used by the operator or by agents. Sampled diffs and mechanical checks are deferred. |

**Scores** are computed by code (no LLM) and written to `REPORT.md` on every pass:
- fire rate
- never-fired in 30 days
- noise rate
- violation rate
- tier contribution (is T1 worth it, and is T2 needed?)
- reviewer agreement (tunes `autoApproveConfidence`)
- per-agent coverage (catches a broken adapter)

**Privacy:**
- Source documents: see D12. Without `local-only`, a document is sent to the extraction crew's model. `knowledge init` states this.
- The log stays in the vault.
- Notifications carry counts only.
- Prompt text is truncated to 200 characters.
- The log rotates monthly; the full pass compacts old months into stats.

## 8. Units

| Unit | Package | Responsibility |
|---|---|---|
| `knowledge/schema` | shared | Rule/source/config types + validator |
| `knowledge/store` | core | Read/write KB dirs, index compile, layer resolution (KB + project overrides) |
| `knowledge/ingest` | core | Source hashing, markitdown conversion, quote verification, change classification |
| `knowledge/scheduler` | core | Incremental/full due-time state, lock, and snapshot on the rotation tick; enqueues a mailbox request to the homeProject captain (D11) |
| `knowledge/matcher` | core | T0 in-process (T1 deferred, #902), budget/dedup/format |
| `knowledge/decider` | core | Typed-question seam; v1 = LLM implementation |
| `knowledge/audit` | core | Append, rotate, score, REPORT.md |
| adapters | agents/workspaces | claude hooks (extend `hooks.ts` before the crew-only early exit), codex/gemini hooks, opencode plugin |
| CLI | cli | `squadrant knowledge {init,sources,reconcile,review,propose,feedback,report}`, `squadrant rules {match,search,show}` |
| skills | plugin/skills | `knowledge-extract`, `knowledge-review` (portable markdown) |

## 9. Testing

- **Unit tests:**
  - schema validation
  - quote verification (verbatim / whitespace-normalized / missing)
  - change classification table
  - layer resolution and overrides
  - T0 matching and ranking
  - budget/dedup
  - scheduler window semantics (fixed window; full every 30 days)
  - score computation from an audit fixture
- **Golden fixture KB:** a small Saitex-like corpus (pdf + docx + md) with known rules, including a known duplicate, a conflict, and a rule that changes meaning across two versions. Extraction runs against it, and the result is diffed with stable-id expectations.
- **Matching eval:** about 30 labeled (event → expected rules) cases, including the "computeTotal without the word invoice" case. Report recall/precision per tier.
- **Adapters:** a live smoke test per agent, checking that the injected text reaches the model. Codex PostToolUse, gemini BeforeAgent/AfterTool and the opencode experimental hooks are the ones to verify. Also add an **id-churn metric** to the golden fixture: re-run extraction on unchanged sources and expect 0 id changes.

## 10. Rollout (issue breakdown under #893)

1. **Store + schema + CLI basics:** `knowledge init/sources`, `rules show/search`, layer resolution, `doctor` checks.
2. **Ingest + extract + verify:** markitdown, the `knowledge-extract` skill, quote verification, change classification, per-project anchors, `sensitivity: local-only`, first-ingest guard (`--dry-run`, `maxSectionsPerPass`), optional T1 embeddings.
3. **Reconcile + reviewer + scheduler:** incremental/full passes, mailbox-to-captain execution, lock/snapshot, `knowledge-review` skill, escalations, `review/propose`.
4. **Delivery (Claude first):** in-process T0 matcher (daemon matcher and T1 deferred), `rules match`, Claude `UserPromptSubmit`/`PostToolUse(Read)`/`SessionStart` adapters (adds PostToolUse to the managed hook set).
5. **Delivery for codex/gemini/opencode:** live-verify the injection points, then add the adapters and the AGENTS.md fallback pointer.
6. **Audit + scoring + REPORT.md + feedback CLI.**
7. **Follow-ups (deferred, data-gated):**
   - decider backends, Jev cloud and Quyet-Large local, chosen by replaying `verdicts.jsonl` as an eval set
   - T2 rerank
   - T1 static embeddings (model2vec) and the `knowledge.matcher.t1` config key (#902 scope), plus the daemon-warm matcher they would need
   - MCP pull tool
   - automated outcome detection

Items 1→2→3 come first; 4 can start once 1 lands; 6 grows alongside 2–4.

## 11. Open items to verify during implementation

- How stable opencode's `experimental.*` hooks are.
- model2vec in Node: whether a JS loader exists, or static embeddings are implemented directly in TS (a tokenizer plus a vector-table lookup), measured on the operator's laptop.
- Matching inside a monorepo: anchors are per project; check sub-path projects.
