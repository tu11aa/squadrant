// src/commands/ping.ts
//
// Cross-project reach, fire-and-forget tier: deliver a message into ANY
// registered project's captain pane. No tracked task, no report-back.
// Reuses the same delivery mechanism as `squadrant runtime send`.

import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { buildRegistry, resolveTarget, needRef } from "./runtime.js";

export async function runPing(project: string, message: string): Promise<void> {
  const config = loadConfig();
  const registry = buildRegistry();
  const resolved = resolveTarget(registry, config, project, false);
  const ref = await needRef(resolved);
  await resolved.driver.send(ref, message);
}

export const pingCommand = new Command("ping")
  .description("Fire-and-forget: deliver a message into a registered project's captain pane (no tracked task, no report-back)")
  .argument("<project>", "Target project name (must be registered)")
  .argument("<message>", "Message to deliver")
  .action(async (project: string, message: string) => {
    try {
      await runPing(project, message);
      console.log(chalk.green(`✔ Pinged '${project}'`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
