# Reorg Step 3 — Scaffold + Extract `@cockpit/shared` Implementation Plan

> **✅ Shipped** (PR #356, 2026-06-17). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This plan is scaffolding-heavy: tasks verify via build/run/pack gates rather than red-green unit tests, which is appropriate for build-tooling work.

**Goal:** Convert claude-cockpit to a pnpm workspaces monorepo, bundle both entrypoints (CLI + daemon) with tsup, and extract the leaf `@cockpit/shared` package — proving the full build/publish pipeline on the safest package before any domain code moves.

**Architecture:** Root `claude-cockpit` stays the transitional "everything-else" package (keeps `src/`, `bin`, builds via tsup), depending on a new private `@cockpit/shared` (types + leaf utils + config). TS project references enforce the boundary. tsup inlines `@cockpit/shared` into self-contained `dist/index.js` + `dist/cockpitd.js` so publish + the launchd daemon need no runtime package resolution.

**Tech Stack:** TypeScript (ESM, `moduleResolution: bundler`), pnpm workspaces, tsup (esbuild), vitest, git, gh.

## Global Constraints

- Parent spec: `docs/superpowers/specs/2026-06-17-monorepo-reorg-step3-scaffold-design.md`. Master rollout: `docs/superpowers/specs/2026-06-17-monorepo-reorg-design.md` (step 3).
- Platform macOS-only. No behavior change — structure/tooling only.
- The real runtime gate after every build is BOTH: `node dist/index.js --help` AND `node dist/cockpitd.js` boots and serves the socket. tsc/vitest passing is NOT sufficient (NodeNext/ESM runtime gotcha).
- Sub-packages are `private: true`, never separately published. Only root `claude-cockpit` publishes; tsup bundles inline.
- Branch off `develop` (which must already contain this plan + spec). Branch name: `feat/reorg-step3-scaffold`. Open a PR to `develop`; do NOT self-merge (captain reviews).
- Known pre-existing failures to ignore (not caused here): the 3 `relay-proxy.test.ts` flakes tracked in #353.
- Follow karpathy-principles: surgical, every change traces to the plan, no drive-by refactors.

**Reference — `@cockpit/shared` exact contents:**
- `config.ts` (from `src/config.ts`)
- `types/control.ts`, `types/projection.ts`, `types/workspaces.ts` (from `src/control/types.ts`, `src/projection/types.ts`, `src/workspaces/types.ts`)
- Leaf lib: `cmux-autoconfig`, `cmux-bin`, `cmux-config`, `cmux-probe`, `compat-manifest`, `config-drift`, `config-version`, `git-worktree`, `resolve-text-input`, `runtime-sync`, `tool-compat`, `canonical-source`, `daily-logs`, `vault-layout`
- EXCLUDED: `per-crew-settings.ts` (couples to `control/interactive/claude` logic — stays in root).

---

### Task 1: Migrate to pnpm + update CI/release (no structural change)

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json` (add `packageManager`), `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Delete: `package-lock.json`; Create: `pnpm-lock.yaml`

**Interfaces:**
- Produces: a working pnpm workspace root with `packages/*` glob (dir created in Task 3). No code change.

- [ ] **Step 1: Create the workspace manifest**

Create `pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 2: Pin the package manager**

In `package.json`, add a top-level field (use the installed pnpm version; check with `pnpm --version`):
```json
  "packageManager": "pnpm@9.0.0",
```

- [ ] **Step 3: Regenerate the lockfile with pnpm**

Run:
```bash
rm -f package-lock.json
pnpm import 2>/dev/null || true   # seed from package-lock if present
pnpm install
```
Expected: `pnpm-lock.yaml` created, `node_modules/` populated, no errors.

- [ ] **Step 4: Verify build + test + CLI still work on pnpm (still tsc)**

Run:
```bash
pnpm run build && node dist/index.js --help && pnpm test
```
Expected: build OK, `--help` prints usage, tests green (minus #353 flakes).

- [ ] **Step 5: Switch CI to pnpm**

In `.github/workflows/ci.yml`, replace the `Install dependencies` step and add pnpm setup. The `build-and-test` job steps become:
```yaml
      - name: Checkout
        uses: actions/checkout@v6

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node
        uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm run build

      - name: Test
        run: pnpm test
```

- [ ] **Step 6: Switch release workflow to pnpm**

In `.github/workflows/release.yml`, apply the same pnpm setup pattern: add `pnpm/action-setup@v4` before Node setup, set `cache: "pnpm"`, replace `npm ci`→`pnpm install --frozen-lockfile`, `npm run build`→`pnpm run build`, and any `npm publish` stays as-is (pnpm reads `NODE_AUTH_TOKEN`). Do NOT change the publish-guard logic; only the install/build commands.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build: migrate to pnpm workspaces (lockfile + CI + release), no structural change"
```

---

### Task 2: Adopt tsup bundling for both entrypoints (the bundler landmine)

**Files:**
- Create: `tsup.config.ts`
- Modify: `package.json` (build/dev/lint scripts, devDep tsup, bin unchanged), `src/control/launchd.ts:16` (stale comment only)
- Add devDep: `tsup`

**Interfaces:**
- Produces: `dist/index.js` (bundled CLI, the `bin`) and `dist/cockpitd.js` (bundled daemon). Both self-contained except external npm deps.

- [ ] **Step 1: Add tsup**

Run:
```bash
pnpm add -D tsup
```

- [ ] **Step 2: Write the tsup config**

Create `tsup.config.ts`:
```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",            // -> dist/index.js  (cockpit bin)
    cockpitd: "src/control/cockpitd.ts", // -> dist/cockpitd.js (launchd daemon)
  },
  format: "esm",
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: false,        // keep two independent self-contained bundles
  sourcemap: true,
  clean: true,
  dts: false,              // bin/daemon don't ship types; faster build
  // Keep node built-ins + real npm deps external; bundle our workspace code inline.
  // tsup/esbuild externalize node_modules by default EXCEPT workspace packages,
  // which we WANT inlined — so do not add @cockpit/* to `external`.
  external: [],
  banner: { js: "#!/usr/bin/env node" }, // bin shebang on both is harmless; required on index
});
```

- [ ] **Step 3: Point the build scripts at tsup**

In `package.json` scripts:
```json
    "build": "tsup",
    "dev": "tsup --watch",
    "lint": "tsc -b --noEmit || tsc --noEmit",
```
(Keep `test` and `codex:gen-types` unchanged. `bin` stays `"cockpit": "./dist/index.js"`.)

- [ ] **Step 4: Build and verify BOTH bundles run**

Run:
```bash
pnpm run build
ls -la dist/index.js dist/cockpitd.js
node dist/index.js --help
```
Expected: both files exist; `--help` prints usage. (Daemon boot verified in Step 6 to avoid colliding with a running daemon.)

- [ ] **Step 5: Fix the stale launchd comment**

The daemon-path resolution in `src/control/launchd.ts:22`
(`join(dirname(fileURLToPath(import.meta.url)), "cockpitd.js")`) still works because the
bundled `launchd` code lives in `dist/index.js`, whose sibling is `dist/cockpitd.js`. Only the
comment at line ~16 is stale. Change:
```
 * module (cockpitd.js is a sibling of launchd.js in <dist>/control/). This is
```
to:
```
 * module (cockpitd.js is a sibling of the bundled entry in <dist>/). This is
```

- [ ] **Step 6: Verify the bundled daemon boots in isolation (landmine check)**

Run (uses a throwaway state root so it cannot disturb the live daemon/socket):
```bash
COCKPIT_STATE_ROOT=$(mktemp -d) node dist/cockpitd.js &
DPID=$!; sleep 2
ls -la "${COCKPIT_STATE_ROOT:-/tmp}" 2>/dev/null | head
kill $DPID 2>/dev/null
```
Expected: the daemon process starts without an immediate crash/stack trace (it prints its `started pid=… sock=…` line). If it crashes on a missing bundled module, the tsup `external`/`bundle` config is wrong — fix before proceeding. (If `COCKPIT_STATE_ROOT` is not a supported override, boot it the way `cockpitd.ts` documents and just confirm no crash.)

- [ ] **Step 7: Packed-tarball test — prove pkgRoot reads survive bundling (highest-risk gate)**

Run:
```bash
pnpm pack
TARBALL=$(ls -t claude-cockpit-*.tgz | head -1)
TMP=$(mktemp -d); tar -xzf "$TARBALL" -C "$TMP"
node "$TMP/package/dist/index.js" --help
# Confirm the pkgRoot-relative dirs are present in the packed package (runtime-sync sources):
ls "$TMP/package/templates" "$TMP/package/plugin" "$TMP/package/scripts" >/dev/null && echo "PKGROOT DIRS OK"
rm -f "$TARBALL"
```
Expected: `--help` works from the packed tarball AND `PKGROOT DIRS OK` prints. If `templates/`/`plugin/`/`scripts/` are missing from the pack, add a `files` allowlist to `package.json` that includes `dist`, `templates`, `plugin`, `scripts` and re-pack. This proves `runtime-sync`/`canonical-source` can still find their sources after bundling.

- [ ] **Step 8: Full test suite + commit**

Run:
```bash
pnpm test
```
Expected: green (minus #353 flakes). Then:
```bash
git add -A
git commit -m "build: bundle cli + daemon entrypoints with tsup (self-contained dist)"
```

---

### Task 3: Scaffold the empty `@cockpit/shared` package + project references

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/README.md`
- Modify: root `package.json` (add `@cockpit/shared` dep), root `tsconfig.json` (add references)

**Interfaces:**
- Produces: importable `@cockpit/shared` (empty barrel for now) linked into root via workspace symlink.

- [ ] **Step 1: Create the package manifest**

Create `packages/shared/package.json`:
```json
{
  "name": "@cockpit/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -b" }
}
```

- [ ] **Step 2: Create the package tsconfig (composite)**

Create `packages/shared/tsconfig.json`:
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
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create an empty barrel**

Create `packages/shared/src/index.ts`:
```typescript
// @cockpit/shared — pure types + leaf utilities + config.
// Populated in Tasks 4-5. Intentionally empty barrel for the scaffold.
export {};
```

- [ ] **Step 4: Add the workspace dependency to root**

In root `package.json` `dependencies`, add:
```json
    "@cockpit/shared": "workspace:*",
```

- [ ] **Step 5: Wire project references in root tsconfig**

In root `tsconfig.json`, add a top-level `references` array (sibling of `compilerOptions`):
```json
  "references": [{ "path": "packages/shared" }],
```

- [ ] **Step 6: Install + verify linking and type-build**

Run:
```bash
pnpm install
pnpm -C packages/shared build
node -e "import('@cockpit/shared').then(() => console.log('SHARED LINK OK'))"
```
Expected: `node_modules/@cockpit/shared` symlink exists, `packages/shared/dist` builds, `SHARED LINK OK` prints.

- [ ] **Step 7: Write the README**

Create `packages/shared/README.md`:
```markdown
# @cockpit/shared

**Purpose:** Leaf package — pure types, zero-dependency utilities, and config. Depended on by every other package; depends on none.

**Owns:** shared type definitions (control/projection/workspaces), `config.ts`, and side-effect-free helpers (cmux config/probe/bin, compat-manifest, config-drift/version, git-worktree, runtime-sync, canonical-source, vault-layout, daily-logs, resolve-text-input, tool-compat).

**Public interface:** everything re-exported from `src/index.ts` (import via `@cockpit/shared`).

**Depends on:** nothing internal (only npm deps + node built-ins).

**Doesn't belong here:** anything that imports from `core`, `agents`, `workspaces`, `web`, or `cli`; anything that spawns processes or owns daemon/CLI logic. If a util reaches into a domain package, it belongs in that domain, not here.
```

- [ ] **Step 8: Build + test + commit**

Run:
```bash
pnpm run build && node dist/index.js --help && pnpm test
```
Expected: green. Then:
```bash
git add -A
git commit -m "feat(shared): scaffold empty @cockpit/shared package + project references"
```

---

### Task 4: Move config + type modules into `@cockpit/shared`, repoint imports

**Files:**
- Move: `src/config.ts`→`packages/shared/src/config.ts`; `src/control/types.ts`→`packages/shared/src/types/control.ts`; `src/projection/types.ts`→`packages/shared/src/types/projection.ts`; `src/workspaces/types.ts`→`packages/shared/src/types/workspaces.ts`
- Modify: `packages/shared/src/index.ts` (re-export); ~22 importer files across `src/`

**Interfaces:**
- Produces: `@cockpit/shared` exports `config` API + the three type namespaces. Importers use `import { … } from "@cockpit/shared"`.

- [ ] **Step 1: Move the files with git**

Run:
```bash
mkdir -p packages/shared/src/types
git mv src/config.ts packages/shared/src/config.ts
git mv src/control/types.ts packages/shared/src/types/control.ts
git mv src/projection/types.ts packages/shared/src/types/projection.ts
git mv src/workspaces/types.ts packages/shared/src/types/workspaces.ts
```

- [ ] **Step 2: Re-export from the barrel**

Replace `packages/shared/src/index.ts` with:
```typescript
// @cockpit/shared — pure types + leaf utilities + config.
export * from "./config.js";
export * from "./types/control.js";
export * from "./types/projection.js";
export * from "./types/workspaces.js";
```
(If two type modules export colliding names, switch the colliding ones to `export * as control from "./types/control.js"` etc. and update importers accordingly — verify with the build in Step 4.)

- [ ] **Step 3: Repoint all importers to `@cockpit/shared`**

Find every importer:
```bash
git grep -lE "from \"[./]+(config|control/types|projection/types|workspaces/types)(\.js)?\"" -- src
```
For each hit, change the relative import to the bare specifier. Examples:
- `import { … } from "../config.js"` → `import { … } from "@cockpit/shared"`
- `import { … } from "./types.js"` (inside `src/control/`) → `import { … } from "@cockpit/shared"`
- `import type { PaneRef } from "../workspaces/types.js"` → `import type { PaneRef } from "@cockpit/shared"`

- [ ] **Step 4: Build shared, then the root bundle (catch missing/renamed exports)**

Run:
```bash
pnpm -C packages/shared build
pnpm run build
```
Expected: both succeed. If tsup reports an unresolved relative import, a `src/` file still points at a moved file — fix it. If a name collision surfaced, apply the namespaced re-export from Step 2.

- [ ] **Step 5: Verify no stale relative imports of the moved modules remain**

Run:
```bash
git grep -nE "from \"[./]+(config|control/types|projection/types|workspaces/types)(\.js)?\"" -- src
```
Expected: **no output**.

- [ ] **Step 6: Runtime + test gate + commit**

Run:
```bash
node dist/index.js --help && pnpm test
```
Expected: green (minus #353). Then:
```bash
git add -A
git commit -m "refactor(shared): move config + type modules to @cockpit/shared, repoint imports"
```

---

### Task 5: Move leaf `lib/` modules into `@cockpit/shared`, repoint imports

**Files:**
- Move: the 14 leaf lib files (see Reference list, all EXCEPT `per-crew-settings.ts`) from `src/lib/` to `packages/shared/src/lib/`
- Modify: `packages/shared/src/index.ts` (re-export each); importers across `src/`; any `__tests__` that referenced moved lib files move with them

**Interfaces:**
- Produces: `@cockpit/shared` additionally exports the leaf-lib API. `per-crew-settings.ts` stays in `src/lib/` and imports its needed types from `@cockpit/shared`.

- [ ] **Step 1: Move the leaf lib files (+ their colocated tests)**

Run:
```bash
mkdir -p packages/shared/src/lib
for f in cmux-autoconfig cmux-bin cmux-config cmux-probe compat-manifest config-drift \
         config-version git-worktree resolve-text-input runtime-sync tool-compat \
         canonical-source daily-logs vault-layout; do
  git mv "src/lib/$f.ts" "packages/shared/src/lib/$f.ts"
done
# Move any colocated tests for those modules into the shared package's test dir:
mkdir -p packages/shared/src/lib/__tests__
git ls-files src/lib/__tests__ | while read t; do
  base=$(basename "$t"); name="${base%.test.ts}"
  case " cmux-autoconfig cmux-bin cmux-config cmux-probe compat-manifest config-drift config-version git-worktree resolve-text-input runtime-sync tool-compat canonical-source daily-logs vault-layout cmux-config cmux-probe " in
    *" $name "*) git mv "$t" "packages/shared/src/lib/__tests__/$base" ;;
  esac
