# Persisted cross-project work tracking (`squadrant work`)

**Date:** 2026-07-29
**Status:** Approved direction — NOT started
**Author:** side-session (research), with user
**Related:** #625 (trim boot prefix), #626 (`squadrant tokens`), #628 (lifecycle driver-agnostic)

---

## 1. Problem

Running several projects at once, the user loses the thread:

1. Can't remember what is in flight, or where.
2. Next day, can't reconstruct yesterday. `handoff.json` exists but is felt as
   *unreliable* — it's written only when the captain remembers, and it's one
   file per project.
3. No mechanism that says *"you started this"* → *"you must record it done"*.
4. GitHub Issues carry some of this load but don't fit.
5. Concrete failure case — **friendslop-factory** and **oneplan** both have
   multi-wave roadmaps. In practice: the work drifts off the roadmap, waves
   complete out of order, and incidents spawn side-branches of work that are
   nowhere in the roadmap. Those side-branches are currently untracked, and
   that's where the confusion comes from.
6. The recap ("what am I doing / did / will do") exists but is per-session and
   dies when the tab closes.

**Wanted:** a persisted status board that survives days and spans projects.

---

## 2. Audit of what already exists

Done before designing, as required. Verified against the live install, not docs.

| Surface | What it actually solves | Gap / defect |
|---|---|---|
| `handoff.json` + `write-handoff.sh` / `read-handoff.sh` | End-of-session snapshot. Rich shape (`currentState` / `openBranches` / `nextSteps` / `blockedItems` / `decisions`). **In practice the captain does write it** — squadrant's own handoff was updated the morning of 2026-07-29. | One-time-use by design (read consumes it). One file per project, overwritten. Prose, not queryable. Opt-in ("if work is mid-flight"). **Not a defect — see §3.** |
| `status.md` + `write-status.sh` | — | **`write-status.sh` does not exist** — absent from both `scripts/` in the repo and `~/.config/squadrant/scripts/`. Yet `plugin/skills/captain-ops/SKILL.md:33,259` and `docs/reference.md:202` still instruct captains to run it. squadrant's own `status.md` is stale since **2026-05-15** and still names `cockpit reactor poll-status`, an engine deleted in PR #155. The code already admits it: `packages/cli/src/commands/status.ts:45` — *"never from status.md, which nothing writes to"*. **Dead surface with live readers.** |
| `{spokeVault}/daily-logs/` | Per-day narrative with Completed / Blocked / Tomorrow | Opt-in → 4 files in 3 months for squadrant. Prose, not queryable, no item identity. |
| `{spokeVault}/learnings/` (112 files), `wiki/` | Knowledge capture | Not work tracking. Out of scope. |
| `squadrant status` | Captain liveness per project — **real**, sourced from the daemon liveness registry (#538) | Task counts read `status.md` frontmatter → permanently 0. |
| `squadrant standup` / `squadrant retro` | Cross-project daily/period rollup | Sources = `status.md` (dead) + daily-log (sparse) + git commits. Only git is alive → shows *what was committed*, never *what was intended*. |
| `squadrant projects` | Project registry listing | No work state. |
| `/wim` (`where-i-am` skill) | Prints exactly the wanted shape: Done / In progress / Next / Watch | Rebuilt from scratch every invocation out of 4 sources (session, claude-mem, handoff, git). Costs tokens, persists nothing, and two runs can disagree. |
| Daemon store + `TaskRecord` + state machine | The working precedent: per-project JSON, atomic `write+rename`, path-traversal guard, TTL GC (7d) + per-project cap (20), and **real chokepoints** — `crew signal done/review` refuses on a terminal record (#557), `crew approve` refuses unless state is `review` (#599). | Scoped to **crew tasks only** (`provider` / `pid` / `sessionId` / `attempts`). Nothing represents *the user's own work*. Also auto-cancels at 8h (`DEFAULT_TASK_TIMEOUT_MS`) — correct for a crew, wrong for work spanning days. |
| claude-mem (sqlite) | Durable cross-session observations, already injected (~2.7k/turn) | An event stream, not a state board. Cannot answer "what is still open". |
| `@squadrant/web` dashboard | Rendering | Same sources — adds nothing new. |
| GitHub Issues | Durable, has open/closed, has a UI | Per-repo, so no cross-project view. Heavy for a 20-minute task. And the mid-incident side-branch — the exact failure case — is precisely the work the user never opens an issue for. |

### Verdict

**Roughly 80% of the ask is durability + enforcement bolted onto what exists**,
not a new system. But one primitive is genuinely missing: the daemon has a
state machine for *crew tasks* and nothing for *the user's own work items*.

Three concrete holes:

- **H1 (zombie):** `status.md` / `write-status.sh` — dead writer, live readers,
  live instructions. Makes `standup` and `status` structurally lie.
- **H2 (missing primitive):** no work-item record for the user.
- **H3 (no chokepoint):** nothing mechanically asks "is this done?".

---

## 3. Explicit non-change: `handoff.json` stays one-time-use

An earlier draft proposed defaulting `read-handoff.sh` to `--keep` and making
handoffs append-only. **The user rejected both**, and the reasoning stands:

> A fresh session is cheaper and cleaner. Keep it only when yesterday's work is
> genuinely half-finished. The handoff is *today's note for tomorrow* — read
> once, then gone. One-time-use.

So handoff semantics are **unchanged**. Durable work tracking is a *separate*
system (§4), not a mutation of the handoff. `/wim` and `command-ops` keep their
explicit `--keep` (they are readers, not consumers).

---

## 4. Design — `squadrant work`

### 4.1 Storage

`~/.config/squadrant/work/<project>/<id>.json`

Deliberately **outside** `state/`, so the daemon's `sweep()` never sees these
records and work items survive daemon downtime. One file per item, atomic
`write-tmp + rename`, same path-segment guard as `createStore`.

Implementation note: `packages/core/src/store.ts` already encodes the
security-critical `safeSegment` + `assertUnderRoot` logic. Duplicating it is
worse than generalising it. Prefer widening `createStore` to
`createStore<T extends { project: string; id: string }>` — `TaskRecord` already
satisfies the constraint, so this is additive. **Run `gitnexus_impact` on
`createStore` before touching it** (per `CLAUDE.md`); it is a high-fan-in symbol.

### 4.2 Record shape

```json
{
  "id": "w_3f2a",
  "project": "friendslop-factory",
  "title": "Wave 3 — matchmaking",
  "state": "working",
  "parent": null,
  "tags": ["wave-3"],
  "note": "",
  "crewTaskIds": [],
  "issue": null,
  "createdAt": 1785000000000,
  "updatedAt": 1785000000000,
  "closedAt": null
}
```

States: `working` · `blocked` · `paused` · `done` · `cancelled`.
Terminal: `done`, `cancelled`.

**No heartbeat, no auto-timeout.** This is the key divergence from `TaskRecord`.
A user work item may sit open for a week; the crew's 8h wall-clock kill would be
actively wrong here. Staleness is *surfaced*, never *acted on*.

### 4.3 `parent` — the thing that solves the friendslop/oneplan case

- A wave is a work item.
- Work inside the wave is a child item (`--parent <wave-id>`).
- **An incident side-branch is an item with no parent.**

That single field makes the user's actual failure mode legible: `work list --tree`
shows planned work nested under its wave, and unplanned work sitting flat at the
top level. Waves finishing out of order is then a non-problem — order was never
encoded, so nothing breaks when it's violated.

### 4.4 Retention

`done` / `cancelled` items are deleted 30 days after `closedAt`.

Purge runs **lazily inside the `work` CLI itself** (on any `work` invocation) —
not in the daemon sweep. Work tracking must not depend on the daemon being up,
and the sweep does not need more surface area.

### 4.5 Commands

```
squadrant work start "<title>" [--project X] [--parent <id>] [--tag t]
squadrant work done   <id> [--note "..."]
squadrant work block  <id> --why "..."
squadrant work resume <id>
squadrant work cancel <id> [--why "..."]
squadrant work note   <id> "..."
squadrant work list   [--project X | --all] [--tree] [--include-done]
squadrant work link   <id> --crew <taskId>
squadrant work promote <id>          # → gh issue create, stores issue number
```

`work list` defaults to the current project when run inside a registered one,
and to `--all` otherwise. `crew spawn --work <id>` links at spawn time.

### 4.6 Enforcement — who closes, and what forces the asking

**Only the user closes an item.** The captain never runs `work done` on its own
initiative. This is a hard rule, stated in the skill and enforced by the fact
that closing requires an explicit id the captain must have been given.

But *"the captain will ask"* is, by itself, a line in a template — and the
user's own standing observation is that agents skip those. The **asking** must
be mechanical:

1. **`squadrant crew approve`** — a code path that is already a real chokepoint
   (it refuses any task not in `review` state, #599). After a successful
   approve, if the crew task is linked to a work item that is still open, print:

   ```
   ↳ work item w_3f2a "Wave 3 — matchmaking" is still open.
     Done?  squadrant work done w_3f2a
   ```

   It **prompts, it does not refuse**. Refusing would be correct three times and
   infuriating on the fourth. This is the right moment: the user is already
   looking at the diff.

2. **Captain boot brief** — `squadrant launch <project>` composes the captain's
   first turn. Inject open work items there, capped at 10 lines. This is the
   fix for "can't remember yesterday", and it re-surfaces stale items for free.
   **Agent-agnostic**: it goes through the CLI, so claude / codex / opencode /
   gemini all get it identically.

3. **`SessionEnd` hook** (`squadrant hooks claude session-end`, already installed
   globally) — emit a notifier line when items are left open. Lowest priority of
   the three; Claude-only, so it is a bonus, not the mechanism.

Explicitly **not** doing: forcing `--work <id>` on `crew spawn`. High friction,
and most of the user's work has no crew attached.

### 4.7 Token budget

**Zero added to the per-turn prefix.** Work items are read only when the user
runs a `work` command, `/wim`, or on the one-time boot brief (capped, ~<300
tokens, once per session). The captain's ~52k/turn boot prefix
(`docs/specs/2026-07-28-captain-context-budget.md`) is untouched. This is a hard
constraint, not a nice-to-have — see #625.

### 4.8 Zombie cleanup (H1)

- Remove `write-status.sh` instructions from `plugin/skills/captain-ops/SKILL.md`
  (lines 33, 259) and `docs/reference.md:202`.
- `squadrant status` / `squadrant standup` / `squadrant retro`: stop reading
  `status.md` frontmatter; source counts from the work store.
- `packages/web/src/read-status.ts`: same.
- **Do not delete existing `status.md` files** — leave them in place as history
  (project convention: archive, don't delete). Just stop reading them.

### 4.9 GitHub Issues — projection only

`squadrant work promote <id>` creates an issue and records its number on the
work item. That is the entire integration. Issues are **not** the store: they
are per-repo, useless offline, and the incident side-branch case proves the user
won't open one at the moment it matters.

---

## 5. Out of scope for v1

- Web dashboard view of work items (follow-up once the store exists).
- Cross-project dependency edges between work items.
- Any automatic closing, inferring, or state-guessing.
- Migrating existing daily-logs or handoffs into work items.
- Replacing `/wim` — it keeps synthesising, but now reads a durable board
  instead of reconstructing state from four sources.

---

## 6. Success criteria

Verifiable, checked before this is called done:

1. `squadrant work start` → the item appears in `squadrant work list` after a
   daemon restart **and** after a machine reboot.
2. A `done` item disappears from the default `work list`, remains under
   `--include-done`, and is gone from disk 30 days after `closedAt` (tested with
   an injected clock, not by waiting).
3. `work list --tree` on a fixture with two waves and one parentless incident
   item renders the incident flat at top level.
4. `squadrant crew approve` on a crew linked to an open work item prints the
   reminder, and still succeeds.
5. A fresh captain session boots with open work items in its first turn —
   verified on **claude and opencode**, not just claude.
6. `squadrant standup` shows non-zero task counts sourced from the work store
   (today it is structurally always 0).
7. Captain boot-prefix token delta measured at **0** (per `squadrant tokens`,
   #626).
8. `grep -rn "write-status" .` returns no instruction to run a script that does
   not exist.

---

## 7. Sequencing

- **A** — zombie cleanup (§4.8). Small, independent, and it stops `standup` and
  `status` from lying today.
- **B** — `squadrant work` store + commands + `--parent` + 30-day TTL (§4.1–4.5),
  then the two enforcement points (§4.6.1, §4.6.2).
- **C** — `work promote` (§4.9). Last, and small.

A can ship without B. B is the substance.
