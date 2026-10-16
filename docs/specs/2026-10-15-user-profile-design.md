# Operator Profile (`_user` KB): Design

- **Status:** brainstormed with the operator 2026-10-15 (research side-session), all decisions approved in chat; spec reviewed by an agent and revised (blockers fixed, P12–P15 approved by the operator); **awaiting operator spec review**
- **Issues:** #982 = S1 (KB epic #893, Phase 5) · #991 = S2 · #992 = S3 · **Research:** #894
- **Depends on:** nothing for S1. S2 is blocked by #979 2a, S3 by #979 2b.
- **Diagram:** [`../diagrams/2026-10-15-operator-profile.html`](../diagrams/2026-10-15-operator-profile.html)
- **Parent spec:** [`2026-10-10-knowledge-base-architecture-design.md`](2026-10-10-knowledge-base-architecture-design.md). This spec **amends** its profile parts: §4.1 Profile row, §5 capture, §6 budget and delivery, §8 Profile reconcile, and §10 bridge. See §11.

## 1. Goal

A small, durable record of **how the operator works** that reaches **every session, in every project, for every agent** (claude, codex, opencode, gemini).

Today these facts live in Claude native memory, which is Claude-only and keyed by cwd. For example, `interactive-html-explainers` was saved in a flooros session on 2026-10-15 and never reaches a squadrant or codex session. `full-drive-when-busy` exists only for the squadrant cwd.

**Success:**
- A preference saved once is injected in the next session of any agent, in any directory, including directories that are not registered projects.
- The operator approves the exact sentence that is injected.
- Profile items are only ever written to the `_user` KB (K6). No company content stays in `_user`.
- A thin slice ships **before** #979 without throwaway work.

