import { Command } from "commander";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import {
  createClaudeDriver,
  createCodexDriver,
  createGeminiDriver,
  createAiderDriver,
  CapabilityRegistry,
} from "../drivers/index.js";
import type { PaneRef } from "../runtimes/types.js";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");

export interface CrewSpawnInput {
  project: string;
  task: string;
  direction?: "right" | "left" | "up" | "down";
  agent?: string;
}

export async function runCrewSpawn(input: CrewSpawnInput): Promise<PaneRef> {
  const config = loadConfig();
  const project = config.projects[input.project];
  if (!project) {
    throw new Error(`Project '${input.project}' not found. Run 'cockpit projects list'.`);
  }

  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() })
    .forProject(input.project, config);

  const captain = await runtime.status(project.captainName);
  if (!captain) {
    throw new Error(`Captain workspace '${project.captainName}' is not running. Run 'cockpit launch ${input.project}' first.`);
  }

  const agents = new CapabilityRegistry({
    claude: createClaudeDriver(),
    codex: createCodexDriver(),
    gemini: createGeminiDriver(),
    aider: createAiderDriver(),
  });
  const agentName = input.agent ?? "claude";
  const agent = agents.get(agentName);
  if (!agent) {
    throw new Error(`Unknown agent '${agentName}'. Known: claude, codex, gemini, aider.`);
  }

  const promptFile = path.join(TEMPLATES_DIR, `crew.${agent.templateSuffix}.md`);
  const command = agent.buildCommand({
    prompt: input.task,
    workdir: project.path,
    role: "crew",
    promptFile,
  });

  const direction = input.direction ?? "right";
  const title = `🔧 ${input.project}-crew`;
  const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });
  await runtime.sendToPane(pane, command);
  return pane;
}

export const crewCommand = new Command("crew").description("Spawn and manage crew sessions in split panes");

crewCommand
  .command("spawn")
  .description("Spawn a crew session in a split pane next to the project's captain")
  .argument("<project>", "Project name (must be registered)")
  .argument("<task>", "Task prompt for the crew session")
  .option("--direction <dir>", "Split direction (right|left|up|down)", "right")
  .option("--agent <name>", "Agent CLI to use (claude|codex|gemini|aider)", "claude")
  .action(async (project: string, task: string, opts: { direction: "right" | "left" | "up" | "down"; agent: string }) => {
    try {
      const pane = await runCrewSpawn({ project, task, direction: opts.direction, agent: opts.agent });
      console.log(chalk.green(`✔ Crew spawned in ${pane.workspaceId} ${pane.surfaceId}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
