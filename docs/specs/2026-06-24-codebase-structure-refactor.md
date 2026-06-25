# Codebase structure refactor — settle code into its declared boundaries

**Date:** 2026-06-24
**Status:** Design proposal — research-validated, ready to sequence into crew work
**Author:** research side-session (verified against live tree at `develop` / `cdd024d`)
**Related issues:** S1 → #427 · S2/S3 → #367 (thin-wrapper, **currently CLOSED — reopen**; refreshed plan posted as a comment) · S4 → #428 · S5 → #429 · S6 → #333 (LifecycleSource port — separate track)

---

## Thesis: repatriate, do not redraw

The 6-package monorepo DAG is **sound** and stays exactly as it is:

```
shared ◄ core ◄ {agents, workspaces, web} ◄ cli
```

The problem is **not** the package boundaries — it is that code leaked across them during and after the 2026-06 flat-`src/` → monorepo migration. Tests for `core` internals live in `cli`. Orchestration logic that belongs in `core`/`agents` lives inside `cli` command bodies. A pre-monorepo `control/` directory survives as a fossil. A 5.4k-LOC generated type-mirror sits inside `agents/src` and inflates every build and the GitNexus index.

**Every change in this refactor moves code to the package it already declares it belongs to.** No package is added, removed, or re-scoped. Imports only ever get *shorter* (cross-package → intra-package) or disappear. If a step requires changing the DAG, it is out of scope for this document.

One independent track (S6) is **not** repatriation — it is a design-first runtime port, already tracked as #333. It is listed here only so the sequencing is honest about what is *not* in the sweep.

---

## Current-state ground truth

Re-measured 2026-06-24 (`find packages/<pkg>/src -name '*.ts'`, splitting `__tests__/` + `*.test.ts` from the rest):

| Package | Real LOC | Test LOC | Notes |
|---|---:|---:|---|
| `@squadrant/shared` | 1,721 | 1,331 | leaf, healthy |
| `@squadrant/core` | 4,816 | 2,484 | **test LOC understated** — its real test suite lives in `cli` |
| `@squadrant/agents` | 8,539 | 3,122 | **5,384 of the 8,539 "real" LOC is generated** (`codex/protocol`, S5) |
| `@squadrant/workspaces` | 1,291 | 2,291 | `runtimes/cmux.ts` alone is 591 LOC (S6) |
| `@squadrant/web` | 1,360 | 1,101 | bundled dashboard, healthy |
| `@squadrant/cli` | 6,406 | **10,253** | **test LOC > 1.5× real LOC — it hosts core's test suite** |

The `cli` row is the headline anomaly: a thin command layer should have *less* test code than library code, not 60% more. The excess is `core`'s test suite (S1). The `agents` row is the second anomaly: subtract the 5,384 generated LOC and the hand-written package is ~3,155 LOC (S5).

---

## Findings

Each finding is verified with `file:line` evidence below. Three of the brief's framings needed correction; those are called out in **bold** so the captain doesn't act on stale assumptions.

### S1 — Test-placement inversion (highest value, lowest risk)

`packages/cli/src/control/__tests__/` holds **38 import lines from `@squadrant/core` across 28 test files**, while `packages/cli/src/control/` has only **4 non-test files** (`squadrantd.ts`, `telegram-control.ts`, `restart-daemon.ts`, `crew-routing.ts`).

The tests import `core` *internals*, not the public host surface:

```
cli/control/__tests__/daemon.test.ts:        import { createDaemon, createStore, crewTag } from "@squadrant/core"
cli/control/__tests__/state-machine.test.ts: import { reduce } from "@squadrant/core"
cli/control/__tests__/mailbox.test.ts:        import { appendToMailbox } from "@squadrant/core"
cli/control/__tests__/mailbox.test.ts:        import { readCursor, writeCursor } from "@squadrant/core"
cli/control/__tests__/launchd.test.ts:        import { renderPlist, LABEL, kickstartArgv, sanitizePathForPlist, ... } from "@squadrant/core"
```

