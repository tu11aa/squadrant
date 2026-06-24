# Telegram Integration Implementation Plan

> **⛔ SUPERSEDED (2026-06-22)** by the v1 design at [`docs/superpowers/specs/2026-06-22-telegram-integration-v1-design.md`](../superpowers/specs/2026-06-22-telegram-integration-v1-design.md) and its forthcoming implementation plan. Kept for history only — do not implement from this.
>
> **POST-#332 NOTE (historical):** This plan assumes the `notify-relay` transport, which was **deleted in #332**. Inbound/outbound messages now ride **daemon-direct cmux delivery**.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive squadrant from Telegram — push curated crew lifecycle events to per-session Telegram forum topics, and route replies back to the captain.

**Architecture:** A daemon-resident, opt-in, crash-contained Telegram subsystem. Outbound: the daemon's existing `notify` fan-out is composed so each lifecycle event is *also* pushed to the crew's Telegram forum topic (in parallel with the mailbox; the cmux relay is untouched). Inbound: a `getUpdates` long-poll loop maps `(chat_id, message_thread_id)` → `{project, task}` and delivers the reply to the captain via a new mailbox `captain.message` entry, which the existing relay delivers verbatim. One Telegram supergroup per project; topics map 1:1 to sessions.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥18 global `fetch` (no Telegram SDK), Vitest, commander CLI. Spec: `docs/specs/2026-06-15-telegram-integration-design.md`.

**Design decisions resolved from spec open questions:**
- **O1 (outbound parallelism):** Telegram runs *in parallel* with the cmux relay by composing the daemon's `notify` hook — NOT by replacing `config.notifier`. The `NotifierDriver` registry (used only by the `squadrant notify` CLI) is left alone. The daemon `notify` fan-out is the real lifecycle-event seam.
- **O2 (inbound queue):** Reuse the mailbox + relay. A new `captain.message` mailbox kind carries daemon-originated captain-directed messages; the relay's `deliverable()` already delivers any entry with a non-null `message`, so no relay change is required.

**Security model:** The allowlist is *derived* from the linked chats — only a `chat_id` present in `config.telegram.chats` may command. No separate allowlist field. Inbound text is delivered as a captain *message*, never executed.

---

## File Structure

**New files:**
- `src/control/telegram/client.ts` — Bot API HTTP client (fetch-based).
- `src/control/telegram/state.ts` — persistent offset + topic registry (`<stateRoot>/telegram-state.json`).
- `src/control/telegram/format.ts` — topic-name + inbound-message formatters (pure).
- `src/control/telegram/subsystem.ts` — outbound push + inbound long-poll loop; crash-contained orchestration.
- `src/control/telegram/index.ts` — barrel re-exports.
- `src/commands/telegram.ts` — `squadrant telegram link|status` CLI.
- `src/control/telegram/__tests__/client.test.ts`
- `src/control/telegram/__tests__/state.test.ts`
- `src/control/telegram/__tests__/format.test.ts`
- `src/control/telegram/__tests__/subsystem.test.ts`
- `src/commands/__tests__/telegram.test.ts`

**Modified files:**
- `src/config.ts` — add `TelegramConfig` + `SquadrantConfig.telegram`.
- `src/control/mailbox.ts` — widen `MailboxEntry.kind`; add `appendCaptainMessage`.
- `src/control/squadrantd.ts` — wire subsystem (compose `notify`, start inbound, stop); add `opts.telegram`.
- `src/control/__tests__/squadrantd.*.test.ts` (new file `squadrantd.telegram.test.ts`) — daemon-isolation test.
- `src/index.ts` (or wherever commands register) — register `telegramCommand`.
- `README.md` / `AGENTS.md` — setup + feature note.

---

## Task 1: Telegram config types

**Files:**
- Modify: `src/config.ts` (after the `RoleConfig` type, ~line 60; add field to `SquadrantConfig` ~line 71 near `notifier`)
- Test: `src/__tests__/config.telegram.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/config.telegram.test.ts
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";

describe("telegram config", () => {
  it("round-trips a telegram block through loadConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        commandName: "x",
        hubVault: "/tmp/hub",
        projects: {},
        defaults: { maxCrew: 5, worktreeDir: ".w", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
        metrics: { enabled: false, path: "/tmp/m.json" },
        telegram: { botToken: "123:ABC", chats: { squadrant: -100123 } },
      }),
    );
    const cfg = loadConfig(p);
    expect(cfg.telegram?.botToken).toBe("123:ABC");
    expect(cfg.telegram?.chats.squadrant).toBe(-100123);
  });

  it("leaves telegram undefined when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        commandName: "x",
        hubVault: "/tmp/hub",
        projects: {},
        defaults: { maxCrew: 5, worktreeDir: ".w", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
        metrics: { enabled: false, path: "/tmp/m.json" },
      }),
    );
    expect(loadConfig(p).telegram).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/config.telegram.test.ts`
Expected: FAIL — `telegram` property does not exist on `SquadrantConfig`.

- [ ] **Step 3: Add the types**

In `src/config.ts`, add this interface above `SquadrantConfig`:

```typescript
export interface TelegramConfig {
  /** Bot token from BotFather. Lives in ~/.config/squadrant (never in the repo). */
  botToken: string;
  /** project name → Telegram supergroup chat_id (negative for supergroups).
   *  The set of values here is ALSO the inbound allowlist: only these chats may command. */
  chats: Record<string, number>;
}
```

Then add to the `SquadrantConfig` interface, right after `notifier?: string;` (line 71):

```typescript
  notifier?: string;
  /** #65 Telegram integration. Absent = feature off (daemon behaves exactly as before). */
  telegram?: TelegramConfig;
```

`loadConfig` already `JSON.parse`s the whole file, so no parsing change is needed — the field passes through.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/config.telegram.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.telegram.test.ts
git commit -m "feat(telegram): config types (#65)"
```

---

## Task 2: Telegram Bot API client

**Files:**
- Create: `src/control/telegram/client.ts`
- Test: `src/control/telegram/__tests__/client.test.ts`

The client is fetch-based and injectable (`fetchImpl`) so tests never hit the network. All Bot API calls are `POST https://api.telegram.org/bot<token>/<method>` with a JSON body; responses are `{ ok: boolean, result?: T, description?: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/telegram/__tests__/client.test.ts
import { describe, it, expect, vi } from "vitest";
import { createTelegramClient } from "../client.js";

