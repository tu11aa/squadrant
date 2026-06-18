# Reorg Step 4a — Restructure `cockpitd.ts` Implementation Plan

> **✅ Shipped** (PR #356, 2026-06-17). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a large multi-file restructure — use `/gsd:plan-phase` + `/gsd:execute-phase` for wave-based execution with fresh context per task.

**Goal:** Carve the driver-agnostic daemon core out of the 1032-LOC `src/control/cockpitd.ts` into focused `src/control/daemon/*` modules, leaving `cockpitd.ts` as a thin host that constructs concrete drivers and calls `startDaemon(deps)`. Behavior-preserving; **no package created yet** (that is Step 4b).

**Architecture:** Each `daemon/*.ts` exports a `createX(ctx)` factory over a shared `DaemonContext`. `cockpitd.ts` stays the bin/launchd entrypoint filename (so `dist/cockpitd.js`, the launchd plist, and the tsup entry are all unchanged) but becomes the host: it builds the concrete drivers and the `deps` object, then calls `startDaemon(deps)` exported from `daemon/start.ts`.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, pnpm + tsup build, git.

## Global Constraints

- Platform: macOS-only. No cross-platform shims.
- NodeNext ESM: relative imports need `.js` extensions. **The real runtime gate is `node dist/cockpitd.js` booting + serving the socket AND `node dist/index.js --help`** — not just tests (tsc + vitest miss missing-extension breakage).
- **Behavior-preserving refactor only.** No logic changes, no feature work, no signature changes to public daemon behavior. The existing test suite is the characterization safety net — every task ends with the **full suite green** (minus the known pre-existing #353 relay-proxy flakes) and the daemon booting.
- **No package move in 4a.** Everything stays in the root `src/` tree. `packages/core` is created in 4b.
- **Daemon-boot smoke must override `sockPath`** (temp path), never bind the real `~/.config/cockpit/cockpit.sock` — the Step-3 gotcha that disrupted the live daemon.
- Branch off `develop`. Open a PR to `develop`; do not self-merge (captain reviews).
- Do NOT touch the live daemon, live `~/.config/cockpit/config.json`, or restart cmux during dev.

**Source-of-truth line map (verified 2026-06-17 against `cockpitd.ts`, 1032 LOC):**

| Concern | Current location in `cockpitd.ts` | Target module |
|---|---|---|
| Inline structural driver types (`codexDriver`/`opencodeBridge`/`cmuxEventsBridge`/`daemonCmux` shapes) | `CockpitdOpts` lines 80–125 | `interfaces.ts` (named interfaces) |
| `distBuiltAt` (132), `gatherLogStats` (138), `gatherStoreStats` (169), `gatherResults` (190) | module-level helpers | `daemon/snapshot-gather.ts` |
| `buildHealth` (540), `knownProjects` (571), `gatherSnapshotInputs` (584) | inside `startCockpitd` | `daemon/snapshot-gather.ts` (as `createSnapshotGather(ctx)`) |
| state setup (221–262): `store`, `bootedAt`, `lastSweepAt`, `taskTimeoutMs`, `isPidAlive`, `spawn`, `resultsDir`, `writeResult`, `log`, `attachConns`, probe maps, in-flight sets | inside `startCockpitd` | `daemon/context.ts` (`DaemonContext` + `buildContext`) |
| `proxiedSurfaceAlive` (267) | inside `startCockpitd` | `daemon/probes.ts` |
| `broadcast` (280), `schedulePromotion` (295), `cancelPromotionsFor` (324) | inside `startCockpitd` | `daemon/attach.ts` |
| event-ingestion / cmux-events subscriptions + `ingest` (336–415) | inside `startCockpitd` | `daemon/start.ts` (composition) |
| `defaultNotify` (424–540) | inside `startCockpitd` | `daemon/delivery.ts` |
| boot-recovery IIFE: reconcile + codex reattach + opencode re-subscribe + cmux-events start + #348 autoconfig (622–688) | inside `startCockpitd` | `daemon/start.ts` (boot sequence; drivers via `deps`) |
| `server = startServer(...)` + message-router handler (690–~790) | inside `startCockpitd` | `daemon/server.ts` |
| daemon-direct delivery setup: `deliveryCore`/`deliveryTick`/`directPaneReader`/`interactiveProbe`/`probeTick` (790–945) | inside `startCockpitd` | `daemon/delivery.ts` + `daemon/probes.ts` |
| approval-gate wiring (`makeGate`, decision routing ~527) | inside the handler | `daemon/gates.ts` |
| timers (delivery/probe/sweep/rotation, 947–1011) + return handle (1013–1025) | inside `startCockpitd` | `daemon/start.ts` |
| launchd entry guard (1028–1031) | bottom of file | `cockpitd.ts` host |

---

### Task 1: Extract driver-seam interfaces (`interfaces.ts`)

**Files:**
- Create: `src/control/interfaces.ts`
- Modify: `src/control/cockpitd.ts` (`CockpitdOpts` — replace inline structural types with the named interfaces)

**Interfaces:**
- Produces: `AgentDriver` (`{ dispatch, reattach, say, steer, interrupt, answer, close }`), `OpencodeBridge` (`{ start, stop, answer }`), `CmuxEventsBridge` (`{ start, stop }`), `DaemonSurfaceDriver` (the `DaemonCmux` surface used by delivery: `findWorkspaceId?`, `listSurfaces`, `send`). Each copied verbatim from the inline shapes currently in `CockpitdOpts` (lines 80–125) so the structural contract is identical.
- Consumes: nothing (pure type module, no runtime imports).

- [ ] **Step 1:** Create `src/control/interfaces.ts` with the four interfaces above, lifting each member signature **verbatim** from the inline `CockpitdOpts` types (lines 80–88 for `AgentDriver`, 98–103 for `OpencodeBridge`, 106 for `CmuxEventsBridge`, the `DaemonCmux` usage in `deliveryCore` for `DaemonSurfaceDriver`). Add a one-line doc comment per interface naming the seam it represents.
- [ ] **Step 2:** In `cockpitd.ts`, change the `CockpitdOpts` fields to reference the named interfaces (`codexDriver?: AgentDriver`, `opencodeBridge?: OpencodeBridge`, `cmuxEventsBridge?: CmuxEventsBridge`, `daemonCmux?: DaemonSurfaceDriver | DaemonCmux`). Keep `DaemonCmux` import for now (it's the concrete default's type).
- [ ] **Step 3:** Type-check + full suite: `pnpm run lint && npm test`. Expected: `tsc -b` clean (structural types match, no behavior change), suite green.
- [ ] **Step 4:** Boot smoke: `pnpm run build && node dist/cockpitd.js & sleep 2; <verify socket on a TEMP sockPath via a scratch invocation>; kill %1`. Expected: daemon boots. (Use a temp `sockPath` — never the real socket.)
- [ ] **Step 5:** Commit: `git commit -am "refactor(4a): extract driver-seam interfaces into interfaces.ts"`.

---

### Task 2: Extract `daemon/snapshot-gather.ts`

**Files:**
- Create: `src/control/daemon/snapshot-gather.ts`
- Modify: `src/control/cockpitd.ts`

**Interfaces:**
- Produces: pure helpers `distBuiltAt()`, `gatherLogStats(path, now, windowMs)`, `gatherStoreStats(store, stateRoot, project)`, `gatherResults(resultsDir)` (moved verbatim with their existing signatures); and `createSnapshotGather(ctx)` returning `{ buildHealth, knownProjects, gatherSnapshotInputs }` (the three closure fns, now reading `store`/`d`/`stateRoot`/`bootedAt`/`resultsDir` from `ctx`).
- Consumes: `DaemonContext` (Task 3 defines it — for ordering, do Task 3 first if the crew prefers; this plan lists snapshot first because the pure helpers move cleanly, then the `createSnapshotGather` factory is added once `ctx` exists). If executed before Task 3, move only the 4 pure helpers in this task and defer `createSnapshotGather` to a follow-up step after `context.ts` lands.

- [ ] **Step 1:** Move `distBuiltAt`, `gatherLogStats`, `gatherStoreStats`, `gatherResults` verbatim into `snapshot-gather.ts`; export each. Repoint their imports (`DaemonSnapshotInputs`, `ResultArtifacts` from `./snapshot.js`, `readCursor`/`mailboxStats` as needed). Import them back into `cockpitd.ts`.
- [ ] **Step 2:** Full suite + boot smoke (as Task 1 Steps 3–4). Expected: green; daemon boots.
- [ ] **Step 3:** Commit: `git commit -am "refactor(4a): move snapshot I/O helpers to daemon/snapshot-gather.ts"`.

---

### Task 3: Define `DaemonContext` + `buildContext` (`daemon/context.ts`)

**Files:**
- Create: `src/control/daemon/context.ts`
- Modify: `src/control/cockpitd.ts`

**Interfaces:**
- Produces: `interface DaemonContext` holding the shared state currently set up in lines 221–262 — `stateRoot`, `sockPath`, `store`, `bootedAt`, `lastSweepAt` (mutable — expose as a getter/setter or a `{ value }` box so the sweep timer can update it), `taskTimeoutMs`, `isPidAlive`, `spawn`, `resultsDir`, `writeResult`, `log`, `attachConns`, `pendingProbes`, `probeResults`, `inFlightProbes`, `inFlightHeadlessIds`, `activeHeadlessKills`, `d` (the `Daemon` from `createDaemon`), and the `deps` (drivers + notify + config injectors). Plus `buildContext(deps): DaemonContext`.
- Consumes: `interfaces.ts` types; `createStore`, `createDaemon`.

- [ ] **Step 1:** Define `DaemonContext` and `buildContext(deps)` in `context.ts`, moving the state-setup block (221–262) into `buildContext`. `lastSweepAt` becomes a mutable box on the context so timers can update it. `d` (daemon) is constructed here or passed in — keep `createDaemon` wiring where it currently is and store the result on `ctx`.
- [ ] **Step 2:** In `cockpitd.ts`/`start.ts`, replace the inline state setup with `const ctx = buildContext(deps)`.
- [ ] **Step 3:** Full suite + boot smoke. Expected: green; daemon boots.
- [ ] **Step 4:** Commit: `git commit -am "refactor(4a): introduce DaemonContext + buildContext"`.

---

### Task 4: Extract `daemon/attach.ts`

**Files:**
- Create: `src/control/daemon/attach.ts`
- Modify: `src/control/cockpitd.ts` / `daemon/start.ts`

**Interfaces:**
- Produces: `createAttach(ctx)` returning `{ broadcast(taskId, frame), schedulePromotion(...), cancelPromotionsFor(taskId) }` (moved verbatim from lines 280–336, reading `attachConns` from `ctx`).
- Consumes: `DaemonContext`; `AttachFrame`/`encodeFrame` from `./protocol.js`.

- [ ] **Step 1:** Move `broadcast`, `schedulePromotion`, `cancelPromotionsFor` into `createAttach(ctx)`; wire callers in `start.ts` to the returned handlers.
- [ ] **Step 2:** Full suite + boot smoke. Expected: green; daemon boots.
- [ ] **Step 3:** Commit: `git commit -am "refactor(4a): extract attach fan-out to daemon/attach.ts"`.

---

### Task 5: Extract `daemon/probes.ts`

**Files:**
- Create: `src/control/daemon/probes.ts`
- Modify: `src/control/cockpitd.ts` / `daemon/start.ts`

**Interfaces:**
- Produces: `createProbes(ctx)` returning `{ proxiedSurfaceAlive(rec), buildInteractiveProbe(deliverDeps), captainMissingStreak, stoppedProjects }` — the `proxiedSurfaceAlive` closure (267–278) plus the `createInteractiveProbe`/`createDirectCrewPaneReader` wiring (910–944, the `probeTick` guard). `captainMissingStreak`/`stoppedProjects` maps move here (shared with delivery via `ctx` if delivery also needs them — keep them on `ctx`).
- Consumes: `DaemonContext`; `createInteractiveProbe`/`STALE_THRESHOLD_MS` (still from `../commands/notify-relay.js` in 4a — the back-edge is fixed in 4b), `createDirectCrewPaneReader`/`createDirectSurfaceLivenessProbe` from `./crew-pane-reader.js`.

- [ ] **Step 1:** Move `proxiedSurfaceAlive` + the interactive-probe setup + `probeTick` guard into `createProbes(ctx)`. Keep `captainMissingStreak`/`stoppedProjects` on `ctx` (delivery reads them).
- [ ] **Step 2:** Full suite + boot smoke. Expected: green; daemon boots.
- [ ] **Step 3:** Commit: `git commit -am "refactor(4a): extract liveness probes to daemon/probes.ts"`.

---

### Task 6: Extract `daemon/delivery.ts`

**Files:**
- Create: `src/control/daemon/delivery.ts`
- Modify: `src/control/cockpitd.ts` / `daemon/start.ts`

**Interfaces:**
- Produces: `createDelivery(ctx)` returning `{ defaultNotify(args), deliveryTick }` — `defaultNotify` (424–540) and the daemon-direct delivery block (790–908: `deliveryCore` + `deliveryTick` re-entrancy guard, using `ctx.deps.daemonCmux` as the `DaemonSurfaceDriver`, `CaptainDelivery`, `discoverCaptainSurface`, cursor read/write, `sessionStartMs`, `STALE_THRESHOLD_MS`).
- Consumes: `DaemonContext`; `CaptainDelivery` from `./delivery/captain-delivery.js`; `discoverCaptainSurface` (keep exported from where tests import it — verify the test import path; re-export if it moves).

- [ ] **Step 1:** Move `defaultNotify` + `deliveryCore`/`deliveryTick` into `createDelivery(ctx)`. The `notify` used by the daemon = `ctx.deps.notify ?? defaultNotify`. Preserve all #332 storm guards (re-entrancy `delivering`, stale-skip, streak) byte-for-byte.
- [ ] **Step 2:** Verify `discoverCaptainSurface`'s test import still resolves (it is currently `export`ed from `cockpitd.ts`). If a test imports it from `cockpitd.ts`, re-export it from `cockpitd.ts` (`export { discoverCaptainSurface } from "./daemon/delivery.js"`) to avoid touching tests in 4a.
- [ ] **Step 3:** Full suite + boot smoke + **daemon-direct delivery check** (boot with a temp `sockPath` + injected fake `daemonCmux` + `sweepMs>0`, assert `tickDelivery` advances a cursor). Expected: green; daemon boots; delivery ticks.
- [ ] **Step 4:** Commit: `git commit -am "refactor(4a): extract delivery loop to daemon/delivery.ts"`.

---

### Task 7: Extract `daemon/gates.ts` + `daemon/server.ts`

**Files:**
- Create: `src/control/daemon/gates.ts`, `src/control/daemon/server.ts`
- Modify: `src/control/cockpitd.ts` / `daemon/start.ts`

**Interfaces:**
- Produces:
  - `createGates(ctx)` → `{ gate }` (the `makeGate` wiring + approve/deny decision routing, ~527).
  - `createServer(ctx, handlers)` → the `startServer(sockPath, { handler })` wiring + the message router (690–~790: `seed`, `codex-close`, `relay-register`, `relay-heartbeat`, `relay-proxy-poll`, `relay-proxy-result`, and the `d.handle(msg)` fallthrough). `handlers` carries the `broadcast`/driver hooks the router calls (e.g. `ctx.deps.codexDriver.close`).
- Consumes: `DaemonContext`; `startServer`/`encodeFrame` from `./protocol.js`; `makeGate` from `./codex/gate.js` (stays in root in 4a).

- [ ] **Step 1:** Move the gate wiring into `createGates(ctx)`.
- [ ] **Step 2:** Move `startServer` + the message router into `createServer(ctx, handlers)`. The router calls into `attach`/`delivery`/`probes`/`gates` via the passed `handlers` object — no direct closure refs.
- [ ] **Step 3:** Full suite + boot smoke. Expected: green; daemon boots; a `seed`/`relay-register` round-trips.
- [ ] **Step 4:** Commit: `git commit -am "refactor(4a): extract gates + socket server to daemon/{gates,server}.ts"`.

---

### Task 8: Assemble `daemon/start.ts` + reduce `cockpitd.ts` to the host

**Files:**
- Create: `src/control/daemon/start.ts`
- Modify: `src/control/cockpitd.ts`

**Interfaces:**
- Produces:
  - `startDaemon(deps: DaemonDeps): DaemonHandle` in `start.ts` — builds `ctx`, constructs the factories (`createAttach`, `createProbes`, `createDelivery`, `createGates`, `createServer`, `createSnapshotGather`), runs the boot-recovery sequence (reconcile + codex reattach + opencode re-subscribe + cmux-events start + #348 autoconfig — all via `deps` drivers), starts the timers (delivery/probe/sweep/rotation, 947–1011), and returns the `{ stop, tickDelivery, tickProbe }` handle (1013–1025). `DaemonDeps` = `CockpitdOpts` minus the inline driver defaults, **plus required driver fields** (`codexDriver`, `opencodeBridge`, `cmuxEventsBridge`, `launchHeadless`, `healRelay`; `daemonCmux`/`makeDaemonCmux` stay optional, gated by `daemonDirectCmux`).
  - `cockpitd.ts` host: `readPkgVersion`/`PKG_VERSION` stay; constructs the concrete drivers (`new CodexInteractiveDriver()`, real `OpencodeSseBridge`, `new CmuxEventsBridge(...)`, `() => new DaemonCmux(createCmuxDriver())`, `runHeadless`, real `healRelay`), assembles `deps`, calls `startDaemon(deps)`. Keep the `startCockpitd(opts)` exported name as a thin shim over `startDaemon` (host supplies defaults) so existing test imports of `startCockpitd` keep working in 4a.
- Consumes: everything above; the concrete driver classes (the only file still importing them).

- [ ] **Step 1:** Create `start.ts` with `startDaemon(deps)` assembling the factories + boot sequence + timers + handle.
- [ ] **Step 2:** Rewrite `cockpitd.ts` as the host: construct concrete drivers, build `deps`, and export `startCockpitd(opts)` as a shim that fills driver defaults from the concrete classes then calls `startDaemon`. Keep the launchd entry guard (1028–1031) calling `startCockpitd({ sweepMs: 30000 })`.
- [ ] **Step 3:** Confirm `cockpitd.ts` no longer contains daemon logic — only driver construction + the shim + the entry guard (target ≤ ~120 LOC). Grep it for the moved function names; expect none remain defined here.
- [ ] **Step 4:** Full suite + **both** runtime gates: `pnpm run build && node dist/index.js --help && node dist/cockpitd.js` (temp sockPath) boots + serves. Expected: all green.
- [ ] **Step 5:** Commit: `git commit -am "refactor(4a): reduce cockpitd.ts to host; add daemon/start.ts (startDaemon)"`.

---

### Task 9: Verify, document, open PR

**Files:**
- Create: `src/control/daemon/README.md` (≈15 lines: Purpose / Owns / Public interface (`startDaemon`) / Depends on / Doesn't belong here — concrete drivers).
- Modify: none.

- [ ] **Step 1:** Confirm no concrete-driver imports remain in any `daemon/*.ts`: `git grep -nE "codex/driver|opencode/sse-bridge|cmux/events-bridge|cmux/daemon-cmux|runtimes/index|headless-launcher" -- src/control/daemon`. Expected: **no output** (those live only in the host `cockpitd.ts`). The one allowed root-edge — `createInteractiveProbe` from `commands/notify-relay.js` in `daemon/probes.ts` — is the documented 4b back-edge; note it but do not fix it here.
- [ ] **Step 2:** Clean-room CI gate (the Step-3 lesson — run the exact CI command, do not pre-build by hand): from a clean `git stash`-free checkout, `pnpm i --frozen-lockfile && pnpm run build && pnpm test`. Expected: build + suite green.
- [ ] **Step 3:** Write `daemon/README.md`.
- [ ] **Step 4:** Push + open PR to `develop`:
```bash
git push -u origin HEAD
gh pr create --base develop --title "Reorg 4a: restructure cockpitd.ts into daemon/* (host + startDaemon)" \
  --body "Part of the monorepo reorg (docs/superpowers/specs/2026-06-17-monorepo-reorg-step4-extract-core-design.md), rollout step 4a.

- Carve driver-agnostic core out of cockpitd.ts (1032 LOC) into daemon/{start,context,server,attach,delivery,probes,gates,snapshot-gather}.ts + interfaces.ts.
- cockpitd.ts becomes the thin host (constructs concrete drivers, calls startDaemon). Entrypoint filename unchanged -> dist/cockpitd.js, launchd plist, tsup entry untouched.
- No package move (that is 4b). No behavior change.

Verified: pnpm build + pnpm test green; node dist/cockpitd.js boots (temp sockPath); node dist/index.js --help works; daemon-direct delivery ticks."
```
- [ ] **Step 5:** `cockpit crew signal done`.

---

## Self-Review

**Spec coverage** (against the Step-4 4a section of `2026-06-17-monorepo-reorg-step4-extract-core-design.md`):
- `cockpitd.ts` stays entry, becomes thin host → Task 8. ✓
- Split into `daemon/{start,context,server,attach,delivery,probes,gates,snapshot-gather}.ts` → Tasks 2–8. ✓
- Promote inline driver types to named interfaces → Task 1. ✓
- `core` depends on nobody (seam interfaces) → Task 1 + Task 9 Step 1 grep. ✓
- Entry/launchd/tsup untouched → Task 8 keeps `cockpitd.ts` filename + entry guard. ✓
- Daemon-boot test overrides `sockPath` → Global Constraints + Task 6 Step 3. ✓
- 4b back-edge (`notify-relay`) noted not fixed → Task 5 + Task 9 Step 1. ✓

**Placeholder scan:** No TBD/TODO; every task names exact functions + line ranges + verification commands. The one deliberate ordering note (Task 2 vs Task 3) is called out explicitly, not left vague. ✓

**Type consistency:** `DaemonContext` (Task 3) is the single shared bag consumed by Tasks 4–8; `DaemonDeps` (Task 8) = `CockpitdOpts` minus inline driver defaults + required driver fields; `startDaemon`/`startCockpitd`-shim names are consistent across Tasks 8–9. Seam interface names (`AgentDriver`/`OpencodeBridge`/`CmuxEventsBridge`/`DaemonSurfaceDriver`) match between Task 1 and their consumers. ✓

**Out of scope (correctly deferred to 4b):** creating `packages/core`, moving the modules, fixing the `notify-relay` back-edge, project-reference enforcement. None ride along here.
