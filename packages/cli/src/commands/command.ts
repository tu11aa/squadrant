import { Command } from "commander";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "@cockpit/shared";
import { createCmuxDriver, RuntimeRegistry } from "@cockpit/workspaces";
import type { PaneRef } from "@cockpit/workspaces";
import {
  createClaudeDriver,
  createCodexDriver,
  createGeminiDriver,
  createOpencodeDriver,
  CapabilityRegistry,
} from "@cockpit/agents";
import { resolveCmuxBin } from "@cockpit/shared";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");

type CommandTask = "briefing" | "learnings-review" | "wiki-aggregate";

const TASK_PROMPTS: Record<CommandTask, string> = {
  briefing:
    "Run your daily briefing using the cockpit:command-ops skill. Read all spoke handoffs, yesterday's logs, current status; produce a concise cross-project briefing; save to {hubVault}/daily-logs/YYYY-MM-DD.md; then exit.",
  "learnings-review":
    "Run a learnings review using the cockpit:command-ops skill. Scan {spokeVault}/learnings across all projects, identify cross-project patterns, propose captured-skill or fix actions, and exit when done.",
  "wiki-aggregate":
    "Run a wiki aggregation pass using the cockpit:command-ops skill. Scan each spoke wiki index, identify shared knowledge worth promoting, write hub wiki pages, and exit when done.",
};

export interface CommandSpawnInput {
  task: CommandTask;
  direction?: "right" | "left" | "up" | "down";
  agent?: string;
}

function detectCurrentWorkspace(): string {
  const out = execSync(`"${resolveCmuxBin()}" current-workspace`, { encoding: "utf-8" }).trim();
  const match = out.match(/workspace:\d+/);
  if (!match) {
    throw new Error("Could not detect current cmux workspace. Run `cockpit command` from inside a cmux workspace.");
  }
  return match[0];
}

export async function runCommandSpawn(input: CommandSpawnInput): Promise<PaneRef> {
  const prompt = TASK_PROMPTS[input.task];
  if (!prompt) {
    throw new Error(`Unknown task '${input.task}'. Known: briefing, learnings-review, wiki-aggregate.`);
  }

  const config = loadConfig();
  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).global(config);

  const workspaceId = detectCurrentWorkspace();

  const agents = new CapabilityRegistry({
    claude: createClaudeDriver(),
    codex: createCodexDriver(),
    gemini: createGeminiDriver(),
    opencode: createOpencodeDriver(),
  });
  const agentName = input.agent ?? "claude";
  const agent = agents.get(agentName);
  if (!agent) {
    throw new Error(`Unknown agent '${agentName}'. Known: claude, codex, gemini, opencode.`);
  }

  const promptFile = path.join(TEMPLATES_DIR, `command.${agent.templateSuffix}.md`);
  const cliCommand = agent.buildCommand({
    prompt,
    workdir: process.cwd(),
    role: "command",
    promptFile,
  });

  const direction = input.direction ?? "right";
  const title = `🤖 command-${input.task}`;
  const pane = await runtime.newPane({ workspaceId, direction, title });
  await runtime.sendToPane(pane, cliCommand);
  return pane;
}

export const commandCommand = new Command("command")
  .description("Spawn a one-shot Command session in a split pane (briefing | learnings-review | wiki-aggregate)")
  .option("--task <name>", "Task prompt to bake in (briefing|learnings-review|wiki-aggregate)", "briefing")
  .option("--direction <dir>", "Split direction (right|left|up|down)", "right")
  .option("--agent <name>", "Agent CLI to use (claude|codex|gemini|opencode)", "claude")
  .action(async (opts: { task: CommandTask; direction: "right" | "left" | "up" | "down"; agent: string }) => {
    try {
      const pane = await runCommandSpawn({ task: opts.task, direction: opts.direction, agent: opts.agent });
      console.log(chalk.green(`✔ Command spawned in ${pane.workspaceId} ${pane.surfaceId} (task: ${opts.task})`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