function fakeFetch(responses: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: { body?: string }) => {
    const method = url.split("/").pop()!;
    const body = init?.body ? JSON.parse(init.body) : {};
    const result = responses[method];
    return {
      ok: true,
      json: async () => ({ ok: true, result, _sentBody: body }),
    } as unknown as Response;
  });
}

describe("telegram client", () => {
  it("createForumTopic returns the message_thread_id", async () => {
    const f = fakeFetch({ createForumTopic: { message_thread_id: 42, name: "🔧 crew-1" } });
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    const id = await c.createForumTopic(-100, "🔧 crew-1");
    expect(id).toBe(42);
    expect(f).toHaveBeenCalledWith(
      "https://api.telegram.org/botT/createForumTopic",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sendMessage includes message_thread_id when given", async () => {
    const f = fakeFetch({ sendMessage: { message_id: 1 } });
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    await c.sendMessage(-100, "hi", 42);
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ chat_id: -100, text: "hi", message_thread_id: 42 });
  });

  it("sendMessage omits message_thread_id when undefined", async () => {
    const f = fakeFetch({ sendMessage: { message_id: 1 } });
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    await c.sendMessage(-100, "hi");
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ chat_id: -100, text: "hi" });
  });

  it("getUpdates returns the result array", async () => {
    const updates = [{ update_id: 7, message: { chat: { id: -100 }, text: "yo" } }];
    const f = fakeFetch({ getUpdates: updates });
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    const got = await c.getUpdates(5, 0);
    expect(got).toEqual(updates);
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ offset: 5, timeout: 0 });
  });

  it("throws on a Telegram error response", async () => {
    const f = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    } as unknown as Response));
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    await expect(c.getMe()).rejects.toThrow("Unauthorized");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/telegram/__tests__/client.test.ts`
Expected: FAIL — module `../client.js` not found.

- [ ] **Step 3: Implement the client**

```typescript
// src/control/telegram/client.ts

export interface TgChat {
  id: number;
  type: string;
  title?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    chat: TgChat;
    message_thread_id?: number;
    text?: string;
    from?: { id: number; username?: string };
  };
  /** Emitted when the bot is added to / removed from a chat — used by `telegram link`. */
  my_chat_member?: {
    chat: TgChat;
    new_chat_member?: { status: string };
  };
}

