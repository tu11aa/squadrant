// hooks.ts — 'squadrant hooks <agent> <sub>' — lifecycle hook receiver for NativeHookSource.
//
// The NativeHookSource installer writes 'squadrant hooks claude <sub>' into
// ~/.claude/settings.json. When claude fires a hook, this command:
//   1. reads SQUADRANT_CREW_TASK_ID + SQUADRANT_CREW_PROJECT from the inherited env
//   2. drains stdin for the JSON payload claude passes to every hook
//   3. maps the sub-alias to the appropriate ControlEvent
//   4. sends { kind: "event" } to the daemon via the existing IPC path
//
// Always exits 0 — claude's hook contract requires it (non-zero blocks the conversation).
import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { sendRequest, readUndelivered, resolveCurrentProject, computeRulesInjection, computeProfileInjection, withBudget, INJECT_BUDGET_MS } from "@squadrant/core";
import { mapClaudeHookToEvent, deriveTranscriptPath, decideCaptainMemoryWrite, decideAttributionTrailer, decideSubagentCrewSignal, readAttributionDisabled } from "@squadrant/agents";
import { loadConfig, DAEMON_SOCK_PATH, workspacePath, stateRoot, userKbDir } from "@squadrant/shared";
import type { ControlEvent, SquadrantConfig, TaskRecord } from "@squadrant/shared";
import type { CaptainSessionRecord } from "../lib/handoff-facts.js";
import { appendCaptainSession } from "../lib/captain-session-registry.js";
import { compactHandoffContext, appendAdditionalContext, isCaptainCompactStart } from "../lib/compact-handoff.js";
import { renderLiveLedger } from "../lib/compact-ledger.js";
import { gatherLiveCrews, defaultCommandRunner } from "../lib/handoff-live-repo.js";
import { runGatePermissionRequest } from "./gate.js";

const SOCK = DAEMON_SOCK_PATH;

async function sendToSock(req: unknown): Promise<void> {
  await sendRequest(SOCK, req);
}

/**
 * Map a NativeHookSource sub-alias to a ControlEvent.
 *
 * "stop", "notification", "session-end" delegate to mapClaudeHookToEvent (which
 * handles detectTrailingQuestion and classifyNotification). "ask-question"
 * also delegates to it (#560) — it fires from the same PreToolUse+AskUserQuestion
 * matcher as the crew's own hook set, so it must extract the real question/options
 * from tool_input the same way (the previous inline version read a `payload.question`
 * field that doesn't exist in Claude's actual PreToolUse payload, so it always fell
 * back to a generic placeholder). "permission-request" delegates to it too (#760) —
 * a dedicated, earlier, richer permission signal than Notification. "stop-failure"
 * delegates to it too (#763) — a crew turn killed by an API error. The remaining
 * subs are handled inline.
 */
export function mapHookSub(sub: string, payload: unknown, taskId: string): ControlEvent | null {
  switch (sub) {
    case "session-start":
      // #1089: SessionStart(compact) is not activity — its `task.progress` resumed an idle crew to
      // 'working'. The daemon closes the compact via `crew-compact-done` instead.
      if ((payload as { source?: unknown } | null)?.source === "compact") return null;
      return { type: "task.progress", id: taskId, note: sub };
    case "pre-tool-use":
      return { type: "task.progress", id: taskId, note: sub };
    case "prompt-submit":
      // #470: NativeHookSource path mirrors the crew _hook UserPromptSubmit path.
      // Reducer stamps firstTurnConfirmedAt only once; subsequent submits become liveness.
      return { type: "task.first-turn.confirmed", id: taskId };
    case "stop":
      return mapClaudeHookToEvent("Stop", payload, taskId);
    case "stop-failure":
      return mapClaudeHookToEvent("StopFailure", payload, taskId);
    case "notification":
      return mapClaudeHookToEvent("Notification", payload, taskId);
    case "ask-question":
      return mapClaudeHookToEvent("PreToolUse", payload, taskId);
    case "permission-request":
      return mapClaudeHookToEvent("PermissionRequest", payload, taskId);
    case "session-end":
      return mapClaudeHookToEvent("SessionEnd", payload, taskId);
    default:
      return null;
  }
}

