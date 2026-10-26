// captain.ts — `squadrant captain compact <project> [--focus <text>]` (#1010).
//
// Asks the daemon to /compact a Claude captain once its turn has ended and its
// input box is clear. Returns immediately; the daemon owns the wait and the pane
// typing (see core/daemon/captain-compact.ts).
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { squadrantdCall } from "./crew-control.js";

export async function runCaptainCompact(
  project: string,
  focus: string | undefined,
  call: (req: unknown) => Promise<unknown> = squadrantdCall,
): Promise<void> {
  if (!loadConfig().projects[project]) {
    throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  }
  await call({ kind: "captain-compact", project, focus });
}

export const compactQueuedLine = (project: string): string => `✔ Compact queued for '${project}' — it runs once the captain's turn ends.`;

export const captainCommand = new Command("captain").description("Captain session controls (#1010)");

captainCommand
  .command("compact <project>")
  .description("Queue a /compact for the project's Claude captain; typed by the daemon once the captain is idle (returns immediately)")
  .option("--focus <text>", "focus text passed to /compact")
  .action(async (project: string, opts: { focus?: string }) => {
    try {
      await runCaptainCompact(project, opts.focus);
      console.log(chalk.green(compactQueuedLine(project)));
    } catch (e) {
      console.error(chalk.red(`✖ ${(e as Error).message}`));
      process.exit(1);
    }
  });
