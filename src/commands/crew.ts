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
import type { PaneRef, PanePlacement, RuntimeDriver } from "../runtimes/types.js";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");

// Time to wait between launching the crew CLI and sending the first prompt.
// The CLI needs a moment to initialize plugins / load the system prompt before
// it's ready to accept input. 3s matches the captain launch path.
const CLI_BOOT_DELAY_MS = 3000;

function titleFor(project: string, name: string): string {
  return `🔧 ${project}:${name}`;
}

function isCrewTitle(project: string, title: string): boolean {
  return title.startsWith(`🔧 ${project}:`);
}

function nameFromTitle(project: string, title: string): string {
  return title.slice(`🔧 ${project}:`.length);
}

async function listProjectCrews(
  runtime: RuntimeDriver,
  workspaceId: string,
  project: string,
): Promise<PaneRef[]> {
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces.filter((s) => s.title && isCrewTitle(project, s.title));
}

async function findCrew(
  runtime: RuntimeDriver,
  workspaceId: string,
  project: string,
  name: string,
): Promise<PaneRef | null> {
  const want = titleFor(project, name);
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces.find((s) => s.title === want) ?? null;
}

function nextAutoName(existingTitles: string[], project: string): string {
  const used = new Set<number>();
  for (const title of existingTitles) {
    const n = nameFromTitle(project, title).match(/^crew-(\d+)$/);
    if (n) used.add(Number(n[1]));
  }
  let i = 1;
  while (used.has(i)) i++;
  return `crew-${i}`;
}

async function resolveCaptainWorkspace(project: string): Promise<{
  runtime: RuntimeDriver;
  workspaceId: string;
}> {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) {
    throw new Error(`Project '${project}' not found. Run 'cockpit projects list'.`);
  }
  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, config);
  const captain = await runtime.status(proj.captainName);
  if (!captain) {
    throw new Error(
      `Captain workspace '${proj.captainName}' is not running. Run 'cockpit launch ${project}' first.`,
    );
  }
  return { runtime, workspaceId: captain.id };
}

export interface CrewSpawnInput {
  project: string;
  task: string;
  name?: string;
  direction?: PanePlacement;
  agent?: string;
}

export async function runCrewSpawn(input: CrewSpawnInput): Promise<PaneRef> {
  const config = loadConfig();
  const proj = config.projects[input.project];
  if (!proj) {
    throw new Error(`Project '${input.project}' not found. Run 'cockpit projects list'.`);
  }

  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(input.project, config);
  const captain = await runtime.status(proj.captainName);
  if (!captain) {
    throw new Error(
      `Captain workspace '${proj.captainName}' is not running. Run 'cockpit launch ${input.project}' first.`,
    );
  }

  const existing = await listProjectCrews(runtime, captain.id, input.project);
  const existingTitles = existing.map((s) => s.title!);
  if (input.name) {
    const wantTitle = titleFor(input.project, input.name);
    if (existingTitles.includes(wantTitle)) {
      throw new Error(
        `Crew '${input.name}' already exists for ${input.project}. Use 'cockpit crew send ${input.project} ${input.name}' to send a follow-up, or pick a different --name.`,
      );
    }
  }
  const name = input.name ?? nextAutoName(existingTitles, input.project);

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
  // Claude crews run interactively (no -p) so the session stays alive between
  // turns; the task is sent via cmux after the CLI boots. Other agents that
  // don't yet honor `interactive` will keep their existing print-mode shape —
  // a known limitation tracked for future work.
  const interactive = agent.name === "claude";
  const cliCommand = agent.buildCommand({
    prompt: input.task,
    workdir: proj.path,
    role: "crew",
    promptFile,
    interactive,
  });

  const direction: PanePlacement = input.direction ?? "tab";
  const title = titleFor(input.project, name);
  const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });

  // Step 1: launch the CLI in the new tab.
  await runtime.sendToPane(pane, cliCommand);

  // Step 2: for interactive sessions, wait for the CLI to boot, then send the
  // task as the first prompt. For non-interactive (legacy) the prompt is
  // already baked into cliCommand, so we're done.
  if (interactive) {
    await new Promise((r) => setTimeout(r, CLI_BOOT_DELAY_MS));
    await runtime.sendToPane(pane, input.task);
  }

  return { ...pane, title };
}

