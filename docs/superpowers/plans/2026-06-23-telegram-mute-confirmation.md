# Telegram Mute-Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When `squadrant telegram notify <p> …` makes a project quieter (off/down transition), send a one-time confirmation into that project's Telegram topic, bypassing the mute gate.

**Architecture:** Pure transition-detection helpers in `@squadrant/shared`; the CLI `notify` action computes resolved notify before/after the change and, on an off/down transition for a project that has a topic, sends a direct best-effort `client.sendMessage`.

**Tech Stack:** TypeScript (NodeNext ESM — relative imports end in `.js`), vitest, commander.

## Global Constraints

- **ESM `.js` extensions** on every relative import.
- **Bypass via direct send:** the confirmation uses `client.sendMessage(supergroupId, threadId, text)` directly — never `deliverOutbound` — so it ignores active/cap/crew gates.
- **Best-effort:** a send failure prints a warning and the command still exits 0 (the config/state write already happened).
- **Surgical:** only the `telegram notify` CLI path; do NOT touch `config set`, the daemon, or `deliverOutbound`.
- Single-file tests: `npx vitest run <path>`; full suite once at the end.

---

### Task 1: Pure transition helpers in shared

**Files:**
- Modify: `packages/shared/src/project-config.ts`
- Test: `packages/shared/src/__tests__/project-config.test.ts`

**Interfaces:**
- Produces:
  - `crewRank(tier: CrewTier): number` — `none=0, done_only=1, alert_only=2, all=3`
  - `isQuieter(before: NotifyConfig, after: NotifyConfig): { quieter: boolean; dim: "active" | "cap" | "crew" | null }` — returns the first dimension that became more silent (`active` on→off, `cap` on→off, or `crew` rank decreased), else `{quieter:false, dim:null}`

- [ ] **Step 1: Write the failing tests**

Append to `project-config.test.ts`:

```ts
import { crewRank, isQuieter } from "../project-config.js";

describe("notify transition helpers", () => {
  const base = { active: true, cap: true, crew: "all" } as const;
  it("crewRank orders tiers", () => {
    expect(crewRank("none")).toBe(0);
    expect(crewRank("done_only")).toBe(1);
    expect(crewRank("alert_only")).toBe(2);
    expect(crewRank("all")).toBe(3);
  });
  it("cap on→off is quieter", () => {
    expect(isQuieter({ ...base }, { ...base, cap: false })).toEqual({ quieter: true, dim: "cap" });
  });
  it("active on→off is quieter", () => {
    expect(isQuieter({ ...base }, { ...base, active: false })).toEqual({ quieter: true, dim: "active" });
  });
  it("crew all→none is quieter", () => {
    expect(isQuieter({ ...base }, { ...base, crew: "none" })).toEqual({ quieter: true, dim: "crew" });
  });
  it("louder / unchanged is not quieter", () => {
    expect(isQuieter({ ...base, cap: false }, { ...base }).quieter).toBe(false);
    expect(isQuieter({ ...base }, { ...base }).quieter).toBe(false);
    expect(isQuieter({ ...base, crew: "none" }, { ...base, crew: "all" }).quieter).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `npx vitest run packages/shared/src/__tests__/project-config.test.ts`
Expected: FAIL — `crewRank`/`isQuieter` not exported.

- [ ] **Step 3: Implement in `project-config.ts`**

```ts
const CREW_RANK: Record<CrewTier, number> = { none: 0, done_only: 1, alert_only: 2, all: 3 };
export function crewRank(tier: CrewTier): number {
  return CREW_RANK[tier];
}

export function isQuieter(
  before: NotifyConfig,
  after: NotifyConfig,
): { quieter: boolean; dim: "active" | "cap" | "crew" | null } {
  if (before.active && !after.active) return { quieter: true, dim: "active" };
  if (before.cap && !after.cap) return { quieter: true, dim: "cap" };
  if (crewRank(after.crew) < crewRank(before.crew)) return { quieter: true, dim: "crew" };
  return { quieter: false, dim: null };
}
```

- [ ] **Step 4: Run → pass**

Run: `npx vitest run packages/shared/src/__tests__/project-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project-config.ts packages/shared/src/__tests__/project-config.test.ts
git commit -m "feat(shared): notify transition helpers (crewRank, isQuieter)"
```

---

### Task 2: CLI sends a confirmation on off/down transitions

**Files:**
- Modify: `packages/cli/src/commands/telegram.ts`
- Test: `packages/cli/src/commands/__tests__/telegram.test.ts`

**Interfaces:**
- Consumes: `resolveNotify`, `loadProjectOverride`, `isQuieter` from `@squadrant/core`/`@squadrant/shared`; `loadState` for the live `active` + the topic id.
- Produces:
  - `runNotifyConfirmation(opts: { project: string; before: NotifyConfig; after: NotifyConfig; cfg: TelegramConfig; client: TelegramClient; stateRoot: string }): Promise<boolean>` — sends a one-time confirmation when `isQuieter(before,after).quieter` AND the project has a topic; returns whether it sent. Best-effort: swallows send errors (logs), returns false on failure.

- [ ] **Step 1: Write the failing tests**

Append to `telegram.test.ts` (use the file's fake-client style; build a `NotifyConfig` literal):

```ts
import { runNotifyConfirmation } from "../telegram.js";
import { setTopic } from "@squadrant/core";

