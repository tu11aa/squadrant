---
name: human-review-guide
description: Write the operator a short, well-sourced guide for the human gate of crew PRs, covering only what the automated gates did not cover or cannot judge, plus the gate gaps. Use when the operator types `/squadrant:human-review-guide` (or `/human-review-guide`) or says "review guide", "how should I review these PRs", "guide me through the PRs", "what should I focus on in review", "what do I check before merging", or is about to review one or more crew PRs by hand. One PR → answer in chat; several PRs → one local interactive HTML. The guide is LOCAL ONLY and is never posted anywhere. Works in any squadrant session; the session that drove the PR(s) writes it.
---

# human-review-guide — a local guide for the human review gate

## Core principle: the human gate covers only what the gates cannot see

Code and rules are already reviewed by agents and gated: crew self-review, the owner's agent review, CI, lint, guard tests, knowledge-base rule checks, a repo's PR review tool. **The human gate exists only for what those gates cannot see or did not cover.** Two kinds of thing qualify:

1. **Not covered** — no gate looked at it in this diff.
2. **Only a human can judge it** — intent and scope, public contract names, architecture trade-offs, whether the tests test the right thing, a live comparison with a design or prototype.

Everything else is dropped from the guide, and the human is never asked to redo it. The guide also records the **gate gaps**: things that *should* have been machine-checked but no gate covers, each with a suggested new gate or follow-up ticket, so a human catches it once and a machine catches it next time.

This skill produces the guide that makes that review fast.