`daemon.test.ts` alone is 53,369 bytes; `state-machine.test.ts` 17,320; `protocol-socket.test.ts` 17,143; `mailbox.test.ts` 15,113; `launchd.test.ts` 8,830; `watchdog.test.ts` 6,949. These are unit tests for `core/daemon.ts`, `core/state-machine.ts`, `core/mailbox.ts`, `core/protocol.ts`, `core/launchd.ts`, `core/watchdog.ts` — they belong in `packages/core/src/**/__tests__/`.

**Stay in `cli` (correctly testing the host shim):** every `squadrantd-*.test.ts` (e.g. `squadrantd-daemon-direct.test.ts` 24,995 B, `squadrantd-push.test.ts`, `squadrantd-telegram.test.ts`, `squadrantd-smoke.test.ts`) plus `restart-daemon.test.ts`, `telegram-control.test.ts`, `crew-control.test.ts`, `crew-pane-reader-direct.test.ts`. These test the daemon *host* (`cli/control/squadrantd.ts`) and CLI-owned glue, which legitimately live in `cli`.

**Fix:** move the core-internal test files into `packages/core/src/**/__tests__/` next to the units they exercise; their imports collapse from `@squadrant/core` to relative `../`. This is pure file movement + import-path rewrite, zero production-code change → lowest risk, highest signal-to-noise (it makes the LOC table tell the truth and lets `core` be tested without the `cli` package present).

### S2 — `cli` is a god-package (tracked by #367)

`cli` imports **70× from `core`, 32× from `workspaces`, 12× from `agents`** (non-test). Command files carry orchestration that should be library functions:

- `packages/cli/src/commands/crew.ts` — **569 LOC** (worktree mgmt + env injection + routing inside the command layer)
- `packages/cli/src/commands/telegram.ts` — 564 LOC
- `packages/cli/src/commands/side.ts` — 363 LOC
- `packages/cli/src/commands/launch.ts` — 288 LOC
- `packages/cli/src/commands/group.ts` — 174 LOC

Commands should be thin: *parse args → call a `core`/`agents` library function → format output.* The orchestration extracted out becomes unit-testable without spawning processes.

**Correction to the brief:** this is issue **#367, which is CLOSED, not open**, and it is **stale** — it predates the rebrand (says `@cockpit/core`/`@cockpit/agents`), cites `crew.ts` at **804 LOC** (now 569 — partial thinning already landed), and lists `notify-relay.ts` (407 LOC) which **no longer exists** (relay deleted). The plan must be **reopened and refreshed**, not duplicated. The concrete file-by-file plan is posted as a comment on #367 (see "Issues" below).

### S3 — `cli/src/control/` is a pre-monorepo fossil

The `control/` directory is a holdover from the flat `src/` layout. Fossil path comments still name the old location:

```
cli/control/squadrantd.ts:1     // src/control/squadrantd.ts — host: constructs concrete drivers + thin shim.
core/daemon/delivery.ts:1       // src/control/daemon/delivery.ts   ← fossil even leaked into core
```

Four survivors in `cli/control/`:

| File | Verdict |
|---|---|
| `squadrantd.ts` (9,808 B) | **Stays** — daemon host/shim, correctly in `cli` (it constructs concrete drivers) |
| `crew-routing.ts` (903 B) | **→ `core`** — pure routing types/logic, no CLI concern (`CrewRouteResult` interface + resolver) |
| `restart-daemon.ts` (1,450 B) | **→ `core`** — daemon lifecycle helper |
| `telegram-control.ts` (2,989 B) | **→ `core`** (or `core/telegram/`) — daemon-side Telegram capabilities; CLI only injects closures |

