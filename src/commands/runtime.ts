import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "@cockpit/shared";
import { createCmuxDriver, RuntimeRegistry } from "@cockpit/workspaces";
import type { RuntimeDriver } from "@cockpit/workspaces";
import type { CockpitConfig } from "@cockpit/shared";

function buildRegistry(): RuntimeRegistry {
  return new RuntimeRegistry({
    cmux: createCmuxDriver(),
  });
}

interface ResolvedTarget {
  driver: RuntimeDriver;
  workspaceName: string;
}

function resolveTarget(
  registry: RuntimeRegistry,
  config: CockpitConfig,
  target: string | undefined,
  useCommand: boolean,
): ResolvedTarget {
  if (useCommand) {
    return {
      driver: registry.global(config),
      workspaceName: config.commandName,
    };
  }
  if (!target) {
    throw new Error("Missing target: pass a project name or use --command");
  }
  const proj = config.projects[target];
  if (!proj) {
    throw new Error(`Project '${target}' not found. Run 'cockpit projects list'.`);
  }
  return {
    driver: registry.forProject(target, config),
    workspaceName: proj.captainName,
  };
}

async function needRef(resolved: ResolvedTarget): Promise<string> {
  const ref = await resolved.driver.status(resolved.workspaceName);
  if (!ref) {
    throw new Error(`Workspace '${resolved.workspaceName}' is not running`);
  }
  return ref.id;
}

export const runtimeCommand = new Command("runtime")
  .description("Interact with the runtime layer (workspaces). Bridges bash scripts to the RuntimeDriver.");

runtimeCommand
  .command("status")
  .description("Print 'running' or 'stopped' for a target; exit 0 if running, 1 if not")
  .argument("[target]", "Project name")
  .option("--command", "Target the command workspace instead of a project captain")
  .action(async (target: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await resolved.driver.status(resolved.workspaceName);
      if (ref) {
        console.log("running");
        process.exit(0);
      } else {
        console.log("stopped");
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(2);
    }
  });

runtimeCommand
  .command("send")
  .description("Send a message to a target workspace AND commit with Enter. With --command, the first positional is the message.")
  .argument("<arg1>", "Project name, or the message when --command is used")
  .argument("[arg2]", "Message (when target is a project). Omit when using --command.")
  .option("--command", "Target the command workspace")
  .action(async (arg1: string, arg2: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      if (opts.command && arg2 !== undefined) {
        throw new Error("With --command, pass only the message (not a project name)");
      }
      const target = opts.command ? undefined : arg1;
      const message = opts.command ? arg1 : arg2;
      if (!message) throw new Error("Message is required");
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await needRef(resolved);
      await resolved.driver.send(ref, message);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

runtimeCommand
  .command("send-key")
  .description("Send a literal key press (e.g. Enter, Escape) to a target workspace. With --command, the first positional is the key.")
  .argument("<arg1>", "Project name, or the key when --command is used")
  .argument("[arg2]", "Key name (when target is a project). Omit when using --command.")
  .option("--command", "Target the command workspace")
  .action(async (arg1: string, arg2: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      if (opts.command && arg2 !== undefined) {
        throw new Error("With --command, pass only the key (not a project name)");
      }
      const target = opts.command ? undefined : arg1;
      const key = opts.command ? arg1 : arg2;
      if (!key) throw new Error("Key is required");
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await needRef(resolved);
      await resolved.driver.sendKey(ref, key);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

runtimeCommand
  .command("list")
  .description("List all workspaces from the global runtime")
  .option("-j, --json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    const driver = registry.global(config);
    const refs = await driver.list();
    if (opts.json) {
      console.log(JSON.stringify(refs, null, 2));
    } else {
      for (const r of refs) {
        console.log(`${r.id}\t${r.name}\t${r.status}`);
      }
    }
  });

runtimeCommand
  .command("read-screen")
  .description("Print a terminal snapshot of a target workspace")
  .argument("[target]", "Project name")
  .option("--command", "Target the command workspace")
  .action(async (target: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await needRef(resolved);
      const screen = await resolved.driver.readScreen(ref);
      process.stdout.write(screen);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

runtimeCommand
  .command("stop")
  .description("Stop a target workspace")
  .argument("[target]", "Project name")
  .option("--command", "Target the command workspace")
  .action(async (target: string | undefined, opts: { command?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const resolved = resolveTarget(registry, config, target, !!opts.command);
      const ref = await resolved.driver.status(resolved.workspaceName);
      if (!ref) {
        console.log(chalk.yellow(`Workspace '${resolved.workspaceName}' already stopped`));
        return;
      }
      await resolved.driver.stop(ref.id);
      console.log(chalk.green(`✔ Stopped ${resolved.workspaceName}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
