// src/commands/crew-control.ts
import { Command } from "commander";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { sendRequest } from "../control/protocol.js";
import { ensureDaemon } from "../control/launchd.js";
import type { ControlEvent, Mode, Provider, TaskRecord } from "../control/types.js";
import { mapClaudeHookToEvent } from "../control/interactive/claude.js";
import { crewAttachCommand } from "./crew-attach.js";
import { crewChatCommand } from "./crew-chat.js";

const SOCK = join(homedir(), ".config", "cockpit", "cockpit.sock");

// Codex thread setup is async after `dispatch` returns; let startThread finish
// before sending the first turn. Empirically codex handshake completes in well
// under a second; 1.5s is a safe margin without blocking the spawn return for
// long (this function is invoked fire-and-forget).
const CODEX_FIRST_TURN_DELAY_MS = 1500;

/**
 * Send the spawn task arg to a freshly-dispatched codex interactive task as
 * the first turn — mirrors how `cockpit crew spawn --agent claude "<task>"`
 * sends the task arg into the claude CLI's first prompt.
 *
 * Reuses the existing attach-socket `say` op (same one used by `crew send` and
 * `crew attach` follow-ups). Opens a transient socket, attaches, sends say,
 * closes. The renderer running in the captain tab attaches independently and
 * receives the streamed reply.
 */
export async function sendCodexFirstTurn(taskId: string, text: string): Promise<void> {
  await new Promise((r) => setTimeout(r, CODEX_FIRST_TURN_DELAY_MS));
  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(SOCK);
    conn.setEncoding("utf-8");
    conn.on("data", () => { /* drain attach frames; we just want to send */ });
    conn.on("error", reject);
    conn.once("connect", () => {
      try {
        conn.write(JSON.stringify({ op: "attach", taskId }) + "\n");
        conn.write(JSON.stringify({ op: "say", taskId, text }) + "\n");
      } catch (e) {
        reject(e);
        return;
      }
      // Brief flush window before close so the daemon processes both frames.
      setTimeout(() => { conn.end(); resolve(); }, 100);
    });
  });
}

export function buildDispatchRequest(o: {
  project: string; provider: Provider; mode: Mode; task: string; budgetMs?: number; cwd?: string;
  approvalPolicy?: string; roleInstructions?: string; name?: string;
}): { kind: "dispatch"; record: TaskRecord } {
  const now = Date.now();
  const attemptId = randomUUID();
  return {
    kind: "dispatch",
    record: {
      id: randomUUID(), project: o.project, provider: o.provider, mode: o.mode,
      state: "submitted", task: o.task, cwd: o.cwd, createdAt: now, lastHeartbeat: now,
      lastEvent: "dispatch", heartbeatBudgetMs: o.budgetMs ?? 300000,
      attempts: [{ attemptId, startedAt: now, lastHeartbeatAt: now }],
      ...(o.approvalPolicy ? { approvalPolicy: o.approvalPolicy } : {}),
      ...(o.roleInstructions ? { roleInstructions: o.roleInstructions } : {}),
      ...(o.name ? { name: o.name } : {}),
    },
  };
}

export function buildStatusRequest(project: string, id: string) {
  return { kind: "status" as const, project, id };
}

export function buildGateResolveRequest(o: { project: string; gateId: string; message: string }) {
  const lower = o.message.toLowerCase().trim();
  const decision = lower.startsWith("approve") ? "approve" : lower.startsWith("deny") ? "deny" : undefined;
  return {
    kind: "gate-resolve" as const,
    project: o.project,
    gateId: o.gateId,
    resolvedBy: "captain",
    payload: { text: o.message, ...(decision ? { decision } : {}) },
  };
}

export async function cockpitdCall(req: unknown): Promise<unknown> {
  try {
    return await sendRequest(SOCK, req);
  } catch {
    ensureDaemon(); // resolves its own entrypoint — never pass a path here
    // kickstart→socket is racy; bounded backoff. If all attempts fail,
    // throw the last error (fail loud, no scrape fallback).
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await sendRequest(SOCK, req);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw lastErr;
  }
}

