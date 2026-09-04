# Claude hook upgrades (#760, #761, #762, #763) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land 4 Claude Code hook capability upgrades — real per-turn `turnId`, a `PermissionRequest` hook + structural `notification_type` matcher, a `background_tasks`/`session_crons` structural veto on turn-completion, and a `StopFailure` source for API-error turn deaths — as one branch, one commit per issue, in dependency order.

**Architecture:** All four land in the existing hook-mapping pipeline: `packages/agents/src/interactive/claude.ts` (`mapClaudeHookToEvent`, pure) is the single place a raw Claude hook payload becomes a `ControlEvent`. Two installers feed it real hook fires: `packages/workspaces/src/native-hooks/native-hook-source.ts` (`installClaudeHooks`, the captain's managed `~/.claude/settings.json`, #615) via `packages/cli/src/commands/hooks.ts` (`mapHookSub`), and the `EVENTS`/`MATCHED_EVENTS` list in `claude.ts` itself (the crew's own per-session settings, via `packages/cli/src/lib/per-crew-settings.ts` → `packages/cli/src/commands/crew-control.ts`'s `_hook` command, which calls `mapClaudeHookToEvent` directly). New ControlEvent variants also need a `packages/core/src/state-machine.ts` reducer case and a `packages/core/src/daemon/reduce.ts` `KNOWN_EVENT_TYPES` entry, then `scripts/control-event-table.mjs` regenerates `docs/generated/control-events.md`.

**Tech Stack:** TypeScript, vitest, pnpm workspaces (tsup build).

**Spec:** issues #760, #761, #762, #763 (verified payload shapes in `docs/specs/2026-09-04-cmux-0.64.22-compat-study.md` §8, not yet on this branch — content already reviewed and summarized inline below).

## Global Constraints

- Every new Claude hook event needs an explicit `mapClaudeHookToEvent` mapping — an unmapped event must return `null`, never fall through to `task.progress` (anti-liveness-lie rule already enforced by the `default: return null` in the switch).
- Never write full `tool_input` to disk/logs — summarize (file-path/command hint only, truncated).
- Keep fallbacks for payloads missing `notification_type` / `prompt_id` / `background_tasks` so older Claude clients keep current behaviour.
- Anti-#2576 invariant: no Claude hook may map to `task.done` or `task.failed`.
- Do not touch the daemon, launchctl, `~/.claude/settings.json`, or config on this machine — unit tests only, all I/O injectable.
- One commit per issue, order: #761 → #760 → #762 → #763.
- Gate before PR: `pnpm build && pnpm test && node dist/index.js --help`; regenerate `docs/generated/control-events.md` via `node scripts/control-event-table.mjs` if `ControlEvent` shapes changed, verified by `node scripts/control-event-table.mjs --check`.

---

## Task 1 (#761): thread `prompt_id` as the real turnId

**Files:**
- Modify: `packages/agents/src/interactive/claude.ts` (Stop case, ~L351-358)
- Test: `packages/agents/src/__tests__/interactive-claude-hook.test.ts`

**Interfaces:**
- Produces: `resolveTurnId(payload: unknown): string` — exported, pure. Returns `payload.prompt_id` when it is a non-empty string, else the literal `"hook-stop"`.
- Consumes: nothing new.

- [ ] **Step 1: Write failing tests** in `interactive-claude-hook.test.ts`, new `describe("mapClaudeHookToEvent Stop turnId (#761)")`:
```ts
it("Stop with prompt_id → turnId is the real per-turn id", () => {
  const ev = mapClaudeHookToEvent("Stop", { prompt_id: "204d13c6-abcd" }, "task-abc");
  expect(ev).toEqual({ type: "task.turn.completed", id: "task-abc", turnId: "204d13c6-abcd" });
});

it("Stop without prompt_id → turnId falls back to the constant (older clients)", () => {
  const ev = mapClaudeHookToEvent("Stop", { session_id: "x" }, "task-abc");
  expect(ev).toEqual({ type: "task.turn.completed", id: "task-abc", turnId: "hook-stop" });
});

it("Stop with empty-string prompt_id → falls back to the constant", () => {
  const ev = mapClaudeHookToEvent("Stop", { prompt_id: "" }, "task-abc");
  expect(ev).toEqual({ type: "task.turn.completed", id: "task-abc", turnId: "hook-stop" });
});

it("logs permission_mode when present (log-only, no behaviour change)", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  mapClaudeHookToEvent("Stop", { prompt_id: "p1", permission_mode: "acceptEdits" }, "task-abc");
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("acceptEdits"));
  spy.mockRestore();
});
```
Add `vi` to the existing `import { describe, it, expect, beforeEach, afterEach } from "vitest";` → add `vi`.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @squadrant/agents test -- interactive-claude-hook` (or vitest run on the file). Expect the first new test to fail (`turnId` still `"hook-stop"`).

- [ ] **Step 3: Implement.** In `claude.ts`, add above `mapClaudeHookToEvent`:
```ts
/**
 * Pure: resolve the real per-turn correlation id. Stop/PermissionRequest/
 * Notification payloads all carry prompt_id (a UUID matching across events
 * of the same turn — verified live, 2026-09-04 compat study §8.3). Falls
 * back to the pre-#761 constant when absent (older Claude clients).
 */
export function resolveTurnId(payload: unknown): string {
  const id = (payload as { prompt_id?: unknown } | null | undefined)?.prompt_id;
  return typeof id === "string" && id.trim() ? id : "hook-stop";
}

/**
 * #761: log-only observability for a crew that silently switched permission
 * mode mid-session (cmux #8070 persists this as lastPermissionMode). No
 * behaviour change — this never affects the emitted ControlEvent.
 */
function logStopPermissionMode(payload: unknown, taskId: string): void {
  const mode = (payload as { permission_mode?: unknown } | null | undefined)?.permission_mode;
  if (typeof mode === "string" && mode) {
    console.error(`[squadrant] hook: Stop permission_mode=${mode} task=${taskId}`);
  }
}
```
Update the Stop case body:
```ts
case "Stop": {
  const text = resolveLastAssistantText(payload);
  const question = text ? detectTrailingQuestion(text) : null;
  if (question) {
    return { type: "task.blocked", id: taskId, reason: "crew asked a question (auto-detected)", question };
  }
  logStopPermissionMode(payload, taskId);
  return { type: "task.turn.completed", id: taskId, turnId: resolveTurnId(payload) };
}
```

- [ ] **Step 4: Run tests to verify pass** — same command as Step 2, plus the full existing `interactive-claude-hook.test.ts` suite (all prior `turnId: "hook-stop"` assertions must still pass since none of those payloads carry `prompt_id`).

- [ ] **Step 5: Commit.**
```bash
git add packages/agents/src/interactive/claude.ts packages/agents/src/__tests__/interactive-claude-hook.test.ts
git commit -m "$(cat <<'EOF'
feat(hooks): thread Stop hook prompt_id as the real per-turn turnId (#761)

Claude-Session: https://claude.ai/code/session_01MT9qzA3XYujdbXPgpF5HGz
EOF
)"
```

---

## Task 2 (#760): PermissionRequest hook + notification_type matcher

**Files:**
- Modify: `packages/agents/src/interactive/claude.ts`
- Modify: `packages/workspaces/src/native-hooks/native-hook-source.ts`
- Modify: `packages/cli/src/commands/hooks.ts`
- Modify: `CLAUDE.md` (managed hook set line)
- Test: `packages/agents/src/__tests__/interactive-claude-hook.test.ts`
- Test: `packages/workspaces/src/native-hooks/__tests__/native-hook-source.test.ts`
- Test: `packages/cli/src/commands/__tests__/hooks.test.ts`

**Interfaces:**
- Produces: `classifyNotification(payload: unknown): { kind: "blocked" | "input-requested" | "progress"; question?: string }` (exported, pure, replaces the inline substring branch in the `Notification` case; keeps `isPermissionNotification` exported and used as the fallback for payloads missing `notification_type`).
- Produces: `formatPermissionRequestQuestion(payload: unknown): string` (exported, pure) — builds a question from `tool_name` + a short, non-dumping summary of `tool_input`.
- Consumes: `FILE_PATH_FIELD_BY_TOOL` (already defined in `claude.ts`, reused for the tool_input summary hint).
- Renames: `nextAskUserQuestionRequestId` → `nextHookRequestId` (module-private counter, now shared by `PreToolUse`/`AskUserQuestion` and `Notification`/`agent_needs_input`).

**Verified payload shapes (2026-09-04 compat study, claude 2.1.260):**
```jsonc
// PermissionRequest
{ "hook_event_name": "PermissionRequest", "tool_name": "Write",
  "tool_input": { "file_path": "…", "content": "…" },
  "permission_suggestions": [...], "prompt_id": "...", "permission_mode": "default",
  "session_id": "...", "cwd": "..." }
// Notification — notification_type is REQUIRED (zod: not optional); message is required too.
// 14-value enum: permission_prompt idle_prompt auth_success elicitation_dialog
// agent_needs_input agent_completed elicitation_url_dialog worker_permission_prompt
// push_notification computer_use_enter computer_use_exit quota_auto_resume_fired
// quota_auto_resume_stale quota_auto_resume_disabled
```

- [ ] **Step 1: Write failing tests** in `interactive-claude-hook.test.ts`.

New `describe("mapClaudeHookToEvent Notification notification_type (#760)")`:
```ts
it("notification_type=permission_prompt → task.blocked even without permission wording in message", () => {
  const ev = mapClaudeHookToEvent("Notification", { message: "hi", notification_type: "permission_prompt" }, "task-abc");
  expect(ev).toEqual({
    type: "task.blocked", id: "task-abc",
    reason: "crew awaiting permission (notification hook)", question: "hi",
  });
});

it("notification_type=worker_permission_prompt → task.blocked", () => {
  const ev = mapClaudeHookToEvent("Notification", { message: "worker needs approval", notification_type: "worker_permission_prompt" }, "task-abc");
  expect(ev?.type).toBe("task.blocked");
});

it("notification_type=agent_needs_input → task.input.requested with a requestId", () => {
  const ev = mapClaudeHookToEvent("Notification", { message: "need input", notification_type: "agent_needs_input" }, "task-abc");
  expect(ev?.type).toBe("task.input.requested");
  expect(typeof (ev as any).requestId).toBe("number");
});

it("notification_type=idle_prompt → task.progress (liveness only, never blocked)", () => {
  const ev = mapClaudeHookToEvent("Notification", { message: "Claude is thinking", notification_type: "idle_prompt" }, "task-abc");
  expect(ev).toEqual({ type: "task.progress", id: "task-abc", note: "notification" });
});

it("notification_type=quota_auto_resume_fired → task.progress (no source yet, never blocked)", () => {
  const ev = mapClaudeHookToEvent("Notification", { message: "quota resumed", notification_type: "quota_auto_resume_fired" }, "task-abc");
  expect(ev).toEqual({ type: "task.progress", id: "task-abc", note: "notification" });
});

it("missing notification_type (older client) falls back to substring detection — permission message still blocks", () => {
  const ev = mapClaudeHookToEvent("Notification", { message: "Claude needs your permission" }, "task-abc");
  expect(ev?.type).toBe("task.blocked");
});

it("missing notification_type, non-permission message → task.progress (unchanged fallback)", () => {
  const ev = mapClaudeHookToEvent("Notification", { message: "Waiting for your input" }, "task-abc");
  expect(ev).toEqual({ type: "task.progress", id: "task-abc", note: "notification" });
});
```

New `describe("mapClaudeHookToEvent PermissionRequest (#760)")`:
```ts
it("maps PermissionRequest → task.blocked with a question naming the tool and a short input hint", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "/tmp/needs-approval.txt", content: "x".repeat(500) } };
  const ev = mapClaudeHookToEvent("PermissionRequest", payload, "task-abc");
  expect(ev?.type).toBe("task.blocked");
  const question = (ev as any).question as string;
  expect(question).toContain("Write");
  expect(question).toContain("/tmp/needs-approval.txt");
  expect(question.length).toBeLessThan(200); // never dumps the full 500-char content
});

