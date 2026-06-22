# Self-Reporting Squadrant Defects — Design

- **Date:** 2026-06-22
- **Status:** Draft for review (research side-session; spec only, no code, no issue filed)
- **Originating ask:** Captains and crews hit defects *in squadrant itself* and stay silent. We want a low-noise feedback loop: when an agent hits something that looks like a squadrant bug, it checks the repo, and either tells the user to update (if already fixed) or files a non-duplicate issue — and optionally offers to contribute a fix.
- **The trigger that prompted this:** a transient `API error, retrying 7/10` (an Anthropic infra blip). That must **never** be filed.

## Approach: a prompt line, not a subsystem

The mechanism is **a few lines injected into the captain and crew prompts**. Agents already have `gh` and their own judgment — that's the entire toolset needed to search issues, check versions, and file. No new CLI command, no local cache, no classifier module, no redaction library. Karpathy: simplest thing that works; no speculative abstraction.

The only thing the line must get right is **signal vs. noise** — without a guard clause it will file the transient-API-error case. That guard is one phrase, not a code path.

### Why this is safe to keep this simple

Squadrant already encodes the noise boundary in code: `packages/agents/src/interactive/pane-classifier.ts` + `packages/core/src/daemon/interactive-probe.ts` detect transient banners (`API Error: 529`, `Overloaded`, `429/5xx … unavailable`, `retries exhausted`) and treat them as **recoverable**, not failures. So the prompt's "not an API/infra blip" clause is aligned with how the daemon already behaves — we're just telling the agent the same line the code already draws.

---

## The prompt line(s)

**Captain** (interactive, human-facing — can search, decide, and file):

> **Reporting squadrant bugs.** If you or a crew hit an error or behavior that looks like a defect in *squadrant itself* — a `squadrant`/`squadrantd` command throwing, a daemon/socket crash, an ENOENT or wrong path in squadrant's own files, a lifecycle signal that should have fired and didn't — and it is **not** a transient API/network blip, a config/user error, or an expected test failure, then search `tu11aa/squadrant` issues. If it's already fixed in a newer release, tell the user to update. Otherwise, if there's no open duplicate, offer to file an issue (include version + agent + OS, redact tokens and home paths). If the fix looks small, offer to draft a PR instead.

