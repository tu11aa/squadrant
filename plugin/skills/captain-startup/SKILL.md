---
name: captain-startup
description: Captain session startup contract plus a trigger table that says which captain-ops section or skill to read before each action. Use at session start; read captain-ops sections only when a row below fires.
---

# Captain Startup

Do these 4 steps, then report ready. Keep output small: print only the fields you need, never whole JSON blobs.

1. **Facts:** `squadrant handoff facts {project} --fetch`. Read `liveRepo`, `checkpoint`, `gapSessions`.
2. **branchState:** act on each flag: `upstreamStatus` behind / diverged / upstream-gone / no-upstream, `dirtyWorkingTree`, `onUnexpectedBranch`, `mergedIntoBase`.
3. **Live crews:** `liveRepo.liveCrews`; a `blocked` crew with a `question` is waiting on you now.
4. **Handoff, once:** if `checkpoint.content` is set it is the handoff, do not read it again. Else (`checkpoint.live` or no checkpoint) run `~/.config/squadrant/scripts/read-handoff.sh {project}` (it archives the file). With neither, rebuild state from the facts.

Hard rules live in your system prompt. Before the action in the left column, read the right column (`captain-ops` = the `squadrant:captain-ops` skill, section in quotes).

| Before you… | Read |
|---|---|
| spawn a crew, write a brief, route by level or effort | "Spawning Crew" (incl. Leveled crew routing, Effort mode, Crafting Load-Bearing Crew Briefs); `prompt-master`; `set-effort`; `add-pick-crew-rule` |
| send a follow-up, inspect or close a crew; use Task Master | "Spawning Crew"; "Task Decomposition with Task Master" |
| handle CREW IDLE / BLOCKED, or a crew question | "Task Coordination", "Crew Question Triage & Discussion Threads" |
| review CREW REVIEW / DONE, approve, merge | "Handling CREW REVIEW or CREW DONE"; `karpathy-principles`; `rules-ops`; `human-review-guide` |
| finish a crew, or live-check a branch build | "When Crew is Fully Finished"; "Live-checking a branch build" |
| show the status board or answer a Telegram task | "Status Board", "Replying to Telegram-originated tasks" |
| end the day, write the handoff or log, roll over, restart | "Session Shutdown"; `daily-log`; `rollover` (roll, rs); `restart` |
| look up or grade KB rules | "Project Rules (Knowledge Base)"; `rules-ops` |
| work with sibling projects | "Group Awareness"; "Cross-Project Delegation" |
| record a learning, compile the wiki, load notes | "Recording Learnings"; "Wiki Compilation"; "Selective Loading"; `wiki-ops` |
| capture, fix or rate a skill | "Capturing Skills", "Fixing Skills", "Quality Tracking" |
| need sender, MCP tool or crew-setup details | "Message Senders", "MCP Tools", "Crew Setup" |