Once routing + restart + telegram-control move down and the S1 tests move to `core`, the `control/` directory **dissolves** — only `squadrantd.ts` remains and it belongs directly under `cli/src/`. S3 is the structural completion of S2 and shares its tracking issue (#367).

### S4 — Confusing twin namings (cosmetic, but one duplication claim was wrong)

| Twin | Reality |
|---|---|
| `core/daemon.ts` (26,432 B, the reducer/state-machine) **vs** `core/daemon/` (assembly dir: `start.ts`, `server.ts`, `delivery.ts`, …) | A 26 KB file sitting beside a same-named directory. Confusing; consider `core/daemon-reducer.ts` or folding the reducer under `core/daemon/`. |
| `core/delivery/` (`captain-delivery.ts`, `defer-delivery.ts`) **vs** `core/daemon/delivery.ts` | **Not duplication.** `core/daemon/delivery.ts` (185 LOC) is the *daemon-direct delivery loop* (#332); `core/delivery/` holds the *defer-while-typing primitives* (`CaptainDelivery`, `DeferDelivery`). Two different concerns, both named "delivery". Naming clarity problem, not dedup. |
| `workspaces/cmux/` **vs** `workspaces/runtimes/cmux.ts` | directory vs same-named file under a sibling dir — naming confusion. |
| `DeferDelivery` "defined in `cmux.ts`" | **The brief's duplication hypothesis is FALSE.** `DeferDelivery` is defined **once**, in `core/delivery/defer-delivery.ts:2`. `workspaces/runtimes/cmux.ts:20-21` only *imports and re-exports* it (`import { DeferDelivery } from "@squadrant/core"; export { DeferDelivery };`). There is **no duplicate logic to merge.** The smell is the **re-export hop** — `workspaces` re-publishing a `core` symbol so its own throw-sites read locally — which makes the ownership look ambiguous. |

**The S4 "dedup question" therefore resolves to a *naming/ownership* question, not a code-merge:** (a) should `workspaces/runtimes/cmux.ts` drop the `DeferDelivery` re-export and import it directly from `core` at each use? (b) rename the `daemon.ts`/`daemon/` and `delivery/`/`daemon/delivery.ts` twins so the two delivery concepts are distinguishable at a glance. This is cosmetic and gets folded into whichever step touches those files; it is **not** an independent work item beyond the tracking issue that records the decision.

### S5 — `agents/src/codex/protocol/v2` is a vendored serde mirror inside `src/`

`packages/agents/src/codex/protocol/` is a **486-file, 5,384-LOC generated type-mirror** of the Codex app-server's serde types. **485 of 486 files** carry the banner:

```
// GENERATED CODE! DO NOT MODIFY BY HAND!
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

Confirmed **genuinely generated, not hand-edited** (single non-marked file is the `index.ts` barrel). Sitting inside `src/` it: bloats `@squadrant/agents` (5,384 of its 8,539 "real" LOC), slows every `tsc`/`tsup` pass over the package, and inflates the GitNexus index — a large share of the 4,625 indexed symbols are inert type aliases.

**Fix:** move the generated tree out of `src/` — either a non-indexed `packages/agents/vendor/codex-protocol/` (with a `.gitnexusignore` / tsconfig exclude) or a bundled `.d.ts`. Hand-written code imports from a single barrel so the move is one path swap at the import sites. Verify the generator/source-of-truth is recorded (upstream Codex repo + ts-rs) so regeneration is reproducible.

### S6 — `workspaces/runtimes/cmux.ts` screen-scraping god-file (tracked by #333, SEPARATE track)

`packages/workspaces/src/runtimes/cmux.ts` is **591 LOC** with **~14 read-screen / surface-heuristic sites** (`parseDraftFromScreen`, `readInputBoxRaw`, `classifyStartupSurface`, and the `cmux ["read-screen", …]` capture calls at lines 383, 440, 494, 506, 517, 541). This screen-scraping is the root of runtime fragility — the claude CP4-idle gap and the `#258`/`#268` draft-parsing bugs all live here.

**This is NOT part of the repatriation sweep.** It is a design-first runtime port already tracked as **#333** (driver-agnostic `LifecycleSource` port: cmux-store adapter + native-hook core). It is listed here only to mark the boundary: S1–S5 settle code into existing boundaries with mechanical moves; S6 replaces *how* the runtime reads agent lifecycle and needs its own design. Do not couple them — a repatriation step must never wait on the #333 redesign.

---

## Target end-state

```
core/
  __tests__/  (+ daemon/__tests__, etc.)   ← S1: daemon/state-machine/mailbox/protocol/launchd/watchdog tests land here
  crew-routing.ts                            ← S3: moved from cli/control
  restart-daemon.ts                          ← S3
  telegram/control.ts                        ← S3: moved from cli/control/telegram-control.ts
  daemon-reducer.ts (or daemon/reduce.ts)    ← S4: disambiguated from daemon/ dir
  delivery/        (defer primitives — sole owner of DeferDelivery)
  daemon/delivery-loop.ts                    ← S4: renamed from daemon/delivery.ts

agents/
  src/            (hand-written only, ~3.1k LOC)
  vendor/codex-protocol/   ← S5: generated ts-rs mirror, excluded from build graph + GitNexus index

workspaces/
  runtimes/cmux.ts   ← imports DeferDelivery from core directly, no re-export (S4); S6 port tracked separately in #333

cli/
  squadrantd.ts      ← the only daemon-host file; control/ dir dissolved (S3)
  commands/*.ts      ← thin wrappers: parse → call core/agents → format (S2/#367)
  control/__tests__/ ← only squadrantd-*.test.ts + cli-glue tests remain (S1)
```

**Post-refactor the LOC table tells the truth:** `core` test LOC ≈ 7k (its real suite), `cli` test LOC drops below its real LOC, `agents` real LOC drops to ~3.1k hand-written.

---

## Sequenced incremental plan

**Iron rule for every step:** one crew, one isolated git worktree, full test suite **green between steps** (`pnpm build && pnpm test` — not vitest alone; vitest does not typecheck, see the #424 lesson). No step depends on the #333 redesign. Steps land as separate PRs so any one is independently revertible.

| # | Step | Scope | Risk | Gate |
|---|---|---|---|---|
| 1 | **S1 — test repatriation** | Move core-internal test files `cli/control/__tests__/{daemon,state-machine,mailbox,protocol,protocol-socket,launchd,watchdog,store,snapshot,liveness,streaming-protocol}.test.ts` → `packages/core/src/**/__tests__/`; rewrite `@squadrant/core` imports to relative. Leave all `squadrantd-*` + cli-glue tests in place. | **Lowest** — no prod code touched | full suite green; same test count, same pass count |
| 2 | **S5 — vendor the generated types** | Move `agents/src/codex/protocol/**` → `agents/vendor/codex-protocol/**`; exclude from tsconfig build graph + GitNexus index; repoint the barrel import sites. Record regeneration provenance. | **Low** — generated code, single barrel seam | full suite green; build faster; re-run `gitnexus analyze`, confirm symbol count drops |
| 3 | **S3 + S2 — dissolve `control/`, thin the commands** | **Reopen + refresh #367.** Move `crew-routing.ts`, `restart-daemon.ts`, `telegram-control.ts` → `core`; `control/` collapses to `squadrantd.ts` under `cli/src/`. Then, **one command file per PR**, extract orchestration from `crew.ts`/`launch.ts`/`side.ts`/`group.ts`/`telegram.ts` into `core`/`agents` library fns, each with a full crew-lifecycle re-test across claude/codex/opencode (`docs/testing/crew-lifecycle-checklist.md`). | **Medium** — behavior-sensitive (#278/#360/#2/#3 code paths); incremental, never big-bang | lifecycle checklist PASS on all 3 agents per PR |
| 4 | **S4 — naming/ownership cleanup** | Folded into whichever PRs above touch the files: drop the `DeferDelivery` re-export in `cmux.ts` (import from `core` directly); disambiguate `daemon.ts`/`daemon/` and `delivery/`/`daemon/delivery.ts` twins; resolve `workspaces/cmux/` vs `runtimes/cmux.ts`. Use `gitnexus_rename`, never find-and-replace. | **Low** — rename/re-export only | full suite green; `gitnexus_detect_changes` shows only renamed symbols |
| 5 | **S6 — LifecycleSource port** | **Separate independent track — #333.** Design-first; does not block or wait on steps 1–4. | High / design-first | own design doc + checklist |

Steps 1 and 2 are pure mechanical moves and can run first/parallel (different packages, no shared files). Step 3 is the substantive one and must stay incremental. Step 4 rides along. Step 5 is on its own clock.

---

## Issues

- **S1** → **#427** (`B-daemon-debt`) — test repatriation.
- **S2 / S3** → comment on **#367** (refreshed file-by-file plan posted); **#367 is CLOSED — reopen + retitle** (pre-rebrand-stale).
- **S4** → **#428** (`B-daemon-debt`) — naming/ownership; records that `DeferDelivery` is **not** duplicated.
- **S5** → **#429** (`enhancement` + `B-daemon-debt`) — vendor the generated types.
- **S6** → existing **#333**; no new issue. Cross-referenced as the separate runtime track.