done
```
(If a test name doesn't map cleanly, leave it; fix references in Step 4.)

- [ ] **Step 2: Re-export the leaf lib from the barrel**

Append to `packages/shared/src/index.ts`:
```typescript
export * from "./lib/cmux-autoconfig.js";
export * from "./lib/cmux-bin.js";
export * from "./lib/cmux-config.js";
export * from "./lib/cmux-probe.js";
export * from "./lib/compat-manifest.js";
export * from "./lib/config-drift.js";
export * from "./lib/config-version.js";
export * from "./lib/git-worktree.js";
export * from "./lib/resolve-text-input.js";
export * from "./lib/runtime-sync.js";
export * from "./lib/tool-compat.js";
export * from "./lib/canonical-source.js";
export * from "./lib/daily-logs.js";
export * from "./lib/vault-layout.js";
```
(Resolve any export-name collisions with namespaced re-exports, verified by the build.)

- [ ] **Step 3: Fix intra-shared imports of the moved type modules**

Inside the moved lib files, change imports that pointed at the old type locations to package-relative within shared, e.g.:
- `from "../projection/types.js"` → `from "../types/projection.js"`
- `from "../workspaces/types.js"` → `from "../types/workspaces.js"`
- `from "../control/types.js"` → `from "../types/control.js"`

- [ ] **Step 4: Repoint root importers (incl. per-crew-settings) to `@cockpit/shared`**

Find importers of the moved lib files:
```bash
git grep -lE "from \"[./]+lib/(cmux-autoconfig|cmux-bin|cmux-config|cmux-probe|compat-manifest|config-drift|config-version|git-worktree|resolve-text-input|runtime-sync|tool-compat|canonical-source|daily-logs|vault-layout)(\.js)?\"" -- src
```
Repoint each to `@cockpit/shared`. Ensure `src/lib/per-crew-settings.ts` imports any shared types/utils it needs from `@cockpit/shared` (it keeps its `control/interactive/claude` import as-is — that's why it stays in root).

- [ ] **Step 5: Build shared + root, verify no stale lib imports**

Run:
```bash
pnpm -C packages/shared build && pnpm run build
git grep -nE "from \"[./]+lib/(cmux-autoconfig|cmux-bin|cmux-config|cmux-probe|compat-manifest|config-drift|config-version|git-worktree|resolve-text-input|runtime-sync|tool-compat|canonical-source|daily-logs|vault-layout)(\.js)?\"" -- src
```
Expected: builds succeed; grep prints **no output**.

- [ ] **Step 6: Runtime + full test + pack gate + commit**

Run:
```bash
node dist/index.js --help && pnpm test
# Re-run the pkgRoot pack test (runtime-sync.ts now lives in shared — must still resolve sources):
pnpm pack && TARBALL=$(ls -t claude-cockpit-*.tgz | head -1) && TMP=$(mktemp -d) && tar -xzf "$TARBALL" -C "$TMP" \
  && node "$TMP/package/dist/index.js" --help && ls "$TMP/package/templates" "$TMP/package/plugin" "$TMP/package/scripts" >/dev/null && echo "PKGROOT OK" && rm -f "$TARBALL"
