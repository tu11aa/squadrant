# Status Observer: one status system for squadrant, the machine and every session

Status: design agreed with the operator 2026-11-10 (side session `machine-status`), revised after one spec
review pass. P0 built in #1112's first PR (timeout fix, probe class dedup, suspension detector); P1 and P2 not yet planned.

## Why

On one night the operator's laptop lid was closed for 14 hours. macOS put the machine to sleep and then
"dark woke" it 61 times (roughly every 15 minutes, up to 180 s each, network sometimes up). In every dark
wake the daemon, the crews and the captain got a few seconds of CPU:

- The crews (Claude Code) retried the API and printed `API Error: Can't reach the API server … (ENOTFOUND)`
  or `Your computer went to sleep mid-response`.
- The daemon's interactive probe saw a changed pane tail and pushed a `CREW WARN` again.
- One captain received 63 alerts (55 `task.warn`, 5 `task.turn.failed`, 3 `task.stalled`). It ran 62 turns
  and used about 16M input tokens while the lid was shut, only to read the same news.
- In another project the 8-hour wall-clock reaper cancelled a live crew mid-sleep. The `CREW TIMEOUT`
  notice was dropped by a bug, so nobody knew. Next morning the crew's `done` was refused with
  "task is already cancelled".

Five root causes:

1. The probe dedups on the whole pane tail, which always changes.
2. Its error regex matches Claude's own `Retrying …` progress line.
3. `task.warn` bypasses every dedup.
4. Every budget counts wall-clock time, sleep included.
5. Nothing models a shared cause, so each crew reports the same cause separately.

Squadrant has no notion of *why* something is failing. It has per-task watchdog fragments (captain liveness,
task records, lifecycle sources, the daemon-down alert, the stall watchdog, the timeout reaper, noise
filters) and a pull-only health snapshot. None of them detects machine sleep, network loss or a provider
outage. None of them knows that 2 crews failing at the same second share one cause.

The operator wants one status system that covers **squadrant itself, the machine and every session**.
It records the current status of each, refreshes it when the thing recovers, reports a shared cause once,
and stays quiet about its symptoms.

## Goals

1. **One cause, one report.** A machine-wide or squadrant-wide cause (sleep, network loss, daemon down,
   cmux down, provider outage) is reported to each captain that has affected crews, and to Telegram:
   once at open and once at recovery, or once combined for sleep (D10). Its symptoms are recorded but
   take no captain turn.
2. **Session status for every captain and crew**: written down, refreshed on every change, back to OK
   when the session recovers.
3. **Squadrant self-status.** The daemon, delivery, runtime (cmux), Telegram bridge, lifecycle sources and
   hooks are subjects of the same system, so a squadrant fault explains its symptoms the same way a
   machine fault does.
4. **No wrong state changes during an outage.** Timer-based actions use time the machine was awake and
   pause while a shared cause is open. A timer-based cancellation is always announced.
5. **Agent-neutral contract**, implemented for Claude first.

## Non-goals

- Keeping the machine awake (caffeinate, lid warnings). This may come later as a separate idea.
- Polling third-party provider status pages. It may come later as opt-in.
- Implementing the codex, opencode and gemini adapters now. The operator runs Claude only today. The
  contract is designed for them, and their known gaps are listed below.
- Replacing the task state machine. That is epic #1077 (decouple communication from task state). This
  design adds a reachability dimension next to it and never writes the work state.

## Anti-goals (failure even if it "works")

- **A real message is lost or delayed.** Every kind not on the absorbable list (see "Absorbable kinds"
  below) is **delivered immediately, as today**, whatever the status says. This is the #1077 principle:
  every communication is delivered.
- **Absorbing means deleting.** An absorbed alert is recorded in `status/incidents.jsonl` with the
  incident that explains it, and counted in the recovery summary.
- **Pane-text guessing comes back as a source of truth for Claude.**
- **A new class of silent state change.**

## Decisions taken with the operator

