# @squadrant/workspaces

The **environment / surface seam**: where agents run (cmux RuntimeDriver), where knowledge
lives (obsidian WorkspaceDriver), how the human is notified (cmux NotifierDriver), and the
daemon↔cmux bridge.

Depends only on `@squadrant/core` and `@squadrant/shared`. Adding a new surface (tmux/zed) is a
new folder here plus one wiring line in the host/cli — no `core` change.
