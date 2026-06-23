# Telegram Tap-First — Slice 2: Guided `/spawn` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `/spawn` (no args) replies with a project-picker; tapping a project sends a Telegram **ForceReply** prompt; the user's reply (the task text) spawns a crew on that project — never appended as a captain message.

**Architecture:** Stateless ForceReply flow. The picker tap sends a prompt whose text encodes the project behind a fixed marker; when a reply to that prompt arrives, the bridge parses the project from `reply_to_message.text`, gates on the replier, and runs `crew spawn`. No new client method, no pending-state map.

**Tech Stack:** TypeScript (NodeNext ESM — relative imports end in `.js`), vitest.

**Spec:** `docs/superpowers/specs/2026-06-23-telegram-tap-first-commands-design.md` (slice 2 section)
**Builds on:** slice 1 (PR #416) — `panels.ts`, `handleCallback`, `sendReply(threadId, text, replyMarkup?)`.

## Global Constraints

- **ESM `.js` extensions** on every relative import.
- **Stateless:** project is carried in the ForceReply prompt text behind a fixed marker — no pending-spawn map, no client change.
- **Gate the reply** on the replier's user-id (`isControlEnabled && isAuthorized`), same as commands/callbacks.
- **Never append** a ForceReply reply or a bare `/spawn` as a captain message.
- **Never throw into the poll loop.**
- Single-file tests `npx vitest run <path>`; full suite once at the end. 1 known timeout flake acceptable baseline.

## File structure

| File | Change |
|---|---|
| `packages/core/src/telegram/panels.ts` | `spawnPicker(projects)`; `parseCallback` handles `sp:<project>`; `SPAWN_PROMPT_PREFIX` + `buildSpawnPrompt(project)` + `parseSpawnPrompt(text)` |
| `packages/core/src/telegram/bridge.ts` | `/spawn` no-arg → picker; `sp:` callback → ForceReply prompt; route a reply-to-prompt → `crew spawn` |

---

### Task 1: panels — spawn picker + prompt codec

**Files:**
- Modify: `packages/core/src/telegram/panels.ts`
- Test: `packages/core/src/telegram/__tests__/panels.test.ts`

**Interfaces:**
- Produces:
  - `spawnPicker(projects: string[]): InlineKeyboard` — buttons `sp:<project>`
  - `parseCallback` also returns `{ t: "spawn"; project: string }` for `sp:<project>`
  - `SPAWN_PROMPT_PREFIX: string` (constant marker)
  - `buildSpawnPrompt(project: string): string` → `${SPAWN_PROMPT_PREFIX}${project}`
  - `parseSpawnPrompt(text: string | undefined): string | null` → the project if `text` starts with the prefix, else null

- [ ] **Step 1: Failing tests**
```ts
import { spawnPicker, parseCallback, buildSpawnPrompt, parseSpawnPrompt, SPAWN_PROMPT_PREFIX } from "../panels.js";
it("spawnPicker emits sp:<project> buttons", () => {
  expect(spawnPicker(["brove", "solder"]).inline_keyboard.flat().map((b) => b.callback_data)).toEqual(["sp:brove", "sp:solder"]);
});
it("parseCallback handles sp:", () => {
  expect(parseCallback("sp:brove")).toEqual({ t: "spawn", project: "brove" });
});
it("spawn prompt round-trips the project", () => {
  const p = buildSpawnPrompt("brove");
  expect(p.startsWith(SPAWN_PROMPT_PREFIX)).toBe(true);
  expect(parseSpawnPrompt(p)).toBe("brove");
  expect(parseSpawnPrompt("just a normal message")).toBeNull();
  expect(parseSpawnPrompt(undefined)).toBeNull();
});
```

- [ ] **Step 2: Run → fail** — `npx vitest run packages/core/src/telegram/__tests__/panels.test.ts`

- [ ] **Step 3: Implement** in `panels.ts`:
```ts
export const SPAWN_PROMPT_PREFIX = "🆕 Reply with the task for a crew on: ";
export function buildSpawnPrompt(project: string): string {
  return `${SPAWN_PROMPT_PREFIX}${project}`;
}
export function parseSpawnPrompt(text: string | undefined): string | null {
  if (!text || !text.startsWith(SPAWN_PROMPT_PREFIX)) return null;
  const project = text.slice(SPAWN_PROMPT_PREFIX.length).trim();
  return project.length > 0 ? project : null;
}
export function spawnPicker(projects: string[]): InlineKeyboard {
  return { inline_keyboard: projects.map((p) => [{ text: p, callback_data: `sp:${p}` }]) };
}
// in parseCallback, add before the final return:
//   if (parts[0] === "sp" && parts[1]) return { t: "spawn", project: parts.slice(1).join(":") };
```
Also add `{ t: "spawn"; project: string }` to the `parseCallback` return union.

- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): spawn picker + ForceReply prompt codec (panels)"`

---

### Task 2: bridge — `/spawn` picker, ForceReply on tap, reply → crew spawn

**Files:**
- Modify: `packages/core/src/telegram/bridge.ts`
- Test: `packages/core/src/telegram/__tests__/bridge.callback.test.ts` (extend) + the inbound test harness

**Interfaces:**
- Consumes: `spawnPicker`, `buildSpawnPrompt`, `parseSpawnPrompt`, `parseCallback` (panels); existing `runCommand`, `sendReply`, gate predicates.

