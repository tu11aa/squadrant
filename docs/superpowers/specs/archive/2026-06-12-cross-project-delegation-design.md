# Cross-project (intra-group) delegation — design

> **✅ Shipped** (PR #274, 2026-06-12). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Issue:** #246 — Clearer cross-project communication flow
**Date:** 2026-06-12
**Status:** Approved design, pending implementation

## Problem

Sibling projects in a group (e.g. `scaffold-stylus` ↔ `scaffold-stylus-docs`, `brove` ↔ `brove-docs`) have no first-class way for one captain to ask another to do work. Group awareness today is passive (config `group`/`groupRole` + claude-mem context). There is no defined channel for a stylus captain to say "stylus-docs, please document this change" and have it land as actionable, tracked work in the sibling.

## Decisions (from brainstorm)

| Decision | Choice |
|----------|--------|
| What happens on B's side | **Auto-accept + work** — B's captain automatically takes the task and spawns a crew. |
| Trigger surface | **`cockpit group dispatch`** (Phase 1), later extended by **`runtime send --to-captain`** (Phase 2). |
| Boot semantics | If B (captain workspace + relay) is **not up**, dispatch boots it and waits for warmup before delivering. |
| Report-back | **Auto relay-back + wake A** — B's done/blocked signal routes back and wakes A's captain. A dispatches-and-yields, never polls (consistent with #241). |
| Reach | **Same-group only** for now. Cross-group is out of scope (captains can read config to stay *aware* of other groups; no dispatch channel to them). |
| Safety toggle | B's config gets `acceptDelegations` (**default true**); a project can opt out. |

## Architecture — one new field, reuse the per-project relay

The key insight: cockpit already routes per-project. `TaskRecord` has a `project` field (`src/control/types.ts:43`); the mailbox is per-project (`${project}.log`); each captain runs a per-project notify-relay that watches its own project and wakes its captain. **A cross-project task is just a normal task that remembers where it came from.**

### Data model

Add one optional field to `TaskRecord`:

```ts
originProject?: string;  // set when this task was delegated from a sibling captain
```

A delegated task is recorded with `project: B, originProject: A`. No new bus, no new transport:
- **Delivery to B:** B's existing relay already watches project B → it wakes B's captain with the request.
- **Report-back to A:** when the task settles, the daemon sees `originProject: A` and fans the signal back to **A's** mailbox → A's relay wakes A's captain.

### `cockpit group dispatch <to-project> "<task>"` — flow

1. **Resolve & gate.** A = current project (from cwd/config), B = `<to-project>`. Reject if B is not in A's `group`. Reject if B has `acceptDelegations: false` (clear message, no silent drop).
2. **Ensure B is up.** If B's captain workspace / relay are not running, `cockpit launch B` and start B's relay, then **wait for warmup** — bounded poll on relay heartbeat / captain-pane readiness with a hard timeout (no unbounded loop). If warmup times out, fail the dispatch with a clear error (task not recorded).
3. **Record.** Write the task to the daemon: `{ project: B, originProject: A, status: submitted, task: "<task>" }`.
4. **Deliver.** B's relay wakes B's captain: `📨 Cross-project task from <A>: <task>`. If `acceptDelegations` is true, B's captain auto-accepts and spawns a crew (opencode default) to do the work.
5. **Yield.** A's `group dispatch` returns immediately; A's captain dispatches-and-yields. No polling.

### Report-back round-trip

When B's crew signals `done` / `blocked` / `failed`:
1. Daemon updates the task record.
2. Daemon sees `originProject: A` and writes a report event to A's mailbox.
3. A's relay wakes A's captain: `✅ Delegated task → B: done` (or `⛔ Delegated task → B: blocked — <reason>`).

Both sides are event-driven; neither polls.

### Safety

- **Same-group check** is the hard boundary — enforced in `group dispatch` before anything is recorded or booted.
- **`acceptDelegations`** (per-project config, default `true`) lets a project opt out of being driven. When `false`, dispatch is rejected (Phase 1 keeps it simple — no notify-only downgrade).

### captain-ops skill

Add a "Cross-project delegation" section to the captain-ops skill:
- When to use `group dispatch` (a task genuinely belongs to a sibling).
- The same-group rule and `acceptDelegations` behavior.
- That report-back auto-wakes the captain — **dispatch and yield, do not poll** the sibling.

## Components & boundaries

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `group` command (`src/commands/group.ts`, new) | Parse `group dispatch`, resolve A/B, same-group gate, boot-if-down + warmup wait, record task, return | config, launch, daemon client, relay status |
| `TaskRecord.originProject` (`src/control/types.ts`) | Carry origin so report-back can route | — |
| Daemon report-back (`src/control/…`) | On settle, if `originProject` set, write report event to origin's mailbox | mailbox, state-machine |
| `acceptDelegations` (config) | Per-project opt-out | config schema |
| captain-ops skill section | Teach captains the flow | — |

## Phasing

- **Phase 1 (this issue, #246):** `group dispatch` + `originProject` + report-back + same-group gate + `acceptDelegations` + captain-ops section. Tests for: same-group gate, boot-if-down warmup timeout, record shape, report-back fan-out to origin.
- **Phase 2 (later, separate issue):** `cockpit runtime send --to-captain <project> "<msg>"` for free-form peer captain↔captain comms, riding the same `originProject` rail. Not built now.

## Out of scope

- Cross-group delegation.
- Notify-only downgrade when `acceptDelegations: false`.
- Multi-hop delegation chains (A→B→C tracking).
- Phase 2 peer comms.

## Success criteria

1. `cockpit group dispatch <sibling> "<task>"` from project A records a task on B with `originProject: A`, booting B if it was down.
2. B's captain is woken with the request and (when `acceptDelegations` is true) auto-spawns a crew.
3. On completion/block, A's captain is auto-woken with the outcome — without A polling.
4. Dispatch to a non-same-group project, or to a project with `acceptDelegations: false`, is rejected with a clear message.
5. captain-ops documents the flow and the dispatch-and-yield discipline.
