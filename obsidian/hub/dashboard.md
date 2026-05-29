---
title: Cockpit Dashboard
---

# Cockpit Dashboard

State of every registered project, mirrored from each spoke's `status.md` by `cockpit dashboard sync-hub` (#44).

```dataview
TABLE WITHOUT ID
  file.link as "Project",
  auto_state as "State",
  captain_workspace as "Captain",
  auto_last_checked as "Last checked"
FROM "projects"
SORT auto_last_checked DESC
```

## States

| Icon | State | Meaning |
|------|-------|---------|
| ●    | idle    | Prompt visible, no spinner |
| ◐    | busy    | Spinner / "Brewing" / "Cogitating" / "Compiling" / similar |
| ⏸    | blocked | "blocked" / "waiting for input" / "needs input" |
| ✗    | errored | "✗" / "panic:" / "FATAL" / "Error:" |
| ○    | offline | Empty pane / "session ended" / "[process exited" |

## Refresh

- Run a one-shot refresh manually: `cockpit dashboard sync-hub`.
- For a live in-terminal view: `cockpit dashboard --pane` (sidebar pane in cmux, refreshes every 10s).
