import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig, resolveEffort, DEFAULT_CONFIG_PATH } from "@cockpit/shared";
import type { Effort } from "@cockpit/shared";

const VALID_EFFORTS: Effort[] = ["max", "balance", "low"];

const EFFORT_MEANING: Record<Effort, string> = {
  max: "tokens are plentiful — bias crew spawns toward claude/opus",
  balance: "normal routing — use default crew routing rules unchanged",
  low: "conserve tokens — bias crew spawns toward opencode/sonnet; reserve opus for work that genuinely needs it",
};

export interface EffortGetResult {
  effort: Effort;
  description: string;
}

export function runEffortGet(configPath = DEFAULT_CONFIG_PATH): EffortGetResult {
  const config = loadConfig(configPath);
  const effort = resolveEffort(config);
  const description = `${effort}: ${EFFORT_MEANING[effort]}`;
  return { effort, description };
}

export function runEffortSet(value: string, configPath = DEFAULT_CONFIG_PATH): void {
  if (!(VALID_EFFORTS as string[]).includes(value)) {
    throw new Error(
      `Invalid effort '${value}'. Valid values: ${VALID_EFFORTS.join(" | ")}`,
    );
  }
  const config = loadConfig(configPath);
  config.defaults.effort = value as Effort;
  saveConfig(config, configPath);
}

export const effortCommand = new Command("effort")
  .description("Get or set the global crew tokenomics dial (max | balance | low)")
  .argument("[value]", "effort level to set: max | balance | low")
  .action(async (value: string | undefined) => {
    if (value === undefined) {
      const { effort, description } = runEffortGet();
      console.log(chalk.bold("Current effort:"), chalk.cyan(effort));
      console.log(chalk.dim(EFFORT_MEANING[effort]));
      return;
    }

    try {
      runEffortSet(value);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }

    const effort = value as Effort;
    console.log(chalk.green(`✔ effort → ${effort}`));
    console.log(chalk.dim(EFFORT_MEANING[effort]));

    // Best-effort active notify: send a one-line notice to any running captain.
    // Never hard-fails — config is already written above.
    try {
      const { createCmuxDriver, RuntimeRegistry } = await import("@cockpit/workspaces");
      const config = loadConfig();
      const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
      const driver = registry.global(config);
      const notice = `🎚️ effort → ${effort}: ${EFFORT_MEANING[effort]}`;
      for (const [, proj] of Object.entries(config.projects)) {
        try {
          const ref = await driver.status(proj.captainName);
          if (ref) {
            await driver.send(ref.id, notice);
          }
        } catch {
          // individual project captain unreachable — skip
        }
      }
    } catch {
      // runtime unavailable — config already written, change applies on next launch
      console.log(chalk.dim("(no running captain detected — change applies on next launch)"));
    }
  });
