# Service-Health / Liveness Layer — First-Cut Plan

**Closes:** #207 (relay register/health-check/heal) + #77 (component liveness layer).
**Resolves:** #208 residual (verdict + close).
**Branch target:** `develop`. **Blast radius:** LOW (all changes additive — no existing signature breaks).

---

## The one theme

Cockpit has no liveness tracking for its **own** services, so when one dies the
failure is silent and cascades. The daemon already sweeps every 30s and owns the
task ledger + mailbox surfaces — it is the natural home for a health layer.

## The decisive architectural constraint (researched, not assumed)

cmux enforces a **process-lineage check on writers**: only a process inside
cmux's process tree may `send` / `new-surface` into a captain pane. The cockpitd
daemon runs under **launchd — NOT in cmux's tree**. Therefore:

| Daemon → cmux | Allowed? | Evidence |
|---|---|---|
| **Read** (`list-workspaces`, `tree`, `read-screen`) | ✅ yes | the #139 surface-liveness probe is wired into the daemon and relies on it |
| **Write / spawn** (`send`, `new-surface`) | ❌ refused | `Error: Failed to write to socket`; research note `2026-05-27-multi-session-orchestrator-notification-patterns.md` (4× confirmations); cmux notifier `notify()` also shells the lineage-bound `cockpit runtime send` |

**Consequence:** the daemon **cannot itself re-spawn a relay tab in production.**
The genuine in-prod heal must be performed by a cmux-tree-resident process. The
daemon's honest role is: **register + detect + drive heal best-effort + expose a
queryable liveness surface** so the captain is *never silently blind* (the
out-of-band safety net is `cockpit doctor` / `status --detailed`, run from inside
cmux). This shapes the heal design below and is **the key scope decision for the
captain to approve.**

---

## Part A — Component liveness layer (#77 foundation)

New pure module `src/control/liveness.ts` (runtime-agnostic):

- `ComponentKind = "relay" | "captain" | "crew" | "command"`
- `ComponentHealth = { kind, project, ref, state: "alive"|"stale"|"gone"|"unknown", lastSeenMs, detail }`
- Pure `classifyHealth(lastSeenMs | null, now, staleMs, goneMs) → state`.

The daemon holds an in-memory `Map<project, RelayHealth>` (fed by Part B) and
**derives** the other components on demand from sources it already has:

- **crew** → `store.listAll()` task records (`lastHeartbeat`, `state`). Already tracked; just project it.
- **captain** → daemon reads cmux `runtime.status(captainName)` (read = allowed). Alive iff workspace present.
- **command** → command is optional/on-demand now; workspace-presence if configured, else `"unknown"`. Minimal.
- **relay** → the registration-heartbeat map (Part B).

Surface:
- New additive socket verb `{ kind: "health", project? } → ComponentHealth[]`.
- `cockpit doctor` gains a **Service Health** section.
- `cockpit status --detailed` renders per-component last-seen + state.

