# captain-ops reference: Review gate

_Read this before reviewing a crew diff (CREW REVIEW / DONE), approving, merging, closing a finished crew, or live-checking a branch build. Part of the `captain-ops` skill; the trigger table is in `SKILL.md`._


### Handling CREW REVIEW or CREW DONE (Assessment Gate)

CREW REVIEW and CREW DONE both mean the crew has paused and is waiting for your verdict (either explicitly asking for review, or claiming the work is done). Treat neither as final until you have reviewed.

**Follow the HUMAN REVIEW GATE contract from your system prompt.** The template defines *what* you must do (never auto-merge without permission); this playbook defines *how* to do it.

**Review Modes (per contract):**
- **DEFAULT mode (Wait for human):** You review the diff, then **STOP** and surface a diff summary to the USER. You **WAIT** for the user to approve. You do NOT run `squadrant crew approve` or merge until they say so.
- **DELEGATED mode (Captain auto):** ONLY when the user explicitly delegates (e.g. "you review and merge it"). You review, run `squadrant crew approve`, and merge autonomously.

*Note: Either way the captain-side review still happens — the human gate is ADDED ON TOP of the captain review, not a replacement for it.*

On CREW REVIEW or CREW DONE:

1. **Open the diff** — `squadrant diff <project> <crew>` (branch-vs-base). Use `--staged`/`--unstaged`/`--working` if you want to peek at uncommitted work.
2. **Classify (Captain-side review):**

| Diff looks | Captain action |
|-----------|-----------------|
| Good — matches the task, tests pass, no scope creep | **DEFAULT mode:** Surface diff summary to user and WAIT. Once user approves, run `squadrant crew approve <project> <crew>`, then ask about merging (or merge if they already approved it).<br><br>**DELEGATED mode:** Run `squadrant crew approve <project> <crew>`, then merge autonomously. |
| Needs changes | `squadrant crew send <project> <crew> "<feedback>"` — the crew iterates and re-signals. Loop until approved. |

3. **Grade the rules the crew was given** (only if the project subscribes to a knowledge base; #945). While the diff is open:
   - `squadrant knowledge surfaced --task <task-id>` lists the rules delivered to that task (task id from `squadrant crew tasks <project>`).
   - For each listed rule that **applies to this diff**, record what you saw: `squadrant knowledge feedback <rule-id> --followed|--violated --source review --task <task-id>` (`--wrong` if the rule itself is wrong).
   - Skip the rules that don't apply. Don't guess: grade only what the diff shows. These grades are the high-confidence signal behind `complianceRate` and `violationRate` in the KB's REPORT.md.
4. **Evidence SHA = branch head, before any merge ask** (#1136). If the repo has `.squadrant/verify.json`, compare the crew branch head (`git -C <worktree> rev-parse HEAD`, or the PR head SHA) with the evidence file: `.squadrant/evidence/<head>.json` must exist in the crew worktree with `green: true` and no `metaFailures`. MISSING, STALE (evidence is for an older commit) or RED means do not ask the operator to merge: `squadrant crew send` the crew to run `squadrant verify` at HEAD and re-signal, or run it yourself. State the evidence SHA in the merge ask. The crew's signal already enforces this per the `verifyGate` policy (`off|warn|refuse`), but under `warn` or `off` the captain check is the gate. This complements, and does not replace, your own e2e before the merge ask.
5. **Never auto-terminalize** by emitting `task.done` directly — always go through `squadrant crew approve`.
6. **Operator about to review by hand** ("review guide", "how should I review these PRs")? Use the `squadrant:human-review-guide` skill: one PR → chat answer, several → one local interactive HTML. You write it yourself (you hold the context), and it is never posted anywhere.
7. Do **not** re-send the original task or close the crew while it's awaiting review — `crew close` on a `review`-state task discards work that hasn't been pushed anywhere yet.

## When Crew is Fully Finished (After Approval)

After a crew task is approved and optionally merged:

1. Close the crew with `squadrant crew close <project> <name>` once the work track is done.
2. VERIFY no orphaned processes remain — e.g. `pgrep -fl vitest` and check for stray dev servers. Kill any leftovers. `pnpm test` is one-shot (`vitest run`, always exits) and machine-wide bounded via `scripts/heavy-lock.mjs` (#570), so concurrent crews queue instead of piling up — but still prefer one verification on the authoritative checkout rather than relying on the lock to save you.
3. Record learnings if any (see `knowledge.md`).
4. Update your handoff if the work shifts the next-step plan (see `shutdown.md`).

## Live-checking a branch build

Live-check branch builds on a dev daemon: `pnpm build` in the worktree, `eval "$(node dist/index.js dev up)"`, launch/spawn on the throwaway project, then `squadrant dev down`. Never `npm i -g <branch tgz>` + `squadrant heal daemon` (or any production restart) for a branch test: it restarts the daemon every project depends on. See `docs/reference.md` → Dev daemon.
