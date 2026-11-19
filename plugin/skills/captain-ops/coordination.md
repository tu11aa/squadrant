# captain-ops reference: Task coordination

_Read this before handling a crew status event (IDLE, BLOCKED, QUIET, STALLED) or checking crew status. Part of the `captain-ops` skill; the trigger table is in `SKILL.md`._


## Task Coordination

**HARD RULE: Do NOT poll crew screens in a loop.** Crew lifecycle events (idle / done / blocked) are delivered to your captain pane automatically by the squadrant daemon — trust the daemon signal. Polling loops hang indefinitely, exhaust context, and mask real blockers.

You don't have an Agent Team or `TaskCreate`/`TaskUpdate` tools — those were Claude-specific. When you need crew status:
1. **Wait for the daemon to notify you.** When a crew finishes, signals blocked, or goes idle, the daemon delivers the event to your captain pane via daemon-direct cmux delivery. This is the primary mechanism — do not replace it with polling.
2. `squadrant crew read <project> <name>` — **on-demand spot-check only** (a single read when you have a specific reason, e.g. reviewing a finished diff). Never in a loop, never with `until`.
3. `squadrant crew tasks <project>` — **on-demand** compact task listing; `--id <prefix>` to filter; `--state-only <id>` for a single-word state check.
4. `squadrant crew list <project>` — see all live crews and pick the right one.
5. Inspecting the crew tab visually in cmux when you want richer context (you have its surface ref from the spawn output).
6. Asking the user to check the dashboard if you need a cross-project view (see issue #44).

If you ever need a bounded check (not a loop), use a fixed counter (≤ 3 attempts with a sleep between), or watch the mailbox seq — never an unbounded `until` loop.

### Handling CREW IDLE / BLOCKED

Since #1017 a plain end-of-turn, the first stall, and CREW QUIET no longer reach your pane (they stay in `crew tasks`); a CREW IDLE you do see carries the crew's own message word for word — read it before spot-checking. A long reply (or BLOCKED question) is cut at 1500 chars and ends with `… full: squadrant crew msg <project> <seq>`; run that to read the whole text instead of asking the crew to rewrite it to a file. One `CREW STALLED … ESCALATION` (30 min, no tool result) is the "really hung" signal.

CREW IDLE is **ambiguous** — the watchdog did not detect a heartbeat, which can happen when:
- **(a)** The crew finished but never signalled done — via `squadrant crew signal done` or, where `squadrant mcp` is registered, the `crew_signal_done` MCP tool (a Claude crew calls it as `mcp__squadrant__crew_signal_done` directly; ToolSearch only if it answers "No such tool", then the CLI), which is the preferred path (#1029; the CLI stays as the fallback) (issue #278 — common for claude/opencode before the completion-protocol fix).
- **(b)** The crew is genuinely waiting for the captain (asked a question or needs a decision).
- **(c)** The crew is still mid-task and the idle pulse was transient.

On CREW IDLE, do a **single on-demand spot-check** (allowed — not a polling loop), then classify:

| Spot-check shows | Captain action |
|-----------------|----------------|
| Completed work (PR opened, commits pushed, results reported) but no CREW DONE | Treat as the #278 case — review, then follow the HUMAN REVIEW GATE contract: surface the diff and wait for operator go-ahead; never merge unprompted. If not actually done, **re-task**: send the next instruction via `crew send` (the #148 re-open flow). |
| Crew asked a question or is waiting for a decision (plain text, no rendered options) | Respond via `crew send`. Do NOT terminalize — it will signal done after the next turn. |
| Crew has an **open AskUserQuestion/permission prompt** (a rendered `❯ 1. …` option list) | `crew send` will correctly **refuse** to touch it — don't fight the refusal or fall back to `crew close` + re-spawn. Read the options with `squadrant crew read <project> <name>`, then answer deliberately with `squadrant crew answer <project> <name> <option>` (#592). Never guess with a bare Enter. |
| Still mid-task / transient idle | Leave it; wait for the next daemon event. |

**Do not re-send the original task** if the crew appears to have completed it — that triggers a duplicate run. Read the crew screen or diff first, then decide: terminalize vs re-task vs leave.

This is the captain-side backstop: even if the completion-protocol imperative is skipped, the lifecycle still terminalizes because the captain classifies intent instead of letting the task strand at IDLE. The same BLOCKED-on-a-real-prompt case applies whether the daemon fires an explicit CREW BLOCKED event or you only notice via a spot-check on IDLE.

When a crew sends you a status message via `squadrant runtime send <project> "<message>"`, it lands in your captain pane. Acknowledge, then update your handoff if a meaningful decision was made.
