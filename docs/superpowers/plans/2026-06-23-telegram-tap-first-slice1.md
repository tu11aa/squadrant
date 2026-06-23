# Telegram Tap-First Commands — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Inline-button panels for the parameterized Telegram commands — `/notify` panel, `/effort` panel, and project-picker panels for `/crews`/`/launch`/`/mute`/`/unmute` — plus the shared `callback_query` plumbing. (Guided `/spawn` is slice 2, not here.)

**Architecture:** Add inline-keyboard + callback methods to the Telegram client; a pure `panels.ts` that builds keyboards and parses/formats `callback_data`; and a `callback_query` handler in the bridge that gates on the tapper, applies via existing state writers / the curated `runCommand`, answers the callback, and re-renders the panel (guarding "not modified").

**Tech Stack:** TypeScript (NodeNext ESM — relative imports end in `.js`), vitest, plain `fetch` Telegram client.

**Spec:** `docs/superpowers/specs/2026-06-23-telegram-tap-first-commands-design.md`

## Global Constraints

- **ESM `.js` extensions** on every relative import.
- **Always `answerCallbackQuery`** in every callback path (even no-op / unauthorized) — else the button spinner hangs.
- **Guard "message is not modified":** only call `editMessageReplyMarkup` when the rendered keyboard differs; catch and swallow a `not modified` API error if it slips through.
- **Gate on `callback_query.from.id`** (the tapper) via `isControlEnabled(cfg) && isAuthorized(fromId, cfg)` — never trust the panel.
- **Render state fresh** on every callback (derive project from the message's `message_thread_id`; read notify/effort live).
- **`callback_data` ≤ 64 bytes**, prefix-routed.
- Single-file tests `npx vitest run <path>`; full suite once at the end.

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/telegram/client.ts` | add `replyMarkup` to sendMessage; `answerCallbackQuery`; `editMessageReplyMarkup` |
| `packages/core/src/telegram/panels.ts` (new) | pure keyboard builders + `callback_data` format/parse |
| `packages/core/src/telegram/bridge.ts` | `callback_query` handler; reply panels for `/notify` `/effort` `/crews` `/launch` `/mute` `/unmute` |
| `packages/core/src/telegram/bot-commands.ts` | menu list: add `effort`; drop `config` |

---

### Task 1: Client — inline keyboards + callback methods

**Files:**
- Modify: `packages/core/src/telegram/client.ts`
- Test: `packages/core/src/telegram/client.test.ts`

**Interfaces:**
- Produces (on `TelegramClient`):
  - `sendMessage(chatId, threadId, text, replyMarkup?: unknown): Promise<void>` (4th param optional → `reply_markup`)
  - `answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>`
  - `editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: unknown): Promise<void>`

- [ ] **Step 1: Failing tests** (reuse the file's fake-fetch harness — assert method + body)

```ts
it("sendMessage includes reply_markup when given", async () => {
  const calls: any[] = [];
  const client = createTelegramClient({ token: "t", fetch: fakeFetch(calls) });
  await client.sendMessage(5, 9, "hi", { inline_keyboard: [[{ text: "x", callback_data: "e:max" }]] });
  expect(calls[0].method).toBe("sendMessage");
  expect(calls[0].body.reply_markup).toEqual({ inline_keyboard: [[{ text: "x", callback_data: "e:max" }]] });
});
it("answerCallbackQuery posts id + text", async () => {
  const calls: any[] = []; const client = createTelegramClient({ token: "t", fetch: fakeFetch(calls) });
  await client.answerCallbackQuery("cb1", "done");
  expect(calls[0].method).toBe("answerCallbackQuery");
  expect(calls[0].body).toMatchObject({ callback_query_id: "cb1", text: "done" });
});
it("editMessageReplyMarkup posts chat+message+markup", async () => {
  const calls: any[] = []; const client = createTelegramClient({ token: "t", fetch: fakeFetch(calls) });
  await client.editMessageReplyMarkup(5, 42, { inline_keyboard: [] });
  expect(calls[0].method).toBe("editMessageReplyMarkup");
  expect(calls[0].body).toMatchObject({ chat_id: 5, message_id: 42 });
});
```
(If the file has no `fakeFetch` helper, add one returning `{ ok: true, json: async () => ({ ok: true, result: {} }) }` and recording `{method, body}`.)

- [ ] **Step 2: Run → fail** — `npx vitest run packages/core/src/telegram/client.test.ts`

- [ ] **Step 3: Implement** in `client.ts`:
```ts
// interface additions:
sendMessage(chatId: number, threadId: number | undefined, text: string, replyMarkup?: unknown): Promise<void>;
answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: unknown): Promise<void>;
// impl:
async sendMessage(chatId, threadId, text, replyMarkup) {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (threadId !== undefined) body.message_thread_id = threadId;
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
  await call<unknown>("sendMessage", body);
},
async answerCallbackQuery(callbackQueryId, text) {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text !== undefined) body.text = text;
  await call<unknown>("answerCallbackQuery", body);
},
async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  await call<unknown>("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
},
```

- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): client inline-keyboard + callback methods"`

