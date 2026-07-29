# Review Gate — Fully Enforcing (#608)

As of #608, the review gate is comprehensively sticky. While a task is in the
`review` state, every turn-boundary and idle event — `task.turn.completed`,
heartbeat, `task.progress`, `task.delta` — is treated as liveness-only and
cannot move the task out of `review`.

This closes the gap left by #605, where `review` was only protected in the
`task.done` handler: a crew's turn ending could still silently clobber
`review` back to `awaiting-input`, letting work slip past the gate unseen.

`review` now shares the same preservation semantics as `blocked` via a
shared `isStickyAttention(state)` check applied at every transition site.
The only ways out of `review` are `squadrant crew approve` or explicit
captain feedback.

例: squadrant crew approve <project> <crew>