it("maps PermissionRequest for Bash → question includes a truncated command hint", () => {
  const ev = mapClaudeHookToEvent("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }, "task-abc");
  expect((ev as any).question).toContain("Bash");
  expect((ev as any).question).toContain("rm -rf /tmp/x");
});

it("maps PermissionRequest with missing/malformed tool_input → still task.blocked, generic hint, never throws", () => {
  expect(mapClaudeHookToEvent("PermissionRequest", { tool_name: "Read" }, "task-abc")?.type).toBe("task.blocked");
  expect(mapClaudeHookToEvent("PermissionRequest", {}, "task-abc")?.type).toBe("task.blocked");
  expect(mapClaudeHookToEvent("PermissionRequest", null, "task-abc")?.type).toBe("task.blocked");
});

it("anti-#2576 invariant: PermissionRequest never emits task.done or task.failed", () => {
  const ev = mapClaudeHookToEvent("PermissionRequest", { tool_name: "Write", tool_input: {} }, "task-abc");
  expect(ev!.type).not.toBe("task.done");
  expect(ev!.type).not.toBe("task.failed");
});
```

Add `"PermissionRequest"` and `"Notification"` (already present) to the anti-#2576 sweep's `ALL_KNOWN` array is unnecessary (Notification already covered; PermissionRequest always returns `task.blocked` by design, covered above).

- [ ] **Step 2: Run to verify failure** — the `notification_type` tests fail against the current substring-only logic (e.g., `{ message: "hi", notification_type: "permission_prompt" }` currently → `task.progress` since "hi" has no permission wording). `PermissionRequest` tests fail with `mapClaudeHookToEvent` returning `null` (no case yet).

- [ ] **Step 3: Implement** in `claude.ts`.

Rename the counter and its two use sites:
```ts
let nextHookRequestId = Date.now();
```
(update the JSDoc above it to say "shared by AskUserQuestion PreToolUse and Notification agent_needs_input").

Add before `mapClaudeHookToEvent`:
```ts
/**
 * Pure: classify a Notification hook using the structured notification_type
 * field (required on current Claude clients — 14-value enum, verified live
 * 2026-09-04). Falls back to the pre-#760 English-substring test
 * (isPermissionNotification) only when notification_type is absent
 * (older clients) — never for a current client with an unrecognized value.
 */
export function classifyNotification(
  payload: unknown,
): { kind: "blocked" | "input-requested" | "progress"; question?: string } {
  const p = payload as { message?: unknown; notification_type?: unknown } | null | undefined;
  const msg = typeof p?.message === "string" ? p.message : "";
  const notificationType = typeof p?.notification_type === "string" ? p.notification_type : null;

  if (notificationType === "permission_prompt" || notificationType === "worker_permission_prompt") {
    return { kind: "blocked", question: msg || "crew awaiting permission" };
  }
  if (notificationType === "agent_needs_input") {
    return { kind: "input-requested", question: msg || "crew needs input" };
  }
  if (notificationType != null) {
    // idle_prompt, quota_auto_resume_*, auth_success, agent_completed, etc. —
    // liveness only. squadrant has no dedicated source for quota state yet (#760).
    return { kind: "progress" };
  }
  if (msg && isPermissionNotification(msg)) {
    return { kind: "blocked", question: msg };
  }
  return { kind: "progress" };
}

// Tool → tool_input field carrying a short, human-meaningful hint of WHAT is
// being asked (reuses the file-path map already defined for the memory-write
// guard). Never used to dump the full tool_input — only this one field, and
// truncated, so a PermissionRequest question never leaks large file contents.
const TOOL_INPUT_HINT_LEN = 80;
function summarizeToolInput(toolName: unknown, toolInput: unknown): string {
  if (typeof toolName !== "string" || !toolName) return "a tool call";
  const input = toolInput as Record<string, unknown> | null | undefined;
  if (!input || typeof input !== "object") return toolName;
  const hintField = FILE_PATH_FIELD_BY_TOOL[toolName] ?? (toolName === "Bash" ? "command" : undefined);
  const raw = hintField ? input[hintField] : undefined;
  if (typeof raw === "string" && raw) {
    const short = raw.length > TOOL_INPUT_HINT_LEN ? `${raw.slice(0, TOOL_INPUT_HINT_LEN)}…` : raw;
    return `${toolName}(${short})`;
  }
  return toolName;
}

/**
 * Pure: build a task.blocked question for a PermissionRequest hook. Never
 * serializes the full tool_input (#760 hard rule) — only a short, tool-
 * specific hint via summarizeToolInput.
 */
export function formatPermissionRequestQuestion(payload: unknown): string {
  const p = payload as { tool_name?: unknown; tool_input?: unknown } | null | undefined;
  return `crew needs permission to run ${summarizeToolInput(p?.tool_name, p?.tool_input)}`;
}
```

Update the `PreToolUse` case's requestId use (`nextAskUserQuestionRequestId++` → `nextHookRequestId++`).

Update the `Notification` case:
```ts
case "Notification": {
  const cls = classifyNotification(payload);
  if (cls.kind === "blocked") {
    return { type: "task.blocked", id: taskId, reason: "crew awaiting permission (notification hook)", question: cls.question! };
  }
  if (cls.kind === "input-requested") {
    return { type: "task.input.requested", id: taskId, requestId: nextHookRequestId++, question: cls.question! };
  }
  return { type: "task.progress", id: taskId, note: "notification" };
}
```

Add a new case (next to `Notification`):
```ts
case "PermissionRequest":
  // #760: fires ~6s before the matching Notification, with the tool name and
  // a rich (never fully dumped) input summary — a strictly better task.blocked
  // source. Re-blocking an already-blocked task is a no-op in the reducer
  // (task.blocked idempotency, #174), so this naturally dedups against a
  // Notification for the same prompt_id without extra state here.
  return {
    type: "task.blocked",
    id: taskId,
    reason: "crew awaiting permission (permission-request hook)",
    question: formatPermissionRequestQuestion(payload),
  };
```

Update `EVENTS` at the top of the file:
```ts
const EVENTS = ["Stop", "SubagentStop", "SessionEnd", "PostToolUse", "Notification", "UserPromptSubmit", "PermissionRequest"] as const;
```
(extend the comment block above it with a one-line note: `// PermissionRequest fires while a tool-use permission dialog is open — earlier and richer than Notification (#760).`)

- [ ] **Step 4: Run tests, verify pass.** Also re-run the full `interactive-claude-hook.test.ts` file — the existing `isPermissionNotification`-fallback tests and the two "two calls in quick succession get distinct requestIds" AskUserQuestion tests must still pass unchanged (renaming the counter doesn't change behavior).

- [ ] **Step 5: `native-hook-source.ts` — add the managed-set entry.**

Write/adjust failing tests first in `native-hook-source.test.ts`:
```ts
// replace the "7 subs across 6 event keys" test body:
it("installs hooks for all 8 lifecycle-relevant subs across 7 event keys", () => {
  const { opts, written } = makeInstallOpts();
  installClaudeHooks(opts);
  expect(written).toHaveLength(1);
  const result = JSON.parse(written[0].content);
  for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Notification", "SessionEnd", "PermissionRequest"]) {
    expect(result.hooks[ev]).toBeDefined();
    expect(Array.isArray(result.hooks[ev])).toBe(true);
    expect(result.hooks[ev].length).toBeGreaterThan(0);
  }
  expect(result.hooks["AskUserQuestion"]).toBeUndefined();
  expect(result.hooks.PreToolUse).toHaveLength(2);
});
```
And extend the "each installed hook entry uses the correct sub-command alias" test's `singleEntryExpectations` array with `["PermissionRequest", "permission-request"]`.

Implement: add `["PermissionRequest", "permission-request"]` to `CLAUDE_HOOK_EVENTS`, and `case "permission-request": return "needsInput";` to `mapSubToLifecycle`.

- [ ] **Step 6: `hooks.ts` — wire the sub-alias.**

Test in `hooks.test.ts` (extend the "other subs still map as before" test or add a new one):
```ts
it("permission-request delegates to mapClaudeHookToEvent PermissionRequest (#760)", () => {
  const ev = mapHookSub("permission-request", { tool_name: "Write", tool_input: { file_path: "/tmp/x" } }, "task-abc");
  expect(ev?.type).toBe("task.blocked");
});
```
Implement: add `case "permission-request": return mapClaudeHookToEvent("PermissionRequest", payload, taskId);` to `mapHookSub`, and extend its doc-comment list.

- [ ] **Step 7: Update `CLAUDE.md`'s managed-hook-set line** (the `## Managed ~/.claude/settings.json (#615)` section) to read `... PreToolUse (incl. the AskUserQuestion tool matcher) / Stop / Notification / SessionEnd / PermissionRequest ...`.

- [ ] **Step 8: Run the full test suite for the three touched packages** (`pnpm --filter @squadrant/agents --filter @squadrant/workspaces --filter @squadrant/cli test`) and fix any fallout.

- [ ] **Step 9: Commit.**
```bash
git add packages/agents/src/interactive/claude.ts packages/agents/src/__tests__/interactive-claude-hook.test.ts \
        packages/workspaces/src/native-hooks/native-hook-source.ts packages/workspaces/src/native-hooks/__tests__/native-hook-source.test.ts \
        packages/cli/src/commands/hooks.ts packages/cli/src/commands/__tests__/hooks.test.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(hooks): register PermissionRequest + classify Notification by notification_type (#760)

Claude-Session: https://claude.ai/code/session_01MT9qzA3XYujdbXPgpF5HGz
EOF
)"
```

---

## Task 3 (#762): background_tasks / session_crons structural veto

**Files:**
- Modify: `packages/agents/src/interactive/claude.ts` (Stop case)
- Test: `packages/agents/src/__tests__/interactive-claude-hook.test.ts`

**Interfaces:**
- Produces: `hasActiveBackgroundWork(payload: unknown): boolean` (exported, pure). `true` iff `payload.background_tasks` is a non-empty array OR `payload.session_crons` is a non-empty array. Absent/non-array/empty → `false` (matches cmux's own absence-means-false handling).
- Consumes: nothing new. Composes with the existing Stop case's trailing-question check (question detection still wins — an explicit question is a stronger signal than a background-task veto) and with Task 1's `resolveTurnId`/`logStopPermissionMode`.

- [ ] **Step 1: Write failing tests**, new `describe("mapClaudeHookToEvent Stop background_tasks/session_crons veto (#762)")`:
```ts
it("hasActiveBackgroundWork: false when both fields absent", () => {
  expect(hasActiveBackgroundWork({})).toBe(false);
  expect(hasActiveBackgroundWork(null)).toBe(false);
});

it("hasActiveBackgroundWork: false when both present but empty (matches cmux's absence-means-false)", () => {
  expect(hasActiveBackgroundWork({ background_tasks: [], session_crons: [] })).toBe(false);
});

it("hasActiveBackgroundWork: true when background_tasks is non-empty", () => {
  expect(hasActiveBackgroundWork({ background_tasks: [{ status: "running" }], session_crons: [] })).toBe(true);
});

it("hasActiveBackgroundWork: true when session_crons is non-empty", () => {
  expect(hasActiveBackgroundWork({ background_tasks: [], session_crons: [{ id: "cron-1" }] })).toBe(true);
});

it("Stop with non-empty background_tasks → task.progress instead of task.turn.completed", () => {
  const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Done.", background_tasks: [{ status: "running" }] }, "task-abc");
  expect(ev).toEqual({ type: "task.progress", id: "task-abc", note: "stop-background-work" });
});

it("Stop with non-empty session_crons → task.progress instead of task.turn.completed", () => {
  const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Done.", session_crons: [{ id: "c1" }] }, "task-abc");
  expect(ev).toEqual({ type: "task.progress", id: "task-abc", note: "stop-background-work" });
});

it("Stop with empty background_tasks/session_crons → unchanged task.turn.completed", () => {
  const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Done.", background_tasks: [], session_crons: [] }, "task-abc");
  expect(ev).toEqual({ type: "task.turn.completed", id: "task-abc", turnId: "hook-stop" });
});

it("Stop with no background_tasks/session_crons fields at all → unchanged task.turn.completed", () => {
  const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Done." }, "task-abc");
  expect(ev).toEqual({ type: "task.turn.completed", id: "task-abc", turnId: "hook-stop" });
});

it("a trailing question STILL wins over an active background-task veto (explicit human ask beats liveness)", () => {
  const ev = mapClaudeHookToEvent("Stop", { last_assistant_message: "Which config should I use?", background_tasks: [{ status: "running" }] }, "task-abc");
  expect(ev?.type).toBe("task.blocked");
});
```
Add `hasActiveBackgroundWork` to the test file's import line.

- [ ] **Step 2: Run to verify failure** — background_tasks/session_crons tests fail (function doesn't exist / Stop ignores the fields).

- [ ] **Step 3: Implement** in `claude.ts`, above `mapClaudeHookToEvent`:
```ts
/**
 * Pure: #762. A Stop payload's background_tasks/session_crons are a
 * structural, agent-reported veto on turn-completion — stronger than the
 * #492 pendingTool veto because it also covers Claude's own background
 * tasks and session crons, which pendingTool cannot see. Both fields are
 * .optional() on the wire; absence must mean false (matches cmux's own
 * hasActiveClaudeBackgroundWork handling).
 */
export function hasActiveBackgroundWork(payload: unknown): boolean {
  const p = payload as { background_tasks?: unknown; session_crons?: unknown } | null | undefined;
  const tasks = p?.background_tasks;
  if (Array.isArray(tasks) && tasks.length > 0) return true;
  const crons = p?.session_crons;
  if (Array.isArray(crons) && crons.length > 0) return true;
  return false;
}
```
Update the Stop case:
```ts
case "Stop": {
  const text = resolveLastAssistantText(payload);
  const question = text ? detectTrailingQuestion(text) : null;
  if (question) {
    return { type: "task.blocked", id: taskId, reason: "crew asked a question (auto-detected)", question };
  }
  if (hasActiveBackgroundWork(payload)) {
    // #762: the turn ended but background_tasks/session_crons are still
    // running — not a genuine turn boundary. Liveness only, same class as
    // the #492 pendingTool veto.
    return { type: "task.progress", id: taskId, note: "stop-background-work" };
  }
  logStopPermissionMode(payload, taskId);
  return { type: "task.turn.completed", id: taskId, turnId: resolveTurnId(payload) };
}
```

- [ ] **Step 4: Run tests, verify pass** — full `interactive-claude-hook.test.ts` file (all pre-existing Stop tests use payloads without `background_tasks`/`session_crons`, so `hasActiveBackgroundWork` returns `false` for every one of them — no regression expected, but verify).

- [ ] **Step 5: Commit.**
```bash
git add packages/agents/src/interactive/claude.ts packages/agents/src/__tests__/interactive-claude-hook.test.ts
git commit -m "$(cat <<'EOF'
feat(hooks): veto Stop turn-completion on active background_tasks/session_crons (#762)

Claude-Session: https://claude.ai/code/session_01MT9qzA3XYujdbXPgpF5HGz
EOF
)"
```

---

## Task 4 (#763): StopFailure source

**Files:**
- Modify: `packages/shared/src/types/control.ts` (new `ControlEvent` variant)
- Modify: `packages/agents/src/interactive/claude.ts` (new case + EVENTS entry + redaction helper)
- Modify: `packages/workspaces/src/native-hooks/native-hook-source.ts` (managed set + lifecycle mapping)
- Modify: `packages/cli/src/commands/hooks.ts` (sub-alias wiring)
- Modify: `packages/core/src/state-machine.ts` (reducer case)
- Modify: `packages/core/src/daemon/reduce.ts` (`KNOWN_EVENT_TYPES` + `formatMessage`)
- Modify: `CLAUDE.md` (managed hook set line)
- Regenerate: `docs/generated/control-events.md` (`node scripts/control-event-table.mjs`)
- Test: `packages/agents/src/__tests__/interactive-claude-hook.test.ts`
- Test: `packages/workspaces/src/native-hooks/__tests__/native-hook-source.test.ts`
- Test: `packages/cli/src/commands/__tests__/hooks.test.ts`
- Test: `packages/core/src/__tests__/state-machine.test.ts`
- Test: `packages/core/src/__tests__/daemon.test.ts`

**Interfaces:**
- Produces: new `ControlEvent` variant `{ type: "task.turn.failed"; id: string; turnId: string; error: string }`.
- Produces: `redactApiError(error: unknown): string` (exported, pure, in `claude.ts`) — truncates to 300 chars and scrubs common secret-shaped substrings (Anthropic keys, GitHub tokens, Telegram bot tokens) before it ever becomes a captain-facing string.
- Consumes: `resolveTurnId` (Task 1) — `StopFailure` also carries `prompt_id`, reuse the same resolver.

**Verified payload shape (2026-09-04 compat study, claude 2.1.260):** `StopFailure` — "turn ends due to an API error" — carries `error`, `error_details`, `last_assistant_message` (and, like `Stop`, `prompt_id`/`session_id`/`cwd`).

Design decision (record in the PR description): the state transition for `task.turn.failed` is **identical** to `task.turn.completed` (turn boundary → `awaiting-input`, respecting the same `#492` pendingTool/pendingMonitor veto and the `#608` sticky-attention guard) — it is intentionally NOT a new `TaskState` and NOT `failed` (anti-#2576: no Claude hook may terminalize to `failed`). The only difference is the notify message text, which must say "API error, not a stall" so the watchdog's stall-detection is never confused with this — and structurally can't double-report, because the record already left `working` for `awaiting-input` the instant the hook fires, exactly like a normal turn-end.

- [ ] **Step 1: Write failing tests.**

`interactive-claude-hook.test.ts`, new `describe("mapClaudeHookToEvent StopFailure (#763)")`:
```ts
it("maps StopFailure → task.turn.failed carrying the resolved turnId and a redacted error", () => {
  const ev = mapClaudeHookToEvent("StopFailure", { prompt_id: "p-1", error: "529 Overloaded" }, "task-abc");
  expect(ev).toEqual({ type: "task.turn.failed", id: "task-abc", turnId: "p-1", error: "529 Overloaded" });
});

it("StopFailure without prompt_id → turnId falls back to the constant", () => {
  const ev = mapClaudeHookToEvent("StopFailure", { error: "network timeout" }, "task-abc");
  expect(ev).toEqual({ type: "task.turn.failed", id: "task-abc", turnId: "hook-stop", error: "network timeout" });
});

it("StopFailure with missing error → a generic placeholder, never throws", () => {
  const ev = mapClaudeHookToEvent("StopFailure", {}, "task-abc");
  expect(ev).toEqual({ type: "task.turn.failed", id: "task-abc", turnId: "hook-stop", error: "unknown API error" });
});

it("anti-#2576 invariant: StopFailure never emits task.done or task.failed", () => {
  const ev = mapClaudeHookToEvent("StopFailure", { error: "x" }, "task-abc");
  expect(ev!.type).not.toBe("task.done");
  expect(ev!.type).not.toBe("task.failed");
});

it("redactApiError truncates long error text", () => {
  expect(redactApiError("x".repeat(500)).length).toBeLessThanOrEqual(301);
});

it("redactApiError scrubs an embedded Anthropic API key", () => {
  const scrubbed = redactApiError("failed with key sk-ant-api03-abcdefghijklmnop");
  expect(scrubbed).not.toContain("sk-ant-api03-abcdefghijklmnop");
});

it("redactApiError falls back to a generic label for a non-string/empty error", () => {
  expect(redactApiError(undefined)).toBe("unknown API error");
  expect(redactApiError("")).toBe("unknown API error");
});
```

`native-hook-source.test.ts` — bump the count test again (8→9 subs, 7→8 event keys) and extend `singleEntryExpectations` with `["StopFailure", "stop-failure"]`.

`hooks.test.ts` — add:
```ts
it("stop-failure delegates to mapClaudeHookToEvent StopFailure (#763)", () => {
  const ev = mapHookSub("stop-failure", { error: "529" }, "task-abc");
  expect(ev?.type).toBe("task.turn.failed");
});
```

`state-machine.test.ts`, new tests modeled on the existing `task.turn.completed` block:
```ts
it("task.turn.failed transitions working → awaiting-input, same as task.turn.completed (#763)", () => {
  const next = reduce(rec({ state: "working" }), { type: "task.turn.failed", id: "t1", turnId: "p1", error: "529" }, 8000);
  expect(next.state).toBe("awaiting-input");
});

it("task.turn.failed respects the #492 pendingTool veto", () => {
  const open = reduce(rec({ state: "working" }), { type: "task.progress", id: "t1", note: "agent.hook.PreToolUse", tool: "Bash" }, 7000);
  const stillOpen = reduce(open, { type: "task.turn.failed", id: "t1", turnId: "p1", error: "529" }, 8000);
  expect(stillOpen.state).toBe("working");
});

it("task.turn.failed does NOT auto-unblock a blocked task (#608 sticky-attention guard)", () => {
  const blocked = reduce(rec({ state: "blocked", question: "q?" }), { type: "task.turn.failed", id: "t1", turnId: "p1", error: "529" }, 5000);
  expect(blocked.state).toBe("blocked");
  expect(blocked.question).toBe("q?");
});
```
(`rec()` helper already exists in this file — reuse it, do not redefine.)

`daemon.test.ts`, new test modeled on the existing `CREW IDLE` messaging tests (find the pattern around the `crewTag`/`formatMessage` CREW IDLE assertions and mirror its store/daemon setup):
```ts
it("task.turn.failed produces a CREW-facing message naming an API error, not a stall (#763)", async () => {
  const store = createStore(dir);
  store.put(rec("t-api-err", { state: "working" }));
  const calls: any[] = [];
  const d = createDaemon({ store, now: () => 999999, notify: async (a) => { calls.push(a); } });
  await d.handle({ kind: "event", project: "p", event: { type: "task.turn.failed", id: "t-api-err", turnId: "p1", error: "529 Overloaded" } });
  expect(calls).toHaveLength(1);
  expect(calls[0].message).toMatch(/API error/i);
  expect(calls[0].message).not.toMatch(/no heartbeat/i); // never worded like a stall
  expect(calls[0].message).toContain("529 Overloaded");
});
```

- [ ] **Step 2: Run all five test files to verify the new tests fail** (new type doesn't exist yet, so this also needs a `tsc`/build check after adding the type — expect vitest to fail on missing case handling and TS to flag the literal type mismatch once you touch the switch).

- [ ] **Step 3: Add the `ControlEvent` variant.** In `packages/shared/src/types/control.ts`, add after `task.turn.completed`:
```ts
  | { type: "task.turn.completed"; id: string; turnId: string }
  // #763: a crew's turn died on an API error (e.g. 529/overload) — Claude's
  // StopFailure hook. Anti-#2576: NOT task.failed — a hook may never
  // terminalize a task. Structurally identical to task.turn.completed (same
  // turn-boundary transition, same #492 pendingTool veto, same #608 sticky-
  // attention guard); only the notify message differs, so the watchdog's
  // stall path is never independently triggered for the same turn — the
  // record has already left 'working' for 'awaiting-input' by the time the
  // hook fires.
  | { type: "task.turn.failed"; id: string; turnId: string; error: string }
  | { type: "task.delta"; id: string; turnId: string; chunk: string }
```

- [ ] **Step 4: Implement `claude.ts`.** Add above `mapClaudeHookToEvent`:
```ts
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,          // Anthropic API key
  /gh[pousr]_[A-Za-z0-9]{10,}/g,          // GitHub token
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,       // Telegram bot token shape
];
const MAX_API_ERROR_LEN = 300;

/**
 * Pure: #763. A StopFailure error string is captain-facing (CREW notify text,
 * possibly a filed issue later) — apply the same redaction discipline as
 * CLAUDE.md's bug-report rules (strip API keys / gh tokens / Telegram bot
 * tokens) and cap length so a verbose provider error never floods a notify.
 */
export function redactApiError(error: unknown): string {
  if (typeof error !== "string" || !error.trim()) return "unknown API error";
  let scrubbed = error.trim();
  for (const re of SECRET_PATTERNS) scrubbed = scrubbed.replace(re, "[redacted]");
  return scrubbed.length > MAX_API_ERROR_LEN ? `${scrubbed.slice(0, MAX_API_ERROR_LEN)}…` : scrubbed;
}
```
Add the case (next to `Stop`):
```ts
case "StopFailure":
  // #763: the turn died on an API error (529/overload/etc) — today squadrant
  // has NO source for this; the watchdog eventually reports a stall, which is
  // the wrong story. Distinct from Stop: never treated as a genuine
  // turn.completed AND never task.failed (anti-#2576 — no hook terminalizes).
  return {
    type: "task.turn.failed",
    id: taskId,
    turnId: resolveTurnId(payload),
    error: redactApiError((payload as { error?: unknown } | null | undefined)?.error),
  };
```
Add `"StopFailure"` to the `EVENTS` array:
```ts
const EVENTS = ["Stop", "SubagentStop", "SessionEnd", "PostToolUse", "Notification", "UserPromptSubmit", "PermissionRequest", "StopFailure"] as const;
```

- [ ] **Step 5: Implement `native-hook-source.ts`.** Add `["StopFailure", "stop-failure"]` to `CLAUDE_HOOK_EVENTS`, and `case "stop-failure": return "idle";` to `mapSubToLifecycle` (a StopFailure ends the turn, same coarse bucket as `"stop"`).

- [ ] **Step 6: Implement `hooks.ts`.** Add `case "stop-failure": return mapClaudeHookToEvent("StopFailure", payload, taskId);` to `mapHookSub`.

- [ ] **Step 7: Implement `state-machine.ts`.** In `reduce()`'s switch, change:
```ts
    case "task.turn.completed":
```
to:
```ts
    case "task.turn.failed":
    case "task.turn.completed":
```
(the shared body already only references `rec`/`base`/`ev.type` — no field access specific to one variant — so no other change needed; `base.lastEvent` is stamped from the actual `ev.type` before the switch runs).

- [ ] **Step 8: Implement `reduce.ts`.**

Add `"task.turn.failed"` to `KNOWN_EVENT_TYPES`.

In `formatMessage`, change the `case "awaiting-input":` branch:
```ts
    case "awaiting-input":
      // #763: a turn that ended on an API error reads very differently from
      // a genuine turn-end — must not be worded like a stall (that story is
      // reserved for the 'stalled' state's own heartbeat-timeout message).
      if (event?.type === "task.turn.failed") {
        return `CREW TURN FAILED ${tag}: API error ended the turn (not a stall) — ${event.error}`;
      }
      // #522: 'awaiting-input' is reached via a genuine turn-boundary event
      // ...
      return `CREW IDLE ${tag}: turn ended, awaiting your reply.`;
```

- [ ] **Step 9: Update `CLAUDE.md`'s managed-hook-set line** to also list `StopFailure`.

- [ ] **Step 10: Run every touched test file, verify pass** — `pnpm --filter @squadrant/shared --filter @squadrant/agents --filter @squadrant/workspaces --filter @squadrant/cli --filter @squadrant/core test`.

- [ ] **Step 11: Regenerate the generated docs.**
```bash
node scripts/control-event-table.mjs
node scripts/control-event-table.mjs --check   # must exit 0
```
Review the diff to `docs/generated/control-events.md` — `task.turn.failed` should show a producer at `packages/agents/src/interactive/claude.ts` with a ✓ in the state-machine and reduce.ts-allowlist columns.

- [ ] **Step 12: Full gate.**
```bash
pnpm build && pnpm test && node dist/index.js --help
```

- [ ] **Step 13: Commit.**
```bash
git add packages/shared/src/types/control.ts packages/agents/src/interactive/claude.ts packages/agents/src/__tests__/interactive-claude-hook.test.ts \
        packages/workspaces/src/native-hooks/native-hook-source.ts packages/workspaces/src/native-hooks/__tests__/native-hook-source.test.ts \
        packages/cli/src/commands/hooks.ts packages/cli/src/commands/__tests__/hooks.test.ts \
        packages/core/src/state-machine.ts packages/core/src/__tests__/state-machine.test.ts \
        packages/core/src/daemon/reduce.ts packages/core/src/__tests__/daemon.test.ts \
        CLAUDE.md docs/generated/control-events.md
git commit -m "$(cat <<'EOF'
feat(hooks): add StopFailure source for API-error turn deaths (#763)

Claude-Session: https://claude.ai/code/session_01MT9qzA3XYujdbXPgpF5HGz
EOF
)"
```

---

## Final: PR

- [ ] Push the branch, open a PR to `develop` titled to cover all four issues, body with `Closes #760, closes #761, closes #762, closes #763` plus a per-issue summary (see task instructions), ending with the session link. Then `squadrant crew signal review`.

## Self-Review Notes

- **Scope decision, recorded for the PR body:** `packages/core/src/events/*` (the newer fact-based event module, opencode-direct/claude-shadow per the 2026-08-29 design) is deliberately NOT touched — it has no Stop/PermissionRequest/StopFailure fact producer for claude today, so extending its schema is a separate follow-up, not part of these four issues. The live path for all four issues is `native-hook-source.ts` + `hooks.ts` (captain) and the `EVENTS`/`_hook` path (crew), both converging on `mapClaudeHookToEvent`.
- **`telegram/format.ts` / `telegram/tiers.ts`:** not modified. `formatLifecycle`'s `default:` branch already renders any unhandled `ControlEvent` type as a generic info line, so `task.turn.failed` and `task.blocked`-from-`PermissionRequest` degrade gracefully without a dedicated case. Adding one would be a reasonable follow-up but is not required by the four issues' stated proposals.
