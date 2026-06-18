# Step 7 — Group `@cockpit/cli` + delete legacy `src/` Implementation Plan

> **✅ Shipped** (PR #368, 2026-06-18). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move everything left in `src/` into a new private workspace package `packages/cli` (the DAG apex), repoint the two tsup entries (output paths unchanged), fix latent stale type-imports + the `@cockpit/web` tsup-inline gap, and delete the legacy flat `src/` layout — completing the six-package monorepo. Mechanical grouping ONLY; the thin-wrapper logic refactor is deferred to a tracked GH issue.

**Architecture:** Straight `git mv` of the bin entry, 29 command files, the daemon-host entry (`cockpitd.ts`), the cli-side `control/` + `lib/` files into `packages/cli/src/`, behind interfaces already in the five sibling packages. Root stays the published `claude-cockpit` package and build/publish orchestrator; only tsup entry **source** paths change. `dist/index.js` + `dist/cockpitd.js` outputs and the launchd plist are unchanged.

**Tech Stack:** TypeScript (NodeNext ESM — relative imports need `.js`), pnpm workspaces, TS project references, tsup bundle, vitest.

## Global Constraints

- **NodeNext ESM:** every relative import ends in `.js`. Real gate = `node dist/index.js --help`, not `tsc` alone.
- **DO NOT touch runtime path math** in `index.ts` / `cockpitd.ts` (`join(__dirname, "..", "package.json")`, `join(dirname(SELF_PATH), "..", "package.json")`). These resolve against the **bundled `dist/` output**, which is unchanged — they are correct as-is. Changing `".."`→`"../.."` to "match the deeper source path" REINTRODUCES the #363 ENOENT. Leave them exactly as they are.
- **Output paths are fixed:** tsup must still emit `dist/index.js` (bin) + `dist/cockpitd.js` (launchd). The launchd plist (`packages/core/src/launchd.ts`) and root `package.json` `bin` are NOT edited.
- **Minimum-diff move:** straight `git mv`; do NOT split or refactor any command file (that's the deferred issue). Internal `./` imports survive.
- **NEVER run `node dist/cockpitd.js` against the real socket** (`~/.config/cockpit/cockpit.sock` — #360 trap). Daemon smokes use a temp `sockPath` + `rotationIntervalMs: 0` + `sweepMs: 0`.
- **Run `pnpm build` (tsc) THEN the full suite** — never trust vitest alone (it erases `import type`, hiding the very errors this step must fix). Pass bar = exactly 3 pre-existing `relay-proxy.test.ts` #353 failures; any other = regression.
- **Worktree:** isolated worktree; run `pnpm install --frozen-lockfile` before building.
- **Branch:** `crew/reorg-7-cli` off `develop`. Captain squash-merges `--admin` (crew does NOT merge).
- **DAG:** `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`. cli imports any `@cockpit/*`; nothing imports cli.

---

## File Structure

**New `packages/cli/`:**
- `package.json` — `@cockpit/cli`, private, deps = the 5 sibling packages (`workspace:*`) + the npm deps the commands use (commander, chalk, etc. — re-derive from imports), `scripts.build` = `tsc -b`.
- `tsconfig.json` — composite, NodeNext, `outDir dist`, `rootDir src`, references to all 5 sibling packages.
- `README.md` — purpose/owns/interface/depends-on.
- `src/index.ts`, `src/commands/**`, `src/control/{cockpitd,crew-routing,relay-supervisor,relay-supervisor-loop,relay-log-broadcaster}.ts`, `src/lib/per-crew-settings.ts`, and all `__tests__/`.

**Edited at root:**
- `tsup.config.ts` — entry source paths → `packages/cli/src/...`; add `@cockpit/web` to `inlinePackagesPlugin` + `noExternal`.
- `tsconfig.json` — becomes a pure solution file: add `{ "path": "packages/cli" }`; remove the `include`/`rootDir`/`outDir`/`paths`/`src`-compile block (src/ is gone).
- `package.json` — add `packages/cli` to the `build` `tsc -b --force …` chain; add `"@cockpit/cli": "workspace:*"` to devDependencies. `bin`/`files` unchanged.

**Moved out of cli:**
- `src/config.test.ts` → `packages/shared/src/lib/__tests__/config.test.ts` (it tests `@cockpit/shared` config).

---

## Task 1: Fix latent stale `import type` references (in place, pre-move)

These 6 errors are invisible to vitest but will break the cli composite `tsc -b`. Fix them in `src/` first so the suite + a manual `tsc --noEmit` are both clean before moving.

**Files:**
- Modify: `src/commands/__tests__/heal.test.ts`, `src/commands/__tests__/health-view.test.ts`, `src/control/__tests__/cockpitd-daemon-direct.test.ts`, `src/control/__tests__/crew-pane-reader-direct.test.ts`

- [ ] **Step 1: Confirm the debt.** Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS"`. Expect 6 errors citing `../../control/liveness.js`, `../cmux/daemon-cmux.js`, `../../runtimes/types.js`.

- [ ] **Step 2: Repoint each stale type import to its new package home:**
  - `heal.test.ts` + `health-view.test.ts`: `import type { ComponentHealth } from "../../control/liveness.js"` → `import type { ComponentHealth } from "@cockpit/core"`.
  - `cockpitd-daemon-direct.test.ts`: `../cmux/daemon-cmux.js` → `@cockpit/workspaces`; `../../runtimes/types.js` → `@cockpit/workspaces` (verify the exact symbol's new export location — grep `packages/workspaces/src` and `packages/shared/src`; PaneRef-style types may live in `@cockpit/shared`).
  - `crew-pane-reader-direct.test.ts`: `../cmux/daemon-cmux.js` → `@cockpit/workspaces`.

- [ ] **Step 3: Verify tsc is clean.** Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` → `0`.

- [ ] **Step 4: Verify the suite is unchanged.** Run: `pnpm build && npx vitest run`. Pass bar = 3 `relay-proxy.test.ts` #353 failures only.

- [ ] **Step 5: Commit.**
```bash
git add src/commands/__tests__/heal.test.ts src/commands/__tests__/health-view.test.ts src/control/__tests__/cockpitd-daemon-direct.test.ts src/control/__tests__/crew-pane-reader-direct.test.ts
git commit -m "test: repoint stale type-imports to package homes (prep step 7 cli composite)"
```

---

## Task 2: Scaffold `packages/cli` (empty, builds) + convert root tsconfig to a solution file

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/README.md`, `packages/cli/src/.gitkeep` (temporary)
- Modify: root `package.json` (build chain + devDep), root `tsconfig.json` (add ref; keep `include` for now so src/ still typechecks until Task 3 moves it)

- [ ] **Step 1: Write `packages/cli/package.json`** (template from `packages/web/package.json`): name `@cockpit/cli`, `private`, `type: module`, `scripts.build: "tsc -b"`, dependencies = `@cockpit/shared`, `@cockpit/core`, `@cockpit/agents`, `@cockpit/workspaces`, `@cockpit/web` (all `workspace:*`) plus the npm runtime deps the commands import (grep `from "commander"`, `from "chalk"`, etc. across `src/` and list them). No `main`/`exports` needed (cli is the build entry, not imported by anyone).

- [ ] **Step 2: Write `packages/cli/tsconfig.json`** (template from `packages/web/tsconfig.json`): composite, NodeNext, `rootDir: src`, `outDir: dist`, `references: [{path:"../shared"},{path:"../core"},{path:"../agents"},{path:"../workspaces"},{path:"../web"}]`.

- [ ] **Step 3: Write `packages/cli/README.md`** (≈20 lines: Purpose = the `cockpit` bin + launchd daemon host + command surface; Owns = commands, entries, cli-side control/lib; Depends on = all five packages; Doesn't belong here = orchestration logic that should live in core/agents — see deferred-refactor issue).

- [ ] **Step 4: Wire root build + refs.** In root `package.json` `build`: append `packages/cli` →
  `tsc -b --force packages/shared packages/core packages/agents packages/workspaces packages/web packages/cli && tsup`. Add `"@cockpit/cli": "workspace:*"` to root devDependencies. In root `tsconfig.json` `references`, add `{ "path": "packages/cli" }`.

- [ ] **Step 5: Install + build (empty cli builds clean).** Run: `pnpm install && pnpm build`. Expected: clean (cli has no src yet — `tsc -b` on an empty composite is fine; if it errors on no inputs, defer the build-chain entry until Task 3 and note it).

- [ ] **Step 6: Commit.**
```bash
git add packages/cli package.json tsconfig.json pnpm-lock.yaml
git commit -m "build(cli): scaffold empty @cockpit/cli package (step 7)"
```

---

## Task 3: Move `src/` → `packages/cli/src/`, repoint tsup, fix web-inline

**Files:**
- Move (git mv): `src/index.ts`, `src/commands/` (+`__tests__/`), `src/control/{cockpitd,crew-routing,relay-supervisor,relay-supervisor-loop,relay-log-broadcaster}.ts` (+`control/__tests__/`), `src/lib/per-crew-settings.ts` (+`lib/__tests__/`) → `packages/cli/src/`
- Move: `src/config.test.ts` → `packages/shared/src/lib/__tests__/config.test.ts`
- Modify: `tsup.config.ts` (entry paths + web inline)

- [ ] **Step 1: `git mv` the cli tree.** Move `index.ts`, `commands/`, the five `control/*.ts` + `control/__tests__/`, `lib/per-crew-settings.ts` + `lib/__tests__/` into `packages/cli/src/` preserving structure. Internal `./` and `../` imports within the moved tree stay valid (the whole tree moves as a unit).

- [ ] **Step 2: Move `config.test.ts` to shared.** `git mv src/config.test.ts packages/shared/src/lib/__tests__/config.test.ts`. It already imports from `@cockpit/shared`, so no import edit — but confirm the relative depth of any `node:`/fixture imports is still valid (it uses only `@cockpit/shared` + `node:` + vitest, so it's fine).

- [ ] **Step 3: Repoint tsup entries + add web inline.** In `tsup.config.ts`:
  - `entry.index`: `"src/index.ts"` → `"packages/cli/src/index.ts"`.
  - `entry.cockpitd`: `"src/control/cockpitd.ts"` → `"packages/cli/src/control/cockpitd.ts"`.
  - Add `const webDist = path.resolve(__dirname, "packages/web/dist/index.js");` and a `build.onResolve({ filter: /^@cockpit\/web$/ }, () => ({ path: webDist }))` clause in `inlinePackagesPlugin`.
  - Add `"@cockpit/web"` to the `noExternal` array.
  - Do NOT change `format`/`platform`/`splitting`/output. Output stays `dist/index.js` + `dist/cockpitd.js`.

- [ ] **Step 4: DO NOT touch path math.** Confirm `packages/cli/src/index.ts` still has `join(__dirname, "..", "package.json")` / `join(__dirname, "..")` and `packages/cli/src/control/cockpitd.ts` still has `join(dirname(SELF_PATH), "..", "package.json")` — unchanged. (They resolve against `dist/` at runtime.)

- [ ] **Step 5: Build.** Run: `pnpm build`. Expected: `tsc -b` compiles all 6 packages clean (Task 1 cleared the stale-type debt); tsup emits `dist/index.js` + `dist/cockpitd.js`. If tsc flags any remaining stale relative import in a moved file, repoint it to the correct `@cockpit/*` package (do not add logic).

- [ ] **Step 6: ESM + path-lookup gate.** Run: `node dist/index.js --help` (prints help), `node dist/index.js config` (prints config — exercises the package.json path lookup, the #363 guard), `node dist/index.js dashboard --once` (exercises inlined `@cockpit/web`).

- [ ] **Step 7: Commit.**
```bash
git add -A
git commit -m "refactor(cli): move src/ into @cockpit/cli; repoint tsup entries; inline @cockpit/web"
```

---

## Task 4: Delete the legacy `src/` layout + finalize root tsconfig

**Files:**
- Delete: `src/` (should be empty post-move)
- Modify: root `tsconfig.json` (remove the `include`/`rootDir`/`outDir`/`paths` src-compile block — pure solution file now)

- [ ] **Step 1: Confirm `src/` is empty** (only the moved-out tree remained). Run: `find src -type f 2>/dev/null`. Expected: nothing. Then `git rm -r src 2>/dev/null; rmdir src 2>/dev/null` and confirm `src/` is gone.

- [ ] **Step 2: Convert root `tsconfig.json` to a solution file.** Keep only `references` (now 6: shared, core, agents, workspaces, web, cli). Remove `compilerOptions.{rootDir,outDir,include}` and the `src`-targeted `include`. Keep/remove `paths` per what the IDE/vitest needs — vitest resolves `@cockpit/*` via pnpm workspace symlinks to `packages/*/dist`, so `paths` is not required at runtime; if removing it breaks editor resolution, move it into a shared base config instead. Verify `npx tsc --noEmit -p tsconfig.json` is clean (or that `tsc -b` is the canonical check).

- [ ] **Step 3: Grep for dangling `src/` references.** Run: `grep -rn "\"src/\|'src/\|/src/index\|src/control/cockpitd" package.json tsup.config.ts tsconfig.json .github/ 2>/dev/null`. Expected: only `packages/cli/src/...` in tsup; no bare root `src/` refs remain.

- [ ] **Step 4: Build + ESM gate again.** Run: `pnpm build && node dist/index.js --help`. Expected: green.

- [ ] **Step 5: Commit.**
```bash
git add -A
git commit -m "refactor: delete legacy src/ layout; root tsconfig is now a solution file (reorg complete)"
```

---

## Task 5: Full validation battery (captain re-runs all of this on review)

- [ ] **Step 1: Boundary grep.** `grep -rEn "from \"(\.\./)+src/" packages/cli/src` (none); confirm nothing in `packages/{shared,core,agents,workspaces,web}/src` imports cli. Report OK/FAIL.

- [ ] **Step 2: Clean-room install + build.** `pnpm install --frozen-lockfile && pnpm build`. Both `dist/index.js` + `dist/cockpitd.js` emit.

- [ ] **Step 3: ESM + path-lookup gate.** `node dist/index.js --help`, `node dist/index.js config`, `node dist/index.js dashboard --once` — all run.

- [ ] **Step 4: Socket-safe daemon boot (HEAVY).** Boot the rebuilt `dist/cockpitd.js` via a TEMP `sockPath` + `rotationIntervalMs: 0` + `sweepMs: 0` (NEVER the real socket — #360). Assert bind + a `health`/`list` round-trip; tear down. Confirm `src/control/__tests__/launchd.test.ts` (now under `packages/cli`) is green (plist path unchanged).

- [ ] **Step 5: Full suite.** `pnpm build` (tsc) THEN `npx vitest run`. Pass bar = exactly 3 `relay-proxy.test.ts` #353 failures; report exact counts. (If `cockpitd-daemon-direct` flakes in isolation, it must still pass in the full run.)

- [ ] **Step 6: Tarball gate (HEAVY).** `pnpm pack` (capture printed filename as `$(pwd)/<file>` BEFORE cd-ing), install into a temp dir, run `cockpit --help` + `cockpit dashboard --once` (inlined web) + a runtime-sync op. Expected: functional.

- [ ] **Step 7: Legacy-gone check.** `test ! -d src && echo "src/ deleted ✓"`. `git status` clean.

- [ ] **Step 8: Report the gate matrix** (one line per gate: PASS/FAIL + evidence) and the exact suite counts. Do NOT merge — the captain reviews and merges. Then signal done.

---

## Self-Review (planner)

- **Spec coverage:** Task 1 = stale-type cleanup (spec "the trap"/latent debt); Task 2 = scaffold + root tsconfig; Task 3 = move + tsup repoint + web-inline (spec scope + inline-gap); Task 4 = delete legacy + solution tsconfig; Task 5 = all 8 spec gates incl. daemon-boot + tarball. config.test.ts→shared covered (Task 3.2). Deferred-refactor issue is filed by the captain (out of crew scope). ✓
- **Path-math trap:** explicitly do-not-touch in Global Constraints + Task 3.4. ✓
- **Type consistency:** stale imports repoint to `@cockpit/core` (ComponentHealth) / `@cockpit/workspaces` (daemon-cmux/runtimes types) — verify exact export homes during Step 1 grep. ✓
- **Ordering:** stale-fix (1) → scaffold (2) → move (3) → delete (4) keeps every commit building; output paths fixed throughout so the daemon stays runnable. ✓
- **No placeholders:** every step has concrete commands/edits. ✓