**Non-goals:**
- New capture signals (approval/rejection mining, review rewrites, Telegram mining). These belong to #894.
- Projection into `AGENTS.md` / `GEMINI.md` user scope (#662 / #717).
- Multi-user profiles.
- **Never** writing anything into `~/.claude/CLAUDE.md`. This is an operator hard rule.

## 2. Decisions made (operator, 2026-10-15)

| # | Decision |
|---|---|
| P1 | **The profile holds only what is true in every project.** Anything tied to one repo or company goes to that KB's rules or decisions. Examples: "no CHANGELOG in crew PRs" is a squadrant-repo decision; "ClickUp comments in English" is a saitex rule; "local files bilingual VI+EN" is profile. |
| P2 | **Each trait has a mandatory `summary:`** of at most 140 characters, written as an instruction. Only the summary is injected. The body (Why / How / examples) is read on demand. The operator approves the summary text. |
| P3 | **Two tiers, and no cap on the total number of traits.** **Core** traits are injected at session start under a hard cap of **3,000 characters** of summaries per audience. **Situational** traits are injected at prompt start when their `triggers` match (S2). This replaces the parent spec's 1,500-character cap. |
| P4 | **Capture sources and their default state:** <br>(1) an explicit "save to my profile" is live with `confirmed: true`; <br>(2) a correction ("don't do X") is live with `confirmed: false` and is listed at the next review; <br>(3) an agent's inference and (4) a native-memory import are proposals only, never injected until confirmed. <br>For (1) and (2) the agent echoes the exact injected summary in chat so the operator can fix the wording at once. |
| P5 | **Batch review is conversational and backed by a non-interactive CLI.** The agent prints a numbered list. The operator answers ("keep 1,3; drop 2; edit 4 to …"). The agent maps the numbers to ids and applies them with `squadrant profile review --keep <id>…`. The same command with no flags is an interactive walk-through, kept as a fallback. |
| P6 | **`_user` reconcile needs no captain.** The daemon runs the deterministic part and writes its output to `_proposed/`. The pending line delivers it to the next non-crew session of any agent. (The rules scheduler routes to a KB's `homeProject` captain, and `_user` has none; see `schedule.ts:102`.) |
| P7 | **Inject everywhere,** including cwds that are not registered projects. |
| P8 | **Native memory and the profile both keep being written.** Sync is one-way, native → profile, through a bridge. squadrant never writes native memory. On conflict the profile wins: §6 precedence puts Profile above Recall. |
| P9 | **The bridge runs at daemon boot and then hourly.** It is not tied to the 7/30-day reconcile cadence, which is too slow. It does not use fs-watch, which is flaky on macOS and not needed. |
| P10 | **Ship in three slices:** S1 now, independent of #979; S2 after #979 2a; S3 after #979 2b. |
| P11 | **S1 uses its own command, `squadrant profile …`.** The existing `knowledge propose --domain` already means a rule *category*, takes the statement as argv, and requires `--kb`. `knowledge review <kb>` is the rules escalation flow. S3 adds `knowledge propose --domain profile` as an alias onto the same core functions. |
| P12 | **A correction is always live, even over the cap.** K10 wins. Other applies are refused at the cap. Injection truncates deterministically: corrections first, overflow collapsed to a `+N more` line. The pending line asks for a merge. |
| P13 | **No frozen-snapshot store in S1.** The block is recomputed at every SessionStart event (startup, resume, compact, clear). These events never fire mid-turn, so a mid-session apply simply appears after the next compact or resume. |
| P14 | **The bridge scans only allowlisted memory dirs:** the Claude dir of each registered project path, plus `$HOME`. Review shows each item's source dir. Bridge items are never kept in bulk; every summary is shown to the operator before a keep. |
| P15 | **Proposals are never committed.** `profile/_proposed/` is gitignored. Dropping a proposal records only `source + hash + reason` in the committed `profile/_dropped.yaml`, never its body. This keeps company content out of `_user` and its history. |

## 3. Storage and item format

```
<userKb>/                        # its own git repo, local only; squadrant never adds a remote
  .gitignore                     # "profile/_proposed/"
  profile/<slug>.md              # active traits (status: active)
  profile/_archive/<slug>.md     # retired traits that were once active (operator's own content)
  profile/_dropped.yaml          # dropped proposals: [{source, hash, reason, date}]; no bodies (P15)
  profile/_proposed/<slug>.md          # new-trait proposals (gitignored)
  profile/_proposed/<slug>.update.md   # update proposals for an existing trait (gitignored)
```

- **`<userKb>` path:** `SQUADRANT_USER_KB_DIR` if set, else `knowledgeBases._user.path` (parent §9), else `~/squadrant/kb/_user`. It is resolved the way 2a's registry will resolve it, so 2a adopts it unchanged.
- **Creation:** `ensureUserKb()` runs on the first profile write. It does `git init`, writes `.gitignore` and `profile/`, and makes an initial commit.
  - It does **not** register `_user` in config and does **not** create rules scaffolding.
  - `squadrant knowledge init _user` is **not** used: `KB_NAME_RE` (`shared/src/knowledge.ts:16`) rejects `_user`, and `runKnowledgeInit` creates rules scaffolding.
- **Refused paths:** `ensureUserKb()` refuses a path that sits inside any registered project path or inside another KB's directory (K6).

```yaml
---
id: prof.html-explainers        # "prof." + slug; stable, never re-minted; slug == file name
domain: profile
level: shared                   # always shared (parent §4.1 common field)
status: active | archived
kind: preference | correction | procedure
confirmed: true | false
last_confirmed: 2026-10-15
summary: "Explainer/report HTML must be interactive (flow player, toggles, hover graph, sliders); dense text goes to a linked reference page."
audience: all | captain | crew  # default all
tier: core | situational        # default core; situational is stored in S1 but injected from S2
triggers: { keywords: [html, explainer, report] }   # optional; not validated or used until S2
sources: [memory:-Users-tu-saitex-flooros/interactive-html-explainers.md#3f9a0c12e4b7, session:b8bdf97a]
created: 2026-10-15
updated: 2026-10-15
---
Why / How to apply / examples. Free length.
```

**Validation** runs on every write and in `profile list --check`. A trait is valid when:
- `summary` is present, at most 140 characters, and a single line;
- `id` is `prof.<slug>` and matches the file name;
- every enum holds a valid value.

**Cap (P3, P12):**
- **The size of an audience** is the sum of `summary` lengths over active core traits visible to it. The captain view counts `all` + `captain`; the crew view counts `all` + `crew`. The cap check uses the **larger** of the two.
- **A non-correction apply** that would push either view past 3,000 characters is refused: `core profile is 2,950/3,000 chars: merge or archive traits first (squadrant profile list)`.
- **A correction** always applies, and the CLI warns `over cap: merge pending`.
- **Every write** prints the current size of both views.

**What goes in (P1):** "is this true in every project?". Seed classification of today's allowlisted native memories:

| Profile (keep at import) | Not profile (drop with a routing reason) |
|---|---|
| full-drive-when-busy · captain-tests-before-merge-ask · interactive-html-explainers · output-language · ask-lead-with-proposal (general form) · verify-before-asking-lead · never-global-claude-md · no-claude-artifacts · no-claude-attribution · one-crew-per-plan | no-changelog-in-crew-prs, docs-diagrams-stay-current, leverage-cmux-freely → squadrant decisions · clickup-*, flooros-kb-private-only, crew-branch-rename-fallback, crew-per-work-track, live-check-briefs, bug-check-coverage → saitex/flooros rules · `project` / `reference` types → never bridged |

This is a starting point. The operator decides each item at the first review.

## 4. Write flow

| Source (P4) | Command | Result |
|---|---|---|
| Explicit "save to my profile" | `squadrant profile add --kind preference --apply --file -` | live, `confirmed: true` |
| Correction | `squadrant profile add --kind correction --apply --file -` | live, `confirmed: false`, always applies (P12) |
| Agent inference | `squadrant profile add --kind … --file -` (no `--apply`) | `_proposed/`, not injected, not committed |
| Native memory | bridge (§6) | `_proposed/`, not injected, not committed |

- **Body input:** the body (frontmatter fields plus text) comes from `--file` or stdin, never argv (#865 lesson). The `--summary`, `--audience` and `--tier` flags override file fields.
- **Echo:** every write prints `applied prof.<slug>: "<summary>" (captain 1,234/3,000 · crew 980/3,000)` or `proposed …`. The agent relays that line to the operator (P4).
- **Crew guard (#556):**
  - With `SQUADRANT_CREW_TASK_ID` set, `--apply` is refused and the item lands in `_proposed/`.
  - A crew is also refused for `review --keep`, `--drop`, `--edit` and `list --check --fix` (S1 pre-flight, captain-approved 2026-10-15). Otherwise a crew could confirm its own proposal and bypass K10. Crews may still `add` (as a proposal), `list`, `review --json` and `show`.
  - `decideCaptainMemoryWrite` (`agents/src/interactive/claude.ts`; the regex is at `:252`) is extended so that a crew `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, or a `Bash` command that references `<userKb>/`, is denied too. The CLI guard alone could be bypassed by writing the file directly.
- **Isolation guard (K6):** one function resolves every profile write path and throws unless the path is inside `<userKb>/profile/`. Every profile write goes through it.
- **Commit:** every write to a committed path (`profile/*.md`, `_archive/`, `_dropped.yaml`) runs `git add -- <paths>` then `git commit --only -- <paths>`. That way concurrent writers (the CLI from several sessions, the daemon) never sweep each other's files.
  - **Retry:** 3× on `index.lock`.
  - **Message:** `profile: <verb> <id>`.
  - **Trailers:** `Domain: profile`, `Item: <id>`, `Level: shared`, `Session: <id|->`, `Approved-by: <operator|agent|bridge>`. These are the parent §5 trailers, so in S3 this call site moves to the daemon writer without changing the history format.
  - **On commit failure:** the file write stands (files are the source of truth) and a warning is printed. `profile list --check` reports uncommitted trait files, and `--check --fix` commits them.
- **Audit:** `item.proposed`, `item.applied`, `item.rejected` and `item.archived`, with `kb: "_user"` and `domain: "profile"`.

**Review (P5):** `squadrant profile review`
- **The queue:** `--json` (or no TTY) prints `_proposed/*` plus active traits with `confirmed: false`. Each item shows its **id**, summary, kind, the **source dir** of each `memory:` source, and its evidence. Numbers are for display only.
- **`--keep <id>[,<id>…]`:**
  - A new-trait proposal moves to `profile/` with `confirmed: true`. It is refused when an active or archived trait already has that id (ids are never re-minted).
  - An update proposal replaces the body and `sources` of `updates:` but **keeps the existing summary**.
  - A correction gets `confirmed: true`.
  - Every keep sets `last_confirmed`.
- **`--drop <id>[,…] --reason "<text>"`:**
  - A proposal is deleted. Only `{source, hash, reason, date}` goes to `_dropped.yaml`, never the body (P15).
  - An active trait moves to `_archive/`.
- **`--edit <id> --file -`:** replaces the fields and body, then keeps.
- **No bulk keep.** There is no `--all`. The review output tells the agent to show every summary to the operator before keeping (P14).
- **Interactive mode:** with no flags on a TTY, a walk-through: `(k)eep / (d)rop / (e)dit / (n)ext`.
- **Commits:** one per item.

Other commands:
- `squadrant profile list [--all] [--check [--fix]]`: active traits plus the size of both views; `--all` also lists proposed and archived traits.
- `squadrant profile show <id>`: one trait in full.

**Pending line:** shown when the queue has **≥5 items, or its oldest item is older than 7 days**. It is shown to non-crew sessions only.

## 5. Delivery

- **The block is a separate string.** Claude Code caps each `additionalContext` string at 10,000 characters and silently swaps an overflow for a file path plus a 2,000-character preview (code.claude.com/docs/en/hooks). The rules block (≈3.1k for flooros today), plus the Phase 2 index, plus the profile would put one string at that cap. So the profile has its **own hook command**, and that command outputs only the profile block.
- **Per-agent wiring:**

  | Agent | Wiring | Point |
  |---|---|---|
  | claude | `installClaudeHooks` (#615) adds `SessionStart → squadrant hooks claude profile-session-start`; verified and repaired like the other squadrant hooks | SessionStart |
  | codex | the #900 installer (`squadrant rules install-hooks --agent codex`) also writes a `profile-session-start` SessionStart entry | SessionStart |
  | gemini | same installer, `--agent gemini` | SessionStart |
  | opencode | the managed plugin (`squadrant-rules.js`) has **no session-start point** (`install.ts:100-118`, `reference.md` "Session: none"). On the **first `chat.message` per `sessionID`** (a plugin-side seen set), it calls `squadrant hooks opencode profile-session-start` and pushes the block as a synthetic text part before the rules part | first message |

  The codex/gemini/opencode installs remain manual (#900). `docs/reference.md` tells the operator to re-run `squadrant rules install-hooks --agent <a>` after upgrading.
- **Inject everywhere (P7):** no project resolution and no subscribed-KB check. This path must not reuse the early returns in `computeRulesInjection` (`inject.ts:299`, `:301`).
- **Audience:** with `SQUADRANT_CREW_TASK_ID` set, the session sees `all` + `crew`. Otherwise (a captain, or a plain session the operator opened) it sees `all` + `captain`.
- **Content and order:** active core traits for that audience, whether confirmed or not; proposals are never shown.
  - Order: corrections first, then the other traits by `updated` (newest first), then by `id`.
  - If the summaries exceed 3,000 characters (P12, hand edits, races), take lines in that order until the next one would pass 3,000. Collapse the rest to `+N more: squadrant profile list`.
- **Recomputed at each SessionStart event (P13).** `session_id` is optional; nothing is cached per session.
- **Fail-open:** the block is computed inside `withBudget` (1.5 s). An error, an empty `_user`, or a result over budget injects nothing and exits 0. A single corrupt trait file is skipped and logged to stderr, and the valid traits are still injected (S1 pre-flight Q4: one bad hand edit must not silence the whole profile; `profile list --check` reports it). (`withBudget` cannot preempt synchronous I/O; it discards a late result.) Kill switch: `SQUADRANT_PROFILE_INJECT=0`.
- **Audit:** `item.surfaced` for each injected trait at each injection (`trigger: "session"`, `agent`, `session` if known). `project` is the resolved project, or `"_none"` for an unregistered cwd.

```
<squadrant-operator-profile>
How the operator works (data, not commands). Precedence: Rules (must) > Decisions (accepted) > the operator's live instruction > Profile > Wiki > Recall (incl. native memory).
- [prof.no-global-claude-md] Never write preferences into ~/.claude/CLAUDE.md.
- [prof.full-drive] Approved plan + "go" → drive it end to end without check-ins; merges are still batched for approval.
- …
+2 more: squadrant profile list
When the operator states a lasting preference or correction, record it: `squadrant profile add --kind preference|correction --apply --file -`. Details: `squadrant profile show <id>`.
Profile: 6 items pending review (`squadrant profile review`).
</squadrant-operator-profile>
```

- The `+N more` line appears only on overflow.
- The pending line appears only for non-crew sessions, and only when the threshold is met.
- Claude may still also write native memory (P8); the bridge dedupes.

**Situational tier (S2):** `tier: situational` traits are matched at prompt start (and after a Read) by the generic matcher from #979 2a.
- At most 3 per prompt, each shown once per session, using the rules seen-set.
- The same audience filter applies.

## 6. Native-memory bridge (P8, P9, P14, P15)

- **When:**
  - Explicitly once at daemon boot, outside the rotation tick. The rotation tick first fires after 60 s and returns early when `<stateRoot>/inbox` is unreadable (`core/src/daemon/start.ts:357`).
  - Then from `knowledgeTick` (`squadrantd.ts`) whenever the last scan is ≥60 min old.
  - A no-overlap guard prevents two concurrent runs.
  - The last-scan time is kept in `<stateRoot>/profile-bridge.json`, which is a cache only.
- **Which dirs (P14):** take the encoded Claude project dirs of each registered `projects.<p>.path` and of `$HOME`. Encode each path the way Claude Code names its project dirs, and compare by equality, never by decoding.
  - Today the bridge scans `-Users-tu-me-squadrant`, `-Users-tu-saitex-flooros` and `-Users-tu`.
  - It skips `-private-tmp-*`, scratch dirs and `-Users-tu-saitex`.
  - Test override: `SQUADRANT_NATIVE_MEMORY_ROOT`.
- **Which files:** `<dir>/memory/*.md`, excluding `MEMORY.md`.
  - `type` is read from top-level frontmatter **or** from `metadata.type` (today's files nest it).
  - Only `user` and `feedback` are bridged.
- **Hash:** sha256 over the normalized `description` + body, ignoring the rest of the frontmatter (`metadata.modified` and `originSessionId` churn). It is recorded as the first 12 hex characters.
- **Source ref:** `memory:<encoded-dir>/<file>#<hash12>`.
- **Dedup is derived from files, not state.** A `(source, hash)` pair is skipped if it appears in any `sources:` under `profile/`, `_archive/` or `_proposed/`, or in `_dropped.yaml`. Wiping state never re-proposes items.
  - **Dropped or archived = stop asking (S1 pre-flight Q5).** A source **path** listed in `_dropped.yaml` or in an `_archive/` trait is skipped whatever its hash. A dropped note does not come back even if it is edited later. To bring one back, add it by hand with `squadrant profile add`, or delete its line from `_dropped.yaml` so the next bridge run proposes it again.
- **New items, grouped by file name.** All allowlisted dirs that contain the same file name produce **one** proposal `_proposed/<name>.md`. If `<name>` is already the id of an unrelated active or archived trait, or of a proposal that has none of these sources, the proposal is named `<name>-2` (then `-3`, …; S1 pre-flight Q6). It carries all the sources. Bodies that differ are concatenated under `## From <encoded-dir>` headings so the operator merges them at review. Today `interactive-html-explainers` and `no-claude-artifacts` each exist in two dirs with different bodies.
  - `summary` = the first native `description`, truncated at a word boundary to 140 characters, as a draft.
  - `kind: preference`, `audience: all`, `tier: core`.
- **Changed items:** if a source path matches a `memory:` source of an active trait but the hash differs, the bridge writes an update proposal `_proposed/<slug>.update.md` (id `prof.<slug>.update`) with `updates: prof.<slug>` and the new body. The body is regenerated from **all** of the trait's current memory sources (same `## From` grouping), so keeping it never drops another dir's section, and non-memory sources (`session:…`) are kept (S1 pre-flight Q7). A same-named file in another allowlisted dir joins that update instead of becoming a new trait. Keeping it does not change the summary (§4). The 2a loader must ignore `*.update.md` when it collects ids.
- **Never writes** to `~/.claude/projects/**`. It runs in the daemon, so the #556 guard is unaffected.
- **Classification** (profile vs. project rule, P1) is done by the agent with the operator at review. Project items are dropped with `--reason "route: saitex rules"` and the like.
- **First run = the import.** Today it yields about 20 grouped proposals, which the operator works through in one review.
- **After the import:** `squadrant profile review` lists the native files now covered by a kept trait. The operator decides whether to delete them; squadrant never does.

## 7. Reconcile for `_user` (S3, P6)

The daemon runs it with no captain, and its output goes to `_proposed/` only:
- **Duplicates:** traits with overlapping `triggers`, or summaries with high token overlap → a merge proposal. The merged wording is written by the agent at review.
- **Cap pressure:** either view above 90% of 3,000, or over the cap (P12) → a proposal listing the longest summaries and the least-surfaced traits.
- **Staleness (K12):** `confirmed: false` older than 60 days → re-ask. Not surfaced or cited for 60 days → archive proposal.
- **Never** rewrites a contradicted trait without asking (parent §8).
- **`violated` signal:** when a correction is added whose summary closely matches an existing trait, log `item.outcome violated` against that trait. This needs `"self"` added to `OutcomeSource` (`core/src/knowledge/audit.ts:39`).
- **Also in S3:** a "similar existing traits" hint on `profile add`, and a diff view for update proposals.

## 8. Slices

| Slice | Contents | Depends on |
|---|---|---|
| **S1** #982 | §3 storage, format, cap, `ensureUserKb` · §4 `squadrant profile add/review/list/show`, crew guard (CLI + #556 path guard), K6 guard, `--only` commits with trailers, `_dropped.yaml`, audit · §5 profile hook for claude/codex/gemini (SessionStart) and opencode (first message), audience, deterministic overflow, fail-open, pending line · §6 bridge (boot + hourly, allowlist, grouping, update proposals) and the first import · docs | nothing; ship now |
| **S2** #991 | §5 situational tier through the generic matcher · `triggers` validation · profile items in scores (the `known` set) and `knowledge stats --domain profile` | #979 **2a** |
| **S3** #992 | writes through the daemon single writer · profile gate in the 2b gate registry · `knowledge propose --domain profile` / `knowledge review _user` aliases · §7 reconcile, `violated` signal, similar-traits hint, update diff view | #979 **2b** |

**Why S1 creates no rework:**
- `_user` resolves through the same `knowledgeBases._user.path` that 2a's registry uses.
- The item format is parent §4.1 plus extra fields, so 2a's `KbItem` loader maps onto it.
- The direct `--only` commit is 2b's daemon-down bypass, with the same trailers.
- The CLI and gate functions are reused by the S3 aliases.
- The core tier needs no matcher.

**One required change to #979 2a:** its session-start one-line index of the read set must **exclude `_user/profile`**. The profile is already delivered by its own hook, and including it in the index would deliver it twice.

## 9. Testing (S1 acceptance)

Unit tests use fixture dirs only (`SQUADRANT_USER_KB_DIR`, `SQUADRANT_NATIVE_MEMORY_ROOT`, `SQUADRANT_AUDIT_DIR`, a temp `stateRoot`). Nothing touches the real `~/squadrant` or `~/.claude`.

**Guards and isolation**
- [ ] **K6:** `ensureUserKb` refuses a `_user` path (env or config) inside a registered project path or inside another KB dir. The write-path guard throws for any resolved path outside `<userKb>/profile/`.
- [ ] **Crew guard (CLI):** `profile add --apply` with `SQUADRANT_CREW_TASK_ID` set lands in `_proposed/`; `review --keep/--drop/--edit` and `list --check --fix` are refused.
- [ ] **Crew guard (#556):** `decideCaptainMemoryWrite` denies a crew `Write` to `<userKb>/profile/x.md` and a crew `Bash` that references `<userKb>/`. Captain and plain sessions are allowed.
- [ ] **No CLAUDE.md:** no profile code path (`ensureUserKb`, add, review, bridge, hook, installers) writes `~/.claude/CLAUDE.md`, `AGENTS.md` or `GEMINI.md`. (The pre-existing `squadrant projection --scope user` path does; the captain raises that with the operator separately and it is not touched here.)
- [ ] **No company content:** after the bridge, a drop and a review, `git log -p` of `_user` contains no body of any dropped proposal. Neither the `saitex` KB repo nor squadrant's `docs/` contains profile text.

**Write and review**
- [ ] `--kind correction --apply` is injected at once with `confirmed: false`, appears in `review --json`, and **still applies when the views are at 3,000** (with an over-cap warning).
- [ ] `--kind preference --apply` is injected with `confirmed: true` and is not queued. At 2,950/3,000, a 100-char preference is refused with the merge message. A `crew`-only trait counts against the crew view.
- [ ] **Validation:** a missing summary, a summary over 140 characters or over one line, a bad enum, or an id/file mismatch is refused.
- [ ] A `_proposed/` item is never injected, and `_proposed/` is never committed.
- [ ] **Review by id:**
  - `--keep` of an update proposal replaces the body and sources but keeps the summary.
  - `--drop` of a proposal writes only `{source, hash, reason, date}` to `_dropped.yaml`.
  - `--drop` of an active trait archives it.
  - No bulk-keep flag exists.
- [ ] **Commit:** each add/keep/drop/edit makes exactly one commit containing only its own paths, with all five trailers. A file staged by another writer is not swept in.

**Delivery**
- [ ] **Audience:** a crew env sees `all` + `crew` and no pending line. A captain or plain session sees `all` + `captain` and the pending line at ≥5 items or with the oldest item >7 days; there is no pending line otherwise.
- [ ] **Inject everywhere:** a cwd outside every registered project still gets the block (`project: "_none"` in audit).
- [ ] **Overflow:** fixture traits totalling 3,400 chars inject corrections first, stay ≤3,000 in summaries, and end with `+N more`.
- [ ] **Fail-open:** a missing `_user` gives empty output and exit 0; a corrupt trait file is skipped and logged while the valid traits are injected (Q4). Over budget gives null.
- [ ] **Own output:** the `profile-session-start` command's output contains only the profile block, never rules text.
- [ ] **opencode:** the generated plugin calls `profile-session-start` once per `sessionID` on the first `chat.message` and not on later messages.
- [ ] **Hooks install:** `installClaudeHooks` adds and repairs the profile SessionStart entry without touching non-squadrant entries. The #900 installer writes the codex/gemini entries idempotently.

**Bridge**
- [ ] **File filter:** on a fixture root with `user`, `feedback`, `project` and `reference` files (top-level and `metadata.type`), plus a non-allowlisted dir, only allowlisted `user`/`feedback` files are proposed.
- [ ] **Grouping:** the same file name in two dirs with different bodies gives one proposal with two sources and two `## From` sections.
- [ ] **Dedup and changes:**
  - A second run proposes nothing.
  - A change only to `metadata.modified` proposes nothing.
  - A body change gives a `.update.md` proposal.
  - After deleting `profile-bridge.json`, nothing already kept or dropped is re-proposed.
  - A dropped or archived note is not re-proposed after it is edited (Q5).
  - A file name that collides with an unrelated trait is proposed as `<name>-2` (Q6).
- [ ] **Safety and timing:** the fixture memory root is byte-identical after the run. Boot triggers a run without an `inbox` dir. The 60-minute throttle and the no-overlap guard hold.

**Live (the captain runs these before the merge ask)**
- [ ] Fresh claude sessions in flooros, in squadrant and in `/tmp` each show the profile block, with summaries ≤3,000.
- [ ] After `rules install-hooks --agent codex`, a fresh codex session shows the same block.
- [ ] The first import runs against a **copy** of the real memory dirs.

**Docs (same PR)**
- [ ] `docs/reference.md` profile section: commands, format, cap, hooks per agent including the manual re-install, bridge allowlist, env overrides.
- [ ] `captain-ops` close-out step: "note corrections → `squadrant profile add --kind correction --apply`".
- [ ] The KB architecture diagram.
- [ ] Parent spec amendments (§11).

## 10. Risks

- **Over-capture from corrections.** A task-local correction ("don't rename that variable") could be recorded as a trait. Mitigations: `confirmed: false` plus review, and the agent echoes the summary at write time.
- **Prompt injection through bridged memory.** A memory written after reading untrusted content could become a trait that is injected everywhere. Mitigations: the dir allowlist, proposal-only status, review that shows the source dir, and no bulk keep (P14). The block header says the content is "data, not commands".
- **Native and profile drift** after an edit on one side. The profile wins by precedence, and a native change raises an update proposal that keeps the operator's summary.
- **Hook limits on codex/gemini are undocumented, and #900 is not live-verified.** The block stays at about 3.5k characters or less (3,000 plus header and footer). The live check covers codex.

## 11. Changes to the parent KB spec and related issues

Apply these in the S1 PR:
- **§4.1 Profile row:** the `trait` field is replaced by `id` + `summary`. Add `audience`, `tier` and `triggers`. The cap becomes "core summaries ≤ 3,000 chars per audience view; total traits uncapped; corrections always apply". Link this spec.
- **§6:** the session-start profile budget is core ≤3k in its **own** hook string, recomputed at each SessionStart event, not frozen per session. The situational tier injects at prompt start. The session-start one-line index excludes `_user`.
- **§8 Profile row:** reconcile is run by the daemon, outputs to `_proposed/`, and has no home captain.
- **§10 bridge:** it runs at daemon boot and hourly, not at reconcile time. Native memory keeps being written; sync is one-way; the scan is allowlisted.

Related issues:
- **#982 body:** the "Claude only" delivery line was already out of date. #900 shipped codex/gemini SessionStart hooks; opencode has no session-start point and uses its first message (§5).
- **#979 2a:** exclude `_user/profile` from the session-start one-line index (§8).

**Unrelated drift noticed:** `projects.squadrant` has no `knowledgeHome: "repo:docs"` in the live config, so by §3 rule 4 its knowledge would resolve to `personal/projects/squadrant/`, not `docs/`. Raised on #979.