---

### Task 2: `panels.ts` — pure keyboard builders + callback codec

**Files:**
- Create: `packages/core/src/telegram/panels.ts`
- Test: `packages/core/src/telegram/__tests__/panels.test.ts`

**Interfaces:**
- Consumes: `NotifyConfig`, `CrewTier` from `@squadrant/shared`.
- Produces:
  - `type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }`
  - `notifyPanel(s: NotifyConfig): InlineKeyboard`
  - `effortPanel(current: "max" | "balance" | "low"): InlineKeyboard`
  - `projectPicker(action: "cr" | "lc" | "mu" | "um", projects: string[]): InlineKeyboard`
  - `parseCallback(data: string): | { t: "notify"; dim: "cap" | "crew" | "active"; val: string } | { t: "effort"; mode: string } | { t: "pick"; action: "cr" | "lc" | "mu" | "um"; project: string } | null`

- [ ] **Step 1: Failing tests**
```ts
import { notifyPanel, effortPanel, projectPicker, parseCallback } from "../panels.js";
it("notifyPanel marks current crew tier + cap state", () => {
  const kb = notifyPanel({ active: true, cap: true, crew: "alert_only" });
  const flat = kb.inline_keyboard.flat();
  expect(flat.find((b) => b.callback_data === "n:cap:off")).toBeTruthy();   // cap is on → button offers OFF
  const crewBtn = flat.find((b) => b.callback_data === "n:crew:alert_only")!;
  expect(crewBtn.text).toMatch(/[•✓]/);                                     // current marked
});
it("effortPanel marks current", () => {
  const kb = effortPanel("balance");
  const b = kb.inline_keyboard.flat().find((x) => x.callback_data === "e:balance")!;
  expect(b.text).toMatch(/[•✓]/);
});
it("projectPicker emits one button per project", () => {
  const kb = projectPicker("cr", ["brove", "solder"]);
  expect(kb.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(["cr:brove", "cr:solder"]);
});
it("parseCallback round-trips each kind", () => {
  expect(parseCallback("n:crew:none")).toEqual({ t: "notify", dim: "crew", val: "none" });
  expect(parseCallback("n:cap:on")).toEqual({ t: "notify", dim: "cap", val: "on" });
  expect(parseCallback("e:max")).toEqual({ t: "effort", mode: "max" });
  expect(parseCallback("cr:brove")).toEqual({ t: "pick", action: "cr", project: "brove" });
  expect(parseCallback("garbage")).toBeNull();
});
```

