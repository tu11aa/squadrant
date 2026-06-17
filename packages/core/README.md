# @cockpit/core

**Purpose:** Driver-agnostic daemon / control-plane core for claude-cockpit.

**Owns:**
- Daemon state machine, mailbox, protocol, liveness, watchdog, store, snapshot
- `daemon/` modules: start, context, server, attach, delivery, probes, gates, snapshot-gather
- `delivery/` — CaptainDelivery
- Driver-seam interfaces (AgentDriver, OpencodeBridge, CmuxEventsBridge, DaemonSurfaceDriver)
- Pure helpers: gate, DeferDelivery, interactive-probe, launchd, relay-healer, crew-pane-reader

**Public interface:** Everything exported from `packages/core/src/index.ts`.

**Depends on:** `@cockpit/shared` only.

**Doesn't belong here:**
- Concrete agent/workspace drivers (`codex/`, `opencode/`, `cmux/`, `headless`, `runtimes/`) — those live in root and move to `agents`/`workspaces` in Step 5.
- CLI commands (`commands/`) — Step 7.
- Dashboard / web (`dashboard/`) — Step 6.
- `cockpitd.ts` host — stays in root as the bin/launchd entry.
