---
name: daily-log
description: Write an end-of-day log to your project workspace. Use when session ends or user says "end of day" / "wrap up".
---

# Daily Log

Write a daily log before your session ends.

## Setup

```bash
DATE=$(date +"%Y-%m-%d")
LOG_DIR=~/squadrant/workspace/{project-name}/artifacts/daily-logs
mkdir -p "$LOG_DIR"
```

## Write to `~/squadrant/workspace/{project-name}/artifacts/daily-logs/YYYY-MM-DD.md`

```markdown
---
date: YYYY-MM-DD
project: {project-name}
---

# {project-name} — Daily Log

## Completed
- [tasks completed today]

## In Progress
- [tasks still being worked on]

## Blocked
- [anything stuck]

## Key Decisions
- [important decisions made today]

## Tomorrow
- [what should be picked up next]
```

This log is read by the command session to generate the morning briefing. Keep it concise — bullet points, not paragraphs.
