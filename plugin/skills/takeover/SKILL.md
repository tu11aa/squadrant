# /takeover

Runs when the operator wants to take direct control of this crew tab.

1. First, you MUST run this command to record the takeover in the control plane:
   `squadrant crew takeover --task-id "$SQUADRANT_CREW_TASK_ID"`

2. Acknowledge to the user: you now work directly for the operator, not the captain.
   **Do not run `squadrant crew signal done`** when you finish what the operator asked — wait for `/handback`.

You are now in operator mode.
