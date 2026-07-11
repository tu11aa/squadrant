import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { createCmuxDriver, RuntimeRegistry } from "@squadrant/workspaces";
import type { RuntimeDriver } from "@squadrant/workspaces";
import type { SquadrantConfig } from "@squadrant/shared";

export function buildRegistry(): RuntimeRegistry {
  return new RuntimeRegistry({
    cmux: createCmuxDriver(),
  });
}

export interface ResolvedTarget {
  driver: RuntimeDriver;
  workspaceName: string;
}

export function resolveTarget(
  registry: RuntimeRegistry,
  config: SquadrantConfig,
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
    throw new Error(`Project '${target}' not found. Run 'squadrant projects list'.`);
  }
  return {
    driver: registry.forProject(target, config),
    workspaceName: proj.captainName,
  };
}

export async function needRef(resolved: ResolvedTarget): Promise<string> {
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

// #566: how long a CLI-originated send waits for the delivery loop to confirm
// the mailbox entry actually reached the pane before failing loudly. Generous
// enough to cover the #302 stable-content probe escalation (a few delivery
// ticks) without hanging the terminal indefinitely on a genuinely stuck send.
const SEND_CONFIRM_TIMEOUT_MS = 15000;
const SEND_CONFIRM_POLL_MS = 500;

export async function runRuntimeSend(
  arg1: string,
  arg2: string | undefined,
  opts: { command?: boolean },
  confirmOpts?: { timeoutMs?: number; pollMs?: number },
) {
  const config = loadConfig();
  const registry = buildRegistry();

  if (opts.command && arg2 !== undefined) {
    throw new Error("With --command, pass only the message (not a project name)");
  }
  const target = opts.command ? undefined : arg1;
  const message = opts.command ? arg1 : arg2;
  if (!message) throw new Error("Message is required");

  const { requireDaemon } = await import("../lib/require-daemon.js");
  const { appendCaptainMessage, waitForCaptainDelivery } = await import("@squadrant/core");
  await requireDaemon();

  const resolved = resolveTarget(registry, config, target, !!opts.command);
  await needRef(resolved);

  const finalProject = opts.command ? config.commandName : target!;

  const { join, dirname } = await import("node:path");
  const { DEFAULT_CONFIG_PATH } = await import("@squadrant/shared");
  const stateRoot = join(dirname(DEFAULT_CONFIG_PATH), "state");

  // #566: never gate the send attempt itself on a liveness verdict — always
  // append, then confirm. Keeps the #529 draft-clobber protection (still
  // routed through the mailbox/delivery loop) while making non-delivery loud
  // instead of silent.
  const seq = await appendCaptainMessage({
    stateRoot,
    project: finalProject,
    text: message,
    source: "cli",
  });

  const timeoutMs = confirmOpts?.timeoutMs ?? SEND_CONFIRM_TIMEOUT_MS;
  const delivered = await waitForCaptainDelivery({
    stateRoot,
    project: finalProject,
    seq,
    timeoutMs,
    pollMs: confirmOpts?.pollMs ?? SEND_CONFIRM_POLL_MS,
  });
  if (!delivered) {
    throw new Error(
      `Message queued for '${finalProject}' (seq=${seq}) but delivery was not confirmed within ${Math.round(timeoutMs / 1000)}s. ` +
      `It may still be pending — check with 'squadrant runtime read-screen ${finalProject}${opts.command ? " --command" : ""}'.`,
    );
  }
}

runtimeCommand
  .command("send")
  .description("Send a message to a target workspace AND commit with Enter. With --command, the first positional is the message.")
  .argument("<arg1>", "Project name, or the message when --command is used")
  .argument("[arg2]", "Message (when target is a project). Omit when using --command.")
  .option("--command", "Target the command workspace")
  .action(async (arg1: string, arg2: string | undefined, opts: { command?: boolean }) => {
    try {
      await runRuntimeSend(arg1, arg2, opts);
      console.log(chalk.green("✔ Delivered (confirmed)"));
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
