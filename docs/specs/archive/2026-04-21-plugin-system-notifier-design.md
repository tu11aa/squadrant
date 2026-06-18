# Plugin/Extension System — Phase 4: Notifier Slot

> **✅ Shipped** (PR #29, 2026-04-21). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


**Date:** 2026-04-21
**Status:** Draft — design only, implementation in next sprint
**Issue:** [#9](https://github.com/tu11aa/claude-cockpit/issues/9)
**Phase:** 4 of N (notifier — last of the core 4 slots)
**Depends on:** Phase 1 (runtime, PR #20), Phase 2 (workspace, PR #26), Phase 3 (tracker, PR #28)

## Problem

Cockpit's "tell the user something happened" layer hardcodes cmux as the channel. Every escalation path in `scripts/execute-reaction.sh` shells out to `cockpit runtime send --command` — fine today, but there's no seam for a future Slack/Discord/email notifier. Swapping to a different alert channel would require editing every escalation call-site.

## Goal

Abstract user-notification behind a `NotifierDriver` interface mirroring phases 1-3. Cmux remains the default and only shipped implementation. The abstraction:

- Gives a single swap-point for future notifier providers (Slack, Discord, email, pager)
- Keeps the implementation thin — `CmuxNotifier.notify()` delegates to existing `cockpit runtime send --command`
- Exposes `cockpit notify <message>` CLI so bash scripts use one command for all escalations

## Non-Goals

- **Urgency levels** (`info`/`warn`/`error`) — no caller needs them today; add when a driver requires routing based on severity.
- **Multi-sink fanout** — "escalations go to Slack AND cmux" is routing logic, out of scope for phase 4. Follow-up if/when real multi-channel needs arrive.
- **Per-project notifier** — notifications go to the single user; scope is global only.
- **Replacing `delegate-to-captain` / `send-to-captain`** — those are dispatch to internal workspaces, not notifications. Stay on `cockpit runtime send <project>`.
- **Additional providers** (Slack, Discord, email, pager) — each is a follow-up PR.
- **External plugin loading** — phase 5.
- **Strict `NotifierScope` typing** — shipping loose, same pattern as prior phases.

## Architecture: Notifier Driver (mirrors Runtime + Workspace + Tracker)

```
cockpit core
  └── src/notifiers/
        ├── types.ts         ← NotifierDriver interface
        ├── cmux.ts          ← Cmux notifier (delegates to cockpit runtime send --command)
        ├── registry.ts      ← NotifierRegistry — global, no per-project
        ├── index.ts         ← re-exports
        └── __tests__/
```

Callers (`execute-reaction.sh`, future TS) go through `cockpit notify <message>`. The registry returns the configured driver; `CmuxNotifier` is a thin delegate over `cockpit runtime send --command`.

## 1. Notifier Driver Interface

```typescript
// src/notifiers/types.ts
export interface NotifierProbeResult {
  installed: boolean;   // provider deps present
  reachable: boolean;   // this notifier can currently deliver (e.g., command workspace running)
}

export interface NotifierScope {
  [key: string]: unknown;  // provider-specific (loose)
}

export interface NotifierDriver {
  name: string;          // "cmux", "slack", ...

  probe(): Promise<NotifierProbeResult>;
  notify(message: string): Promise<void>;
}

export type NotifierFactory = (scope: NotifierScope) => NotifierDriver;
```

### Contract notes

- **`notify()` must deliver and commit.** For cmux: the underlying `cockpit runtime send --command` already handles Enter-after-message per phase 1. For other providers: implementations are responsible for whatever "commit" means (Slack: message visible in channel; email: queued for send).
- **`probe()` returns two flags.** `installed` = the provider dependencies are present (cmux binary, auth token, SDK). `reachable` = the configured scope is currently deliverable (command workspace running, API key valid, etc.).
- **No scope for the default cmux notifier.** Scope parameter exists for future providers (Slack workspace ID, Discord webhook URL); cmux ignores it.

## 2. Registry & Config

```typescript
// src/notifiers/registry.ts
export class NotifierRegistry {
  constructor(private factories: Record<string, NotifierFactory>) {}

  get(config: CockpitConfig): NotifierDriver {
    const name = config.notifier ?? DEFAULT_NOTIFIER;
    return this.getFactory(name)({});
  }

  getFactory(name: string): NotifierFactory { /* throws on unknown */ }

  async probeAll(): Promise<Record<string, NotifierProbeResult>> { /* ... */ }
}
```

Config addition (single optional field, default `"cmux"`):

```jsonc
// ~/.config/cockpit/config.json
{
  "notifier": "cmux"  // NEW — global default (no per-project override)
}
```

No per-project `notifier` field — notifications target the user, not a project.

## 3. CLI Subcommand

New command at `src/commands/notify.ts`:

```
cockpit notify <message>       # deliver to the configured notifier
cockpit notify -               # read message from stdin
```

Single subcommand (notifier has one op). Exit 0 on success, 1 on failure. No `--help` subcommand tree needed — just this one command.

## 4. Refactor Surface

| File | Current | After |
|------|---------|-------|
| `scripts/execute-reaction.sh` `escalate` case | `cockpit runtime send --command "$MESSAGE"` | `cockpit notify "$MESSAGE"` |
| `scripts/execute-reaction.sh` `send-to-command` case | `cockpit runtime send --command "$MESSAGE"` | `cockpit notify "$MESSAGE"` |
| `scripts/execute-reaction.sh` `auto-fix-ci` max-retries escalation | `cockpit runtime send --command "$ESC_MSG"` | `cockpit notify "$ESC_MSG"` |
| `src/commands/doctor.ts` | no notifier check today | probe configured notifier |

Other call-sites remain on `cockpit runtime send <project>` — those dispatch to internal workspaces (captain command delivery), not notifications.

## 5. Testing

Mirror prior phases:

- **Unit tests** for `CmuxNotifier` — mock `execSync` to verify it calls `cockpit runtime send --command "..."`; verify `probe()` calls `cockpit runtime status --command` and maps exit code to `reachable`.
- **Unit tests** for `NotifierRegistry` — default provider returns cmux; override via `config.notifier`; unknown provider throws.
- **In-memory test driver** — `createMemoryNotifier(state?)` backed by an array of delivered messages. Used for any future TS caller tests.
- **Integration smoke** — `cockpit notify "hello"` against a running command workspace, gated behind `SKIP_INTEGRATION=1`.

## 6. Rollout

1. Land this spec and implementation plan.
2. Implement `src/notifiers/` with only `CmuxNotifier`.
3. Add `cockpit notify` CLI subcommand.
4. Migrate three `execute-reaction.sh` call-sites.
5. Add doctor probe.
6. Document in README.
7. Ship as single PR.

## 7. Relationship to Other Work

- **Builds on:** Phase 1 runtime (PR #20), Phase 2 workspace (PR #26), Phase 3 tracker (PR #28). Same driver+registry+CLI pattern.
- **Unblocks:** Slack, Discord, email, pager notifier PRs — each is a self-contained future addition.
- **Completes the core 4-slot plugin system.** Phase 5 (external plugin loading from `node_modules`) is the platform bet — deferred, optional, not blocking.
- **Follow-ups may arise:** urgency levels, multi-sink routing — only when a driver or caller actually needs them.
