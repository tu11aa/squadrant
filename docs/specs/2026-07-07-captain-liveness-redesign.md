# Captain Liveness Redesign — hybrid ground-truth (runtime-preferred + squadrant-owned persistence)

**Status:** Design (approved in brainstorm 2026-07-07/08; all §11 facts verified)
**Owner:** research side-session → primary captain for implementation
**Related:** #333 (LifecycleSource port), #517 (stopped captain misclassified as alive), #520 (daemon launch no-op), #519 (dashboard live logs)

---

## 1. Problem

Captain liveness is **sweep-based, stale, and volatile**, and it is the *only* component not on the
event-driven lifecycle path crews already use. Verified in source:

- `delivery-loop.ts` sweeps `cmux.findWorkspaceId(captainTitle)` → `listSurfaces` →
  `discoverCaptainSurface` with an **exact pane-title match** (`s.title === captainTitle`), debounced
  by `captainMissingStreak` (K=3) before adding to `stoppedProjects`.
- `start.ts:106` collapses that into `captainStopped = stopped ? true : streak===0 ? false : null`;
  `liveness.ts projectHealth` maps it to `alive | stopped | unknown` (captains never report `gone`).
- `telegram/control.ts createIsCaptainAlive` reads this **cached** health via the daemon `health`
  IPC — so the boot-if-down probe inherits the staleness.

Three defects, all the same root cause:

1. **False negative** — pane `title` drifts from `captainName`, or a transient sweep miss →
   spurious "❌ couldn't reach".
