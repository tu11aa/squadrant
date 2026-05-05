---
title: Cockpit Dashboard
---

# Cockpit Dashboard

Auto-derived state of every registered project. Mirrored from each spoke's `status.md` by `cockpit dashboard sync-hub` (#44), which the reactor runs every cycle alongside `cockpit reactor poll-status` (#43).

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

- Reactor cycle (default 5 min) re-polls all captain panes and re-mirrors here.
- Run a one-shot refresh manually: `cockpit reactor poll-status && cockpit dashboard sync-hub`.
- For a live in-terminal view: `cockpit dashboard --pane` (sidebar pane in cmux, refreshes every 10s).
