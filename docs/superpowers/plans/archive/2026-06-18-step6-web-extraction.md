# Step 6 — Extract `@cockpit/web` Implementation Plan

> **✅ Shipped** (PR #366, 2026-06-18). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carve `src/dashboard/` into a new private workspace package `@cockpit/web` that depends only on `@cockpit/core` + `@cockpit/shared`, resolving the three outbound edges into `src/commands/` via injection (cockpitdCall) + relocation (ageText, healCmdFor → core).

**Architecture:** Straight package move (like 5a/5b) of seven dashboard modules + their `__tests__`, behind interfaces already in core/shared. The only logic edits are: (a) `readAllStatuses` gains an injected `call` dependency; (b) two pure functions move from cli command files into `packages/core/src/liveness.ts`. The CLI command `src/commands/dashboard.ts` repoints to `@cockpit/web` and injects `cockpitdCall`.

**Tech Stack:** TypeScript (NodeNext ESM — every relative import needs `.js`), pnpm workspaces, TS project references, tsup bundle, vitest.

## Global Constraints

- **NodeNext ESM:** every relative import ends in `.js`. The real gate is `node dist/index.js --help`, not `tsc` alone (#344/#362 lesson).
- **Minimum-diff move:** keep file names and internal structure; do NOT refactor `web-render.ts` (42 KB) or any moved module. Only import lines and the two relocations change.
- **Package is a devDependency**, bundled by tsup — NOT a runtime dependency (publish-safety, 4b/5a/5b lesson).
- **Zero new test failures:** the suite pass bar is exactly the 3 pre-existing `relay-proxy.test.ts` failures (#353). Any 4th failure is a regression. Run `pnpm build` (tsc) THEN the suite — never trust vitest (esbuild, no typecheck) alone.
- **Socket safety:** NEVER run `node dist/cockpitd.js` against the real socket (`~/.config/cockpit/cockpit.sock` — #360 hijack trap). Daemon smokes use a temp `sockPath` + `rotationIntervalMs: 0` + `sweepMs: 0`.
- **Worktree:** isolated worktree; run `pnpm install --frozen-lockfile` in it before building (worktrees lack `node_modules`).
- **Base branch:** `develop`. Branch: `crew/reorg-6-web`. Squash-merge `--admin` at the end (captain does the merge, not the crew).
- **Dependency DAG (must hold):** `shared ◄ core ◄ web`; `web ◄ cli`. No edge web→agents, web→workspaces, web→cli.

---

## File Structure

**New package `packages/web/`:**
- `package.json` — name `@cockpit/web`, private, deps `@cockpit/core` + `@cockpit/shared`, plus `chalk`; build script `tsc -b`.
- `tsconfig.json` — composite, project references to `../core` + `../shared`, `outDir dist`, NodeNext.
- `README.md` — one-paragraph purpose (observability surface: terminal dashboard, hub sync, web server).
- `src/probes.ts`, `src/read-status.ts`, `src/render.ts`, `src/snapshot-merge.ts`, `src/sync-hub.ts`, `src/web-render.ts`, `src/web-server.ts`, `src/index.ts` (barrel), `src/__tests__/…`.

**Edited in `packages/core/`:**
- `src/liveness.ts` — add `ageText`, `healCmdFor` (next to `ComponentHealth`).
- `src/index.ts` — re-export `ageText`, `healCmdFor` (confirm `liveness` types already re-exported; if not, add).

**Edited in `src/` (future cli):**
- `src/commands/dashboard.ts` — repoint 5 dashboard imports to `@cockpit/web`; inject `cockpitdCall` into `readAllStatuses`.
- `src/commands/heal.ts` — delete local `healCmdFor`, import from `@cockpit/core`.
- `src/commands/health-view.ts` — delete local `ageText`, import from `@cockpit/core`.
- `src/commands/__tests__/dashboard.test.ts` — update import if it deep-imports dashboard.
- Root `package.json` — add `web` to build script + as devDependency.
- Root `tsconfig.json` / build config — add `packages/web` to the project-reference build order if applicable.

---

## Task 1: Relocate `ageText` + `healCmdFor` into `@cockpit/core` (no move yet)

Do this FIRST, in-place, so the pure functions have a stable home before the dashboard moves. This keeps each subsequent step compiling.

**Files:**
- Modify: `packages/core/src/liveness.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `src/commands/heal.ts`, `src/commands/health-view.ts`
- Test: `packages/core/src/__tests__/liveness.test.ts` (create or extend)

**Interfaces:**
- Produces: `ageText(lastSeenMs: number | null, now: number): string` and `healCmdFor(c: ComponentHealth): string | null`, both exported from `@cockpit/core`.

- [ ] **Step 1: Write failing tests for the relocated functions in core.** In `packages/core/src/__tests__/liveness.test.ts`, add tests asserting `ageText(null, now) === "—"`, `ageText(now-5000, now) === "5s ago"`, `ageText(now-120000, now) === "2m ago"`, `ageText(now-7200000, now) === "2h ago"`; and `healCmdFor` returns `cockpit heal relay --project P` for a `relay`/`gone` component and `null` otherwise. Import both from `../liveness.js`.

- [ ] **Step 2: Run the tests, verify they fail** (functions not yet in liveness). Run: `pnpm --filter @cockpit/core test liveness` → FAIL (`ageText`/`healCmdFor` not exported).

- [ ] **Step 3: Add both functions to `packages/core/src/liveness.ts`**, copied verbatim from `src/commands/health-view.ts` (`ageText`) and `src/commands/heal.ts` (`healCmdFor`). `healCmdFor` already references `ComponentHealth`, defined in this file — no new import. Add `export` to both.

```ts
export function ageText(lastSeenMs: number | null, now: number): string {
  if (lastSeenMs == null) return "—";
  const s = Math.max(0, Math.round((now - lastSeenMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function healCmdFor(c: ComponentHealth): string | null {
  if (c.kind === "relay" && (c.state === "gone" || c.state === "unknown")) {
    return `cockpit heal relay --project ${c.project}`;
  }
  return null;
}
```

- [ ] **Step 4: Re-export from `packages/core/src/index.ts`.** Confirm `liveness` exports flow through the barrel (grep for an existing `export … from "./liveness.js"`). If `ageText`/`healCmdFor` aren't covered by an existing `export *`, add them explicitly. Verify `web-render.ts` already resolves `ComponentHealth`/`HealthState` from `@cockpit/core` — same barrel.

- [ ] **Step 5: Repoint the cli consumers.** In `src/commands/health-view.ts`: delete the local `ageText` definition, add `ageText` to the existing `import { … } from "@cockpit/core"`. In `src/commands/heal.ts`: delete the local `healCmdFor` definition, add `import { healCmdFor } from "@cockpit/core"` (or extend an existing core import). Leave `web-render.ts` for Task 3 (it still imports from `../commands/...` until the move).

- [ ] **Step 6: Build + run affected tests.** Run: `pnpm build` then `pnpm --filter @cockpit/core test liveness` (PASS) and the existing `heal`/`health-view`/`doctor`/`status` tests (unchanged behavior). Expected: green.

- [ ] **Step 7: Commit.**
```bash
git add packages/core/src/liveness.ts packages/core/src/index.ts packages/core/src/__tests__/liveness.test.ts src/commands/heal.ts src/commands/health-view.ts
git commit -m "refactor(core): relocate pure ageText + healCmdFor into liveness (prep step 6)"
```

---

## Task 2: Scaffold `packages/web` (empty package that builds)

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/README.md`, `packages/web/src/index.ts` (temporary empty barrel: `export {};`)
- Modify: root `package.json` (build script + devDependency), root `tsconfig` build order if applicable.

**Interfaces:**
- Produces: a buildable `@cockpit/web` package referencing `@cockpit/core` + `@cockpit/shared`.

- [ ] **Step 1: Copy `packages/workspaces/package.json` as the template** for `packages/web/package.json`. Rename to `@cockpit/web`, `private: true`, `type: module`, `main`/`types` → `dist/index.js`/`dist/index.d.ts`, deps `@cockpit/core` + `@cockpit/shared` + `chalk` (match the version used elsewhere in the repo — grep `"chalk"` in root `package.json`), `scripts.build` = `tsc -b`. No `files` allowlist needed (private, bundled).

- [ ] **Step 2: Copy `packages/workspaces/tsconfig.json`** as `packages/web/tsconfig.json`. References: `[{ "path": "../core" }, { "path": "../shared" }]`. `compilerOptions`: composite, NodeNext, `outDir: dist`, `rootDir: src`.

- [ ] **Step 3: Write `packages/web/src/index.ts`** as a temporary `export {};` and `packages/web/README.md` (one paragraph: "Read-only observability surface — terminal dashboard, hub sync, and the HTTP+SSE web dashboard. Depends on @cockpit/core + @cockpit/shared only.").

- [ ] **Step 4: Wire into root build.** In root `package.json`, add `packages/web` to the prebuild `tsc -b --force packages/shared packages/core packages/agents packages/workspaces packages/web` (match the exact existing form), and add `"@cockpit/web": "workspace:*"` to root `devDependencies`. Add `{ "path": "./packages/web" }` to the root solution `tsconfig` references if one exists.

- [ ] **Step 5: Install + build the empty package.** Run: `pnpm install` then `pnpm build`. Expected: clean build, `packages/web/dist/index.js` emitted.

- [ ] **Step 6: Commit.**
```bash
git add packages/web package.json tsconfig.json pnpm-lock.yaml
git commit -m "build(web): scaffold empty @cockpit/web package (step 6)"
```

---

## Task 3: Move the seven dashboard modules + tests into `packages/web/src/`

**Files:**
- Move (git mv): `src/dashboard/{probes,read-status,render,snapshot-merge,sync-hub,web-render,web-server}.ts` → `packages/web/src/`
- Move: `src/dashboard/__tests__/` → `packages/web/src/__tests__/`
- Modify after move: `read-status.ts` (inject `call`), `web-render.ts` (import `healCmdFor`/`ageText` from `@cockpit/core`), `packages/web/src/index.ts` (real barrel).
- Modify: test files that imported `DaemonSnapshot` from `../../control/snapshot.js` → `@cockpit/core`.

**Interfaces:**
- Consumes: `@cockpit/core` (`sendRequest`, `DaemonSnapshot`, `HealthState`, `ComponentHealth`, `ageText`, `healCmdFor`), `@cockpit/shared` (`CockpitConfig`, `loadConfig`, `resolveCmuxBin`, `resolveHome`, `TaskRecord`).
- Produces (barrel exports): `readAllStatuses`, `CockpitdCall` type, `renderDashboard`, `syncHub`, `SyncHubResult`, `startWebServer`, `defaultProbeRunners`, plus `ProjectStatus`/`DashboardState`/probe types.

- [ ] **Step 1: `git mv` the seven modules and the `__tests__` dir** into `packages/web/src/`. Internal `./` imports survive (5a/5b lesson — all cross-dir refs are within-dir). Do NOT edit bodies yet.

- [ ] **Step 2: Resolve Edge 1 (inject `cockpitdCall`) in `read-status.ts`.** Remove `import { cockpitdCall } from "../commands/crew-control.js"`. Add `export type CockpitdCall = (req: unknown) => Promise<unknown>;`. Change `readAllStatuses`'s options to accept `call: CockpitdCall` and replace the `cockpitdCall(...)` call site (≈line 48) with `call(...)`. Keep the `{ kind: "list", project }` payload identical.

- [ ] **Step 3: Resolve Edges 2+3 in `web-render.ts`.** Replace `import { healCmdFor } from "../commands/heal.js"` and `import { ageText } from "../commands/health-view.js"` with a single `import { healCmdFor, ageText } from "@cockpit/core";` (merge into the existing `@cockpit/core` import if present). No other change to this 42 KB file.

- [ ] **Step 4: Fix the test-only `DaemonSnapshot` imports.** In the moved `__tests__/snapshot-merge.test.ts` and `__tests__/web-render.test.ts`, change `from "../../control/snapshot.js"` → `from "@cockpit/core"`. Update the `read-status` test to construct `readAllStatuses` with a stub `call` (e.g. `const call = async () => [];`) instead of mocking the `crew-control` module.

- [ ] **Step 5: Write the real `packages/web/src/index.ts` barrel** exporting the public surface listed under Interfaces (re-export from each module with `.js` paths).

- [ ] **Step 6: Build the package in isolation.** Run: `pnpm --filter @cockpit/web build`. Expected: PASS (proves zero residual edges into cli — any `../commands` import would fail to resolve).

- [ ] **Step 7: Boundary grep gate.** Run:
```bash
grep -rEn "from \"(\.\./)+(commands|lib|control)/" packages/web/src && echo "FAIL: cli edge remains" || echo "OK: no cli edges"
grep -rn "@cockpit/agents\|@cockpit/workspaces" packages/web/src && echo "FAIL: sibling edge" || echo "OK: no sibling edges"
```
Expected: both `OK`.

- [ ] **Step 8: Commit.**
```bash
git add -A
git commit -m "refactor(web): move dashboard into @cockpit/web; inject cockpitdCall; import ageText/healCmdFor from core"
```

---

## Task 4: Repoint the CLI consumer + delete `src/dashboard/`

**Files:**
- Modify: `src/commands/dashboard.ts` (5 imports → `@cockpit/web`; inject `cockpitdCall`).
- Modify: `src/commands/__tests__/dashboard.test.ts` if it deep-imports dashboard.
- Delete: `src/dashboard/` (should be empty after Task 3's `git mv`; remove the dir).

**Interfaces:**
- Consumes: `@cockpit/web` (`readAllStatuses`, `renderDashboard`, `syncHub`, `SyncHubResult`, `startWebServer`, `defaultProbeRunners`), and `cockpitdCall` from `./crew-control.js` (stays in cli).

- [ ] **Step 1: Repoint imports in `src/commands/dashboard.ts`.** Change the five `../dashboard/{read-status,render,sync-hub,web-server,probes}.js` imports to `@cockpit/web` (single import line or grouped). 

- [ ] **Step 2: Inject `cockpitdCall`.** Ensure `cockpitdCall` is imported from `./crew-control.js`, and update the `readAllStatuses(...)` call site(s) (`runDashboardOnce`, `runDashboardWeb` if it reads statuses) to pass `{ config, call: cockpitdCall }`. Verify the live path keeps the retry-capable `cockpitdCall` (not a stub).

- [ ] **Step 3: Update `src/commands/__tests__/dashboard.test.ts`** if needed (repoint any deep dashboard import to `@cockpit/web`; pass a `call` stub where the test exercises `readAllStatuses`).

- [ ] **Step 4: Remove the empty `src/dashboard/` directory.** Run: `git status` to confirm it's empty post-mv, then `rmdir src/dashboard` (or `git rm` any stragglers). Confirm `src/dashboard` no longer exists.

- [ ] **Step 5: Full build + the ESM gate.** Run: `pnpm build` then `node dist/index.js --help` (must print help — the NodeNext `.js` gate) and `node dist/index.js dashboard --once` against the live daemon (must render without throwing).

- [ ] **Step 6: Commit.**
```bash
git add -A
git commit -m "refactor(cli): repoint dashboard command to @cockpit/web; remove src/dashboard"
```

---

## Task 5: Full validation battery (the captain re-runs all of this on review)

These are the gates from the spec. Run them all; report pass/fail per gate.

- [ ] **Step 1: Clean-room install + build.** From the worktree root: `pnpm install --frozen-lockfile && pnpm build`. Expected: clean; `dist/index.js` + `dist/cockpitd.js` emitted.

- [ ] **Step 2: ESM gate.** `node dist/index.js --help` → prints help. `node dist/index.js dashboard --once` → renders.

- [ ] **Step 3: Socket-safe daemon boot.** Import/boot the daemon with a TEMP `sockPath` + `rotationIntervalMs: 0` + `sweepMs: 0` (never the real socket — #360). Assert it binds and answers a `health`/`list` request, then tear down.

- [ ] **Step 4: Web-server smoke (the heavy gate).** Boot `startWebServer({ port: <ephemeral>, intervalMs, sockPath: <temp daemon sock>, runners: defaultProbeRunners() })`; `fetch` `/` and assert HTML returned; connect to the SSE endpoint and assert ≥1 frame; then close the server + daemon. (Write this as a vitest test under `packages/web/src/__tests__/web-server.smoke.test.ts`, or a scratch script run once and removed — captain's choice; prefer a committed test.)

- [ ] **Step 5: Full suite.** `pnpm build` (tsc) THEN the full test run. Pass bar = exactly the 3 `relay-proxy.test.ts` #353 failures; zero new failures. Report the exact pass/fail counts.

- [ ] **Step 6: Tarball gate.** `pnpm pack` (capture the printed filename as `$(pwd)/<file>` BEFORE cd-ing), install into a temp dir, run `cockpit --help`, `cockpit dashboard --once`, and a `runtime-sync` op. Expected: functional.

- [ ] **Step 7: Report the gate matrix to the captain** (one line per gate: PASS/FAIL + evidence). Do NOT merge — the captain reviews and merges.

---

## Self-Review (planner)

- **Spec coverage:** Task 1 = relocations (edges 2,3 home); Task 3 = move + edge 1 injection + edges 2,3 repoint; Task 4 = cli repoint + delete; Tasks 2/5 = scaffold + gates. All eight spec gates appear in Task 5. ✓
- **Type consistency:** `CockpitdCall = (req: unknown) => Promise<unknown>` matches `cockpitdCall`'s real signature (`(req: unknown) => Promise<unknown>`). `ageText`/`healCmdFor` signatures copied verbatim from source. ✓
- **No placeholders:** every code step shows the actual code or exact command. ✓
- **Ordering:** relocate-in-place (Task 1) before move (Task 3) keeps every intermediate commit building. ✓
