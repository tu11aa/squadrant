# @cockpit/agents

The **AI-driver seam**: which AI runs (claude · codex · opencode · gemini), how it is
controlled (interactive / headless), and how its state is projected to external formats.

Depends only on `@cockpit/core` and `@cockpit/shared`. Adding a new agent is a new file
here plus one wiring line in the host/cli — no `core` change.
