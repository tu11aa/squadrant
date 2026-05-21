// src/commands/crew-control.ts
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendRequest } from "../control/protocol.js";
import { ensureDaemon } from "../control/launchd.js";
import type { Mode, Provider, TaskRecord } from "../control/types.js";
import { crewAttachCommand } from "./crew-attach.js";
import { crewChatCommand } from "./crew-chat.js";

const SOCK = join(homedir(), ".config", "cockpit", "cockpit.sock");

export function buildDispatchRequest(o: {
  project: string; provider: Provider; mode: Mode; task: string; budgetMs?: number; cwd?: string;
  approvalPolicy?: string;
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
    },
  };
}

export function buildStatusRequest(project: string, id: string) {
  return { kind: "status" as const, project, id };
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
        const r = await cockpitdCall({
          kind: "gate-resolve",
          project,
          gateId: opts.gate,
          resolvedBy: "captain",
          payload: { text: message },
        });
        process.stdout.write(JSON.stringify(r) + "\n");
        return;
      }
      process.stderr.write("reply delivery is not yet wired (deferred); state transitioned only\n");
      const r = await cockpitdCall({ kind: "reply", project, id, message });
      process.stdout.write(JSON.stringify(r) + "\n");
    });

  // TODO(downstream interactive-wiring spec): not yet functional — no-op stub.
  crew
    .command("_hook <event>", { hidden: true })
    .description("internal: invoked by injected agent hooks (deferred — not yet functional)")
    .action(async (event: string) => {
      // hook payload arrives on stdin (Claude hook JSON); minimal: emit progress.
      process.stdout.write(`hook:${event}\n`);
    });

  crew.addCommand(crewAttachCommand);
  crew.addCommand(crewChatCommand);
}

// Standalone control-plane-only command (kept for back-compat / direct use;
// the CLI composes these onto the legacy `crew` command via the function above).
export const crewControlCommand = new Command("crew")
  .description("Dispatch and track crew via the cockpit control plane");
addControlPlaneCrewCommands(crewControlCommand);
