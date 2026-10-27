# Captain discussion threads + 3-level triage (#1016)

Status: implemented (v1). Builds on #1015 (crew ledger, context meter) and #1017 (crew event tiers). Diagram: [`../diagrams/2026-10-21-captain-threads.html`](../diagrams/2026-10-21-captain-threads.html). Usage: [`reference.md` → Captain discussion threads](../reference.md#captain-discussion-threads-1016).

## Problem

The captain did two jobs in one conversation: coordinating crews (little reasoning, must see every crew) and thinking with the operator (deep reasoning on one topic). Crew events interrupted discussions, and a discussion was always half-finished, so the captain never reached a safe rollover point and its context kept growing.

## Design

**A thread is a fork of the captain for one topic.** `squadrant thread open` forks the captain's Claude session into a new cmux tab. The thread holds the captain's full knowledge and model, and shares its prompt-cache prefix. Crew lifecycle events never go to a thread: threads are not crews, and the daemon delivers only to the captain.

**Park returns a decision, not a discussion.** When the operator and the thread settle the question, the thread writes a decision record (question, decision, reasons, rejected options, per-crew actions) through `squadrant thread park … --decision-file -`. The CLI then:

1. stores it in the registry (`<stateRoot>/<project>/threads/<id>.json`),
2. appends exactly ONE `captain.message` (the short form) to the captain mailbox,
3. appends one line `[thread <id>] <topic>: <decision>` to `handoff.json` `session.decisions`,
4. closes the tab last. The thread usually runs this command itself, so closing its tab ends it. The session id is kept.

**Reopen.**

