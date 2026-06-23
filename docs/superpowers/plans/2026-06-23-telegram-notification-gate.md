# Telegram Per-Project Notification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate outbound Telegram lifecycle notifications per-project — muted by default, auto-unmuted when the user messages into a project topic, with manual `/mute`/`/unmute` (Telegram) and `squadrant telegram notify` (CLI) toggles.

**Architecture:** Add a per-project `notify` flag to the existing `telegram-state.json`. A synchronous early-return gate in `deliverOutbound` drops lifecycle events for muted projects (no network call). Inbound messages into a project topic flip the project active (auto-unmute). Manual toggles route through the existing fail-closed command surfaces — General-topic `/mute <project>` reuses the curated CLI argv channel; in-topic `/mute` is handled directly in the bridge.

**Tech Stack:** TypeScript (NodeNext ESM — relative imports MUST end in `.js`), vitest, commander.

## Global Constraints

- **ESM `.js` extensions:** every relative import in `.ts` source MUST end in `.js` (NodeNext). Missing it compiles but crashes at runtime.
- **Default muted:** a project absent from `state.notify` (or `false`) is MUTED. No config schema change, no migration, no backfill.
- **Fail-closed Telegram toggles:** `/mute` and `/unmute` run ONLY when `isControlEnabled(cfg) && isAuthorized(fromId, cfg)`. Auto-unmute-on-message is independent of `remoteControl` (gated only by the existing `cfg.chats` coarse filter).
- **Gate scope:** only auto-pushed lifecycle events (`pushLifecycle`/`deliverOutbound`) are gated. Command replies and the General command channel are never gated.
- **Single-file test runs:** `npx vitest run <path>` (the bare `vitest` script is watch mode). Do not run the full suite repeatedly.
- **Exports:** `packages/core/src/telegram/index.ts` does `export * from "./state.js"`, re-exported by `packages/core/src/index.ts`. New `state.ts` exports are automatically available as `@squadrant/core` imports.

---

### Task 1: `notify` state field + helpers

**Files:**
- Modify: `packages/core/src/telegram/state.ts`
- Test: `packages/core/src/telegram/__tests__/state.test.ts`

**Interfaces:**
- Produces:
  - `interface TelegramState { offset: number; topics: Record<string, number>; notify: Record<string, boolean> }`
  - `isNotifyActive(stateRoot: string, project: string): boolean` — `true` iff `state.notify[project] === true`
  - `setNotify(stateRoot: string, project: string, active: boolean): void` — read-modify-write, mirrors `setTopic`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/telegram/__tests__/state.test.ts` (reuse the file's existing tmp-dir helper; if none, create a tmp dir per test with `fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-"))`):

```ts
import { isNotifyActive, setNotify } from "../state.js";

describe("notify state", () => {
  it("defaults to muted (absent key → false)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-"));
    expect(isNotifyActive(dir, "squadrant")).toBe(false);
  });

  it("loadState defaults notify to {} when file lacks it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-"));
    fs.writeFileSync(path.join(dir, "telegram-state.json"), JSON.stringify({ offset: 3, topics: {} }));
    expect(loadState(dir).notify).toEqual({});
  });

  it("setNotify round-trips through save/load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-"));
    setNotify(dir, "squadrant", true);
    expect(isNotifyActive(dir, "squadrant")).toBe(true);
    setNotify(dir, "squadrant", false);
    expect(isNotifyActive(dir, "squadrant")).toBe(false);
  });

  it("setNotify preserves offset and topics", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-state-"));
    setTopic(dir, "squadrant", 7);
    setNotify(dir, "squadrant", true);
    const s = loadState(dir);
    expect(s.topics).toEqual({ "squadrant::project": 7 });
    expect(s.notify).toEqual({ squadrant: true });
  });
});
```

