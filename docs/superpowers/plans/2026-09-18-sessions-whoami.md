# `squadrant sessions` / `squadrant whoami` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only, registry-backed agent-session introspection: `squadrant sessions` (list live sessions) and `squadrant whoami` (the calling session's identity).

**Architecture:** One optional `listSessions?()` method on the existing `AgentDriver` seam. Claude implements it over `~/.claude/sessions/*.json` (pid-reconciled); opencode implements it over the #786/#789 captain record (`state/<project>/captain.json`); codex/gemini omit it and are reported unsupported. `whoami` resolves the calling session from positive markers only (`SQUADRANT_CREW_*`, `SQUADRANT_ROLE`, `$CLAUDE_CODE_MESSAGING_SOCKET`, cwd→project) and falls back to the captain/task record. Both commands are read-only and never touch the daemon.

**Tech Stack:** TypeScript (ESM), vitest, commander, node:fs.

Refined scope: https://github.com/tu11aa/squadrant/issues/669#issuecomment-5725823983

---

## File structure

| File | Responsibility |
|---|---|
| `packages/agents/src/drivers/types.ts` (modify) | `AgentSession` type; `listSessions?` on `AgentDriver` |
| `packages/agents/src/sessions/claude-sessions.ts` (create) | Read + reconcile `~/.claude/sessions` |
| `packages/agents/src/sessions/opencode-sessions.ts` (create) | Read `state/*/captain.json` (agent=opencode) |
| `packages/agents/src/drivers/claude.ts` (modify) | wire `listSessions` |
| `packages/agents/src/drivers/opencode.ts` (modify) | wire `listSessions` |
| `packages/agents/src/drivers/index.ts` / `src/index.ts` (modify) | exports |
| `packages/cli/src/lib/whoami.ts` (create) | pure `resolveWhoami` + `projectForCwd` |
| `packages/cli/src/commands/sessions.ts` (create) | `sessions` command + pure filter/format helpers |
| `packages/cli/src/commands/whoami.ts` (create) | `whoami` command |
| `packages/core/src/launchd.ts` (modify) | `READ_ONLY_TOP_LEVEL_COMMANDS` + `isReadOnlyTopLevelCommand` |
| `packages/cli/src/index.ts` (modify) | register commands; skip daemon for read-only |
| `docs/reference.md` (modify) | document both commands |

## Data sources (verified)

- Claude: `~/.claude/sessions/<pid>.json` — `{ pid, sessionId, cwd, status?, messagingSocketPath, ... }`. Status absent on `sdk-cli` ⇒ `unknown`.
- Opencode captain: `~/.config/squadrant/state/<project>/captain.json` — `{ agent, port?, sessionId?, directory, launchedAt }`.
- Claude peer socket: `captainSocketPath(project)` = `/tmp/cc-socks/squadrant-captain-<project>.sock` (`@squadrant/core`).
- Crew markers: `SQUADRANT_CREW_TASK_ID`, `SQUADRANT_CREW_PROJECT`; captain: `SQUADRANT_ROLE=captain`; claude self: `$CLAUDE_CODE_MESSAGING_SOCKET`.
- Crew task record: `state/<project>/<taskId>.json` (`TaskRecord`).

---

### Task 1: `AgentSession` + `listSessions` seam

**Files:** modify `packages/agents/src/drivers/types.ts`

- [ ] Add:
```ts
/** #669: one live agent session, normalized across agents. */
export interface AgentSession {
  /** Stable session id (claude sessionId / opencode ses_…). */
  id: string;
  pid?: number;
  cwd?: string;
  /** Agent-reported, reconciled: idle|busy|shell|waiting|unknown|stale|recorded. */
  status: string;
  /** claude: UDS socket path; opencode: http://127.0.0.1:<port>. */
  address?: string;
  /** Squadrant project, when the source can name one (opencode captain records). */
  project?: string;
}
```
- [ ] Add optional method to `AgentDriver`:
```ts
  /**
   * #669: read-only introspection of this agent's live sessions. Optional —
   * an agent that cannot enumerate its sessions omits it and is reported as
   * "unsupported". Pure read; never delivers or mutates.
   */
  listSessions?(): Promise<AgentSession[]>;
```
- [ ] Export `AgentSession` from `drivers/index.ts` and hence `src/index.ts`.
- [ ] Commit.

### Task 2: claude `listSessions` (TDD)