- Within 1h of the last activity (Claude's prompt-cache TTL): resume the same session, plus a delta made of the crew ledger now and decisions from other threads since this one parked.
- Later: fork fresh from the current captain, plus this topic's earlier decision records. Once the cache is cold the cost is the same, and the fork is never stale.

**State machine.** `open → parked | closed`, `parked → open | closed`, and `closed` is terminal. Invalid moves throw. The cap `defaults.maxThreads` (default 3) counts only open threads. Parked threads run no process.

## Decisions (operator, 2026-10-21, on the issue)

1. Storage: the daemon state root next to crew task records. The handoff carries only a one-line summary with the thread id.
2. The operator can override the triage level at any time. The captain follows and records it.
3. Dedup: the registry (topic, crews, state, last decision) is listed by `thread list`. The captain picks the matching thread or opens a new one.
4. Model: a thread uses the captain's model, and the fork keeps the cache prefix.

## Prompt-cache constraints

The fork reuses the cache only if the system prompt, tools and model are identical to the captain's. So:

- the thread command is the captain's own `buildAgentCmd(… "captain" …)` output (same `--append-system-prompt-file`, `--plugin-dir`, `--model`, `--effort`, permission mode), plus `--resume <captain> --fork-session --session-id <uuid>`. The captain-only `--messaging-socket-path` is dropped, and the captain's `-n` name is replaced with `-n squadrant-thread-<project>-<id>` (Claude accepts `-n` with `--fork-session`; without it the fork shows the captain's name in its status line);
- the thread instructions are sent as the **first user turn**, never as a system prompt.

`--session-id` with `--fork-session` assigns the thread's session id up front, so resume needs no transcript discovery.

The captain prompt file is passed as a byte-identical copy, `<stateRoot>/<project>/threads/thread.claude.md`. cmux liveness classifies a session's role from that basename (`store-fingerprint.ts`), so `captain.claude.md` would register the thread as a second captain of the project. The cache keys on content, not path. A control test on a 60k-token session confirmed it: a fork with the original path read 38,818 tokens and wrote 21,743, the same numbers as with the copy, and the next fork with the copy read all 60,561 and wrote 0.

### Step 0 measurement (2026-10-21, claude 2.1.306, throwaway session, ~400 KB of docs as the first prompt)

| Call | cache read | cache write | `duration_ms` | wall |
|---|---|---|---|---|
| base session, first call | 11,529 | 176,181 | 2,699 | 6.5 s |
| `--resume <base> --fork-session` | **171,960** | 15,790 | 2,140 | 6.0 s |
| plain `--resume <base>` (reference) | 171,960 | 18,651 | 2,102 | 6.0 s |
| `--resume <base> --fork-session --session-id <uuid>` | **187,726** | 7,355 | — | — |

The fork's first call hits the cache just as a plain resume does, so a fork costs about the same as continuing the captain. The ~6 s wall time is CLI boot plus one call.

## Triage (captain templates + `squadrant:captain-ops`)

| Level | When | Captain action |
|---|---|---|
| 1 · operator ↔ crew | a permission or approval for a step inside one crew's own task (revised 2026-10-27, see below) | one line telling the operator to answer in the crew's tab; no model upgrade (a mid-session model switch drops the crew's cache) |
| 2 · captain answers | answer exists in a decision, brief, rule or handoff | answer the crew and cite the source |
| 3 · thread | a choice of direction, touches develop/main/shared code or another crew, or changes a settled decision (revised 2026-10-27) | open or resume a thread on its own; give the operator the tab |

Level 1 leaves a trace: crews list `Decided with operator: <question> → <answer>` in their done message.

## 2026-10-27 trigger revision

Captain transcripts from 2026-10-21 to 2026-10-27 show no captain in any project opened a real thread; only smoke tests exist. Findings:

1. The only trigger was a crew question, and most crew questions ask permission for a step inside one crew ("OK to push?", "run /pr-full-review and post?"), so they are correctly level 1.
2. Levels 1 and 3 overlapped: level 3 said "needs a new operator decision", but every level-1 answer is also an operator decision. On 2026-10-23 crew sync-818 asked about svc-crm prettier reformatting on develop; it affects develop, not one crew, yet was treated as level 1.
3. Real discussions (KB design, release choices) start with the operator in the captain pane, and no rule moved them into a thread, so the captain's context kept growing.
4. Nothing nudged the captain; the rules were prose only.

Rules added (templates + `captain-ops`):

- **A. Second trigger.** A design or decision discussion that runs 3 or more turns on one topic, or an operator answer that turns into a discussion, makes the captain offer "Move this to thread `<topic>`?". It opens the thread only after a yes and holds no more discussion in its own pane. A fork carries the full captain context, so a late move loses nothing. Agents without fork seed the thread from the ledger and decision records.
- **B. Sharper boundary.** Level 1 is a permission or approval for a step inside one crew's own task (push, post, run a command, pick an option on a prompt the crew rendered). Level 3 is any question that needs a choice of direction, touches develop/main/shared code or another crew, or changes a settled decision. sync-818 is the level-3 example.
- **C. Operator answers in the captain pane.** Valid; the operator never re-answers elsewhere. A clear answer is forwarded verbatim with `crew send`, prefixed "Operator answered (in captain pane): …" (`crew answer` with the named option for an open rendered prompt; a level-3 decision also appends one line to handoff `decisions`). It is a go-ahead for that one prompt only. An answer that turns into a discussion gets rule A. An ambiguous or partly matching answer gets one short question before forwarding; the captain never guesses.

## Multi-agent

The fork is Claude-only. For codex, opencode or gemini captains, and for a Claude captain with no registered session, `thread open` starts a fresh interactive session seeded with the thread prompt, the live crew ledger and the topic's decision records. It prints a note, not an error. Resume always re-seeds. A seeded thread knows only what is written down. opencode runs through its interactive driver command. The codex and gemini drivers build only headless one-shot commands, so their threads run the plain interactive CLI (`codex`, `gemini`), and the operator answers that agent's own approval prompts in the tab.

## Environment and isolation

Threads run with `SQUADRANT_ROLE=thread SQUADRANT_THREAD_ID=<id>`:

- with the `thread.claude.md` prompt copy, cmux liveness does not classify them as captains;
- the SessionStart hook does not register them in `captain-sessions.jsonl`, so the context meter and the next fork keep pointing at the real captain;
- `isGateSession` treats them like the captain for the U7 permission gate;
- they are not crews, so no crew event, ledger entry or watchdog applies.

## Deferred

- **Routed captains** (`backend: direct|proxy`): the thread command does not reapply the router `--settings` file, so a routed captain's thread runs native. Follow-up if routed captains use threads.
- **Captain launched with `--model` override:** the thread uses the configured captain model. If the override differs, the fork misses the cache.
- **Telegram mirror** of a thread to a forum topic: not in v1.
- **Stale captain registry (#1023, captain context meter robustness):** inside the captain, `CLAUDE_CODE_SESSION_ID` is used as ground truth. From another shell, the newest registry record is used.
