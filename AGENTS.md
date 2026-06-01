<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **claude-cockpit** (3604 symbols, 5970 relationships, 88 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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

# [claude-cockpit] recent context, 2026-06-01 5:56pm GMT+7

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (17,944t read) | 215,830t work | 92% savings

### Jun 1, 2026
11810 10:59a ✅ Added net module import for port allocation
11811 11:00a 🟣 Implemented getFreePort helper for dynamic ephemeral port allocation
11812 " 🟣 Wired dynamic port allocation into opencode crew spawn flow
11813 " ✅ Added opencodeBridge injectable option to CockpitdOpts for testing
11814 11:01a ✅ Imported OpencodeSseBridge into cockpitd module
11815 " 🟣 Wired OpencodeSseBridge into cockpitd launchInteractive for opencode crews
11816 " 🟣 Implemented SSE bridge crash recovery for daemon restart resilience
11817 " ✅ Added missing TERMINAL_STATES import to cockpitd
11818 11:02a 🔵 TypeScript error: task.turn.completed requires turnId field
11819 " 🔵 ControlEvent requires turnId for both turn.started and turn.completed events
11820 " 🔴 Fixed task.turn.completed to include required turnId field
11821 " ✅ Updated second test expectation to include turnId field
11822 " ✅ Verified TypeScript build and all tests pass with turnId fix
11823 11:03a 🔵 Found existing test for interactive opencode command without port
11824 " ✅ Added test coverage for interactive opencode with port option
11825 " ✅ Verified daemon boots cleanly with SSE bridge integration
11826 " 🔵 Confirmed daemon runs fresh SSE bridge code from this repository
11827 11:04a 🔵 Confirmed CLI also runs live from repository via npm link
11828 " ✅ Spawned live opencode crew to test SSE bridge integration
11829 11:05a 🟣 SSE bridge successfully detected opencode turn completion automatically
11830 11:06a 🟣 SSE bridge works across multiple turns with persistent subscription
11831 11:07a 🟣 Validated anti-#2576 invariant: terminal state absorbs trailing SSE events
11832 " 🔴 Added blocked-state guard to task.turn.completed reducer
11833 11:08a 🔵 Found existing blocked state test pattern to mirror for turn.completed
11834 " ✅ Added test validating blocked state preservation for task.turn.completed
11835 " ✅ Restarted daemon with blocked-state fix and spawned fresh test crew
11836 11:10a 🟣 Validated blocked-state guard in production with live SSE bridge events
11837 " 🟣 Captain answer cleared blocked state and crew resumed normal turn cycle
11838 " ✅ Full test suite passes with opencode SSE bridge implementation
11839 11:11a ✅ Documented opencode SSE bridge success in crew lifecycle checklist
S3589 Complete implementation work and verify all tests pass (Jun 1 at 11:24 AM)
S3590 Validate test suite status on feat/opencode-idle-sse-bridge branch (Jun 1 at 11:25 AM)
S3591 Verify completion of opencode-idle-sse-bridge feature implementation (Jun 1 at 11:27 AM)
S3593 Push and open PR for OpenCode idle/turn-end detection feature (CP4) (Jun 1 at 11:28 AM)
11840 11:51a ✅ Pushed OpenCode idle SSE bridge feature branch
11841 " 🟣 Implemented OpenCode SSE bridge for turn-end detection
S3596 Merge PR #188 (opencode idle SSE bridge) to develop (Jun 1 at 11:51 AM)
11843 12:47p 🟣 Merged SSE bridge for OpenCode control
S3597 Merge and verify OpenCode SSE bridge implementation (PR #188) (Jun 1 at 12:48 PM)
11847 12:48p ✅ Reindexed claude-cockpit repository with SSE bridge changes
S3600 Document Codex architecture and explain why interactive TUI cannot replace app-server approach (Jun 1 at 12:49 PM)
11857 2:50p 🔵 Codex CLI Architecture and Operational Modes
11858 " ⚖️ Interactive Codex Integration via app-server Protocol Instead of TUI Scraping
11860 2:53p ✅ Vietnamese Architecture Documentation for Codex Integration
S3605 Create architecture reports for Claude, Codex, and Opencode with strengths/weaknesses analysis explaining integration complexity differences (Jun 1 at 2:53 PM)
11870 3:01p ✅ Added Claude and Codex architecture documentation with strengths/weaknesses analysis
11873 3:02p 🟣 Opencode architecture documentation explaining why it's the easiest integration
S3638 Architecture clarification: crew communication flow uses hooks vs explicit signals (Jun 1 at 3:02 PM)
12109 5:47p 🔵 Architecture Divergence: Crews Bypassing Hook-Daemon Flow
12110 5:48p 🔵 Claude Crews Use Dual Communication: Hooks for Liveness, Explicit Signals for State
12116 5:52p 🔵 Push-Based Notification Ranked Over Polling for Captain Communication
12117 " 🔵 Captain Template Has No Polling Guidance - Relies on Push Notifications
S3639 Verify polling is fallback-only in captain-crew communication architecture design (Jun 1 at 5:53 PM)
12119 5:54p 🔵 Codex startThread Method Has Two Direct Upstream Callers
12121 5:55p 🔵 Codex Driver Injects Explicit Signal Command into Developer Instructions
12122 " 🟣 Adding config Parameter to Codex startThread Method
12123 " 🟣 Implemented Surgical Sandbox Escape for Codex Daemon Socket Access
12124 5:56p 🟣 Codex Sandbox Configuration Fix Tests Pass
12125 " ✅ Deployed Codex Sandbox Fix to Running Daemon
12126 " ✅ Spawned Codex Test Crew to Verify Sandbox Fix

Access 216k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>