**Crew** (headless — can't prompt the user, so it routes up):

> If this task failed because of a defect in *squadrant itself* (not infra/config/an expected failure), say so in your `signal blocked`/`done` message so the captain can check the repo and file it. Don't file from the crew.

That's the whole feature. Everything below is supporting rationale and the noise rubric the captain applies — kept short, and reference-only.

---

## Behavior, step by step (what the captain does)

1. **Notice** an error/weird behavior that points at squadrant's own code/runtime.
2. **Filter noise** (rubric below). Ambiguous → do nothing. Silence beats spam.
3. **Search** `gh issue search --repo tu11aa/squadrant --state all "<signature>"`.
4. **Already fixed?** If a closed issue says it's fixed in a release newer than the running version → *"this is fixed in vX.Y.Z, update with `npm i -g squadrant@latest`."* Don't file.
5. **Open duplicate?** → don't file; optionally mention "+1, already tracked as #NNN."
6. **New?** → offer the user a one-line y/n to file (semi-auto; the user prefers prompted-at-key-moments, not nagging). File on yes.
7. **Small fix?** → offer to draft a PR instead of / in addition to the issue.

The version check in step 4 is the new, genuinely useful twist: a known-and-fixed bug becomes an *update nudge*, not a duplicate issue.

## Noise rubric (the one thing the line must get right)

**File-worthy** — points at squadrant's own code/runtime:
- a `squadrant`/`squadrantd` command throwing a stack trace through `dist/`/`packages/`
- daemon crash, socket `ECONNREFUSED`/`EADDRINUSE`, "command not found" after install (the rebrand-hook class)
- `ENOENT`/wrong path in a path squadrant computed (cf. #363)
- a state-machine invariant throw; a lifecycle signal that should have fired and didn't (#278/#339 class — captain-observed)

**Never file** — the trigger and its cousins:
- transient model-infra: `API Error: 529`, `Overloaded`, `429`, `retrying 7/10`, `retries exhausted` *(the originating case)*
- network: DNS/timeout/TLS to the model API
- user/config error: bad project name, missing token the user must set, not-a-git-repo
- expected failure: a red TDD test, a lint/type error in the crew's *target* repo
- known flakiness: the relay-proxy tests (baseline = 3 fails)

Default when any signal is ambiguous: **don't file.** (Same discipline the pane-classifier already states: "an ambiguous tail returns null.")

## Issue hygiene (captain applies inline, no tooling)

- **Title:** `[agent-report] <short signature>`; label `bug` (+ `filed-by:agent` if that label is added — one-time `gh label create`, optional).
- **Body:** what happened, best-effort repro, environment (squadrant version from `package.json`, agent + version, OS, node), and a **redacted** error excerpt — banner + top few stack frames only, never file contents; strip tokens (`ANTHROPIC_API_KEY`, `gh[pousr]_…`, Telegram `\d+:…`) and rewrite `/Users/<name>/…` → `~`.
- **Cap:** at most one new issue per session by judgment; recurring known bugs get a mention, not a re-file.

## Multi-agent portability

The lines go in **AGENTS.md** (read by claude/codex/opencode alike) and the crew **completion-protocol suffix** that's already injected per-agent. No Claude-only surface — it's prompt text + `gh`, both agent-agnostic. Satisfies the multi-agent direction in `CLAUDE.md`/`AGENTS.md`.

---

## CONTRIBUTING.md (part of this feature)

The loop ends in *"offer to draft a PR"* — but there's no `CONTRIBUTING.md` today, and the README has no contribution section. A contributor who (or an agent that) takes up the offer has nothing to point at. So this feature should ship a short `CONTRIBUTING.md` at repo root, and the issue/PR offer links to it.

Keep it minimal and sourced from conventions already true in the repo (don't invent process):

- **Setup:** `pnpm install` (repo pins `pnpm@10.30.3`); `pnpm build`, `pnpm test` (vitest), `pnpm lint` (`tsc --noEmit`).
- **Branching:** GitFlow — branch off `develop`, PR back into `develop`; `main` is release-only (per `project_gitflow_and_repo_workflow`).
- **No PR-time CI** — tests only run on push to `main`. **Run `pnpm test` and `pnpm lint` locally on a clean checkout before opening a PR** (the `project_no_pr_ci` lesson — broken tests have reached develop silently).
- **ESM / NodeNext gotcha:** relative imports need the `.js` extension or the runtime crashes even when tests pass; `node dist/index.js --help` is the real gate (the `project_esm_js_extension_gotcha` lesson).
- **Coding discipline:** the Karpathy principles (`plugin/skills/karpathy-principles/SKILL.md`) — surgical changes, simplicity first.
- **Monorepo shape:** six-package one-way DAG `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`; place changes in the right package.
- **macOS-only** for now (`project_macos_only_for_now`) — guard platform tests accordingly.
- A line pointing agent-filed issues (`[agent-report]`) at this guide, closing the loop: bug found → issue → fix → PR.

This also benefits human contributors generally, independent of the self-report loop. Optionally add a matching `.github/PULL_REQUEST_TEMPLATE.md` (defer if you want to keep v1 tight).

## Adjacent finding (separate small fix)

`packages/cli/src/commands/feedback.ts` hardcodes `const squadrantVersion = "0.1.0";` — wrong (real version `0.9.1`). Any version string the report includes should come from `package.json` / the `_squadrantVersion` stamp (`packages/shared/src/lib/config-version.ts`), and `feedback.ts` should be fixed too.

## Deferred — only if the prompt-line version proves noisy

If real-world use shows the prompt line is too spammy or too silent, *then* consider escalating to tooling: a `squadrant issue report` helper with a fingerprint-based dedup cache and a mechanical deny-list (reusing the `pane-classifier.ts` regex as a hard safety gate), and/or daemon-side auto-detection in `interactive-probe.ts` (which already classifies panes and excludes transient banners). **Not built in v1** — it's speculative until the simple version is shown to fail. Captured here so the escalation path is known, not so it's built.

---

## Recommendation on a meta dogfood issue

**Recommend filing one** short tracking issue (it dogfoods the very loop it describes). **Leave the filing to the captain/user** — this side-session does not file. Draft:

> **Title:** `[agent-report] Add a self-reporting prompt line so agents flag squadrant defects (check → update-or-file, low-noise)`
> **Labels:** `enhancement`
>
> **Problem.** Captains/crews hit defects in squadrant itself (CLI throw, daemon crash, ENOENT in squadrant paths, a lifecycle signal not firing) and stay silent. Meanwhile the failure they hit *most* is transient model-infra (`API error, retrying 7/10`) which must never be filed.
>
> **Proposal (minimal).** A few prompt lines in AGENTS.md + the crew completion-protocol suffix: when an agent hits a likely *squadrant* defect (not an API/infra blip, config/user error, or expected test failure), it searches `tu11aa/squadrant` — if already fixed in a newer release, nudge the user to update; else if no open duplicate, offer to file (redacted, with version/agent/OS); offer a fix PR if small. Crews route the finding up to the captain rather than filing. No new code — agents use `gh` + judgment.
>
> **Also add** a root `CONTRIBUTING.md` (setup/branching/test-before-PR/the `.js` + no-PR-CI gotchas) so the "offer a fix PR" path has something to point at.
>
> **Spec:** `docs/superpowers/specs/2026-06-22-self-report-squadrant-defects-design.md`.
> **Adjacent fix:** `feedback.ts` hardcodes version `0.1.0` (should read from package.json).
> **Escalation path (deferred):** a deduping `squadrant issue report` helper + daemon-side detection, only if the prompt-line version proves noisy.