- [ ] **Step 2: Run → fail**
- [ ] **Step 3: Implement** `panels.ts` (pure; mark current with a leading `• `):
```ts
import type { NotifyConfig, CrewTier } from "@squadrant/shared";
export type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
const mark = (on: boolean, label: string) => (on ? `• ${label}` : label);
const TIERS: CrewTier[] = ["none", "alert_only", "all"];        // curated subset for the row

export function notifyPanel(s: NotifyConfig): InlineKeyboard {
  return { inline_keyboard: [
    [{ text: `Captain: ${s.cap ? "ON" : "OFF"}`, callback_data: `n:cap:${s.cap ? "off" : "on"}` }],
    TIERS.map((t) => ({ text: mark(s.crew === t, `crew:${t}`), callback_data: `n:crew:${t}` })),
    [{ text: s.active ? "🔕 Mute topic" : "🔔 Unmute", callback_data: `n:active:${s.active ? "off" : "on"}` }],
  ]};
}
export function effortPanel(current: "max" | "balance" | "low"): InlineKeyboard {
  return { inline_keyboard: [(["max", "balance", "low"] as const).map((m) => ({ text: mark(current === m, m), callback_data: `e:${m}` }))] };
}
export function projectPicker(action: "cr" | "lc" | "mu" | "um", projects: string[]): InlineKeyboard {
  return { inline_keyboard: projects.map((p) => [{ text: p, callback_data: `${action}:${p}` }]) };
}
export function parseCallback(data: string): any {
  const parts = data.split(":");
  if (parts[0] === "n" && (parts[1] === "cap" || parts[1] === "crew" || parts[1] === "active") && parts[2])
    return { t: "notify", dim: parts[1], val: parts[2] };
  if (parts[0] === "e" && parts[1]) return { t: "effort", mode: parts[1] };
  if (["cr", "lc", "mu", "um"].includes(parts[0]) && parts[1]) return { t: "pick", action: parts[0], project: parts.slice(1).join(":") };
  return null;
}
```
(Type the `parseCallback` return as the union from the Interfaces block rather than `any` in the real impl.)

- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): pure panel builders + callback_data codec"`

---

### Task 3: Bridge — `callback_query` handler

**Files:**
- Modify: `packages/core/src/telegram/bridge.ts`
- Test: `packages/core/src/telegram/__tests__/bridge.callback.test.ts`

**Interfaces:**
- Consumes: `parseCallback`, `notifyPanel`, `effortPanel` (panels.ts); `isControlEnabled`/`isAuthorized` (auth.js); `setNotify`, `saveProjectOverride`, `resolveNotify`, `findProjectByThread`, `loadState` (state/shared); the bridge's existing `runCommand`.

**Behavior of `handleCallback(cq)`** where `cq = { id, from?:{id}, message?:{ chat:{id}, message_id, message_thread_id? }, data? }`:
1. If no `data` or no `message` → `answerCallbackQuery(cq.id)` and return.
2. Gate: `if (!isControlEnabled(cfg) || !isAuthorized(cq.from?.id, cfg))` → `answerCallbackQuery(cq.id, "⛔ not authorized")`, return.
3. `const action = parseCallback(cq.data)`; if null → `answerCallbackQuery(cq.id)`, return.
4. Apply + answer + re-render:
   - **notify** (needs project): `const proj = findProjectByThread(stateRoot, threadId)?.project`; if none → answer "no project", return.
     - `dim==="active"` → `setNotify(stateRoot, proj, val==="on")`
     - `dim==="cap"` → `saveProjectOverride(proj, { telegram:{ notify:{ cap: val==="on" } } }, configRoot)`
     - `dim==="crew"` → `saveProjectOverride(proj, { telegram:{ notify:{ crew: val as CrewTier } } }, configRoot)`
     - `answerCallbackQuery(cq.id, \`✅ ${dim} = ${val}\`)`
     - re-render: `const next = notifyPanel(resolveWithLiveActive(proj))`; **only if changed** → `editMessageReplyMarkup(chat.id, message_id, next)` (compare JSON of new vs the rebuilt-from-previous; simplest: wrap the edit in try/catch and swallow a "not modified" error).
   - **effort** → `await runCommand(["effort", action.mode])`; `answerCallbackQuery(cq.id, \`✅ effort = ${action.mode}\`)`; re-render `effortPanel(action.mode)`.
   - **pick** (General-topic project actions):
     - `cr` → `const out = await runCommand(["crew","list",project])`; `answerCallbackQuery(cq.id)`; `reply(threadId, out)` (text result, no panel edit).
     - `lc` → `runCommand(["launch",project])`; `answerCallbackQuery(cq.id, "launching " + project)`.
     - `mu` → `setNotify(stateRoot, project, false)`; `answerCallbackQuery(cq.id, "🔕 muted " + project)`.
     - `um` → `setNotify(stateRoot, project, true)`; `answerCallbackQuery(cq.id, "🔔 unmuted " + project)`.
