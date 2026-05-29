// src/commands/crew-chat.ts
// DEPRECATED alias for `cockpit crew spawn --agent codex`. Kept so external
// callers don't break; prints a warning and delegates to runCrewSpawn so the
// session opens as a tab in the captain (same UX as `--agent claude`).
import { Command } from "commander";
import { runCrewSpawn } from "./crew.js";

export const crewChatCommand = new Command("chat")
  .description("[DEPRECATED] alias for `cockpit crew spawn <project> '(interactive)' --agent codex`.")
  .requiredOption("--provider <p>", "provider (codex only today)")
  .requiredOption("--project <name>", "project name")
  .option("--cwd <dir>", "(ignored; project cwd is used)", process.cwd())
  .option("--model <m>", "(unused; reserved for future codex model routing)")
  .option(
    "--approval",
    "force codex approvalPolicy='untrusted' so tool/shell calls request approval",
    false
  )
  .action(async (opts: { provider: string; project: string; cwd: string; model?: string; approval: boolean }) => {
    process.stderr.write(
      "⚠️  `cockpit crew chat --provider codex` is deprecated. " +
      "Use: cockpit crew spawn <project> '(interactive)' --agent codex" +
      (opts.approval ? " --approval" : "") +
      "\n"
    );
    if (opts.provider !== "codex") {
      throw new Error(`crew chat is implemented for provider=codex only (got '${opts.provider}')`);
    }
    const pane = await runCrewSpawn({
      project: opts.project,
      task: "(interactive)",
      agent: "codex",
      ...(opts.approval ? { approvalPolicy: "untrusted" } : {}),
    });
    process.stdout.write(`Crew '${pane.title}' spawned (${pane.surfaceId})\n`);
  });
