# Crew Operator Takeover Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Follow `plugin/skills/karpathy-principles/SKILL.md` and `superpowers:test-driven-development`.

**Spec:** [`docs/specs/2026-08-06-crew-operator-takeover.md`](../specs/2026-08-06-crew-operator-takeover.md) — read it before Task 1.
**Issues:** #649 (P0) primary, #661 folded in as Task 9.

**Goal:** Let the operator take over a crew's tab explicitly, make the captain aware of it, and make it mechanically impossible for the captain to destroy that session.

**Architecture:** An orthogonal `operatorHold` field on `TaskRecord` (never a new `TaskState` — a takeover must be recordable on a `done`/terminal task). Two `ControlEvent`s set and clear it. The CLI is the only source of truth; slash commands are thin wrappers. Enforcement lives in the CLI (`crew close` / `crew send` refuse), never only in a template. A second, independent layer stops `crew close` from forcing past git's own dirty-worktree refusal, which covers the case where the operator forgets to run the command at all.

**Tech Stack:** TypeScript (NodeNext ESM), pnpm workspace, vitest, commander.

## Global Constraints

- **NodeNext ESM:** every relative import needs an explicit `.js` extension. `tsc` and `vitest` both miss a missing one; it dies at runtime. `node dist/index.js --help` is the real gate.
- **Package DAG is one-way:** `shared ◄ core ◄ {agents, workspaces, web} ◄ cli`. Never import upward.
- **Naming is settled:** `takeover` / `handback`. Do not rename.
- **macOS-only project.** Guard platform-specific tests with `it.skipIf(process.platform !== "darwin")`.
- **Do not build `maxCrew` enforcement.** It does not exist today (verified: the only non-config, non-test reference in the repo is one line of prose at `plugin/skills/captain-ops/SKILL.md:197`). Out of scope.
- **Do not attempt daemon-side detection of operator keystrokes.** Explicit non-goal in the spec; the open question stays on #649.
- **Full gate before signalling review:** `pnpm build && pnpm test` (2430+ tests) plus `node dist/index.js --help`.
- Commit after every task. Conventional commits, reference the issue.

---

### Task 1: `operatorHold` on the record, and the two events that move it

**Files:**
- Modify: `packages/shared/src/types/control.ts` (`TaskRecord` ~line 42; `ControlEvent` union ~line 150-180)
- Modify: `packages/core/src/state-machine.ts` (`reduce()`)
- Test: `packages/core/src/__tests__/state-machine.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TaskRecord.operatorHold?: { since: number; note?: string; lastNudgeAt?: number }`; events `crew.takeover.started` and `crew.takeover.ended`, both `{ type, id, note? }`.