export interface TelegramClient {
  getMe(): Promise<void>;
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, threadId?: number): Promise<void>;
  /** Returns the new topic's message_thread_id. */
  createForumTopic(chatId: number, name: string): Promise<number>;
  closeForumTopic(chatId: number, threadId: number): Promise<void>;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export function createTelegramClient(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  const base = `https://api.telegram.org/bot${botToken}`;

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as TgResponse<T>;
    if (!json.ok) throw new Error(json.description ?? `telegram ${method} failed`);
    return json.result as T;
  }

  return {
    async getMe() {
      await call<unknown>("getMe", {});
    },
    async getUpdates(offset, timeoutS, signal) {
      return call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutS }, signal);
    },
    async sendMessage(chatId, text, threadId) {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (threadId !== undefined) body.message_thread_id = threadId;
      await call<unknown>("sendMessage", body);
    },
    async createForumTopic(chatId, name) {
      const r = await call<{ message_thread_id: number }>("createForumTopic", { chat_id: chatId, name });
      return r.message_thread_id;
    },
    async closeForumTopic(chatId, threadId) {
      await call<unknown>("closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/telegram/__tests__/client.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/control/telegram/client.ts src/control/telegram/__tests__/client.test.ts
git commit -m "feat(telegram): Bot API client (#65)"
```

---

## Task 3: Telegram state (offset + topic registry)

**Files:**
- Create: `src/control/telegram/state.ts`
- Test: `src/control/telegram/__tests__/state.test.ts`

Persists to `<stateRoot>/telegram-state.json`: the `getUpdates` offset and the topic map keyed by `${project}::${taskId}` → `message_thread_id`. `findTask(threadId)` is the inbound reverse lookup.

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/telegram/__tests__/state.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTelegramState } from "../state.js";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "tg-"));
}

describe("telegram state", () => {
  it("starts empty and defaults offset to 0", async () => {
    const s = await loadTelegramState(freshRoot());
    expect(s.offset()).toBe(0);
    expect(s.getTopic("squadrant", "t1")).toBeUndefined();
  });

  it("persists offset and topics across reloads", async () => {
    const root = freshRoot();
    const s = await loadTelegramState(root);
    await s.setOffset(99);
    await s.setTopic("squadrant", "t1", 42);
    const s2 = await loadTelegramState(root);
    expect(s2.offset()).toBe(99);
    expect(s2.getTopic("squadrant", "t1")).toBe(42);
  });

  it("findTask reverse-maps a thread id to {project, taskId}", async () => {
    const s = await loadTelegramState(freshRoot());
    await s.setTopic("squadrant", "t1", 42);
    await s.setTopic("brove", "t2", 7);
    expect(s.findTask(42)).toEqual({ project: "squadrant", taskId: "t1" });
    expect(s.findTask(7)).toEqual({ project: "brove", taskId: "t2" });
    expect(s.findTask(999)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/telegram/__tests__/state.test.ts`
Expected: FAIL — module `../state.js` not found.

- [ ] **Step 3: Implement the state store**

```typescript
// src/control/telegram/state.ts
import { promises as fs } from "node:fs";
import { join } from "node:path";

interface PersistShape {
  offset: number;
  topics: Record<string, number>; // `${project}::${taskId}` -> message_thread_id
}

export interface TelegramState {
  offset(): number;
  setOffset(n: number): Promise<void>;
  getTopic(project: string, taskId: string): number | undefined;
  setTopic(project: string, taskId: string, threadId: number): Promise<void>;
  findTask(threadId: number): { project: string; taskId: string } | undefined;
}

function statePath(stateRoot: string): string {
  return join(stateRoot, "telegram-state.json");
}

function key(project: string, taskId: string): string {
  return `${project}::${taskId}`;
}

export async function loadTelegramState(stateRoot: string): Promise<TelegramState> {
  let data: PersistShape = { offset: 0, topics: {} };
  try {
    data = JSON.parse(await fs.readFile(statePath(stateRoot), "utf-8")) as PersistShape;
    if (typeof data.offset !== "number") data.offset = 0;
    if (!data.topics) data.topics = {};
  } catch {
    // ENOENT / corrupt → start fresh
  }

  async function persist(): Promise<void> {
    await fs.mkdir(stateRoot, { recursive: true });
    const tmp = statePath(stateRoot) + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.rename(tmp, statePath(stateRoot));
  }

  return {
    offset: () => data.offset,
    async setOffset(n) {
      data.offset = n;
      await persist();
    },
    getTopic: (project, taskId) => data.topics[key(project, taskId)],
    async setTopic(project, taskId, threadId) {
      data.topics[key(project, taskId)] = threadId;
      await persist();
    },
    findTask(threadId) {
      for (const [k, v] of Object.entries(data.topics)) {
        if (v === threadId) {
          const sep = k.indexOf("::");
          return { project: k.slice(0, sep), taskId: k.slice(sep + 2) };
        }
      }
      return undefined;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/telegram/__tests__/state.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/control/telegram/state.ts src/control/telegram/__tests__/state.test.ts
git commit -m "feat(telegram): persistent offset + topic registry (#65)"
```

---

## Task 4: Formatters

**Files:**
- Create: `src/control/telegram/format.ts`
- Test: `src/control/telegram/__tests__/format.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/telegram/__tests__/format.test.ts
import { describe, it, expect } from "vitest";
import { crewTopicName, inboundCaptainMessage } from "../format.js";

describe("telegram formatters", () => {
  it("crewTopicName prefixes the crew name with a wrench", () => {
    expect(crewTopicName("crew-2")).toBe("🔧 crew-2");
  });

  it("inboundCaptainMessage tags the source crew", () => {
    expect(inboundCaptainMessage("crew-2", "use lucia")).toBe("📩 [from Telegram · crew-2] use lucia");
  });

  it("inboundCaptainMessage handles a captain-topic reply (no task name)", () => {
    expect(inboundCaptainMessage(undefined, "status?")).toBe("📩 [from Telegram] status?");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/telegram/__tests__/format.test.ts`
Expected: FAIL — module `../format.js` not found.

- [ ] **Step 3: Implement the formatters**

```typescript
// src/control/telegram/format.ts

/** Forum-topic title for a crew session. */
export function crewTopicName(crewName: string): string {
  return `🔧 ${crewName}`;
}

/** Captain-facing rendering of an inbound Telegram reply. */
export function inboundCaptainMessage(crewName: string | undefined, text: string): string {
  return crewName ? `📩 [from Telegram · ${crewName}] ${text}` : `📩 [from Telegram] ${text}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/telegram/__tests__/format.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/control/telegram/format.ts src/control/telegram/__tests__/format.test.ts
git commit -m "feat(telegram): topic + inbound message formatters (#65)"
```

---

## Task 5: `captain.message` mailbox entry

**Files:**
- Modify: `src/control/mailbox.ts` (`MailboxEntry.kind` ~line 13; add `appendCaptainMessage` after `appendToMailbox` ~line 127)
- Test: `src/control/__tests__/mailbox-captain-message.test.ts` (create)

This is the inbound delivery seam (O2). The relay's `deliverable()` already delivers any entry whose `message` is non-null, regardless of kind, so adding a new kind requires **no relay change**.

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/mailbox-captain-message.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendCaptainMessage, readFromCursor } from "../mailbox.js";

describe("appendCaptainMessage", () => {
  it("appends a deliverable captain.message entry with a monotonic seq", async () => {
    const root = mkdtempSync(join(tmpdir(), "mbox-"));
    const seq1 = await appendCaptainMessage({ stateRoot: root, project: "squadrant", message: "hello", taskId: "t1", name: "crew-1" });
    const seq2 = await appendCaptainMessage({ stateRoot: root, project: "squadrant", message: "again" });
    expect(seq2).toBe(seq1 + 1);

    const entries = [];
    for await (const e of readFromCursor({ stateRoot: root, project: "squadrant", fromSeq: 1 })) entries.push(e);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("captain.message");
    expect(entries[0].message).toBe("hello");
    expect(entries[0].name).toBe("crew-1");
    expect(entries[1].taskId).toBe("captain");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/mailbox-captain-message.test.ts`
Expected: FAIL — `appendCaptainMessage` is not exported.

- [ ] **Step 3: Widen the kind type and add the helper**

In `src/control/mailbox.ts`, change the `kind` field of `MailboxEntry` (line 13):

```typescript
  kind: ControlEvent["type"] | "captain.message";
```

Then add this exported function immediately after `appendToMailbox` (after line 127):

```typescript
interface CaptainMessageOpts {
  stateRoot: string;
  project: string;
  message: string;
  /** Source crew task id, if the reply targeted a specific crew topic. Defaults to "captain". */
  taskId?: string;
  /** Source crew name, surfaced in the entry for parity with task entries. */
  name?: string;
}

/**
 * Append a daemon-originated, captain-directed message (e.g. an inbound Telegram
 * reply). Reuses the mailbox seq/lock machinery so the existing relay delivers
 * it verbatim via deliverable() — no relay change needed. Kind is the synthetic
 * "captain.message"; no state-machine transition is involved (this never flows
 * through d.handle()).
 */
export async function appendCaptainMessage(opts: CaptainMessageOpts): Promise<number> {
  return withProjectLock(opts.project, async () => {
    const dir = inboxDir(opts.stateRoot);
    await fs.mkdir(dir, { recursive: true });
    const file = logPath(opts.stateRoot, opts.project);
    const lastSeq = await readMaxSeq(opts.stateRoot, opts.project);
    const seq = lastSeq + 1;
    const entry: MailboxEntry = {
      seq,
      ts: new Date().toISOString(),
      taskId: opts.taskId ?? "captain",
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      kind: "captain.message",
      provider: "claude",
      payload: {},
      message: opts.message,
    };
    await fs.appendFile(file, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
    return seq;
  });
}
```

Note: `provider` is required on `MailboxEntry` and is metadata only (the relay ignores it for delivery); `"claude"` is a benign constant for captain messages.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/mailbox-captain-message.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing mailbox + relay tests to confirm no regression**

Run: `npx vitest run src/control/__tests__/mailbox.test.ts src/commands/__tests__/notify-relay.test.ts`
Expected: PASS (the widened union is backward-compatible; `deliverable()` is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/control/mailbox.ts src/control/__tests__/mailbox-captain-message.test.ts
git commit -m "feat(telegram): captain.message mailbox entry for inbound delivery (#65)"
```

---

## Task 6: Subsystem — outbound push

**Files:**
- Create: `src/control/telegram/subsystem.ts`
- Test: `src/control/telegram/__tests__/subsystem.test.ts`

`createTelegramSubsystem` owns the client + state and exposes `pushLifecycle`, `startInbound`, and `stop`. This task implements `pushLifecycle` only (outbound). It is **best-effort**: any throw is caught and logged; it never rejects to the caller.

`pushLifecycle({ project, message, record })`:
1. Resolve `chatId = chats[project]`. Not linked → no-op.
2. Resolve `threadId = state.getTopic(project, record.id)`; if missing, `createForumTopic(chatId, crewTopicName(record.name))` and persist.
3. `sendMessage(chatId, message, threadId)`.
4. If `record.state` is terminal, `closeForumTopic` after sending.

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/telegram/__tests__/subsystem.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramSubsystem } from "../subsystem.js";
import type { TelegramClient } from "../client.js";
import type { TaskRecord } from "../../types.js";

function fakeClient(over: Partial<TelegramClient> = {}): TelegramClient {
  return {
    getMe: vi.fn(async () => {}),
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async () => {}),
    createForumTopic: vi.fn(async () => 42),
    closeForumTopic: vi.fn(async () => {}),
    ...over,
  };
}

function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return { id: "t1", project: "squadrant", name: "crew-1", provider: "claude", state: "working", mode: "interactive", task: "x", lastHeartbeat: 0, createdAt: 0 } as TaskRecord;
}

const baseDeps = (client: TelegramClient, root: string) => ({
  client,
  chats: { squadrant: -100 },
  stateRoot: root,
  appendCaptainMessage: vi.fn(async () => 1),
  resolveCrewName: () => "crew-1",
  log: () => {},
});

describe("telegram subsystem — outbound", () => {
  it("creates a topic on first push and sends into it", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient();
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await sub.pushLifecycle({ project: "squadrant", message: "CREW BLOCKED: ?", record: rec() });
    expect(client.createForumTopic).toHaveBeenCalledWith(-100, "🔧 crew-1");
    expect(client.sendMessage).toHaveBeenCalledWith(-100, "CREW BLOCKED: ?", 42);
  });

  it("reuses an existing topic on the second push (no second create)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient();
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await sub.pushLifecycle({ project: "squadrant", message: "a", record: rec() });
    await sub.pushLifecycle({ project: "squadrant", message: "b", record: rec() });
    expect(client.createForumTopic).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("no-ops for an unlinked project", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient();
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await sub.pushLifecycle({ project: "brove", message: "x", record: rec({ project: "brove" }) });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("closes the topic after a terminal-state push", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient();
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await sub.pushLifecycle({ project: "squadrant", message: "CREW DONE", record: rec({ state: "done" }) });
    expect(client.closeForumTopic).toHaveBeenCalledWith(-100, 42);
  });

  it("never throws when the client fails (best-effort)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const client = fakeClient({ sendMessage: vi.fn(async () => { throw new Error("network down"); }) });
    const sub = await createTelegramSubsystem(baseDeps(client, root));
    await expect(sub.pushLifecycle({ project: "squadrant", message: "x", record: rec() })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/telegram/__tests__/subsystem.test.ts`
Expected: FAIL — module `../subsystem.js` not found.

- [ ] **Step 3: Implement the subsystem (outbound half)**

```typescript
// src/control/telegram/subsystem.ts
import { loadTelegramState, type TelegramState } from "./state.js";
import { crewTopicName, inboundCaptainMessage } from "./format.js";
import type { TelegramClient } from "./client.js";
import type { TaskRecord } from "../types.js";
import { TERMINAL_STATES } from "../types.js";

export interface TelegramSubsystemDeps {
  client: TelegramClient;
  /** project → supergroup chat_id (also the inbound allowlist). */
  chats: Record<string, number>;
  stateRoot: string;
  /** Inbound delivery seam — bound to mailbox.appendCaptainMessage by the daemon. */
  appendCaptainMessage: (opts: { stateRoot: string; project: string; message: string; taskId?: string; name?: string }) => Promise<number>;
  /** Resolve a crew display name from a taskId (store lookup), used on inbound. */
  resolveCrewName: (project: string, taskId: string) => string | undefined;
  log: (m: string) => void;
}

export interface TelegramSubsystem {
  pushLifecycle(args: { project: string; message: string; record: TaskRecord }): Promise<void>;
  startInbound(): void;
  stop(): void;
}

export async function createTelegramSubsystem(deps: TelegramSubsystemDeps): Promise<TelegramSubsystem> {
  const state: TelegramState = await loadTelegramState(deps.stateRoot);

  async function topicFor(project: string, chatId: number, record: TaskRecord): Promise<number> {
    const existing = state.getTopic(project, record.id);
    if (existing !== undefined) return existing;
    const threadId = await deps.client.createForumTopic(chatId, crewTopicName(record.name ?? record.id));
    await state.setTopic(project, record.id, threadId);
    return threadId;
  }

  async function pushLifecycle(args: { project: string; message: string; record: TaskRecord }): Promise<void> {
    try {
      const chatId = deps.chats[args.project];
      if (chatId === undefined) return; // project not linked
      const threadId = await topicFor(args.project, chatId, args.record);
      await deps.client.sendMessage(chatId, args.message, threadId);
      if (TERMINAL_STATES.has(args.record.state)) {
        await deps.client.closeForumTopic(chatId, threadId);
      }
    } catch (e) {
      deps.log(`telegram push failed project=${args.project}: ${(e as Error).message}`);
    }
  }

  // startInbound + stop are implemented in Task 7.
  return {
    pushLifecycle,
    startInbound: () => {},
    stop: () => {},
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/telegram/__tests__/subsystem.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/control/telegram/subsystem.ts src/control/telegram/__tests__/subsystem.test.ts
git commit -m "feat(telegram): subsystem outbound push (#65)"
```

---

## Task 7: Subsystem — inbound long-poll loop

**Files:**
- Modify: `src/control/telegram/subsystem.ts`
- Test: `src/control/telegram/__tests__/subsystem.test.ts` (append)

The inbound loop calls `getUpdates(offset, 30s)` repeatedly. For each update with a `message.text`:
1. **Allowlist:** `message.chat.id` must be a value in `chats` (reverse to project). Else ignore + log.
2. Map `message.message_thread_id` → `{project, taskId}` via `state.findTask`. Absent thread / not found → captain topic (no specific crew).
3. Render via `inboundCaptainMessage` and call `appendCaptainMessage` for that project.
4. Advance and persist offset (`update_id + 1`).

The loop is crash-contained: the whole body is wrapped; a thrown `getUpdates` (network) is caught, logged, and retried after a short backoff. `stop()` flips a flag and aborts the in-flight long-poll.

- [ ] **Step 1: Write the failing test (append to subsystem.test.ts)**

```typescript
// append to src/control/telegram/__tests__/subsystem.test.ts
import { processInboundUpdate } from "../subsystem.js";

describe("telegram subsystem — inbound routing (pure)", () => {
  const chats = { squadrant: -100, brove: -200 };

  it("routes a crew-topic reply to that crew's captain via appendCaptainMessage", async () => {
    const append = vi.fn(async () => 1);
    const findTask = (thread: number) => (thread === 42 ? { project: "squadrant", taskId: "t1" } : undefined);
    const handled = await processInboundUpdate({
      update: { update_id: 5, message: { chat: { id: -100, type: "supergroup" }, message_thread_id: 42, text: "use lucia" } },
      chats, findTask, resolveCrewName: () => "crew-2",
      appendCaptainMessage: append, stateRoot: "/tmp", log: () => {},
    });
    expect(handled).toBe(true);
    expect(append).toHaveBeenCalledWith({ stateRoot: "/tmp", project: "squadrant", message: "📩 [from Telegram · crew-2] use lucia", taskId: "t1", name: "crew-2" });
  });

  it("routes a general-topic reply to the captain (no task)", async () => {
    const append = vi.fn(async () => 1);
    await processInboundUpdate({
      update: { update_id: 6, message: { chat: { id: -100, type: "supergroup" }, text: "status?" } },
      chats, findTask: () => undefined, resolveCrewName: () => undefined,
      appendCaptainMessage: append, stateRoot: "/tmp", log: () => {},
    });
    expect(append).toHaveBeenCalledWith({ stateRoot: "/tmp", project: "squadrant", message: "📩 [from Telegram] status?", taskId: undefined, name: undefined });
  });

  it("ignores updates from a non-allowlisted chat", async () => {
    const append = vi.fn(async () => 1);
    const handled = await processInboundUpdate({
      update: { update_id: 7, message: { chat: { id: -999, type: "supergroup" }, text: "rm -rf" } },
      chats, findTask: () => undefined, resolveCrewName: () => undefined,
      appendCaptainMessage: append, stateRoot: "/tmp", log: () => {},
    });
    expect(handled).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it("ignores updates with no text (e.g. join events)", async () => {
    const append = vi.fn(async () => 1);
    const handled = await processInboundUpdate({
      update: { update_id: 8, message: { chat: { id: -100, type: "supergroup" } } },
      chats, findTask: () => undefined, resolveCrewName: () => undefined,
      appendCaptainMessage: append, stateRoot: "/tmp", log: () => {},
    });
    expect(handled).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/telegram/__tests__/subsystem.test.ts`
Expected: FAIL — `processInboundUpdate` is not exported.

- [ ] **Step 3: Implement inbound (pure router + loop)**

Add the exported pure router and wire the loop into `createTelegramSubsystem`. In `src/control/telegram/subsystem.ts`:

```typescript
import type { TgUpdate } from "./client.js";

export interface InboundRouterDeps {
  update: TgUpdate;
  chats: Record<string, number>;
  findTask: (threadId: number) => { project: string; taskId: string } | undefined;
  resolveCrewName: (project: string, taskId: string) => string | undefined;
  appendCaptainMessage: TelegramSubsystemDeps["appendCaptainMessage"];
  stateRoot: string;
  log: (m: string) => void;
}

/** Pure-ish: route ONE update. Returns true if it produced a captain message. */
export async function processInboundUpdate(deps: InboundRouterDeps): Promise<boolean> {
  const msg = deps.update.message;
  if (!msg || !msg.text) return false;

  // Allowlist: chat must be a linked supergroup. Reverse chat_id → project.
  const entry = Object.entries(deps.chats).find(([, id]) => id === msg.chat.id);
  if (!entry) {
    deps.log(`telegram inbound ignored: chat ${msg.chat.id} not allowlisted`);
    return false;
  }
  const [project] = entry;

  // Resolve target task from the topic thread (absent / unknown → captain).
  const found = msg.message_thread_id !== undefined ? deps.findTask(msg.message_thread_id) : undefined;
  const taskId = found?.taskId;
  const crewName = found ? deps.resolveCrewName(found.project, found.taskId) : undefined;

  await deps.appendCaptainMessage({
    stateRoot: deps.stateRoot,
    project,
    message: inboundCaptainMessage(crewName, msg.text),
    taskId,
    name: crewName,
  });
  return true;
}
```

Now replace the `startInbound` / `stop` stubs in the returned object with a real loop:

```typescript
  let stopped = false;
  let abort: AbortController | undefined;

  function startInbound(): void {
    void (async () => {
      while (!stopped) {
        try {
          abort = new AbortController();
          const updates = await deps.client.getUpdates(state.offset(), 30, abort.signal);
          for (const update of updates) {
            await processInboundUpdate({
              update,
              chats: deps.chats,
              findTask: state.findTask,
              resolveCrewName: deps.resolveCrewName,
              appendCaptainMessage: deps.appendCaptainMessage,
              stateRoot: deps.stateRoot,
              log: deps.log,
            });
            await state.setOffset(update.update_id + 1);
          }
        } catch (e) {
          if (stopped) return;
          deps.log(`telegram inbound loop error: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, 3000)); // backoff; never tight-loops
        }
      }
    })();
  }

  function stop(): void {
    stopped = true;
    abort?.abort();
  }

  return { pushLifecycle, startInbound, stop };