**Behavior:**
1. **`/spawn` with no task arg** (General topic *and* project topic): reply `spawnPicker(projects)` where `projects = Object.keys(loadConfig().projects)` — **gated** (auth); never appended. (`/spawn <project> <task...>` typed form keeps working via the existing path.)
2. **`sp:<project>` callback** (add a branch to `handleCallback`): `await sendReply(threadId, buildSpawnPrompt(action.project), { force_reply: true, selective: true })`; `await answerCallbackQuery(cq.id)`. (`threadId` = the callback message's `message_thread_id`.)
3. **Inbound reply routing** — extend the narrowed message type with `reply_to_message?: { text?: string }`. In `handleUpdate`/`handleProjectTopic`, **before** the auto-unmute + captain.message append:
   ```
   const spawnProject = parseSpawnPrompt(m.reply_to_message?.text);
   if (spawnProject) {
     if (!isControlEnabled(cfg) || !isAuthorized(m.from?.id, cfg)) { await reply(threadId, "⛔ not authorized"); return; }
     const task = m.text.trim();
     if (!task) { await reply(threadId, "spawn cancelled — empty task"); return; }
     if (runCommand) await runCommand(["crew", "spawn", spawnProject, task]);
     await reply(threadId, `🆕 spawning a crew on ${spawnProject}…`);
     return;   // NOT appended as a captain message
   }
   ```
   Note: a reply can land in a project topic (has thread id) or General (no thread id) — handle both by doing this check in `handleUpdate` right after the chats-allowlist gate, before branching on `message_thread_id`.

- [ ] **Step 1: Failing tests**
```ts
it("/spawn with no task replies a project picker (gated, not appended)", async () => {
  await deliverInbound({ message: { chat: { id: CHAT }, text: "/spawn", from: { id: USER } } });
  const call = fakeClient.sendMessage.mock.calls.at(-1);
  expect(call[3].inline_keyboard.flat().some((b: any) => b.callback_data.startsWith("sp:"))).toBe(true);
  expect(appendCaptainMessage).not.toHaveBeenCalled();
});
it("sp: tap sends a ForceReply prompt", async () => {
  await deliverCallback({ id: "c1", from: { id: USER }, data: "sp:brove", message: { chat: { id: CHAT }, message_id: 5, message_thread_id: 7 } });
  const call = fakeClient.sendMessage.mock.calls.at(-1);
  expect(call[2]).toContain("brove");                 // prompt text carries the project
  expect(call[3]).toMatchObject({ force_reply: true });
});
it("a reply to the spawn prompt runs crew spawn (authorized), not appended", async () => {
  await deliverInbound({ message: { chat: { id: CHAT }, message_thread_id: 7, text: "audit the auth module",
    from: { id: USER }, reply_to_message: { text: buildSpawnPrompt("brove") } } });
  expect(fakeRunCommand).toHaveBeenCalledWith(["crew", "spawn", "brove", "audit the auth module"]);
  expect(appendCaptainMessage).not.toHaveBeenCalled();
});
it("a reply to the spawn prompt from a non-allowlisted user is refused", async () => {
  await deliverInbound({ message: { chat: { id: CHAT }, message_thread_id: 7, text: "do x",
    from: { id: 999 }, reply_to_message: { text: buildSpawnPrompt("brove") } } });
  expect(fakeRunCommand).not.toHaveBeenCalled();
});
it("an ordinary message (no reply_to spawn prompt) is still appended", async () => {
  setTopic(stateRoot, "squadrant", 9);
  await deliverInbound({ message: { chat: { id: CHAT }, message_thread_id: 9, text: "hello", from: { id: USER } } });
  expect(appendCaptainMessage).toHaveBeenCalled();
});
```
(Use the test file's real harness names; `buildSpawnPrompt` imported from `../panels.js`.)

- [ ] **Step 2: Run → fail**
- [ ] **Step 3: Implement** per the Behavior block (extend the narrowed message type to include `from?: { id }` and `reply_to_message?: { text?: string }`).
- [ ] **Step 4: Run → pass**
- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): guided /spawn — picker + ForceReply → crew spawn"`

---

### Task 3: menu copy + build + suite + CHANGELOG

**Files:** `packages/core/src/telegram/bot-commands.ts` (spawn description already added in slice 1; confirm), `CHANGELOG.md`

- [ ] **Step 1: Confirm `spawn` is in `BOT_COMMANDS`** (added slice 1). If missing, add `{ command: "spawn", description: "spawn a crew (guided)" }` and update the bot-commands test.
- [ ] **Step 2: Build + gate** — `pnpm build && node dist/index.js --help` (no crash).
- [ ] **Step 3: Full suite once** — `npx vitest run` (1 known timeout flake acceptable; nothing new red).
- [ ] **Step 4: CHANGELOG**
```markdown
### Added
- **Guided `/spawn` over Telegram.** `/spawn` now replies with a project picker; tap a project and the bot asks (ForceReply) for the task — your reply spawns the crew. No typed arguments needed. (Completes the tap-first command UX.)
```
- [ ] **Step 5: Commit** — `git commit -m "docs(telegram): changelog for guided /spawn (slice 2)"`

---

## Self-Review

- `/spawn` no-arg → picker → Task 2 ✓
- `sp:` tap → ForceReply → Task 2 ✓
- reply → `crew spawn`, gated, not appended → Task 2 ✓
- stateless prompt codec → Task 1 ✓
- ordinary messages + typed `/spawn <p> <task>` unaffected → Task 2 tests ✓
- **Types:** `parseCallback` `{t:"spawn"}` (Task 1) consumed in Task 2; `SPAWN_PROMPT_PREFIX`/`buildSpawnPrompt`/`parseSpawnPrompt` consistent across both tasks.