| # | Decision |
|---|---|
| D1 | `squadrant status` shows **one line per session** by default. The existing `--detailed` flag shows every layer and recent incidents. Machine and squadrant self-status lines sit on top. |
| D2 | Multi-agent: **one adapter per agent** translates its native status system into a common contract. Where an agent provides nothing for a layer, squadrant observes it generically (pid, pane, exit code). Claude only for now. |
| D3 | Claude errors come from **hooks first**: `StopFailure` with all three fields, and `Notification`. Pane scraping is a **fallback that only records evidence and never sends an alert by itself**. A `Retrying in Ns · attempt n/N` line is never an error. |
| D4 | Real messages are **delivered immediately as today**, even while the captain is offline. No holding. |
| D5 | A shared incident is reported to **each captain that has affected crews: once at open and once at recovery**. Telegram gets the same messages once. **Exception for sleep: D10.** |
| D6 | The task-timeout ceiling stays, but counts **awake time only** and pauses while a shared incident is open. **A crew still alive past the ceiling is not cancelled: D11.** |
| D7 | Tracked sessions are **captains and crews**. Side sessions appear only under `--detailed`. |
| D8 | The system covers **squadrant itself too**, not only the machine and the sessions. |
| D9 | Crew-only re-reports: see D13 (D13 supersedes the earlier "backoff, at most 3" wording). |
| D10 | **Sleep incident: one combined message, sent only once the machine is stably awake.** Nothing is sent during sleep or dark wakes. A network outage while the machine is awake still sends its open line at once. |
| D11 | **Ceiling reached and the crew is alive → `CREW OVERTIME`** to the captain, who decides. No automatic cancel. **Ceiling reached and the crew is provably gone → cancel + `CREW TIMEOUT`.** This reverses the #457 suppression (`reduce.ts:690-695`) for this path. |
| D12 | **No auto-resume.** After recovery, the message lists each crew whose turn died during the incident, marked "needs a nudge". The captain decides what to send. |
| D13 | **Crew-only re-reports are reminders.** While the error stands and the captain has sent nothing to that crew, remind at about 15, 30 and 60 min after the first report: 3 reminders at most per window, not counting the first report. Any `crew send` to that crew, or the crew recovering, stops the reminders and resets the counter. |

## Design

### Four layers

```
Observers → Facts        Conditions (per subject)         Incidents                  Notifier
tick gap (+ OS confirm)  machine.Awake                     key, parent, counters      open: 1 line per affected captain (+ Telegram)
OS hint (pmset)          network.Reachable                 symptoms: inhibited        symptom of an open parent: recorded, no turn
agent adapter events     provider:<p>.Healthy              crew-only: reminders ≤ 3   recovery: 1 summary line (+ Telegram)
squadrant self checks    squadrant:<component>.Healthy
                         session:<project>/<id>.Reachable
```

- **Fact**: one timestamped observation with its source. A fact never sends anything by itself.
- **Condition**: one per (subject, type), shaped like Kubernetes conditions: `status: True | False | Unknown`,
  `reason` (machine-readable), `message` (human), `lastTransitionTime` (only changes when status changes),
  plus `lastProbeAt`, `evidence[]` and, when an ancestor explains it, `inhibitedBy`. Session conditions are
  recorded **even when inhibited**, so the display can say "unreachable (machine)". Hysteresis lives here:
  open after K bad facts or one strong fact, close after M good facts over at least 60 s.
- **Incident**: opened when a condition goes bad. It has a dedup key (for example `machine:asleep`,
  `network:dns`, `provider:anthropic`, `squadrant:runtime`, `crew:<taskId>:<errorClass>`) and a **parent**
  taken from the subject tree. It holds `affected[]`, `inhibited` (count), `reports`, `lastReportAt` and
  `lastCaptainSendAt`. The last two are persisted, so reminders survive a restart.
