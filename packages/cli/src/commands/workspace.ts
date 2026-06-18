import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, type CockpitConfig } from "@cockpit/shared";
import { createObsidianDriver, WorkspaceRegistry } from "@cockpit/workspaces";
import type { WorkspaceDriver } from "@cockpit/shared";

function buildRegistry(): WorkspaceRegistry {
  return new WorkspaceRegistry({
    obsidian: createObsidianDriver,
  });
}

function resolveDriver(
  registry: WorkspaceRegistry,
  config: CockpitConfig,
  projectTarget: string | undefined,
  useHub: boolean,
): WorkspaceDriver {
  if (useHub) return registry.hub(config);
  if (!projectTarget) throw new Error("Missing target: pass a project name or use --hub");
  return registry.forProject(projectTarget, config);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const workspaceCommand = new Command("workspace")
  .description("Interact with the workspace layer (vault storage). Bridges bash scripts to the WorkspaceDriver.");

// Reusable positional parser. The CLI convention:
//   <target> <path>          → project workspace
//   --hub <path>             → hub workspace
// With commander we declare <arg1> [arg2] and in the action:
//   if --hub: arg1 is the path (target is implicit).
//   else:     arg1 is the target, arg2 is the path.
function resolveTargetAndPath(
  arg1: string,
  arg2: string | undefined,
  useHub: boolean,
): { projectTarget: string | undefined; path: string } {
  if (useHub) {
    if (arg2 !== undefined) {
      throw new Error("With --hub, pass only the path (not a project name)");
    }
    return { projectTarget: undefined, path: arg1 };
  }
  if (arg2 === undefined) {
    throw new Error("Missing path — usage: <project> <path>  (or: --hub <path>)");
  }
  return { projectTarget: arg1, path: arg2 };
}

workspaceCommand
  .command("read")
  .description("Print the contents of a scope-relative path to stdout")
  .argument("<arg1>", "Project name, or the path when --hub is used")
  .argument("[arg2]", "Scope-relative path (omit when using --hub)")
  .option("--hub", "Target the hub workspace instead of a project spoke")
  .action(async (arg1: string, arg2: string | undefined, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const { projectTarget, path } = resolveTargetAndPath(arg1, arg2, !!opts.hub);
      const driver = resolveDriver(registry, config, projectTarget, !!opts.hub);
      const content = await driver.read(path);
      process.stdout.write(content);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

workspaceCommand
  .command("write")
  .description("Write content to a scope-relative path. Pass '-' as content to read from stdin.")
  .argument("<arg1>", "Project name, or the path when --hub is used")
  .argument("<arg2>", "Scope-relative path, or content when --hub is used")
  .argument("[arg3]", "Content (omit when using --hub). Use '-' for stdin.")
  .option("--hub", "Target the hub workspace")
  .action(async (arg1: string, arg2: string, arg3: string | undefined, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      let projectTarget: string | undefined;
      let path: string;
      let rawContent: string;
      if (opts.hub) {
        if (arg3 !== undefined) {
          throw new Error("With --hub, pass only the path and content");
        }
        projectTarget = undefined;
        path = arg1;
        rawContent = arg2;
      } else {
        if (arg3 === undefined) {
          throw new Error("Missing content — usage: <project> <path> <content>");
        }
        projectTarget = arg1;
        path = arg2;
        rawContent = arg3;
      }
      const driver = resolveDriver(registry, config, projectTarget, !!opts.hub);
      const payload = rawContent === "-" ? await readStdin() : rawContent;
      await driver.write(path, payload);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

workspaceCommand
  .command("list")
  .description("List entries in a scope-relative directory")
  .argument("<arg1>", "Project name, or the directory when --hub is used")
  .argument("[arg2]", "Scope-relative directory (omit when using --hub)")
  .option("--hub", "Target the hub workspace")
  .action(async (arg1: string, arg2: string | undefined, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const { projectTarget, path } = resolveTargetAndPath(arg1, arg2, !!opts.hub);
      const driver = resolveDriver(registry, config, projectTarget, !!opts.hub);
      const entries = await driver.list(path);
      for (const entry of entries) console.log(entry);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

workspaceCommand
  .command("exists")
  .description("Exit 0 if path exists, 1 if not")
  .argument("<arg1>", "Project name, or the path when --hub is used")
  .argument("[arg2]", "Scope-relative path (omit when using --hub)")
  .option("--hub", "Target the hub workspace")
  .action(async (arg1: string, arg2: string | undefined, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const { projectTarget, path } = resolveTargetAndPath(arg1, arg2, !!opts.hub);
      const driver = resolveDriver(registry, config, projectTarget, !!opts.hub);
      const ok = await driver.exists(path);
      process.exit(ok ? 0 : 1);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(2);
    }
  });

workspaceCommand
  .command("mkdir")
  .description("Recursively create a scope-relative directory")
  .argument("<arg1>", "Project name, or the path when --hub is used")
  .argument("[arg2]", "Scope-relative path (omit when using --hub)")
  .option("--hub", "Target the hub workspace")
  .action(async (arg1: string, arg2: string | undefined, opts: { hub?: boolean }) => {
    const config = loadConfig();
    const registry = buildRegistry();
    try {
      const { projectTarget, path } = resolveTargetAndPath(arg1, arg2, !!opts.hub);
      const driver = resolveDriver(registry, config, projectTarget, !!opts.hub);
      await driver.mkdir(path);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
