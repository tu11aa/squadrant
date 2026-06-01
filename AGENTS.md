<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **claude-cockpit** (3602 symbols, 5968 relationships, 88 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/claude-cockpit/context` | Codebase overview, check index freshness |
| `gitnexus://repo/claude-cockpit/clusters` | All functional areas |
| `gitnexus://repo/claude-cockpit/processes` | All execution flows |
| `gitnexus://repo/claude-cockpit/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Project Direction: Multi-Agent

Cockpit is a **multi-agent orchestration layer**, not a Claude-Code-only tool. Claude Code is the reference implementation today; Codex, Cursor, and Gemini CLI are supported (or in progress) through the runtime driver abstraction and the upcoming cross-agent projection layer (issue #31).

When working on cockpit:
- Prefer **`AGENTS.md`** as the canonical instruction format. `CLAUDE.md` is becoming a thin wrapper.
- When adding agent-facing features, ask: *"does this work for non-Claude agents too?"* If not, file a follow-up issue to generalize it.
- Don't add Claude-only surface area without a migration path. The three plugin slots (runtime / workspace / notifier) exist specifically to avoid this.
- Skills in `plugin/skills/` are portable markdown — Claude Code reads them via the Skill tool; other agents read them via `AGENTS.md` inclusion.

Full direction statement: [`docs/specs/2026-04-24-multi-agent-direction.md`](docs/specs/2026-04-24-multi-agent-direction.md).

## Coding Discipline: Karpathy Principles

Every coding task in this repo follows [`plugin/skills/karpathy-principles/SKILL.md`](plugin/skills/karpathy-principles/SKILL.md):

1. **Think before coding** — surface assumptions and tradeoffs; ask if ambiguous
2. **Simplicity first** — no speculative abstractions, no impossible-case error handling
3. **Surgical changes** — every changed line traces to the request; no drive-by refactors
4. **Goal-driven execution** — define verifiable success criteria before implementing
# Memory Context

# [claude-cockpit] recent context, 2026-06-01 10:23pm GMT+7

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (17,035t read) | 164,281t work | 90% savings

### Jun 1, 2026
12129 5:57p 🔵 Codex Signal Command Failed to Reach Daemon Despite Sandbox Fix
12131 " 🔵 Codex Sandbox Blocks Both Socket Connect and LaunchAgent Access
12133 5:58p 🔵 Codex Sandbox Has Dedicated --allow-unix-socket Flag for Socket Connectivity
12134 5:59p 🔵 Confirmed: --allow-unix-socket Flag Enables Daemon Socket Connectivity
12135 6:00p 🔵 Codex Config Keys for Unix Socket Permissions Identified
12136 6:01p 🔵 Codex Unix Socket Config Uses allow_unix_sockets Key (Plural)
12137 " 🔵 Config Key Approach Fails - Unix Socket Permissions Not Configurable via -c Flag
12138 6:02p 🔵 Unix Socket Permissions Not Part of SandboxWorkspaceWrite Config
12139 6:03p 🔵 Codex app-server Supports -c Config Override and Can Be Passed at Spawn
12140 6:04p 🔵 Config Override -c Flag Cannot Grant Unix Socket Permissions
12141 6:05p 🔵 Codex Is Only Crew Provider Running Under Seatbelt Sandbox
S3645 Completed implementation on fix/codex-sandbox-writable-roots branch (Jun 1 at 6:15 PM)
S3646 Fix codex sandbox blocking daemon socket connectivity by enabling network access (Jun 1 at 6:15 PM)
12143 6:18p 🔴 Codex crews switched to danger-full-access sandbox to fix lifecycle signals
12144 " 🔵 Codex AF_UNIX socket access requires experimental config unavailable via stable API
12145 " ✅ Crew lifecycle checklist updated with codex full-access results
S3647 Update PR #189 with danger-full-access implementation and revise PR metadata (Jun 1 at 6:18 PM)
12146 6:19p ✅ Updated PR #189 with danger-full-access implementation
12147 6:20p ✅ Updated PR #189 description to reflect danger-full-access solution
S3649 Verify codex sandbox writable_roots fix and prepare for merge (Jun 1 at 6:20 PM)
12148 6:35p 🔵 Cockpit crew signal daemon communication verified
12149 6:36p 🔵 Cockpit daemon fails to start due to LaunchAgents permission errors
S3654 Review completed opencode permission gate implementation and decide next steps (Jun 1 at 6:38 PM)
12196 7:01p 🟣 Semi-automatic permission gate for bash tool calls
12197 7:03p 🔵 Test failure detected in test suite
S3655 Investigate process leaks and memory overflow in claude-cockpit test suite after system restart (Jun 1 at 7:09 PM)
12200 7:41p 🔵 Orphaned workspaces causing system crashes and daemon loss
12201 7:42p 🔵 Process leak investigation identified test files spawning real processes
12202 7:43p 🔵 app-server-client.test.ts uses dependency injection with fake processes
12203 " 🔵 Process orphan analysis reveals opencode potential leaks and proper socket test cleanup
12204 7:44p ✅ Killed stray vitest workers and confirmed no test process orphans
S3659 Distinguish cockpit vs oneplan vitest processes and prevent RAM overflow from concurrent test runs (Jun 1 at 7:45 PM)
12220 8:00p 🔵 Vitest worker configuration uncapped in cockpit project
12221 8:01p 🔵 CP3 opencode permission gate work preserved on feature branch
12222 " 🔴 Capped vitest worker pool to prevent RAM exhaustion
12223 8:02p 🔴 Shipped vitest worker cap fix via PR #192
S3660 Investigate excessive node processes (25 gitnexus, ~1.3GB RAM) suspected from oneplan/cockpit (Jun 1 at 8:02 PM)
12224 10:00p 🔵 Node process investigation reveals gitnexus as primary resource consumer
12225 " 🔵 All 25 gitnexus processes are MCP server instances from common parent
12227 10:01p 🔴 Fixed gitnexus MCP server resource leak from codex app-server
12228 " 🔵 Gitnexus configured as MCP server in codex with cockpit protocol support
12229 10:02p 🔵 Codex driver lacks thread cleanup on task completion
S3662 Simple acknowledgment and wait instruction - no active work requested (Jun 1 at 10:03 PM)
12230 10:10p 🔵 Process Snapshot Tool Created for Crew Cleanup Verification
12231 10:11p 🔵 Claude Crew Cleanup Verification: Complete Process Cleanup Confirmed
12232 " 🔴 Codex Crew Cleanup Leak: Orphaned MCP and Node Process
12233 10:12p 🔵 Opencode Crew Cleanup Verification: Complete Process Cleanup Confirmed
12234 10:13p 🔵 Codex Crew Leak Investigation: Orphaned MCP Not Parented to App-Server
12235 " 🔵 Codex Crew Leak Root Cause: Orphaned Gitnexus MCP Parented to OpenAI Codex Module
12236 " 🔵 Codex Crew Leak Confirmation: Manual Cleanup Restores Baseline
S3663 Verify crew cleanup: all crew types (claude, codex, opencode) must terminate sockets, MCP servers, vitest, node, bun processes when closed (Jun 1 at 10:14 PM)
12238 10:20p ✅ Started Codex Cleanup Fix Implementation
12239 " 🟣 Added archiveThread Method to AppServerClient
12240 " 🟣 Added close Method to CodexInteractiveDriver for Thread Teardown
12244 10:21p ✅ Extended Codex Driver Interface to Include close Method
12245 " 🔴 Wired Cockpitd to Archive Codex Threads on Crew Close
12246 10:22p 🔄 Refactored Codex Cleanup to Use Dedicated codex-close Message Kind
12247 " 🔴 Completed Codex Crew Cleanup Fix: runCrewClose Now Sends codex-close to Daemon
12248 " ✅ Added Test Coverage for CodexInteractiveDriver.close Method
12249 10:23p ✅ Build and Test Verification: Codex Cleanup Fix Compiles and Passes Tests

Access 164k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>