export async function runCrewSend(project: string, name: string, message: string): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const crew = await findCrew(runtime, workspaceId, project, name);
  if (!crew) {
    throw new Error(`Crew '${name}' not found for ${project}. Run 'cockpit crew list ${project}'.`);
  }
  await runtime.sendToPane(crew, message);
}

export async function runCrewRead(project: string, name: string): Promise<string> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const crew = await findCrew(runtime, workspaceId, project, name);
  if (!crew) {
    throw new Error(`Crew '${name}' not found for ${project}. Run 'cockpit crew list ${project}'.`);
  }
  return runtime.readPaneScreen(crew);
}

export async function runCrewClose(project: string, name: string): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const crew = await findCrew(runtime, workspaceId, project, name);
  if (!crew) {
    throw new Error(`Crew '${name}' not found for ${project}. Run 'cockpit crew list ${project}'.`);
  }
  await runtime.closePane(crew);
}

export async function runCrewList(project: string): Promise<Array<{ name: string; surfaceId: string }>> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const crews = await listProjectCrews(runtime, workspaceId, project);
  return crews.map((c) => ({
    name: nameFromTitle(project, c.title!),
    surfaceId: c.surfaceId,
  }));
}

export const crewCommand = new Command("crew").description(
  "Spawn and manage interactive crew sessions next to the project's captain",
);

crewCommand
  .command("spawn")
  .description(
    "Spawn an interactive crew session as a tab in the captain's workspace (use --direction to split into a pane instead)",
  )
  .argument("<project>", "Project name (must be registered)")
  .argument("<task>", "Initial task prompt for the crew session")
  .option("--name <name>", "Crew name (default: auto-generated crew-N)")
  .option("--direction <dir>", "Placement: tab (default) or split direction (right|left|up|down)", "tab")
  .option("--agent <name>", "Agent CLI to use (claude|codex|gemini|aider)", "claude")
  .action(
    async (
      project: string,
      task: string,
      opts: { name?: string; direction: PanePlacement; agent: string },
    ) => {
      try {
        const pane = await runCrewSpawn({
          project,
          task,
          name: opts.name,
          direction: opts.direction,
          agent: opts.agent,
        });
        console.log(chalk.green(`✔ Crew '${pane.title}' spawned (${pane.surfaceId})`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    },
  );

crewCommand
  .command("list")
  .description("List live crew sessions for a project")
  .argument("<project>", "Project name")
  .action(async (project: string) => {
    try {
      const crews = await runCrewList(project);
      if (crews.length === 0) {
        console.log(chalk.yellow(`No live crew sessions for ${project}.`));
        return;
      }
      for (const c of crews) {
        console.log(`  ${c.name}  (${c.surfaceId})`);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

crewCommand
  .command("send")
  .description("Send a follow-up message to an existing crew session")
  .argument("<project>", "Project name")
  .argument("<name>", "Crew name (e.g. crew-1)")
  .argument("<message>", "Message to send")
  .action(async (project: string, name: string, message: string) => {
    try {
      await runCrewSend(project, name, message);
      console.log(chalk.green(`✔ Sent to ${project}:${name}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

crewCommand
  .command("read")
  .description("Read the current screen of a crew session")
  .argument("<project>", "Project name")
  .argument("<name>", "Crew name")
  .action(async (project: string, name: string) => {
    try {
      const screen = await runCrewRead(project, name);
      console.log(screen);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

crewCommand
  .command("close")
  .description("Shutdown a crew session (closes its tab)")
  .argument("<project>", "Project name")
  .argument("<name>", "Crew name")
  .action(async (project: string, name: string) => {
    try {
      await runCrewClose(project, name);
      console.log(chalk.green(`✔ Closed ${project}:${name}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