const ON = { active: true, cap: true, crew: "all" } as const;
function fakeClient() {
  const calls: any[] = [];
  return { calls, sendMessage: async (...a: any[]) => { calls.push(a); }, createForumTopic: async () => 1, getUpdates: async () => [], getMe: async () => ({ id: 1, username: "b" }) };
}
const cfg = { supergroupId: 5, chats: [1] } as any;

it("sends one confirmation on cap off when a topic exists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cf-"));
  setTopic(dir, "squadrant", 9);
  const c = fakeClient();
  const sent = await runNotifyConfirmation({ project: "squadrant", before: { ...ON }, after: { ...ON, cap: false }, cfg, client: c as any, stateRoot: dir });
  expect(sent).toBe(true);
  expect(c.calls).toHaveLength(1);
  expect(c.calls[0][1]).toBe(9); // threadId
});

it("sends nothing for a louder/unchanged change", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cf-"));
  setTopic(dir, "squadrant", 9);
  const c = fakeClient();
  expect(await runNotifyConfirmation({ project: "squadrant", before: { ...ON }, after: { ...ON }, cfg, client: c as any, stateRoot: dir })).toBe(false);
  expect(c.calls).toHaveLength(0);
});

it("sends nothing when the project has no topic", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cf-"));
  const c = fakeClient();
  expect(await runNotifyConfirmation({ project: "x", before: { ...ON }, after: { ...ON, cap: false }, cfg, client: c as any, stateRoot: dir })).toBe(false);
  expect(c.calls).toHaveLength(0);
});

it("swallows send failure and reports false", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cf-"));
  setTopic(dir, "squadrant", 9);
  const c: any = { sendMessage: async () => { throw new Error("boom"); } };
  expect(await runNotifyConfirmation({ project: "squadrant", before: { ...ON }, after: { ...ON, cap: false }, cfg, client: c, stateRoot: dir })).toBe(false);
});
```

- [ ] **Step 2: Run → fail**

Run: `npx vitest run packages/cli/src/commands/__tests__/telegram.test.ts`
Expected: FAIL — `runNotifyConfirmation` not exported.

- [ ] **Step 3: Implement**

Add `runNotifyConfirmation` (uses `isQuieter`, `loadState`, `topicKey`) and a small `confirmationText(project, before, after, dim)` builder for the copy in the spec's table. Then in the `notify` command action: capture `before` (resolved), apply the change, capture `after`, and if a token is set, build a client and call `runNotifyConfirmation` (best-effort; only when `state`/`crew`/`cap` actually changed). Print a dim line when it sends, e.g. `→ notified squadrant topic`.

Confirmation text builder (match spec copy):
```ts
function confirmationText(project: string, before: NotifyConfig, after: NotifyConfig, dim: "active" | "cap" | "crew"): string {
  if (dim === "active") return `🔕 ${project} — all notifications muted here. Unmute: squadrant telegram notify ${project} on`;
  if (dim === "cap")    return `🔕 ${project} — captain messages muted here. Re-enable: squadrant telegram notify ${project} cap on`;
  return `🔕 ${project} — crew notifications now '${after.crew}' (was '${before.crew}'). Re-enable: squadrant telegram notify ${project} crew ${before.crew}`;
}
```

- [ ] **Step 4: Run → pass**

Run: `npx vitest run packages/cli/src/commands/__tests__/telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + CLI gate**

Run: `pnpm build && node dist/index.js telegram notify --help`
Expected: prints (no ESM crash).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/telegram.ts packages/cli/src/commands/__tests__/telegram.test.ts
git commit -m "feat(telegram): announce mute/down transitions to the project topic (bypasses gate)"
```

---

### Task 3: Full suite + CHANGELOG

- [ ] **Step 1: Full suite once**

Run: `npx vitest run`
Expected: PASS (no regressions). Run ONCE.

- [ ] **Step 2: CHANGELOG**

Add under the unreleased heading:

```markdown
### Added
- **Telegram mute confirmations.** Turning a project quieter via `squadrant telegram notify <p> off|cap off|crew <lower>` now posts a one-time confirmation into that project's topic (bypassing the mute), so you can tell on Telegram that it went silent rather than guessing.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(telegram): changelog for mute confirmations"
```

---

## Self-Review

- Off/down trigger (active/cap/crew) → Task 1 `isQuieter` ✓
- Bypass gate (direct sendMessage) → Task 2 ✓
- Topic-exists / unchanged / send-failure guards → Task 2 tests ✓
- Scope limited to `telegram notify` CLI (no daemon, no `config set`) → Tasks 1–2 ✓
- No louder/ON announce → `isQuieter` returns false ✓

**Types:** `NotifyConfig` / `CrewTier` reused from `project-config.ts` across both tasks; `runNotifyConfirmation` signature matches the Task 2 tests.
