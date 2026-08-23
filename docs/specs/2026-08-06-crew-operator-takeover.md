# Crew Operator Takeover Protocol

**Issue:** #649 (P0) · **Date:** 2026-08-06 · **Status:** DRAFT — naming approved, spec pending operator review

> **Status update (2026-08-22):** Shipped in v0.18.0 — `/takeover` and `/handback` skills are live (`plugin-crew/skills/takeover`), `squadrant crew takeover`/`squadrant crew handback` set/clear `operatorHold` on the crew task record. Kept below for the design rationale.

Naming settled by the operator on 2026-08-06: **`takeover` / `handback`**.

---

## Problem

When the operator works **directly inside a crew's tab** — rather than routing through the
captain — squadrant records nothing. The captain's model of that crew goes stale silently,
and it keeps acting on a conversation it can only see half of.

Two incidents, escalating:

**oneplan** — the operator pasted screenshots plus their own instructions straight into a
crew tab. The crew came back `CREW BLOCKED` asking which screenshot was iOS and which was
Android — a question that made no sense against the captain's own message, because the
captain had labelled them. The captain had to reverse-engineer, from the *content* of the
block, that images it had never seen must have been injected.

**prism-app, 2026-08-06, squadrant 0.17.1** — the operator adopted a finished crew's tab and
spent ~3 hours standing up a full local stack. Eight minutes after they typed "Authorize",
the captain ran `crew close` to free a `maxCrew` slot. It killed the session mid-turn and
pruned the worktree. `packages/admin/.env.local` and a generated local admin key were lost;
`packages/server/.env` survived only by luck (the crew had edited the main repo's copy, not
the worktree's).

### Why `CREW DONE` is an actively misleading safety signal

`CREW DONE` means *the task the captain delegated* is finished. It says nothing about whether
a human has since adopted the tab. At prism-app those two facts pointed in opposite
directions and the captain had no way to tell them apart. Every lifecycle indicator it had —
`CREW DONE` fired, branch pushed, PR open — read as safe.

### Why the documented workaround did not apply

#649 originally relied on "the operator mentions it manually". At prism-app the operator was
talking **to the crew**, not to the captain. There was no moment where mentioning it to the
captain would have been natural.

---

## Root cause

Two independent gaps, each sufficient on its own to cause the incident:

1. **No representation of operator ownership.** Nothing in `TaskRecord`, the state machine, or
   any CLI surface can express "a human is inside this tab". The captain cannot avoid what it
   cannot see.
2. **`crew close` overrides git's own refusal.** `packages/shared/src/lib/git-worktree.ts:206`:

   ```ts
   export function removeWorktree(repoRoot: string, wtPath: string): void {
     try   { execFileSync("git", [..., "worktree", "remove", wtPath], ...); }
     catch { execFileSync("git", [..., "worktree", "remove", "--force", wtPath], ...); }
   }
   ```

   Git refuses to remove a dirty worktree. Squadrant catches that refusal and forces past it.
   The safety mechanism exists and is being actively defeated.

### Contributing factor: the motive

The captain closed that crew **to free a `maxCrew` slot** (limit 5, 4 in use). Blocking the
action without removing the pressure just relocates the problem.

---

## Non-goals

- **Daemon-side detection of operator keystrokes.** #649 notes this would be strictly better
  since it cannot be forgotten, but also that operator input is indistinguishable from a crew
  self-prompt at the pane level. Out of scope; the open question stays on #649.
- **`squadrant crew tell`** (the original #649 proposal). Superseded — see "One mechanism,
  both incidents".
- Any change to normal crew spawn / signal / approve flow when no takeover is active.

---

## Design

### 1. Data model — an orthogonal field, not a new `TaskState`

```ts
// packages/shared/src/types/control.ts — TaskRecord
operatorHold?: {
  since: number;         // epoch ms, when the operator took over
  note?: string;         // optional: why
  lastNudgeAt?: number;  // last time the captain asked whether it is still needed
};
```

**Why not a new `TaskState`.** At prism-app the crew was `done` — *terminal* — when the operator
adopted it. `TERMINAL_STATES` is `{done, failed, cancelled}` and `task.reopened` is the only
event permitted to escape it (`state-machine.ts`). Modelling takeover as a state would force a
terminal task to be reopened on takeover and then re-terminalized to a remembered prior state
on handback — a state-restoration problem that a flag does not have.

Layering instead of replacing also produces the reading that matches reality:
`state=done` + `operatorHold` = *"the delegated task is finished, but a human is in there."*

This field lives on the `TaskRecord`, which the daemon persists to
`~/.config/squadrant/state/<project>/<taskId>.json` via atomic tmp+rename (`core/src/store.ts:56`).
No new file, no new store. It therefore survives `/compact`, daemon restart, and reboot for free,
and appears in `handoff facts` because the captain already reads from there.

> Deliberately **not** the work-store (`~/.config/squadrant/work/`, #630) — that tracks
> operator-level work items across sessions, not crew task state. And **not** `status.md`,
> which is dead: nothing has written it since #653/#656 purged it along with
> `write-status.sh` / `read-status.sh` (see the comment at `cli/src/commands/status.ts:9`).

### 2. Events

Two additions to `ControlEvent`:

```ts
| { type: "crew.takeover.started"; id: string; note?: string }
| { type: "crew.takeover.ended";   id: string; note?: string }
```

`reduce()` sets / clears `operatorHold` and touches nothing else.

**Both must apply to terminal records.** They do not mutate `state`, so permitting them on a
terminal task introduces none of the hazards `TERMINAL_STATES` exists to prevent. The prism-app
case (`state=done`) is exactly the case that matters, so this is load-bearing, not an edge case.

Idempotence: a second `started` on an already-held task refreshes nothing and is not an error.
An `ended` on a task with no hold is a no-op warning, not an error — the operator should never
be punished for over-releasing.

### 3. CLI — the source of truth

```bash
squadrant crew takeover <project> <crew> [--note "..."]
squadrant crew handback <project> <crew> [--note "..."]

# from inside a crew, where the task id is already in env:
squadrant crew takeover --task-id "$SQUADRANT_CREW_TASK_ID" [--note "..."]
```

Resolves crew name → task id (or takes `--task-id` directly), emits the event, and pushes a
line into the captain's pane. This mirrors `crew signal`, which already accepts both forms.

**Slash commands do two things.** `/takeover` and `/handback` ship as crew-side skills that:

1. **Shell out to the CLI** — `squadrant crew takeover --task-id "$SQUADRANT_CREW_TASK_ID"`.
   `SQUADRANT_CREW_TASK_ID` and `SQUADRANT_CREW_PROJECT` are injected into every crew's env at
   spawn (`core/src/crew-spawn.ts:358`). No name resolution needed, no logic duplicated.
2. **Tell the crew itself that the operator is now its principal** — the skill body instructs
   the crew: you are working directly for the operator, not the captain; **do not
   `squadrant crew signal done`** when you finish what the operator asked; wait for `/handback`.

Step 2 is load-bearing, not decoration. Without it the crew finishes the operator's ad-hoc work
and signals `done` on its own, the captain sees `CREW DONE`, and the exact misleading signal
from prism-app is recreated inside the mechanism built to prevent it.

**Known limitation, inherited from `crew signal`:** codex crews do not receive `SQUADRANT_CREW_*`
in their environment (`agents/src/codex/driver.ts:272` — only claude and opencode get them on
shell launch). For codex, pass `--task-id` explicitly or use the `<project> <crew>` form from a
terminal. Not a new gap; do not solve it here.

Why CLI-first rather than slash-only:

- **Portable.** Slash commands are agent-specific. The operator's default crew agent is
  opencode; codex and gemini differ again. The CLI works from any terminal against any agent.
- **Not queued.** A slash command typed into a busy crew waits behind the current turn. That
  gap between typing and registering is precisely the window prism-app died in. The CLI hits
  the daemon immediately and works even when the crew is wedged.

The slash commands are kept because they preserve the type-in-the-tab UX, which is what makes
the protocol get used at all.

**Token cost, accepted:** `CREW_SKILLS` is deliberately scoped to `["karpathy-principles"]`
(#625) to keep the crew boot prefix small. Two more skills widen it. The operator accepted this
explicitly — the UX is worth the tokens. Keep both skills minimal (a few lines each).

### 4. Enforcement is mechanical, not advisory

The #653 finding is the governing precedent: **a rule that lives only in a template is
voluntary.** The prism-app captain would have honoured a "don't close a held crew" rule — it
simply had no way to know the crew was held. The gate must be in the CLI.

| Surface | Behaviour when `operatorHold` is set |
|---|---|
| `runCrewClose` | **Refuse.** `--force` required. |
| `runCrewSend` | **Refuse.** `--force` required. |
| Notifier | Crew signals (`done` / `idle` / `blocked` / `review`) are logged as informational, **not** pushed to the captain as actionable. |
| `crew list` / `crew tasks` | Held crews are listed under a separate `HELD` group and **excluded from the active count** the captain reads. |

`crew approve` is intentionally **not** blocked — it already sits behind the human review gate
(#599 / #656), so it cannot fire without the operator anyway.

#### `maxCrew` is honor-system — verified, not assumed

`maxCrew` has **no enforcement path in code**. Outside `config.ts` (type + default 5), drift
config, tests and docs, the only reference in the entire repo is one line of prose at
`plugin/skills/captain-ops/SKILL.md:197`: *"Respect `maxCrew` — don't exceed the configured
concurrent crew count."* Nothing counts crews; nothing refuses a spawn.

So "exclude held crews from `maxCrew`" cannot be implemented as an accounting change — there is
no accounting. It resolves to two things:

1. `crew list` / `crew tasks` separate held crews from active ones, so the number the captain
   counts already excludes them.
2. The `captain-ops` line is amended to say held crews do not count toward the limit, and that
   when the limit is reached the captain asks the operator rather than choosing a crew to close.

**This remains honor-system enforcement** — precisely the weak kind #653 warned about. It is
accepted here because the *destructive* path (`crew close`) is mechanically gated by §4 and §5
regardless, so a miscount can no longer destroy anything. Building real `maxCrew` enforcement is
out of scope; file it separately if it matters.

The operator accepted the trade-off that live sessions may exceed `maxCrew` while takeovers are
open, over the alternative (held crews consume slots, captain nags when full).

The captain templates get a corresponding clause explaining *why*, so the captain reasons
correctly rather than merely bouncing off a refusal. The CLI remains the actual gate.

### 5. Second layer — catches a forgotten takeover

Independent of the protocol above. This is what protects the operator who simply starts typing.

1. **Stop forcing past git.** Remove the `catch { --force }` fallback in `removeWorktree`.
   If git refuses, the refusal stands.
2. **`crew close` inspects the worktree first.** If it is dirty, refuse and print: the worktree
   path, the uncommitted file list, and the question *why are these uncommitted?* — the operator
   answers before anything is destroyed. `--force` overrides.
3. **Make recovery discoverable.** On close, print the session transcript path and the
   `claude --resume <session-id>` command. At prism-app the transcript survived on disk, but
   the captain reconstructed the recovery route by hand; an operator who did not know
   transcripts survive would reasonably conclude the work was gone.

### 6. Visibility across sessions

`crew list`, `crew tasks`, and `handoff facts` → `liveCrews` each surface a `HELD` marker plus
duration. This is the payoff of storing on `TaskRecord`: a captain booting cold, or resuming
after `/compact`, sees the takeover without being told.

### 7. Nudge, never auto-release

The watchdog emits an informational `CREW HELD-LONG` when `operatorHold.since` exceeds a
configurable threshold (default 6h) and no nudge has fired recently. The captain then asks the
operator.

**Nothing auto-releases a takeover.** A timeout would recreate the original defect: a moment
where the hold lapses while the operator is still working in the tab.

### 8. One mechanism, both incidents

The oneplan case is a short takeover: `takeover` → paste screenshots → `handback`. The handback
notification tells the captain to `crew read` before continuing, which is exactly the
information it lacked. No separate `crew tell` wrapper is needed.

---

## Captain-facing notifications

| Trigger | Message |
|---|---|
| takeover | `CREW TAKEOVER [<project>/<crew>] — operator is driving this tab. Do not send, do not close, do not act on its signals until handback.` + note |
| handback | `CREW HANDBACK [<project>/<crew>] — operator returned control. State: <state>. Run 'squadrant crew read' before acting; the tab has history you did not see.` + note |
| long hold | `CREW HELD-LONG [<project>/<crew>] — held <N>h. Ask the operator whether it is still in use. Do not release it yourself.` |

---

## Success criteria

1. `crew close` on a held crew fails without `--force`, and the prism-app sequence is
   unreproducible.
2. `crew close` on a crew with a dirty worktree fails without `--force`, **even with no
   takeover recorded** — the forgotten-command path is covered.
3. A captain booting cold (fresh session, post-`/compact`) sees `HELD` in `handoff facts`
   without being told.
4. A takeover recorded on a `done` (terminal) task persists and is readable — the exact
   prism-app shape.
5. `crew list` / `crew tasks` show held crews separately, so the count the captain reads
   already excludes them. (No code-level `maxCrew` enforcement exists to change — see §4.)
6. `/takeover` and `/handback` produce state identical to the CLI commands.
7. A crew under takeover does not emit `crew signal done` on its own — it waits for handback.
8. No takeover recorded → every existing flow behaves exactly as before.

## Testing

**`reduce()` unit tests**
- takeover on `working`; on `done` (terminal — the load-bearing case); on `blocked`
- handback restores nothing and leaves `state` untouched
- double takeover is idempotent; handback with no hold is a no-op, not a throw

**CLI**
- `crew close` refuses when held; succeeds with `--force`
- `crew close` refuses when the worktree is dirty and no hold exists; succeeds with `--force`
- `crew send` refuses when held; succeeds with `--force`
- `removeWorktree` propagates git's refusal instead of forcing

**Integration**
- `crew list` / `crew tasks` group held crews separately from the active count
- a crew signalling `done` while held produces no actionable captain push
- `handoff facts` carries `operatorHold` through to `liveCrews`

Repo gate: `pnpm build` + full `pnpm test` (2430+ tests) on the authoritative checkout, plus
`node dist/index.js --help` — NodeNext means a missing `.js` extension in a relative import
typechecks clean and dies at runtime.

---

## Related

- **#661** — `crew spawn` bases the worktree on the GitHub default branch rather than the
  captain's checked-out branch (`resolveWorktreeBase`, `git-worktree.ts:62`). Same file, same
  worktree lifecycle, filed the same session. Separate fix; worth batching into one crew.
- **#656** — the human review gate. Same defect family: something acts on the operator's behalf
  with no gate.
- **#625** — `CREW_SKILLS` scoping, which §3 knowingly widens.
