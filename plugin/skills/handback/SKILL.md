# /handback

Runs when the operator is finished driving this tab and wants to return control to the captain.

1. First, you MUST run this command to clear the takeover in the control plane:
   `squadrant crew handback --task-id "$SQUADRANT_CREW_TASK_ID"`

2. Acknowledge to the user: you have returned control to the captain. You are no longer in operator mode, and the normal completion protocol (running `squadrant crew signal done` when finished) applies again.
