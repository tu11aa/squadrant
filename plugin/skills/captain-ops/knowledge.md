# captain-ops reference: Rules, learnings and wiki

_Read this before consulting KB rules, recording a learning, compiling the wiki, or loading past learnings. Part of the `captain-ops` skill; the trigger table is in `SKILL.md`._


## Project Rules (Knowledge Base)

If the project subscribes to a knowledge base, consult `squadrant rules search <terms>` before decomposing or reviewing work, and tell crews to do the same (see the `squadrant:rules-ops` skill).

## Recording Learnings

Recording learnings is **opt-in**. Record when something genuinely surprised you or a useful pattern emerged — not on a schedule.

Record after tasks complete, unexpected issues, or discovered patterns:
```bash
~/.config/squadrant/scripts/record-learning.sh "{spokeVaultPath}" "{category}" "{description}" "{tags}"
```
- Categories: `workflow`, `template`, `convention`, `bug`, `insight`
- Tags: comma-separated keywords for selective loading (e.g., `cairo,escrow,pvp`)

## Wiki Compilation

Wiki writes are **opt-in**. Compile knowledge when you have something worth recording — not on a schedule. Use the `squadrant:wiki-ops` skill for full instructions.

1. **After each task**: If you learned how something works, create/update a wiki page
2. **During session shutdown**: Review today's learnings — promote useful ones to wiki pages
3. **Before starting work**: Query the wiki for relevant context:
```bash
~/.config/squadrant/scripts/wiki-query.sh "{spokeVaultPath}" "{task-keywords}"
```

**Learnings vs Wiki**: Learnings are raw observations (quick to record). Wiki pages are compiled, structured knowledge (worth maintaining). Promote a learning when it's been useful 2+ times or represents how a system works.

## Selective Loading (on session start)

Do NOT read all learnings. Instead, filter by relevance:
1. `grep -rl` your current task keywords in `{spokeVault}/learnings/` 
2. Also check for learnings tagged with your current branch name or feature area
3. Only read the matching files — skip the rest
4. For each learning you load, increment its `times_loaded` counter
5. If a learning actually helps your current work, run:
```bash
~/.config/squadrant/scripts/mark-learning-useful.sh "{learning-file-path}"
```

Learnings with `times_loaded > 5` and `times_useful: 0` are stale — ignore them.

## Captured skills and quality counters

Rare; the scripts still ship (`templates/learnings.claude.md` repeats the commands).
- **Capture** a novel, reusable multi-step pattern (seen in 2+ similar tasks) as a skill: `~/.config/squadrant/scripts/capture-skill.sh "{spokeVaultPath}" "{skill-name}" "{one-line description}" "{full markdown body}"` → `{spokeVault}/skills/{name}/SKILL.md`. Don't capture trivial one-off fixes or project-specific config.
- **Fix** a captured skill whose instructions are wrong or outdated: `~/.config/squadrant/scripts/fix-skill.sh "{spokeVaultPath}" "{skill-name}" "{corrected markdown body}"` (backs up the old version).
- **Prune by counters:** a learning loaded 5+ times but never useful → skip it; a captured skill used 3+ times but never successful → flag for fix or removal.