2. **False positive (#517, worse)** — user closes the captain, then Telegram-messages within the K=3
   window → `isAlive` still returns `alive` → daemon replies "📨 delivered" and **never launches** →
   the message drops into a mailbox no live captain reads. Proven in daemon logs.
3. **Restart wipes everything** — `captainMissingStreak` + `stoppedProjects` are `new Map()`/`new
   Set()` on boot (`context.ts:183-184`). Any daemon restart (reboot, upgrade, rebuild) resets every
   captain to `unknown`/streak-lost until the next sweep re-learns it. Very likely the deepest cause
   of the always-wrong dashboards.

**Dashboard divergence** (verified): the **web** dashboard (`read-status.ts`) doesn't consume the
health source at all — it derives state from the task `list` IPC and only shows `offline` when that
call *throws*. The **pane/CLI** health (`health-view.ts`) reads `health` → `projectHealth` and shows
the stale streak. Two code paths → they disagree.

## 2. Goals

1. **Close detection works for every method** and flips status to offline/dead: (a) `squadrant …
   close` CLI, (b) cmux workspace **X**, (c) cmux **app** quit, (d) captain **tab** X.
2. **Open/registration works for every method**: `launch`, dispatch, Telegram auto-launch, manual
   workspace open.
3. **Both dashboards** show correct real-time status from **one** health source.
4. **Survive daemon restarts** — status correct *immediately* after any restart.

## 3. Non-goals

- No captain **heartbeat** protocol (YAGNI — pid liveness already answers "is it breathing").
- No change to the **crew** lifecycle path beyond additive field extension (§4.4).
- Not implementing `runtime.liveness()` for non-cmux runtimes in this pass — the seam is defined so
  they can, but cmux is the only implementation now (§5.4).

## 4. Design

### 4.1 Hybrid source model — runtime-preferred, squadrant-owned persistence

The verified insight (probe on the real brove-mobile captain): **the runtime's own session store is
authoritative ground-truth** and, being a *file*, it already survives daemon restarts and cleanly
distinguishes user-close from crash (§7). So we prefer it when present — but we do **not** couple the
core to cmux, and we do **not** lose liveness for future runtimes. Two layers:

```
        ┌─────────────────────────────────────────────────────────────┐
        │  Squadrant Liveness Registry   (core-owned, persisted)        │
        │  <stateRoot>/liveness.json  —  survives daemon restart        │
        │  entry: { project, role, pid, sessionId, startedAt,           │
        │           lastState, lastSeenAt, source }                     │
        └───────────▲───────────────────────────▲─────────────────────┘
                    │ authoritative (when present)│ populated directly
        ┌───────────┴──────────────┐   ┌──────────┴──────────────────────┐
        │ RuntimeDriver.liveness() │   │ lifecycle reports + pid floor    │
        │  cmux impl: read/watch   │   │  claude hook (ppid), codex        │
        │  ~/.cmuxterm/*.json      │   │  app-server, opencode SSE,        │
        │  → §7 stopped/gone free  │   │  headless child.pid, kill(pid,0)  │
        └──────────────────────────┘   └───────────────────────────────────┘
             preferred on cmux              fallback / other runtimes
```

- **`RuntimeDriver.liveness()` — new optional seam.** Each runtime driver may expose ground-truth
  liveness. The **cmux** driver implements it by reading/watching the store file. The core depends
  only on this **interface**, never on cmux directly — the cmux-coupling lives in the cmux driver,
  which is its entire purpose. Other runtimes return `undefined` for now.
- **Squadrant Liveness Registry — always-on, core-owned, persisted.** The single unifying source of
  truth the daemon reads. On cmux it is kept in sync **from** `runtime.liveness()` (cmux is
  authoritative). Where a runtime has no liveness view, the registry is populated directly by
  lifecycle reports + the pid floor. Persisted to `<stateRoot>/liveness.json` (atomic write) so it
  **outlives the daemon** — solving goal 4 for every runtime, not just cmux.

This is exactly the user's decision: *use cmux's ground-truth when on cmux; otherwise squadrant owns
liveness itself — achieving cmux's "beauty" while staying ready for new runtimes.*

### 4.2 The registry entry — disjoint field ownership, one derivation

Two signals own **different fields** on one entry, so they can never write conflicting values.

```
LivenessEntry {              // persisted; reconstructed/reconciled on boot (§5.3)
  project:   string
  role:      "captain" | "crew" | "command"
  pid:       number | null   // from runtime.liveness() (cmux store) OR hook ppid OR child.pid
  sessionId: string
  startedAt: number
  lastState: "start" | "end" // intent: open vs clean-close
  lastSeenAt:number
  pidAlive:  boolean         // written ONLY by the pid floor (kill(pid,0))
  source:    "runtime" | "agent" | "scan"   // provenance (see 4.3)
}
```

| Axis | Owner | Fields |
|---|---|---|
| **Presence / intent** — opened? cleanly closed? | `runtime.liveness()` (authoritative) or hooks | `pid`, `startedAt`, `lastState`, `sessionId` |
| **Liveness** — process breathing? | **pid floor** (`kill(pid,0)`, per tick) | `pidAlive` only |

State is a **read-only derivation** (first match wins — order matters):

```
no entry (never registered this session) ...... unknown
entry & lastState = "end" ..................... stopped   // clean close; magenta, not a fault
entry & pidAlive = false ...................... gone      // pid dead, record lingered → crash; red
entry & pidAlive = true ....................... alive
```

**Absent runtime record ≠ deleted entry.** When `runtime.liveness()` stops returning a captain that
was registered (user closed workspace/tab → cmux removed the store record), the reconcile step sets
that entry's `lastState = "end"` (→ `stopped`) — it does **not** drop the entry. This is exactly why
squadrant owns persistence: it remembers "this captain was here and cleanly closed" (`stopped`, calm)
rather than forgetting it (`unknown`). An entry is only truly absent → `unknown` when the captain was
never registered this session, or was long-since reaped.

### 4.3 Reconciliation — the non-conflict rule (extends `reduceLifecycle`)

Provenance precedence, mirroring the existing `origin` tie-break in `lifecycle-source.ts`:

**`runtime` (ground-truth) ≥ `agent` (hook) > `scan` (pid floor).**

- `runtime.liveness()` on cmux is authoritative for presence + intent: **record absent → `stopped`**,
  **record present + pid dead → `gone`** (probe-proven, §7). No hook needed on cmux.
- The pid floor (`scan`) is **liveness-only** — it may set `pidAlive=false` (→ `gone`/down) but may
  never assert presence or intent over a `runtime`/`agent` signal.
- **Monotonic tie-break:** `pidAlive=false` overrides a stale `alive`; a dead pid is only revived by
  a **newer** open signal (new pid, newer `startedAt`). No oscillation. **← #517 impossible.**
- **cmux vs squadrant registry never disagree destructively:** the registry *mirrors*
  `runtime.liveness()` on cmux (cmux wins by precedence); off cmux it is fed by hooks + floor. The
  two are reconciled by the same last-writer-by-provenance rule — one source is authoritative per
  axis at any time.

### 4.4 New `component`/`role` field (debuggability; do NOT overload `origin`)

`role` (component) and `source`/`origin` are **orthogonal axes**. Keep `origin: "agent" | "scan"`
in the shared crew `reduceLifecycle` **unchanged** (add `"runtime"` as a new authoritative peer of
`agent`), and carry `role: captain|crew|command` additively. Logs get the full cross-product:

```
[captain/runtime] cmux record present pid=41030 → alive
[captain/scan   ] pid 41030 dead, record lingers → gone      // crash
[captain/runtime] cmux record absent → stopped               // user closed workspace/tab
[crew/agent     ] notification → needsInput
```

### 4.5 Ground-truth-on-demand for the Telegram probe

`createIsCaptainAlive` (`telegram/control.ts`) must resolve **fresh at call time** — never the cached
streak: consult `runtime.liveness()` (or the registry + a live `kill(pid,0)`).

- captain present & pid alive → `alive`
- absent, or pid dead → **not alive** → boot-if-down launches (idempotent).

Direct #517 fix: the daemon can never claim "delivered" to a dead captain.

## 5. Coverage — proving the goals

### 5.1 Close (goal 1) — §7 resolved by probe (real brove-mobile captain)

| Method | Runtime record | pid | Result |
|---|---|---|---|
| (a) `squadrant … close` CLI | removed (also `lastState=end`) | dead | `stopped` |
| (b) cmux workspace **X** | **removed** | dead | `stopped` |
| (c) captain **tab** X (workspace kept by a sibling crew) | **removed** | dead | `stopped` |
| (d) crash (`kill -9`) | **lingers** (`isRestorable=true`) | dead | `gone` |
| (e) cmux **app** quit | removed with the app | dead | `stopped` |

The pid floor is the universal liveness-catcher; **runtime-record presence is the intent
discriminator** — no SessionEnd hook required on cmux. (App-quit (e) inferred from (b)/store
teardown; not re-tested to avoid killing the operator's own session.)

### 5.2 Open (goal 2)

Every open path starts a claude session inside a cmux workspace → cmux writes the store record →
`runtime.liveness()` surfaces it → the registry registers the captain. **Correlation key = the
launch-template fingerprint** (`--append-system-prompt-file` basename): `captain.claude.md` ⇒
captain, `crew.claude.md` ⇒ crew, `side.research.claude.md` ⇒ side. `cwd` alone is ambiguous
(captain + side-session share `cwd` *and* `workspaceId` — observed live); project is derived from
`cwd`/`workingDirectory`. Covers `launch`, dispatch, Telegram auto-launch, and manual open uniformly.
Edge: a hibernated session can have `pid: null` (observed) → "record present ⇒ alive-unknown" until a
real pid appears.

Off cmux (future runtimes): the open signal arrives via that runtime's lifecycle source (hook /
app-server / SSE), populating the registry directly.

### 5.3 Restart survival (goal 4)

`liveness.json` is persisted on every registry mutation (atomic write). On **daemon boot**:
1. Load `liveness.json` → seed the in-memory registry.
2. Reconcile against `runtime.liveness()` for each cmux project (authoritative — corrects anything
   that changed while the daemon was down: captain closed → record absent → mark `lastState="end"`
   (`stopped`), keep the entry; still running → refresh pid).
3. pid floor confirms liveness on the first tick.

Correct within one tick of any restart, for cmux *and* future runtimes (the file outlives the daemon
regardless of whether the runtime's own store does).

### 5.4 `RuntimeDriver.liveness()` seam

```ts
interface RuntimeDriver {
  // …existing…
  liveness?(): Promise<RuntimeLivenessRecord[]>;   // optional; cmux implements, others return undefined
}
interface RuntimeLivenessRecord {
  role: "captain" | "crew" | "command" | "unknown";  // from launch-template fingerprint
  project: string;                                    // from cwd / workingDirectory
  pid: number | null;
  sessionId: string;
  present: boolean;          // record exists in the store
  isRestorable?: boolean;    // lingering-after-crash hint
}
```

cmux impl: read/watch `~/.cmuxterm/*-hook-sessions.json`; the record is rich (`pid`, `isRestorable`,
`workspaceId`, `surfaceId`, `launchCommand.arguments` incl. cwd) — everything needed. Watch via
`fs.watch` (reuse `CmuxStoreSource`; extend its `StoreSession` schema to read `launchCommand` +
`workspaceId`).

## 6. Dashboards (goal 3) — one source

Registry → `projectHealth` → **one `health` IPC** → both consumers.

- **Pane/CLI** (`health-view.ts`): already reads `health`. Fix is **upstream only** — `start.ts`
  derives captain `HealthState` from the registry instead of the streak. Zero renderer changes.
- **Web** (`read-status.ts`): must **also** read `health`. **Precedence:** captain liveness dominates
  task activity — `gone`/`stopped` → row offline regardless of leftover tasks; `alive` → fall back to
  task-derived `busy`/`blocked`/`idle`.

## 7. State vocabulary (D1) — resolved

**Reuse existing `HealthState` values — no new enum member.** The `stopped`↔`gone` discriminator is
**runtime-record presence + a `kill(pid,0)` check** (probe-proven, §5.1), not SessionEnd:

- runtime record **absent** (or `squadrant close` / `lastState=end`) → **`stopped`** (magenta, calm;
  honors #324 "never red-alarm an expected shutdown")
- runtime record **present but pid dead** → **`gone`** (red fault — a crash)
- pid alive → `alive`; never registered → `unknown`

Off cmux, where there is no runtime record: intent comes from SessionEnd/close-CLI (`lastState`), else
abrupt-death defaults to `gone`.

## 8. Affected code (run `gitnexus_impact` before editing each)

| Area | File | Change |
|---|---|---|
| **Registry + persistence** | new `packages/core/src/daemon/liveness-registry.ts` | core-owned registry; load/save `<stateRoot>/liveness.json` (atomic); boot reconcile (§5.3) |
| Daemon context | `packages/core/src/daemon/context.ts` | replace `captainMissingStreak` + `stoppedProjects` with the registry |
| Health projection | `packages/core/src/daemon/start.ts` | derive captain `HealthState` from the registry; drop streak logic |
| Liveness types/derivation | `packages/core/src/liveness.ts` | pure derivation (4.2) + reconciliation (4.3); testable |
| Runtime seam | `packages/workspaces/src/runtimes/types.ts` (+ `cmux.ts`) | add `liveness()` to the driver interface; **cmux** impl reads/watches the store, keyed by template fingerprint |
| cmux store reader | `packages/workspaces/src/cmux-daemon/cmux-store-source.ts` | extend `StoreSession` to read `launchCommand`/`workspaceId`/`surfaceId`; expose captain/crew/side by fingerprint |
| Delivery loop | `packages/core/src/daemon/delivery-loop.ts` | remove title-sweep authority; add pid floor per tick |
| Component field | `packages/core/src/lifecycle-source.ts` | add `role` + `source:"runtime"` (additive; `agent`/`scan` unchanged) |
| Telegram probe | `packages/core/src/telegram/control.ts` | `createIsCaptainAlive` → fresh ground-truth at call time (#517 fix) |
| Web dashboard | `packages/web/src/read-status.ts` | consume `health`; captain-liveness precedence |

## 9. Testing

- **Pure derivation/reconciliation** (`liveness.ts`): the 4 states + `runtime≥agent>scan` precedence
  + pid-dead-beats-stale-alive + monotonic revive. No I/O.
- **Persistence**: registry survives a simulated restart (save → new instance → load → reconcile).
- **Ground-truth-on-demand**: `isCaptainAlive` false for dead pid / absent record; boot-if-down
  launches. Regression for #517.
- **Close matrix**: the 5 rows of §5.1 → correct `stopped` vs `gone`.
- **cmux liveness()**: template-fingerprint correlation distinguishes captain/crew/side sharing
  cwd+workspace; `pid:null` hibernation edge.
- **Dashboard parity**: web + pane derive the same captain state from one `health` reply.
- **All lifecycle/close/crash tests run on a throwaway TEST project** — never a real captain (a probe
  on the real brove-mobile captain destroyed its in-flight session on 2026-07-07).
- Agent-parity: verify cmux path now; codex/opencode `liveness()` are follow-ups.

## 10. Rollout / risk

- **Blast radius:** the `health` IPC shape is unchanged (`ComponentHealth[]`) — consumers keep
  working. Run `gitnexus_impact` on `projectHealth`, `createIsCaptainAlive`, `discoverCaptainSurface`,
  `deliveryTick` before editing. No new `HealthState` value → no renderer churn.
- **Sequencing:** (1) registry + persistence + pure derivation + tests; (2) `runtime.liveness()`
  seam + cmux impl (open + §7 + restart reconcile); (3) pid floor per tick (crash→gone); (4) Telegram
  ground-truth-on-demand (#517); (5) web dashboard; (6) retire `captainMissingStreak`/`stoppedProjects`.
  Each independently testable.

## 11. Verification status — all §11 facts resolved

- **FACT 1 (§7 X-button) — RESOLVED** on the real captain: workspace-X and tab-X → record **removed**
  + pid dead (`stopped`); `kill -9` crash → record **lingers** `isRestorable=true` + pid dead
  (`gone`). Color rule derives from store-presence + `kill(pid,0)` alone — **no SessionEnd hook
  needed** on cmux.
- **FACT 2 (hooks)** — captain hooks are crew-only today (net-new). Not on the cmux critical path;
  hooks are the *off-cmux / future-runtime* population path (§4.1) and an optional fast-open
  corroborator.
- **FACT 3 (pid)** — cmux **CLI** exposes no pid, so the surface-query fallback is **dropped**; but
  the cmux **store record is rich** (pid, isRestorable, workspaceId, surfaceId, launchCommand incl.
  cwd) — the authoritative source. Same pid source interactive crews already rely on.
- **FACT 4 (`SQUADRANT_CAPTAIN_PROJECT`)** — not needed for cmux discovery (template fingerprint +
  cwd suffice). Only relevant if/when the off-cmux hook path is wired.
- **Dropped:** the "daemon restart cadence" investigation — the restarts were the user's manual
  rebuilds, not a crash-loop. The restart-*survival* requirement (§2.4 / §5.3) stays.
