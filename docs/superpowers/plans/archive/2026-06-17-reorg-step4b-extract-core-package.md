# Reorg Step 4b — Create `packages/core` + Move Implementation Plan

> **✅ Shipped** (PR #357, 2026-06-17). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a cross-package move — the highest-risk sub-PR of the reorg. Work task-by-task; do not batch.

**Goal:** Create the private `@cockpit/core` package and move the driver-agnostic daemon/control-plane core into it, so `core` depends on `@cockpit/shared` only and the compiler (TS project references) enforces `core ↛ root`. The host `cockpitd.ts` and all concrete drivers stay in the root package (they move to `agents`/`workspaces` in Step 5).

**Architecture:** Behavior-preserving. Four `core → root` back-edges (discovered in 4b prep) are resolved by **relocating mis-filed pure logic into its proper home** — none need interface inversion. `cockpitd.ts` keeps its filename as the bin/launchd entry, so `dist/cockpitd.js`, the launchd plist, and the tsup `cockpitd` entry are all unchanged; the host simply repoints its imports to `@cockpit/core` (root → core is the correct DAG direction). tsup inlines `@cockpit/core` into the published bundle exactly as it already inlines `@cockpit/shared`.

**Tech Stack:** TypeScript (NodeNext ESM, `moduleResolution: bundler` per package), pnpm workspaces, tsup, vitest, git.

## Global Constraints

- Platform: macOS-only. No cross-platform shims.
- NodeNext/bundler ESM: cross-package imports use the **bare specifier** `@cockpit/core` (no `.js`); intra-package relative imports keep `.js`. **The real runtime gate is `node dist/cockpitd.js` booting + serving the socket AND `node dist/index.js --help`** — not just tests.
- **Behavior-preserving move only.** No logic/feature/signature changes. The existing suite is the safety net; every task ends with the **full suite == develop baseline** (1272 pass / **3 known pre-existing #353 relay-proxy failures** — `relay-proxy-poll pending probes`, `(c) dead surface reaped`, `in-flight dedup`; verified identical on clean develop, do NOT treat as regressions).
- **`core` depends on `@cockpit/shared` ONLY.** `tsc -b` (project references) is the hard boundary gate — any `core → root`/`commands`/concrete-driver import fails the build.
- **`@cockpit/core` is a `devDependency` of root** (bundled/inlined by tsup, like `@cockpit/shared`), NOT a runtime `dependency` — else end-user `npm i claude-cockpit` breaks (the Step-3 publish-dep lesson).
- **Daemon-boot smoke MUST override `sockPath`** to a temp path — never bind the real `~/.config/cockpit/cockpit.sock`. Never run bare `node dist/cockpitd.js` raw (its entry guard binds the real socket); boot via an import with `{ sockPath: <temp>, sweepMs: 0, rotationIntervalMs: 0 }`.
- **Clean-room CI gate** (the Step-3 lesson — local-green hid 3 defects): the final gate runs the exact CI command (`pnpm i --frozen-lockfile && pnpm run build && pnpm test`) WITHOUT hand-pre-building any package.
- Branch off `develop`. PR to `develop`. Do NOT self-merge (captain reviews). Do NOT `--dangerously-skip-permissions`.
- Do NOT touch the live daemon, live `~/.config/cockpit/config.json`, or restart cmux.

## Scope: what moves, what stays

**MOVES to `packages/core/src/` (the daemon-core closure):**
- Top-level: `daemon.ts`, `mailbox.ts`, `protocol.ts`, `state-machine.ts`, `liveness.ts`, `watchdog.ts`, `store.ts`, `snapshot.ts`, `launchd.ts`, `relay-healer.ts`, `crew-pane-reader.ts`, `interfaces.ts`
- Subtrees: `daemon/` (the 8 4a modules), `delivery/` (`captain-delivery.ts` + tests)
- Relocated back-edge deps (see Task 4): `codex/gate.ts` → `core/gate.ts`; `DeferDelivery` (from `runtimes/cmux.ts`) → `core/delivery/defer-delivery.ts`; `createInteractiveProbe` + `STALE_THRESHOLD_MS` (from `commands/notify-relay.ts`) → `core/daemon/interactive-probe.ts`

**STAYS in root** (moves in Step 5/7, verified not imported by core):
- Host `cockpitd.ts`; concrete drivers `codex/` (minus `gate.ts`), `opencode/`, `cmux/`, `interactive/`, `headless/`, `headless-launcher.ts`, `runtimes/`
- **`notifiers/` + `projection/`** — driver-coupled (cmux notifier; per-agent emitters), NOT core; no core module imports them. Deferred to Step 5.
- **`relay-supervisor.ts`, `relay-supervisor-loop.ts`, `relay-log-broadcaster.ts`, `crew-routing.ts`** — verify in Task 3 Step 1 that core does not import them; if confirmed (expected: they are cli/command-side), they stay root and move with `cli` in Step 7.

**Repoint blast radius (verified 2026-06-17):** ~17 root files import the moved control modules; +7 files import `DeferDelivery`; `daemon/attach.ts` imports `gate`; `commands/notify-relay.ts` is the probe-helper home. All repoint to `@cockpit/core`.

---

### Task 1: Move `PaneRef` (+ runtime types) into `@cockpit/shared`

`src/runtimes/types.ts` is a **pure type module** (zero imports): `WorkspaceRef`, `PaneRef`, `RuntimeSpawnOptions`, `PanePlacement`, `RuntimePaneOptions`, `RuntimeProbeResult`, `RuntimeDriver`. `core` (`daemon/context.ts`, `daemon/delivery.ts`) needs `PaneRef`. Move the whole module to shared; leave a re-export shim so root consumers don't churn.

**Files:**
- Create: `packages/shared/src/types/runtime.ts` (the moved content)
- Modify: `packages/shared/src/index.ts` (re-export the runtime types), `src/runtimes/types.ts` (becomes a shim: `export * from "@cockpit/shared";` limited to these types — or re-export the moved names)
- Test: existing type usage compiles.

**Interfaces:**
- Produces: `@cockpit/shared` now exports `PaneRef`, `WorkspaceRef`, `RuntimeDriver`, etc.
- Consumes: nothing new.

- [ ] **Step 1:** Move the contents of `src/runtimes/types.ts` into `packages/shared/src/types/runtime.ts`; export from `packages/shared/src/index.ts`.
- [ ] **Step 2:** Replace `src/runtimes/types.ts` body with a re-export of those names from `@cockpit/shared` (keeps every existing `../runtimes/types.js` importer working untouched).
- [ ] **Step 3:** `pnpm run build && pnpm test`. Expected: `tsc -b` clean; suite == baseline.
- [ ] **Step 4:** Commit: `git commit -am "refactor(4b): move runtime types (PaneRef et al) to @cockpit/shared"`.

---

### Task 2: Scaffold the empty `@cockpit/core` package

**Files:**
- Create: `packages/core/package.json` (`name: @cockpit/core`, `private: true`, `type: module`, `exports` → `./dist/index.js` + `types`, `dependencies: { "@cockpit/shared": "workspace:*" }`)
- Create: `packages/core/tsconfig.json` (`composite: true`, `outDir: dist`, `references: [{ "path": "../shared" }]`, `moduleResolution: bundler` matching shared)
- Create: `packages/core/src/index.ts` (empty barrel for now: `export {};`)
- Create: `packages/core/README.md` (Purpose / Owns / Public interface / Depends on (shared) / Doesn't belong here (concrete drivers, cli, web))
- Modify: root `tsconfig.json` (add `{ "path": "packages/core" }` to `references`)
- Modify: root `package.json` (add `"@cockpit/core": "workspace:*"` to **devDependencies**; update `build` if needed so `tsc -b` builds core before tsup — current `build` is `tsc -b --force packages/shared && tsup`; change to `tsc -b --force packages/shared packages/core && tsup`)

**Interfaces:**
- Produces: a buildable empty `@cockpit/core`.
- Consumes: `@cockpit/shared`.

- [ ] **Step 1:** Create the four `packages/core/*` files above (mirror `packages/shared`'s `package.json`/`tsconfig.json` shape exactly — same `moduleResolution`, same `exports` pattern).
- [ ] **Step 2:** Wire root `tsconfig.json` references + root `package.json` devDependency + `build` script (prebuild shared **and** core before tsup — the Step-3 build-ordering lesson).
- [ ] **Step 3:** `pnpm i` (link the new workspace package), then `pnpm run build && pnpm test`. Expected: core builds to an empty `dist`; suite == baseline (nothing imports core yet).
- [ ] **Step 4:** Commit: `git commit -am "scaffold(4b): empty @cockpit/core package (refs shared)"`.

---

### Task 3: Move the daemon-core closure into `@cockpit/core` (the heavy task)

This is one cohesive move — the build is not green mid-move (moved files importing still-in-root deps fail `tsc -b`), so it ends on a single green checkpoint. Move leaf deps first, then dependents, then repoint consumers.

**Files (move via `git mv`, preserving history):**
- `src/control/{daemon.ts,mailbox.ts,protocol.ts,state-machine.ts,liveness.ts,watchdog.ts,store.ts,snapshot.ts,launchd.ts,relay-healer.ts,crew-pane-reader.ts,interfaces.ts}` → `packages/core/src/`
- `src/control/daemon/` → `packages/core/src/daemon/`
- `src/control/delivery/` → `packages/core/src/delivery/`
- Their `__tests__` move with them.

**Interfaces:**
- Produces: `@cockpit/core` exports (via `packages/core/src/index.ts` barrel) `startCockpitd`/`startDaemon` glue is NOT here — the host stays in root and imports the **pieces** it needs. Export from core's barrel exactly what root currently imports across the ~17 sites (enumerate by grepping the importers; e.g. `createDaemon`, `createStore`, `startServer`, `assembleDaemonSnapshot`, `projectHealth`, mailbox fns, `interfaces` types, `CaptainDelivery`, the `daemon/*` factories that the host wires).
- Consumes: `@cockpit/shared` only.

- [ ] **Step 1: Confirm the stay-in-root set is not imported by the move set.** Run:
```bash
git grep -nE "from \"(\.\.?/)+(relay-supervisor|relay-log-broadcaster|crew-routing|notifiers|projection)" -- src/control/daemon src/control/delivery src/control/daemon.ts src/control/mailbox.ts src/control/snapshot.ts src/control/liveness.ts
```
Expected: **no output**. If anything prints, STOP and report — that module also needs moving or the edge needs inverting.
- [ ] **Step 2: `git mv` the move-set** into `packages/core/src/` (top-level files, `daemon/`, `delivery/`, with their `__tests__`). Intra-set relative imports keep working (relative paths preserved). Imports of `@cockpit/shared` already bare — fine.
- [ ] **Step 3: Create `packages/core/src/index.ts` barrel** exporting every symbol the root importers consume (derive the list from `git grep` of the ~17 importers before deleting old paths).
- [ ] **Step 4: Repoint the ~17 root importers + host `cockpitd.ts`** from `../control/<mod>.js` / `./daemon/*.js` etc. to `@cockpit/core`. The host `cockpitd.ts` now imports `startDaemon`/factories/`buildContext`/`CockpitdOpts` from `@cockpit/core`.
- [ ] **Step 5: `tsc -b`** — expect failures only at the 3 remaining back-edges (gate, DeferDelivery, notify-relay probes). Those are fixed in Task 4. (If you prefer a single green checkpoint, fold Task 4 into this task before building — but commit them as separate logical steps.)
- [ ] **Step 6:** After Task 4's back-edge fixes, run `pnpm run build && pnpm test` + the runtime gates. Expected: green, suite == baseline.
- [ ] **Step 7:** Commit: `git commit -am "refactor(4b): move daemon-core closure into @cockpit/core"`.

---

### Task 4: Resolve the 3 remaining back-edges (relocate into core)

Each is pure logic mis-filed in a driver/command folder. Move it to core; the former host imports it back from `@cockpit/core` (root → core, correct direction).

**4a. `gate.ts` (generic HITL gate primitive — only imports `Gate` from shared, zero codex deps).**
- `git mv src/control/codex/gate.ts packages/core/src/gate.ts` (+ its tests). Export from core barrel.
- Repoint `daemon/attach.ts` (now in core) to the intra-core path; repoint any other `codex/gate.js` importer to `@cockpit/core`. Verify: `git grep -n "codex/gate" -- src` → no output.

**4b. `DeferDelivery` (delivery-control signal, defined + thrown in `runtimes/cmux.ts`, imported by 7 files incl. core + root).**
- Extract `class DeferDelivery` from `src/runtimes/cmux.ts` into `packages/core/src/delivery/defer-delivery.ts`; export from core barrel.
- Repoint all 7 importers to `@cockpit/core`: `runtimes/cmux.ts` (root → core), `control/cmux/daemon-cmux.ts`, `delivery/captain-delivery.ts` (now in core — intra-core path), and the 4 test files. Verify: `git grep -nE "DeferDelivery" -- src | grep -v "@cockpit/core"` shows only the moved definition's consumers via the new path.

**4c. `createInteractiveProbe` + `STALE_THRESHOLD_MS` (daemon-probe logic living in the `notify-relay` command).**
- Move both into `packages/core/src/daemon/interactive-probe.ts`; export from core barrel.
- `src/commands/notify-relay.ts` imports them **back** from `@cockpit/core`. Repoint `daemon/probes.ts` + `daemon/delivery.ts` (now in core) to the intra-core path. Verify: `git grep -nE "commands/notify-relay" -- packages/core` → no output.

- [ ] **Step 1:** Do 4a, 4b, 4c (each: move, repoint, grep-verify no residual back-edge).
- [ ] **Step 2:** `tsc -b` — expect **clean** now (boundary satisfied). Then `pnpm run build && pnpm test`. Expected: green, suite == baseline.
- [ ] **Step 3:** Commit: `git commit -am "refactor(4b): relocate gate + DeferDelivery + interactive-probe into core (fix back-edges)"`.

---

### Task 5: Verify the boundary, the bundle, the daemon, and open the PR

- [ ] **Step 1: Boundary gate.** `git grep -nE "from \"(\.\.?/)+(commands|runtimes|codex|opencode|cmux|interactive|headless|dashboard|notifiers|projection)" -- packages/core/src`. Expected: **no output** (core imports only `@cockpit/shared` + intra-core relatives). `tsc -b` re-confirms.
- [ ] **Step 2: Clean-room CI** (do NOT hand-pre-build): `git stash -u` any cruft, then `pnpm i --frozen-lockfile && pnpm run build && pnpm test`. Expected: build ordering resolves (shared → core → tsup); suite == baseline (3 #353 only).
- [ ] **Step 3: Runtime gates.** `node dist/index.js --help` works; daemon boots via an import with a **temp `sockPath`** (`sweepMs:0`, `rotationIntervalMs:0`), binds the temp socket, stops cleanly. Confirm `dist/cockpitd.js` still exists at the same path (launchd/tsup entry unchanged).
- [ ] **Step 4: Tarball gate** (re-proves `pkgRoot` reads survive + the bundle is self-contained): `pnpm pack`, install the tarball in a temp dir, run `cockpit --help` + a `runtime-sync` (templates/plugin/scripts land in a temp `~/.config/cockpit`). Expected: works; no `@cockpit/*` resolution error (inlined by tsup).
- [ ] **Step 5:** Finalize `packages/core/README.md`. Push + open PR to `develop`:
```bash
git push -u origin HEAD
gh pr create --base develop --title "Reorg 4b: extract @cockpit/core (move daemon-core closure)" \
  --body "Part of the monorepo reorg (docs/superpowers/specs/2026-06-17-monorepo-reorg-step4-extract-core-design.md), rollout step 4b.

- Create private @cockpit/core (deps: @cockpit/shared only; devDep of root, bundled by tsup).
- Move daemon-core closure (daemon.ts, daemon/, delivery/, mailbox/protocol/state-machine/liveness/watchdog/store/snapshot/launchd/relay-healer/crew-pane-reader/interfaces) into core.
- Fix 4 back-edges by relocating mis-filed pure logic: PaneRef -> shared; gate.ts + DeferDelivery + interactive-probe -> core.
- Host cockpitd.ts + concrete drivers STAY in root (Step 5). Entry filename unchanged -> dist/cockpitd.js, launchd plist, tsup entry untouched.
- notifiers/ + projection/ deferred to Step 5 (driver-coupled). No behavior change.

tsc -b enforces core not-> root. Verified: clean-room pnpm build + test == develop baseline (3 known #353 flakes); node dist/cockpitd.js boots (temp sock); tarball installs + runtime-syncs."
```
- [ ] **Step 6:** `cockpit crew signal done`.

---

## Self-Review

**Spec coverage** (against `2026-06-17-monorepo-reorg-step4-extract-core-design.md`, 4b section):
- Create `packages/core`, deps shared only → Task 2. ✓
- Move daemon-core closure → Task 3. ✓
- Host stays root, repoints to core, entry unchanged → Task 3 Step 4. ✓
- Fix `notify-relay` back-edge → Task 4c. ✓ (Plus 3 more back-edges 4b-prep found: gate, DeferDelivery, PaneRef — Tasks 1/4a/4b.)
- `tsc -b` enforces boundary; tarball + socket-overridden daemon boot gates → Task 5. ✓
- `@cockpit/core` as devDep (publish-safe) → Task 2 + Global Constraints. ✓

**Placeholder scan:** No TBD/TODO; every move names exact files, every back-edge names its relocation + a grep-verify. The one judgment call (relay-supervisor*/crew-routing stay-or-move) is gated by an explicit grep in Task 3 Step 1, not left vague. ✓

**Type consistency:** `PaneRef` moves to shared (Task 1) and is consumed from `@cockpit/shared` everywhere after; `DeferDelivery`/`gate`/`interactive-probe` consumed from `@cockpit/core` after Task 4; the core barrel (`packages/core/src/index.ts`) is the single export surface the host + ~17 importers consume. ✓

**Scope correction (recorded):** `notifiers/` + `projection/` are NOT moved in 4b despite the master spec's mapping — import analysis shows they are driver-coupled and not imported by core. Deferred to Step 5. This avoids dragging driver code into core and creating fresh back-edges.

**Out of scope (Step 5+):** moving concrete drivers (`codex`/`opencode`/`cmux`/`interactive`/`headless`/`runtimes`) into `agents`/`workspaces`; `notifiers`/`projection`; `dashboard` → `web`; `commands` grouping. No behavior change rides along.