/**
 * Pure. Builds a captain-sessions.jsonl record from a raw SessionStart hook
 * payload — #651's ground-truth attribution, recorded at the source instead
 * of inferred later from file mtimes or transcript content. Prefers the
 * documented `transcript_path` field when Claude provides it; falls back to
 * deriving it from session_id+cwd (same layered approach already used for
 * #174's last-assistant-text resolution). Returns null when there's no
 * session_id to key the record on — nothing meaningful to record.
 */
export function buildCaptainSessionRecord(
  payload: unknown,
  project: string,
  fallbackCwd: string,
  now: string,
): CaptainSessionRecord | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { session_id?: unknown; cwd?: unknown; transcript_path?: unknown };

  const sessionId = typeof p.session_id === "string" && p.session_id ? p.session_id : null;
  if (!sessionId) return null;

  const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : fallbackCwd;
  const transcriptPath =
    (typeof p.transcript_path === "string" && p.transcript_path ? p.transcript_path : null) ??
    deriveTranscriptPath(sessionId, cwd) ??
    "";

  return { sessionId, project, agent: "claude", startedAt: now, cwd, transcriptPath };
}

/**
 * I/O: resolve the current project (cwd-based, same as `squadrant dispatch`)
 * and append a session record to that project's registry. Best-effort —
 * never throws, never blocks the hook contract (exit 0 either way).
 */
function recordCaptainSessionStart(payload: unknown): void {
  try {
    const config = loadConfig();
    const project = resolveCurrentProject(config);
    if (!project || !config.projects[project]) return;

    const record = buildCaptainSessionRecord(payload, project, process.cwd(), new Date().toISOString());
    if (!record) return;

    appendCaptainSession(workspacePath(project), record);
  } catch {
    // Best-effort — a registry-write failure must never block the session.
  }
}

/** #1015: best-effort — a daemon that is down simply contributes no ledger. */
async function runCrewList(project: string): Promise<Array<{ name: string }>> {
  return (await import("./crew.js")).runCrewList(project);
}

export async function compactLedgerContext(project: string): Promise<string> {
  try {
    const projPath = loadConfig().projects[project]?.path ?? process.cwd();
    const tasks = (await sendRequest(SOCK, { kind: "list", project })) as TaskRecord[];
    // Crews that signalled done but still have a tab are waiting on this captain — keep them.
    const openTabs = await runCrewList(project).then((l) => new Set(l.map((c) => c.name))).catch(() => new Set<string>());
    const crews = gatherLiveCrews(tasks, defaultCommandRunner, projPath, openTabs);
    return renderLiveLedger(crews, await readUndelivered(stateRoot(), project));
  } catch {
    return "";
  }
}

type RulesSub = { event: "session-start" | "prompt-submit" | "post-read"; hookEventName: string };

/** Per agent: hook sub-command → rules event and the hookEventName the agent expects back. */
const RULES_HOOK_SUBS: Record<string, Record<string, RulesSub>> = {
  claude: {
    "session-start": { event: "session-start", hookEventName: "SessionStart" },
    "prompt-submit": { event: "prompt-submit", hookEventName: "UserPromptSubmit" },
    "post-tool-use": { event: "post-read", hookEventName: "PostToolUse" },
  },
  codex: {
    "session-start": { event: "session-start", hookEventName: "SessionStart" },
    "prompt-submit": { event: "prompt-submit", hookEventName: "UserPromptSubmit" },
    "post-tool-use": { event: "post-read", hookEventName: "PostToolUse" },
  },
  gemini: {
    "session-start": { event: "session-start", hookEventName: "SessionStart" },
    "before-agent": { event: "prompt-submit", hookEventName: "BeforeAgent" },
    "after-tool": { event: "post-read", hookEventName: "AfterTool" },
  },
  // opencode has no hook protocol: the squadrant plugin pipes a synthesized payload and reads additionalContext.
  opencode: {
    "session-start": { event: "session-start", hookEventName: "session" },
    "chat-message": { event: "prompt-submit", hookEventName: "chat.message" },
    "tool-after": { event: "post-read", hookEventName: "tool.execute.after" },
  },
};