**Read first:** `reduce()` in `state-machine.ts`. Note the guard near the top that absorbs events on terminal states, and the `task.reopened` comment explaining it is "the ONE event allowed to escape a terminal state". Your two events are different: they never touch `state`, so they must be allowed to *apply* on a terminal record without escaping it.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/__tests__/state-machine.test.ts
describe("operator takeover (#649)", () => {
  const base = (over: Partial<TaskRecord> = {}): TaskRecord => ({
    id: "t1", project: "p", provider: "claude", mode: "interactive",
    state: "working", task: "x", createdAt: 0, lastHeartbeat: 0,
    lastEvent: "task.started", heartbeatBudgetMs: 1000, attempts: [],
    ...over,
  });

  it("records a takeover on a working task without changing state", () => {
    const next = reduce(base(), { type: "crew.takeover.started", id: "t1", note: "local stack" }, 5000);
    expect(next.state).toBe("working");
    expect(next.operatorHold).toEqual({ since: 5000, note: "local stack" });
  });

  // THE load-bearing case: prism-app's crew was `done` when the operator adopted it.
  it("records a takeover on a DONE (terminal) task", () => {
    const next = reduce(base({ state: "done" }), { type: "crew.takeover.started", id: "t1" }, 5000);
    expect(next.state).toBe("done");
    expect(next.operatorHold?.since).toBe(5000);
  });

  it("handback clears the hold and leaves state untouched", () => {
    const held = reduce(base({ state: "done" }), { type: "crew.takeover.started", id: "t1" }, 5000);
    const next = reduce(held, { type: "crew.takeover.ended", id: "t1" }, 9000);
    expect(next.state).toBe("done");
    expect(next.operatorHold).toBeUndefined();
  });

  it("a second takeover is idempotent — `since` does not drift", () => {
    const a = reduce(base(), { type: "crew.takeover.started", id: "t1" }, 5000);
    const b = reduce(a, { type: "crew.takeover.started", id: "t1" }, 8000);
    expect(b.operatorHold?.since).toBe(5000);
  });

  it("handback with no hold is a no-op, not a throw", () => {
    expect(() => reduce(base(), { type: "crew.takeover.ended", id: "t1" }, 5000)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm vitest run packages/core/src/__tests__/state-machine.test.ts -t "operator takeover"`
Expected: FAIL — the event types do not exist on `ControlEvent`, so this will not even typecheck.

- [ ] **Step 3: Add the field to `TaskRecord`**

```ts
// packages/shared/src/types/control.ts — inside TaskRecord
  /** #649: set while the OPERATOR is driving this crew's tab directly rather
   *  than the captain. Deliberately orthogonal to `state`, not a TaskState:
   *  a takeover must be recordable on a terminal record (at prism-app the crew
   *  was `done` when the operator adopted it), and modelling it as a state
   *  would force a reopen on takeover plus prior-state restoration on handback.
   *  While set, the CLI refuses `crew close` and `crew send` without --force,
   *  and the daemon suppresses actionable captain pushes for this task. */
  operatorHold?: { since: number; note?: string; lastNudgeAt?: number };
```

- [ ] **Step 4: Add the two events to the `ControlEvent` union**

```ts
// packages/shared/src/types/control.ts — in the ControlEvent union
  // #649: the operator has taken over / handed back this crew's tab. Neither
  // event mutates `state`, so both are valid on a terminal record — that is the
  // whole point (see TaskRecord.operatorHold).
  | { type: "crew.takeover.started"; id: string; note?: string }
  | { type: "crew.takeover.ended"; id: string; note?: string }
```

- [ ] **Step 5: Handle both in `reduce()`**

Place these cases **before** any terminal-state absorption guard, so they apply to `done`/`failed`/`cancelled` records.

```ts
// packages/core/src/state-machine.ts — in reduce(), alongside the task.reopened case
    case "crew.takeover.started":
      // Idempotent: keep the original `since` so a repeat does not reset the
      // clock the HELD-LONG nudge measures from.
      if (rec.operatorHold) return { ...rec, lastHeartbeat: now, lastEvent: ev.type };
      return {
        ...rec,
        operatorHold: { since: now, ...(ev.note !== undefined ? { note: ev.note } : {}) },
        lastHeartbeat: now,
        lastEvent: ev.type,
      };
    case "crew.takeover.ended": {
      // Over-releasing must never be punished — a no-op, not an error.
      const { operatorHold: _dropped, ...rest } = rec;
      return { ...rest, lastHeartbeat: now, lastEvent: ev.type };
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/state-machine.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/control.ts packages/core/src/state-machine.ts packages/core/src/__tests__/state-machine.test.ts
git commit -m "feat(core): record operator takeover on TaskRecord (#649)"
```

---

### Task 2: `squadrant crew takeover` / `handback`

**Files:**
- Modify: `packages/cli/src/commands/crew-control.ts` (register next to `signal`, ~line 441)
- Test: `packages/cli/src/commands/__tests__/crew-takeover.test.ts` (create)

**Interfaces:**
- Consumes: the two events from Task 1.
- Produces: `runCrewTakeover(mode: "start" | "end", opts, deps)` — resolves the task id, emits the event, returns the resolved `TaskRecord`.

**Read first:** `runCrewSignal` in the same file (~line 192). Mirror its shape exactly: it resolves `--task-id` / `SQUADRANT_CREW_TASK_ID` env, falls back to `--project` / `SQUADRANT_CREW_PROJECT`, and does a settle-check against current task state before emitting. Reuse that resolution helper rather than writing a second one.

Both argument forms must work:
- `squadrant crew takeover <project> <crew>` — from any terminal
- `squadrant crew takeover --task-id "$SQUADRANT_CREW_TASK_ID"` — from inside a crew

- [ ] **Step 1: Write the failing tests**

Cover: takeover by `<project> <crew>`; takeover by `--task-id`; `--note` reaches the event; handback emits `crew.takeover.ended`; unknown crew name produces a clear error naming `squadrant crew list`. Inject a fake `call` the way `crew-signal.test.ts` does — do not hit a real daemon.

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/__tests__/crew-takeover.test.ts`

- [ ] **Step 3: Implement `runCrewTakeover` and register both subcommands**

Unlike `crew signal`, do **not** refuse when the task is terminal — a takeover on a `done` task is the primary case.

Each command prints a one-line confirmation and pushes a line to the captain's pane via the existing runtime-send path used elsewhere in this file:

```
CREW TAKEOVER [<project>/<crew>] — operator is driving this tab. Do not send, do not close, do not act on its signals until handback.
CREW HANDBACK [<project>/<crew>] — operator returned control. State: <state>. Run 'squadrant crew read <project> <crew>' before acting; the tab has history you did not see.
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Verify the real CLI wires up**

Run: `pnpm build && node dist/index.js crew takeover --help`
Expected: help text renders (this is the NodeNext `.js`-extension gate).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/crew-control.ts packages/cli/src/commands/__tests__/crew-takeover.test.ts
git commit -m "feat(cli): squadrant crew takeover|handback (#649)"
```

---

### Task 3: `crew close` and `crew send` refuse a held crew

**Files:**
- Modify: `packages/core/src/crew-spawn.ts` — `runCrewClose` (line 565), `runCrewSend` (line 473)
- Modify: `packages/cli/src/commands/crew.ts` — add `--force` to both subcommands, thread it through
- Test: `packages/core/src/__tests__/crew-spawn.test.ts`

**Interfaces:**
- Consumes: `TaskRecord.operatorHold` (Task 1).
- Produces: both core functions accept `opts?: { force?: boolean }` as a new trailing parameter.

**Read first:** `runCrewClose` at `crew-spawn.ts:565`. It resolves matching tasks via `deps.listTasks`, picks `pickMostRecentTask`, then terminalizes and tears down. The hold check goes **immediately after the match resolution and before the first `emitEvent`** — refusing after a `task.cancelled` has already been emitted would leave the record terminalized but the pane alive.

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses to close a crew under operator takeover", async () => {
  const held = mkTask({ name: "c1", state: "done", operatorHold: { since: 1000 } });
  await expect(
    runCrewClose("p", "c1", fakeRuntime, "ws", { ...deps, listTasks: async () => [held] }),
  ).rejects.toThrow(/operator takeover/i);
});

it("emits no event when it refuses", async () => {
  const held = mkTask({ name: "c1", state: "done", operatorHold: { since: 1000 } });
  const emitted: ControlEvent[] = [];
  await runCrewClose("p", "c1", fakeRuntime, "ws", {
    ...deps, listTasks: async () => [held],
    emitEvent: async (_p, e) => { emitted.push(e); },
  }).catch(() => {});
  expect(emitted).toEqual([]);   // must not terminalize then bail
});

it("closes a held crew when force is set", async () => { /* ...same, opts { force: true }, resolves */ });
it("refuses to send to a crew under operator takeover", async () => { /* runCrewSend, rejects */ });
```

- [ ] **Step 2: Run and verify they fail**

- [ ] **Step 3: Implement the guard in both functions**

```ts
// crew-spawn.ts, in runCrewClose after `const primary = pickMostRecentTask(matches);`
// and BEFORE the emitEvent loop:
if (primary.operatorHold && !opts?.force) {
  const heldForMin = Math.round((Date.now() - primary.operatorHold.since) / 60000);
  throw new Error(
    `Crew '${name}' is under operator takeover (held ${heldForMin}m` +
      `${primary.operatorHold.note ? `: ${primary.operatorHold.note}` : ""}). ` +
      `The operator is working in that tab — closing it kills their session and prunes the worktree. ` +
      `Ask them to run 'squadrant crew handback ${project} ${name}', or pass --force if they told you to.`,
  );
}
```

Mirror the same shape in `runCrewSend`, worded for interruption rather than destruction.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Add `--force` to the CLI subcommands**

`packages/cli/src/commands/crew.ts` — `.option("--force", "override an operator takeover (only when the operator told you to)", false)` on both `close` and `send`, threaded into the core calls.

- [ ] **Step 6: Full suite**

Run: `pnpm test`
Expected: PASS. Existing `runCrewClose` / `runCrewSend` callers must still compile — the new parameter is optional.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/crew-spawn.ts packages/cli/src/commands/crew.ts packages/core/src/__tests__/crew-spawn.test.ts
git commit -m "feat(core): refuse close/send on a crew under operator takeover (#649)"
```

---

### Task 4: Stop forcing past git, and make recovery discoverable

**Files:**
- Modify: `packages/shared/src/lib/git-worktree.ts` — `removeWorktree` (line 206)
- Modify: `packages/core/src/crew-spawn.ts` — `runCrewClose` teardown
- Test: `packages/shared/src/lib/__tests__/git-worktree.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — this layer is deliberately independent, so it fires even when no takeover was recorded.
- Produces: `removeWorktree` now throws on a dirty worktree; new exported `worktreeDirtyFiles(wtPath: string): string[]`.

**This is the layer that catches a forgotten `/takeover`.** Do not couple it to `operatorHold`.

Current code — git refuses, and squadrant forces past the refusal:

```ts
export function removeWorktree(repoRoot: string, wtPath: string): void {
  try   { execFileSync("git", ["-C", repoRoot, "worktree", "remove", wtPath], { stdio: "pipe" }); }
  catch { execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", wtPath], { stdio: "pipe" }); }
}
```

- [ ] **Step 1: Write the failing tests**

Build a real temp repo + worktree in the test (the existing suite in this file already does this — follow its helpers). Cover: clean worktree removes fine; worktree with an uncommitted file throws and **the worktree still exists afterwards**; `force: true` removes it; `worktreeDirtyFiles` lists untracked *and* modified paths.

- [ ] **Step 2: Run and verify they fail**

- [ ] **Step 3: Implement**

```ts
/** #649: files that would be destroyed by removing this worktree. */
export function worktreeDirtyFiles(wtPath: string): string[] {
  try {
    return execFileSync("git", ["-C", wtPath, "status", "--porcelain", "--untracked-files=all"],
      { stdio: ["ignore", "pipe", "ignore"] })
      .toString().split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Remove a crew's worktree. The branch is left intact so commits survive.
 *
 * #649: this used to catch git's refusal and retry with --force. Git refuses to
 * remove a dirty worktree precisely to protect uncommitted work; catching that
 * and forcing past it destroyed an operator's uncommitted .env files at
 * prism-app. The refusal now stands — callers pass force explicitly.
 */
export function removeWorktree(repoRoot: string, wtPath: string, opts?: { force?: boolean }): void {
  const args = ["-C", repoRoot, "worktree", "remove", ...(opts?.force ? ["--force"] : []), wtPath];
  execFileSync("git", args, { stdio: "pipe" });
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Make `runCrewClose` check before it tears down**

Before removing the worktree: if `worktreeDirtyFiles(worktreeCwd)` is non-empty and `!opts?.force`, refuse — listing the worktree path and the files, and asking **why they are uncommitted**. Then print the recovery route on the way out of every close:

```
transcript: <path>
resume:     claude --resume <sessionId>   (run from the worktree path above)
```

`sessionId` is already on the record (`TaskRecord.sessionId`). At prism-app the transcript survived on disk but the recovery route was reconstructed by hand — surfacing it is the whole point.

- [ ] **Step 6: Full suite + real CLI**

Run: `pnpm build && pnpm test && node dist/index.js --help`

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/lib/git-worktree.ts packages/shared/src/lib/__tests__/git-worktree.test.ts packages/core/src/crew-spawn.ts
git commit -m "fix(worktree): stop forcing past git's dirty-worktree refusal (#649)"
```

---

### Task 5: Suppress actionable captain pushes for a held crew

**Files:**
- Modify: `packages/core/src/daemon/reduce.ts` — `firePush` (line 217)
- Test: `packages/core/src/__tests__/` (the reduce/daemon suite)

**Interfaces:**
- Consumes: `TaskRecord.operatorHold` (Task 1).
- Produces: no new exports.

**Why here:** `firePush` already early-returns on `!ATTENTION_STATES.has(next.state)`. One more guard beside it covers every actionable push in one place.

- [ ] **Step 1: Write the failing test**

```ts
it("does not push CREW DONE for a crew under operator takeover (#649)", () => {
  // A held crew finishing the OPERATOR's ad-hoc work must not tell the captain
  // the delegated task is done — that is the exact misleading signal from prism-app.
  const held = mkTask({ state: "working", operatorHold: { since: 1000 } });
  const notified: string[] = [];
  applyEvent(held, { type: "task.done", id: held.id }, { notify: (m) => notified.push(m) });
  expect(notified).toEqual([]);
});
```

- [ ] **Step 2: Run and verify it fails**

- [ ] **Step 3: Implement**

```ts
// packages/core/src/daemon/reduce.ts, inside firePush, next to the ATTENTION_STATES guard
  // #649: the operator is driving this tab. Any attention state now reflects
  // THEIR work, not the captain's delegated task — pushing it invites the
  // captain to act on a conversation it cannot see. Handback re-enables pushes.
  if (next.operatorHold) return;
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(daemon): suppress captain pushes while a crew is under takeover (#649)"
```

---

### Task 6: Surface `HELD` everywhere the captain looks

**Files:**
- Modify: `packages/cli/src/commands/crew.ts` (`crew list`) and `crew-control.ts` (`crew tasks`)
- Modify: `packages/cli/src/commands/handoff.ts` — the `liveCrews` gatherer
- Test: the corresponding CLI test files

**Interfaces:**
- Consumes: `TaskRecord.operatorHold` (Task 1).
- Produces: `liveCrews` entries carry `operatorHold`.

This is what makes a takeover survive `/compact` and a cold captain boot — the payoff of storing on `TaskRecord` rather than a scratch file.

- [ ] **Step 1: Write the failing tests**

`crew list` and `crew tasks` render held crews under a separate `HELD` group with duration, and the active count excludes them. `handoff facts` includes `operatorHold` on the `liveCrews` entry.

- [ ] **Step 2: Run and verify they fail**

- [ ] **Step 3: Implement**

Rendering, e.g.:

```
active (2):
  crew-1   working
  crew-3   review
HELD BY OPERATOR (1) — not counted toward maxCrew:
  welcome-email   done · held 3h12m · "local stack + resend key"
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cli): surface operator-held crews in list/tasks/handoff facts (#649)"
```

---

### Task 7: `CREW HELD-LONG` nudge — never auto-release

**Files:**
- Modify: `packages/core/src/watchdog.ts`
- Modify: `packages/shared/src/config.ts` — add `defaults.takeoverNudgeHours` (default `6`)
- Test: `packages/core/src/__tests__/watchdog.test.ts`

**Interfaces:**
- Consumes: `operatorHold.since` and `operatorHold.lastNudgeAt` (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

A hold younger than the threshold nudges nothing. A hold past it emits exactly one `CREW HELD-LONG` and stamps `lastNudgeAt`. A second sweep before the next interval does not re-nudge. **And the critical one:** no sweep ever clears `operatorHold`.

```ts
it("never auto-releases a takeover, however old", () => {
  const ancient = mkTask({ operatorHold: { since: 0 } });
  const after = sweep([ancient], { now: 1000 * 60 * 60 * 24 * 30 });
  expect(after[0].operatorHold).toBeDefined();
});
```

- [ ] **Step 2: Run and verify they fail**

- [ ] **Step 3: Implement**

Notify-only, mirroring the existing `task.quiet` pattern (reducer no-op). Message:

```
CREW HELD-LONG [<project>/<crew>] — held <N>h. Ask the operator whether it is still in use. Do not release it yourself.
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(watchdog): nudge on long-running operator takeover (#649)"
```

---

### Task 8: Slash commands and the captain contract

**Files:**
- Create: `plugin-crew/skills/takeover/SKILL.md`
- Create: `plugin-crew/skills/handback/SKILL.md`
- Modify: `packages/shared/src/lib/runtime-sync.ts` — `CREW_SKILLS` (~line 127)
- Modify: `templates/captain.claude.md`, `templates/captain.generic.md`
- Modify: `plugin/skills/captain-ops/SKILL.md` (the `maxCrew` line, 197)

**Interfaces:**
- Consumes: the CLI from Task 2.
- Produces: no code exports.

**Altitude rule (#653):** the *contract* goes in `templates/` (always loaded, agent-agnostic). The *playbook* goes in the skill. The skill references the template; it never restates the contract.

**Keep both skills tiny.** `CREW_SKILLS` is deliberately scoped to `["karpathy-principles"]` (#625) to bound the crew boot prefix. Widening it was accepted for UX, not for prose.

- [ ] **Step 1: Write `/takeover`**

Two jobs, both required:

1. Run `squadrant crew takeover --task-id "$SQUADRANT_CREW_TASK_ID"` (injected at spawn — `core/src/crew-spawn.ts:358`).
2. Tell the crew its principal changed: *you now work directly for the operator, not the captain. **Do not run `squadrant crew signal done`** when you finish what the operator asked — wait for `/handback`.*

Job 2 is load-bearing. Without it the crew self-signals `done`, the captain sees `CREW DONE`, and the mechanism recreates the exact misleading signal it exists to prevent.

- [ ] **Step 2: Write `/handback`**

Runs `squadrant crew handback --task-id "$SQUADRANT_CREW_TASK_ID"` and restores normal crew behaviour (captain is the principal again; the completion protocol applies again).

- [ ] **Step 3: Add both to `CREW_SKILLS`**

- [ ] **Step 4: Add the captain contract clause to both templates**

State: a crew under operator takeover is off-limits — no `send`, no `close`, and its lifecycle signals are not yours to act on. If you are at your crew limit, **ask the operator**; never pick a held crew to close. `--force` exists only for when the operator explicitly tells you to use it.

- [ ] **Step 5: Fix the `maxCrew` line in `captain-ops`**

Current: *"Respect `maxCrew` — don't exceed the configured concurrent crew count."*
Add: held crews do not count toward the limit, and at the limit the captain asks the operator rather than choosing a crew to close.

- [ ] **Step 6: Verify the runtime sync carries them**

Run: `pnpm build && node dist/index.js runtime sync` (or the project's sync verb), then confirm both skills landed under `~/.config/squadrant/plugin-crew/skills/`.

- [ ] **Step 7: Commit**

```bash
git add plugin-crew/skills templates packages/shared/src/lib/runtime-sync.ts plugin/skills/captain-ops/SKILL.md
git commit -m "feat(crew): /takeover and /handback slash commands + captain contract (#649)"
```

---

### Task 9: #661 — worktree base must follow the captain's checked-out branch

**Files:**
- Modify: `packages/shared/src/lib/git-worktree.ts` — `resolveWorktreeBase` (line 62)
- Test: `packages/shared/src/lib/__tests__/git-worktree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveWorktreeBase` unchanged signature, changed resolution order.

**Folded into this plan because it edits the same file as Task 4.** Two crews on `git-worktree.ts` in parallel would conflict. Independent commit; reviewable on its own.

Current behaviour reads `refs/remotes/origin/HEAD` — the **GitHub default branch** — and never looks at what the captain has checked out. On `prism-app` (default `main`, integration `staging`, 155 commits apart) every single spawn started 155 commits stale, and the crew had no way to suspect it.

```ts
export function resolveWorktreeBase(repoRoot: string, fallback = "develop"): string {
  try {
    const ref = execFileSync("git", ["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"], ...);
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch { return fallback; }
  return fallback;
}
```

- [ ] **Step 1: Write the failing tests**

Real temp repos. Cover: checked out on a non-default branch → that branch is the base (the #661 repro); detached HEAD → falls back to `origin/HEAD`; no `origin/HEAD` and detached → `fallback`; checked out on the default branch → unchanged behaviour.

- [ ] **Step 2: Run and verify they fail**

- [ ] **Step 3: Implement**

```ts
/**
 * #359: derive the branch a new worktree should be based on.
 * #661: prefer the captain's CHECKED-OUT branch. Reading origin/HEAD first meant
 * every spawn on a repo whose integration branch is not the GitHub default
 * branch started stale — 155 commits at prism-app — silently, with the damage
 * only surfacing at PR time as a diff full of unrelated reverts.
 * Order: checked-out branch → origin/HEAD → fallback.
 */
export function resolveWorktreeBase(repoRoot: string, fallback = "develop"): string {
  try {
    const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (head && head !== "HEAD") return head;   // "HEAD" means detached
  } catch {
    // fall through to origin/HEAD
  }
  try {
    const ref = execFileSync("git", ["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch {
    return fallback;
  }
  return fallback;
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Print the resolved base at spawn**

`crew spawn` already prints a dim routing line. Add the base next to it — `base: staging` — so a wrong base is visible immediately instead of at PR time.

- [ ] **Step 6: Full suite**

Run: `pnpm build && pnpm test && node dist/index.js --help`

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/lib/git-worktree.ts packages/shared/src/lib/__tests__/git-worktree.test.ts packages/core/src/crew-spawn.ts
git commit -m "fix(worktree): base crew worktree on the checked-out branch (#661)"
```

---

## Final gate before signalling review

- [ ] `pnpm build` clean
- [ ] `pnpm test` — full suite, 2430+ passing
- [ ] `node dist/index.js --help` — the NodeNext runtime gate
- [ ] `node dist/index.js crew takeover --help` and `crew handback --help` render
- [ ] No orphaned processes: `pgrep -fl vitest` empty, no stray dev servers
- [ ] Manual smoke on a **throwaway TEST project, never a real one**: spawn a crew → `crew takeover` → confirm the captain pane shows `CREW TAKEOVER` → confirm `crew close` refuses → `crew handback` → confirm `crew close` now works
- [ ] Commit the spec alongside the implementation: `docs/specs/2026-08-06-crew-operator-takeover.md`
- [ ] `squadrant crew signal review` — **do not merge.** The human review gate applies.

## Self-review notes

**Spec coverage:** §1 → Task 1 · §2 → Task 1 · §3 → Tasks 2, 8 · §4 → Tasks 3, 5, 6, 8 · §5 → Task 4 · §6 → Task 6 · §7 → Task 7 · §8 → Tasks 2, 8 · #661 → Task 9. No section unmapped.

**Known softness, stated rather than hidden:** Tasks 2, 6, 7 give exact file anchors and required behaviour but not verbatim test bodies, because the surrounding helpers in those files were not read during planning. Follow the neighbouring tests in each file. Tasks 1, 3, 4, 5, 9 — the correctness-critical ones — carry real code read from the current source.

**Deliberately not built:** `maxCrew` enforcement (does not exist — see Global Constraints); daemon-side operator-input detection (spec non-goal); `squadrant crew tell` (superseded by takeover/handback).
