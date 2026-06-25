import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { createCmuxDriver, RuntimeRegistry } from "@squadrant/workspaces";
import type { PaneRef, PanePlacement } from "@squadrant/workspaces";
import {
  createClaudeDriver,
  createCodexDriver,
  createGeminiDriver,
  createOpencodeDriver,
  CapabilityRegistry,
} from "@squadrant/agents";
import { resolveCaptainWorkspace, sendFirstTurnWhenReady } from "@squadrant/workspaces";
import { resolveTextInput } from "@squadrant/shared";
import {
  buildSideFirstTurn,
  runSideSpawn as coreRunSideSpawn,
  runSideSend as coreRunSideSend,
  runSideList as coreRunSideList,
  runSideClose as coreRunSideClose,
  type SideSpawnInput,
} from "@squadrant/core";

export { buildSideFirstTurn, type SideSpawnInput };

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "squadrant", "templates");

export async function runSideSpawn(input: SideSpawnInput): Promise<PaneRef> {
  const config = loadConfig();
  const proj = config.projects[input.project];
  if (!proj) {
    throw new Error(`Project '${input.project}' not found. Run 'squadrant projects list'.`);
  }

  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(
    input.project,
    config,
  );

  const agents = new CapabilityRegistry({
    claude: createClaudeDriver(),
    codex: createCodexDriver(),
    gemini: createGeminiDriver(),
    opencode: createOpencodeDriver(),
  });
  const sideRole = config.defaults.roles?.side;
  const agentName = input.agent ?? sideRole?.agent ?? "claude";
  const agent = agents.get(agentName);
  if (!agent) {
    throw new Error(`Unknown agent '${agentName}'. Known: claude, codex, gemini, opencode.`);
  }

  const sideModel = sideRole?.model;
  const promptFile = path.join(
    TEMPLATES_DIR,
    `side.${input.role}.${agent.templateSuffix}.md`,
  );

  const agentCmdFactory = (spawnCwd: string) =>
    agent.buildCommand({
      prompt: input.topic,
      workdir: spawnCwd,
      role: "side",
      promptFile: fs.existsSync(promptFile) ? promptFile : undefined,
      interactive: true,
      permissionMode: config.defaults.permissions?.crew ?? "auto",
      ...(sideModel ? { model: sideModel } : {}),
    });

  const sendFirstTurn = (pane: PaneRef, firstTurn: string, preLaunchScreen: string) =>
    sendFirstTurnWhenReady(runtime, pane, firstTurn, preLaunchScreen);

  return coreRunSideSpawn(input, config, { runtime, agentCmdFactory, sendFirstTurn });
}

export async function runSideSend(
  project: string,
  name: string,
  message: string,
): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  await coreRunSideSend(runtime, workspaceId, project, name, message);
}

export async function runSideList(
  project: string,
): Promise<Array<{ name: string; surfaceId: string }>> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  return coreRunSideList(runtime, workspaceId, project);
}

export async function runSideClose(project: string, name: string): Promise<void> {
  const config = loadConfig();
  const proj = config.projects[project];
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  await coreRunSideClose(
    runtime,
    workspaceId,
    project,
    name,
    proj?.path,
    config.defaults.worktreeDir ?? ".worktrees",
  );
}

export const sideCommand = new Command("side").description(
  "Spawn and manage side-sessions (research/debug) — fresh-context tabs off the daemon lifecycle",
);

sideCommand
  .command("spawn")
  .description(
    "Spawn a fresh-context side-session tab for research or debug (--role required)",
  )
  .argument("<project>", "Project name (must be registered)")
  .argument("[topic]", "Topic or question for the session (omit with --topic-file)")
  .requiredOption("--role <role>", "Session role: research | debug")
  .option("--name <name>", "Session name (default: auto-generated side-N)")
  .option(
    "--direction <dir>",
    "Placement: tab (default) or split direction (right|left|up|down)",
    "tab",
  )
  .option("--agent <name>", "Agent CLI to use (claude|opencode)", "claude")
  .option("--topic-file <path>", "Read topic from file instead of positional arg ('-' for stdin)")
  .action(
    async (
      project: string,
      topic: string | undefined,
      opts: { role: string; name?: string; direction: PanePlacement; agent: string; topicFile?: string },
    ) => {
      try {
        const resolvedTopic = await resolveTextInput({
          positional: topic,
          filePath: opts.topicFile,
          label: "topic",
        });
        const pane = await runSideSpawn({
          project,
          topic: resolvedTopic,
          role: opts.role,
          name: opts.name,
          direction: opts.direction,
          agent: opts.agent,
        });
        console.log(chalk.green(`✔ Side session '${pane.title}' spawned (${pane.surfaceId})`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    },
  );

sideCommand
  .command("list")
  .description("List live side-sessions for a project")
  .argument("<project>", "Project name")
  .action(async (project: string) => {
    try {
      const sessions = await runSideList(project);
      if (sessions.length === 0) {
        console.log(chalk.yellow(`No live side-sessions for ${project}.`));
        return;
      }
      for (const s of sessions) {
        console.log(`  ${s.name}  (${s.surfaceId})`);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

sideCommand
  .command("send")
  .description("Send a follow-up message to an existing side-session")
  .argument("<project>", "Project name")
  .argument("<name>", "Session name (e.g. side-1)")
  .argument("[message]", "Message to send (omit with --message-file)")
  .option("--message-file <path>", "Read message from file ('-' for stdin)")
  .action(
    async (
      project: string,
      name: string,
      message: string | undefined,
      opts: { messageFile?: string },
    ) => {
      try {
        const resolvedMessage = await resolveTextInput({
          positional: message,
          filePath: opts.messageFile,
          label: "message",
        });
        await runSideSend(project, name, resolvedMessage);
        console.log(chalk.green(`✔ Sent to ${project}:${name}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    },
  );

sideCommand
  .command("close")
  .description("Close a side-session (closes its tab)")
  .argument("<project>", "Project name")
  .argument("<name>", "Session name")
  .action(async (project: string, name: string) => {
    try {
      await runSideClose(project, name);
      console.log(chalk.green(`✔ Closed ${project}:${name}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