```
Expected: tests green; `PKGROOT OK`. Then:
```bash
git add -A
git commit -m "refactor(shared): move leaf lib modules to @cockpit/shared, repoint imports"
```

---

### Task 6: Final verification gate + open PR

**Files:** none (verification only).

- [ ] **Step 1: Clean-room full build/test/type-check**

Run:
```bash
rm -rf node_modules packages/shared/dist dist
pnpm install --frozen-lockfile
pnpm -C packages/shared build
pnpm run build
pnpm exec tsc -b
pnpm test
node dist/index.js --help
```
Expected: all succeed; tests green (minus #353); `tsc -b` enforces the reference graph; `--help` works.

- [ ] **Step 2: Confirm the boundary is enforced**

Verify `@cockpit/shared` has no import path back into root `src/`:
```bash
git grep -nE "from \"\.\.?/(\.\./)*src/|from \"@cockpit/(core|cli|agents|workspaces|web)" -- packages/shared || echo "BOUNDARY CLEAN"
```
Expected: `BOUNDARY CLEAN`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin HEAD
gh pr create --base develop --title "Reorg Step 3: pnpm workspaces + tsup bundle + extract @cockpit/shared" \
  --body "Part of the monorepo reorg (docs/superpowers/specs/2026-06-17-monorepo-reorg-design.md), rollout step 3. Design: docs/superpowers/specs/2026-06-17-monorepo-reorg-step3-scaffold-design.md.

- pnpm workspaces (lockfile + CI + release migrated).
- tsup bundles cli (dist/index.js) + daemon (dist/cockpitd.js), inlining workspace code.
- Extract leaf @cockpit/shared (config + types + leaf lib). per-crew-settings stays in root (couples to interactive logic).
- TS project references enforce shared has no back-import.

Verified: clean-room pnpm build + tsc -b green; node dist/index.js --help works; bundled daemon boots; packed-tarball runtime-sync sources present (pkgRoot survives bundling); tests green minus #353 flakes."
```
Expected: PR URL. Do NOT merge.