- **Notifier**: the **single entry point** for every absorbable alert, including Telegram. Today Telegram's
  `pushLifecycle` runs after the captain gate, whatever the gate decided (`start.ts:67-73`). The notifier
  returns a reason: `delivered`, `inhibited:<incident>` (the operator's "already reported"), `reminder-wait`
  or `exhausted`.

### Subject tree (parents explain children)

```
machine
├─ network
│  └─ provider:<anthropic|openai|…>
│     └─ account:<provider>          (rate limit, usage limit, auth, billing)
├─ squadrant:daemon                  (process up, ticking, event loop not stalled)
│  ├─ squadrant:runtime              (cmux reachable; pane-based checks return "unknown" when down)
│  ├─ squadrant:delivery:<project>   (deferral / DELIVERY STUCK)
│  ├─ squadrant:telegram             (polling, last error)
│  ├─ squadrant:lifecycle:<source>   (LifecycleSource.health())
│  └─ squadrant:hooks:<agent>        (claude: managed ~/.claude/settings.json hook set; other agents: their
│                                     own install check when their adapter exists)
└─ session:<project>/captain, session:<project>/<taskId>
   (a session's errors are children of machine / network / provider / account / squadrant:runtime)
```

**Inhibition rule.** While any ancestor has an open incident, a symptom on a descendant is recorded with
`inhibitedBy`. It takes no captain turn and sends no Telegram push. This is Alertmanager inhibition and
Nagios "UNREACHABLE, notify the nearest failing parent only".

A crew error with **no** open ancestor is a crew-only incident. Only crew-only incidents get reminders
(D13). This mirrors Kubernetes' Pod failure policy `DisruptionTarget → Ignore`: infrastructure failures do
not count against the job's retry budget.

**When a parent closes,** every child session still in error (no healthy event since its symptom) is
re-evaluated. If it is still failing, it becomes a crew-only incident and is reported then. A real crew
fault that coincided with a network blip is therefore not lost.

### Absorbable kinds (the only things inhibition can touch)

| Absorbable | Never absorbed (delivered as today) |
|---|---|
| `task.warn` (probe), `task.turn.failed`, `task.stalled` (first and escalated), `task.quiet`, plain `task.idle`, DELIVERY STUCK, the daemon-down alert | `task.done`, `task.failed`, `task.cancelled`, `task.blocked`, `task.review`, `task.approval.requested`, `task.input.requested`, addressed/reply turn-ends (`isAddressedTurnEnd`, `captain-noise.ts:29-31`), every `captain.message` from a crew, the CLI or Telegram, `task.timeout`, `task.overtime`, incident open/recovery lines |

`task.turn.failed` is a hook event, not daemon-synthesized, but it is an observation of an error, not a
message from the crew. It is absorbable. A turn that dies still moves the crew to `awaiting-input` through
the state machine as today (`state-machine.ts:204-236`). D12 relies on this.

**Must-deliver kinds.** `task.timeout`, the new `task.overtime`, and incident open/recovery lines (a new
daemon `captain.message` subtype `status.incident`) are added to the stale-skip bypass set
`TERMINAL_KINDS` (`delivery-loop.ts:30`, used at `:501-511`). They are also allowed by the captain-pane
tier gate (`captainPaneAllows`, `captain-noise.ts:56-61`) at every tier except `none`. Today
`task.timeout` is only in `alert_only` (`telegram/tiers.ts:5-13`), so a `done_only` captain would never
see it.

### Detection

**Machine suspension.** On every daemon tick, compare `Date.now()` with the previous tick's wall time.
A gap larger than the interval plus `tickGapMs` is a **candidate**. Negative deltas (clock set backwards)
are ignored. The candidate is then **confirmed by the OS**:

- **macOS:** `sysctl kern.sleeptime kern.waketime`. The last sleep/wake pair includes dark wakes (checked
  on the operator's machine). If the pair falls inside the gap, it is a suspension. The wall clock cannot
  be compared with Node's monotonic clock here: libuv on darwin implements `uv_hrtime` with
  `mach_continuous_time` (libuv v1.x `src/unix/darwin.c`), which keeps counting during sleep, and Node
  timers become due while asleep and fire at the next (dark) wake.
- **Linux:** wall-clock delta minus `process.hrtime` delta (libuv uses `CLOCK_MONOTONIC`, which stops in
  suspend). Verify this on Linux before relying on it.
- An **unconfirmed** gap is an event-loop stall (sync work, debugger, SIGSTOP, App Nap). It becomes a
  `squadrant:daemon` fact (`reason: EventLoopStall`). It does **not** open `machine:asleep` and does not
  pause reapers.

The `pmset -g log` hint (Clamshell / Maintenance / Thermal) only labels the incident.

| Subject | Opens on | Closes on |
|---|---|---|
| `machine.Awake=False` | a confirmed suspension. One strong fact is enough. | **Stably awake.** Each tick runs gap detection **before** close evaluation, so the first tick of the next dark wake extends the incident rather than closing it. Close when there is no gap and `now − stableSince ≥ stableAwakeMs`, where `stableSince` is the end of the last gap. Default 5 min, which is longer than the 180 s dark-wake cap. There is never a close, reopen or message per dark wake. Required test: 180 s awake / 15 min asleep cycles produce exactly one incident and one message. |
| `network.Reachable=False` | errors classed `network`/`dns` from **at least 2 sessions** in a window, **or** 1 session plus a failed DNS + TCP:443 probe to the configured provider hosts (the probe runs only while suspicious) | M good probes in a row, or successful turns from the sessions that failed |
| `provider:<p>.Healthy=False` | `overloaded`/`server` from at least 2 sessions on that provider, or 1 session plus a passing network probe (the network is fine, so the API is the problem) | M successful turns on that provider |
| `account:<p>.Usable=False` | errorClass `rate_limit` / `usage_limit` / `auth` / `billing` | reset time reached or one successful turn |
| `squadrant:daemon` | boot after a gap (existing exit/running markers, `start.ts:313-349`), or an event-loop stall | first healthy tick |
| `squadrant:runtime` | cmux calls fail / `checkAlive` returns "unknown" for every crew | cmux answers again |
| `squadrant:delivery:<p>` | existing DELIVERY STUCK edge (`delivery-loop.ts:678-700`) | delivery advances |
| `squadrant:telegram`, `squadrant:lifecycle:<s>` | existing `health()` reports an error (`telegram/bridge.ts:906`, `lifecycle-source.ts:70-88`) | `health()` OK |
| `squadrant:hooks:claude` | hook repair on boot found missing hooks (`native-hook-source.ts`, #615) | repaired |
| `session:…Reachable=False` | an adapter error (recorded with `inhibitedBy` when an ancestor is open) | the next healthy adapter event (turn running / turn completed) |

**Boot after a gap.** The gap between the last running-marker heartbeat and boot is recorded as a
suspension when the OS confirms sleep in that window. Otherwise it is recorded as daemon downtime. In
both cases awake-time budgets do not count it. A restart after an overnight sleep therefore cannot fire
the ceiling at once. The existing down alert goes to every configured project today (`start.ts:316-323`).
From P1 it goes through the notifier (affected captains only).

**Post-wake grace.** Detection is always after the fact. For `postWakeGraceMs` after a suspension ends,
session errors are attributed to the machine incident.

### Session contract and adapters (D2)

Common contract per session, written to the status file:

| Layer | Meaning | Note |
|---|---|---|
| `alive` | process / pane exists | never implies anything about the network |
| `reachable` | the agent can talk to its model API | the dimension this design adds |
| `started` | first turn confirmed | existing `firstTurnConfirmedAt` |
| `work` | the task state (working / awaiting-input / blocked / review / done / …) | owned by the state machine (#1077); the status system reads it and never writes it |
| `errorClass` | `sleep \| network \| dns \| overloaded \| rate_limit \| usage_limit \| auth \| billing \| server \| invalid_request \| max_output \| retrying \| unknown` | `retrying` is never an alert |

`reachable` sits next to `work` like a statechart parallel region. The status system only writes
`reachable`. A turn that dies on an API error still changes `work` through the existing state machine.

**Claude adapter (now).**

| Layer | Source |
|---|---|
| alive | cmux store pid. `~/.claude/sessions/<pid>.json` is an undocumented internal Claude file: use it as a best-effort, version-dependent hint for `alive` and busy/idle only, never as an error source. |
| reachable / errorClass | `StopFailure` hook: `error` (enum), **`error_details`**, **`last_assistant_message`**. Today only `error` is read (`packages/agents/src/interactive/claude.ts:630-640`, redaction at `:511-530`), so a DNS failure reaches the captain as plain `server_error`. Map `error` + `error_details` + the message text to `errorClass`: `ENOTFOUND` → `dns`, "went to sleep" → `sleep`, "offline"/`connection_failed` → `network`. `Notification` types `quota_auto_resume_*` → `usage_limit`. |
| work | existing hook events (`squadrant hooks claude <sub>`, `packages/cli/src/commands/hooks.ts:45-70`) |
| fallback | interactive probe pane scrape (`packages/core/src/daemon/interactive-probe.ts`). For **Claude crews**, the **error branch** only records evidence and never alerts. The approval/question → `task.blocked` branch and the error + `gone` → `task.failed` branch are unchanged. Non-Claude crews keep the scrape alert, now deduped by errorClass and subject to inhibition, until their adapter exists (designer's call). |

**Captain sessions.** Today the hook handler exits for any session without `SQUADRANT_CREW_TASK_ID`
(`packages/cli/src/commands/hooks.ts:355-358`), so a captain's `StopFailure` never reaches the daemon.

- **P1:** a captain's `reachable` comes from liveness only.
- **P2:** add a captain hook path (`StopFailure` / `Notification` for captains).
- **Captain-only faults** go to **Telegram only**, because the captain cannot be told about itself
  (designer's call).

**Other agents (contract only, not built now).**

- **Codex:** the app-server `error` notification carries `willRetry`. Today it is mapped to a terminal
  `task.failed` and the flag is ignored (`packages/agents/src/codex/normalize.ts:73-79`). Fix this before
  codex crews are enabled.
- **opencode:** SSE handles only `session.idle` / `permission.asked`
  (`packages/agents/src/opencode/sse-bridge.ts`). `session.error` needs mapping.
- **Gemini:** headless only, so exit code + stderr.
- **Until an adapter exists,** that agent's crews feed `network`/`provider` detection only through the
  generic probe evidence. Their errors therefore mostly stay crew-only.
- **Every adapter** declares which layers it provides, and squadrant fills the rest generically. Error
  strings live in the driver, not in core.

### Alert rules

1. **Dedup key** for a session symptom is `(taskId, errorClass)`, never the pane text. A repeat with the
   same key while the incident is open only updates `count` and `lastSeenAt`.
2. **Inhibit** absorbable symptoms under an open ancestor. Append a symptom record to
   `status/incidents.jsonl` (never to the project mailbox, so the delivery loop never sees it), add to
   `incident.inhibited`, take no captain turn, send no Telegram push.
3. **Shared incident (D5, D10).** Each **affected** captain gets one line at open and one at recovery, and
   Telegram gets the same once.
   - A sleep incident sends **one combined line after the machine is stably awake**.
   - A captain is affected when one of its crews logged a symptom, had a turn die, or had a timer-based
     action paused during the incident.
   - A captain that becomes affected **after** the open line was sent gets its own open line at that
     moment.
   - A short, quiet sleep reaches nobody and is only recorded (designer's call).
4. **Crew-only incident (D13).**
   - **First report:** immediately.
   - **Reminders:** while the error stands and nobody has run `crew send` to that crew since the last
     report, remind at `initialMs · factor^n` (15 → 30 → 60 min) with ±10% jitter, at most `maxReports`
     (3) per `windowMs`.
   - **Stop and reset:** a `crew send` to the crew updates the incident's persisted `lastCaptainSendAt`,
     which stops the reminders and resets the counter. The crew recovering does the same.
   - **Recovery** sends no message (designer's call: the next crew event shows it is fine).
   - **On boot,** reminder timers are rebuilt from `incidents.jsonl`.
5. **Never inhibited:** everything in the right-hand column of "Absorbable kinds" (D4).
6. **Telegram.**
   - **Where:** incident lines go to the **General topic** (`telegram/bridge.ts:108-113`). They respect the
     global `telegram.notify.active` mute; they do not use `pushRaw`, which bypasses mute
     (`bridge.ts:88-91`).
   - **Retry:** the bridge is fire-and-forget with no outbox (`bridge.ts:894-905`), so incident lines go
     through a small durable outbox, `status/telegram-outbox.jsonl`. It holds at most 20 entries, keyed by
     incident and phase so a line is never sent twice. Sending is retried with backoff and stops at
     recovery + 24 h.
   - **Which daemon sends:** "once per machine" means once per daemon that has Telegram configured. A dev
     daemon normally has none.

### Clocks and timer-based actions (D6, D11)

- **Suspensions.** Keep `suspensions: [{from, to, kind: sleep|daemon-down, hint}]` for the last 48 h,
  **persisted from P0 on**.
- **Awake time.** Add a pure `awakeElapsed(from, to)`: wall time minus the overlap with suspensions.
  Use it in:
  - the task-timeout ceiling (`packages/core/src/daemon/reduce.ts:676-708`);
  - `evaluateStall` (`packages/core/src/watchdog.ts:56-93`): the tool / Monitor budgets and the headless
    heartbeat;
  - the stall escalation (`reduce.ts:793-810`) and quiet (`reduce.ts:833-853`);
  - the blocked re-nudge (constant `reduce.ts:118`, use `:731`);
  - the first-turn recovery and resend (`reduce.ts:113`, `:399-400`, `:460`, `:755`, `:821`);
  - the takeover nudge (`reduce.ts:639`).
- **Pause.** While a `machine`, `network`, `provider` or `squadrant:runtime` incident is open, and during
  post-wake grace, **every timer-based action** is paused: the ceiling, `evaluateStall`'s working →
  stalled change, the stall escalation, quiet, the blocked re-nudge, the first-turn resend and the
  takeover nudge. DELIVERY STUCK deferrals are not counted either.
- **Evidence-based reaps keep running.** These are the surface-gone reaps (`reduce.ts:714-723`,
  `:886-892`), `task.session.ended`, and the probe's error + `gone` → `task.failed`. They pause only while
  `squadrant:runtime` (cmux) is down, because then "gone" cannot be trusted.
  - **Explicit exception to "every cancellation is announced":** the two surface-gone reaps stay silent
    as today (#139, the crew's tab is already gone). They are recorded in the status file and listed in a
    recovery summary when they happen during an incident (designer's call).
- **Ceiling (D11).** Check liveness first.
  - **Alive:** `CREW OVERTIME`, a notify-only `task.overtime`, with no state change. It is deduped by a
    persisted `overtimeNotifiedFor` field on the TaskRecord, equal to `workingStretchStartedAt`, so it
    fires once per working stretch even across restarts.
  - **Gone:** cancel + `CREW TIMEOUT`.
- **Bug fix (independent, ships first).** The timeout path writes `cancelled` to the store (`reduce.ts:687`)
  and then notifies with the pre-cancel record (`:699`). `defaultNotify` sees a terminal record that
  differs from the announced state and drops it (`delivery-loop.ts:320-322`). Notify with the cancelled
  record, and add `task.timeout` to the must-deliver set.

### Display (D1, D7)

```
machine    ⚠ asleep 18:06→08:25 (lid closed, 61 dark wakes) · recovered
squadrant  ● ok

project-a
  captain        ● ok
  crew-1         working   · ok
  crew-2         awaiting  · ⚠ unreachable (machine) 18:06→08:25
project-b
  captain        ● ok
  crew-3         working   · ⚠ overtime 8h (!)
```

`--detailed` (existing flag, `packages/cli/src/commands/status.ts:54`) adds:
- every layer per session (alive / reachable / started / work + the native agent status);
- each squadrant component;
- side sessions;
- recent incidents from `incidents.jsonl`.

The dashboard reads the same file. The existing pull-only health (`buildHealth` and
`gatherSnapshotInputs`, `packages/core/src/daemon/start.ts:156-224`, used by `squadrant status` /
`doctor`) reads the status file for the parts it covers and stays as is for the rest.

### Storage

`<stateRoot>/status/`: one per daemon, so a dev daemon never touches production state. It is not
`sessions.json`, which is already the session-freshness file.

- **`status/current.json`:** atomic snapshot, written with the tmp + rename pattern of
  `packages/core/src/daemon/liveness-registry.ts:21`. Fields:
  `{ schema, updatedAt, daemon:{pid,lastTickWall,tickIntervalMs}, suspensions[], conditions[], incidents[] }`.
- **`status/incidents.jsonl`:** append-only open / symptom / report / close records. This is the decision
  log and the source for `--detailed` history.
  - A bad line is skipped, never fatal. (`liveness-registry.ts:24-30` resets everything on a parse error;
    do not copy that.)
  - Rotate at 1 MB and keep one previous file.
  - If `current.json` is corrupt, rebuild it from the open incidents in the log.
- **`status/telegram-outbox.jsonl`:** see alert rule 6.
- **Reloaded on boot,** so dedup and reminders survive a restart. Today `stallEpisode`, `stallEscalated`
  and `lastTail` live in memory only (`reduce.ts:381-382`, `interactive-probe.ts:142`).
- **`liveness.json`** stays as is in the first phases, then folds into the `session:<project>/captain`
  conditions.

### Recovery message

```
MACHINE RECOVERED: asleep 18:06 → 08:25 (14h19m, lid closed, 61 dark wakes).
During it: 2 crews hit network errors (crew-1, crew-2); 55 alerts absorbed; timers paused; 0 tasks cancelled.
Needs a nudge (turn died during the incident): crew-2.
Now: crew-1 working · crew-2 awaiting-input.
```

No crew is resumed automatically (D12).

### Config (new `status` block, `packages/shared/src/config.ts`)

| Key | Default |
|---|---|
| `status.enabled` | `true`. `false` turns off the whole observer (detection, inhibition, awake time, reminders) and restores today's behaviour. The P0 timeout bug fix is not behind it. |
| `status.tickGapMs` | `30000` |
| `status.postWakeGraceMs` | `120000` |
| `status.stableAwakeMs` | `300000` |
| `status.openAfterBad` / `status.closeAfterOk` | `2` / `2` |
| `status.probe.intervalMs` | `30000` (only while suspicious or an incident is open) |
| `status.probe.hosts` | from each driver (for example `api.anthropic.com:443`) |
| `status.report.maxReports` | `3` (reminders, not counting the first report) |
| `status.report.windowMs` | `21600000` |
| `status.report.backoff` | `{ "initialMs": 900000, "factor": 2, "jitterPct": 10 }` |
| `status.telegram` | `"open-and-recover"` (`off` \| `open-and-recover`) |

The pause and awake-time behaviours have no separate switches; `status.enabled` covers them. Which keys
are live-reloadable is decided in `packages/shared/src/daemon-keys.ts` (builder's call; the timing keys
can be live).

## Phasing

Each phase only uses things built in the same or an earlier phase.

| Phase | Content |
|---|---|
| P0 (small, independent) — **done** (#1112) | (a) **Timeout bug fix:** notify with the cancelled record; `task.timeout` must-deliver and allowed at every tier except `none`. (b) **Probe:** stop alerting on `Retrying …` lines; dedup by `(taskId, coarseClass)`, a minimal regex-level class (`retrying` / `network` / `sleep` / `other`) that P1's adapter mapping replaces. (c) **Suspension detector:** tick gap + OS confirmation, persisted `suspensions`, awake time for the ceiling and `evaluateStall`/escalation, and a pause of timer-based actions **during a suspension and post-wake grace only** (incidents do not exist yet). (a)+(b)+(c) would have removed nearly all of that night's 63 alerts and kept the cancelled crew alive. |
| P1 (split) | **Status file — done (#1112):** `status/current.json`, `incidents.jsonl`, `machine.Awake` / `network.Reachable` / session / `squadrant:daemon` stall conditions, `status.{enabled,tickGapMs,postWakeGraceMs,stableAwakeMs}`. **Still open:** Telegram outbox; `machine` / `network` conditions; absorbable-kind inhibition in the notifier; Telegram through the same gate; open and recovery lines; must-deliver kinds; reminders (D13); `CREW OVERTIME` (D11); Claude adapter using all `StopFailure` fields and quota notifications; pane scrape demoted to evidence for Claude; daemon-down alert through the notifier. |
| P2 | `squadrant:*` self subjects (daemon, runtime, delivery, telegram, lifecycle sources, hooks); provider / account conditions; the one-line `squadrant status` view + `--detailed`; dashboard; captain liveness folded in; captain hook path. |
| Later | codex (`willRetry`), opencode (`session.error`), gemini adapters; optional provider status pages; optional phi-accrual stall detection. |

## Call sites (for the plan)

- `packages/core/src/daemon/interactive-probe.ts:32-38,142,167-191`: regex, dedup key, demote to evidence.
- `packages/core/src/daemon/start.ts`:
  - `:67-73`: Telegram behind the notifier gate.
  - `:313-349`: boot gap → suspension or downtime; the down alert through the notifier.
  - `:407-426`: timers feed the tick-gap detector.
  - `:156-224`: health reads the status file.
- `packages/core/src/daemon/delivery-loop.ts`:
  - `:30`: must-deliver kinds.
  - `:302-337`: `defaultNotify` returns a reason and applies inhibition.
  - `:320-322`: the timeout bug.
  - `:678-700`: DELIVERY STUCK becomes an incident and pauses during one.
- `packages/core/src/daemon/captain-noise.ts:56-61` and `packages/core/src/telegram/tiers.ts:5-13`: tier gate
  for the must-deliver kinds; an `inhibited` outcome.
- `packages/core/src/daemon/reduce.ts:113,118,639,676-708,399-400,460,731,755,764-810,821,833-853` and
  `packages/core/src/watchdog.ts:56-93`: awake time, pause, OVERTIME.
- `packages/shared/src/types/control.ts`:
  - `:179`: `errorClass`, `errorDetails` on `task.turn.failed` / `task.warn`.
  - a new `task.overtime` event;
  - `overtimeNotifiedFor` on TaskRecord.
- `packages/agents/src/interactive/claude.ts:511-530,630-640`: the Claude errorClass mapping.
- The `crew send` path: update `lastCaptainSendAt` on the crew's open crew-only incident.
- `packages/core/src/telegram/bridge.ts`: outbox and General-topic incident lines.
- `packages/cli/src/commands/status.ts`, `packages/web`: the view.
- `packages/shared/src/config.ts`: the `status` block.
- Docs in the same PRs: `docs/reference.md`, `docs/diagrams/`, this spec.

## Left to the builder

- Exact K/M thresholds and the probe target list per provider.
- Whether the tick-gap detector hooks every timer or runs as its own 5–10 s heartbeat timer (either is fine
  if the gap threshold accounts for the interval).
- How the OS confirmation and the `pmset -g log` hint are read (bounded, best effort, cached per gap).
- File schema details beyond the fields named above.
- The errorClass mapping table for Claude message strings. Keep it in the Claude driver and cover it with
  tests that use the real strings from the incident:
  - `API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)`
  - `API Error: Your computer went to sleep mid-response. The response above may be incomplete.`
  - `✻ API error · Retrying in 0s · attempt 1/10`

## Designer's calls (made without the operator; check while reading)

1. Only captains with an affected crew are told about a shared incident. A short, quiet sleep is only
   recorded.
2. Pane-scrape demotion applies to Claude crews and the error branch only.
3. Captain status in P1 is liveness only. Captain-only faults go to Telegram only.
4. Evidence-based reaps keep running during incidents. The two surface-gone reaps stay silent as today.
5. A crew recovering from a crew-only fault sends no message.
6. Telegram incident lines go to the General topic, honour the global mute, and are capped and retried for
   at most recovery + 24 h.
7. An unconfirmed tick gap is a daemon event-loop stall, not machine sleep.
8. The new must-deliver kinds pass every captain tier except `none`.