- Wrap each callback in try/catch; on error `answerCallbackQuery(cq.id, "⚠️ failed")` + `log`. The handler must never throw into the poll loop.
- In `handleUpdate`, before the `u.message` branch: `if (u.callback_query) { await handleCallback(u.callback_query); return; }`.

Add a helper for live-active notify resolution (reuse the §deliverOutbound pattern): `resolveNotify(cfg.notify, loadProjectOverride(proj, configRoot))` with `active` overlaid from `loadState(stateRoot).notify[proj] ?? resolved.active`.

- [ ] **Step 1: Failing tests** (build a bridge with a recording fake client + a fake `runCommand`; drive `handleCallback` via the exported handler or a synthesized `getUpdates` returning a `callback_query`):
```ts
it("authorized notify tap toggles crew + answers + edits", async () => {
  setTopic(stateRoot, "squadrant", 9);
  await deliverCallback({ id: "c1", from: { id: USER }, data: "n:crew:none",
    message: { chat: { id: CHAT }, message_id: 42, message_thread_id: 9 } });
  expect(loadProjectOverride("squadrant", configRoot).telegram?.notify?.crew).toBe("none");
  expect(fakeClient.answerCallbackQuery).toHaveBeenCalledWith("c1", expect.stringContaining("crew = none"));
  expect(fakeClient.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
});
it("unauthorized tap answers not-authorized and does NOT apply", async () => {
  await deliverCallback({ id: "c2", from: { id: 999 }, data: "n:crew:all", message: { chat: { id: CHAT }, message_id: 1, message_thread_id: 9 } });
  expect(fakeClient.answerCallbackQuery).toHaveBeenCalledWith("c2", expect.stringContaining("not authorized"));
  expect(fakeClient.editMessageReplyMarkup).not.toHaveBeenCalled();
});
it("effort tap runs the effort command", async () => {
  await deliverCallback({ id: "c3", from: { id: USER }, data: "e:low", message: { chat: { id: CHAT }, message_id: 7 } });
  expect(fakeRunCommand).toHaveBeenCalledWith(["effort", "low"]);
});
```
(cfg has `remoteControl: true`, `users: [USER]`. Use the test file's existing harness names.)

- [ ] **Step 2: Run → fail**
- [ ] **Step 3: Implement** per the Behavior block above.
- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): callback_query handler — gated panel taps apply + re-render"`

---

### Task 4: Commands reply panels + menu update

**Files:**
- Modify: `packages/core/src/telegram/bridge.ts` (command → panel), `packages/core/src/telegram/bot-commands.ts`, `packages/core/src/telegram/commands.ts`
- Test: `packages/core/src/telegram/__tests__/bridge.callback.test.ts` (extend), `commands.test.ts`, `__tests__/bot-commands.test.ts`