/**
 * #899/#900: Rules KB injection for an agent's session / prompt / after-read hooks. Returns the
 * hook's stdout JSON (`hookSpecificOutput.additionalContext`), or "" when there
 * is nothing to inject. Never throws: a slow or failing lookup yields "" so a
 * rules problem can never block a session or prompt. Purely additive — the
 * lifecycle event for the same sub is still sent by the caller.
 */
export async function rulesHookOutput(
  sub: string,
  payload: unknown,
  opts: {
    env: NodeJS.ProcessEnv; cwd: string; project?: string; agent?: string;
    loadCfg?: () => SquadrantConfig; stateRoot?: string; budgetMs?: number;
  },
): Promise<string> {
  const agent = opts.agent ?? "claude";
  const map = RULES_HOOK_SUBS[agent]?.[sub];
  if (!map) return "";
  if (opts.env.SQUADRANT_RULES_INJECT === "0") return "";
  const ctx = await withBudget(() => computeRulesInjection({
    event: map.event, payload, env: opts.env, cwd: opts.cwd, project: opts.project, agent,
    cfg: (opts.loadCfg ?? loadConfig)(),
    stateRoot: opts.stateRoot ?? stateRoot(),
  }), opts.budgetMs ?? INJECT_BUDGET_MS);
  if (!ctx) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: map.hookEventName, additionalContext: ctx } });
}

/** The sub-command every agent's profile hook calls (#982): its own command, so its own additionalContext string. */
export const PROFILE_HOOK_SUB = "profile-session-start";

/** hookEventName the agent expects back for its session-start point (opencode's plugin ignores it). */
const SESSION_EVENT_NAME: Record<string, string> = { claude: "SessionStart", codex: "SessionStart", gemini: "SessionStart", opencode: "session" };

/**
 * #982: the operator profile block for any agent's session start. Output holds only the profile block, never
 * rules. Never throws: an error, an empty `_user` or a blown budget yields "" (fail-open).
 */
export async function profileHookOutput(
  payload: unknown,
  opts: { env: NodeJS.ProcessEnv; cwd: string; agent?: string; loadCfg?: () => SquadrantConfig; budgetMs?: number },
): Promise<string> {
  const agent = opts.agent ?? "claude";
  if (opts.env.SQUADRANT_PROFILE_INJECT === "0") return "";
  const ctx = await withBudget(() => computeProfileInjection({
    payload, env: opts.env, cwd: opts.cwd, agent, cfg: (opts.loadCfg ?? loadConfig)(),
  }), opts.budgetMs ?? INJECT_BUDGET_MS);
  if (!ctx) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: SESSION_EVENT_NAME[agent] ?? "SessionStart", additionalContext: ctx } });
}

/**
 * #556 + #982: decide a crew PreToolUse call against the captain-memory dirs and the `_user` KB. A config
 * error falls back to the env/default `_user` path rather than dropping the guard.
 */
export function preToolUseGuard(
  payload: unknown, env: NodeJS.ProcessEnv, home: string, loadCfg: () => SquadrantConfig = loadConfig,
): ReturnType<typeof decideCaptainMemoryWrite> {
  const p = payload as { tool_name?: unknown; tool_input?: unknown } | undefined;
  let ukb: string;
  try { ukb = userKbDir(loadCfg(), env); } catch { ukb = userKbDir(undefined, env); }
  return decideCaptainMemoryWrite(typeof p?.tool_name === "string" ? p.tool_name : "", p?.tool_input, env, home, ukb);
}

