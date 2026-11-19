# captain-ops reference: Crew question triage and threads

_Read this before answering a crew question, opening or resuming a discussion thread, or relaying an operator answer. Part of the `captain-ops` skill; the trigger table is in `SKILL.md`._


### Crew Question Triage & Discussion Threads (#1016)

Every crew question (CREW BLOCKED, a question in a CREW IDLE, a `runtime send`) gets a level. **You decide the level yourself**; the operator can override it at any time ("push this to a thread" / "let the crew handle it"). Follow the override and record it (the handoff `decisions`, or the thread's record).

| Level | When | Your action |
|---|---|---|
| **1 · Operator ↔ crew** | A permission or approval for a step inside that crew's own task (push, post, run a command, pick an option on a prompt the crew rendered) | One line to the operator: "crew A asks X — local, answer it in crew A's tab". **No model upgrade**: switching a crew's model mid-session drops its prompt cache. The crew lists what it settled with the operator in its done message (`Decided with operator: …`); read that line when it lands. |
| **2 · Captain answers** | The answer already exists in a decision, the brief, a rule or the handoff | `crew send` the answer and **cite the source** ("per handoff decision …", "rule `x.y`", "brief §Scope"). |
| **3 · Thread** | Needs a choice of direction, touches develop/main/shared code or another crew, or changes a settled decision | Open or resume a thread (below) on your own, then give the operator the tab name. Do not hold the discussion in your own pane. |

Level 3 example: a crew asking whether to reformat a file that is shared on develop. It changes shared code, so it is level 3, not level 1.

Escalation is allowed: when a level-1 conversation turns out to span crews, the operator or the crew pushes it up to a thread.

**Second thread trigger — operator discussions.** Real discussions (design, release choices) usually start in your pane, not from a crew question. When the operator starts a design or decision discussion that runs 3 or more turns on one topic, or an operator answer turns into a discussion, offer: "Move this to thread `<topic>`?" Open the thread only after the operator says yes, and hold no further discussion in your own pane. Because a thread forks your session, a late move loses nothing.

**Operator answers a crew question in your pane.** Valid; never make the operator re-answer elsewhere.
- **Clear answer** → forward it verbatim with `squadrant crew send`, prefixed "Operator answered (in captain pane): …". If the crew has an open rendered prompt, use `squadrant crew answer` with the option the operator named. If it was a level-3 decision, also append one line to the handoff `decisions`. The operator's direct answer is a go-ahead for that one prompt only.
- **It turns into a discussion** (operator asks back, is unsure, a second turn on it) → apply the second trigger and offer a thread.
- **Ambiguous, or only partly matches the question** → ask the operator one short question before forwarding. Never guess.

**Threads.** A thread is a fork of your own session for one topic (claude: `--resume <captain> --fork-session`; it shares your prompt-cache prefix, so it starts warm and on your model). Crew events never go to a thread — they keep coming to you.

```bash
squadrant thread list <project>                       # registry: id, state, topic, related crews, last decision
squadrant thread open <project> "<topic>" --crew crew-a --crew crew-b   # new tab "💬 <project>:<id>"
squadrant thread resume <project> <id>                # matching topic exists and is parked
squadrant thread park <project> <id>                  # ask the thread to write its record and park
squadrant thread close <project> <id>                 # topic finished (PR merged, ticket closed)
squadrant thread show <project> <id>                  # full decision records
```

- **Dedup first:** `thread list` and pick the matching topic before opening a new one. Resume within ~1h of its last activity reuses the same session plus a delta (crew state now + decisions made since it parked); later it forks fresh from you with the topic's earlier decision records.
- **Cap:** `defaults.maxThreads` open threads (default 3). Parked threads cost nothing and run no process.
- **Park → you get ONE message** starting `💬 Thread decision — <topic>`: question, decision, why, rejected options, per-crew actions. It is also appended as one line to the handoff's `decisions` (`[thread <id>] …`). Act on the per-crew actions (`crew send`), then move on — you receive the decision, never the discussion.
- **Agents without fork** (codex, opencode): the thread is a fresh session seeded from the crew ledger and the topic's decision records; `thread open` prints a note saying so. It knows only what is written down.