- [ ] **Step 4: Signal done**

```bash
cockpit crew signal done
```

---

## Self-Review

**Spec coverage:** pnpm workspaces (Task 1) ✓; tsup both entrypoints (Task 2) ✓; `@cockpit/shared` = config+types+leaf-lib, `per-crew-settings` excluded (Tasks 3-5) ✓; project references (Task 3) ✓; CI+release pnpm (Task 1) ✓; landmine #1 daemon entrypoint (Task 2 Steps 5-6) ✓; landmine #2 pkgRoot-after-bundle (Task 2 Step 7 + Task 5 Step 6 pack tests) ✓; landmine #3 vitest resolution (covered by `pnpm test` gates after each move; if vitest can't resolve `@cockpit/shared`, add a vitest alias — flagged in spec) ✓; README (Task 3 Step 7) ✓; success criteria (Task 6) ✓.

**Placeholder scan:** every step has exact commands + expected output; configs given verbatim. The only conditional branches (export-name collisions, test-name mapping, missing `files` allowlist, vitest alias) include the exact remedy inline. No bare TODO/TBD.

**Type consistency:** moved type modules re-exported from one barrel; importers use the bare `@cockpit/shared` specifier consistently; intra-shared imports repointed to `../types/*` (Task 5 Step 3). `per-crew-settings.ts` consistently kept in root across Tasks 4-5.