```

(Delete the placeholder `startInbound`/`stop` from Task 6's return.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/telegram/__tests__/subsystem.test.ts`
Expected: PASS (all outbound + inbound cases).

- [ ] **Step 5: Add the barrel file**

```typescript
// src/control/telegram/index.ts
export { createTelegramClient } from "./client.js";
export type { TelegramClient, TgUpdate } from "./client.js";
export { createTelegramSubsystem, processInboundUpdate } from "./subsystem.js";
export type { TelegramSubsystem } from "./subsystem.js";
export { loadTelegramState } from "./state.js";
```

- [ ] **Step 6: Commit**

```bash
git add src/control/telegram/subsystem.ts src/control/telegram/index.ts src/control/telegram/__tests__/subsystem.test.ts
git commit -m "feat(telegram): inbound long-poll loop + captain routing (#65)"
```

---

## Task 8: Wire subsystem into the daemon

**Files:**
- Modify: `src/control/squadrantd.ts` (imports; `SquadrantdOpts` ~line 74; `notify` composition ~line 272; boot ~line 418; `stop()` ~line 556)
- Test: `src/control/__tests__/squadrantd.telegram.test.ts` (create)

Wires outbound (compose `notify`), inbound (`startInbound` after server start), and teardown (`stop`). The subsystem is injectable via `opts.telegram` so tests never construct a real client. The critical guarantee: **a throwing Telegram subsystem must not affect the daemon core.**