**Behavior:**
- **`/notify` (project topic):** replace the slice-0 usage-hint reply (from #415) with the panel — `reply(threadId, "🔔 <project> notifications", notifyPanel(currentState))`. Still gated (auth) and still never appended. Keep `/notify cap on` typed form working (parseNotifyPref path) for power users.
- **`/effort` (General topic):** `runCommand`'s registry already maps `/effort` → argv; intercept in `handleGeneral`: if the command is `effort` with NO mode arg → reply `effortPanel(currentEffort)` instead of running. With a mode arg → run as today.
- **`/crews` `/launch` `/mute` `/unmute` (General topic) with NO project arg:** reply the `projectPicker(action, projects)` (projects from `loadConfig().projects`) instead of the usage error. With a project arg → run as today.
- **`bot-commands.ts`:** add `{ command: "effort", description: "set effort: max | balance | low" }` and `{ command: "spawn", description: "spawn a crew (guided)" }`; remove nothing else. (config was never in the menu.)
- **`commands.ts`:** no behavior change required for config (it's not in BOT_COMMANDS); leave the typed handler intact.

- [ ] **Step 1: Failing tests**
```ts
it("/notify in a topic replies the panel (not usage), gated", async () => {
  setTopic(stateRoot, "squadrant", 9);
  await deliverInbound({ message: { chat: { id: CHAT }, message_thread_id: 9, text: "/notify", from: { id: USER } } });
  const call = fakeClient.sendMessage.mock.calls.at(-1);
  expect(call[3]?.inline_keyboard).toBeTruthy();          // 4th arg = replyMarkup
  expect(appendCaptainMessage).not.toHaveBeenCalled();
});
it("/crews with no project replies a project picker", async () => {
  await deliverInbound({ message: { chat: { id: CHAT }, text: "/crews", from: { id: USER } } });
  const call = fakeClient.sendMessage.mock.calls.at(-1);
  expect(call[3].inline_keyboard.flat().some((b: any) => b.callback_data.startsWith("cr:"))).toBe(true);
});
it("bot-commands menu includes effort, excludes config", () => {
  const names = BOT_COMMANDS.map((c) => c.command);
  expect(names).toContain("effort");
  expect(names).not.toContain("config");
});
```

- [ ] **Step 2: Run → fail**
- [ ] **Step 3: Implement** per the Behavior block.
- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): commands reply inline panels (/notify /effort /crews /launch /mute /unmute)"`

---

### Task 5: Build, full suite, CHANGELOG

- [ ] **Step 1: Build + gate** — `pnpm build && node dist/index.js --help` (no ESM crash).
- [ ] **Step 2: Full suite once** — `npx vitest run` (1 known bridge/launch timeout flake acceptable; nothing new red).
- [ ] **Step 3: CHANGELOG**
```markdown
### Added
- **Tap-first Telegram commands (inline buttons).** `/notify`, `/effort`, and `/crews`/`/launch`/`/mute`/`/unmute` now reply with tappable button panels instead of needing typed arguments — pick from buttons, no syntax to remember. Button taps are gated on your user-id (remoteControl) like commands. (Guided `/spawn` lands next.)
```
- [ ] **Step 4: Commit** — `git commit -m "docs(telegram): changelog for tap-first command panels (slice 1)"`

---

## Self-Review

- Client inline-keyboard + callback methods → Task 1 ✓
- Pure panels + callback codec → Task 2 ✓
- callback_query gate + apply + answer + guarded re-render → Task 3 ✓
- Commands reply panels + menu update → Task 4 ✓
- Pitfall guards: always-answer (Task 3 every path), not-modified (Task 3 try/catch), gate-on-tapper (Task 3 step 2), fresh-state (Task 3 re-render reads live) ✓
- Spec slice-1 scope (no `/spawn` ForceReply, no `config` buttons, no `/menu` hub) ✓
- **Types:** `InlineKeyboard`, `parseCallback` union, `callback_data` strings (`n:` `e:` `cr:` …) consistent across Tasks 2–4; client `sendMessage` 4-arg signature used in Task 4.