/**
 * Build an explicit terminal/blocked event request from a crew's `signal`
 * verb. Defaults to reading `COCKPIT_CREW_TASK_ID` and `COCKPIT_CREW_PROJECT`
 * from env so the claude/opencode crew templates can run e.g.
 * `cockpit crew signal done --message "…"` without knowing their own ids.
 *
 * Explicit `taskId`/`project` (from `--task-id`/`--project` flags) take
 * precedence over env. This is the codex path: a single long-lived app-server
 * child serves all codex tasks as threads, so a process-level env var is
 * unsafe (wrong for concurrent tasks). The codex crew is told its concrete ids
 * via per-thread developerInstructions and signals with the explicit flags.
 *
 * Anti-#2576 invariant lives at the OTHER end (the hook bridge in
 * `_hook`). This builder is the *explicit* path: a crew running this verb
 * has *intentionally* declared terminal state after its own settle-check.
 */
export function buildSignalRequest(
  signal: "done" | "blocked" | "failed",
  o: {
    message?: string;
    question?: string;
    error?: string;
    /** Explicit override (codex); falls back to COCKPIT_CREW_TASK_ID env. */
    taskId?: string;
    /** Explicit override (codex); falls back to COCKPIT_CREW_PROJECT env. */
    project?: string;
    /** Injectable for tests; defaults to writing under ~/.config/cockpit/state/_results. */
    writeResult?: (id: string, payload: string) => string;
  },
): { kind: "event"; project: string; event: ControlEvent } {
  const taskId = o.taskId ?? process.env.COCKPIT_CREW_TASK_ID;
  const project = o.project ?? process.env.COCKPIT_CREW_PROJECT;
  if (!taskId)
    throw new Error("not running under a crew (COCKPIT_CREW_TASK_ID unset)");
  if (!project)
    throw new Error("not running under a crew (COCKPIT_CREW_PROJECT unset)");
  let event: ControlEvent;
  if (signal === "done") {
    const resultRef = o.writeResult ? o.writeResult(taskId, o.message ?? "") : "";
    event = {
      type: "task.done",
      id: taskId,
      resultRef,
      ...(o.message !== undefined ? { message: o.message } : {}),
    };
  } else if (signal === "blocked") {
    event = { type: "task.blocked", id: taskId, reason: "crew signaled blocked", question: o.question ?? "" };
  } else {
    event = { type: "task.failed", id: taskId, error: o.error ?? "crew signaled failed" };
  }
  return { kind: "event", project, event };
}