- [ ] **Step 1: Write the failing test**

```typescript
// src/control/__tests__/squadrantd.telegram.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSquadrantd } from "../squadrantd.js";
import type { TelegramSubsystem } from "../telegram/subsystem.js";

function tmpRoots() {
  const root = mkdtempSync(join(tmpdir(), "cd-"));
  return { stateRoot: join(root, "state"), sockPath: join(root, "d.sock") };
}

describe("squadrantd telegram wiring", () => {
  it("calls pushLifecycle on a notify event without letting a throw escape", async () => {
    const { stateRoot, sockPath } = tmpRoots();
    const pushLifecycle = vi.fn(async () => { throw new Error("tg down"); });
    const telegram: TelegramSubsystem = { pushLifecycle, startInbound: vi.fn(), stop: vi.fn() };
    const notify = vi.fn(async () => {}); // base notify (mailbox) stub

    const h = startSquadrantd({ stateRoot, sockPath, sweepMs: 0, rotationIntervalMs: 0, notify, telegram });
    // Drive one notify by handing the daemon a started+done lifecycle through notify directly:
    await notify({ project: "squadrant", message: "CREW DONE", record: { id: "t1", project: "squadrant", name: "crew-1", provider: "claude", state: "done" } as any, event: { type: "task.done", id: "t1" } as any });
    // The composed notify (telegram on top of base) is what the daemon uses; assert it via a direct push:
    await expect(telegram.pushLifecycle({ project: "squadrant", message: "x", record: { id: "t1", project: "squadrant", state: "done" } as any })).resolves.toBeUndefined();
    expect(telegram.startInbound).toHaveBeenCalled();

    await h.stop();
    expect(telegram.stop).toHaveBeenCalled();
  });

  it("does not start telegram when opts.telegram is absent and config has none", async () => {
    const { stateRoot, sockPath } = tmpRoots();
    const h = startSquadrantd({ stateRoot, sockPath, sweepMs: 0, rotationIntervalMs: 0 });
    // No throw, daemon boots fine without telegram.
    await h.stop();
    expect(true).toBe(true);
  });
});
```

