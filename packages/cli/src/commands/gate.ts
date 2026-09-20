// gate.ts — `squadrant gate claude permission-request`
//
// The U7 (#782) hook handler. Claude Code's built-in auto-mode classifier is
// hardcoded to Claude Sonnet 5 and fails CLOSED on a router backend; this gate
// classifies with the operator's configured router model (no Anthropic
// credential) and steps aside when mode is off/auto.
//
// It is the SINGLE owner of the `PermissionRequest` event:
//   allow/deny → print `hookSpecificOutput.decision.behavior` and do NOT emit
//                task.blocked (the crew was never actually blocked);
//   ask/yield  → print nothing (normal dialog appears) and emit the existing
//                #560 task.blocked so the captain is still notified.
//
// Design: docs/specs/2026-09-20-router-permission-gate-u7-design.md

import { Command } from "commander";
import { sendRequest } from "@squadrant/core";
import {
  GateDecisionCache,
  SIDE_SESSION_ENV,
  evaluatePermissionRequest,
  formatPermissionDecision,
  readUserIntent,
  type DecisionCacheLike,
  type GateEvaluation,
} from "@squadrant/core";
import { DAEMON_SOCK_PATH, loadConfig, type SquadrantConfig } from "@squadrant/shared";
import type { ControlEvent } from "@squadrant/shared";
import { deriveTranscriptPath, mapClaudeHookToEvent } from "@squadrant/agents";

const SOCK = DAEMON_SOCK_PATH;

export interface GateHookDeps {
  payload: unknown;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  config?: SquadrantConfig;
  cache?: DecisionCacheLike;
  fetchImpl?: typeof fetch;
  /** Writes the hook's permission decision (or nothing). */
  stdout?: (s: string) => void;
  /** Diagnostics — stderr, never stdout (Claude parses stdout JSON). */
  log?: (m: string) => void;
  /** Emits the #560 task.blocked event on the ask/yield path. */
  sendEvent?: (project: string, event: ControlEvent) => Promise<void>;
  loadConfigFn?: () => SquadrantConfig;
  readIntent?: (transcriptPath: string | undefined) => string | null;
}

/**
 * Evaluate one PermissionRequest and emit the right hook output. Returns the
 * evaluation so callers/tests can assert the decision.
 */
export async function runGatePermissionRequest(deps: GateHookDeps): Promise<GateEvaluation> {
  const env = deps.env ?? process.env;
  const payload = (deps.payload ?? {}) as Record<string, unknown>;
  const p = payload as {
    tool_name?: unknown;
    tool_input?: unknown;
    permission_mode?: unknown;
    cwd?: unknown;
    transcript_path?: unknown;
    session_id?: unknown;
  };

  const taskId = env.SQUADRANT_CREW_TASK_ID;
  const project = env.SQUADRANT_CREW_PROJECT;
  const isSide = env[SIDE_SESSION_ENV] === "1";

  // Not a squadrant crew/side session (an operator's own claude): never touch it.
  if (!taskId && !isSide) {
    return { decision: "yield", reason: "not a squadrant crew/side session" };
  }

  const stdout = deps.stdout ?? (() => {});
  const log = deps.log ?? ((m: string) => process.stderr.write(`[squadrant] ${m}\n`));
  const config = deps.config ?? (deps.loadConfigFn ?? loadConfig)();

  const cwd =
    deps.cwd ??
    (typeof p.cwd === "string" && p.cwd ? p.cwd : env.SQUADRANT_CREW_CWD ?? process.cwd());
  const transcriptPath =
    typeof p.transcript_path === "string" && p.transcript_path
      ? p.transcript_path
      : deriveTranscriptPath(
          typeof p.session_id === "string" ? p.session_id : "",
          cwd,
        ) ?? undefined;

  const evaluation = await evaluatePermissionRequest({
    toolName: typeof p.tool_name === "string" ? p.tool_name : "",
    toolInput: p.tool_input,
    permissionMode: typeof p.permission_mode === "string" ? p.permission_mode : undefined,
    cwd,
    env,
    config,
    userIntent: (deps.readIntent ?? readUserIntent)(transcriptPath),
    cache: deps.cache ?? new GateDecisionCache(),
    fetchImpl: deps.fetchImpl,
    log,
  });

  if (evaluation.decision === "allow" || evaluation.decision === "deny") {
    log(
      `gate ${evaluation.decision}` +
        ` (tier ${evaluation.tier ?? "?"}${evaluation.cached ? ", cached" : ""}): ${evaluation.reason}`,
    );
    stdout(
      formatPermissionDecision(
        evaluation.decision,
        evaluation.decision === "deny"
          ? `Blocked by the squadrant permission gate: ${evaluation.reason}`
          : undefined,
      ),
    );
    return evaluation;
  }

  // ask / yield: leave the normal dialog intact and preserve #560 signalling.
  if (taskId && project && deps.sendEvent) {
    const ev = mapClaudeHookToEvent("PermissionRequest", payload, taskId);
    if (ev) {
      try {
        await deps.sendEvent(project, ev);
      } catch {
        // Daemon down: do NOT block claude. Hook contract requires exit 0.
      }
    }
  }
  return evaluation;
}

const DEFAULT_EVENT = "permission-request";

export function gateCommand(): Command {
  const gate = new Command("gate").description(
    "(internal) hook-based permission gate for router-backed crew/side sessions (#782)",
  );

  gate
    .command("claude <event>", { hidden: true })
    .description("internal: classify a claude PermissionRequest with the configured router model")
    .action(async (event: string) => {
      // Drain stdin FIRST (Claude's hook JSON), then exit 0 unconditionally —
      // a non-zero exit would block the conversation.
      let stdin = "";
      try {
        for await (const chunk of process.stdin) stdin += chunk as string;
      } catch {
        /* ignore */
      }
      let payload: unknown = undefined;
      if (stdin.trim()) {
        try {
          payload = JSON.parse(stdin);
        } catch {
          /* ignore malformed */
        }
      }

      if (event !== DEFAULT_EVENT) {
        process.exit(0);
      }

      await runGatePermissionRequest({
        payload,
        env: process.env,
        stdout: (s) => process.stdout.write(s),
        sendEvent: async (project, ev) => {
          await sendRequest(SOCK, { kind: "event", project, event: ev });
        },
      });
      process.exit(0);
    });

  return gate;
}
