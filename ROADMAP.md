# Squadrant — Roadmap

> Last updated: 2026-04-06
> Status: Active development. Priorities shift based on project deadlines.

## Current State

Squadrant v0.1.x is a working multi-project agent orchestration system with:
- 3-tier hierarchy (Command → Captain → Crew) via cmux + Agent Teams
- Obsidian hub/spoke vaults for offline status dashboards
- Session freshness logic (daily + template hash)
- Self-enhancement via learnings system
- CLI: init, launch, status, doctor, projects, shutdown, feedback

## ✅ Shipped

Landed since the entries below were written (as of v0.8.2):

- **Global effort dial** — `squadrant effort max|balance|low` tokenomics dial (#317 / #381).
- **Monorepo reorg** — six internal packages (`shared`/`core`/`agents`/`workspaces`/`web`/`cli`) in a one-way DAG, single bundled bin.
- **Daemon-direct delivery** — crew/handoff delivery moved onto the daemon→cmux path; `notify-relay` deleted (#332).
- **Semantic crew heartbeat** — CREW IDLE / QUIET / STALLED lifecycle signal (#354).
- **`stopped` project status + orphan-crew reap** — daemon reaps orphaned crews and marks intentional shutdown as `stopped` (#324 / #323 / #388).
- **Control-plane store hygiene** — task-store GC / purge to keep the daemon store bounded.

## Roadmap

### P0 — Critical (Next 2 weeks) — ✅ ALL DONE

#### 1. Task Master MCP Integration ✅
**Why:** Rick gives PRDs, Alan needs structured task decomposition. No tool in squadrant breaks down PRDs into dependency-aware tasks today.
**What:**
- Register task-master-ai as MCP server in squadrant config
- Captain uses Task Master tools (`parse_prd`, `get_tasks`, `next_task`, `expand_task`) to decompose PRDs
- Task Master's `tasks.json` lives in project root, captain queries it for crew assignments
- Add to captain-ops skill: "After receiving a PRD or large scope, use Task Master to decompose before spawning crew"
**Depends on:** task-master-ai npm package (installed globally)
**Status:** Installed globally, registered as MCP server, integrated into captain-ops skill. Works via Max subscription — no separate API key needed.

#### 2. `squadrant standup` Command ✅
**Why:** Rick expects daily async standups. Currently captain writes daily-log manually and there's no formatted output for sharing.
**What:**
- New CLI command: `squadrant standup [--project <name>] [--all] [--yesterday]`
- Pure bash/TS — zero LLM tokens (inspired by CCPM's pattern)
- Reads: spoke vault status.md, daily-logs/, git log --since=yesterday per project
- Output: formatted markdown block (what done, what next, blockers, time allocation)
- Optional: `--slack` flag to post to a webhook
**Effort:** ~2-4 hours
**Status:** Implemented in `src/commands/standup.ts`.

#### 3. Session Handoff Files ✅
**Why:** New day = forced fresh session = lost context. claude-mem helps but is unstructured. GSD solves this with HANDOFF.json.
**What:**
- Captain writes `handoff.json` to spoke vault at session end (manual trigger or auto on shutdown)
- Schema: `{ currentState, openBranches, nextSteps, blockedItems, activeTaskMasterTag, decisions }`
- captain-ops startup reads handoff.json if it exists, loads context, then deletes it
- Command writes hub-level handoff aggregating all projects
**Effort:** ~2-3 hours
**Status:** `scripts/write-handoff.sh` + `scripts/read-handoff.sh`. Captain-ops reads on startup, writes on shutdown.

### P1 — High Priority (April)

#### 4. Model Routing Config
**Why:** oh-my-claudecode claims 30-50% token savings by routing exploration→Haiku, planning→Opus, execution→Sonnet. Squadrant currently runs everything on whatever model the session uses.
**What:**
- Add to config.json: `"models": { "exploration": "haiku", "planning": "opus", "execution": "sonnet", "review": "opus" }`
- Captain passes `model` param when spawning crew via Agent tool
- Command uses Opus (always)
**Effort:** ~1-2 hours (config + template changes)

#### 5. CI Feedback Reactor Extension — **OBSOLETE** (reactor engine removed; would need a new auto-delegation mechanism)
**Why:** Composio AO auto-routes CI failures back to agents. Squadrant reactor detects CI failure but only notifies — doesn't auto-fix.
**What:**
- New reaction action: `auto-fix-ci` — on CI failure, re-delegate to captain with failure logs
- Captain spawns crew specifically for the fix (reads CI output, patches, pushes)
- Max retry count (default 2) before escalating to command
- Extend existing reactor architecture, not a new system
**Effort:** ~3-4 hours

#### 6. GSD Integration for Crew
**Why:** Crew members hit context rot on long tasks. GSD's artifact-driven execution (fresh 200K context per executor, plans carry forward) is the best solution.
**What:**
- Install GSD as a skill available to crew sessions
- Crew uses `/gsd:do` for multi-step implementation tasks
- Captain passes task specs as GSD-compatible artifacts
- Crew's subagents get fresh contexts per wave (GSD handles this)
**Depends on:** GSD skill installation

### P2 — Medium Priority (May)

#### 7. LLM Wiki / Knowledge Compilation System
**Why:** Based on Karpathy's viral LLM wiki pattern (Apr 2026). Squadrant's spoke vaults are proto-wikis — captains learn things but don't compile them into cross-referenced, indexed knowledge. See `llm-wiki-research-report.pdf` in repo root for full analysis.
**What:**
- **Ingest**: When captain/crew discovers something notable, it creates/updates wiki pages in spoke vault `wiki/` directory
- **Index**: `wiki/index.md` — content-oriented catalog of all wiki pages, updated on each ingest
- **Log**: `wiki/log.md` — append-only chronological record of wiki changes
- **Lint**: Periodic health check (orphaned pages, contradictions, stale claims, missing concept pages)
- **Cross-project compilation**: Command aggregates spoke wikis into hub-level wiki for cross-project knowledge
- **Query**: Any role can search the wiki for relevant context before starting work
- Hub vault becomes the "compiled knowledge base", spoke vaults are "working wikis"
- Inspired by: toolboxmd/karpathy-wiki (auto-invocation hooks), rvk7895/llm-knowledge-bases (Obsidian frontend)
**Architecture mapping (from report):**
  - `raw/` layer → existing project source code + docs
  - `wiki/` layer → new directory in spoke vaults (LLM-maintained)
  - Schema layer → existing CLAUDE.md + squadrant templates
  - Obsidian = IDE, LLM = programmer, wiki = codebase
**Effort:** ~1-2 weeks (phased: basic ingest first, lint later)

#### 8. `squadrant retro` Command
**Why:** Rick wants end-of-week/sprint summaries. Currently requires manually reading 5-7 daily logs.
**What:**
- New CLI command: `squadrant retro [--week] [--sprint] [--project <name>] [--all]`
- Aggregates daily logs for the period
- Groups by: completed, in-progress, blocked, key decisions
- Computes: tasks completed, PRs merged, crew sessions spawned
- Output: formatted markdown for sharing
**Effort:** ~2-3 hours

#### 9. Linear Integration — **OBSOLETE as specified** (depended on the now-removed reactor engine)
**Why:** Composio AO supports Linear+GitHub+GitLab. Squadrant only has GitHub reactor. Some projects may use Linear for tracking.
**What:**
- New reactor source: `linear-issues` (poll via Linear MCP tools already available)
- Trigger rules for Linear issue state changes, label changes, assignments
- Action: delegate to captain, same as GitHub flow
- Bidirectional: captain updates Linear issue status on task completion
**Effort:** ~1 week

### P3 — Nice to Have (Future)

#### 10. Web Dashboard
**Why:** Obsidian requires desktop app. A lightweight web view would allow checking status from phone/browser.
**What:**
- Simple static page served locally (localhost:3737)
- Reads same spoke vault status.md files
- Auto-refresh, similar to Composio AO's dashboard
- No auth needed (local only)

#### 11. Plugin/Extension System
**Why:** Composio AO has 7 plugin slots with 21 plugins. Squadrant's architecture is currently fixed.
**What:**
- Define plugin interfaces: runtime, agent, workspace, tracker, notifier
- Allow community to add new trackers (Jira, Asana), notifiers (Slack, Discord), runtimes
- Follow Composio AO's `PluginModule<T>` pattern

#### 12. Remote VM Support
**Why:** Originally planned. Rick's Rex system runs on GCP VMs.
**What:**
- `host: "remote"` in project config
- SSH tunnel to remote machine
- cmux workspace maps to remote tmux session

#### 13. Cost Dashboard
**Why:** Token costs across multiple projects add up. No visibility today.
**What:**
- Track token usage per role per project per day
- Display in squadrant status or web dashboard
- Alert when daily spend exceeds threshold

## Competitor Reference

| Tool | Stars | Watch for |
|------|-------|-----------|
| Composio Agent Orchestrator | 6K | Linear/GitLab tracker plugins, CI feedback loop patterns |
| GSD (Get Shit Done) | 48K | Context engineering methodology, wave-based execution |
| gstack (Garry Tan) | 65K | Role-based commands, browser integration |
| oh-my-claudecode | 25K | Model routing, 19-agent specialization |
| CCPM | 8K | Zero-token bash standups, GitHub Issues as source of truth |
| Claude Task Master | 26K | PRD decomposition, MCP tools, dependency graphs |
| 1code (YC W26) | 5K | Trigger agents from GitHub/Linear/Slack mentions |
