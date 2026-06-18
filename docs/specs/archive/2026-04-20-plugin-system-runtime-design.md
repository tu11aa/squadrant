# Plugin/Extension System — Phase 1: Runtime Slot

> **✅ Shipped** (PR #20, 2026-04-20). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-04-20
**Status:** Draft — design only, implementation in next sprint
**Issue:** [#9](https://github.com/tu11aa/claude-cockpit/issues/9)
**Phase:** 1 of N (runtime slot first, per phased rollout)

## Problem

Cockpit's execution environment is hardcoded to cmux. The `cmux` binary is referenced directly across bash scripts (`execute-reaction.sh`, `spawn-workspace.sh`) and TypeScript (`launch.ts`, `shutdown.ts`, `doctor.ts`). Swapping cmux for tmux, Docker, or a remote SSH session requires editing every call-site.

Additionally, current workspace liveness checks grep the output of `cmux list-workspaces` and treat empty strings as "offline" — fragile and produces false negatives.

## Goal

Abstract the runtime (where agent workspaces actually run) behind a driver interface mirroring the existing `src/drivers/` pattern for agents. Cmux remains the default and only shipped implementation. The abstraction unlocks future runtimes (tmux, Docker, SSH) without further refactoring.

## Non-Goals

- Additional slots (workspace, tracker, notifier) — phase 2+ of #9.
- External plugin loading from `node_modules` (community-authored plugins) — phase 3, deferred.
- New runtime implementations beyond cmux extraction — each new runtime is its own follow-up PR.
- Rewriting bash scripts in TypeScript — scripts stay, call `cockpit runtime <op>` instead of `cmux`.

## Architecture: Runtime Driver (mirrors Agent Driver)

```
cockpit core
  └── src/runtimes/
        ├── types.ts         ← RuntimeDriver interface + types
        ├── cmux.ts          ← cmux driver (extracted from scattered call-sites)
        ├── registry.ts      ← RuntimeRegistry — config-driven selection
        ├── index.ts         ← re-exports
        └── __tests__/       ← unit + integration (gated)
```

Cockpit core and bash scripts never talk to cmux directly — always through a driver, exposed either as a TypeScript import (core code) or as `cockpit runtime <op>` CLI subcommands (bash scripts).

## 1. Runtime Driver Interface

```typescript
// src/runtimes/types.ts
export interface WorkspaceRef {
  id: string;                // runtime-native ref (cmux: "workspace:42")
  name: string;              // human name ("brove-captain")
  status: "running" | "stopped" | "unknown";
}

export interface RuntimeSpawnOptions {
  name: string;
  workdir: string;
  command: string;           // built by AgentDriver.buildCommand
  icon?: string;
}

export interface RuntimeProbeResult {
  installed: boolean;
  version: string;
}

export interface RuntimeDriver {
  name: string;              // "cmux", "tmux", "docker", ...

  probe(): Promise<RuntimeProbeResult>;
  list(): Promise<WorkspaceRef[]>;
  status(nameOrId: string): Promise<WorkspaceRef | null>;
  spawn(opts: RuntimeSpawnOptions): Promise<WorkspaceRef>;
  send(ref: string, message: string): Promise<void>;
  sendKey(ref: string, key: string): Promise<void>;
  readScreen(ref: string): Promise<string>;
  stop(ref: string): Promise<void>;
}
```

### Contract notes

- **`send()` is "deliver and commit"** — the implementation must both transmit the message AND commit it (for cmux: `cmux send` followed by `cmux send-key Enter`). Callers do not need to pair it with a separate Enter. Current bash code pairs `send` + `send-key Enter` in every call-site; this contract absorbs that idiom into the interface.
- **`sendKey()` remains literal** — for non-Enter keys (e.g., Ctrl+C, Escape) callers still invoke `sendKey(ref, "Enter")` etc. explicitly when they need control.
- **`status()` returns `WorkspaceRef | null`** — `null` means not running. Replaces the current `grep list-workspaces && [ -z "$WS" ]` pattern in bash with a single structured call.
- **`spawn()` returns a `WorkspaceRef`** — the caller never has to grep for its own workspace post-spawn.

## 2. Registry & Config

```typescript
// src/runtimes/registry.ts
export class RuntimeRegistry {
  constructor(private drivers: Record<string, RuntimeDriver>) {}

  forProject(projectName: string, config: Config): RuntimeDriver {
    const runtimeName =
      config.projects[projectName]?.runtime ?? config.runtime ?? "cmux";
    const driver = this.drivers[runtimeName];
    if (!driver) throw new Error(`Unknown runtime '${runtimeName}'`);
    return driver;
  }

  probeAll(): Promise<Record<string, RuntimeProbeResult>> { /* ... */ }
}
```

Config additions (both optional, default `"cmux"`; no migration required):

```jsonc
{
  "runtime": "cmux",                 // NEW — global default
  "projects": {
    "brove": {
      "runtime": "cmux",             // NEW — optional per-project override
      "path": "~/projects/brove",
      "captainName": "brove-captain",
      "spokeVault": "~/cockpit-hub/spokes/brove",
      "host": "local"
    }
  }
}
```

When both are absent, behavior is identical to today (cmux). `cockpit doctor` gains a new check: probe every distinct runtime referenced in config and report installed version.

## 3. CLI Subcommand — Bridge to Bash

New command at `src/commands/runtime.ts`:

```
cockpit runtime status <target>           # "running" | "stopped"; exit 0 if running, 1 if not
cockpit runtime send <target> <msg>       # send + commit (Enter) — the 99% path
cockpit runtime send-key <target> <key>   # literal key press
cockpit runtime list [-j|--json]          # all workspaces, optionally JSON
cockpit runtime read-screen <target>      # terminal snapshot
cockpit runtime stop <target>
```

`<target>` is one of:
- A project name — resolves to that project's `captainName` from config.
- `--command` flag — resolves to the global `commandName` (cockpit's overseer workspace).

Resolution chain: target → workspace name → `RuntimeRegistry.forProject()` (or global driver for `--command`) → `driver.status(name)` → ref. Bash scripts never handle refs directly.

Process-spawn overhead per invocation (~100ms) is acceptable: reactor polls every 5 minutes, spawn is one-shot. No hot-loop callers.

## 4. Refactor Surface

| File | Current | After |
|------|---------|-------|
| `scripts/execute-reaction.sh` | `"$CMUX" send --workspace "$WS" "$MSG"; send-key Enter` | `cockpit runtime send "$PROJECT" "$MSG"` |
| `scripts/execute-reaction.sh` | `get_captain_ws` — grep `list-workspaces` | `cockpit runtime status "$PROJECT"` |
| `scripts/execute-reaction.sh` | `get_command_ws` — grep for commandName | `cockpit runtime status --command` |
| `scripts/spawn-workspace.sh` | direct cmux spawn | driver-dispatched via `cockpit runtime spawn` (or via TS in launch.ts) |
| `src/commands/launch.ts` | cmux-specific logic | `registry.forProject(name, config).spawn(opts)` |
| `src/commands/shutdown.ts` | cmux stop | `driver.stop(ref)` |
| `src/commands/doctor.ts` | hardcoded cmux probe | iterate configured runtimes, probe each |

All call-sites keep their file location and shape — only their dependency changes.

## 5. Testing

Mirror `src/drivers/__tests__/`:

- **Unit tests** for `CmuxDriver` — mock `child_process.spawn` with fixture stdout capturing realistic `cmux list-workspaces` / `send` outputs.
- **Unit tests** for `RuntimeRegistry` — project-override > global > default fallback chain.
- **Integration smoke** — `cockpit runtime status <project>` against a real cmux workspace, gated behind `SKIP_INTEGRATION=1` like existing driver integration tests.
- **Bash script regression** — smoke-test `execute-reaction.sh` paths (delegate, escalate, auto-fix-ci) against a mock runtime that records `send`/`status` calls, verifying behavior unchanged.

## 6. Rollout

1. Land this spec and implementation plan.
2. Implement `src/runtimes/` with only `CmuxDriver`.
3. Add `cockpit runtime` CLI subcommand.
4. Migrate TS call-sites (`launch.ts`, `shutdown.ts`, `doctor.ts`).
5. Migrate bash call-sites (`execute-reaction.sh`, `spawn-workspace.sh`).
6. Add config docs to README.
7. Ship as single PR. Keep driver pattern identical to `src/drivers/` so phase 2 slots have a proven template.

## 7. Open Questions

None at spec time. Future phases (workspace/tracker/notifier slots) will reuse this pattern and get their own specs.

## Relationship to Other Work

- **Builds on:** `src/drivers/` (agent driver pattern, PR #16) — same shape, same testing approach.
- **Unblocks:** #10 Remote VM Support (SSH runtime becomes a trivial second driver).
- **Precedes:** #9 phase 2 — workspace/tracker/notifier slots, each a separate spec.
