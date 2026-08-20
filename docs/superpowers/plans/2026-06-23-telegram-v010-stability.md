# Telegram v0.10 Stability Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Follow `superpowers:test-driven-development` and `squadrant:karpathy-principles` for every task.

**Goal:** Make the Telegram integration stable enough to release v0.10 by closing two usability gaps — (1) a project-topic message auto-launches the captain when none is alive, (2) a general command channel runs curated squadrant operations from the phone — both gated behind a user-id allowlist (#321) and an opt-in `remoteControl` flag.

**Architecture:** All new logic lives in `@squadrant/core/src/telegram/` (auth helper, command registry, message routing) plus a small config addition in `@squadrant/shared` and a wiring change in the daemon host (`@squadrant/cli/src/control/squadrantd.ts`). The Telegram bridge stays decoupled from captain lifecycle by receiving an injected `ensureCaptainAlive` capability and a `runCommand` capability. Auto-launch reuses the existing `group dispatch` boot-if-down pattern (spawn `squadrant launch`, bounded warmup poll). Everything that shells out uses **async `execFile`** — never `*Sync` on the daemon poll path.

**Tech Stack:** TypeScript (NodeNext ESM — relative imports MUST end in `.js`), vitest, pnpm workspaces (6 packages), plain `fetch` Telegram client (no SDK).

## Global Constraints

- **ESM `.js` extensions:** every relative import ends in `.js` (NodeNext). `node dist/index.js --help` is the real gate, not just tests.
- **No daemon-blocking sync:** command execution and `squadrant launch` run via async `execFile` (from `node:child_process` promisified) — never `execFileSync`/`execSync` on the poll loop (event-loop starvation, learning #2).
- **Fail-closed security:** auto-launch and general commands act ONLY when `remoteControl === true` AND `message.from.id ∈ users[]`. Empty/undefined `users` ⇒ control surfaces disabled. Never fall back to chat-level for control actions.
- **`remoteControl` default false:** zero behavior change on upgrade. Existing v1 flows (freeform task → live captain, lifecycle push-out) unchanged when off.
- **Never write secrets over Telegram:** `/config set` must reject `telegram.botToken`, `telegram.users`, `telegram.chats`, `telegram.supergroupId`. Default-deny writable-key allowlist.
- **Crash containment:** no inbound handler error may escape the poll loop (existing `try/catch` in `pollLoop` is the backstop; new code must not break the at-least-once offset semantics).
- **Branch:** all work on one feature branch → one PR to `develop`. Frequent commits.

---

### Task 1: Config schema + auth helper

**Files:**
- Modify: `packages/shared/src/config.ts:42-47` (extend `TelegramConfig`)
- Create: `packages/core/src/telegram/auth.ts`
- Test: `packages/core/src/telegram/auth.test.ts`

**Interfaces:**
- Produces: `TelegramConfig` gains `users?: number[]` and `remoteControl?: boolean`.
- Produces: `isAuthorized(fromId: number | undefined, cfg: TelegramConfig): boolean` and `isControlEnabled(cfg: TelegramConfig): boolean` from `auth.ts`.

- [ ] **Step 1: Write the failing test** (`auth.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { isAuthorized, isControlEnabled } from "./auth.js";
import type { TelegramConfig } from "@squadrant/shared";

const base: TelegramConfig = { supergroupId: -100, chats: [-100] };

describe("telegram auth", () => {
  it("control disabled when remoteControl is unset/false", () => {
    expect(isControlEnabled(base)).toBe(false);
    expect(isControlEnabled({ ...base, remoteControl: false })).toBe(false);
    expect(isControlEnabled({ ...base, remoteControl: true })).toBe(true);
  });
  it("fails closed when users[] is empty or undefined", () => {
    expect(isAuthorized(42, base)).toBe(false);
    expect(isAuthorized(42, { ...base, users: [] })).toBe(false);
  });
  it("authorizes only allowlisted user ids", () => {
    const cfg = { ...base, users: [42] };
    expect(isAuthorized(42, cfg)).toBe(true);
    expect(isAuthorized(99, cfg)).toBe(false);
    expect(isAuthorized(undefined, cfg)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm --filter @squadrant/core test auth` → FAIL (module not found).

- [ ] **Step 3: Extend `TelegramConfig`** (config.ts) — add two optional fields, keep existing comment style:

```ts
export interface TelegramConfig {
  botToken?: string;      // falls back to env TELEGRAM_BOT_TOKEN at read time
  supergroupId: number;   // forum supergroup hosting per-project topics
  chats: number[];        // chat_id allowlist (inbound honored only from these)
  users?: number[];       // user-id allowlist for CONTROL actions (#321); empty ⇒ control disabled
  remoteControl?: boolean; // opt-in master switch for auto-launch + general commands (default false)
  pollMs?: number;        // getUpdates long-poll cadence (default 1000)
}
```

- [ ] **Step 4: Implement `auth.ts`**

```ts
// Pure auth predicates for the Telegram CONTROL surfaces (auto-launch, general
// commands). No I/O. Fail-closed: control requires both the master switch and a
// user-id match — chat membership alone is never enough for control.
import type { TelegramConfig } from "@squadrant/shared";

export function isControlEnabled(cfg: TelegramConfig): boolean {
  return cfg.remoteControl === true;
}

export function isAuthorized(fromId: number | undefined, cfg: TelegramConfig): boolean {
  if (fromId === undefined) return false;
  return Array.isArray(cfg.users) && cfg.users.includes(fromId);
}
```

- [ ] **Step 5: Run test, verify pass.** Then run `pnpm --filter @squadrant/shared build` so the type change propagates.

- [ ] **Step 6: Commit** — `git commit -m "feat(telegram): user-id allowlist + remoteControl config (#321)"`

---

### Task 2: Command registry (parse + validate + argv builder)

**Files:**
- Create: `packages/core/src/telegram/commands.ts`
- Test: `packages/core/src/telegram/commands.test.ts`

This task is pure logic — no execution, no network. Execution wiring is Task 4.

**Interfaces:**
- Produces:
  ```ts
  type ParsedCommand =
    | { kind: "ok"; name: string; argv: string[] }       // argv to pass to the squadrant CLI
    | { kind: "usage"; name: string; message: string }    // known command, bad args
    | { kind: "unknown"; message: string }                // not in registry
    | { kind: "denied"; message: string };                // e.g. /config set on a protected key
  function parseCommand(text: string): ParsedCommand;
  const WRITABLE_CONFIG_KEYS: readonly string[];           // default-deny allowlist
  ```
- The `argv` is the squadrant CLI argument vector (e.g. `["projects"]`, `["launch", "brove"]`). Task 4 prepends the resolved CLI binary path and runs via `execFile`.

**Command → argv mapping (v1 set):**

| Input | argv | Notes |
|---|---|---|
| `/help` | (handled in registry; returns usage text, not argv) | special-cased |
| `/status` | `["status"]` | |
| `/projects` | `["project", "list"]` | confirm subcommand name against CLI during impl |
| `/crews <project>` | `["crew", "list", "<project>"]` | |
| `/launch <project>` | `["launch", "<project>"]` | |
| `/register <repo> [--group g]` | `["register", "<repo>", "--group", "<g>"]` | non-interactive flags only |
| `/config get <key>` | `["config", "get", "<key>"]` | |
| `/config set <key> <val>` | `["config", "set", "<key>", "<val>"]` | key MUST be in `WRITABLE_CONFIG_KEYS` else `denied` |
| `/effort [max\|balance\|low]` | `["effort"]` or `["effort", "<mode>"]` | |
| `/spawn <project> <task...>` | `["crew", "spawn", "<project>", "<task>"]` | task is the rest of the line |

> **Implementer note:** verify each subcommand name against the actual CLI (`packages/cli/src/commands/`) before finalizing — adjust argv to match real command names. The mapping above is the intended behavior; exact tokens must match the CLI.

- [ ] **Step 1: Write failing tests** (`commands.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { parseCommand, WRITABLE_CONFIG_KEYS } from "./commands.js";

describe("parseCommand", () => {
  it("maps /status to argv", () => {
    expect(parseCommand("/status")).toEqual({ kind: "ok", name: "status", argv: ["status"] });
  });
  it("requires a project for /launch", () => {
    expect(parseCommand("/launch").kind).toBe("usage");
    expect(parseCommand("/launch brove")).toEqual({ kind: "ok", name: "launch", argv: ["launch", "brove"] });
  });
  it("denies /config set on a protected key", () => {
    expect(parseCommand("/config set telegram.botToken X").kind).toBe("denied");
    expect(parseCommand("/config set telegram.users [1] ").kind).toBe("denied");
  });
  it("allows /config set only on writable keys", () => {
    expect(WRITABLE_CONFIG_KEYS).toContain("defaults.effort");
    const p = parseCommand("/config set defaults.effort low");
    expect(p).toEqual({ kind: "ok", name: "config", argv: ["config", "set", "defaults.effort", "low"] });
  });
  it("rejects unknown commands", () => {
    expect(parseCommand("/frobnicate").kind).toBe("unknown");
  });
  it("captures the rest of the line as the spawn task", () => {
    const p = parseCommand("/spawn brove fix the header bug");
    expect(p).toMatchObject({ kind: "ok", name: "spawn", argv: ["crew", "spawn", "brove", "fix the header bug"] });
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `commands.ts`** — a small registry keyed by command name. Each entry: `{ minArgs, build(args): ParsedCommand-ish, usage }`. `WRITABLE_CONFIG_KEYS` starts intentionally tiny (default-deny): `["defaults.effort"]` (extend later as needed). Tokenize on whitespace; `/spawn` and `/config set` join the tail appropriately. `/help` returns a `usage`-kind listing all commands. No shell strings anywhere — argv arrays only.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): general command registry parser (#402)"`

---

### Task 3: ensureCaptainAlive (boot-if-down + warmup + debounce)

**Files:**
- Create: `packages/core/src/telegram/ensure-captain.ts`
- Test: `packages/core/src/telegram/ensure-captain.test.ts`

Reuses the `group dispatch` pattern (`packages/cli/src/commands/group.ts:36-61`) but expressed as an injectable factory so it can be unit-tested with stubs and wired in Task 5.

**Interfaces:**
- Produces:
  ```ts
  type EnsureResult = "alive" | "launched" | "timeout";
  interface EnsureCaptainDeps {
    isAlive: (project: string) => Promise<boolean>;   // liveness probe
    launch: (project: string) => Promise<void>;       // spawn `squadrant launch <project>`
    warmupTimeoutMs?: number;                          // default 120_000
    pollMs?: number;                                   // default 1_000
    sleep?: (ms: number) => Promise<void>;             // injectable for tests
    now?: () => number;                                // injectable for tests
  }
  function createEnsureCaptainAlive(deps: EnsureCaptainDeps): (project: string) => Promise<EnsureResult>;
  ```
- **Debounce:** the factory holds a `Set<string>` of projects currently launching. If `ensure(project)` is called while that project is mid-warmup, it does NOT launch again — it awaits/polls the same liveness loop and returns when alive or on timeout. Cleared on resolution.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { createEnsureCaptainAlive } from "./ensure-captain.js";

const fastSleep = () => Promise.resolve();

describe("ensureCaptainAlive", () => {
  it("returns alive immediately when captain is up", async () => {
    const launch = vi.fn();
    const ensure = createEnsureCaptainAlive({ isAlive: async () => true, launch, sleep: fastSleep });
    expect(await ensure("p")).toBe("alive");
    expect(launch).not.toHaveBeenCalled();
  });
  it("launches and returns launched when warmup succeeds", async () => {
    let alive = false;
    const launch = vi.fn(async () => { alive = true; });
    const ensure = createEnsureCaptainAlive({ isAlive: async () => alive, launch, sleep: fastSleep });
    expect(await ensure("p")).toBe("launched");
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("returns timeout when warmup never completes", async () => {
    let t = 0;
    const ensure = createEnsureCaptainAlive({
      isAlive: async () => false, launch: async () => {}, sleep: fastSleep,
      warmupTimeoutMs: 50, pollMs: 10, now: () => (t += 20),
    });
    expect(await ensure("p")).toBe("timeout");
  });
  it("debounces concurrent calls into a single launch", async () => {
    let alive = false;
    const launch = vi.fn(async () => { setTimeout(() => { alive = true; }, 0); });
    const ensure = createEnsureCaptainAlive({ isAlive: async () => alive, launch, sleep: fastSleep });
    const [a, b] = await Promise.all([ensure("p"), ensure("p")]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect([a, b].every((r) => r === "launched" || r === "alive")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `ensure-captain.ts`** — check `isAlive`; if alive ⇒ `"alive"`. Else, if not already launching this project, mark launching + call `launch(project)`; then poll `isAlive` every `pollMs` until true (⇒ `"launched"`) or `now()` passes the deadline (⇒ `"timeout"`); finally clear the launching mark. Concurrent callers for the same project skip the launch and share the poll.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): ensureCaptainAlive boot-if-down for auto-launch (#403)"`

---

### Task 4: Bridge routing — classify project / general / hint + auth gating

**Files:**
- Modify: `packages/core/src/telegram/bridge.ts:54-61` (`handleUpdate`) + `:16-22` (`TelegramBridgeOptions`)
- Test: `packages/core/src/telegram/bridge.test.ts` (add cases; create if absent)

**Interfaces:**
- Consumes: `isAuthorized`, `isControlEnabled` (Task 1); `parseCommand` (Task 2); `EnsureResult` (Task 3).
- `TelegramBridgeOptions` gains three optional injected capabilities (all optional ⇒ undefined preserves v1 behavior):
  ```ts
  ensureCaptainAlive?: (project: string) => Promise<"alive" | "launched" | "timeout">;
  runCommand?: (argv: string[]) => Promise<string>;       // executes squadrant CLI, returns capped output
  sendReply?: (threadId: number | undefined, text: string) => Promise<void>; // post to General topic (threadId undefined) or a topic
  ```
- The `message` shape parsed in `handleUpdate` must additionally read `from?: { id: number }`.

**New `handleUpdate` behavior:**

```
m = u.message
if !m || m.text === undefined: return
if !cfg.chats.includes(m.chat.id): return            // coarse chat filter (unchanged)

// GENERAL CHANNEL: no thread id, slash command
if m.message_thread_id === undefined:
    if !m.text.startsWith("/"): { sendReply?(undefined, "Send /help for commands."); return }
    if !isControlEnabled(cfg) || !isAuthorized(m.from?.id, cfg):
        { sendReply?(undefined, "⛔ not authorized"); return }   // fail-closed
    parsed = parseCommand(m.text)
    switch parsed.kind:
        unknown|usage|denied: sendReply?(undefined, parsed.message)
        ok: out = await runCommand?(parsed.argv); sendReply?(undefined, out)
    return

// PROJECT TOPIC (existing path + auto-launch)
resolved = findProjectByThread(stateRoot, m.message_thread_id)
if !resolved: return
if ensureCaptainAlive && isControlEnabled(cfg) && isAuthorized(m.from?.id, cfg):
    r = await ensureCaptainAlive(resolved.project)
    if r === "timeout": sendReply?(m.message_thread_id, "⚠️ captain didn't warm up; message queued."); // still append below
await appendCaptainMessage({ stateRoot, project: resolved.project, text: formatInbound(m.text), source: "telegram" })
```

> Note: when `remoteControl` is off OR sender not allowlisted, the project-topic path skips auto-launch and behaves exactly as v1 (append only). This preserves the safe default.

- [ ] **Step 1: Write failing tests** — fake `client`, capture `appendCaptainMessage`, `ensureCaptainAlive`, `runCommand`, `sendReply` via spies. Cases:
  - General topic, non-slash → `sendReply("Send /help…")`, no command run.
  - General topic, `/status`, control off → `sendReply("⛔ not authorized")`.
  - General topic, `/status`, control on + authorized → `runCommand(["status"])` called, output replied.
  - General topic, `/status`, control on + NOT authorized → not authorized reply, no `runCommand`.
  - Project topic, control on + authorized, captain dead → `ensureCaptainAlive` called, then `appendCaptainMessage`.
  - Project topic, control off → `ensureCaptainAlive` NOT called, `appendCaptainMessage` still called (v1 parity).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** the routing in `bridge.ts`. Add the optional fields to `TelegramBridgeOptions` and destructure them. Keep all error handling inside `handleUpdate`/`pollLoop` (no throw escapes; an append failure still rethrows to preserve at-least-once offset, but command/reply failures are caught and logged).

- [ ] **Step 4: Run, verify pass.** Run the full core suite: `pnpm --filter @squadrant/core test`.

- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): route general commands + auto-launch in handleUpdate (#402/#403)"`

---

### Task 5: Daemon host wiring — construct capabilities

**Files:**
- Modify: `packages/cli/src/control/squadrantd.ts:38-50` (`buildTelegramBridge`)
- Possibly add: a small `runCommand` + `isCaptainAlive`/`launch` helper module under `packages/cli/src/control/` (CLI layer owns process spawning + socket access).
- Test: covered indirectly; add a focused unit test for `runCommand` output capping if it has logic worth testing.

**Interfaces:**
- Consumes: `createEnsureCaptainAlive` (Task 3), `createTelegramBridge` options (Task 4).
- Wires:
  - `ensureCaptainAlive` = `createEnsureCaptainAlive({ isAlive, launch })` where `isAlive(project)` queries the daemon health (reuse the `group.ts` `isCaptainAlive` approach via `sendRequest(SOCK, {kind:"health",project})`) and `launch(project)` runs `execFile(squadrantBin, ["launch", project])`.
  - `runCommand(argv)` = `execFile(squadrantBin, argv, { timeout })` → return `stdout` (+ stderr tail) capped to ~3500 chars (Telegram message limit is 4096; leave headroom).
  - `sendReply(threadId, text)` = `client.sendMessage(cfg.supergroupId, threadId, text)`; when `threadId` is undefined, send to the General topic (omit `message_thread_id` so it lands in General).

> **Resolve during impl:** the squadrant CLI binary path. The global `squadrant` bin is a symlink to the repo build (`dist/index.js`). Resolve it the same way other spawns in the codebase do (check how crew/launch spawns resolve the bin) rather than hardcoding.

- [ ] **Step 1:** Add `runCommand` + `isCaptainAlive` + `launch` helpers (async `execFile`, promisified). Cap output. Guard: `runCommand` only ever receives argv from `parseCommand` (already validated) — still pass argv array (no shell).
- [ ] **Step 2:** In `buildTelegramBridge`, construct `ensureCaptainAlive`, `runCommand`, `sendReply` and pass them to `createTelegramBridge`.
- [ ] **Step 3:** Build the CLI: `pnpm build`; smoke `node dist/index.js --help` and `node dist/squadrantd.js --help` (must print one-liner + exit, NOT boot).
- [ ] **Step 4:** Run full suite `pnpm test` (or per-package) — green.
- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): wire ensureCaptainAlive + command runner into daemon host"`

---

### Task 6: `telegram setup` wizard — capture user-id + enable remoteControl

**Files:**
- Modify: `packages/cli/src/commands/telegram.ts` (the setup wizard)
- Test: existing telegram command tests; add a case if the wizard has unit-testable parsing.

**Behavior:**
- After detecting the supergroup/topics (existing flow), the wizard prompts: "Enable remote control (auto-launch + general commands)? [y/N]". If yes, it captures the operator's Telegram **user-id** (from the most recent message's `from.id` via getUpdates, mirroring how it polls for the group) and writes `telegram.users = [<id>]` + `telegram.remoteControl = true`.
- Keep token input masking (existing raw-mode keypress handling) and the stdin-pause-on-complete fix (so the process exits — prior bug).
- Idempotent: re-running setup updates `users`/`remoteControl` without clobbering `chats`/`supergroupId`.

- [ ] **Step 1:** Read the current wizard to match its prompt/style. **Run `gitnexus_impact` on the setup function before editing** (CLAUDE.md rule).
- [ ] **Step 2:** Add the remote-control prompt + user-id capture + config write.
- [ ] **Step 3:** Manual verification path documented (can't fully unit-test interactive TTY): `squadrant telegram setup` → enable → confirm config has `users`/`remoteControl`.
- [ ] **Step 4: Commit** — `git commit -m "feat(telegram): setup wizard captures user-id + enables remoteControl (#321)"`

---

### Task 7: Docs + regression + release readiness

**Files:**
- Modify: Telegram docs (find under `docs/` — the v1 integration doc) — document the General command channel, the command list, `users`/`remoteControl` config, and the fail-closed security model.
- Modify: add the #403 end-to-end note (WoL relay = operator infra, out of repo scope).
- Modify: `CHANGELOG.md` (or wherever release notes live) — v0.10.0 entry.

- [ ] **Step 1:** Update the Telegram doc with the new config fields + command channel + security model. Add a short "remote-wake (WoL)" section pointing at #403 as operator-side infra.
- [ ] **Step 2:** Run the FULL test suite on the authoritative checkout — `pnpm test` — confirm green (baseline was 1358/1358). Record the number.
- [ ] **Step 3:** `node dist/index.js --help` + `node dist/squadrantd.js --help` smoke. Run `gitnexus_detect_changes()` to confirm only expected symbols changed.
- [ ] **Step 4:** Add CHANGELOG v0.10.0 entry summarizing the three features.
- [ ] **Step 5: Commit** — `git commit -m "docs(telegram): v0.10 command channel + security model; changelog"`
- [ ] **Step 6:** Push branch, open PR to `develop` titled "Telegram v0.10 stability: auto-launch + general command channel + user-id allowlist (#403/#402/#321)". Link all three issues.

---

## Self-Review

**Spec coverage:**
- Routing model → Task 4. ✅
- Gap 1 auto-launch (boot-if-down, warmup, debounce) → Task 3 + Task 4 + Task 5. ✅
- Gap 2 general registry (curated, validated, async execFile, `/config set` key allowlist) → Task 2 + Task 5. ✅
- Security gate `users[]` + `remoteControl`, fail-closed → Task 1 + Task 4. ✅
- Setup wizard captures user-id → Task 6. ✅
- Docs + WoL out-of-scope note + release → Task 7. ✅

**Type consistency:** `ensureCaptainAlive` returns `"alive" | "launched" | "timeout"` consistently across Tasks 3/4/5. `ParsedCommand` kinds (`ok|usage|unknown|denied`) consistent across Tasks 2/4. `TelegramConfig` fields (`users`, `remoteControl`) consistent across Tasks 1/4/6.

**Open items deferred to impl (non-blocking):** exact CLI subcommand tokens for argv (verify against `packages/cli/src/commands/`); squadrant bin path resolution; `/register` repo-clone semantics. Each flagged inline in the owning task.
