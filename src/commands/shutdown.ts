import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import type { RuntimeDriver } from "../runtimes/index.js";

// Captain workspaces gained the leading "⚓ " prefix partway through cockpit's
// life. Workspaces created before that convention persist with the un-prefixed
// name and shutdown needs to match both shapes.
function nameVariants(name: string): string[] {
  const stripped = name.replace(/^⚓\s+/, "").trim();
  return stripped === name ? [name] : [name, stripped];
}

async function closeMatching(
  runtime: RuntimeDriver,
  variants: string[],
  label: string,
): Promise<{ closed: string[]; failed: string[] }> {
  const workspaces = await runtime.list();
  const matches = workspaces.filter((w) => variants.includes(w.name));
  const closed: string[] = [];
  const failed: string[] = [];
  if (matches.length === 0) {
    console.log(
      chalk.yellow(`  ⚠ Workspace '${label}' not found — already closed?`),
    );
    return { closed, failed };
  }
  for (const ws of matches) {
    try {
      await runtime.stop(ws.id);
      console.log(chalk.green(`  ✔ Closed: ${ws.name}`));
      closed.push(ws.name);
    } catch {
      console.log(chalk.red(`  ✘ Failed to close: ${ws.name}`));
      failed.push(ws.name);
    }
  }
  return { closed, failed };
}

export const shutdownCommand = new Command("shutdown")
  .description(
    "Shutdown command + all captain workspaces (no args) or one captain workspace",
  )
  .argument("[project]", "Project name to shut down captain for")
  .action(async (project: string | undefined) => {
    const config = loadConfig();
    const runtimes = new RuntimeRegistry({ cmux: createCmuxDriver() });

    if (!project) {
      const globalRuntime = runtimes.global(config);
      const workspaces = await globalRuntime.list();
      const captainVariants = Object.values(config.projects).flatMap((p) =>
        nameVariants(p.captainName),
      );
      const commandName = config.commandName || "command";
      const commandVariants = nameVariants(commandName);
      const allVariants = new Set([...captainVariants, ...commandVariants]);
      const cockpitWorkspaces = workspaces.filter((w) => allVariants.has(w.name));

      if (cockpitWorkspaces.length === 0) {
        console.log(chalk.yellow("\nNo cockpit workspaces found to close.\n"));
        return;
      }

      console.log(
        chalk.bold(
          `\nShutting down ${cockpitWorkspaces.length} workspace(s)...\n`,
        ),
      );
      for (const ws of cockpitWorkspaces) {
        try {
          await globalRuntime.stop(ws.id);
          console.log(chalk.green(`  ✔ Closed: ${ws.name}`));
        } catch {
          console.log(chalk.red(`  ✘ Failed to close: ${ws.name}`));
        }
      }
      console.log("");
      return;
    }

    if (!config.projects[project]) {
      console.error(
        chalk.red(
          `\n  ✘ Project '${project}' not found. Run 'cockpit projects list' to see registered projects.\n`,
        ),
      );
      process.exit(1);
    }

    const captainName = config.projects[project].captainName;
    const runtime = runtimes.forProject(project, config);
    console.log(
      chalk.bold(`\nShutting down captain workspace for '${project}'...\n`),
    );

    const { failed } = await closeMatching(
      runtime,
      nameVariants(captainName),
      captainName,
    );
    console.log("");
    if (failed.length > 0) process.exit(1);
  });
