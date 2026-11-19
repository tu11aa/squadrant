---
name: captain-startup
description: Captain session startup contract. Run it at session start, then read the captain-ops core (it holds the trigger table to the on-demand reference files).
---

# Captain Startup

Do these 4 steps, then report ready. Keep output small: print only the fields you need, never whole JSON blobs.

1. **Facts:** `squadrant handoff facts {project} --fetch`. Read `liveRepo`, `checkpoint`, `gapSessions`.
2. **branchState:** act on each flag, don't skim past it. `upstreamStatus` `behind`: local is stale, reconcile before trusting local diffs; `diverged`: both sides moved, decide rebase or merge; `upstream-gone`: remote branch deleted, likely done; `no-upstream`: never pushed. `dirtyWorkingTree`: uncommitted changes from a prior session, find out why. `onUnexpectedBranch`: you sit on a `crew/*` branch. `mergedIntoBase`: safe to switch back to base.
3. **Live crews:** `liveRepo.liveCrews` lists every non-terminal crew task; a `blocked` one with a `question` is waiting on you now.
4. **Handoff, once:** let step 1 finish before choosing; never run `read-handoff.sh` in parallel with `handoff facts` (it archives the file mid-run and prints it twice). If `checkpoint.content` is set it is the handoff, do not read it again. Else (`checkpoint.live` or no checkpoint) run `~/.config/squadrant/scripts/read-handoff.sh {project}` (it archives the file). The facts command updates remote refs first, so what it reports is verified. If there is no handoff (`"exists": false`), rebuild state from `checkpoint`, `gapSessions` and `claudeMem` instead of starting cold.
5. **Load `captain-ops`** (its SKILL.md is a short core). Its trigger table names the reference file or skill to read before each later action. Do not read the reference files at startup.

Hard rules live in your system prompt.
