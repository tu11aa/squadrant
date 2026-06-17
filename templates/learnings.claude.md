# Learnings — Self-Evolving Knowledge System

Agents record, evolve, and reuse knowledge. Inspired by OpenSpace's skill evolution.

## Record Learnings (with tags)

```bash
~/.config/cockpit/scripts/record-learning.sh "{spokeVault}" "{category}" "{description}" "{tags}"
```
- Categories: `workflow`, `template`, `convention`, `bug`, `insight`
- Tags: comma-separated keywords for selective retrieval

## Capture Skills (CAPTURED)

After a successful novel pattern, capture it as a reusable skill:
```bash
~/.config/cockpit/scripts/capture-skill.sh "{spokeVault}" "{name}" "{description}" "{body}"
```

## Fix Skills (FIX)

When a skill's instructions are broken or outdated:
```bash
~/.config/cockpit/scripts/fix-skill.sh "{spokeVault}" "{name}" "{corrected body}"
```

## Quality Tracking

- `mark-learning-useful.sh` — increment usefulness counter
- Loaded 5+ times but never useful → stale, skip it
- Skill used 3+ times but never successful → flag for FIX

## For Command Session: Review & Evolve

1. Scan all spoke vaults for unapplied learnings
2. Group by category, identify cross-project patterns
3. If same issue in 2+ projects → propose a **captured skill**
4. If a skill keeps failing → propose a **fix**
5. Present changes to user for approval
6. Apply and mark as `applied: true`
