# Step 5b — Extract `@cockpit/workspaces` Implementation Plan

> **✅ Shipped** (PR #361, 2026-06-18). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the cmux runtime driver, obsidian workspace driver, cmux notifier, and the daemon↔cmux bridge into a new private workspace package `@cockpit/workspaces`, behind interfaces that already live in `@cockpit/shared`/`@cockpit/core`, with zero changes to `core`/`shared` and zero new test failures.

**Architecture:** A **package move**, mirroring 5a. `git mv` four directories (`runtimes/`, `workspaces/`, `notifiers/`, `control/cmux/`) into `packages/workspaces/src/`, scaffold the package like `@cockpit/core`, wire it into root build/tsconfig/tsup, and repoint ~18 consumer files from relative imports to `@cockpit/workspaces`. Internal `./` imports inside moved dirs are within-dir (the 5a pattern) so they survive unchanged. The "test cycle" is build + boundary grep + the existing vitest suite at baseline (exactly 3 known `relay-proxy.test.ts` failures, #353), **plus a delivery smoke** because this package owns the live `daemonDirectCmux` path.

**Tech Stack:** pnpm workspaces, TypeScript project references (`tsc -b`), tsup (ESM bundle), vitest. NodeNext-style ESM — every relative import carries a `.js` extension.

## Global Constraints

- **Package name:** `@cockpit/workspaces`, `private: true`, `version: 0.0.0`, `type: module` — mirror `packages/core/package.json` exactly.
- **Dependency direction:** `@cockpit/workspaces` may import only `@cockpit/core`, `@cockpit/shared`, and `node:` builtins. ZERO imports of `@cockpit/agents`, commands, lib, cockpitd, crew-routing, relay-*. (All verified absent today — the move must not introduce any.)
- **`core` and `shared` are frozen:** no file under `packages/core/` or `packages/shared/` changes.
- **Entry filenames never move:** `src/index.ts` and `src/control/cockpitd.ts` stay as the tsup entries / bin / launchd daemon.
- **Keep subdir names:** move `workspaces/`→`workspaces/` (do NOT rename to `vault/`), `runtimes/`→`runtimes/`, `notifiers/`→`notifiers/`, `control/cmux/`→`cmux/`. Renaming expands the diff and breaks consumer deep-imports.
- **ESM `.js` extensions:** every relative import in moved/edited TS ends in `.js`. The real gate is `node dist/index.js --help`, not just `tsc`.
- **Test baseline:** `pnpm test` ends with exactly 3 failing files, all `relay-proxy.test.ts` (#353). Any other failure blocks.
- **Live delivery path:** `cmux/daemon-cmux.ts` + `cmux/events-bridge.ts` own `daemonDirectCmux` delivery — verify the daemon still delivers after the move (Task 5).
- **macOS-only:** platform-guarded tests stay guarded.

---

### Task 1: Scaffold `@cockpit/workspaces` package + root wiring (empty shell)

Create the buildable empty shell and wire root configs BEFORE moving content, keeping the build green incrementally.

**Files:**
- Create: `packages/workspaces/package.json`, `packages/workspaces/tsconfig.json`, `packages/workspaces/src/index.ts`, `packages/workspaces/README.md`
- Modify: root `tsconfig.json`, root `package.json`, `tsup.config.ts`

- [ ] **Step 1: Create `packages/workspaces/package.json`**

```json
{
  "name": "@cockpit/workspaces",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -b" },
  "dependencies": {
    "@cockpit/core": "workspace:*",
    "@cockpit/shared": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `packages/workspaces/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true
  },
  "references": [{ "path": "../shared" }, { "path": "../core" }],
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/workspaces/src/index.ts`** (empty barrel; content tasks fill it)

```ts
// @cockpit/workspaces — environment/surface seam (cmux runtime · obsidian vault · cmux notifier).
// Barrel is populated as modules move in (runtimes, workspaces, notifiers, cmux bridge).
export {};
```

- [ ] **Step 4: Create `packages/workspaces/README.md`**

```markdown
# @cockpit/workspaces

The **environment / surface seam**: where agents run (cmux RuntimeDriver), where knowledge
lives (obsidian WorkspaceDriver), how the human is notified (cmux NotifierDriver), and the
daemon↔cmux bridge.

Depends only on `@cockpit/core` and `@cockpit/shared`. Adding a new surface (tmux/zed) is a
new folder here plus one wiring line in the host/cli — no `core` change.
```

- [ ] **Step 5: Wire root `tsconfig.json`** — append reference + path (keep shared/core/agents entries)

In `references`, append `{ "path": "packages/workspaces" }`. In `compilerOptions.paths`, add:
```json
"@cockpit/workspaces": ["./packages/workspaces/src/index.ts"]
```

- [ ] **Step 6: Wire root `package.json`** — add devDep + extend build script

Add `"@cockpit/workspaces": "workspace:*"` to `devDependencies`. Change the `build` script to prebuild the new package:
```
"build": "tsc -b --force packages/shared packages/core packages/agents packages/workspaces && tsup",
```

- [ ] **Step 7: Wire `tsup.config.ts`** — inline-resolve `@cockpit/workspaces`

Add after the existing dist consts:
```ts
const workspacesDist = path.resolve(__dirname, "packages/workspaces/dist/index.js");
```
Add inside `inlinePackagesPlugin.setup`:
```ts
build.onResolve({ filter: /^@cockpit\/workspaces$/ }, () => ({
  path: workspacesDist,
}));
```
Add `"@cockpit/workspaces"` to the `noExternal` array.

- [ ] **Step 8: Install + build + smoke** (gate)

```bash
pnpm install && pnpm build && node dist/index.js --help >/dev/null && echo "CLI OK"
```
Expected: install resolves the new workspace; `tsc -b` compiles shared → core → agents → workspaces (empty); tsup bundles; CLI help works.

- [ ] **Step 9: Commit**

```bash
git add packages/workspaces tsconfig.json package.json tsup.config.ts pnpm-lock.yaml
git commit -m "reorg 5b: scaffold @cockpit/workspaces package + root wiring (empty shell)"
```

---

### Task 2: Move `runtimes/` and `notifiers/` into `@cockpit/workspaces`

The two top-level `src/` driver dirs (RuntimeDriver + NotifierDriver). Same pattern.

**Files:**
- Move: `src/runtimes/` → `packages/workspaces/src/runtimes/`
- Move: `src/notifiers/` → `packages/workspaces/src/notifiers/`
- Modify: `packages/workspaces/src/index.ts` (extend barrel)
- Modify: consumers importing `../runtimes/…` or `../notifiers/…`

- [ ] **Step 1: Move with git (preserves history + `__tests__`)**

```bash
git mv src/runtimes packages/workspaces/src/runtimes
git mv src/notifiers packages/workspaces/src/notifiers
```

- [ ] **Step 2: Confirm internal imports intact** — within-dir `./` + `@cockpit/*` only

```bash
grep -rEn "from ['\"]\.\./" packages/workspaces/src/runtimes packages/workspaces/src/notifiers | grep -v "@cockpit"
```
Expected: empty (all relative refs are `./same-dir`). Confirm `runtimes/types.ts` still re-exports from `@cockpit/shared` (not a dangling relative path).

- [ ] **Step 3: Extend the barrel** — re-export the public API consumers use

Discover the surface:
```bash
grep -rhoE "from ['\"][^'\"]*(runtimes|notifiers)/[^'\"]+" src | sort -u
```
Then extend `packages/workspaces/src/index.ts` based on the existing barrels (`runtimes/index.ts`, `notifiers/index.ts`):
```ts
export * from "./runtimes/index.js";
export * from "./notifiers/index.js";
```
(Add explicit deep re-exports only if a consumer imports a path the sub-barrel doesn't surface.)

- [ ] **Step 4: Repoint consumers**

```bash
grep -rln "from ['\"].*/\(runtimes\|notifiers\)/" src | grep -v "__tests__"
```
Replace each relative import (`../runtimes/index.js`, `../../notifiers/registry.js`, etc.) with `@cockpit/workspaces`. Ensure every symbol used is surfaced by Step 3's barrel.

- [ ] **Step 5: Build + boundary check** (gate)

```bash
pnpm build && node dist/index.js --help >/dev/null && echo "CLI OK"
grep -rEn "from ['\"]@cockpit/agents|from ['\"](\.\./)+(commands|lib)/|control/cockpitd|crew-routing|relay-" packages/workspaces/src/runtimes packages/workspaces/src/notifiers | grep -v "__tests__"
```
Expected: build green; CLI OK; boundary grep **empty**.

- [ ] **Step 6: Test suite at baseline** (gate)

```bash
pnpm test 2>&1 | tail -20
```
Expected: only the 3 `relay-proxy.test.ts` baseline failures.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "reorg 5b: move runtimes/ + notifiers/ into @cockpit/workspaces"
```

---

### Task 3: Move `workspaces/` (obsidian) and `control/cmux/` (bridge)

The WorkspaceDriver (obsidian) and the daemon↔cmux bridge. Keep the `workspaces/` subdir name; flatten `control/cmux/` → `cmux/`.

**Files:**
- Move: `src/workspaces/` → `packages/workspaces/src/workspaces/`
- Move: `src/control/cmux/` → `packages/workspaces/src/cmux/`
- Modify: `packages/workspaces/src/index.ts` (extend barrel)
- Modify: consumers importing `../workspaces/…` or `../control/cmux/…`

- [ ] **Step 1: Move with git**

```bash
git mv src/workspaces packages/workspaces/src/workspaces
git mv src/control/cmux packages/workspaces/src/cmux
```

- [ ] **Step 2: Confirm internal imports intact**

```bash
grep -rEn "from ['\"]\.\./" packages/workspaces/src/workspaces packages/workspaces/src/cmux | grep -v "@cockpit"
```
Expected: empty. Any `../control/…` or other cross-dir ref that prints must be repathed to its new location under `packages/workspaces/src/` (e.g. a ref to the moved `runtimes/` is now a sibling — `../runtimes/...` resolves; verify by build).

- [ ] **Step 3: Extend the barrel**

Discover the surface:
```bash
grep -rhoE "from ['\"][^'\"]*workspaces/[^'\"]+" src | sort -u
grep -rhoE "from ['\"][^'\"]*control/cmux/[^'\"]+" src | sort -u
```
Extend `packages/workspaces/src/index.ts`:
```ts
export * from "./workspaces/index.js";
export { /* daemon-cmux + events-bridge factory symbols the host imports */ } from "./cmux/daemon-cmux.js";
export * from "./cmux/events-bridge.js";
```
Match the exact symbol set consumers/host reference — do not over-export.

- [ ] **Step 4: Repoint consumers**

```bash
grep -rln "from ['\"].*\(/workspaces/\|control/cmux\)" src | grep -v "__tests__"
```
Replace each relative import with `@cockpit/workspaces`. The host `src/control/cockpitd.ts` imports the cmux bridge — repoint it too.

- [ ] **Step 5: Build + boundary check** (gate)

```bash
pnpm build && node dist/index.js --help >/dev/null && echo "CLI OK"
grep -rEn "from ['\"]@cockpit/agents|from ['\"](\.\./)+(commands|lib)/|control/cockpitd|crew-routing|relay-" packages/workspaces/src | grep -v "__tests__"
```
Expected: build green; CLI OK; boundary grep **empty**.

- [ ] **Step 6: Confirm `src/` is down to cli/web only**

```bash
ls src/ && ls src/control/
```
Expected `src/`: `commands/ lib/ dashboard/ index.ts control/ config.test.ts`. Expected `src/control/`: `cockpitd.ts crew-routing.ts relay-*.ts __tests__/` — no `cmux/ runtimes/ workspaces/ notifiers/`.

- [ ] **Step 7: Test suite at baseline** (gate)

```bash
pnpm test 2>&1 | tail -20
```
Expected: only the 3 `relay-proxy.test.ts` baseline failures.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "reorg 5b: move workspaces/ (obsidian) + control/cmux/ bridge into @cockpit/workspaces"
```

---

### Task 4: Full validation battery + boundary proof

**Files:** none modified (verification only)

- [ ] **Step 1: Refined boundary grep (path-anchored — avoid the 4b false positive)**

```bash
grep -rEn "from ['\"]" packages/workspaces/src \
 | grep -v "from ['\"]\.\.*/" \
 | grep -vE "from ['\"]@cockpit/(core|shared)['\"]" \
 | grep -vE "from ['\"]node:" \
 | grep -v "__tests__"
```
Expected: empty. Every non-relative import is `@cockpit/core`, `@cockpit/shared`, or `node:`. (Crucially: zero `@cockpit/agents`.)

- [ ] **Step 2: Confirm core/shared frozen**

```bash
git diff --stat develop -- packages/core packages/shared
```
Expected: empty (no diff).

- [ ] **Step 3: Clean-room frozen install + full build**

```bash
pnpm install --frozen-lockfile && pnpm build
```
Expected: frozen install succeeds; `tsc -b` compiles shared → core → agents → workspaces; tsup bundles. No errors.

- [ ] **Step 4: Full test suite — confirm baseline**

```bash
pnpm test 2>&1 | tail -25
```
Expected: exactly 3 failing files, all `relay-proxy.test.ts` (#353). Record the count.

- [ ] **Step 5: Tarball gate** (absolute path captured before cd)

```bash
TARBALL="$(pnpm pack | tail -1)"; TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
TMP="$(mktemp -d)"; cd "$TMP"; npm init -y >/dev/null 2>&1
npm install "$TARBALL" >/dev/null 2>&1
node node_modules/.bin/cockpit --help 2>&1 | head -3
```
Expected: install succeeds; `cockpit --help` prints.

- [ ] **Step 6: Commit (if Task 1's lockfile changed during clean install)**

```bash
git add -A && git diff --cached --quiet || git commit -m "reorg 5b: lockfile sync"
```

---

### Task 5: Delivery smoke — the live `daemonDirectCmux` path (NEW vs 5a)

This package owns daemon→cmux delivery. A compile-green move can still break delivery silently. Prove the rebuilt daemon still delivers a lifecycle event to the surface.

**Files:** none modified (runtime verification only)

- [ ] **Step 1: Socket-safe daemon boot**

Boot the daemon against a temp socket path with `rotationIntervalMs: 0` and `sweepMs: 0` (the documented harness — import `startCockpitd`/`startDaemon` with an overridden `sockPath`; never run bare `node dist/cockpitd.js`, which binds the REAL socket). Confirm it binds and responds to a status request.

- [ ] **Step 2: Delivery assertion**

Using the same temp-socket daemon, drive a minimal lifecycle event through the moved cmux bridge (`cmux/daemon-cmux.ts` + `events-bridge.ts`) and assert it projects to the surface — i.e. the `daemonDirectCmux` delivery path that 5b just relocated still functions. Reuse the existing cmux/daemon-cmux test harness if one exists (`packages/workspaces/src/cmux/__tests__/`); otherwise assert via the daemon's delivery log/probe.

- [ ] **Step 3: Tear down**

Shut down the temp-socket daemon cleanly. Confirm no orphan cockpitd / node test workers remain:
```bash
pgrep -fl "cockpitd|vitest" | grep -v "com.cockpit.daemon" || echo "no orphans"
```
(The launchd `com.cockpit.daemon` is the real one — leave it alone.)

- [ ] **Step 4: Final verification summary**

Confirm and report to the captain:
- `src/runtimes/`, `src/workspaces/`, `src/notifiers/`, `src/control/cmux/` no longer exist.
- `packages/workspaces/` exists with `package.json` + `README.md` + populated `src/index.ts`.
- All 8 gates passed incl. delivery smoke; suite at the 3-failure baseline; core/shared frozen.
- `git log --oneline` shows the 3 reorg-5b commits (+ optional lockfile-sync).
- No orphan processes; the real launchd daemon untouched.

(No commit — verification only. Captain reviews, squash-merges `--admin`, then `git reset --hard origin/develop`.)

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Scope table (runtimes / notifiers / workspaces / control-cmux) → Tasks 2 + 3.
- Dependencies & interface (workspaces → core + shared only; registries stay; barrel; ~18 repoints) → Task 1 (wiring) + Tasks 2–3 (barrel + repoint).
- Risks (live delivery path, naming collision, runtimes/types re-export, NotifierDriver interface) → boundary greps in Tasks 2/3/4 + delivery smoke in Task 5.
- Validation gates 1–8 → Tasks 2/3 (incremental) + Task 4 (full battery) + Task 5 (delivery smoke, the 5b-specific weight).
- PR shape / step-5-complete → Task 5 Step 4.

**Placeholder scan** — no TBD/TODO. Barrel re-export symbol sets are discovered via explicit grep commands (Tasks 2/3) rather than guessed, because the precise public surface must be read from live consumer imports. The delivery-smoke harness (Task 5 Step 2) references the existing cmux/daemon-cmux test harness with a documented fallback — method fully specified.

**Type consistency** — no new types; this is a move. Package name `@cockpit/workspaces`, build-script package list, and tsup `noExternal` entry are identical strings across Tasks 1–4. Subdir names (`runtimes/ notifiers/ workspaces/ cmux/`) are consistent between the move commands and the boundary/`ls` checks.