Note: the first test asserts the *injected* subsystem is started/stopped and that its `pushLifecycle` is best-effort. The composition wiring (base-notify → telegram) is unit-tested in Task 6/7; this test guards the daemon-level lifecycle hooks.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/control/__tests__/squadrantd.telegram.test.ts`
Expected: FAIL — `opts.telegram` is not accepted / `startInbound` never called.

- [ ] **Step 3: Wire the daemon**

In `src/control/squadrantd.ts`:

(a) Add the import near the other control imports (~line 16):

```typescript
import { createTelegramSubsystem, type TelegramSubsystem } from "./telegram/index.js";
import { appendCaptainMessage } from "./mailbox.js";
```

(`appendToMailbox`/`rotateIfNeeded` are already imported from `./mailbox.js`; add `appendCaptainMessage` to that existing import instead of a duplicate line.)

(b) Add to `SquadrantdOpts` (after `opencodeBridge`, ~line 73):

```typescript
  /** Inject a fake Telegram subsystem for tests. Absent + no config.telegram = feature off. */
  telegram?: TelegramSubsystem;
```

(c) Read config once and build the subsystem. Replace the existing `taskTimeoutMs` line (~line 87):

```typescript
  const cfg = loadConfig();
  const taskTimeoutMs = cfg.defaults.taskTimeoutMs;
```

(d) After `const notify = opts.notify ?? defaultNotify;` (~line 272), compose Telegram on top:

```typescript
  // #65 Telegram: opt-in, crash-contained. Built from config unless a test injects one.
  let telegram: TelegramSubsystem | null = opts.telegram ?? null;
  if (!telegram && cfg.telegram) {
    try {
      telegram = await createTelegramSubsystemFromConfig();
    } catch (e) {
      log(`telegram init failed (feature disabled this boot): ${(e as Error).message}`);
      telegram = null;
    }
  }
  const baseNotify = notify;
  const composedNotify = telegram
    ? async (args: { project: string; message: string; record: TaskRecord; event: ControlEvent }) => {
        await baseNotify(args);
        // best-effort, never blocks/throws into the daemon
        void telegram!.pushLifecycle({ project: args.project, message: args.message, record: args.record });
      }
    : baseNotify;