Structure follows [addyosmani/agent-skills `code-review-and-quality`](https://github.com/addyosmani/agent-skills) (five axes, tests first, severity labels, common rationalizations).

## Who writes it

**The agent in charge of the PR(s) writes the guide itself**, whichever session briefed, reviewed and drove them (normally the captain). It holds the context: why each choice was made, the review findings, the decisions taken since. Do **not** hand the guide, or its HTML, to a new crew, a side session or a fresh subagent; it lacks that context and produces a shallow guide. If you have rolled over or compacted, reload context first (your handoff, `gh pr view N --comments`, the commit history, the review findings) and then write it yourself.

## LOCAL ONLY — never post the guide

**The guide is for the operator. Never post it, or any part of it, on a PR, issue, tracker ticket, chat channel or any other shared place.** Not as a comment, a description edit, a review body or a status update.

- Subagents and workflows can read a conversation-level request ("write a review guide") and act on it publicly. A guide has been posted to a PR this way. Do not hand the request to anything that can comment.
- **While a guide request is fresh in the conversation, run PR review tools with commenting off** (e.g. a `comment: false` / `--no-comment` option).
- **After any PR review tool run that may comment, read the posted comment back** (`gh pr view N --comments`) and strip anything beyond the tool's standard body (verdict line, summary, suggestions, markers).
- A GitHub comment edit keeps its history. Full removal needs "delete revision" or delete-and-repost. If a guide leaked, tell the operator at once; do not silently edit.
- Write the files only under `<workspace>/artifacts/review-guides/` (see Output). Do not commit them to a code repo.

## Output mode

| Input | Output |
|---|---|
| **One PR** | Answer in chat, using the per-PR structure below. No file, unless the operator asks for the HTML too (then write both). |
| **Several PRs** | One local file `<workspace>/artifacts/review-guides/<YYYY-MM-DD>-<topic>.md` (source of truth) plus an interactive `.html` filled from the same facts, opened locally with `open <file>`. |

Language: write the guide in the operator's own language, taken from their profile or preferences, else from the language of the conversation. Code identifiers, paths and commands stay untranslated. If their preferences ask for bilingual local docs, the HTML offers a language toggle between the operator's language and English; otherwise it has no toggle.

In the HTML, each point's **You judge** is a checkbox; per-PR progress counts judged points, and a small bar sits in each PR's tab button. Copy buttons sit next to every `Where` anchor, test path and the open-code block; a header **Copy all anchors** button copies every anchor and test path.

The multi-PR HTML tabs are: **Read first** (summary table, stack diagram, gates, human-gate purpose, severity prefixes, how to open code, review order, merge order, collapse recommendation), then **one tab per PR in review order**, then **Verdict** (per-PR progress and verdict table, pending decisions and the before-handing list, each only when the guide data provides items). Per PR: progress bar, verdict selector and notes, saved locally. The verdict comes from the selector, the notes and **Copy my findings**; there is no separate verdict template block in the HTML. A **Copy my findings** button outputs Markdown per PR (verdict and progress, findings with severity prefixes, notes, and the points not yet judged) plus the gate gaps, for the operator to paste to the session that owns the PRs. It works at phone width with no horizontal scroll, in light and dark.

Templates in this skill directory:
- `templates/guide.template.md` — Markdown skeleton with the shared sections and the per-PR block.
- `templates/guide.template.html` — self-contained interactive shell (tabs per PR with progress bars, collapsible points with a judged checkbox, copy buttons, structured context, per-test mutations, optional design-compare card, per-PR verdict and notes, copy-findings, optional primary/English language toggle, light/dark). Opens as-is with invented sample data. **You fill it yourself** by copying the file next to the Markdown and replacing the `GUIDE` data object (a plain JS literal; the comment above it says how); keep the rest. No render step, no network, no storage required.

## Process

1. **Gather facts, do not recall.** PR list, base/head branches and SHAs, sizes, commit headlines (`gh pr view N --json number,title,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,commits`), gate results, CI result against the base branch, open decisions and unresolved review threads.
2. **Build the gate coverage map** for the PR(s): every gate that ran (agent review rounds, CI, lint, guard tests, KB rule checks, the repo's PR review tool) and what it covers *in this diff*. Read the gate output; do not assume a gate covers a file because it exists.
3. **Pick the points from the map.** A point goes in only if no gate covered it, or only a human can judge it (public contracts and names, intent, trade-offs, test validity, live UI; plus security-sensitive code, the most complex mechanism, deliberate debt and breaking changes when no gate covered them). Give each point a `Gated by` value. Drop what a gate verified.
4. **List the gate gaps**: what should have been machine-checked but is not (a template no test renders, a rule enforced only by prose, a contract name no test pins). Give each a suggested new gate or a follow-up ticket.
5. **Verify every anchor at the head SHA.** `git fetch origin`, then `git grep -n '<pattern>' origin/<branch> -- <path>` for each `Where`. State the head SHA at the top of the guide. Give both `file:line` and the symbol name.
6. **Write the Markdown** yourself, then for several PRs fill the HTML template yourself from the same facts and open it locally (`open <file>`). Do not delegate either step.
7. **Keep it in sync.** Review often runs while crews still push fixes. State the head SHA per PR. On **every** head update, refresh that PR's SHA and re-run the anchor check, update lines, and record decisions taken since (e.g. "owner chose X"), and refresh or clear the pending-decisions list. Update the HTML data block too; the page's saved checkboxes and notes are keyed by PR id, so they survive a re-render.
8. **Never post it** (rule above).

## Per-PR structure

### 1. Context
Structured lists, each optional: **features added**, **bugs fixed**, **deliberately not done**, **breaking changes**, **waits on** (blocked by other people or PRs), plus the ticket id. Also size (files, +/−), base and stack position, and which automated gates already ran and what they found.

### 2. Tests first
One entry per test (file path, what it proves). Give **each** its own concrete **manual mutation** where one makes sense, so the reviewer can confirm the tests are real: "change `<expr>` at `src/orders/service.ts:88` (`createOrder`); `orders.service.test.ts › rejects empty cart` must go red." If it stays green, the test is decoration.

### 3. Implementation points
Each point has the same fields (order: Where / Gated by / What / Why / Cause / Solution / You judge / Axis):

| Field | Content |
|---|---|
| **Where** | `file:line` **and** symbol name, verified at the head SHA |
| **Gated by** | `none`, or `<gate> (partial: <what it covers>)`. Never a point a gate fully verified |
| **What** | What the code does |
| **Why** | The problem or need the reviewer sees: symptom, requirement or constraint |
| **Cause** | The root cause behind it: what in the code, data or design produced the problem. Required for a bug fix, a review finding or a reversed earlier choice; omit for a pure design choice (the HTML hides the row) |
| **Solution** | The approach and its trade-off |
| **You judge** | The concrete question only a human can answer (name a public contract, accept a trade-off, a duplicated helper as debt) |
| **Axis** | One or more of Correctness / Readability / Architecture / Security / Performance |

Balance: each point needs what, why and how plus the human question, but not a paragraph per line of the diff. Keep "what to verify" and "why it is built this way" in separate fields; the operator wants both.

**Why vs Cause.** Why is what the reviewer sees; Cause is what produced it. Example: *Why:* "the stack diagram rendered object text"; *Cause:* "`h()` appended nested arrays without flattening, so `String(array)` leaked". Without the cause the reviewer cannot tell whether the fix hits the root or patches the symptom.

### Axis tags, no generic checklist
The five axes (Correctness, Readability, Architecture, Security, Performance) are **tags on each point**, not a checklist. **Every checkbox on the page is a specific question about this PR** (a point's "You judge", a handoff item). A generic "is it readable?" box contradicts the core principle: the human reviews only what the gates missed. Progress counts judged points only.

For UI changes add a **Compare with the design** card: what to open and what to compare (layout, labels, empty and error states), side by side in a browser.

## Shared sections (several PRs)

Put these once at the top of the guide:

- **Gates already run** — the coverage map as a table: gate, what it covers in this diff, bug class it catches. The reviewer does not redo machine work.
- **Gate gaps** — table: gap (what should be machine-checked but no gate covers), where it shows in the PR, suggested new gate or follow-up ticket. The human catches it once; the ticket makes a machine catch it next time.
- **What the human gate is for** — intent and scope, public contracts, architecture trade-offs, test validity (mutation), live visual comparison.
- **Severity prefixes** for comments:

  | Prefix | Meaning | Author does |
  |---|---|---|
  | *(none)* | Required before merge | Fix |
  | `Critical:` | Blocks merge (security, data loss, broken behaviour) | Fix now |
  | `Consider:` | Worth weighing | Fix or explain |
  | `Nit:` | Small, optional | May ignore |
  | `FYI` | Information | Nothing |

- **How to open the code** — read-only worktrees per stack (`git worktree add <dir> origin/<branch>`), `gh pr diff N` for one PR's diff. The lines in the guide are valid at the stated SHAs; if they drift, search by symbol.
- **Summary table** — numbered in review order, one row per PR: PR, ticket, `branch → base`, size (files, +/−), estimated review time, focus level (High/Medium/Low), automated-gate status, and the **head SHA** the anchors were verified at.
- **Stack diagram** — which PR sits on which, one lane per stack, each starting at the base branch, e.g. `develop ← A ← B` and `develop ← C`.
- **Review order and why**, with time and focus level per PR. Default: contract/backend before UI; within a stack, stack order so each diff holds only its own change.
- **Merge order** (usually stack order, bottom first).
- **Collapse recommendation** — "should these be collapsed into fewer PRs for the lead?" Stacked PRs confuse a lead; one PR per ticket is often better. Give a recommendation and the reason, not just the question.
- **Verdict** per PR: the HTML's selector (Approve · Request changes), notes and Copy my findings produce it. The Markdown may keep a short verdict line.
- **Pending decisions** — data-driven, hidden when empty. Refresh or clear it on every head update; a stale line ("CI running") misleads the reviewer.
- **Before handing to the lead** — only when there are items (`handoff` in the HTML data). Write concrete items tied to these PRs ("follow-up ticket filed for point 2", "`ORDER_EMPTY_CART` name confirmed with the owner"), never a generic list. Every piece of accepted debt gets a follow-up ticket: "we'll clean it up later" without one is not accepted.

## Pitfalls

- **Subagents act publicly on conversation-level requests.** See LOCAL ONLY.
- **Re-checking machine work.** Asking the human to verify what CI, lint or a guard test already proved wastes the gate. If you are unsure a gate covered something, read its output; if it did not, it is a point with `Gated by: none`.
- **Silent gaps.** A point with `Gated by: none` that a machine could have caught is also a gate gap; record it in Gate gaps, not only as a point.
- **Line numbers drift** when crews push fixes. Always give the symbol and the SHA; re-verify before handing over.
- **Do not over-compress** into bare checks; **do not pad** with what machines verified.
- Do not answer a crew's confirmation prompt "no" to sequence work; send instructions as a message instead.
- A guide is not a verdict. The owner's own review still happens first; the human gate sits on top. Never merge on the guide's say-so; the review-gate contract in `captain-ops` still applies.
- Examples in the guide must come from the real PRs; never invent anchors. (The template's sample data is invented and must be replaced.)

## Common rationalizations

Guidance for the agent writing the guide; it is not shown in the HTML.

| Rationalization | Reality |
|---|---|
| "The agent review and CI passed, the human gate can be a skim" | Those gates miss intent, contract names and test validity. That is exactly what the human gate is for. |
| "Let me double-check what CI already checked" | Don't. The human gate covers only what gates cannot see. Build the coverage map, drop covered items, and spend the time on the rest. |
| "No gate covers this, but it's minor, I'll leave it out of the gaps" | A human catching it once is the cost; listing the gap with a suggested gate or ticket is what stops the next human paying it again. |
| "The tests pass, so they test the right thing" | Run the mutation. A test that stays green when the code is broken proves nothing. |
| "Line numbers are enough" | They drift on the next push. Symbol name plus SHA. |
| "Why is enough" | Why is the symptom. Without the cause the reviewer cannot tell whether the fix hits the root or patches the symptom. |
| "Short is better: just list the checks" | Without why and the solution the reviewer cannot judge the trade-off. Keep all the fields (Cause when there is a defect behind the point). |
| "I'll spin up a fresh agent to write the guide" | It lacks the why: the review findings and decisions. The agent in charge of the PRs writes it, reloading context from its handoff and the PR history if needed. |
| "I'll post the guide on the PR so everyone sees it" | Never. It is the operator's private aid. Leaked guides get deleted, and edit history stays. |
| "It's debt, we'll clean it up later" | Not accepted without a follow-up ticket. |
| "The PR is big, I'll review what looks risky" | Then say which parts you skipped. Ask the crew to split a PR that cannot be reviewed. |
| "My memory of the diff is fine" | Gather facts again: SHAs, sizes, gate results. Recall is how stale anchors ship. |
