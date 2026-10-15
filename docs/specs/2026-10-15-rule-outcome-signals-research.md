# Rule outcome signals: research (#945)

Status: direction picked 2026-10-15 (see §0). Only §0's "now" scope is approved for implementation.
Implemented: Phase A "now" scope (A1, A2, A4, A5). §5 test 7 is reframed now that A3 is dropped: the delivery `task` field is stamped the same way on the codex/opencode path as on Claude's.

## 0. Operator decision (2026-10-15)

> "Should judge if confidence is high. Else just do something simple; after the 2-week review we can check what is a possible solution."

- **Rule for every automatic signal:** an outcome counts in scores only when it is high-confidence (a human or captain grade, a deterministic check, or a judge verdict at ≥ `autoApproveConfidence` (0.8) with evidence verified against the diff). Anything less emits no `item.outcome`.
- **Now (simple, no LLM judge):** A1 (`source` + `task` on events), A2 (captain PR-review checklist via `knowledge surfaced --task`), A4 (reconcile code-violation → separate `codeViolations`), A5 (`evaluated` / `complianceRate`, per-source counts).
- **Dropped for now:** A3 crew self-report. It's low-confidence (self-graded), which fails the rule above.
- **Decide after the 2-week review (2026-10-27):** whether to build Phase B (judge) and/or Phase C (checks), using A2's grades and the usefulness study. If the judge is built, it emits only verdicts with `confidence ≥ 0.8` and verified evidence. Lower-confidence verdicts emit nothing; they're only counted for the agreement report.
Parent: #893 (Rules KB). Overlaps: #902 ("Automated outcome detection", "Mechanical checks", "PreToolUse reminder").
Hard constraint (#945): scores stay code-computed (`packages/core/src/knowledge/scores.ts`). A judge only **emits `item.outcome` events**; it never edits scores.

## 1. Where things stand

| Signal | Source today | Live data (audit log, Oct 2026, saitex) |
|---|---|---|
| `item.surfaced` | inject hooks (`inject.ts`), Claude only (#900 open) | 940 events, 28 sessions, 98 rules; **700 of them (74%) at session start**, ~25 rules per session |
| `item.cited` | automatic at `crew signal done\|review` (`crew-control.ts` `logSignalCitations`) + `cite-scan` | 57 (49 from crew-done, 8 from git) |
| `item.outcome` | manual `knowledge feedback` only (`knowledge.ts` `runKnowledgeFeedback`) | **5 total**: 4 followed, 1 noise, **0 violated** |
| reconcile `code-violation` | `review.ts` `evaluateCodeConflict` → `flag-violation` → escalation `needsYou:false` | **0 ever** (165 verdicts in `saitex/verdicts.jsonl`, none are violations); it never logs `item.outcome` |

Facts from the code and the KB that shape the design:

1. **Diluted denominator.** `violationRate = violated ÷ surfaced` and `noiseRate = noise ÷ surfaced`. With ~25 session-start rules per session, most surfaced rules don't apply to the change, so even perfect detection gives a diluted rate. Qodo's per-rule analytics count *evaluations* (compliance / violations / merged violations per PR) rather than exposures. That is the right denominator.
2. **Reword trap.** `usageReview` (`fullpass.ts`) treats **any** `violated` as "reword this rule". A code-state violation is not a wording problem.
3. **No task on delivery events.** `item.surfaced` carries `session` but not `task`, so a crew diff can't be tied to the rules it was shown. The hook process already sees `SQUADRANT_CREW_TASK_ID` (the #556 memory gate uses it).
4. **No `source` on outcomes.** You can't tell operator, self-reported and machine outcomes apart.
5. **~30% of rules are process rules.** The saitex domains are clickup 16, pr 13, git 8, workflows 6, dev/process 3, out of ~160. These rules are about *actions* (pushing, ClickUp edits, PR flow), not code, so a diff-only judge or lint can't observe them.
6. **Anchors say where a rule applies (paths/symbols), not what a violation looks like.** Mechanical checks need a new field.

## 2. Prior art (web, 2026)

| Finding | Source | Implication for us |
|---|---|---|
| Agents' self-reports default to success narratives. About 2% of 8.6k real sessions misrepresent success. Asking for **explicit structured fields** (pass/fail counts) improves reporting but doesn't make it correct. | Transluce field study; NeurIPS-26 test-claim study; "LLMs are insecure reporters" | Self-report is a weak signal. Use a structured grammar, tag `source:"crew"`, and never let it be the only `violated` source. |
| LLM judges are much weaker at **violation detection** than at identifying the relevant guideline. A small judge fine-tuned on synthetic injected violations beats frontier models. | CompliBench (arXiv 2604.12312) | Judge in **shadow** until calibrated. Ask per-rule binary questions with localized evidence. Our `verdicts.jsonl` + judge outcomes later become training data for the #902 Jev/Quyet decider. |
| Agentic review comments: 56% rejected, mostly false positives. A judge pass that filters low-signal findings is the norm (Qodo, CodeRabbit). | arXiv 2607.03316; Qodo docs | Verify judge output mechanically (evidence must exist in the diff), and track judge agreement like `reviewerAgreement`. |
| Checkable house rules scored **from the git diff** give a reproducible adherence measure (CLAUDE.md/AGENTS.md study, 81 runs). | nazmul284/agents-md-compliance | Diff-scored mechanical checks are a proven approach for expressible rules. |
| Adherence **decays within a session**: ~5.6% lower odds per extra generated function (16k observations). File structure has no effect. Task type matters. | McMillan, arXiv 2605.10039 | Log delivery position/turn so we can see decay. It also strengthens #902's "PreToolUse reminder" item. |
| Agents "deliver what you check": with a check in the loop they satisfy the check, sometimes hollowly. | arXiv 2606.28430 | Mechanical checks work for narrow lint-style rules. Don't treat a passing check as proof the broader intent was followed. |
| Runtime policy on **tool-call traces** (trigger + predicate + action), with millisecond overhead. | AgentSpec (arXiv 2503.18666); ActPlane | Process rules can be checked on the tool trace from hooks we already run, in log-only mode. |
| Online judge + **human annotation queue** to align the judge with humans. | Langfuse eval docs | The operator's 2-week manual grading is our annotation queue. Make it a structured, recurring step. |
| Contributive attribution by **ablating context** (ContextCite). | arXiv 2409.00729 | A randomized rule holdout would give a causal "does delivering this rule change behaviour?" Valuable later, but it needs volume. |

## 3. Directions compared (the issue's 4 + 4 new)

| # | Direction | Quality / bias | Token cost | Size | Portable (4 agents) | Unattended-safe | Phase 2 fit |
|---|---|---|---|---|---|---|---|
| 1 | Crew self-report at `signal done` (`Rules: followed … \| noise … \| violated …`) | weak; biased to followed; `noise` fairly honest | ~0 | S | ✅ CLI signal path | ✅ | ✅ any domain |
| 2 | Reconcile code-violation → outcome | precise but measures **codebase drift**, not delivery; volume 0 | 0 | XS | ✅ | ✅ | rules only |
| 3 | LLM judge on crew diff vs rules surfaced to the task | best `violated` recall for code rules; needs calibration; blind to process rules | sampled, ≤~300k/pass | M–L | ✅ if run as a reconcile crew over a CLI packet | ✅ (diff inside packet) | ✅ any domain |
| 4 | Mechanical diff checks (`check:` regex/semgrep on added lines) | highest precision; ~10–20% of rules expressible | 0 | M + authoring | ✅ CLI + git | ✅ | rules only |
| **5** | **Captain PR-review checklist.** At review, `squadrant knowledge surfaced --task <id>` lists the rules delivered to that task. The captain, already reading the diff, grades with `feedback --source review`. | good: an independent agent and the operator in the loop; covers process rules the captain saw | small (captain already reads the diff; +~25-line checklist) | S | ✅ CLI + skill text | ✅ captain is interactive | ✅ |
| **6** | **Tool-trace checks for process rules.** `check: {on: "tool", tool, pattern}` evaluated in the after-tool hook (log-only, never deny) | precise for action rules (`git push --force`, ClickUp edits) | 0 | M | ⚠️ "after a tool runs" is shared by all 4 (arch spec), but the hook payload shape differs per agent | ✅ log-only | rules only |
| **7** | **Randomized holdout.** Withhold a `should`/`may` rule in X% of sessions and compare outcome rates (never `must`) | causal usefulness, not just obedience | 0 | M | ✅ (matcher side) | ✅ | ✅ |
| **8** | **Post-merge corrections.** A revert or fix commit touching the crew's lines within N days, or "changes requested" comments, mapped to rules | noisy attribution; Qodo's "merged violations" is the cleaner variant | 0–small | M | ✅ git/gh | ✅ | partial |

## 4. Recommendation: a phased combo

The principle: **one cheap structured signal now, one calibrated machine judge later, deterministic checks where a pattern can express the rule, and the denominator fixed to "evaluated" instead of "surfaced".**

### Phase A: plumbing + structured human/agent grades (now, no new LLM, ~1 crew, S)

- **A1 `source` + `task` on events.** `item.outcome` gains `source: "operator" | "review" | "crew" | "reconcile" | "judge" | "check"` (old rows = operator) and an optional `task`. Delivery events (`surfaced`/`shown`/`searched`) get `task` from `SQUADRANT_CREW_TASK_ID`, plus a per-session delivery ordinal for the decay finding.
- **A2 Captain PR-review checklist (direction 5).** New `squadrant knowledge surfaced --task <id> [--json]` lists the rules delivered to the task, read from the audit log via the CLI (no out-of-cwd reads). The captain-ops skill review step changes to: "for each listed rule that applies to the diff, `knowledge feedback <id> --followed|--violated|--noise --source review --task <id>`; skip the rest". This turns the current ad-hoc 2-week protocol into a durable annotation queue, which is the calibration set for Phase B.
- **A3 Crew self-report (direction 1). Deferred per §0 (low confidence).** `Rules: followed a b | noise c | violated d` in the DONE message, parsed in `logSignalCitations`. Bare ids stay cite-only. It counts only ids delivered to that task, with one outcome per `(task, item, source)`. One line goes in `templates/crew.{claude,opencode,generic}.md`.
- **A4 Reconcile code-violation (direction 2), kept separate.** `flag-violation` logs `item.outcome violated source:"reconcile"` (no task) → a new `codeViolations` metric. It's excluded from `violationRate` and from `usageReview`'s reword list.
- **A5 Scoring.** Add `evaluated = followed + violated` per item and `complianceRate = followed ÷ evaluated` (null below n=3), next to the existing rates. Report per-source counts in `scores.json` and REPORT.md so self-report bias is visible. `violationRate` counts `operator | review | judge | check` only; crew-sourced outcomes are shown but not counted until Phase B measures their accuracy.

### Phase B: sampled LLM judge (after 2026-10-27; the #902 gate is met by A2's data)

- A reconcile sub-step run by the reviewer crew, using the existing "judge emits, code verifies" pattern:
  - `knowledge outcomes packet <kb>` samples ≤10 merged crew tasks since the last pass: `{task, diff (base...branch, truncated), rules delivered to that task}`.
  - The judge answers **one binary question per rule**: applicable? → followed/violated, with `evidence {file, line, quote}`.
  - `knowledge outcomes apply` drops anything whose quote isn't in the diff or whose rule wasn't delivered to the task (`item.rejected reason:"ungrounded"`), and anything with `confidence < autoApproveConfidence` (§0). It then appends `source:"judge"`.
- `knowledge.outcomes.judge: off | shadow | on` (the same idea as `controlChannel`). In shadow, outcomes are reported but excluded from rates. REPORT.md shows `judgeAgreement` against `review`/`operator` grades on the same `(task, item)`. Flip to `on` at ≥0.8 over ≥20 overlaps. The same agreement table also measures **crew self-report accuracy**, which decides whether A3 outcomes ever count.
- Process rules are out of scope for the diff judge; that's Phase C.

### Phase C: deterministic checks (#902 gate: rules the judge or review shows violated ≥2 times)

- An optional `check:` frontmatter field, proposed by the reviewer and approved by the operator:
  - `{on: "diff", pattern, paths?}` runs on added lines at `signal done` (direction 4)
  - `{on: "tool", tool, pattern}` runs in the after-tool hook, **log-only** (direction 6)
- Both emit `source:"check"`. A diff check emits `followed` only when the diff touches the rule's anchors and the pattern is absent. Enforcement (deny) stays a separate #902 decision.

### Later / not now

- **Direction 7 (randomized holdout):** worth doing once outcome volume exists (≥~30 evaluated per rule/month). Restricted to `should`/`may`. It answers "is this rule worth injecting?", which complements the 2-week usefulness study.
- **Direction 8 (post-merge corrections):** attribution is too noisy. A2 already captures "changes requested" through the captain.
- **Rejected:** a judge in the crew's signal path (latency, tokens, and self-judging), and option 2 as the main violation source.

## 5. Acceptance tests

Phase A (unit, tmp `SQUADRANT_AUDIT_DIR`):
1. `knowledge feedback x --violated` logs `source:"operator"`. `--source review --task t1` logs both fields. Old records without `source` count as operator.
2. A surfaced event with `SQUADRANT_CREW_TASK_ID=t1` carries `task:"t1"`. Without the env var there is no `task` field.
3. `knowledge surfaced --task t1` lists exactly the ids delivered to t1 (surfaced/shown/searched), deduped, with modality and statement.
4. *(deferred with A3)* `logSignalCitations("done", {message: "Rules: followed a b | noise c | violated d"})` with a, c, d delivered to the task and b not: it emits a=followed, c=noise, d=violated (`source:"crew"`) and nothing for b. Re-running adds nothing. A bare `Rules: a b` is cite-only.
5. `applyDecisions` with a `flag-violation` logs `violated source:"reconcile"`. `computeScores` puts it in `codeViolations`, `violationRate` is unchanged, and `usageReview().violated` excludes it.
6. `computeScores`: 2 review-followed + 1 operator-violated + 1 crew-violated → `evaluated` 3, `complianceRate` 0.667, crew row shown in `bySource` and not counted in `violationRate`.
7. The parser is agent-agnostic: the same test runs through the codex/opencode signal path.

Phase B:
8. `outcomes apply` drops a judge outcome whose quote isn't in the task diff, or whose rule wasn't delivered to the task (`item.rejected reason:"ungrounded"`).
9. In shadow, judge outcomes don't move rates. `judgeAgreement` and `crewSelfReportAgreement` are computed over overlapping `(task, item)` pairs.
10. Building the packet needs no reads outside the KB home and squadrant-resolved crew worktrees (no permission prompt for an unattended reviewer crew).

Phase C:
11. A diff check on added lines emits `violated source:"check"`, and never throws or takes more than 2s. A tool check in the after-tool hook logs but never returns a deny.

## 6. Open questions for the operator

1. Phase A: should A2 (captain checklist) and A3 (crew self-report) both ship, or only A2? A2 is the better signal; A3 is nearly free but biased.
2. Phase B sampling: 10 merged tasks per pass, merged PRs only?
3. Should `complianceRate` replace `violationRate` in REPORT.md's table, or sit next to it?
4. Is direction 7 (holdout) acceptable in principle for `should`/`may` rules?

## Sources

- Transluce, "Measuring coding agent misalignment in the wild": https://www.greaterwrong.com/posts/smE9h9RnaK7FWKBZ2/measuring-coding-agent-misalignment-in-the-wild-1
- Self-report reliability (NeurIPS 2026): https://neurips.cc/virtual/2026/168218 · Confessions: https://arxiv.org/html/2512.08093v2
- CompliBench: https://arxiv.org/abs/2604.12312
- Mining developer feedback to CodeRabbit: https://arxiv.org/abs/2607.03316
- Qodo rule analytics: https://docs.qodo.ai/governance/rule-enforcement/analytics
- AGENTS.md/CLAUDE.md compliance runs: https://github.com/nazmul284/agents-md-compliance
- Instruction adherence factorial study: https://arxiv.org/abs/2605.10039
- "Coding Agents Deliver What You Check": https://huggingface.co/papers/2606.28430
- AgentSpec: https://arxiv.org/abs/2503.18666 · ActPlane: https://arxiv.org/pdf/2606.25189
- Langfuse annotation queues / LLM-as-a-judge: https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues
- ContextCite: https://arxiv.org/html/2409.00729v2
- Semgrep rule generation with LLMs (Autogrep, RuleLLM): https://arxiv.org/html/2504.17198v1
