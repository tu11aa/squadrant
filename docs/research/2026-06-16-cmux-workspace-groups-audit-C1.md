# cmux workspace groups — investigation & disposition (audit item C1)

**Date:** 2026-06-16 · **Branch:** `feat/workspace-groups` · **cmux:** 0.64.16 (96)

**Disposition: DEFER.** Investigated all three proposed mappings live. None map
cleanly onto cockpit's surface-based crew model + existing launch flow without
either spawning phantom workspaces or an architectural redesign. No runtime code
was added — this is an "investigated, dispositioned" outcome.

## The proposal

The audit suggested mapping **captain → group anchor, crews → group members**
using `cmux workspace-group` (0.64.x: `create`/`add`/`remove`/`set-color`/
`set-icon`/`move`/`focus`/`new-workspace` + per-group placement). Three concrete
options were on the table:

- **(a)** Per-project visual identity — give each captain workspace a colored/
  iconed group header so projects are distinguishable at a glance.
- **(b)** Cross-project sibling grouping — group the captain workspaces of
  projects sharing a cockpit `group` (e.g. all `scaffold-*`) under one cmux
  group. Aligns with the "sibling projects aware of each other" goal.
- **(c)** The original captain+crews framing.

## STEP 0 — what does `workspace-group` actually operate on?

`cmux workspace-group --help` is unambiguous:

> Each group is owned by an **"anchor" workspace**; the group header IS the
> anchor's sidebar representation. Closing the anchor dissolves the group while
> preserving its other members as ungrouped workspaces.

**Groups group whole _workspaces_, not _surfaces_.** Live-captured shape:

```json
{ "groups": [ {
    "anchor_workspace_ref": "workspace:4",
    "custom_color": null, "icon_symbol": null,
    "is_collapsed": false, "is_pinned": false,
    "member_count": 2,
    "member_workspace_refs": ["workspace:4", "workspace:1"],
    "name": "cockpit-shape-probe",
    "ref": "workspace_group:1"
} ], "window_ref": "window:1" }
```

## Cockpit reality (confirmed live)

Cockpit creates **one workspace per project** — the captain — via
`cmux workspace create --command <agentCmd>` (`src/runtimes/cmux.ts` `spawn()`).
**Crews spawn as `new-surface` tabs _inside_ the captain's workspace**
(`cmux.ts` `newPane()` / `spawnInjector()`), not as separate workspaces. The
separate-workspace-per-crew redesign was rejected in #117.

Directly confirmed while investigating: this crew's own CLI ran as
`surface:18` inside `workspace:3` titled `⚓ cockpit-captain` — i.e. a surface
in the captain workspace, exactly the model above.

## Why each option does not map cleanly

### (c) captain + crews → **hard mismatch**
Crews are _surfaces_; `workspace-group` can only contain _workspaces_. There is
exactly one workspace per project (the captain's). "Captain + its crew tabs as a
group" has no representation. Dead, as the prior crew predicted.

### (a) / (b) workspace-level grouping → **not clean: phantom workspaces**
Both (a) and (b) operate at the right altitude (workspace↔workspace), so they
_look_ viable. They are not, because of how a group comes into existence:

- **`create` spawns a phantom anchor.** Live test:
  `workspace-group create --name X --from workspace:1` produced a **brand-new**
  `workspace:4` as the anchor and added `workspace:1` as a member
  (`member_count: 2`). It did **not** simply wrap the existing workspace. So
  forming a group around already-running captain workspaces leaves a stray,
  empty anchor workspace behind.
- **No `--command` genesis path.** Neither `workspace-group create` nor
  `workspace-group new-workspace` accepts `--command`, so a captain — which
  must be born with its agent CLI via `cmux workspace create --command …` —
  cannot be created _inside_ a group through the group CLI. The captain can only
  be `add`-ed to a group _after_ it already exists as a standalone workspace.
- **Genesis therefore requires `create` → phantom**, then `add` the real
  captains, then `set-anchor` to a real captain, then close the phantom. That is
  multi-step driver-fighting, not a clean wiring — precisely what the task
  warned against ("coordinate via config, don't fight the driver"). It even trips
  cockpit's own workspace-protection guard: the auto-mode classifier denied
  closing the phantom workspace ("user's own workspaces untouched").

Making the phantom _useful_ (a dedicated always-present "group home" workspace
per group) would be a new architectural element — out of scope for a
conservative release and explicitly a "defer on architectural redesign" case.

## Decision

**DEFER.** No runtime code added. Per the audit's decision rule, a clean
investigated-and-dispositioned outcome is the deliverable here.

Re-open if **either** upstream change lands in cmux:

1. A phantom-free way to form a group from an existing workspace (e.g.
   `workspace-group create --anchor <existingWs>` that promotes it in place), **or**
2. `--command` support on `workspace-group new-workspace` / `create`, letting a
   captain be born directly inside a group through the normal spawn path.

With either, **option (b)** (cross-project sibling grouping keyed off the
existing `ProjectConfig.group` field) becomes the clean, valuable target, with
(a)'s per-project color as a deterministic side-benefit. Until then, projects
remain visually distinguished by their captain workspace emoji/title (e.g.
`⚓ cockpit-captain`), which already covers the bulk of (a)'s value with zero
risk.

## Verification artifacts cleaned up

The probe created `workspace:4` (`cockpit-shape-probe`); it was ungrouped and
closed, and the sidebar was confirmed restored to its pre-probe state
(captain + user home, 0 groups).