/** #1007: decide a PreToolUse call (captain or crew) against the operator's disabled-attribution setting. */
export function attributionGuard(
  payload: unknown, home: string,
): ReturnType<typeof decideAttributionTrailer> {
  const p = payload as { tool_name?: unknown; tool_input?: unknown } | undefined;
  if (p?.tool_name !== "Bash") return { decision: "allow" };
  return decideAttributionTrailer("Bash", p.tool_input, readAttributionDisabled(home));
}

function denyPreToolUse(reason: string | undefined): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }));
  process.exit(0);
}

async function readStdinJson(): Promise<unknown> {
  let stdin = "";
  try { for await (const chunk of process.stdin) stdin += chunk as string; } catch { /* ignore */ }
  if (!stdin.trim()) return undefined;
  try { return JSON.parse(stdin); } catch { return undefined; }
}

export function hooksCommand(): Command {
  const hooks = new Command("hooks")
    .description("(internal) receive lifecycle hook events from agent processes");

  hooks
    .command("claude <sub>", { hidden: true })
    .description("internal: bridge a NativeHookSource claude hook to squadrantd")
    .option("--project <name>", "project for rules injection (default: SQUADRANT_CREW_PROJECT, then cwd)")
    .action(async (sub: string, opts: { project?: string }) => {
      // Read stdin FIRST — it's needed by both the captain path below and
      // the crew path further down, and a stream can only be drained once.
      let stdin = "";
      try {
        for await (const chunk of process.stdin) stdin += chunk as string;
      } catch { /* ignore */ }
      let payload: unknown = undefined;
      if (stdin.trim()) {
        try { payload = JSON.parse(stdin); } catch { /* ignore malformed */ }
      }

      // #982: the profile hook is its own command and emits nothing else (no rules, no lifecycle event).
      if (sub === PROFILE_HOOK_SUB) {
        const out = await profileHookOutput(payload, { env: process.env, cwd: process.cwd(), agent: "claude" });
        if (out) await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()));
        process.exit(0);
      }

      // #899: inject Rules KB context first, for every claude session (captain,
      // crew, plain). Await the write so a later process.exit can't truncate it.
      let rulesOut = await rulesHookOutput(sub, payload, { env: process.env, cwd: process.cwd(), project: opts.project });
      // #1010: a captain whose context was just compacted gets its handoff back, folded into the
      // same JSON document (stdout must stay one object). Fail-open: any error injects nothing.
      if (sub === "session-start") {
        try {
          const project = opts.project ?? resolveCurrentProject(loadConfig());
          rulesOut = appendAdditionalContext(rulesOut, compactHandoffContext(payload, process.env, project));
          if (project && isCaptainCompactStart(payload, process.env, project)) {
            // #1015: the daemon's live crew ledger + undelivered mailbox, then lift the delivery
            // hold — in that order, so nothing is typed into the box before the context is out.
            rulesOut = appendAdditionalContext(rulesOut, await compactLedgerContext(project));
            await sendToSock({ kind: "captain-compact-done", project }).catch(() => {});
          }
          // #1051: a crew's session just finished a compact — lift the hold `crew send` waits on.
          const crewTaskId = process.env.SQUADRANT_CREW_TASK_ID;
          if (crewTaskId && (payload as { source?: unknown } | null)?.source === "compact") {
            await sendToSock({ kind: "crew-compact-done", taskId: crewTaskId }).catch(() => {});
          }
        } catch { /* best-effort */ }
      }
      if (rulesOut) await new Promise<void>((resolve) => process.stdout.write(rulesOut, () => resolve()));

      // #651: captain sessions have SQUADRANT_ROLE=captain but no crew env
      // vars, so they'd otherwise no-op below without this. Best-effort,
      // side-effect-only — falls through to the same exit-0 hook contract.
      if (sub === "session-start" && process.env.SQUADRANT_ROLE === "captain") {
        recordCaptainSessionStart(payload);
      }

      // #782: the PermissionRequest event is owned by the permission gate — the
      // single decision point for the prompt. On a router backend the built-in
      // auto classifier fails closed, so the gate classifies with the configured
      // router model: allow/deny emits `decision.behavior` (and suppresses the
      // now-stale #560 task.blocked); ask/yield emits nothing to Claude and
      // falls back to the existing task.blocked signal. Operator sessions and
      // disabled/auto modes no-op inside the gate.
      if (sub === "permission-request") {
        await runGatePermissionRequest({
          payload,
          rawPayload: stdin,
          env: process.env,
          stdout: (s) => process.stdout.write(s),
          sendEvent: async (project, ev) => {
            await sendToSock({ kind: "event", project, event: ev });
          },
        });
        process.exit(0);
      }

      // #1068: a subagent must not change the crew's task state; the main
      // session (no agent_id on the payload) is unaffected.
      if (sub === "pre-tool-use") {
        const sig = decideSubagentCrewSignal(payload);
        if (sig.decision === "deny") {
          console.error(`[squadrant] denied subagent crew signal: ${sig.reason}`);
          denyPreToolUse(sig.reason);
        }
      }

      // #1007: attribution guard applies to captain and crew sessions alike,
      // so it runs before the crew-only gate below.
      if (sub === "pre-tool-use") {
        const attr = attributionGuard(payload, homedir());
        if (attr.decision === "deny") {
          console.error(`[squadrant] denied AI attribution trailer: ${attr.reason}`);
          denyPreToolUse(attr.reason);
        }
      }

      const taskId = process.env.SQUADRANT_CREW_TASK_ID;
      const project = process.env.SQUADRANT_CREW_PROJECT;
      // Not a crew session — no-op (hook fires for all claude processes).
      if (!taskId || !project) { process.exit(0); }

      // #556: the broad ("" matcher) pre-tool-use hook fires for every tool
      // call, including Write/Edit/MultiEdit/NotebookEdit/Bash — the only
      // point that can see a crew's target path before it lands. Deny writes
      // into the captain's long-term memory directory; report/propose is the
      // only allowed path there.
      if (sub === "pre-tool-use") {
        const guard = preToolUseGuard(payload, process.env, homedir());
        if (guard.decision === "deny") {
          console.error(`[squadrant] denied crew write into captain memory (task ${taskId}): ${guard.reason}`);
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: guard.reason,
            },
          }));
          process.exit(0);
        }
      }

      // #1089: a manual /compact fires no UserPromptSubmit and no Stop; PreCompact marks it for the
      // daemon so the SessionStart(compact) that follows can close the turn. Auto-compacts are skipped.
      if (sub === "pre-compact") {
        if ((payload as { trigger?: unknown } | null)?.trigger === "manual") {
          await sendToSock({ kind: "crew-compact-begin", project, taskId }).catch(() => {});
        }
        process.exit(0);
      }

      const ev = mapHookSub(sub, payload, taskId);
      if (!ev) { process.exit(0); }

      try {
        await sendToSock({ kind: "event", project, event: ev });
      } catch {
        // Daemon down: do NOT block claude. Hook contract requires exit 0.
      }
      process.exit(0);
    });

  // #900: rules-only receivers for agents with no lifecycle bridge. Always exit 0.
  for (const agent of ["codex", "gemini", "opencode"]) {
    hooks
      .command(`${agent} <sub>`, { hidden: true })
      .description(`internal: Rules KB and operator profile injection for ${agent}`)
      .option("--project <name>", "project for rules injection (default: SQUADRANT_CREW_PROJECT, then cwd)")
      .action(async (sub: string, opts: { project?: string }) => {
        const payload = await readStdinJson();
        const out = sub === PROFILE_HOOK_SUB
          ? await profileHookOutput(payload, { env: process.env, cwd: process.cwd(), agent })
          : await rulesHookOutput(sub, payload, { env: process.env, cwd: process.cwd(), project: opts.project, agent });
        if (out) await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()));
        process.exit(0);
      });
  }

  return hooks;
}
