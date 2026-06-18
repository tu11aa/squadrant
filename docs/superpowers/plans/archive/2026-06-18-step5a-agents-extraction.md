# Step 5a — Extract `@cockpit/agents` Implementation Plan

> **✅ Shipped** (PR #358, 2026-06-18). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every AI-agent-specific driver/control/projection module into a new private workspace package `@cockpit/agents`, behind interfaces that already live in `@cockpit/core`, with zero changes to `core` and zero new test failures.

**Architecture:** This is a **package move**, not feature work. `git mv` the agents-candidate directories into `packages/agents/src/` (flattening the `control/` prefix), scaffold the package to mirror `@cockpit/core`, wire it into the root build/tsconfig/tsup configs, and repoint the ~11 consumer files from relative imports to `@cockpit/agents`. Internal `./` imports inside the moved dirs are unchanged (all cross-dir refs are within-same-dir — verified). The "test cycle" for each task is **the build + boundary grep + the existing vitest suite staying at its baseline** (exactly 3 known relay-proxy failures, #353), not new unit tests.

**Tech Stack:** pnpm workspaces, TypeScript project references (`tsc -b`), tsup (ESM bundle), vitest. NodeNext-style ESM — every relative import carries a `.js` extension.

## Global Constraints

- **Package name:** `@cockpit/agents`, `private: true`, `version: 0.0.0`, `type: module` — mirror `packages/core/package.json` exactly.
- **Dependency direction:** `@cockpit/agents` may import only `@cockpit/core`, `@cockpit/shared`, and `node:` builtins. ZERO imports of cmux / workspaces / notifiers / runtimes / lib / commands / cockpitd / relay / crew-routing. (All verified absent today — the move must not introduce any.)
- **`core` is frozen:** no file under `packages/core/` or `packages/shared/` changes in this step.
- **Entry filenames never move:** `src/index.ts` and `src/control/cockpitd.ts` stay as the tsup entries / bin / launchd daemon. Do not relocate them.
- **ESM `.js` extensions:** every relative import in moved/edited TS must end in `.js`. The real gate is `node dist/index.js --help`, not just `tsc`.
- **Test baseline:** `pnpm test` must end with **exactly 3 failing files**, all in `relay-proxy.test.ts` (#353). Any other failure blocks the task.
- **macOS-only:** platform-guarded tests stay guarded; do not touch them.

---

### Task 1: Scaffold `@cockpit/agents` package + root wiring (empty shell)

Create the package as an empty-but-buildable shell and wire it into every root config, BEFORE moving any content. This keeps the build green incrementally and isolates "wiring is correct" from "content moved correctly".

**Files:**
- Create: `packages/agents/package.json`
- Create: `packages/agents/tsconfig.json`
- Create: `packages/agents/src/index.ts`
- Create: `packages/agents/README.md`
- Modify: `tsconfig.json` (root) — add project reference + path
- Modify: `package.json` (root) — add devDep + build script
- Modify: `tsup.config.ts` — add agents dist inline-resolve + noExternal

- [ ] **Step 1: Create `packages/agents/package.json`** (mirror core; agents depends on core + shared)

```json
{
  "name": "@cockpit/agents",
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

- [ ] **Step 2: Create `packages/agents/tsconfig.json`** (mirror core; reference shared + core)

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

- [ ] **Step 3: Create `packages/agents/src/index.ts`** (empty barrel for now — content tasks fill it)

```ts
// @cockpit/agents — AI-agent driver seam (claude · codex · opencode · gemini).
// Barrel is populated as modules move in (drivers, control, projection).
export {};
```

- [ ] **Step 4: Create `packages/agents/README.md`**

```markdown
# @cockpit/agents

The **AI-driver seam**: which AI runs (claude · codex · opencode · gemini), how it is
controlled (interactive / headless), and how its state is projected to external formats.

Depends only on `@cockpit/core` and `@cockpit/shared`. Adding a new agent is a new file
here plus one wiring line in the host/cli — no `core` change.
```

- [ ] **Step 5: Wire root `tsconfig.json`** — add the reference and path (keep existing shared/core entries)

In `references`, append `{ "path": "packages/agents" }`. In `compilerOptions.paths`, add:

```json
"@cockpit/agents": ["./packages/agents/src/index.ts"]
```

- [ ] **Step 6: Wire root `package.json`** — add devDep and extend the build script

In `devDependencies` add `"@cockpit/agents": "workspace:*"`. Change the `build` script from:

```
"build": "tsc -b --force packages/shared packages/core && tsup",
```
to:
```
"build": "tsc -b --force packages/shared packages/core packages/agents && tsup",
```

- [ ] **Step 7: Wire `tsup.config.ts`** — inline-resolve `@cockpit/agents` like the others

Add after the `coreDist` line:
```ts
const agentsDist = path.resolve(__dirname, "packages/agents/dist/index.js");
```
Add inside `inlinePackagesPlugin.setup`, alongside the shared/core `onResolve` blocks:
```ts
build.onResolve({ filter: /^@cockpit\/agents$/ }, () => ({
  path: agentsDist,
}));
```
Add `"@cockpit/agents"` to the `noExternal` array.

- [ ] **Step 8: Install + build** (gate: wiring is valid)

Run: `pnpm install && pnpm build`
Expected: install resolves the new workspace; `tsc -b` compiles shared → core → agents (agents empty); tsup emits `dist/index.js` + `dist/cockpitd.js`. No errors.

- [ ] **Step 9: Smoke the bin**

Run: `node dist/index.js --help`
Expected: CLI help prints (proves ESM resolution intact).

- [ ] **Step 10: Commit**

```bash
git add packages/agents tsconfig.json package.json tsup.config.ts pnpm-lock.yaml
git commit -m "reorg 5a: scaffold @cockpit/agents package + root wiring (empty shell)"
```

---

### Task 2: Move `drivers/` and `projection/` into `@cockpit/agents`

The two top-level `src/` dirs. Same move pattern; do both, then repoint consumers, then gate.

**Files:**
- Move: `src/drivers/` → `packages/agents/src/drivers/`
- Move: `src/projection/` → `packages/agents/src/projection/`
- Modify: `packages/agents/src/index.ts` (extend barrel)
- Modify: consumer files importing `../drivers/…` or `../projection/…` (repoint to `@cockpit/agents`)

- [ ] **Step 1: Move the directories with git (preserves history, includes `__tests__`)**

```bash
git mv src/drivers packages/agents/src/drivers
git mv src/projection packages/agents/src/projection
```

- [ ] **Step 2: Confirm no internal import broke** — moved files use `./` (within-dir) + `@cockpit/*` only

Run: `grep -rEn "from ['\"]\.\./" packages/agents/src/drivers packages/agents/src/projection | grep -v "@cockpit"`
Expected: empty (all relative imports are `./same-dir`, which still resolve). If anything prints, it is a cross-dir ref that needs repathing — fix it to the new location.

- [ ] **Step 3: Extend `packages/agents/src/index.ts` barrel** — re-export what consumers import

First discover the public surface consumers use:
```bash
grep -rhoE "from ['\"]\.\.?(/\.\.)*/(drivers|projection)/[^'\"]+" src | sort -u
```
Then replace the `export {};` placeholder with re-exports of the drivers + projection public API. Base it on the existing barrels (`packages/agents/src/drivers/index.ts`, `packages/agents/src/projection/index.ts`):

```ts
export * from "./drivers/index.js";
export * from "./projection/index.js";
```
(If a consumer imports a deep path not surfaced by those barrels, add an explicit re-export here rather than letting the consumer reach into `@cockpit/agents/dist/...`.)

- [ ] **Step 4: Repoint consumers** — change relative imports to the package name

Find them:
```bash
grep -rln "from ['\"].*/\(drivers\|projection\)/" src | grep -v "__tests__"
```
For each hit, replace the relative path (`../drivers/index.js`, `../../projection/registry.js`, etc.) with `@cockpit/agents`. If a consumer imported a deep symbol, ensure Step 3's barrel re-exports it, then import it from `@cockpit/agents`.

- [ ] **Step 5: Build + boundary check** (gate)

```bash
pnpm build && node dist/index.js --help
grep -rEn "from ['\"](\.\./)*(lib|commands|runtimes|workspaces|notifiers)/|cmux" packages/agents/src/drivers packages/agents/src/projection | grep -v "__tests__"
```
Expected: build green; CLI help prints; the boundary grep is **empty** (no forbidden edges).

- [ ] **Step 6: Test suite at baseline** (gate)

Run: `pnpm test 2>&1 | tail -20`
Expected: only the 3 known `relay-proxy.test.ts` files fail (#353). No new failures.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "reorg 5a: move drivers/ + projection/ into @cockpit/agents"
```

---

### Task 3: Move `control/{codex,opencode,interactive,headless}` + `headless-launcher.ts`

These live under `src/control/`; flatten the `control/` prefix on the way into `packages/agents/src/`. Internal `./` imports are within-dir (verified) so they survive the flatten unchanged.

**Files:**
- Move: `src/control/codex/` → `packages/agents/src/codex/`
- Move: `src/control/opencode/` → `packages/agents/src/opencode/`
- Move: `src/control/interactive/` → `packages/agents/src/interactive/`
- Move: `src/control/headless/` → `packages/agents/src/headless/`
- Move: `src/control/headless-launcher.ts` → `packages/agents/src/headless-launcher.ts`
- Modify: `packages/agents/src/index.ts` (extend barrel)
- Modify: consumers importing `../control/{codex,opencode,interactive,headless}/…` or `../control/headless-launcher.js`

- [ ] **Step 1: Move with git (flatten `control/` prefix)**

```bash
git mv src/control/codex packages/agents/src/codex
git mv src/control/opencode packages/agents/src/opencode
git mv src/control/interactive packages/agents/src/interactive
git mv src/control/headless packages/agents/src/headless
git mv src/control/headless-launcher.ts packages/agents/src/headless-launcher.ts
```

- [ ] **Step 2: Confirm internal imports intact** — within-dir `./` refs + `@cockpit/*` only

```bash
grep -rEn "from ['\"]\.\./" packages/agents/src/codex packages/agents/src/opencode packages/agents/src/interactive packages/agents/src/headless packages/agents/src/headless-launcher.ts | grep -v "@cockpit"
```
Expected: empty. Any `../control/…` or `../drivers/…` that prints must be repathed to its new agents-relative location (e.g. `../drivers/...` → it's a sibling now under `packages/agents/src/`, so `../drivers/...` still resolves; verify by build).

- [ ] **Step 3: Extend the barrel** — re-export the control factories consumers use

Discover what consumers import:
```bash
grep -rhoE "from ['\"][^'\"]*control/(codex|opencode|interactive|headless)[^'\"]*" src | sort -u
grep -rhoE "from ['\"][^'\"]*headless-launcher[^'\"]*" src | sort -u
```
Add the corresponding re-exports to `packages/agents/src/index.ts`, e.g.:
```ts
export * from "./codex/driver.js";
export * from "./opencode/sse-bridge.js";
export * from "./interactive/registry.js";
export * from "./headless/registry.js";
export { /* launcher symbols */ } from "./headless-launcher.js";
```
Match the exact symbol set the consumers reference — do not over-export. (If a sub-barrel like `interactive/registry.js` already aggregates, prefer re-exporting that.)

- [ ] **Step 4: Repoint consumers**

```bash
grep -rln "control/\(codex\|opencode\|interactive\|headless\)\|headless-launcher" src | grep -v "__tests__"
```
Replace each relative import with `@cockpit/agents`. Ensure every symbol a consumer used is surfaced by Step 3's barrel.

- [ ] **Step 5: Build + boundary check** (gate)

```bash
pnpm build && node dist/index.js --help
grep -rEn "from ['\"](\.\./)*(lib|commands|runtimes|workspaces|notifiers)/|/cmux/|control/cmux" packages/agents/src | grep -v "__tests__"
```
Expected: build green; CLI help prints; boundary grep **empty**.

- [ ] **Step 6: Confirm `src/control/` now holds only host/relay/routing (no agent dirs left)**

Run: `ls src/control/`
Expected: `cockpitd.ts`, `crew-routing.ts`, `relay-*.ts`, `cmux/`, `__tests__/` only. No `codex/ opencode/ interactive/ headless/ headless-launcher.ts`.

- [ ] **Step 7: Test suite at baseline** (gate)

Run: `pnpm test 2>&1 | tail -20`
Expected: only the 3 `relay-proxy.test.ts` baseline failures.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "reorg 5a: move control/{codex,opencode,interactive,headless} + headless-launcher into @cockpit/agents"
```

---

### Task 4: Full validation battery + cleanup

The per-task gates proved incremental health; this task runs the full 4a/4b battery end-to-end on the final state and refreshes the stale GitNexus index.

**Files:** none modified (verification + index refresh only)

- [ ] **Step 1: Refined boundary grep (path-anchored — avoid the 4b false positive)**

```bash
grep -rEn "from ['\"]" packages/agents/src \
 | grep -v "from ['\"]\.\.*/" \
 | grep -vE "from ['\"]@cockpit/(core|shared)['\"]" \
 | grep -vE "from ['\"]node:" \
 | grep -v "__tests__"
```
Expected: empty. Every non-relative import is `@cockpit/core`, `@cockpit/shared`, or `node:`. (Anchor on the import target, not a filename substring — the 4b false positive matched `interactive` inside `./interactive-probe.js`.)

- [ ] **Step 2: Clean-room frozen install + full build**

```bash
pnpm install --frozen-lockfile
pnpm build
```
Expected: frozen install succeeds (lockfile already updated in Task 1); `tsc -b` compiles shared → core → agents; tsup bundles. No errors.

- [ ] **Step 3: Socket-safe daemon boot** (temp socket, no rotation)

Boot the daemon against a temp socket path with `rotationIntervalMs: 0`, confirm it binds and serves, then shut it down. Use the same harness 4a/4b used (see `docs` handoff note — override socket path + `rotationIntervalMs:0`). Expected: daemon binds the Unix socket, responds to a status ping, exits cleanly.

- [ ] **Step 4: Full test suite — confirm baseline**

Run: `pnpm test 2>&1 | tail -25`
Expected: **exactly 3 failing files**, all `relay-proxy.test.ts` (#353). Record the count. Anything else blocks the merge.

- [ ] **Step 5: Tarball gate** (absolute path captured before any cd)

```bash
TARBALL="$(pnpm pack | tail -1)"; TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
TMP="$(mktemp -d)"; cd "$TMP"
npm init -y >/dev/null 2>&1
npm install "$TARBALL" >/dev/null 2>&1
node node_modules/.bin/cockpit --help 2>&1 | head -3
```
Expected: install succeeds; `cockpit --help` prints. (Capture the absolute tarball path BEFORE `cd` — pnpm pack prints a relative path.)

- [ ] **Step 6: Refresh the stale GitNexus index**

Run: `npx gitnexus analyze --embeddings`
Expected: completes; index no longer flagged stale.

- [ ] **Step 7: Final verification summary**

Confirm and report to the captain:
- `src/drivers/`, `src/projection/`, `src/control/{codex,opencode,interactive,headless}/`, `src/control/headless-launcher.ts` no longer exist.
- `packages/agents/` exists with `package.json` + `README.md` + populated `src/index.ts`.
- All 7 gates passed; test suite at the 3-failure baseline.
- `git log --oneline` shows the 3 reorg-5a commits.

(No commit — verification only. Captain reviews, squash-merges with `--admin`, then `git reset --hard origin/develop`.)

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Scope table (drivers / control{codex,opencode,interactive,headless} / headless-launcher / projection) → Tasks 2 + 3.
- Dependencies & interface (agents → core + shared only; barrel; consumer repoint) → Task 1 (wiring) + Tasks 2–3 (barrel + repoint).
- Risks (pane-classifier edge, marker.ts, headless-launcher) → boundary greps in Tasks 2/3/4 Step 1.
- Validation gates 1–7 → Task 4 (+ incremental gates in Tasks 2/3).
- PR shape / GitNexus refresh → Task 4 Steps 6–7.
- Deferred `runtimes/` → never touched (stays in `src/`), consistent with spec.

**Placeholder scan** — no TBD/TODO; the only intentionally-discovered content is the exact barrel re-export symbol set, which has explicit discovery commands (Task 2 Step 3, Task 3 Step 3) rather than a guessed list, because the precise public surface must be read from the live consumer imports. Acceptable: the *method* is fully specified.

**Type consistency** — no new types introduced; this is a move. Package name `@cockpit/agents`, build script list, and tsup `noExternal` entry are identical strings across Tasks 1/2/3/4.