Ensure `fs`, `path`, `os`, `loadState`, `setTopic` are imported at the top of the test file (add any missing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/telegram/__tests__/state.test.ts`
Expected: FAIL — `isNotifyActive`/`setNotify` not exported.

- [ ] **Step 3: Implement in `state.ts`**

Add `notify` to the interface:

```ts
export interface TelegramState {
  offset: number;
  /** key = `${project}::${scope}` (see topicKey); value = message_thread_id. */
  topics: Record<string, number>;
  /** key = project; value = true when active. Absent/false = MUTED (default). */
  notify: Record<string, boolean>;
}
```

In `loadState`, default the field:

```ts
return {
  offset: typeof data.offset === "number" ? data.offset : 0,
  topics: data.topics ?? {},
  notify: data.notify ?? {},
};
```

Add helpers (after `setTopic`):

```ts
export function isNotifyActive(stateRoot: string, project: string): boolean {
  return loadState(stateRoot).notify[project] === true;
}

export function setNotify(stateRoot: string, project: string, active: boolean): void {
  const s = loadState(stateRoot);
  s.notify[project] = active;
  saveState(stateRoot, s);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/telegram/__tests__/state.test.ts`
Expected: PASS (all notify tests + pre-existing state tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/telegram/state.ts packages/core/src/telegram/__tests__/state.test.ts
git commit -m "feat(telegram): per-project notify flag in telegram-state"
```

---

### Task 2: CLI `telegram notify` subcommand

**Files:**
- Modify: `packages/cli/src/commands/telegram.ts`
- Test: `packages/cli/src/commands/__tests__/telegram.test.ts`

**Interfaces:**
- Consumes: `isNotifyActive`, `setNotify`, `loadState` from `@squadrant/core`
- Produces:
  - `runTelegramNotifySet(opts: { project: string; active: boolean; stateRoot: string }): void`
  - `runTelegramNotifyStatus(opts: { stateRoot: string }): Array<{ project: string; active: boolean }>`
  - CLI: `squadrant telegram notify <project> <on|off>` and `squadrant telegram notify --status` (also: no args → status)

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/commands/__tests__/telegram.test.ts` (match its existing import style and tmp-dir helper):

```ts
import { runTelegramNotifySet, runTelegramNotifyStatus } from "../telegram.js";
import { isNotifyActive, setTopic } from "@squadrant/core";

describe("telegram notify CLI", () => {
  it("runTelegramNotifySet writes the flag", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cli-"));
    runTelegramNotifySet({ project: "squadrant", active: true, stateRoot: dir });
    expect(isNotifyActive(dir, "squadrant")).toBe(true);
    runTelegramNotifySet({ project: "squadrant", active: false, stateRoot: dir });
    expect(isNotifyActive(dir, "squadrant")).toBe(false);
  });

  it("runTelegramNotifyStatus lists known projects (from topics ∪ notify)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cli-"));
    setTopic(dir, "alpha", 1);          // linked but never toggled → muted
    runTelegramNotifySet({ project: "beta", active: true, stateRoot: dir });
    const rows = runTelegramNotifyStatus({ stateRoot: dir }).sort((a, b) => a.project.localeCompare(b.project));
    expect(rows).toEqual([
      { project: "alpha", active: false },
      { project: "beta", active: true },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cli/src/commands/__tests__/telegram.test.ts`
Expected: FAIL — `runTelegramNotifySet`/`runTelegramNotifyStatus` not exported.

- [ ] **Step 3: Implement the helpers + subcommand**

In `packages/cli/src/commands/telegram.ts`, extend the existing `@squadrant/core` import to include `isNotifyActive, setNotify` (it already imports `loadState, setTopic, topicKey`).

Add the helper functions (near `runTelegramStatus`):

```ts
/** Set a project's notification flag in telegram-state.json. */
export function runTelegramNotifySet(opts: { project: string; active: boolean; stateRoot: string }): void {
  setNotify(opts.stateRoot, opts.project, opts.active);
}

/** List every known project (union of linked topics and notify keys) with its state. */
export function runTelegramNotifyStatus(opts: { stateRoot: string }): Array<{ project: string; active: boolean }> {
  const s = loadState(opts.stateRoot);
  const projects = new Set<string>();
  for (const key of Object.keys(s.topics)) {
    const sep = key.indexOf("::");
    projects.add(sep === -1 ? key : key.slice(0, sep));
  }
  for (const p of Object.keys(s.notify)) projects.add(p);
  return [...projects].map((project) => ({ project, active: s.notify[project] === true }));
}
```

Register the subcommand (after the `link` command block):

```ts
telegramCommand
  .command("notify")
  .argument("[project]", "project to toggle")
  .argument("[state]", "on | off")
  .option("--status", "list notification state for all projects")
  .description("Per-project lifecycle notifications: on|off, or --status to list")
  .action((project: string | undefined, state: string | undefined, opts: { status?: boolean }) => {
    const stateRoot = defaultStateRoot();
    if (opts.status || !project) {
      const rows = runTelegramNotifyStatus({ stateRoot });
      if (rows.length === 0) {
        console.log("no projects linked");
        return;
      }
      for (const r of rows) {
        console.log(`  ${r.project}: ${r.active ? chalk.green("on") : chalk.dim("off (muted)")}`);
      }
      return;
    }
    if (state !== "on" && state !== "off") {
      console.error(chalk.red("usage: squadrant telegram notify <project> <on|off>"));
      process.exit(1);
    }
    runTelegramNotifySet({ project, active: state === "on", stateRoot });
    console.log(chalk.green(`${project} notifications ${state === "on" ? "ON" : "OFF"}`));
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/cli/src/commands/__tests__/telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the CLI wiring compiles & runs**

Run: `pnpm build && node dist/index.js telegram notify --help`
Expected: help text for the `notify` subcommand prints (no crash — guards the ESM `.js` extension rule).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/telegram.ts packages/cli/src/commands/__tests__/telegram.test.ts
git commit -m "feat(telegram): squadrant telegram notify <project> on|off + --status"
```

---

### Task 3: Outbound gate in `deliverOutbound`

**Files:**
- Modify: `packages/core/src/telegram/bridge.ts`
- Test: `packages/core/src/telegram/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: `isNotifyActive` from `./state.js`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/telegram/__tests__/bridge.test.ts`, follow the file's existing harness (a fake `TelegramClient` recording calls + a tmp `stateRoot`). Add:

```ts
it("pushLifecycle drops the event when the project is MUTED (no client calls)", async () => {
  // bridge built with the file's existing makeBridge/fakeClient helper
  bridge.pushLifecycle("squadrant", { kind: "task.idle", /* …minimal ControlEvent… */ } as any);
  await flush(); // the file's existing microtask flush for fire-and-forget
  expect(fakeClient.createForumTopic).not.toHaveBeenCalled();
  expect(fakeClient.sendMessage).not.toHaveBeenCalled();
});

it("pushLifecycle delivers when the project is ACTIVE", async () => {
  setNotify(stateRoot, "squadrant", true);
  fakeClient.createForumTopic.mockResolvedValue(7);
  bridge.pushLifecycle("squadrant", { kind: "task.idle" } as any);
  await flush();
  expect(fakeClient.sendMessage).toHaveBeenCalledTimes(1);
});
```

Import `setNotify` from `../state.js` in the test. Reuse the existing `ControlEvent` shape already used elsewhere in this test file (copy a valid event literal rather than inventing fields).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/telegram/__tests__/bridge.test.ts`
Expected: FAIL — muted project still calls `sendMessage` (gate not present).

- [ ] **Step 3: Implement the gate**

In `bridge.ts`, add `isNotifyActive` to the `./state.js` import. Gate at the top of `deliverOutbound`:

```ts
async function deliverOutbound(project: string, ev: ControlEvent): Promise<void> {
  if (!isNotifyActive(stateRoot, project)) return; // muted (default) → no topic create, no send
  let threadId = loadState(stateRoot).topics[topicKey(project)];
  // …unchanged…
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/telegram/__tests__/bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/telegram/bridge.ts packages/core/src/telegram/__tests__/bridge.test.ts
git commit -m "feat(telegram): gate outbound lifecycle on per-project notify flag"
```

---

### Task 4: Auto-unmute + in-topic `/mute`·`/unmute` routing

**Files:**
- Modify: `packages/core/src/telegram/bridge.ts`
- Test: `packages/core/src/telegram/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: `setNotify` from `./state.js`; `isControlEnabled`, `isAuthorized` from `./auth.js` (already imported)

**Behavior of `handleProjectTopic(text, threadId, fromId)`:**
1. Resolve project via `findProjectByThread`; return if none.
2. If the trimmed text's first token is `/mute` or `/unmute` (case-insensitive): this is a toggle, not a message.
   - If `isControlEnabled(cfg) && isAuthorized(fromId, cfg)`: `setNotify(project, /unmute→true | /mute→false)`, then `reply(threadId, "🔔 <project> notifications ON" | "🔕 <project> notifications OFF")`.
   - Else: `reply(threadId, "⛔ not authorized")`.
   - **Return without appending** a captain.message and without auto-unmuting.
3. Otherwise (a normal message): `setNotify(project, true)` (auto-unmute), then the existing `ensureCaptainAlive` (gated) + `appendCaptainMessage` flow — unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `bridge.test.ts` (reuse the existing inbound-update harness — the helper that feeds a fake `getUpdates` result through the poll loop, or calls the exported handler if the file exposes one):

```ts
it("auto-unmutes a project when a normal message lands in its topic", async () => {
  setTopic(stateRoot, "squadrant", 7);
  await deliverInbound({ message: { chat: { id: CHAT_ID }, message_thread_id: 7, text: "hello", from: { id: USER_ID } } });
  expect(isNotifyActive(stateRoot, "squadrant")).toBe(true);
  expect(appendCaptainMessage).toHaveBeenCalledTimes(1);
});

it("auto-unmute works even when remoteControl is OFF", async () => {
  // cfg.remoteControl = false in this bridge instance
  setTopic(stateRoot, "squadrant", 7);
  await deliverInbound({ message: { chat: { id: CHAT_ID }, message_thread_id: 7, text: "hi", from: { id: USER_ID } } });
  expect(isNotifyActive(stateRoot, "squadrant")).toBe(true);
});

it("/unmute in a project topic toggles ON and does NOT append a captain message (authorized)", async () => {
  // cfg.remoteControl = true, cfg.users = [USER_ID]
  setTopic(stateRoot, "squadrant", 7);
  setNotify(stateRoot, "squadrant", false);
  await deliverInbound({ message: { chat: { id: CHAT_ID }, message_thread_id: 7, text: "/unmute", from: { id: USER_ID } } });
  expect(isNotifyActive(stateRoot, "squadrant")).toBe(true);
  expect(appendCaptainMessage).not.toHaveBeenCalled();
  expect(sendReply).toHaveBeenCalled();
});

it("/mute in a project topic is rejected (and not appended) when remoteControl is OFF", async () => {
  // cfg.remoteControl = false
  setTopic(stateRoot, "squadrant", 7);
  setNotify(stateRoot, "squadrant", true);
  await deliverInbound({ message: { chat: { id: CHAT_ID }, message_thread_id: 7, text: "/mute", from: { id: USER_ID } } });
  expect(isNotifyActive(stateRoot, "squadrant")).toBe(true); // unchanged — toggle refused
  expect(appendCaptainMessage).not.toHaveBeenCalled();
  expect(sendReply).toHaveBeenCalledWith(7, expect.stringContaining("not authorized"));
});
```

Use the test file's actual harness names — `deliverInbound`/`CHAT_ID`/`USER_ID`/`sendReply`/`appendCaptainMessage` here are placeholders for whatever the file already defines. If the file exercises inbound only through `getUpdates`, drive these through that same path.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/telegram/__tests__/bridge.test.ts`
Expected: FAIL — no auto-unmute, `/mute` text appended as a captain message.

- [ ] **Step 3: Implement**

Add `setNotify` to the `./state.js` import in `bridge.ts`. Add a small helper above `handleProjectTopic`:

```ts
// Recognize the two in-topic notification toggles. Returns the desired active
// state, or null if the text is an ordinary message.
function notifyToggle(text: string): boolean | null {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (first === "/unmute") return true;
  if (first === "/mute") return false;
  return null;
}
```

Rewrite `handleProjectTopic`:

```ts
async function handleProjectTopic(text: string, threadId: number, fromId: number | undefined): Promise<void> {
  const resolved = findProjectByThread(stateRoot, threadId);
  if (!resolved) return; // no project bound to this topic

  const toggle = notifyToggle(text);
  if (toggle !== null) {
    // Explicit toggle command — fail-closed, never appended as a captain message.
    if (!isControlEnabled(cfg) || !isAuthorized(fromId, cfg)) {
      await reply(threadId, "⛔ not authorized");
      return;
    }
    setNotify(stateRoot, resolved.project, toggle);
    await reply(threadId, toggle ? `🔔 ${resolved.project} notifications ON` : `🔕 ${resolved.project} notifications OFF`);
    return;
  }

  setNotify(stateRoot, resolved.project, true); // engagement → auto-unmute (sticky)
  if (ensureCaptainAlive && isControlEnabled(cfg) && isAuthorized(fromId, cfg)) {
    try {
      const r = await ensureCaptainAlive(resolved.project);
      if (r === "timeout") await reply(threadId, "⚠️ captain didn't warm up; message queued.");
    } catch (e) {
      log(`telegram auto-launch failed project=${resolved.project}: ${(e as Error).message}`);
    }
  }
  await appendCaptainMessage({ stateRoot, project: resolved.project, text: formatInbound(text), source: "telegram" });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/telegram/__tests__/bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/telegram/bridge.ts packages/core/src/telegram/__tests__/bridge.test.ts
git commit -m "feat(telegram): auto-unmute on inbound + in-topic /mute /unmute toggle"
```

---

### Task 5: General-topic `/mute <project>` · `/unmute <project>` in the command registry

**Files:**
- Modify: `packages/core/src/telegram/commands.ts`
- Test: `packages/core/src/telegram/commands.test.ts`

**Interfaces:**
- Produces: registry entries `mute` → argv `["telegram","notify",<project>,"off"]`, `unmute` → argv `["telegram","notify",<project>,"on"]` (require a `<project>` arg; the General topic has no thread to infer from).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/telegram/commands.test.ts` (match its existing `parseCommand` test style):

```ts
it("/unmute <project> → telegram notify <project> on", () => {
  expect(parseCommand("/unmute squadrant")).toEqual({ kind: "ok", name: "unmute", argv: ["telegram", "notify", "squadrant", "on"] });
});

it("/mute <project> → telegram notify <project> off", () => {
  expect(parseCommand("/mute squadrant")).toEqual({ kind: "ok", name: "mute", argv: ["telegram", "notify", "squadrant", "off"] });
});

it("/mute with no project → usage", () => {
  expect(parseCommand("/mute")).toEqual({ kind: "usage", name: "mute", message: "usage: /mute <project>" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/telegram/commands.test.ts`
Expected: FAIL — `/mute`/`/unmute` return `unknown`.

- [ ] **Step 3: Implement the registry entries**

In `commands.ts`, add to `REGISTRY` (alongside the other entries):

```ts
mute: {
  usage: "/mute <project>",
  build: (a) => (a[0] ? ok("mute", ["telegram", "notify", a[0], "off"]) : usage("mute", "usage: /mute <project>")),
},
unmute: {
  usage: "/unmute <project>",
  build: (a) => (a[0] ? ok("unmute", ["telegram", "notify", a[0], "on"]) : usage("unmute", "usage: /unmute <project>")),
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/telegram/commands.test.ts`
Expected: PASS. `/help` now lists `/mute <project>` and `/unmute <project>` automatically (helpText derives from REGISTRY).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/telegram/commands.ts packages/core/src/telegram/commands.test.ts
git commit -m "feat(telegram): /mute /unmute <project> in General command registry"
```

---

### Task 6: Full build, suite, CHANGELOG, docs

**Files:**
- Modify: `CHANGELOG.md`
- Verify: whole repo build + test

- [ ] **Step 1: Clean build**

Run: `pnpm build`
Expected: build succeeds; `dist/index.js` + `dist/squadrantd.js` emitted.

- [ ] **Step 2: Smoke-test the CLI surface**

Run: `node dist/index.js telegram notify --status`
Expected: prints linked-project notify states (or "no projects linked") — no crash.

- [ ] **Step 3: Full test suite once**

Run: `npx vitest run`
Expected: PASS (no regressions; new tests included). Run ONCE — do not loop the suite.

- [ ] **Step 4: CHANGELOG entry (behavior change)**

Add under the next unreleased heading in `CHANGELOG.md`:

```markdown
### Changed
- **Telegram notifications are now per-project and muted by default.** Lifecycle events (crew done/blocked/idle) are delivered to a project's topic only after you engage that project — by sending any message into its topic, by `/unmute` (Telegram, requires remoteControl), or by `squadrant telegram notify <project> on`. This changes prior behavior where every project pushed all lifecycle events. Mute again with `/mute <project>` or `squadrant telegram notify <project> off`. Command replies and the General command channel are unaffected.
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(telegram): changelog for per-project notification gate"
```

---

## Self-Review

**Spec coverage:**
- State / `notify` field + helpers → Task 1 ✓
- Outbound gate (muted = no send) → Task 3 ✓
- Auto-unmute on inbound (remoteControl-independent) → Task 4 ✓
- Sticky lifetime (no timers) → inherent (on-disk flag, no expiry) ✓
- Telegram in-topic `/mute`·`/unmute` (fail-closed) → Task 4 ✓
- Telegram General `/mute <project>`·`/unmute <project>` → Task 5 ✓
- CLI `notify <project> on|off` + `--status` → Task 2 ✓
- Backward-compat CHANGELOG note → Task 6 ✓
- Replies/General channel never gated → preserved (gate only in `deliverOutbound`) ✓

**Type consistency:** `isNotifyActive`/`setNotify`/`notify` field used identically across Tasks 1–4; registry argv `["telegram","notify",<project>,"on|off"]` (Task 5) matches the CLI subcommand signature `<project> <on|off>` (Task 2). ✓

**Placeholder scan:** test-harness identifiers in Tasks 3–4 (`deliverInbound`, `flush`, `CHAT_ID`, `USER_ID`, `fakeClient`, `appendCaptainMessage`, `sendReply`) are explicitly flagged as placeholders to map onto the existing `bridge.test.ts` harness — not invented production symbols. All production code is shown in full.
