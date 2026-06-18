# Design: Monorepo reorg — Step 4 (extract `core` + split `cockpitd.ts`)

> **✅ Shipped** (PR #357, 2026-06-17). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-06-17
**Status:** Design — approved in brainstorming; pending spec-review → writing-plans
**Parent spec:** `docs/superpowers/specs/2026-06-17-monorepo-reorg-design.md` (rollout step 4)
**Predecessor:** Step 3 (`@cockpit/shared` extracted, pnpm workspaces + tsup) — merged as PR #355.

## Goal

Extract the daemon / control-plane core into a new private package **`@cockpit/core`**, and in
the process split the 1032-LOC `cockpitd.ts` host into focused `daemon/*` modules. `core` must
depend on **`@cockpit/shared` only** — never on a concrete agent/workspace driver, never on the
`cli`. Concrete drivers (`codex/`, `opencode/`, `cmux/`, `headless`, `runtimes/`) stay in the root
package this step and move to `agents`/`workspaces` in Step 5.

No behavior change. This is structure + boundary enforcement only.

## Key design decision: `cockpitd.ts` stays the host entrypoint

The launchd daemon and the tsup bundle target `dist/cockpitd.js`. To avoid re-firing parent-spec
**landmine #1** (entrypoint relocation), we keep `src/control/cockpitd.ts` as the **host
entrypoint filename** and extract the driver-agnostic core *out of* it:

- `cockpitd.ts` (root) **becomes the host** — it constructs the concrete drivers and calls
  `startDaemon(deps)`. It is the **only** daemon file that imports concrete driver classes.
- The driver-agnostic logic moves into a new `daemon/` folder (root in 4a, then `packages/core`
  in 4b).

Because the entrypoint filename never changes, **`dist/cockpitd.js` is unchanged**, so the
launchd plist and the tsup `cockpitd` entry are untouched in both sub-PRs. Landmine #1 does not
fire in Step 4 (it was already resolved in Step 3's tsup scaffold).

## Decomposition: two sub-PRs

Driver injection **already exists** — every concrete driver is already an injectable field on
`CockpitdOpts` (`codexDriver?`, `opencodeBridge?`, `cmuxEventsBridge?`, `daemonCmux?` /
`makeDaemonCmux?`, `launchHeadless?`, `healRelay?`). The concrete driver *imports* in `cockpitd.ts`
exist solely to build the **inline defaults**. So "invert the DI" is not an API redesign — it is
lifting those default constructions into the host and making the deps required at the `startDaemon`
boundary. That makes the only high-risk piece the **physical move** into `packages/core`, which we
isolate in its own sub-PR.

### Sub-PR 4a — in-root restructure (no package move)

Carve the driver-agnostic core out of `cockpitd.ts` into `src/control/daemon/`, leaving
`cockpitd.ts` as a thin host. Everything stays in the root package; same test surface; daemon boots.

```
src/control/
  cockpitd.ts          HOST (~80 LOC) — bin/launchd ENTRY (filename unchanged).
                       Constructs concrete drivers (Codex, Opencode, cmux-events,
                       DaemonCmux, headless, healRelay) and calls startDaemon(deps).
                       The ONLY daemon file importing concrete drivers.
  daemon/              NEW — driver-agnostic core carved from the 1032-LOC closure:
    start.ts             startDaemon(deps): build context, wire factories, own timers
    context.ts           DaemonContext type + shared mutable state
                         (store, daemon, log, attachConns, probe queues, …)
    server.ts            startServer + socket message routing
                         (relay-register, heartbeat, relay-proxy-poll/result, d.handle)
    attach.ts            attach fan-out (attachConns, broadcast, schedule/cancelPromotion)
    delivery.ts          deliveryCore loop + defaultNotify + daemon-direct + CaptainDelivery
    probes.ts            proxiedSurfaceAlive, probe queues, buildHealth, captain streak, timers
    gates.ts             makeGate wiring + approval decision routing
    snapshot-gather.ts   gatherLog/Store/Results/SnapshotInputs + distBuiltAt (I/O edge)
  interfaces.ts        NEW — driver-seam interfaces (see below)
```

Each `daemon/*.ts` exports a `createX(ctx: DaemonContext)` factory; `start.ts` builds the context
and wires them — the existing `daemon.ts`-core / `cockpitd.ts`-host pattern extended inward.

**Driver-seam interfaces.** The inline structural driver types already in `CockpitdOpts`
(lines 80–88: `{ dispatch, reattach, say, steer, interrupt, answer, close }`; the opencode bridge
shape; the cmux-events shape; the `DaemonCmux` surface used by delivery) are **promoted to named
interfaces** (`AgentDriver`, `OpencodeBridge`, `CmuxEventsBridge`, `DaemonSurfaceDriver`). These are
the seam interfaces `core` will own. Concrete drivers (still in root) implement them structurally.
This is what lets `core` depend on nobody but `shared`.

`startDaemon(deps)` takes the drivers as **required** fields of `deps` (the host always supplies
them; tests supply fakes). Test-only behavioral injectors that are not drivers (`spawn?`,
`isPidAlive?`, `sweepMs?`, `notify?`, `rotationIntervalMs?`, …) keep their optional-with-default
shape.

**4a is done when:** `npm test` green (same pass set), `node dist/cockpitd.js` boots and serves the
socket, daemon-direct delivery still advances the cursor. No package created yet.

### Sub-PR 4b — create `packages/core` + move

```
packages/core/
  package.json         private: true, name @cockpit/core, dep: @cockpit/shared
  tsconfig.json        composite: true; references: [../shared]
  README.md            Purpose / Owns / Public interface / Depends on / Doesn't belong here
  src/
    daemon/            the 4a split, moved verbatim
    interfaces.ts      the driver-seam interfaces from 4a
    daemon.ts mailbox.ts protocol.ts state-machine.ts liveness.ts watchdog.ts
    store.ts snapshot.ts launchd.ts relay-healer.ts relay-* crew-pane-reader.ts
    delivery/          (captain-delivery.ts)
    notifiers/ projection/
```

- **Stays in the root package** (moves to `agents`/`workspaces` in Step 5): `cockpitd.ts` (host),
  `codex/`, `opencode/`, `cmux/`, `headless-launcher.ts`, `runtimes/`. The host repoints its core
  imports to `@cockpit/core`.
- **Entry path unchanged:** host `cockpitd.ts` keeps its filename → `dist/cockpitd.js` →
  **launchd plist + tsup `cockpitd` entry untouched**.
- **Boundary enforced by TS project references:** `core`'s tsconfig references only `shared`; any
  `core → root` import fails `tsc -b`.

**Back-edge to resolve in 4b.** `cockpitd.ts` currently imports `createInteractiveProbe` and
`STALE_THRESHOLD_MS` from `../commands/notify-relay.ts` — a *command* (cli layer) exporting daemon
logic, which `core` cannot import. Fix: move `createInteractiveProbe` (+ `STALE_THRESHOLD_MS`) into
`core` (it belongs with `daemon/probes.ts`); the `notify-relay` command imports it **back from
`@cockpit/core`**. Verify no other `core → commands/` or `core → drivers/` edges remain (grep the
moved files' imports before finalizing).

## Landmines & mitigations (step-4 specific)

1. **Daemon-boot test must override `sockPath`, not just `stateRoot`** (Step-3 lesson). `cockpitd`
   ignores `COCKPIT_STATE_ROOT`; a state-root-only test binds the **real** socket and disrupts the
   live daemon (it self-heals via launchd KeepAlive, but it's a live-system disruption). Every
   boot/integration test in this step passes an explicit temp `sockPath`.
2. **`pkgRoot`-relative reads** (parent landmine #2). `canonical-source.ts` / `runtime-sync.ts`
   already moved to `@cockpit/shared` in Step 3 and are **not** touched here. No action — but the
   4b tarball gate (below) re-proves them end-to-end.
3. **Hidden `core → root` back-edges.** Beyond the known `notify-relay` one, the move can surface
   others (e.g. a type imported from `runtimes/types.ts`). Mitigation: `tsc -b` is the hard gate;
   anything it flags either moves into `core` (if it's core-owned) or becomes a seam interface.
4. **Shared mutable closure state.** The 1032-LOC `startCockpitd` is one closure; the pieces share
   `store`, `d`, `log`, `attachConns`, the probe maps, the in-flight sets. The split threads these
   through an explicit `DaemonContext` object rather than module globals, so behavior is identical
   and the pieces stay unit-reachable.

## Success criteria

- `packages/core` exists with `package.json`, `tsconfig.json` (composite, references `shared`),
  and `README.md`.
- `cockpitd.ts` is a thin host (~80 LOC) that constructs concrete drivers and calls `startDaemon`;
  it is the only daemon file importing concrete driver classes.
- `cockpitd.ts` (1032 LOC) is split into `daemon/{start,context,server,attach,delivery,probes,gates,
  snapshot-gather}.ts` + `interfaces.ts`, each a focused module (no gratuitous <50-LOC fragments).
- `tsc -b` passes; `@cockpit/core` cannot import from the root package, `commands/`, or any concrete
  driver (project-reference enforced).
- `npm test` green (same pass set as before, minus the known pre-existing #353 relay-proxy flakes).
- `node dist/cockpitd.js` boots + serves the socket; daemon-direct delivery advances the cursor.
- A packed tarball (`pnpm pack`) installs and runs `cockpit --help` + completes a `runtime-sync`.
- `packages/core/README.md` present (Purpose / Owns / Public interface / Depends on / Doesn't
  belong here).

## Out of scope

- Moving `codex/` / `opencode/` / `cmux/` / `headless` / `runtimes/` into `agents` / `workspaces`
  (Step 5).
- Moving `dashboard/` into `web` (Step 6); grouping `commands/` (Step 7).
- Rewriting `daemon.ts` core logic — only the *host* file (`cockpitd.ts`) is decomposed; `daemon.ts`
  (clean core, 5 imports) stays as-is.
- Any behavior change. No feature work rides along.
