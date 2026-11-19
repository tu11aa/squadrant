# captain-ops split: per-rule inventory (#1109, #1142)

Every rule or instruction of the old `plugin/skills/captain-ops/SKILL.md` (43,380 bytes, 621 lines, commit before this PR) and where it went. Paths are under `plugin/skills/captain-ops/` unless noted. "core" = new `SKILL.md` (2.7 KB); "startup" = `plugin/skills/captain-startup/SKILL.md` (1.7 KB). Startup now loads about 4.4 KB (~1.1k tokens) instead of 43 KB.

Mechanical check: every non-blank line of the old file was searched in the new core + reference files; the only lines not found verbatim are the ones marked *moved/condensed/dropped* below (Session Startup, Message Senders, MCP Tools, Crew Setup, Task Master, two cross-reference lines, and the OpenSpace sections).

Tóm tắt (VI): file cũ 43 KB được tách thành core ngắn (bảng trigger duy nhất + 3 rule chỉ có ở đây) và 9 file reference đọc khi cần. Mọi section đều có chỗ đi; chỉ bỏ Task Master (không cài, không dùng) và phần lặp lại template; OpenSpace được rút gọn vì script vẫn ship. Bảng bên dưới liệt kê từng rule.

## Where the trigger table lives

Only in the core `SKILL.md` ("Trigger table (the one source)"). The startup skill and the templates point to it and do not copy it. Reason: the core is the file a captain re-reads mid-session or after `/compact`, and a text projection (AGENTS.md) carries it with the skill; a second copy would drift.

## Inventory

