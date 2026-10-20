---
name: human-review-guide
description: Write the operator a short, well-sourced guide for the human gate of crew PRs. Use when the operator says "review guide", "how should I review these PRs", "guide me through the PRs", "what should I focus on in review", "what do I check before merging", or is about to review one or more crew PRs by hand. One PR → answer in chat; several PRs → one local interactive HTML. The guide is LOCAL ONLY and is never posted anywhere. Captain skill.
---

# human-review-guide — a local guide for the human review gate

Machines already review crew PRs: crew self-review, the captain's agent review, a repo's PR review tool, CI, guard tests. They catch local bugs. The **human gate** is for what they cannot judge: intent and scope, public contracts and names, architecture trade-offs, whether the tests test the right thing, and a live comparison with a design or prototype. This skill produces the guide that makes that review fast.

Structure follows [addyosmani/agent-skills `code-review-and-quality`](https://github.com/addyosmani/agent-skills) (five axes, tests first, severity labels, verdict template, common rationalizations).

## Who writes it

**The agent in charge of the PR(s) writes the guide itself**, normally the captain that briefed, reviewed and drove them. It holds the context: why each choice was made, the review findings, the decisions taken since. Do **not** hand the guide, or its HTML, to a new crew, a side session or a fresh subagent; it lacks that context and produces a shallow guide. If you have rolled over or compacted, reload context first (your handoff, `gh pr view N --comments`, the commit history, the review findings) and then write it yourself.

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
| **One PR** | Answer in chat, using the per-PR structure below. No file. |
| **Several PRs** | One local file `<workspace>/artifacts/review-guides/<YYYY-MM-DD>-<topic>.md` (source of truth) plus an interactive `.html` filled from the same facts, opened locally with `open <file>`. |

Language: write the guide in the operator's own language, taken from their profile or preferences, else from the language of the conversation. Code identifiers, paths and commands stay untranslated. If their preferences ask for bilingual local docs, the HTML offers a language toggle between the operator's language and English; otherwise it has no toggle.

The multi-PR HTML tabs are: **Read first** (summary table, stack diagram, gates, human-gate purpose, severity prefixes, how to open code, review order, merge order, collapse recommendation), then **one tab per PR in review order**, then **Verdict**. Per PR: checklist, progress bar, verdict selector and notes, saved locally. A **Copy my findings** button outputs Markdown per PR with severity prefixes for the operator to paste to the captain. It works at phone width with no horizontal scroll, in light and dark.

Templates in this skill directory:
- `templates/guide.template.md` — Markdown skeleton with the shared sections and the per-PR block.
- `templates/guide.template.html` — self-contained interactive shell (tabs per PR, collapsible points, checkboxes with progress, per-PR verdict and notes, copy-findings, optional primary/English language toggle, light/dark). Opens as-is with invented sample data. **You fill it yourself** by copying the file next to the Markdown and replacing the `GUIDE` data object (a plain JS literal; the comment above it says how); keep the rest. No render step, no network, no storage required.

## Process

1. **Gather facts, do not recall.** PR list, base/head branches and SHAs, sizes, commit headlines (`gh pr view N --json number,title,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,commits`), gate results, CI result against the base branch, open decisions and unresolved review threads.
2. **Pick the points that need a human**: public contracts and names, security-sensitive code (auth, SQL, input handling), the most complex mechanism, deliberate debt, breaking changes. Skip what a machine verified (formatting, types, trivially covered branches).
3. **Verify every anchor at the head SHA.** `git fetch origin`, then `git grep -n '<pattern>' origin/<branch> -- <path>` for each `Where`. State the head SHA at the top of the guide. Give both `file:line` and the symbol name.
4. **Write the Markdown** yourself, then for several PRs fill the HTML template yourself from the same facts and open it locally (`open <file>`). Do not delegate either step.
5. **Keep it in sync.** Review often runs while crews still push fixes. State the head SHA per PR. On **every** head update, refresh that PR's SHA and re-run the anchor check, update lines, and record decisions taken since (e.g. "owner chose X"). Update the HTML data block too; the page's saved checkboxes and notes are keyed by PR id, so they survive a re-render.
6. **Never post it** (rule above).

## Per-PR structure

### 1. Context
What the PR does; what it deliberately does not do; breaking changes; size (files, +/−); base and stack position; which automated gates already ran and what they found.

### 2. Tests first
Which tests prove what. Then one concrete **manual mutation** so the reviewer can confirm the tests are real: "change `<expr>` at `src/orders/service.ts:88` (`createOrder`); `orders.service.test.ts › rejects empty cart` must go red." If it stays green, the test is decoration.

### 3. Implementation points
Each point has the same six fields:

| Field | Content |
|---|---|
| **Where** | `file:line` **and** symbol name, verified at the head SHA |
| **What** | What the code does |
| **Why** | The problem or constraint that forced it (often a bug found in review) |
| **How solved** | The approach and its trade-off |
| **You judge** | The concrete question only a human can answer (name a public contract, accept a trade-off, a duplicated helper as debt) |
| **Axis** | Correctness / Readability / Architecture / Security / Performance |

Balance: each point needs what, why and how plus the human question, but not a paragraph per line of the diff. Keep "what to verify" and "why it is built this way" in separate fields; the operator wants both.

### 4. Five-axis checklist
- **Correctness** — matches the stated intent and edge cases; errors handled; tests cover the behaviour, not the implementation.
- **Readability** — names say what things are; no clever tricks where plain code works; comments explain why.
- **Architecture** — fits existing patterns and layering; no new abstraction without a second user; dependencies point the right way.
- **Security** — input validated at boundaries; auth and permission checks present; no secrets or user data in logs.
- **Performance** — no unbounded loops, N+1 queries or avoidable work on a hot path.

For UI changes add: **compare with the design/prototype live**, side by side, in a browser.

## Shared sections (several PRs)

Put these once at the top of the guide:

- **Gates already run** — table: gate, what it did, bug class it catches. The reviewer does not redo machine work.
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
- **Summary table** — one row per PR: PR, `branch → base`, size (files, +/−), estimated review time, focus level (High/Medium/Low), automated-gate status, and the **head SHA** the anchors were verified at.
- **Stack diagram** — which PR sits on which, e.g. `develop ← A ← B ← C`.
- **Review order and why**, with time and focus level per PR. Default: contract/backend before UI; within a stack, stack order so each diff holds only its own change.
- **Merge order** (usually stack order, bottom first).
- **Collapse recommendation** — "should these be collapsed into fewer PRs for the lead?" Stacked PRs confuse a lead; one PR per ticket is often better. Give a recommendation and the reason, not just the question.
- **Verdict template** per PR: Context / Correctness / Readability / Architecture / Security / Performance / Verification / Verdict (Approve · Request changes).
- **Before handing to the lead** checklist: every `Critical`/required finding resolved; verdicts filled; anchors re-verified at current heads; **a follow-up ticket exists for every piece of accepted debt** ("we'll clean it up later" without a ticket is not accepted).

## Pitfalls

- **Subagents act publicly on conversation-level requests.** See LOCAL ONLY.
- **Line numbers drift** when crews push fixes. Always give the symbol and the SHA; re-verify before handing over.
- **Do not over-compress** into bare checks; **do not pad** with what machines verified.
- Do not answer a crew's confirmation prompt "no" to sequence work; send instructions as a message instead.
- A guide is not a verdict. The captain's own review still happens first; the human gate sits on top. Never merge on the guide's say-so; the review-gate contract in `captain-ops` still applies.
- Examples in the guide must come from the real PRs; never invent anchors. (The template's sample data is invented and must be replaced.)

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "The agent review and CI passed, the human gate can be a skim" | Those gates miss intent, contract names and test validity. That is exactly what the human gate is for. |
| "The tests pass, so they test the right thing" | Run the mutation. A test that stays green when the code is broken proves nothing. |
| "Line numbers are enough" | They drift on the next push. Symbol name plus SHA. |
| "Short is better: just list the checks" | Without why and how solved the reviewer cannot judge the trade-off. Keep all six fields. |
| "I'll spin up a fresh agent to write the guide" | It lacks the why: the review findings and decisions. The agent in charge of the PRs writes it, reloading context from its handoff and the PR history if needed. |
| "I'll post the guide on the PR so everyone sees it" | Never. It is the operator's private aid. Leaked guides get deleted, and edit history stays. |
| "It's debt, we'll clean it up later" | Not accepted without a follow-up ticket. |
| "The PR is big, I'll review what looks risky" | Then say which parts you skipped. Ask the crew to split a PR that cannot be reviewed. |
| "My memory of the diff is fine" | Gather facts again: SHAs, sizes, gate results. Recall is how stale anchors ship. |