**Deferred to follow-up (documented, NOT this PR):** reactions.json escalate
rules, hard crew task-timeout escalation, #64 hook/socket event ingestion.
(#77 itself scopes auto-recovery OUT except relay heal.)

## Part B — Relay register + health-check + heal (#207 core)

1. **Registration** (additive socket kinds, routed in `cockpitd` server handler):
   - boot: `{ kind:"relay-register", project, pid, startedAt }`
   - every ~10s: `{ kind:"relay-heartbeat", project, pid }`
   - daemon stores `RelayHealth{ project, pid, startedAt, lastSeenMs }`.
   - Wired into `runNotifyRelay` (notify-relay.ts) via the already-imported
     `cockpitdCall` — additive interval alongside the existing drain/probe loops.

2. **Health-check** (additive pass in `daemon.sweep`, runs on the existing 30s tick):
   - For each project that should have a relay (registered, or live captain
     workspace), flag dark when `now - lastSeenMs > RELAY_STALE_MS` (≈2× heartbeat).
   - (Stretch, may defer to stay surgical) cursor-progress signal: mailbox has
     `seq > subscriber cursor` while captain is live ⇒ relay alive-but-not-draining.

3. **Heal** — bounded by the constraint above:
   - Daemon calls an injected `healRelay(project)` dep, **debounced** (one attempt
     per "gone" episode via `lastHealAttemptMs`, not every sweep).
   - Default impl attempts re-spawn via the runtime's `spawnInjector`
     (best-effort). If cmux refuses (lineage) → log + leave liveness `"gone"` so
     `cockpit doctor` shows it. Tests inject a fake and assert it fires once per
     detected-dead relay (killed-relay fixture).
   - **KEY DECISION (captain to approve):** because daemon→cmux injection is
     lineage-blocked in prod, daemon-side heal is best-effort + always-surfaced.
     The robust in-prod heal — a small **cmux-tree-resident "relay-keeper"** that
     polls daemon relay-health and re-spawns the relay tab — is the recommended
     **follow-up**, not this PR. This PR guarantees the captain is never
     *silently* blind; full auto-heal-in-prod lands next.

## Part C — #208 verdict (document + close)

Per the issue's own 2026-06-05 comment and the code:

- **B2** (dropped `task.idle`) — **RESOLVED by #217**: daemon `formatMessage`
  handles `awaiting-input → CREW IDLE` (daemon.ts:97-98); relay `deliverable()`
  delivers the daemon message verbatim.
- **B1** (24h budget disables backstop) — addressed by **#139 liveness reaping**:
  dead interactive crews are terminalized by surface-liveness in sweep/reconcile,
  not by heartbeat timeout. The 24h budget stays (no #131/#133 false-stall regression).
- **Residual** (timely idle nudge for a *live* crew whose turn-end was missed) is
  **COVERED** by: (a) reliable per-agent turn-end signals (claude Stop #133,
  opencode SSE session.idle #188) → `awaiting-input` → CREW IDLE, and (b) the
  in-cmux relay pane-probe (`createInteractiveProbe`) that scrapes quiet working
  panes → CREW BLOCKED.

**Verdict: CLOSE #208.** No new code required beyond documentation. A daemon-side
"live-idle nudge" would mean a second short heartbeat budget gated on
`surface=alive` — it risks re-introducing the #131/#133 false-stall, so it is
**not recommended.** If the captain wants it anyway, it is a tightly-scoped follow-up.

---

## TDD test list

- `liveness.test.ts` — `classifyHealth` thresholds (alive/stale/gone/unknown).
- daemon `relay-register` / `relay-heartbeat` → `RelayHealth` map populated.
- daemon sweep: stale relay → marked `gone` + `healRelay` invoked **once** (debounced).
- killed-relay fixture: register → advance clock past stale → sweep → heal fires.
- `health` verb returns projected component health (relay/captain/crew/command).
- doctor / `status --detailed` renders the Service Health section.
- Full `npm test` green + `tsc --noEmit` clean.

## Files (all additive, LOW blast radius)

| File | Change |
|---|---|
| `src/control/liveness.ts` *(new)* + test | pure health classification + projection |
| `src/control/types.ts` | `RelayHealth`, `ComponentHealth` types |
| `src/control/daemon.ts` | `DaemonDeps` += relay-health map + `healRelay`; sweep relay pass; handle `relay-register`/`relay-heartbeat`/`health` |
| `src/control/cockpitd.ts` | wire default `healRelay` + relay-health; route new socket kinds |
| `src/commands/notify-relay.ts` | register + heartbeat in `runNotifyRelay` |
| `src/commands/doctor.ts` | Service Health section |
| `src/commands/status.ts` | `--detailed` flag + liveness |
| docs | #208 verdict note; #77 deferred-scope follow-ups |

## Explicitly deferred (follow-up issues, not gold-plated here)

1. **cmux-tree-resident relay-keeper** — the genuine in-prod auto-heal (this PR's
   daemon heal is best-effort + surfaced). → filed as **#224**.
2. #77's reactions.json escalation + hard crew task-timeout + #64 event
   ingestion. → filed as **#225**.

---

## Status: APPROVED (2026-06-05) — built

Captain approved all three scope decisions, priority refinement: **the
non-negotiable core is "captain is never SILENTLY blind" (detect + surface).
Best-effort heal is SECONDARY** and intentionally minimal — mostly inert under
launchd (cmux lineage), so the liveness surface + the actionable
"relay DOWN — run: cockpit launch &lt;project&gt;" message is the guarantee, not
the heal. #208 verdict: `docs/decisions/2026-06-05-issue-208-verdict.md` → CLOSE.