| # | Old section / rule | Went to | Note |
|---|---|---|---|
| 1 | Session Startup: run the 4-step contract from the system prompt | startup | pointer left in old place is gone; core says startup lives in captain-startup |
| 2 | Step 1: `handoff facts {project} --fetch`, refs updated so facts are verified | startup step 1 + step 4 | |
| 3 | Step 2: seven branchState flags and what each means | startup step 2 | condensed wording, all seven kept |
| 4 | Step 3: `liveRepo.liveCrews`; blocked crew with a question waits on you | startup step 3 | |
| 5 | Step 4: `read-handoff.sh`; read currentState/openBranches/nextSteps/blockedItems/decisions | startup step 4 | now "once": use `checkpoint.content` if set, else `read-handoff.sh` (#1142) |
| 6 | Step 4: when `"exists": false`, rebuild from facts (checkpoint, gapSessions, claudeMem) | startup step 4 | |
| 7 | Step 5 (opt-in): claude-mem search, latest daily log, learnings, skills/, wiki/ | core "Rules that live only here" (last bullet) | |
| 8 | Crew lifecycle events reach the pane with no relay (#332) | core, bullet 4 | |
| 9 | Message Senders (📨 header rule) | dropped, repeats template | identical text is rule 7 in `templates/captain.claude.md` and rule 8 in `captain.generic.md` |
| 10 | MCP Tools (`mcp__squadrant__*` list, ToolSearch fallback, never-over-MCP list) | dropped, repeats template | identical paragraph is the "MCP tools" section of `captain.claude.md` (Claude-only text) |
| 11 | Crew Setup: no Agent Team; spawn as a new tab; nothing to set up | dropped, repeats template | HARD RULE 5 and Core Rule 2 of `captain.claude.md`; `captain.generic.md` rule 2 |
| 12 | Task Decomposition with Task Master (whole section, 38 lines) | dropped | not installed (`task-master` binary absent, no MCP entry in `~/.claude.json`/`settings.json`, no squadrant code references it); only ROADMAP.md/QUICKSTART.md mention it, left untouched |
| 13 | Spawning Crew: MUST spawn a crew for any coding task | `spawning.md` (and template HARD RULES 1-3) | |
| 14 | Crew = interactive sub-session, named crew-N | `spawning.md` | |
| 15 | Spawn a NEW crew: syntax, 4 steps, claude brief storage (`crew tasks`, `crew msg`, `--task-file`, 1200 B) | `spawning.md` | verbatim |
| 16 | Follow-up with `send`, don't spawn per turn | `spawning.md` | |
| 17 | Inspect and shutdown commands (`list/tasks/read/msg/close`) | `spawning.md` | |
| 18 | Examples (5 commands) | `spawning.md` | |
| 19 | Leveled crew routing table, override flags, `add-pick-crew-rule` | `spawning.md`; skill in core table row 1 | |
| 20 | Effort mode table, crew-only, weakest signal, `set-effort` | `spawning.md`; skill in core table row 1 | |
| 21 | Crafting briefs: threshold gate, Template M, agent tuning, `prompt-master` | `briefs.md`; skill in core table row 2 | |
| 22 | Spawning Rules: reuse with send, close finished crews, isolated worktrees / `--shared`, never hand-run `git worktree add`, no source edits, `maxCrew` and held crews, GSD for complex tasks | `spawning.md` | |
| 23 | Note on codex interactive / gemini print-mode | `spawning.md` | |
| 24 | Task Coordination: HARD RULE do not poll crew screens | core "Rules that live only here" bullet 1 and `coordination.md` | kept in both: it is a hard rule with no template copy |
| 25 | Status via daemon events, `crew read`/`tasks`/`list` on demand, bounded checks only | `coordination.md` | |
| 26 | Handling CREW IDLE / BLOCKED: a/b/c ambiguity, spot-check table, rendered-prompt `crew answer`, do not re-send the original task | `coordination.md`; "do not re-send" also in core bullet 2 | |
| 27 | Crew status via `runtime send`: acknowledge and update handoff | `coordination.md` | |
| 28 | Triage levels 1/2/3, level-3 example, escalation | `question-triage.md` (and template "Crew questions" section) | |
| 29 | Second thread trigger; operator answers in captain pane | `question-triage.md` (and template) | |
| 30 | Threads commands, dedup, cap, park message, agents without fork | `question-triage.md` | |
| 31 | Assessment Gate: review modes, diff, classify table, never auto-terminalize, no re-send or close while in review | `review-gate.md`; core bullets 2 and 3 | |
| 32 | Grade KB rules at review (`knowledge surfaced/feedback`, #945) | `review-gate.md`; `rules-ops` in core table row 5 | |
| 33 | `human-review-guide` when the operator reviews by hand | `review-gate.md`; core table row 5 | |
| 34 | When Crew is Fully Finished: close, verify no orphaned processes, learnings, handoff | `review-gate.md` | two cross-references now point to `knowledge.md` and `shutdown.md` |
| 35 | Live-checking a branch build (dev daemon only, never `npm i -g` + heal) | `review-gate.md` | |
| 36 | Status Board: when to show, pull fresh state, format, rules | `status-board.md` | |
| 37 | Replying to Telegram-originated tasks | `status-board.md` | |
| 38 | Session Shutdown: daily log, wiki promotion, profile corrections (#982), handoff write | `shutdown.md`; skills in core table row 7 | |
| 39 | Handoff consolidation rule (read first, verify done items, keep open items and decisions) | `shutdown.md`; also referenced by `rollover` and `restart` skills (updated to name `shutdown.md`) | |
| 40 | Rollover, restart vs rollover, rollover suggestions (#1015), crew compact | `shutdown.md`; `rollover`/`restart` in core table row 7 | |
| 41 | Project Rules (KB): `rules search` before decomposing or reviewing | `knowledge.md`; `rules-ops` in core table row 8 | |
| 42 | Group Awareness | `cross-project.md` | |
| 43 | Cross-Project Delegation: ping vs dispatch, rules, dispatch-and-yield, report-back, example | `cross-project.md` | |
| 44 | Recording Learnings | `knowledge.md` | |
| 45 | Wiki Compilation, learnings vs wiki | `knowledge.md`; `wiki-ops` in core table | |
| 46 | Selective Loading (grep, `times_loaded`, `mark-learning-useful.sh`, stale rule) | `knowledge.md` | |
| 47 | Capturing Skills (OpenSpace): `capture-skill.sh`, when / when not | `knowledge.md` "Captured skills and quality counters" | condensed from 17 to 3 lines; script ships, no captured skills found under the workspace or hub spoke vaults on this machine |
| 48 | Fixing Skills (OpenSpace): `fix-skill.sh`, when to use | same section | condensed; the "when" bullets are the one-line condition |
| 49 | Quality Tracking counters and pruning thresholds | same section | thresholds kept; field list (`times_loaded` etc.) dropped, already in `templates/learnings.claude.md` and `mark-learning-useful.sh` |

## Skill references (safeguard 3)

`prompt-master` (core row 2), `karpathy-principles` (row 5), `rules-ops` (rows 5, 8), `human-review-guide` (row 5), `daily-log` (row 7), `wiki-ops` (rows 7, 8), `add-pick-crew-rule` (row 1), `set-effort` (row 1), `rollover` + `roll` (row 7), `restart` + `rs` (row 7). `captain-startup` tests (`captain-startup-skill.test.ts`) fail when a skill named in any reference file is missing from the table.

## Surviving a compact

Skill text is gone after a compact; the template survives. Two layers: (1) `SessionStart(source=compact)` for a captain re-injects the core `SKILL.md` (trigger table + the three core-only rules) through its OWN hook command `squadrant hooks claude captain-core` (own `additionalContext` string, because Claude cuts one string at ~10k chars and a first attempt that prepended the core to the session-start string lost it behind a 20 KB handoff); `compactCoreContext` in `packages/cli/src/lib/compact-handoff.ts`, `captainCoreHookOutput` in `hooks.ts`, entry added by `installClaudeHooks`. The file is read at runtime, no copy in code. (2) One sentence in both captain templates: after a compact, if the trigger table is not in context, load captain-ops before the next action. Reference files are not re-injected (read on demand via the table). Only the Claude hook exists; other agents rely on (2).

## Changes outside captain-ops

- `templates/captain.claude.md` / `captain.generic.md`: startup step 4 prints the handoff once, step 5 loads captain-startup then the core; pointers to `briefs.md`, `knowledge.md`, `question-triage.md`. No hard rule changed.
- `rollover`, `restart`, `human-review-guide` skills: "Session Shutdown" / "review gate" now name `shutdown.md` / `review-gate.md`.
- Init prompt (`launch.ts`, `spawn-workspace.sh`) names `captain-startup`.
- Non-Claude reach: text projections (AGENTS.md etc.) append sibling reference files as "Reference: <file>" sections; opencode skill sync copies them beside SKILL.md; Claude loads the plugin tree as-is.
