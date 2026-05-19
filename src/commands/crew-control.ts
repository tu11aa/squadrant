// src/commands/crew-control.ts
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendRequest } from "../control/protocol.js";
import { ensureDaemon } from "../control/launchd.js";
import type { Mode, Provider, TaskRecord } from "../control/types.js";

const SOCK = join(homedir(), ".config", "cockpit", "cockpit.sock");

export function buildDispatchRequest(o: {
  project: string; provider: Provider; mode: Mode; task: string; budgetMs?: number;
}): { kind: "dispatch"; record: TaskRecord } {
  const now = Date.now();
  return {
    kind: "dispatch",
    record: {
      id: randomUUID(), project: o.project, provider: o.provider, mode: o.mode,
      state: "submitted", task: o.task, createdAt: now, lastHeartbeat: now,
      lastEvent: "dispatch", heartbeatBudgetMs: o.budgetMs ?? 300000,
    },
  };
}

export function buildStatusRequest(project: string, id: string) {
  return { kind: "status" as const, project, id };
}

async function call(req: unknown): Promise<unknown> {
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

export const crewControlCommand = new Command("crew")
  .description("Dispatch and track crew via the cockpit control plane");

crewControlCommand
  .command("dispatch <project> <task>")
  .requiredOption("--provider <p>", "claude|opencode|codex (gemini: experimental, headless not supported)")
  .option("--mode <m>", "headless|interactive", "interactive")
  .action(async (project: string, task: string, opts: { provider: Provider; mode: Mode }) => {
    const req = buildDispatchRequest({ project, task, provider: opts.provider, mode: opts.mode });
    const r = await call(req);
    process.stdout.write(JSON.stringify(r) + "\n");
  });

crewControlCommand
  .command("status <project> <id>")
  .action(async (project: string, id: string) => {
    const r = await call(buildStatusRequest(project, id));
    process.stdout.write(JSON.stringify(r) + "\n");
  });

crewControlCommand
  .command("list <project>")
  .action(async (project: string) => {
    const r = await call({ kind: "list", project });
    process.stdout.write(JSON.stringify(r) + "\n");
  });

// TODO(downstream interactive-wiring spec): deliverReply is not yet wired in
// cockpitd, so this transitions task state but never reaches the agent. Deferred.
crewControlCommand
  .command("reply <project> <id> <message>")
  .action(async (project: string, id: string, message: string) => {
    process.stderr.write("reply delivery is not yet wired (deferred); state transitioned only\n");
    const r = await call({ kind: "reply", project, id, message });
    process.stdout.write(JSON.stringify(r) + "\n");
  });

// TODO(downstream interactive-wiring spec): not yet functional — no-op stub.
crewControlCommand
  .command("_hook <event>", { hidden: true })
  .description("internal: invoked by injected agent hooks (deferred — not yet functional)")
  .action(async (event: string) => {
    // hook payload arrives on stdin (Claude hook JSON); minimal: emit progress.
    process.stdout.write(`hook:${event}\n`);
  });
