// src/commands/crew-chat.ts
// `cockpit crew chat --provider codex` — opens a live human↔codex chat in
// a cmux workspace. Spec §4.2.
import { Command } from "commander";
import { buildDispatchRequest, cockpitdCall } from "./crew-control.js";
import { createCmuxDriver } from "../runtimes/cmux.js";
import type { TaskRecord } from "../control/types.js";

export const crewChatCommand = new Command("chat")
  .description("Open a live human↔codex chat in a cmux workspace (spec §4.2).")
  .requiredOption("--provider <p>", "provider (codex only today)")
  .requiredOption("--project <name>", "project name")
  .option("--cwd <dir>", "working dir for the codex thread", process.cwd())
  .option("--model <m>", "model id (optional)")
  .option(
    "--approval",
    "force codex approvalPolicy='untrusted' so tool/shell calls request approval (exercises the gate primitive)",
    false
  )
  .action(async (opts: { provider: string; project: string; cwd: string; model?: string; approval: boolean }) => {
    if (opts.provider !== "codex") {
      throw new Error(`crew chat is implemented for provider=codex only (got '${opts.provider}')`);
    }
    const req = buildDispatchRequest({
      provider: "codex",
      mode: "interactive",
      project: opts.project,
      cwd: opts.cwd,
      task: "(interactive)",
      ...(opts.approval ? { approvalPolicy: "untrusted" } : {}),
    });
    const rec = (await cockpitdCall(req)) as TaskRecord;
    process.stdout.write(`task ${rec.id} dispatched\n`);

    const driver = createCmuxDriver();
    const ws = await driver.spawn({
      name: `chat-${rec.id.slice(0, 8)}`,
      command: `cockpit crew attach ${rec.id}`,
      workdir: opts.cwd,
    });
    process.stdout.write(`workspace ${ws.id} (${ws.name}) opened for chat\n`);
  });