**Files:** create `packages/agents/src/sessions/claude-sessions.ts`, test `packages/agents/src/sessions/__tests__/claude-sessions.test.ts`

- [ ] Failing tests: maps a live entry (`status: idle` ⇒ `idle`); dead pid ⇒ `stale`; missing status ⇒ `unknown` (never `idle`); id falls back to `String(pid)` when sessionId absent; address carried; unreadable dir ⇒ `[]`; torn file skipped.
- [ ] Implement, reusing `CLAUDE_SESSIONS_DIR` + `parseRegistryDir` from `../claude/registry.js`, injectable `{ readdir, readFile, isAlive }`.

### Task 3: opencode `listSessions` (TDD)

**Files:** create `packages/agents/src/sessions/opencode-sessions.ts`, test `packages/agents/src/sessions/__tests__/opencode-sessions.test.ts`

- [ ] Failing tests: reads `state/<project>/captain.json` with `agent: "opencode"` ⇒ `{ id: sessionId, cwd: directory, status: "recorded", address: http://127.0.0.1:<port>, project }`; ignores non-opencode records; missing sessionId ⇒ id `captain:<project>`; absent state dir ⇒ `[]`; malformed JSON skipped.
- [ ] Implement: `SQUADRANT_STATE_DIR` default, injectable `{ stateRoot, readdir, readFile }`.
- [ ] Wire `listSessions` into `drivers/claude.ts` and `drivers/opencode.ts`.

### Task 4: `whoami` resolver (TDD)

**Files:** create `packages/cli/src/lib/whoami.ts`, test `packages/cli/src/lib/__tests__/whoami.test.ts`

- [ ] Failing tests:
  - claude session via `$CLAUDE_CODE_MESSAGING_SOCKET` ⇒ `source: "claude-registry"`, agent claude, sessionId from lookup.
  - opencode captain: `SQUADRANT_ROLE=captain`, cwd inside project, captain record ⇒ `source: "captain-record"`, agent opencode, address `http://127.0.0.1:<port>`.
  - opencode captain with no sessionId yet ⇒ `sessionId: null` + note, `ok: true`.
  - crew: `SQUADRANT_CREW_TASK_ID`/`_PROJECT` + task record ⇒ role crew, agent provider, address from socket/serverPort.
  - nothing resolvable ⇒ `ok: false`, source `"none"`.
  - cwd outside any project ⇒ project null.
  - `projectForCwd` prefers the longest matching path.
- [ ] Implement `resolveWhoami(deps)` and `projectForCwd(cwd, projects)`.

### Task 5: `sessions` command (TDD)

**Files:** create `packages/cli/src/commands/sessions.ts`, test `packages/cli/src/commands/__tests__/sessions.test.ts`

- [ ] Failing tests for pure helpers: `filterSessions(rows, {agent, project, liveOnly, projects})` and `formatSessionTable(rows)` (empty ⇒ explicit message, not throw).
- [ ] Implement `sessionsCommand` with `[--json] [--agent <n>] [--project <n>] [--live-only]`. Union of `listSessions` across drivers; unsupported agents noted on stderr (or error+exit 1 when explicitly requested via `--agent`).

### Task 6: `whoami` command

**Files:** create `packages/cli/src/commands/whoami.ts`

- [ ] Build deps from `loadConfig` / `resolveHome` / `readCaptainAddress` / `createStore` / `readClaudeStatusBySocketPath`; print JSON with `--json`, human table otherwise; exit 1 when `!ok`.

### Task 7: daemon-independent registration

**Files:** modify `packages/core/src/launchd.ts`, `packages/cli/src/index.ts`, `packages/core/src/__tests__/launchd.test.ts`

- [ ] Add `READ_ONLY_TOP_LEVEL_COMMANDS = new Set(["sessions", "whoami"])` + pure `isReadOnlyTopLevelCommand(argv)`; test it.
- [ ] `index.ts`: skip `ensureDaemon` when `isReadOnlyCrewCommand(argv) || isReadOnlyTopLevelCommand(argv)`; register both commands.

### Task 8: docs + verification

- [ ] Document both commands in `docs/reference.md`.
- [ ] `pnpm lint` (baseline: pre-existing tsup/node_modules root failures) and `pnpm test` green (relay-proxy known flaky).
- [ ] Open PR base `develop`; do NOT merge.
