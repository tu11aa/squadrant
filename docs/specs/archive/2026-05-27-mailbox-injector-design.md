# Mailbox + Injector — Foundational Design for Captain Notifications

> **✅ Shipped** (PR #116, 2026-05-27). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-05-27
**Status:** Approved design, pre-implementation. Brainstormed in-session 2026-05-27.
**Predecessors (read first):**
- `docs/specs/2026-05-26-claude-interactive-through-daemon-design.md` — Phase 3 (PR #108) — daemon-supervised Claude crews.
- `docs/research/2026-05-27-multi-session-orchestrator-notification-patterns.md` — pattern survey across OpenHands/AutoGen/crewAI/LangGraph/Swarm/tmux-orchestrator/Claude Squad/Aider/Goose/Continue/Codex/Erlang/D-Bus/XPC/sd_notify/OTel. **Rank-1 recommendation: mailbox + injector (Erlang + Orca hybrid).** This spec implements that recommendation.
- `docs/research/2026-05-27-tracking-codex-while-keeping-native-tui.md` — finds that codex hooks fire in TUI mode (notchi/Orca pattern). Motivates #114.

**Cross-refs:**
- **Closes** the un-shipped half of **#113** (replay-on-reconnect) by construction — pull-from-cursor is replay-by-default.
- **Foundation for** **#114** (hybrid codex: native TUI + hook bridge) and **#115** (opencode interactive wiring).
- **Replaces** the subscribe/broadcast machinery added in **PR #112** with a pull-from-file model. PR #112's relay-tab idea survives (correct shape per the research); the protocol underneath it gets simpler.

---

## 1 · Problem & non-goals

**Problem.** Cockpit's captain → crew → captain feedback loop went through three architectural attempts in May 2026:

1. **PR #110 (#109):** daemon shells out to `cockpit runtime send <project> "CREW DONE ..."` after a terminal `ControlEvent`. Fails in production because cmux's CLI rejects callers not in its process tree (proc-lineage check, verified empirically).
2. **PR #112 (#111 fix):** daemon broadcasts events over its socket; a `notify-relay` tab inside each captain workspace subscribes and forwards to the captain pane via `RuntimeDriver.send`. Works in steady state because the relay tab IS inside cmux's tree. **Breaks during daemon-bounce backoff windows** (#113): pushes broadcast while the relay is reconnecting are silently lost. The inbox file written alongside the broadcast was scoped as "debug backup," never replayed.
3. **Field complaint (this session):** the relay-tab + subscribe-protocol + reconnect-backoff machinery is more complex than the value it delivers, and the visible tab clutters captain workspaces.

The 2026-05-27 research survey identified the right architectural shape — already present in PR #112 — but called out that the relay was "treated as a workaround rather than dignified as a first-class element," and that the missing pieces were (a) durable per-captain mailbox, (b) pull-from-cursor delivery instead of push-with-no-replay, (c) RuntimeDriver abstraction of the injector spawn.

**Goal.** Replace PR #112's subscribe/broadcast machinery with a **file-as-source-of-truth mailbox** the daemon appends to and an **injector inside the captain workspace** that tails the mailbox from a persisted cursor and delivers each event to the captain pane via a runtime-agnostic `RuntimeDriver` surface. The result:
- At-least-once delivery (closes #113 by construction)
- Daemon-bounce-tolerant by design (file is durable; no socket coordination)
- Uniform pattern across claude / codex / opencode (each provider emits `ControlEvent`s into the mailbox via its native hook surface; the injector is provider-agnostic)
- Runtime-agnostic (cmux today, orca / zed / IntelliJ-MCP later — each runtime implements two driver methods)

**Non-goals (YAGNI — explicitly out):**
- Replacing PR #98's app-server foundation for codex headless. App-server remains the headless path and reference impl for the gate primitive. This spec is about notifications, not codex driver replacement.
- Multi-captain-per-project workflows. Today one captain per project. Schema allows extending the cursor file naming (`<project>.<captain-name>.cursor`) if multi-captain comes later.
- Cross-host notifications (Telegram / SMS / etc — #65 deferred). The mailbox schema supports multi-subscriber via per-subscriber cursor files; the Telegram subscriber, when implemented, gets its own cursor.
- Replacing legacy `cockpit crew read` / `crew send` / `crew close` (cmux-pane verbs). Those keep working unchanged.
- A general decision-gate primitive (PR #98's gates stay codex-only for now).
- Killing the daemon socket protocol entirely. The socket still serves `dispatch` / `status` / `tasks` / `reply` / `_hook` / `gate-resolve`. Only the `subscribe-notify` + `push` frames added in PR #112 get removed.

---

## 2 · Lessons applied from PRs #110 and #112

This is the **third** iteration on captain notifications in May 2026. Each prior attempt taught something this design must honor.

| Lesson | Source | How this design honors it |
|---|---|---|
| Shelling out via `cockpit runtime send` from launchctl-spawned daemon fails — cmux's CLI rejects non-cmux-tree callers | PR #110 → #111 diagnosis | Daemon never invokes any cmux-aware command. It only appends to a file. The injector — which IS inside cmux's tree — owns all `RuntimeDriver` interaction. |
| Push-with-no-replay loses events during daemon-bounce backoff windows | PR #112 → #113 | Pull-from-cursor model: injector reads from `lastAckedSeq + 1` on every restart. Daemon bouncing doesn't break delivery; the file is durable. |
| Subscribe protocol + reconnect-backoff is more complex than needed for a single in-process subscriber | PR #112 field experience | No subscribe protocol. No socket connection from injector to daemon. Injector tails a file. Loop is ~50 lines vs PR #112's ~150. |
| The "relay tab" idea is correct (process must be in cmux's tree); the protocol behind it is what's wrong | Research 2026-05-27 § *"The relay tab is not a workaround"* | Keep the in-cmux-tree process. Change only how it gets events. |
| Visible relay tab in workspace is cosmetic clutter | User complaint this session | RuntimeDriver `spawnInjector("hidden")`; cmux impl uses a height-minimized split-pane (or falls back to visible if cmux can't hide). |
| `RuntimeDriver` is the right place for runtime-specific concerns; daemon stays runtime-agnostic | Architectural invariant since PR #74 | Driver gains two methods: `spawnInjector` + `sendToSurface`. Daemon never references cmux. |
| Anti-#2576 invariant: terminal state comes from explicit `cockpit crew signal`, never from liveness hooks | Spec line 109 of control-plane design (PR #85) | Mailbox content is whatever the daemon's state machine + `firePush` gate already produces. This spec doesn't change WHICH events fire; only how they reach the captain. |

The research's central observation also applies: the relay-tab pattern is the same shape as Erlang per-process mailboxes (BEAM-allocated queue per actor, owner pulls from it on schedule) and Orca's hook receiver (in-process listener for codex events). Dignifying it with a durable queue and a clean driver surface is what was missing.

---

## 3 · Approach (single PR, surgical, atomic commits)

One branch: `feature/mailbox-injector`. Four atomic commits in one PR:

1. **`src/control/mailbox.ts` (NEW)** — pure mailbox operations + tests. No daemon wiring yet.
2. **Daemon side switchover** — `cockpitd.ts`'s `defaultNotify` rewired to `appendToMailbox`; subscribe-broadcast machinery and `protocol.ts` subscribe/push frames deleted.
3. **`notify-relay` rewrite** — `src/commands/notify-relay.ts` rewritten as file-tailer (replaces socket subscriber).
4. **`RuntimeDriver.spawnInjector("hidden")` + cmux split-pane impl** — `launch.ts` switches from `newPane` (tab) to `spawnInjector` (hidden split).

Each commit keeps end-to-end working (with the brief exception of commit 2, where events land in the mailbox but the relay isn't reading them yet — commit 3 lands the reader in the same PR, so the bridge state never reaches `develop`).

**Approach 3 boundary preserved** (control-plane spec, line 47-52): daemon owns headless children by PID; for interactive, daemon owns the *event stream*, not the agent process. This spec keeps that invariant: daemon owns the mailbox; the injector owns delivery; neither owns the captain process.

---

## 4 · Architecture

```
   ┌──────────────────────────────┐    1. POST ControlEvent
   │ crew (any provider)          │ ─────────────┐
   │ - claude Stop hook → _hook   │              │
   │ - codex hooks (#114) → _hook │              ▼
   │ - opencode plugin (#115) →   │      ┌────────────────────────────────┐
   │      _hook                   │      │ cockpitd                       │
   │ - explicit `crew signal done`│      │ - apply event via state machine│
   └──────────────────────────────┘      │ - firePush gate (existing):    │
                                          │   only on done/blocked/failed/ │
                                          │   stalled AND state changed    │
                                          │ - appendToMailbox()            │
                                          │ - rotateIfNeeded() (timer)     │
                                          │ NO subscribe protocol          │
                                          │ NO socket broadcast            │
                                          └────────────────────────────────┘
                                                          │
                                                          │ append-only
                                                          ▼
                                          ┌────────────────────────────────┐
                                          │ ~/.config/cockpit/inbox/        │
                                          │   <project>.log                 │
                                          │   <project>.log.1 (rotated)     │
                                          │   <project>.<sub>.cursor        │
                                          │ JSON-lines, append-only,        │
                                          │ flock-protected on write        │
                                          └────────────────────────────────┘
                                                          │
                                                          │ tail -F from cursor
                                                          ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ Injector — hidden split-pane in captain's tab (cmux)        │
   │  `cockpit notify-relay <project> --as captain`              │
   │  - read cursor (lastAckedSeq)                                │
   │  - tail mailbox file from seq+1                              │
   │  - for each entry:                                           │
   │      msg = format(entry)                                     │
   │      runtime.sendToSurface(captainSurface, msg)              │
   │      writeCursor(entry.seq) [fsync + atomic rename]          │
   │  - in cmux's process tree → cmux send works (lineage OK)    │
   └─────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- **Mailbox file is single source of truth for the notification stream.** Daemon writes; injector reads. No other path delivers events to the captain.
- **Pull, not push.** Injector is responsible for catching up; daemon doesn't track subscribers. Daemon-bounce is irrelevant to delivery correctness.
- **At-least-once.** Cursor advances only after `sendToSurface` returns. Crash before fsync = replay on restart. Captain may see one event twice; never zero.
- **Runtime-agnostic.** Daemon and notify-relay reference `RuntimeDriver`, never cmux directly. The two new driver methods (`spawnInjector`, `sendToSurface`) are the entire surface area runtimes must implement.

---

## 5 · Mailbox data model

### 5.1 Directory layout

```
~/.config/cockpit/inbox/
  <project>.log                 # current append-target (JSON-lines)
  <project>.log.1               # rotated (older)
  <project>.log.2               # ...
  <project>.<subscriber>.cursor # per-subscriber checkpoint
```

Subscriber name today: `captain` (the only subscriber). Schema designed so future subscribers (Telegram, dashboard) get their own cursor file without changing the log format or contending on the same cursor.

### 5.2 Log line schema

Each line is one JSON object terminated by `\n`. Example:

```json
{"seq":42,"ts":"2026-05-27T14:23:45.123Z","taskId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","kind":"task.done","provider":"claude","payload":{"message":"PING-OK live test successful","resultRef":"/Users/.../state/_results/a1b2c3d4-...txt"}}
```

| Field | Type | Notes |
|---|---|---|
| `seq` | number | Monotonic per project. Daemon increments atomically inside flock during `appendToMailbox`. Starts at 1 on fresh project; on daemon restart, daemon re-scans tail of current log file to find max-seq, resumes at max+1. |
| `ts` | string (ISO-8601 UTC) | Wall-clock time of append. |
| `taskId` | string (UUID) | TaskRecord this event belongs to. |
| `kind` | `"task.started"` \| `"task.progress"` \| `"task.done"` \| `"task.blocked"` \| `"task.failed"` \| `"task.stalled"` | The normalized `ControlEvent` kind. |
| `provider` | `"claude"` \| `"codex"` \| `"opencode"` | For future per-provider rendering / filtering. |
| `payload` | object | Kind-specific: `{message, resultRef}` for done, `{question}` for blocked, `{error}` for failed, etc. |

### 5.3 Cursor file schema

```json
{"lastAckedSeq":42,"subscriber":"captain","updatedAt":"2026-05-27T14:23:45.456Z"}
```

| Field | Notes |
|---|---|
| `lastAckedSeq` | The greatest `seq` the subscriber has *durably acked* (i.e. `sendToSurface` returned successfully AND cursor write completed). On next startup, subscriber resumes from `lastAckedSeq + 1`. |
| `subscriber` | Cosmetic; matches the file's subscriber name slot. Used for diagnostics only. |
| `updatedAt` | Wall-clock; for debug. |

Cursor write is atomic: write to `<file>.tmp` → `fsync` → `rename(<file>.tmp, <file>)`. Survives mid-write crash; injector's restart-read either sees the old cursor (replays one event = at-least-once) or the new cursor (already advanced).

### 5.4 Atomicity of seq increment

Daemon is single-process node; the event loop guarantees serial execution of the `appendToMailbox` body. flock on `<project>.log` is held for the duration of read-max-seq + write-line + close, to guard against:
- Briefly overlapping daemons during launchctl restart (rare, but possible)
- Manual `cockpit` subprocess invocations that might write directly (none today, but defensive)

flock is advisory on macOS; daemon and any future writer must voluntarily honor it. Documented in `mailbox.ts`.

**First-append bootstrap.** On the first append for a project (no `<project>.log` yet), `appendToMailbox` opens the file with `O_CREAT | O_APPEND` and initializes seq=1. No special-case branch in callers.

### 5.5 GC / rotation

Daemon runs `rotateIfNeeded(project)` every 60 seconds (background timer) and immediately after every append. Rotation triggers when **either**:
- `<project>.log` size > **5 MB** (tunable: `config.mailbox.maxBytes`), or
- Oldest line in `<project>.log` timestamp > **7 days** old (tunable: `config.mailbox.maxAgeMs`)

Rotation procedure:
1. Hold flock on `<project>.log`.
2. `rename(<project>.log, <project>.log.tmp-N)` (N = monotonic suffix to avoid races).
3. Open new empty `<project>.log` for append.
4. Release flock.
5. Background: re-sort rotated files by name, rename to canonical `<project>.log.1`, `.2`, etc. Delete any beyond `keepCount = 3` (tunable: `config.mailbox.keepRotations`).

Total retention window: up to ~20 MB (current 5 MB + 3 × 5 MB rotated) OR up to ~28 days (current 7 days + 3 × 7 days rotated), whichever fills first. Plenty for any realistic scrollback.

### 5.6 Gap handling (cursor older than oldest retained)

When injector starts and finds `lastAckedSeq` is older than the earliest entry in any retained log file:
1. Inject a synthetic line into the captain pane:
   `[notify-relay] cursor 42 stale; skipping to seq 158 (116 events lost during outage)`
2. Update cursor to the current tail's max seq.
3. Resume tailing normally.

Honest degradation. User sees explicitly that events were lost (rather than silent stale state).

### 5.7 Multi-subscriber design (forward-compatible, no work today)

Each subscriber has its own cursor file. A future Telegram subscriber would:
- Run `cockpit notify-relay <project> --as telegram --target telegram://...`
- Read/write `<project>.telegram.cursor`
- No contention with captain subscriber; independent cursor advancement

Today only `--as captain` exists. The flag is parsed and used in file naming from day 1.

---

## 6 · Daemon-side changes

### 6.1 New module: `src/control/mailbox.ts`

Pure-ish module. Side effects limited to fs operations. All public functions take a `stateRoot` param for testability.

```typescript
export interface MailboxEntry {
  seq: number;
  ts: string;
  taskId: string;
  kind: ControlEvent["type"];
  provider: Provider;
  payload: Record<string, unknown>;
}

export async function appendToMailbox(opts: {
  stateRoot: string;
  project: string;
  taskRecord: TaskRecord;
  event: ControlEvent;
}): Promise<number>; // returns seq

export async function rotateIfNeeded(opts: {
  stateRoot: string;
  project: string;
  maxBytes?: number;
  maxAgeMs?: number;
  keepCount?: number;
}): Promise<{ rotated: boolean; from?: string; to?: string }>;

export async function* readFromCursor(opts: {
  stateRoot: string;
  project: string;
  fromSeq: number;
}): AsyncIterable<MailboxEntry>;

export async function readCursor(opts: {
  stateRoot: string;
  project: string;
  subscriber: string;
}): Promise<{ lastAckedSeq: number } | null>;

export async function writeCursor(opts: {
  stateRoot: string;
  project: string;
  subscriber: string;
  lastAckedSeq: number;
}): Promise<void>;
```

### 6.2 `defaultNotify` rewrite in `cockpitd.ts`

Today (post-PR #110): `defaultNotify` shells out to `cockpit runtime send`. Tomorrow:

```typescript
const defaultNotify = async (args: { project: string; message: string; record: TaskRecord; event: ControlEvent }): Promise<void> => {
  try {
    await appendToMailbox({
      stateRoot,
      project: args.project,
      taskRecord: args.record,
      event: args.event,
    });
  } catch (e) {
    log(`mailbox append failed project=${args.project}: ${(e as Error).message}`);
  }
};
```

**Signature change:** `defaultNotify` previously took `{project, message}`. Now takes `{project, message, record, event}` so it can serialize the rich payload. `firePush` is updated to pass these through. Tests assert new signature.

### 6.3 Subscribe-broadcast removal

- `src/control/protocol.ts`: delete `subscribe-notify` claim frame and `push` event frame (added in PR #112). Other frames untouched.
- `cockpitd.ts`: delete the subscriber registry, the broadcast loop, and the `case "subscribe-notify"` handler.
- Existing tests for these get deleted in the same commit.

### 6.4 Background rotation timer

```typescript
const rotateTimer = setInterval(async () => {
  for (const project of knownProjects(stateRoot)) {
    try { await rotateIfNeeded({ stateRoot, project, ...rotationConfig }); }
    catch (e) { log(`rotate failed project=${project}: ${(e as Error).message}`); }
  }
}, 60_000);

// On shutdown: clearInterval(rotateTimer);
```

`knownProjects` is `readdirSync(stateRoot/inbox).filter(...)`. Cheap.

### 6.5 firePush gate — unchanged

The existing gate logic (PR #110, refined in PR #112) stays exactly as is:
- Only fire on transitions where `prev.state !== next.state`
- Only fire when `next.state ∈ {done, blocked, failed, stalled}`
- Suppress liveness ticks (`task.progress` events that don't change state)

The gate decides WHICH events reach `defaultNotify`. The mailbox decides WHERE the gated events go. Separation of concerns preserved.

### 6.6 Daemon API surface — net delta

| Surface | Before this spec | After |
|---|---|---|
| Socket frames | dispatch / status / list / reply / event / _hook / gate-resolve / **subscribe-notify** / **push** | dispatch / status / list / reply / event / _hook / gate-resolve |
| Inbox file | Append-only debug log (PR #112); no replay support | **Primary delivery channel** with seq + cursor + rotation |
| Subscriber tracking | In-memory list of socket connections | None |

Net: daemon protocol gets simpler.

### 6.7 Behavior on daemon bounce

- Mid-append daemon kill → flock released by OS; line at EOF may be partial; injector's parser skips partial last line, picks up on next append.
- Daemon restart → reads tail of `<project>.log` to find max seq; resumes at max+1.
- Cursor file unaffected by daemon bounce (only injector writes it).

---

## 7 · Injector side

### 7.1 Command surface

```
cockpit notify-relay <project> [--as <subscriber>] [--state-root <path>]
  <project>         project name from cockpit config
  --as              subscriber name (default: "captain"); determines cursor file name
  --state-root      override default ~/.config/cockpit (tests / dev)
```

Long-running process. Designed to be spawned by `cockpit launch` via `RuntimeDriver.spawnInjector`. Survives until `SIGTERM` (clean shutdown — flushes cursor) or `SIGKILL` (next launch detects dead injector + respawns).

### 7.2 Lifecycle

```
1. BOOT
   - Parse args; resolve config; resolve project entry
   - Resolve captain WorkspaceRef + primary SurfaceRef via RuntimeDriver
     (one-shot; cached for process lifetime)
   - Read cursor (~/.config/cockpit/inbox/<project>.<sub>.cursor)
     - exists → lastAckedSeq = <value>
     - missing → lastAckedSeq = 0 (start from seq 1)
   - GAP CHECK: open <project>.log, peek first line's seq
     - If first seq > lastAckedSeq + 1 → emit synthetic [GAP] line first,
       then update cursor to (peeked-tail-max-seq), continue from there
     - Else proceed normally

2. LOOP
   for await (const entry of readFromCursor({stateRoot, project, fromSeq: lastAckedSeq + 1})) {
     msg = format(entry)
     try {
       await runtime.sendToSurface(captainSurface, msg)
     } catch (e) {
       log(`sendToSurface failed seq=${entry.seq}: ${e.message}`)
       // do NOT advance cursor on send failure; bounded retry handled at outer loop
       await sleep(1000)
       continue
     }
     await writeCursor({stateRoot, project, subscriber, lastAckedSeq: entry.seq})
     lastAckedSeq = entry.seq
   }

3. WAITING ON NEW EVENTS
   - When readFromCursor reaches current EOF, switch to file-watcher
     (chokidar or fs.watch). On 'change' event → re-enter the loop.
   - Poll fallback: if watcher fails to register, poll every 1000ms.

4. ROTATION HANDLING
   - When readFromCursor reaches EOF AND <project>.log gets a new inode
     (detected via stat.ino comparison or watcher 'rename' event),
     close current FD, re-open path, continue.
   - rotated files (<project>.log.1, etc.) are read transparently when
     cursor + tail span the rotation boundary.

5. SHUTDOWN
   - SIGTERM: flush cursor write (already synchronous after each deliver)
   - Exit 0
```

### 7.3 Format dispatch

Per-event message format (matches existing PR #110 format for compat):

| `entry.kind` | Rendered to captain pane |
|---|---|
| `task.started` | (suppressed — not actionable) |
| `task.progress` | (suppressed — liveness; the gate shouldn't even send these, but defensive) |
| `task.done` | `CREW DONE [<provider>/<id8>]: <payload.message OR taskRecord.task first line, 120 chars>` |
| `task.blocked` | `CREW BLOCKED [<provider>/<id8>]: <payload.question>` |
| `task.failed` | `CREW FAILED [<provider>/<id8>]: <payload.error>` |
| `task.stalled` | `CREW STALLED [<provider>/<id8>]: no heartbeat in <budgetMs>ms` |

`id8` = first 8 chars of taskId for compact identification. Identical to PR #110/#112 format for muscle memory.

### 7.4 At-least-once invariant

- Cursor only advances AFTER `sendToSurface` returns successfully (no exception thrown).
- Cursor write uses fsync + atomic rename. Mid-write crash → restart reads old cursor → replays last event.
- Captain may see one event twice (e.g. `sendToSurface` succeeded but the daemon SIGKILLed the injector before cursor write completed) — acceptable. The duplicate `CREW DONE` line is mildly confusing but never silently lost.

### 7.5 Crash + respawn

- Injector dies → captain workspace still has the (now-defunct) hidden split-pane
- Next `cockpit launch <project>` (idempotent — captain-ops runs at session start) checks the injector pane: if process is dead, kill the pane and call `spawnInjector` again
- Respawned injector reads cursor → continues from `lastAckedSeq + 1`
- No coordination with daemon; daemon doesn't know or care if an injector is alive

### 7.6 What was removed from PR #112

The new `notify-relay.ts` is approximately 1/3 the size of PR #112's version:
- ❌ Socket connect logic
- ❌ Subscribe frame send/receive
- ❌ Reconnect-with-backoff (2s → 4s → … → 30s)
- ❌ Subscriber-side dedup
- ✅ File tail + cursor advance (new)

---

## 8 · RuntimeDriver interface

### 8.1 New methods

```typescript
interface RuntimeDriver {
  // ... existing: status, list, send, sendToPane, newPane, listSurfaces, spawn, listSurfaces ...

  /**
   * Spawn a long-running process inside the captain workspace's process tree,
   * such that any IPC/socket constraints of the runtime (e.g. cmux's parent-
   * lineage check) are satisfied.
   *
   * placement: "hidden" should produce a non-distracting surface — runtime
   * decides exactly how. "visible" is a normal pane (debug mode).
   *
   * Returns a SurfaceRef the caller can use later for read/inspect (e.g. to
   * detect the injector has died).
   */
  spawnInjector(opts: {
    captainWorkspace: WorkspaceRef;
    command: string;       // the shell command to run, e.g. "cockpit notify-relay <proj>"
    title?: string;
    placement: "hidden" | "visible";
  }): Promise<SurfaceRef>;

  /**
   * Send text to a specific surface (vs. send() which targets a workspace
   * by name and routes to its primary tab). Used by the injector to deliver
   * messages to the captain's main surface.
   *
   * Returns when the runtime has accepted the write. Throws if the surface
   * no longer exists.
   */
  sendToSurface(surface: SurfaceRef, text: string): Promise<void>;
}
```

### 8.2 cmux implementation (`src/runtimes/cmux.ts`)

**`spawnInjector` with `placement: "hidden"`:**
```
1. cmux new-split --workspace <ws.id> down
   → returns new surface id (parse from output)
2. cmux send --workspace <ws.id> --surface <new> "<command>" + send-key Enter
3. cmux resize-split (if supported) → height = minimum
   If not supported: leave default; document the cosmetic cost
4. cmux rename-tab --workspace <ws.id> --surface <new> "<title or '✉ notify-relay'>"
5. Return SurfaceRef{id: <new>, workspaceId: <ws.id>, ...}
```

**`spawnInjector` with `placement: "visible"`:** identical, skip step 3.

**`sendToSurface`:**
```
cmux send --workspace <surface.workspaceId> --surface <surface.id> "<text>"
cmux send-key --workspace <surface.workspaceId> --surface <surface.id> Enter
```

This is essentially extracting the surface-targeting half of the existing `send()` method (already present in `cmux.ts:87-106` from PR #84) into its own callable method.

### 8.3 Probing cmux capability before commit 4

Commit 4 of the implementation PR must include a probe step:
- Verify `cmux new-split --workspace <id> down` returns a parseable surface id
- Verify `cmux resize-split` (or equivalent) can reduce a split to height ≤ 3 rows
- If resize unsupported → fall back to spawn as a regular tab via `newPane` (PR #112 behavior). Update the spec's open question table to record this outcome.

This is a hardware-of-the-runtime question that's faster to probe than to research; the design is robust to either answer.

### 8.4 Future runtimes (orca / zed) — no daemon code changes

- **orca**: `spawnInjector` could create a hidden status widget or background pane via orca's API. `sendToSurface` uses orca's IPC.
- **zed**: zed has its own pane / buffer model. The injector could be a Zed extension or a sidebar process zed manages. Implementation is the runtime author's problem.
- **none of the daemon code or notify-relay command source changes** when adding a new runtime. The `RuntimeDriver` registry already handles this dispatch.

---

## 9 · Migration & integration with related issues

### 9.1 Single PR, four atomic commits — no flag day

| Commit | What ships | Verifiable in isolation? |
|---|---|---|
| 1: `mailbox.ts` (NEW) + unit tests | Pure functions for append/rotate/read/cursor | Yes. Unit tests cover all schema invariants. No daemon wiring. |
| 2: `cockpitd.ts` rewires `defaultNotify` to `appendToMailbox`; subscribe/broadcast removed from `protocol.ts` and `cockpitd.ts` | Events land in mailbox; relay-tab (PR #112 code) still runs but receives no socket events — harmless idle | Yes. Integration test: dispatch task.done, assert mailbox file has the entry. Captain pane does NOT receive the line yet — that's commit 3's job. |
| 3: `notify-relay.ts` rewritten as file-tailer; PR #112's socket-subscribe code deleted | Captain pane receives lines again, this time via tail-from-cursor | Yes. E2E smoke: spawn crew, signal done, captain pane sees line. Also: bounce daemon mid-spawn, see line still arrive on next run. |
| 4: `RuntimeDriver.spawnInjector("hidden")` + cmux split impl; `launch.ts` switches from tab to hidden split | No new functional capability; cosmetic upgrade. `launch.ts` detects any pre-existing `✉ notify-relay` surface (tab OR split) and closes it before spawning the hidden one — avoids duplicate injectors. | Yes. Visual check + smoke test. Fallback to visible tab if cmux can't hide. |

End of PR: PR #112's old code is fully removed; mailbox-injector is the only path. No dead code period in `develop`.

### 9.2 Closes #113 by construction

The bounce-race that #113 documents — daemon broadcasts during injector's reconnect-backoff window → push lost — cannot happen in this design:
- Daemon doesn't push. It appends to a file.
- Injector doesn't reconnect to a socket. It tails a file.
- Daemon bounce: file is there. Injector continues from cursor.
- Injector bounce: file is there. Cursor is there. Resume on respawn.

No replay protocol needed. No socket-level coordination. The "bug" goes away because the system that caused it is gone.

### 9.3 Foundation for #114 (hybrid codex: native TUI + hook bridge)

#114 adds:
- `src/control/interactive/codex-hooks.ts` (new) — mirrors `interactive/claude.ts`. Writes per-task entry to `~/.codex/hooks.json` pointing the hook command to `cockpit crew _hook codex.<event>`.
- `crew.ts` codex branch: spawn native `codex` CLI + write per-task hook config + clean up on crew close.
- Daemon's `_hook` handler already understands the bridge from claude (PR #108); extend its event-name mapping table to include codex hook event names.

**Zero injector or mailbox changes for #114.** Codex events flow into daemon → `firePush` gate → mailbox → injector → captain pane. The notification pipe is provider-agnostic.

### 9.4 Foundation for #115 (opencode interactive wiring)

#115 adds:
- `src/control/interactive/opencode-plugin.ts` (new) — generates per-task `.opencode/plugin/cockpit-<taskId>.ts` that hooks `session.idle` (and related) and posts via `cockpit crew _hook opencode.<event>`.
- `crew.ts` opencode branch: spawn native `opencode` TUI + write per-task plugin + clean up on close.
- Universal fallback (explicit `cockpit crew signal done`) — already shipped in PR #110 / orchestrator templates.

**Zero injector or mailbox changes for #115.** Same pipe.

### 9.5 The unified provider-shape in `crew.ts`

After #114 and #115 land on top of this spec:

```typescript
if (agentName === "claude" || agentName === "codex" || agentName === "opencode") {
  // 1. Dispatch to daemon (TaskRecord created, daemon supervises)
  const req = buildDispatchRequest({ provider: agentName, mode: "interactive", project, cwd: proj.path, task });
  const rec = await cockpitdCall(req) as TaskRecord;

  // 2. Provider-specific hook/plugin/settings injection (small adapter per provider)
  const hookSetup = providerHookAdapter(agentName).setup({
    taskId: rec.id, project, cwd: proj.path
  });

  // 3. Spawn native CLI with env carrying COCKPIT_CREW_TASK_ID + project
  const cliCommand = agent.buildCommand({
    ...
    settingsPath: hookSetup.settingsPath,   // claude only
    hookConfigPath: hookSetup.hookConfigPath, // codex only
    pluginPath: hookSetup.pluginPath,       // opencode only
  });
  await runtime.sendToPane(pane, `${envPrefix} ${cliCommand}`);

  // 4. Captain pane gets CREW DONE auto-pushed via mailbox → injector
  //    (no extra code path; the pipe is already running)
  return { ...pane, title };
}
```

The codex / opencode branches each shrink to ~20 lines that essentially differ only in the `providerHookAdapter` call.

### 9.6 Out of scope (filed separately or already filed)

- **Telegram subscriber (#65)** — gets its own `<project>.telegram.cursor`; orthogonal. Becomes a new subscriber implementation reusing `readFromCursor`.
- **Dashboard derived from mailbox** — orthogonal. A future PR can subscribe a dashboard service to the mailbox.
- **`cockpit crew tasks` showing events from mailbox** — daemon already serves task state via store; this spec doesn't change that. Mailbox is for notifications, store is for state queries.

### 9.7 Migration risks

| Risk | Severity | Mitigation |
|---|---|---|
| `fs.watch`/chokidar misbehaving on macOS APFS | Med | Poll-fallback every 1s; test both code paths. |
| flock not honored on unusual filesystems | Low | cockpit is single-host today; document the assumption. |
| cmux `new-split` API differs from docs | Med | Probe in commit 4; fall back to visible tab if `spawnInjector("hidden")` cannot deliver hidden. |
| Rotation race: daemon rotates while injector mid-read | Low | Injector reads by FD until EOF, then re-opens path. Standard tail -F pattern. |
| Disk fills under abnormal event rate | Low | Daemon's `appendToMailbox` fails loud; `crew signal done` returns error; honest backpressure. |
| Cursor file written but rename interrupted (powerloss) | Very low | fsync + atomic rename. Worst case: one duplicate event. At-least-once invariant holds. |
| Hidden split-pane looks broken visually (zero rows, artifacts) | Med | Visual validation gates commit 4. Acceptable fallback: 1-3 row visible footer (still way less intrusive than a tab). |
| Old PR #112 cursor format → not compatible | None | PR #112 had no cursor file (no replay). Fresh schema. |
| Live captains during deploy mid-PR | Low | Each commit keeps end-to-end working; deploy after commit 4 is a no-op for in-flight events (mailbox is durable). |

---

## 10 · Testing strategy

### 10.1 Layers

| Layer | What's tested | Pattern |
|---|---|---|
| **Unit — mailbox.ts** | `appendToMailbox` seq monotonicity, atomic write under flock, line schema, rotation triggers; `readFromCursor` skip-rotated-files, partial-line tolerance, gap detection; `readCursor`/`writeCursor` atomicity (mocked rename fail) | vitest with temp tmpdir; no daemon, no socket, no runtime |
| **Unit — notify-relay** | Cursor read/write atomicity, formatter dispatch per event kind, fake-runtime `sendToSurface` assertions, crash-mid-deliver replay (assert event re-delivered), bounded retry on send failure | vitest with `MemoryRuntimeDriver` (existing pattern in `notifiers/__tests__/helpers/`); spec the at-least-once contract |
| **Integration — daemon** | `defaultNotify` writes to mailbox under flock; concurrent appends produce monotonic seq (simulate with `await Promise.all`); rotation under load doesn't lose events; subscribe protocol genuinely removed (assert socket frame rejected) | vitest temp-socket harness (existing `cockpitd-*.test.ts` pattern) |
| **Integration — cmux RuntimeDriver** | `spawnInjector("hidden")` produces a surface; `sendToSurface` lands text in the right surface; resize-to-min succeeds OR fallback path works | vitest with `describe.skipIf(!cmuxAvailable)`; opt-in live |
| **E2E smoke** | Spawn real Claude crew on cockpit project, signal done, captain pane receives line via mailbox→injector chain, cursor advances, daemon bounce mid-task → still delivers on respawn | `scripts/mailbox-injector-smoke.mjs`; evidence to `.mailbox-injector-smoke.local` (gitignored) |

### 10.2 New test count estimate

~25-35 new tests across the unit/integration layers. Existing PR #112 tests for `cockpitd-notify-default.test.ts` get modified (subscriber path tests deleted; mailbox path tests added). Existing `notify-relay.test.ts` rewritten in-place.

### 10.3 Acceptance criteria for the final PR

- [ ] All existing test files (except deleted subscribe-broadcast tests) pass
- [ ] New mailbox + notify-relay tests cover all 7 risk-mitigation rows
- [ ] E2E smoke evidence: bounce daemon mid-task, event arrives in captain pane after reconnect
- [ ] cmux integration test shows hidden split-pane created (OR fallback documented)
- [ ] Issues #113, #114, #115 explicitly reference this PR in their body as foundation
- [ ] `cockpit doctor` still passes (no new failures introduced)
- [ ] Live verification: spawn claude crew on cockpit, `signal done`, captain pane shows `CREW DONE [claude/<id8>]: ...` within ~1s, no daemon bounce required

---

## 11 · Open questions (resolve during plan or first task)

1. **Subscriber name as flag vs hardcoded `captain`** — Spec recommends `--as captain` from day 1 (forward-compatible for telegram/dashboard). Trivial to implement; just makes a future Telegram PR cleaner. **Decided: implement as flag.**
2. **Rotation thresholds in config vs constants** — Spec recommends config with the documented defaults. Adds ~10 lines of config schema. **Decided: config with defaults.**
3. **`spawnInjector` placement on non-cmux runtimes** — Orca/Zed don't exist yet. **Decided: defer to first runtime author.** Spec says "runtime's choice for hidden."
4. **Append-before vs after `store.put`** — Recommend AFTER (state must be durable before notifying). The current `firePush` gate already runs after `store.put`; **maintain that ordering**.
5. **`fs.watch` vs chokidar vs polling-only** — Recommend `fs.watch` with chokidar as fallback IF macOS fs.watch proves unreliable. Add a 1-second poll fallback regardless. **Decided: try fs.watch first; poll fallback always present.**

---

## 12 · Cross-references & follow-ups

- **Closes**: #113 (replay-on-reconnect — by construction).
- **Foundation for**: #114 (hybrid codex), #115 (opencode wiring). Each issue's body should reference this spec.
- **Replaces machinery from**: PR #110 (notify firing path stays; delivery mechanism replaced), PR #112 (subscribe-broadcast + visible tab — both replaced).
- **Preserves**: PR #98 (codex app-server for headless), PR #108 (claude through daemon — its hook bridge feeds the mailbox now).
- **Cooperates with**: #107 (reactor deletion — separate cleanup, no interaction needed).
- **Follow-up spec**: dashboard derived from mailbox (when there's demand).
- **Follow-up spec**: Telegram subscriber (#65 — when re-prioritized) — implements as a second cursor in the existing schema.

---

## 13 · Implementation phasing summary

| Phase | Branch | What ships | Mergeable on its own? |
|---|---|---|---|
| Single PR | `feature/mailbox-injector` | 4 commits: mailbox.ts (NEW) → daemon switchover → notify-relay rewrite → RuntimeDriver hidden split | Yes. Each commit keeps end-to-end working (except commit 2's brief bridge state, healed by commit 3 in same PR). |

No multi-phase rollout. Atomic shipment with a single PR validation cycle.

---

## 14 · Success criterion

A captain spawns a Claude crew. The crew completes its work and runs `cockpit crew signal done --message "<summary>"`. **Within ~1 second the captain's pane shows a line `CREW DONE [claude/<id8>]: <summary>` — auto-pushed by the daemon-mailbox-injector pipe, without the captain polling, without a visible `notify-relay` tab cluttering the workspace.** The same captain bounces the daemon, spawns another crew, signals done — and the second line still arrives, this time delivered after the injector resumes from its persisted cursor across the daemon bounce. Issues #113 closes by construction; #114 and #115 each ship as small PRs that mount onto this foundation.
