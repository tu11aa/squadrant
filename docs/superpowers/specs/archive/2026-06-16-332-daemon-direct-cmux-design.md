# #332 — Deprecate notify-relay → daemon calls cmux directly

> **✅ Shipped** (PR #342, #347, 2026-06-16). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-06-16
**Issue:** [#332](https://github.com/tu11aa/claude-cockpit/issues/332)
**Status:** Design (brainstorm complete, awaiting spec review → writing-plans)
**Reference:** `docs/research/2026-06-16-cmux-agent-lifecycle-and-daemon-architecture.md`

---

## 1. Problem & finding

The entire relay-proxy architecture rests on one premise: *"the daemon (a launchd process, NOT a cmux descendant) cannot drive cmux — process-lineage denies all daemon-originated cmux calls"* (#239/#240/#249). Because of that wall, the daemon proxies every cmux operation through a **notify-relay** process that lives inside the captain's cmux process tree.

**That premise is false on cmux 0.64.16.** Live-verified — every cmux env var scrubbed (simulating the launchd daemon):

```
$ env -i HOME=$HOME PATH=$PATH cmux ping            -> PONG
$ env -i HOME=$HOME PATH=$PATH cmux workspace list  -> * workspace:3  ⚓ cockpit-captain ...
```

cmux auto-discovers a **canonical socket** at `~/.local/state/cmux/cmux.sock` and authenticates without inherited env/password. **Any process on the machine can drive cmux directly.** The relay-proxy hop exists only to satisfy a wall that no longer stands.

## 2. What the relay does today (the thing we are retiring)

The relay (`src/commands/notify-relay.ts`) runs three jobs on a 1s timer, **all** existing only because of the lineage wall:

| # | Job | Mechanism | Layer |
|---|-----|-----------|-------|
| 1 | **Notify EGRESS** — deliver captain notifications | `drain()` tails the mailbox cursor → `runtime.sendToSurface(captainSurface, msg)`, carrying the #258/#302 **defer-while-typing** logic (`DeferDelivery` exception, `deferCounts`/`stableCounts`/`lastContent`, `maxDefers`, `stableProbePolls`) | EGRESS |
| 2 | **Surface-liveness probe** | `executeProxiedProbes()` polls `relay-proxy-poll`, runs `runtime.listSurfaces(ws.id)` + `surfaceVerdict(titles, paneTitle)` in-lineage, posts back via `relay-proxy-result` | INGEST fallback |
| 3 | **Blocked/pane probe** | `createInteractiveProbe()` + `createCrewPaneReader()` read the crew pane to detect permission/trailing-question stalls | INGEST fallback |

Daemon side (`src/control/cockpitd.ts`): `pendingProbes` / `probeResults` / `inFlightProbes` queues + the `relay-proxy-poll` / `relay-proxy-result` message handlers (~L216-241, L638-652). The daemon never calls cmux; it only reads the result cache the relay posts.

## 3. Goal & end-state

Retire the notify-relay. The daemon calls cmux directly via the canonical socket. **End-state = full retirement** of the relay process/tab; all three jobs run daemon-side.

**Cutover strategy = flag-gated parallel run** (chosen for safety — the daemon becomes the sole carrier of the captain's notification lifeline, the exact thing #240's supervisor fought to keep alive):

1. Build the daemon-direct path behind a config flag `defaults.daemonDirectCmux` (default `false`).
2. Flag OFF → relay path unchanged (today's behaviour).
3. Flag ON → daemon-direct path active; relay process becomes idle/deprecated.
4. Verify live (notifications land, no false reaps, defer-while-typing intact) for N days.
5. Flip default to ON.
6. **Follow-on PR:** delete relay code + the flag once proven.

Instant rollback at every stage = flip the flag back.

## 4. Scope — TRANSPORT-ONLY

This effort changes **WHO calls cmux**, not **WHAT cockpit reads for lifecycle**.

- ✅ In scope: move jobs 1/2/3 from relay-in-lineage to daemon-direct. Keep the **exact same** cmux operations (`sendToSurface`, `listSurfaces`, `readScreen`), the **exact same** `surfaceVerdict` parse, the **exact same** defer-while-typing logic. Only the caller changes.
- ❌ Out of scope: changing the lifecycle source-of-truth (scrape → `~/.cmuxterm` hook store, or cockpit-owned hooks). That is **#333** (INGEST / `LifecycleSource` port) and lands behind the seam this effort carves. See §7.

**Why transport-only:** the flag's A/B value depends on exactly one variable changing between "old relay path" and "new daemon path" = the transport. Folding in a source-of-truth change would muddy regression attribution and does not even let us delete the fragile scrape (codex/opencode crews have no hook store today — dossier §3).

## 5. Design

### 5.1 `CmuxClient` module (the seam)

Introduce `src/control/cmux/cmux-client.ts` — the single place the daemon talks to cmux:

- **Socket discovery:** resolve the canonical `~/.local/state/cmux/cmux.sock` (cmux #5176). Robustness: confirm DEV-vs-stable socket handling and any password-from-Settings need (cf. cmux #411 "ignore inherited socket context"). Fail-soft: if the socket is unreachable, calls return a safe sentinel (see §5.4) — never throw into the daemon loop.
- **Operations** (mirror what the runtime driver already does in-lineage, just invoked daemon-side): `send(surface, text, opts)`, `listSurfaces(workspaceId)`, `readScreen(surface, lines)`.
- This is the natural insertion point for #333's `LifecycleSource` later — the port sits behind `CmuxClient`, no rework of #332 code.

### 5.2 EGRESS — daemon-direct notify delivery (job 1)

Move `drain()` + defer-while-typing into the daemon:

- The daemon already tails task/mailbox state; it gains a delivery loop that reads the captain mailbox cursor and calls `CmuxClient.send(captainSurface, msg, {probe})`.
- **Re-home the #258/#302 defer-while-typing logic verbatim:** `DeferDelivery` exception handling, `deferCounts`/`stableCounts`/`lastContent` maps, `maxDefers` (config `relay.maxDeferDeliveries`), `stableProbePolls`, the stable-content probe escalation. This is delicate code (#258/#268/#294/#302 ghost-reaping history) — port, do not rewrite.
- `captainSurface` resolution: the daemon must know the captain's surface ref. It already tracks captain workspace via relay-register today; replace that with daemon-side captain-surface discovery (`CmuxClient.listSurfaces` filtered by the captain pane title) — ties into §5.4.

### 5.3 INGEST fallback — daemon-direct probes (jobs 2/3)

- Replace `proxiedSurfaceAlive()` / `pendingProbes` / `probeResults` / `inFlightProbes` and the `relay-proxy-poll`/`relay-proxy-result` handlers with a **direct** call: the sweep calls `CmuxClient.listSurfaces` + `surfaceVerdict` inline (no queue, no round-trip).
- Move the interactive blocked-probe (`createCrewPaneReader` → `readScreen`) daemon-side likewise.
- **Keep `surfaceVerdict` and pane-parse logic byte-for-byte.** Note (not acted on here): once #333's cockpit-owned hooks land, jobs 2/3 become near-redundant and get *deleted* rather than maintained.

### 5.4 Captain-close reap (#324) — the new lifecycle gap

Today the relay **dies with the captain workspace**, giving the daemon a free "captain gone" reap signal (relay-heartbeat stops → daemon knows). Daemon-direct decouples this: the daemon no longer has a relay heartbeat to lose.

**Replacement:** the daemon detects captain-close by `CmuxClient.listSurfaces` — if the captain surface is absent for K consecutive sweeps, treat the captain as closed (stop delivery attempts, reap as today's lost-heartbeat path did). This is the #324 tie-in and MUST ship with the flag (otherwise flag-ON leaks delivery attempts to a dead surface).

**Fail-soft rule (critical):** any `CmuxClient` failure (socket down, listSurfaces error) returns `"unknown"` / no-op — **never** a false "gone" that reaps a live crew. Mirrors today's `surfaceVerdict(null, …) → "unknown"` safety.

### 5.5 Relay process lifecycle under the flag

- Flag OFF: relay spawns and runs exactly as today (captain-ops `cockpit relay supervise … --as captain`).
- Flag ON: the captain **does not** spawn the relay supervisor; the daemon owns all three jobs. The `relay-register`/`relay-heartbeat` path stays in the daemon as dead-but-harmless code until the follow-on deletion PR.
- `relay-healer.ts` (#207 secondary recovery) is a no-op when the flag is ON (nothing to heal).

## 6. Components & files

| File | Change |
|------|--------|
| `src/control/cmux/cmux-client.ts` | **NEW** — socket discovery + `send`/`listSurfaces`/`readScreen`, fail-soft |
| `src/control/cockpitd.ts` | daemon delivery loop (job 1) + inline probes (jobs 2/3) + captain-surface discovery + captain-close reap; gate all on `daemonDirectCmux` |
| `src/commands/notify-relay.ts` | unchanged when flag OFF; not spawned when flag ON (deleted in follow-on) |
| `src/config.ts` | add `defaults.daemonDirectCmux: false` |
| `plugin/skills/captain-ops/SKILL.md` | when flag ON, skip the `relay supervise` startup step |
| `__tests__` | new: `CmuxClient` socket discovery + fail-soft; daemon-direct delivery + defer-while-typing parity; captain-close reap; flag OFF = relay path untouched |

## 7. Out of scope / follow-on (documented for seam rationale)

- **#333 — `LifecycleSource` port (INGEST).** The chosen direction is **NativeHookSource (option C):** cockpit installs its OWN hooks into each agent's native config → `cockpitd hooks <agent> <sub> --task-id $COCKPIT_CREW_TASK_ID`. This is **automatic** (fixes #278 — DONE always fires, not model-discretionary), **driver-agnostic** (survives cmux swap), and **sidesteps the codex sandbox blocker** (#114 — lifecycle reported by codex's trusted hook process, not a sandboxed `crew signal` shell call). Lands behind the `CmuxClient`/`LifecycleSource` seam #332 carves. **Open (parked) decision:** how cockpit-owned hooks coexist with cmux's own hooks (co-exist/append vs `CMUX_<AGENT>_HOOKS_DISABLED=1` vs read `~/.cmuxterm`).
- **#338 — push-based event-bus ingest** (opencode-style SDK plugin bus). Future / E-later; a fourth source variant behind the same port.
- **Sequencing decided:** #332 first (well-understood, low risk, carves the seam, not blocked by the parked collision decision), then #333.

## 8. Success criteria

1. Flag OFF: behaviour byte-identical to today (relay path), all existing relay/proxy tests green.
2. Flag ON, live: captain notifications land; defer-while-typing still defers mid-keystroke and escalates on stable content; no false crew reaps; captain-close detected within K sweeps.
3. No cmux call from the daemon ever throws into the sweep loop (fail-soft → `"unknown"`/no-op verified by test).
4. Rollback proven: flipping the flag OFF restores the relay path with no residual state.
