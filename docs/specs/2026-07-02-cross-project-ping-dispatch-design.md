# Cross-Project Ping & Dispatch

**Status:** Implemented
**Date:** 2026-07-02
**Author:** crew/ping-dispatch (approved design from captain brainstorm)
**Scope:** control plane — `squadrant ping`, `squadrant dispatch`, `group-dispatch.ts`

## Problem

`squadrant group dispatch` (#246/#367) hard-gated dispatch to same-group siblings only —
`group-dispatch.ts:89` threw if `fromCfg.group !== toCfg.group`. Any registered project
should be reachable; group membership should grant *extra* guarantees on top, not be a
prerequisite for reach at all.

There was also no fire-and-forget tier — every cross-project message had to go through
the tracked-task machinery even for a one-line FYI.

## Design

Two top-level commands, both usable against **any registered project**:

1. **`squadrant ping <project> "<msg>"`** — fire-and-forget. Delivers the message into
   the target's captain pane via the same mechanism `squadrant runtime send <project>
   "<msg>"` already uses cross-group (reused as-is, not reinvented). No tracked task, no
   report-back. Unregistered project → clear error (existing `resolveTarget` error path).

2. **`squadrant dispatch <project> "<task>"`** — tracked. Reuses the existing
   `dispatchToSibling` machinery in `packages/core/src/group-dispatch.ts` unchanged in
   shape, minus the hard same-group gate. `squadrant group dispatch` becomes a
   **deprecated alias**: it still works, delegates to the same `dispatchAction`, and
   prints a one-line deprecation note pointing at `squadrant dispatch`.

### What group membership still buys you

The `acceptDelegations` check (reject if the target set `acceptDelegations: false`,
default `true`) already applied regardless of group and is unchanged.

The one guarantee that *is* group-gated is **boot-if-down**:

- **Same-group**, target captain not running → `dispatch` boots it
  (`bootCaptain` → `squadrant launch <project>`) and waits for warmup (bounded poll,
  120s hard timeout, unchanged from #288).
- **Cross-group**, target captain not running → `dispatch` does **not** attempt to boot
  it. It fails fast with an error suggesting `ping` (if the captain is reachable another
  way) or starting it manually with `squadrant launch <project>`, then retrying. This
  avoids silently paying a 120s timeout for a boot that was never going to happen, and
  avoids one project's captain unilaterally launching an unrelated project's captain
  without that project's own operator having asked for it.

Once a target captain is up, cross-group and same-group dispatch behave identically —
same task record shape, same report-back to the origin project's mailbox on settle.

## Non-Goals (explicitly out of scope)

- Unregistered / machine-only project discovery. `ping`/`dispatch` only reach projects
  already in `config.projects`.
- Any new consent model beyond `acceptDelegations`. No per-target allow/deny lists, no
  approval prompts — the existing boolean is the only gate.
- Changing report-back format, task record shape, or the daemon-side settle/notify path.

## Implementation notes

- `packages/core/src/group-dispatch.ts`: removed the `!fromCfg.group || !toCfg.group ||
  fromCfg.group !== toCfg.group` throw. Added a `sameGroup` boolean used only to decide
  the boot-if-down branch. `acceptDelegations` check untouched (still runs before the
  aliveness check, still applies to every target regardless of group).
- `packages/cli/src/commands/dispatch.ts` (new): `runDispatch` (throws) + `dispatchAction`
  (catches, prints, `process.exit(1)`) + the `dispatchCommand`. This is the extraction of
  what used to live inline in `group.ts`.
- `packages/cli/src/commands/group.ts`: thinned to a deprecated wrapper — prints the
  deprecation note, then calls the shared `dispatchAction`.
- `packages/cli/src/commands/ping.ts` (new): `runPing` reuses `buildRegistry` /
  `resolveTarget` / `needRef` exported from `runtime.ts` (previously module-private) —
  same resolution + delivery path as `runtime send`, no new mechanism.
- `packages/cli/src/index.ts`: registers `pingCommand` and `dispatchCommand` at the top
  level alongside the existing `groupCommand`.

## Tests

`packages/core/src/__tests__/group-dispatch.test.ts`:
- cross-group dispatch to an alive captain now succeeds (was: hard-gate throw)
- cross-group dispatch to a down captain throws a no-boot error and never calls
  `bootCaptain`
- cross-group dispatch still respects `acceptDelegations: false`
- same-group dispatch still boots a down captain via `bootCaptain` and proceeds
- same-group warmup-timeout behavior unchanged

`packages/cli/src/commands/__tests__/ping.test.ts`:
- unregistered project → clear error, no send
- registered + running → delivers via the runtime driver
- registered + not running → clear error, no auto-boot, no send

`packages/cli/src/commands/__tests__/dispatch.test.ts` / `group.test.ts`:
- `dispatchCommand` wires `project`/`task` args and calls `dispatchToSibling` with the
  resolved `fromProject`
- errors from `dispatchToSibling` propagate through `runDispatch`
- `group dispatch` prints the deprecation note and delegates to the shared
  `dispatchAction` with the same arguments

## Docs updated

- `plugin/skills/captain-ops/SKILL.md` — Cross-Project Delegation section rewritten:
  `ping`/`dispatch` reach any registered project; group is extra guarantees
  (boot-if-down), not a requirement.
- `docs/reference.md` — command table: added `ping`/`dispatch`, marked `group dispatch`
  as a deprecated alias.