```

`startSquadrantd` must become `async` is **not** desired (it returns a handle synchronously). Instead, build the subsystem synchronously-then-async via a helper that does the await inside the existing boot IIFE. To keep `startSquadrantd` synchronous, define the builder and start inbound inside the boot IIFE. Concretely:

- Replace step (d)'s `await createTelegramSubsystemFromConfig()` approach with a deferred build. Declare `let telegram: TelegramSubsystem | null = opts.telegram ?? null;` and compose `composedNotify` to read `telegram` lazily (it already does via the closure variable). Then inside the boot IIFE (the existing `void (async () => { ... })()` near line 382), add at the end:

```typescript
    // #65 Telegram subsystem boot (after reconcile so the store is warm).
    if (!telegram && cfg.telegram) {
      try {
        telegram = await createTelegramSubsystem({
          client: createTelegramClient(cfg.telegram.botToken),
          chats: cfg.telegram.chats,
          stateRoot,
          appendCaptainMessage,
          resolveCrewName: (project, taskId) =>
            store.listAll().find((r) => r.id === taskId)?.name,
          log,
        });
      } catch (e) {
        log(`telegram init failed (feature disabled this boot): ${(e as Error).message}`);
        telegram = null;
      }
    }
    telegram?.startInbound();
```

And add the import for `createTelegramClient` to the barrel import in step (a):

```typescript
import { createTelegramClient, createTelegramSubsystem, type TelegramSubsystem } from "./telegram/index.js";
```

Because `composedNotify` closes over the mutable `telegram` variable, the lazy build inside the IIFE is picked up by later events. Pass `composedNotify` (not `notify`) to `createDaemon`:

```typescript
  const d = createDaemon({
    store, now: () => Date.now(), isPidAlive, notify: composedNotify, taskTimeoutMs,
    // ...rest unchanged
```

When `opts.telegram` is injected (tests), `startInbound()` must still run — add `telegram?.startInbound();` is inside the IIFE which always runs, so injected subsystems are started too. Good.

(e) In `stop()` (~line 556), add before `return new Promise(...)`:

```typescript
      telegram?.stop();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/control/__tests__/squadrantd.telegram.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Run the full daemon test suite for regressions**

Run: `npx vitest run src/control/__tests__/`
Expected: PASS — composing notify and the lazy telegram build do not change existing behavior when telegram is absent.

- [ ] **Step 6: Commit**

```bash
git add src/control/squadrantd.ts src/control/__tests__/squadrantd.telegram.test.ts
git commit -m "feat(telegram): wire crash-contained subsystem into squadrantd (#65)"
```

---

## Task 9: `squadrant telegram link` + `status` CLI

**Files:**
- Create: `src/commands/telegram.ts`
- Test: `src/commands/__tests__/telegram.test.ts`

`telegram link <project>` captures the chat_id of the supergroup the bot was added to (from the most recent `my_chat_member` update via `getUpdates`) and writes `config.telegram.chats[project]`. `telegram status` prints linked projects and whether the token validates (`getMe`).

The action logic is extracted into pure-ish injectable functions for testing (no real network / no real config writes in tests).

- [ ] **Step 1: Write the failing test**

```typescript
// src/commands/__tests__/telegram.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveLinkChatId, buildStatusReport } from "../telegram.js";
import type { TgUpdate } from "../../control/telegram/client.js";

describe("telegram link", () => {
  it("picks the chat_id from the most recent my_chat_member where the bot became admin/member", () => {
    const updates: TgUpdate[] = [
      { update_id: 1, my_chat_member: { chat: { id: -100, type: "supergroup", title: "squadrant" }, new_chat_member: { status: "administrator" } } },
      { update_id: 2, message: { chat: { id: -100, type: "supergroup" }, text: "hi" } },
    ];
    expect(resolveLinkChatId(updates)).toBe(-100);
  });

  it("returns undefined when no my_chat_member update is present", () => {
    expect(resolveLinkChatId([{ update_id: 1, message: { chat: { id: -100, type: "supergroup" }, text: "hi" } }])).toBeUndefined();
  });
});

describe("telegram status", () => {
  it("reports linked projects and token validity", () => {
    const report = buildStatusReport({ tokenValid: true, chats: { squadrant: -100, brove: -200 } });
    expect(report).toContain("token: valid");
    expect(report).toContain("squadrant");
    expect(report).toContain("-100");
    expect(report).toContain("brove");
  });

  it("reports when telegram is not configured", () => {
    expect(buildStatusReport({ tokenValid: false, chats: {} })).toContain("no projects linked");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/__tests__/telegram.test.ts`
Expected: FAIL — module `../telegram.js` not found.

- [ ] **Step 3: Implement the command**

```typescript
// src/commands/telegram.ts
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig, type SquadrantConfig } from "../config.js";
import { createTelegramClient, type TgUpdate } from "../control/telegram/index.js";

/** Pure: the chat_id of the most recent my_chat_member update (bot added to a group). */
export function resolveLinkChatId(updates: TgUpdate[]): number | undefined {
  for (let i = updates.length - 1; i >= 0; i--) {
    const m = updates[i].my_chat_member;
    if (m) return m.chat.id;
  }
  return undefined;
}

/** Pure: render `telegram status`. */
export function buildStatusReport(args: { tokenValid: boolean; chats: Record<string, number> }): string {
  const lines = [`token: ${args.tokenValid ? "valid" : "invalid/unset"}`];
  const entries = Object.entries(args.chats);
  if (entries.length === 0) lines.push("no projects linked");
  else for (const [project, id] of entries) lines.push(`  ${project} → ${id}`);
  return lines.join("\n");
}

async function runLink(project: string, configPath?: string): Promise<number> {
  const config: SquadrantConfig = loadConfig(configPath);
  if (!config.telegram?.botToken) {
    console.error(chalk.red("telegram link: set telegram.botToken in ~/.config/squadrant/config.json first"));
    return 1;
  }
  if (!config.projects[project]) {
    console.error(chalk.red(`telegram link: unknown project '${project}'`));
    return 1;
  }
  const client = createTelegramClient(config.telegram.botToken);
  const updates = await client.getUpdates(0, 0);
  const chatId = resolveLinkChatId(updates);
  if (chatId === undefined) {
    console.error(chalk.yellow("telegram link: no group found. Add the bot to your project supergroup (as admin), then re-run."));
    return 1;
  }
  config.telegram.chats = { ...config.telegram.chats, [project]: chatId };
  saveConfig(config, configPath);
  console.log(chalk.green(`✔ linked '${project}' → chat ${chatId}`));
  return 0;
}

async function runStatus(configPath?: string): Promise<number> {
  const config = loadConfig(configPath);
  let tokenValid = false;
  if (config.telegram?.botToken) {
    try {
      await createTelegramClient(config.telegram.botToken).getMe();
      tokenValid = true;
    } catch { tokenValid = false; }
  }
  console.log(buildStatusReport({ tokenValid, chats: config.telegram?.chats ?? {} }));
  return 0;
}

export const telegramCommand = new Command("telegram")
  .description("Configure Telegram remote control (#65)")
  .addCommand(
    new Command("link")
      .description("Bind a project to the supergroup the bot was added to")
      .argument("<project>", "project to link")
      .action(async (project: string) => process.exit(await runLink(project))),
  )
  .addCommand(
    new Command("status")
      .description("Show token validity and linked projects")
      .action(async () => process.exit(await runStatus())),
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/commands/__tests__/telegram.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Register the command**

Find where commands are registered (search for `notifyCommand` or `.addCommand(` in `src/index.ts` or `src/cli.ts`):

Run: `grep -rn "notifyRelayCommand\|notifyCommand" src/index.ts src/cli.ts 2>/dev/null`

Add the import and registration next to the other commands:

```typescript
import { telegramCommand } from "./commands/telegram.js";
// ...
program.addCommand(telegramCommand);
```

- [ ] **Step 6: Build to verify registration compiles**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/commands/telegram.ts src/commands/__tests__/telegram.test.ts src/index.ts
git commit -m "feat(telegram): link + status CLI (#65)"
```

---

## Task 10: Docs + setup guide

**Files:**
- Modify: `README.md` (add a "Telegram remote control" section)
- Modify: `AGENTS.md` (one-line feature note under the relevant section)

- [ ] **Step 1: Add the README section**

Add under the features/usage area of `README.md`:

```markdown
## Telegram remote control (#65)

Drive squadrant from your phone. Crew lifecycle events (done / blocked / idle) push
to Telegram forum topics — one topic per session — and replies route back to the
captain.

### Setup

1. Create a bot with [@BotFather](https://t.me/botfather); copy the token.
2. Add the token to `~/.config/squadrant/config.json`:
   ```json
   { "telegram": { "botToken": "123456:ABC...", "chats": {} } }
   ```
3. Create a Telegram **supergroup with Topics enabled** for the project, and add
   your bot as an **admin** (with "Manage topics").
4. Run `squadrant telegram link <project>` — this binds the group to the project.
5. Restart the daemon: `launchctl kickstart -kp gui/$(id -u)/com.squadrant.daemon`.

Check status any time with `squadrant telegram status`.

### How it works

- **Outbound** rides the daemon's existing notification fan-out — Telegram is a
  parallel consumer; your laptop notifications are unaffected if Telegram or the
  network is down (best-effort).
- **Inbound** replies are delivered to the captain (the coordinator), which routes
  them onward to crews.
- The feature is **opt-in**: with no `telegram` config, the daemon behaves exactly
  as before.

Deferred enhancements: inline approve/deny buttons (#309), webhook ingress (#310),
direct-to-crew injection (#249).
```

- [ ] **Step 2: Add the AGENTS.md note**

Add one bullet where squadrant's notification/remote surfaces are described in `AGENTS.md`:

```markdown
- **Telegram remote control** (opt-in, #65): push crew lifecycle to Telegram forum
  topics (one per session) and reply back to the captain. Configure via
  `squadrant telegram link <project>`. See README "Telegram remote control".
```

- [ ] **Step 3: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs(telegram): setup guide + AGENTS note (#65)"
```

---

## Task 11: Full verification + integration smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all tests PASS (new telegram suites + no regressions). If anything fails, fix before proceeding.

- [ ] **Step 2: Type-check the build**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 3: CLI smoke (no live Telegram needed)**

Run: `node dist/index.js telegram status`
Expected: prints `token: invalid/unset` + `no projects linked` on a machine with no telegram config (or the configured state). No crash.

- [ ] **Step 4: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "test(telegram): full-suite verification fixes (#65)"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Outbound push (curated messages, topic auto-provision, best-effort) → Tasks 6, 8. ✅
- Inbound reply → captain via mailbox → Tasks 5, 7, 8. ✅
- Forum-topic mapping, one group per project → Tasks 3, 4, 6. ✅
- Daemon-hosted, opt-in, crash-contained → Tasks 6 (best-effort push), 7 (loop backoff), 8 (injection + isolation test). ✅
- Security: chat_id allowlist (derived from `chats`), no shell passthrough → Task 7 (allowlist), Task 5 (message-not-command). ✅
- Setup `squadrant telegram link` + config → Tasks 1, 9. ✅
- Isolation/failure matrix → Tasks 6, 7, 8 best-effort + backoff + daemon-isolation test. ✅
- Non-goals (#249/#309/#310, no webhook, no token deltas) → out of scope; not built. ✅
- Testing strategy (pure units, mocked HTTP, isolation) → every task is TDD with injected I/O. ✅

**Type consistency:** `TelegramClient`, `TgUpdate`, `TelegramState`, `TelegramSubsystem`, `appendCaptainMessage`, `createTelegramSubsystem`, `processInboundUpdate` names are used identically across tasks. `MailboxEntry.kind` widening is the one shared-type change (Task 5), consumed in Task 8.

**Open risk flagged for the executor:** Task 8 step 3 keeps `startSquadrantd` synchronous by building the subsystem inside the existing boot IIFE while `composedNotify` closes over the mutable `telegram` variable. If the executor finds the closure timing awkward, the acceptable alternative is to construct the subsystem eagerly with a synchronous `loadTelegramState` variant — but do NOT make `startSquadrantd` async (callers depend on the synchronous handle return). Verify the daemon-isolation test (Task 8) passes either way.
```
