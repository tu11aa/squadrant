# Design: driver-agnostic agent-lifecycle via a `LifecycleSource` port

**Date:** 2026-06-26
**Issue:** [#333](https://github.com/tu11aa/squadrant/issues/333)
**Status:** SIGNED-OFF (2026-06-26) — implementation proceeding per D1–D7 below
**Research dossier:** `docs/research/2026-06-16-cmux-agent-lifecycle-and-daemon-architecture.md` (archived to hub-vault in #370; recover from git `be3230c`)
**Related:** #328/#331 (claude event-bridge), #332 (daemon-direct, drop relay), #326 (compat backlog), #114 (native codex TUI + hooks), #329 (hibernation), #31 (multi-driver projection), #201 (codex first-turn hang)

> **Scope guard.** This is an architecture/tradeoff document. No source code changes are part of this deliverable. The TypeScript below is an *interface sketch* embedded for discussion, not a file to be written. The "DECISIONS NEEDING SIGN-OFF" section is the real payload — the captain and user will brainstorm those before any code lands.

---

## 1. Problem statement — today's lifecycle patchwork

Squadrant's daemon learns "is this crew running / idle / waiting for a human / dead?" through **three unrelated mechanisms, one per agent**, each with its own correlation key, all funnelled into the *same* `ControlEvent` pipeline (`ctx.d.handle({kind:"event", …})`). Plus a fourth, fragile, cmux-coupled fallback: screen-scraping.

| Agent | Mechanism (today) | Where | Correlation key | Normalized via |
|---|---|---|---|---|
| **claude** | cmux native `agent.hook.*` socket stream (one global `cmux events` subscription, durable `--cursor-file`) | `packages/workspaces/src/cmux-daemon/events-bridge.ts` (`CmuxEventsBridge`, `deriveRunState`) | **`cwd`** (unique worktree per crew) | `Stop`→`task.turn.completed`; `PreToolUse`/`UserPromptSubmit`→`task.progress` |
| **opencode** | HTTP SSE `/event` from `opencode --port N`, one subscription per crew | `packages/agents/src/opencode/sse-bridge.ts` (`OpencodeSseBridge`) | **`taskId`/`port`** | `session.idle`→`task.turn.completed`; `permission.asked`→`task.approval.requested` |
| **codex** | app-server JSON-RPC, one shared app-server, thread per crew | `packages/agents/src/codex/driver.ts` (`CodexInteractiveDriver`) | **`threadId`↔`taskId`** | `normalizeAppServerNotification` + serverRequest → `task.*` |
| **(fallback)** | TUI screen-scraping (~14 `read-screen` sites; regex `CC_WORKING_RE`, `classifyStartupSurface`) | `packages/workspaces/src/runtimes/cmux.ts` | surface text | string-classified |

### Why this hurts

1. **The "unified" path only fires for claude.** `CmuxEventsBridge` consumes cmux's `agent.hook.*`. cmux auto-wraps **only claude** (PATH-shim `cmux-claude-wrapper`); codex/gemini/opencode require `cmux hooks setup <agent>`, which is **not installed on this machine** (verified: only `~/.cmuxterm/claude-hook-sessions.json` exists). So the bridge that *looks* general is claude-only.

2. **Three correlation keys, three failure modes.** `cwd` collides if two crews ever share a worktree (we've seen non-isolated worktrees — see memory `crew_worktree_not_isolated`); `port`/`taskId` is clean but opencode-only; `threadId` is clean but codex-only. There is no single, stable identity for "this crew's process".

3. **The most-coupled path is load-bearing.** `agent.hook.*` is cmux's *internal* event wire — the least stable contract cmux exposes. The daemon exists specifically so lifecycle survives a terminal-driver swap; today claude lifecycle would die the moment cmux is replaced.

4. **Screen-scraping is still in the hot path.** ~14 `read-screen` sites with TUI-shape regexes are the fallback for turn-end/working detection. They are brittle (the #292 "shell still running" misread), cmux-specific, and the reason `cmux.ts` is 589 lines of pane heuristics.

5. **No shared liveness layer.** "Is the process actually alive?" is answered ad hoc (codex staleness window in `shouldReattachCodex`, opencode stream-end, claude has none). There is no normalized `running|idle|needsInput|unknown` state that the watchdog, Telegram tiers, and hibernation all read from.

**Goal:** one port — `LifecycleSource` — that normalizes all agents into the same 4-state lifecycle, behind which today's three mechanisms become *adapters*, the cmux-store file becomes the cheap ship-now adapter, and a cockpit-owned native-hook implementation becomes the driver-agnostic core that survives a cmux swap.

---

## 2. The `LifecycleSource` port

### 2.1 The normalized 4-state model

Adopt cmux's exact lifecycle vocabulary (from the source dive — `AgentHibernationLifecycleState.swift`):

```
running     — a turn is live (prompt submitted, tool executing, model thinking)
idle        — turn ended; crew alive and quiescent, awaiting next input
needsInput  — blocked on a human (permission / approval / direction)
unknown     — process detected (alive) but no lifecycle signal yet
```

These are the *internal* lifecycle states. They map onto the **existing** `ControlEvent` union (`packages/shared/src/types/control.ts`) — the port does **not** introduce a parallel event vocabulary; it produces the same events the three bridges already emit:

| LifecycleState transition | Emitted `ControlEvent` | Reducer effect (existing) |
|---|---|---|
| → `running` | `task.progress` (liveness refresh, carries tool name) / `task.started` | keeps liveness clock fresh; un-stalls (#292) |
| → `idle` | `task.turn.completed` | → `awaiting-input` |
| → `needsInput` (approval) | `task.approval.requested` | → `blocked` + gate promotion |
| → `needsInput` (direction) | `task.input.requested` | → `blocked` |
| process gone (liveness) | `task.session.ended` | → reconcile / terminal (NOT completion — anti-#2576) |

> **Anti-#2576 invariant preserved.** Lifecycle signals are *liveness*, never *completion*. Terminal `done`/`blocked`/`failed` still comes only from the explicit `squadrant crew signal`. The reducer already absorbs duplicate/late `task.turn.completed` and `task.progress` idempotently, and a blocked crew stays blocked — so feeding from multiple sources is safe.

### 2.2 Event-driven vs poll — reconciled, not chosen

The three mechanisms are heterogeneous: SSE and app-server are **push**; the cmux-store file is **watch-on-change** (push-ish) plus **periodic pid-verify** (poll); a process scan is **poll**. Forcing one paradigm is wrong. The port models **both**, with a clear rule:

- **Push is primary** — an agent that reports an explicit transition is authoritative.
- **Poll is the liveness floor** — a low-frequency sweep (process-alive + quiescence) that can only ever produce `running`(weak)/`unknown`/dead. **A poll/scan can never assert `needsInput`** — that is hook-only (the source dive's hard rule: hook-less fallback gives "alive + quiescent", never "waiting for a human").

This is encoded as the **`origin` discriminator** on every snapshot (`"agent"` vs `"scan"`) and the **"explicit agent update wins"** reducer rule (from `FeedCoordinator.swift`): an explicit agent state always overrides an inferred scan state; `needsInput` only relaxes to `running` on the next agent-originated `running` (prompt-submit).

### 2.3 Interface sketch (for discussion — not a file to write)

```ts
// ── normalized lifecycle vocabulary ───────────────────────────────────────
export type LifecycleState = "running" | "idle" | "needsInput" | "unknown";

/** One observation about one crew, from one source. */
export interface LifecycleSnapshot {
  taskId: string;
  state: LifecycleState;
  /** Liveness layer: is the OS process actually alive? (pid-verified) */
  alive: boolean;
  /**
   * Provenance — the reconciler's tie-breaker. "agent" = an explicit hook /
   * SSE / app-server transition (authoritative). "scan" = inferred from a
   * process/file sweep (liveness only; may NOT assert needsInput).
   */
  origin: "agent" | "scan";
  /** Monotonic stamp for last-writer reconciliation across sources. */
  at: number;
  pid?: number;
  /** Optional human detail (lastBody, tool name) for surfacing CREW BLOCKED. */
  detail?: { note?: string; tool?: string; reason?: string };
}

/** What the daemon hands every source: how to correlate + where to report. */
export interface LifecycleSourceDeps {
  /**
   * Map a raw signal back to its owning crew TaskRecord, or undefined.
   * The daemon supplies this from the store (non-terminal interactive records).
   * Sources pass whatever identity they have; the resolver tries them in
   * priority order (see §2.4). Keeping it injected keeps each source testable.
   */
  resolve(hint: CorrelationHint): { id: string } | undefined;
  /** Normalized observation → reducer → ControlEvent. */
  report(snap: LifecycleSnapshot): void;
  log?(msg: string): void;
}

export interface CorrelationHint {
  taskId?: string;   // strongest — SQUADRANT_CREW_TASK_ID from process env
  pid?: number;
  cwd?: string;      // weakest — collides if a worktree is shared
  sessionId?: string;
}

/** The port. Each adapter implements start/stop; push sources call deps.report
 *  on transition; poll sources additionally expose snapshot() for the sweep. */
export interface LifecycleSource {
  readonly name: string;                 // "cmux-store" | "native-hook" | "codex-appserver" | "opencode-sse"
  start(deps: LifecycleSourceDeps): void;
  stop(): void;
  /** Poll hook — optional. Returns current liveness for a known crew, or
   *  undefined if this source has no view of it. Drives the liveness floor. */
  snapshot?(taskId: string): LifecycleSnapshot | undefined;
}

// ── the one reducer all sources feed ──────────────────────────────────────
/** Pure. Reconcile a new snapshot against the crew's last known state.
 *  Rules (from cmux FeedCoordinator): explicit agent wins over scan; needsInput
 *  only relaxes to running on an agent-originated running; a scan may downgrade
 *  liveness (alive=false → session.ended) but may NOT set needsInput. */
export function reduceLifecycle(
  prev: LifecycleSnapshot | undefined,
  next: LifecycleSnapshot,
): LifecycleState { /* … see §2.2 rules … */ }
```

### 2.4 Correlation priority (single rule, replacing three ad-hoc keys)

The resolver tries, in order:

1. **`SQUADRANT_CREW_TASK_ID`** — set on every crew's launch line today (claude/opencode shell env; codex via `developerInstructions`). This is the *only* collision-proof key. The `NativeHookSource` (§4) reads it directly from the target process via `KERN_PROCARGS2`; hooks can echo it back in their payload.
2. **`pid`** — for sources that report a pid (cmux-store carries it; process scan owns it).
3. **`cwd`** — the current claude path; kept as a *fallback only*, flagged as collision-prone.
4. **`sessionId`/`threadId`** — source-internal, mapped to taskId inside the adapter (codex already does this).

> The issue/dossier predate the rebrand and say `COCKPIT_CREW_TASK_ID`; the live env var is **`SQUADRANT_CREW_TASK_ID`** (set automatically on crew spawn). This doc uses the current name.

---

## 3. Implementation A — `CmuxStoreSource` (ship-now adapter)

**What:** A `LifecycleSource` that watches `~/.cmuxterm/<agent>-hook-sessions.json` (override `CMUX_AGENT_HOOK_STATE_DIR`), reads each session's `agentLifecycle`, and pid-verifies liveness itself.

**Why first:**
- **16 agents for free.** cmux already installs native hooks for codex, gemini, opencode, cursor, copilot, … (the full matrix). The moment `cmux hooks setup <agent>` runs, that agent's lifecycle appears in its store file. We get accurate `running|idle|needsInput` for the whole matrix without writing a single per-agent template.
- **Stable contract.** The store file is `version:1`, durable, and the dossier confirms it's the *intended external-consumer surface* (the socket stream is internal/less-stable). Far better than scraping `agent.hook.*` off the wire.
- **Matches live reality.** This is the file the daemon can already read directly (cmux socket is reachable from any process since 0.64.16 — the #332 premise).

**Shape (grounded in the captured schema):**

```jsonc
// ~/.cmuxterm/claude-hook-sessions.json (live schema, version:1)
{
  "sessions": {
    "<sessionId>": {
      "agentLifecycle": "running|idle|needsInput|unknown",
      "pid": 12345, "cwd": "/…/worktree", "sessionId": "…",
      "lastBody": "Claude needs your permission", "lastSubtitle": "Permission",
      "launchCommand": { "environment": { /* SQUADRANT_CREW_TASK_ID lives here */ } },
      "updatedAt": "…"
    }
  },
  "activeSessionsBySurface": { /* … */ }
}
```

**Mechanics:**
- `fs.watch` the directory (debounced) → on change, re-read each agent's store file.
- For each session: `resolve()` via `launchCommand.environment.SQUADRANT_CREW_TASK_ID` → `pid` → `cwd`.
- `pid`-verify (`process.kill(pid, 0)`) → set `alive`. A session whose pid is dead → `alive:false` → `task.session.ended` (reconcile).
- Map `agentLifecycle` → `LifecycleSnapshot{ origin:"agent" }` → `report()`.
- `snapshot(taskId)` reads the cached store state for the poll/liveness floor.

**Cost / con:** cmux-coupled — the file vanishes if cmux is swapped out. That's acceptable **because it sits behind the port**: swapping the driver swaps the source, not the daemon's lifecycle logic. It is the cmux *adapter*, explicitly not the core.

**What it lets us delete:** the claude-only `CmuxEventsBridge` socket subscription (§5), and — once proven across claude+opencode — the screen-scraping fallback in `cmux.ts`.

---

## 4. Implementation C — `NativeHookSource` (driver-agnostic core)

**What:** Squadrant installs its **own** hooks into each agent's native config (mirroring cmux's `AgentHookDef` matrix), routed to the daemon via a new daemon subcommand:

```sh
squadrantd hooks <agent> <sub>     # e.g. squadrantd hooks claude stop
                                   #      squadrantd hooks codex prompt-submit
```

plus a **`SQUADRANT_CREW_TASK_ID`-keyed `KERN_PROCARGS2` process scan** (libproc + `sysctl`) for the liveness floor, plus an **OSC turn-end hint** as a universal, driver-independent "a turn probably ended" nudge.

**Why it's the core:** it depends on nothing cmux-specific. Hooks live in the agent's *own* config (`~/.codex/hooks.json`, `~/.gemini/settings.json`, `~/.config/opencode/plugins/…`, claude `--settings`), so lifecycle survives a cmux swap entirely. This is the implementation that fulfils the daemon's whole reason to exist.

**Per-agent native install matrix** (mirror cmux's, but pointing at `squadrantd hooks`):

| Agent | Native file | Events → state | Disable env |
|---|---|---|---|
| claude | per-launch `--settings` (shim) | SessionStart/UserPromptSubmit/PreToolUse→running; Stop→idle; Notification/PermissionRequest→needsInput; SessionEnd→teardown | `SQUADRANT_CLAUDE_HOOKS_DISABLED=1` |
| codex | `~/.codex/hooks.json` + `config.toml` (`codex_hooks=true`) | SessionStart/UserPromptSubmit→running; Stop→idle; PreToolUse/PermissionRequest→needsInput | `SQUADRANT_CODEX_HOOKS_DISABLED=1` |
| gemini | `~/.gemini/settings.json` | SessionStart/BeforeAgent→running; AfterAgent→idle; SessionEnd | `SQUADRANT_GEMINI_HOOKS_DISABLED=1` |
| opencode | `~/.config/opencode/plugins/squadrant-session.js` | SDK plugin event bus | `SQUADRANT_OPENCODE_HOOKS_DISABLED=1` |

**Mechanics:**
- Each hook invocation is a fire-and-forget shell call that never blocks the agent: `squadrantd hooks <agent> <sub> || true`. The daemon receives it (over its existing control socket), reads `SQUADRANT_CREW_TASK_ID` from the hook's env/argv, and `report()`s an `origin:"agent"` snapshot.
- The **`KERN_PROCARGS2` scan** enumerates live PIDs, reads each argv+env, and binds process↔crew by matching `SQUADRANT_CREW_TASK_ID`. Yields `alive` + identity only → `origin:"scan"`, never `needsInput`. This is the liveness floor and the *only* thing that detects a crew whose hooks failed to fire.
- **OSC turn-end hint:** the terminal emits an OSC sequence at turn boundaries we can observe driver-independently; treated as a *weak* `idle` hint (`origin:"scan"`), confirmed/overridden by the next agent hook. Belt-and-suspenders for agents whose hook matrix is incomplete.

**Cons / risks (must be designed for):**
- **Reimplements cmux's installer + per-agent template matrix.** This is real work, done incrementally per agent.
- **Double-hook collision.** If both cmux and squadrant install codex hooks, both fire. Mitigation: namespace squadrant's hooks and make the reducer idempotent (it already is), OR detect cmux's hook presence and defer to `CmuxStoreSource` for that agent. (See decision D4.)
- **Codex hook trust.** codex requires persisted hook trust (or the `--dangerously-bypass-hook-trust` flag, which the user rejects on principle — memory `never_skip_dangerous_permissions`). Need to find how codex persists hook trust and trust squadrant's hook once at setup. (See decision D5; ties to #114.)

---

## 5. Migration plan

The refactor is **incremental and additive** — at no point is the daemon without a working lifecycle path. Phase ordering follows the signed-off D1 decision: **C (`NativeHookSource`) is primary; A (`CmuxStoreSource`) ships as redundancy.** See § 6 for the signed-off decisions that shaped this plan.

**Phase 0 — scaffold interface + reducer + research hook mechanism (no behaviour change).**
Define `LifecycleSource`, `LifecycleSnapshot`, `reduceLifecycle`, and a `LifecycleReconciler` in `@squadrant/core` that fans `report()` into the existing `ctx.d.handle` pipeline. Wire the three existing bridges (`CmuxEventsBridge`, `OpencodeSseBridge`, `CodexInteractiveDriver`) to emit through it *unchanged in behaviour* — they become the first three adapters. This is the seam; everything downstream (reducer, watchdog, Telegram tiers) keeps working. **Concurrently:** research cmux's `AgentHookDef` installer matrix (`CMUXCLI+AgentHookDefinitions.swift`, per-agent template shape, the `squadrantd hooks` subcommand design) to ground Phase 1 before implementation begins.

**Phase 1 — build C (primary, mimic cmux) + A (backup) + codex app-server wrapper.**
Build `NativeHookSource` (C) mirroring cmux's proven hook mechanism, targeting claude first. Run alongside existing `CmuxEventsBridge`; the reducer absorbs duplicates idempotently. Concurrently ship `CmuxStoreSource` (A) as backup/redundancy — one file-watcher on `~/.cmuxterm/*-hook-sessions.json` + pid-verify, covering whichever agents have `cmux hooks setup` configured. Wrap the existing codex app-server driver as a `LifecycleSource` adapter (mechanism unchanged — see D5). Once C proves parity on claude crews, **retire `CmuxEventsBridge`** (the #328/#331 socket subscription).

**Phase 2 — parity + cleanup (deprecate scraping, retire relay when proven).**
With C proving lifecycle for claude and A + app-server covering opencode/codex: **deprecate-in-place** the ~14 `read-screen` lifecycle sites in `cmux.ts` — mark `@deprecated`, leave as safety net; do **not** delete in this phase (see D3). Retire the relay-proxy fallback on the same parity gate once C + A are stable in production across all agents (see D7; **not in v0.13.0**). File the 'retire screen-scraping' follow-up issue. Keep delivery-time read-screen (#258/#302 defer-while-typing — input-box state, not lifecycle).

**Follow-ups post-v0.13.0:**
- Gemini lifecycle driver (gemini has no driver today; out of scope for #333).
- Persist/reconstruct schema if DEFER PERSIST (D6) proves insufficient at scale.
- Full screen-scraping deletion (gated on real-world stability — see D3).
- Full relay retirement if not completed in Phase 2 (see D7).

**Reconcile with #329 (hibernation).**
cmux hibernation reclaims RAM from `idle` crews (`allowsHibernation == idle`). A hibernated crew's pid may be gone or suspended while the crew is *logically alive*. The liveness floor must **not** emit `task.session.ended` for a hibernated-but-resumable crew. Rule: if the store/scan shows `idle` + `isRestorable` (cmux field) or a known resumeRef, treat as **alive-idle**, not dead. This is why the liveness layer is advisory (`origin:"scan"`) and never terminal on its own — terminal still needs an explicit signal or a confirmed process-gone-AND-not-restorable. Note hibernation is currently OFF by design (config doc: cmux 0.64.16 hibernation is global-only and would hibernate the captain), so this is a forward-compatibility rule, not a live concern yet.

**Reconcile with #31 (multi-driver projection).**
`LifecycleSource` slots cleanly under the existing **runtime** plugin seam (it's a property of the terminal/runtime driver, alongside cmux's `DaemonCmux`). `NativeHookSource` is runtime-independent and becomes the default for any runtime that lacks a native lifecycle adapter. `CmuxStoreSource` is the cmux-runtime's cmux-specific backup adapter; a future runtime ships its own equivalent. When both exist, the reducer resolves idempotently.

---

## 6. DECISIONS — SIGNED OFF 2026-06-26

All seven decisions were brainstormed and signed off on 2026-06-26. Decisions that reversed the original recommendation are marked ⚠️ **FLIPPED**.

### D1 — A-vs-C sequencing ⚠️ **FLIPPED**

**SIGNED-OFF (2026-06-26): C-PRIMARY, A-BACKUP.**
`NativeHookSource` (C) is the primary implementation — it mimics cmux's proven hook mechanism and is driver-agnostic by design. `CmuxStoreSource` (A) ships as backup/redundancy, watching `~/.cmuxterm/*-hook-sessions.json`. Both run under the same port; the reducer handles both idempotently.

*(superseded) Original recommendation: (a) A first, then C incrementally — A is cheap (one file watcher + pid-verify), accurate, and proves the port and reducer against real data before investing in the per-agent installer matrix.*

### D2 — Event-driven vs poll

**SIGNED-OFF (2026-06-26): HYBRID push + poll.**
C pushes via hook (primary); low-frequency poll reconciles stuck state (liveness floor). Push gives latency and `needsInput`; poll guarantees detection of a dead/hung crew when hooks fail silently. The `origin` discriminator + "explicit agent wins" reducer makes the two safe to combine. A poll/scan can never assert `needsInput` — that is hook-only.

*(original recommendation unchanged — option (a) confirmed)*

### D3 — Screen-scraping retirement timing ⚠️ **FLIPPED**

**SIGNED-OFF (2026-06-26): DEPRECATE-IN-PLACE.**
Keep the ~14 `read-screen` lifecycle sites in `cmux.ts` as a safety net — mark `@deprecated` in the code, **do not delete in v0.13.0**. Retire only after several stable production versions on C + A, gated on real-world stability (not a synthetic test phase). A follow-up 'retire screen-scraping' issue will be filed and left open. Keep delivery-time read-screen (#258/#302) — input-box state, not lifecycle.

*(superseded) Original recommendation: (a) Retire only after A proves parity for claude + opencode/codex, folded into the #332 PR — lowest risk; scraping and relay-proxy die in one motion.*

### D4 — Double-hook collision (cmux + squadrant both installed)

**SIGNED-OFF (2026-06-26): NAMESPACE + IDEMPOTENT hook install.**
Squadrant's hooks are namespaced and the installer is re-run-safe — it never clobbers pre-existing user hooks. The reducer already absorbs duplicates (anti-#2576). Both cmux and squadrant hooks can fire harmlessly; they write to separate stores and share no mutable state.

*(original recommendation unchanged — option (a) confirmed, re-run-safe emphasis explicit)*

### D5 — Codex under the port (ties to #114)

**SIGNED-OFF (2026-06-26): KEEP app-server for codex, wrapped as one `LifecycleSource`.**
Keep the existing codex app-server driver; wrap it as a `LifecycleSource` adapter. Unified at the port interface; mechanism unchanged. Revisit TUI + native hooks under #114 after the port exists.

*(original recommendation unchanged — option (a) confirmed)*

### D6 — Session persistence on daemon restart

**SIGNED-OFF (2026-06-26): DEFER PERSIST / RECONSTRUCT.**
No new persistence layer in v0.13.0. On daemon restart, reconstruct the live session set from the cmux store (`~/.cmuxterm/*-hook-sessions.json`) and live crew panes (analogous to `listCrewPanes`). Session identity is stable across all supported agents: claude exposes `session_id`, codex exposes `resume-id`, opencode exposes `ses_*`-prefixed IDs. Gemini has no driver (out of scope for #333). No standalone trust-handshake state was found in the codebase (verified).

*(superseded) Original D6 question: "Hook-trust handling for codex (no 'dangerously' flags)" — how squadrant gets its codex hook trusted without `--dangerously-bypass-hook-trust`. Deferred: codex stays on app-server (D5), making hook-trust a non-issue for v0.13.0. Re-evaluate when #114 (codex TUI + native hooks) is scoped.*

### D7 — Relay-proxy disposition (#332 boundary) ⚠️ **FLIPPED**

**SIGNED-OFF (2026-06-26): RETIRE RELAY IN PHASE 2, GATED.**
Verified: the relay main delivery path is gone as of #332, but a live fallback remains for opencode (`claude.ts:183`) and cmux-unreachable paths (`cmux-probe.ts`). Remove in Phase 2 once C + A prove stable in production across all agents, on the same parity gate as screen-scraping deprecation. **Not in v0.13.0.**

*(superseded) Original recommendation: (a) Fully retire relay-proxy in the #332 PR — daemon-direct is the delivery path; relay's reason to exist is gone once lifecycle moves to the port.*

---

## 7. Success criteria (for the eventual implementation, not this doc)

- One `reduceLifecycle` reducer; all agents produce `running|idle|needsInput|unknown` through the same port.
- claude lifecycle no longer depends on the `agent.hook.*` socket wire (moved to store-file adapter, then native hooks).
- The ~14 lifecycle `read-screen` sites in `cmux.ts` are deleted (delivery-time read-screen may remain).
- Correlation keys on a single priority chain headed by `SQUADRANT_CREW_TASK_ID`; no bare-`cwd` collisions.
- A crew whose hooks fail to fire is still detected alive/dead by the liveness floor.
- Lifecycle survives a hypothetical cmux swap once `NativeHookSource` covers an agent (verified by disabling the cmux store path and confirming native hooks still drive state).
- Hibernated-but-restorable crews never read as dead.

---

## Appendix — key source references

**Squadrant (this repo):**
- `packages/workspaces/src/cmux-daemon/events-bridge.ts` — claude `agent.hook.*` bridge, `deriveRunState`, cwd-resolve
- `packages/agents/src/opencode/sse-bridge.ts` — opencode `session.idle` / `permission.asked`
- `packages/agents/src/codex/driver.ts` — codex app-server driver, threadId↔taskId, `buildCodexDeveloperInstructions`
- `packages/workspaces/src/runtimes/cmux.ts` — screen-scraping (`CC_WORKING_RE`, `classifyStartupSurface`, ~14 `read-screen`)
- `packages/cli/src/squadrantd.ts` (≈83–134) — where the three bridges are wired into `ctx.d.handle`
- `packages/shared/src/types/control.ts` — the `ControlEvent` union the port reuses
- `packages/shared/src/config.ts` (≈110–167) — hibernation OFF-by-design rationale (#329)

**cmux (manaflow-ai/cmux@main), from the dossier:**
- `Sources/AgentHibernation/AgentHibernationLifecycleState.swift` — the 4-state enum
- `CLI/CMUXCLI+AgentHookDefinitions.swift` — per-agent native templates + event→subcommand map
- `Sources/RestorableAgentTypes.swift` — `~/.cmuxterm/<agent>-hook-sessions.json` path + record schema
- `Sources/Feed/FeedCoordinator.swift` — "explicit agent update wins" reducer rule
- `Sources/VaultAgentProcessScanner.swift` / `CmuxTopSnapshot.swift` — hook-less process scan (liveness/identity only)
