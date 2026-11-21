---
name: captain-startup
description: Captain session startup contract. Run it at session start, then read the captain-ops core (it holds the trigger table to the on-demand reference files).
---

# Captain Startup

Do these 4 steps, then report ready. Keep output small: print only the fields you need, never whole JSON blobs.

1. **Facts:** `squadrant handoff facts {project} --fetch`. Read `liveRepo`, `checkpoint`, `gapSessions`.
2. **branchState:** act on each flag, don't skim past it. `upstreamStatus` `behind`: local is stale, reconcile before trusting local diffs; `diverged`: both sides moved, decide rebase or merge; `upstream-gone`: remote branch deleted, likely done; `no-upstream`: never pushed. `dirtyWorkingTree`: uncommitted changes from a prior session, find out why. `onUnexpectedBranch`: you sit on a `crew/*` branch. `mergedIntoBase`: safe to switch back to base.
3. **Live crews:** `liveRepo.liveCrews` lists every non-terminal crew task; a `blocked` one with a `question` is waiting on you now.
4. **Handoff + freshness:** run `squadrant handoff read {project}` (live `handoff.json`, else the newest archive; it archives the live file once read, and it is safe to run alongside `handoff facts`). Read `handoff`, `fresh`, `warning`, `sessionsToRead`. If `fresh` is `false`, the handoff is old or another captain session worked after it: **read the transcripts in `sessionsToRead` (newest first, at least the newest in full) before you report ready**, whether or not a handoff exists. Use `gapSessions`, `checkpoint` and `claudeMem` from step 1 as extra context, not a substitute. Your ready report names the sessions you read (or says `fresh: true`).
5. **Load `captain-ops`** (its SKILL.md is a short core). Its trigger table names the reference file or skill to read before each later action. Do not read the reference files at startup.

Hard rules live in your system prompt.