/** Default writer used by the `signal done` subcommand. Tests inject their own. */
function defaultWriteResult(id: string, payload: string): string {
  const dir = join(homedir(), ".config", "cockpit", "state", "_results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.txt`);
  writeFileSync(file, payload);
  return file;
}

/**
 * Attach the control-plane verbs onto an existing `cockpit crew` command so
 * they coexist with the legacy cmux-scrape verbs (spawn/send/read/close/list).
 * The control-plane task listing is `tasks` (not `list`) to avoid colliding
 * with the legacy `list` that captains' playbook still uses. This is the
 * deferred-legacy coexistence state — wired so PR #85 does not break live
 * captains. Migrating captain-ops to the control-plane verbs is the deferred
 * legacy-re-pointing spec's job.
 */
export function addControlPlaneCrewCommands(crew: Command): void {
  crew
    .command("dispatch <project> <task>")
    .description("Dispatch a crew task via the control-plane daemon")
    .requiredOption("--provider <p>", "claude|opencode|codex (gemini: experimental, headless not supported)")
    .option("--mode <m>", "headless|interactive", "interactive")
    .option("--cwd <dir>", "working dir for the crew (project/worktree); required for codex to edit code")
    .action(async (project: string, task: string, opts: { provider: Provider; mode: Mode; cwd?: string }) => {
      const req = buildDispatchRequest({ project, task, provider: opts.provider, mode: opts.mode, cwd: opts.cwd });
      const r = await cockpitdCall(req);
      process.stdout.write(JSON.stringify(r) + "\n");
    });

  crew
    .command("status <project> <id>")
    .description("Read a control-plane task's state")
    .action(async (project: string, id: string) => {
      const r = await cockpitdCall(buildStatusRequest(project, id));
      process.stdout.write(JSON.stringify(r) + "\n");
    });

  crew
    .command("tasks <project>")
    .description("List control-plane tasks for a project (control-plane analogue of legacy `list`)")
    .action(async (project: string) => {
      const r = await cockpitdCall({ kind: "list", project });
      process.stdout.write(JSON.stringify(r) + "\n");
    });

  // TODO(downstream interactive-wiring spec): deliverReply is not yet wired in
  // cockpitd, so this transitions task state but never reaches the agent. Deferred.
  // --gate <gateId> routes through the gate-resolve verb instead (spec §4.9).
  crew
    .command("reply <project> <id> <message>")
    .description("Reply to a blocked control-plane task (delivery deferred), or resolve a gate via --gate")
    .option("--gate <gateId>", "resolve a pending gate by id (codex interactive, spec §4.9)")
    .action(async (project: string, id: string, message: string, opts: { gate?: string }) => {
      if (opts.gate) {
        const r = await cockpitdCall(buildGateResolveRequest({ project, gateId: opts.gate, message }));
        process.stdout.write(JSON.stringify(r) + "\n");
        return;
      }
      process.stderr.write("reply delivery is not yet wired (deferred); state transitioned only\n");
      const r = await cockpitdCall({ kind: "reply", project, id, message });
      process.stdout.write(JSON.stringify(r) + "\n");
    });

  // Bridge from Claude's native Stop/SubagentStop/SessionEnd hooks to the
  // cockpit control plane. Reads hook payload JSON on stdin (Claude hook
  // contract); env-gated on COCKPIT_CREW_TASK_ID/COCKPIT_CREW_PROJECT so the
  // hook is a no-op outside spawned crews. Anti-#2576: maps only to
  // task.progress (liveness), never task.done — terminal state comes from
  // `cockpit crew signal` (explicit, post-settle-check).
  crew
    .command("_hook <event>", { hidden: true })
    .description("internal: bridge from claude Stop/SubagentStop/SessionEnd hooks to cockpitd")
    .action(async (event: string) => {
      const taskId = process.env.COCKPIT_CREW_TASK_ID;
      const project = process.env.COCKPIT_CREW_PROJECT;
      if (!taskId || !project) { process.exit(0); }
      // Drain stdin (Claude posts hook JSON there). Tolerate missing/malformed.
      let stdin = "";
      try {
        for await (const chunk of process.stdin) stdin += chunk;
      } catch { /* ignore */ }
      let payload: unknown = undefined;
      if (stdin.trim()) {
        try { payload = JSON.parse(stdin); } catch { /* ignore malformed */ }
      }
      const ev = mapClaudeHookToEvent(event, payload, taskId);
      if (!ev) { process.exit(0); }
      try {
        await cockpitdCall({ kind: "event", project, event: ev });
      } catch {
        // Daemon down: do NOT block Claude. Hook contract requires exit 0;
        // a non-zero exit would block the conversation.
      }
      process.exit(0);
    });

  // The explicit done/blocked/failed signal — the anti-#2576 escape from
  // liveness-only Stop hooks. The crew runs this AFTER its own settle-check
  // (git status clean, etc.) to declare terminal state to the captain.
  crew
    .command("signal <state>")
    .description("Emit explicit terminal signal from a crew session: done|blocked|failed (reads COCKPIT_CREW_* env, or --task-id/--project for codex)")
    .option("--message <m>", "Summary written to resultRef (done)")
    .option("--question <q>", "Question to surface to captain (blocked)")
    .option("--error <e>", "Error message (failed)")
    .option("--task-id <id>", "Explicit task id (codex; overrides COCKPIT_CREW_TASK_ID env)")
    .option("--project <p>", "Explicit project (codex; overrides COCKPIT_CREW_PROJECT env)")
    .action(async (state: string, opts: { message?: string; question?: string; error?: string; taskId?: string; project?: string }) => {
      if (state !== "done" && state !== "blocked" && state !== "failed") {
        process.stderr.write(`unknown signal '${state}' (expected: done|blocked|failed)\n`);
        process.exit(2);
      }
      try {
        const req = buildSignalRequest(state as "done" | "blocked" | "failed", {
          ...(opts.message !== undefined ? { message: opts.message } : {}),
          ...(opts.question !== undefined ? { question: opts.question } : {}),
          ...(opts.error !== undefined ? { error: opts.error } : {}),
          ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
          ...(opts.project !== undefined ? { project: opts.project } : {}),
          writeResult: defaultWriteResult,
        });
        await cockpitdCall(req);
        process.exit(0);
      } catch (e) {
        process.stderr.write(`${(e as Error).message}\n`);
        process.exit(1);
      }
    });

  crew.addCommand(crewAttachCommand);
  crew.addCommand(crewChatCommand);
}

// Standalone control-plane-only command (kept for back-compat / direct use;
// the CLI composes these onto the legacy `crew` command via the function above).
export const crewControlCommand = new Command("crew")
  .description("Dispatch and track crew via the cockpit control plane");
addControlPlaneCrewCommands(crewControlCommand);
