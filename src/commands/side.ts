import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "@cockpit/shared";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import {
  createClaudeDriver,
  createCodexDriver,
  createGeminiDriver,
  createOpencodeDriver,
  CapabilityRegistry,
} from "../drivers/index.js";
import type { PaneRef, PanePlacement } from "../runtimes/types.js";
import { resolveCaptainWorkspace, sendFirstTurnWhenReady } from "./crew.js";
import { resolveTextInput } from "@cockpit/shared";
import { addWorktree, removeWorktree, worktreePath } from "@cockpit/shared";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");

// Debug scratch worktrees branch off develop (same as crew --worktree).
const WORKTREE_BASE_BRANCH = "develop";

const SIDE_ROLES = ["research", "debug"] as const;
type SideRole = (typeof SIDE_ROLES)[number];

// POSIX single-quote a path so it is safe to embed in a shell command even
// when the path contains spaces or special characters.
function shellQuote(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

function titleFor(project: string, name: string): string {
  return `🗒 ${project}:${name}`;
}

function isSideTitle(project: string, title: string): boolean {
  return title.startsWith(`🗒 ${project}:`);
}

function nameFromTitle(project: string, title: string): string {
  return title.slice(`🗒 ${project}:`.length);
}

function nextAutoName(existingTitles: string[], project: string): string {
  const used = new Set<number>();
  for (const title of existingTitles) {
    const n = nameFromTitle(project, title).match(/^side-(\d+)$/);
    if (n) used.add(Number(n[1]));
  }
  let i = 1;
  while (used.has(i)) i++;
  return `side-${i}`;
}

/** Builds the first-turn message: topic + injected context the agent needs
 *  for handoff (spokeVault, project, role). For debug sessions, scratchWorktree
 *  is the isolated worktree path the session is running in. */
export function buildSideFirstTurn(
  topic: string,
  project: string,
  role: string,
  spokeVault: string,
  scratchWorktree?: string,
): string {
  const lines = [
    topic,
    "",
    "---",
    "Side-session context (for handoff use):",
    `Project: ${project}`,
    `Role: ${role}`,
    `Spoke vault: ${spokeVault}`,
  ];
  if (scratchWorktree) {
    lines.push(`Scratch worktree: ${scratchWorktree}`);
  }
  return lines.join("\n");
}

export interface SideSpawnInput {
  project: string;
  topic: string;
  role: string;
  name?: string;
  direction?: PanePlacement;
  agent?: string;
}

export async function runSideSpawn(input: SideSpawnInput): Promise<PaneRef> {
  const config = loadConfig();
  const proj = config.projects[input.project];
  if (!proj) {
    throw new Error(`Project '${input.project}' not found. Run 'cockpit projects list'.`);
  }

  if (!SIDE_ROLES.includes(input.role as SideRole)) {
    throw new Error(
      `Unknown side role '${input.role}'. Valid roles: ${SIDE_ROLES.join(", ")}.`,
    );
  }

  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(
    input.project,
    config,
  );
  const captain = await runtime.status(proj.captainName);
  if (!captain) {
    throw new Error(
      `Captain workspace '${proj.captainName}' is not running. Run 'cockpit launch ${input.project}' first.`,
    );
  }

  const existing = await runtime.listSurfaces(captain.id);
  const existingTitles = existing
    .filter((s) => s.title && isSideTitle(input.project, s.title))
    .map((s) => s.title!);

  if (input.name) {
    const wantTitle = titleFor(input.project, input.name);
    if (existingTitles.includes(wantTitle)) {
      throw new Error(
        `Side session '${input.name}' already exists for ${input.project}.`,
      );
    }
  }
  const name = input.name ?? nextAutoName(existingTitles, input.project);

  // Debug sessions run in an isolated scratch git worktree so instrumentation
  // edits never touch the captain's checkout. Research sessions share the root
  // checkout. The #279 fix (cd into spawnCwd before launching CLI) applies to both.
  const spawnCwd = input.role === "debug"
    ? addWorktree({
        repoRoot: proj.path,
        worktreeDir: config.defaults.worktreeDir ?? ".worktrees",
        project: input.project,
        name,
        base: WORKTREE_BASE_BRANCH,
      })
    : proj.path;

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

  const direction: PanePlacement = input.direction ?? "tab";
  const title = titleFor(input.project, name);
  const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });

  const cliCommand = agent.buildCommand({
    prompt: input.topic,
    workdir: spawnCwd,
    role: "side",
    promptFile: fs.existsSync(promptFile) ? promptFile : undefined,
    interactive: true,
    permissionMode: config.defaults.permissions?.crew ?? "auto",
    ...(sideModel ? { model: sideModel } : {}),
  });

  await runtime.sendToPane(pane, `cd ${shellQuote(spawnCwd)} && ${cliCommand}`);
  const preLaunchScreen = (await runtime.readPaneScreen(pane)) ?? "";

  const firstTurn = buildSideFirstTurn(
    input.topic,
    input.project,
    input.role,
    proj.spokeVault ?? "",
    input.role === "debug" ? spawnCwd : undefined,
  );
  await sendFirstTurnWhenReady(runtime, pane, firstTurn, preLaunchScreen);

  return { ...pane, title };
}

export async function runSideSend(
  project: string,
  name: string,
  message: string,
): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const want = titleFor(project, name);
  const surfaces = await runtime.listSurfaces(workspaceId);
  const pane = surfaces.find((s) => s.title === want) ?? null;
  if (!pane) {
    throw new Error(
      `Side session '${name}' not found for ${project}. Run 'cockpit side list ${project}'.`,
    );
  }
  await runtime.sendToPane(pane, message);
}

export async function runSideList(
  project: string,
): Promise<Array<{ name: string; surfaceId: string }>> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces
    .filter((s) => s.title && isSideTitle(project, s.title))
    .map((s) => ({
      name: nameFromTitle(project, s.title!),
      surfaceId: s.surfaceId,
    }));
}

export async function runSideClose(project: string, name: string): Promise<void> {
  const config = loadConfig();
  const proj = config.projects[project];
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const want = titleFor(project, name);
  const surfaces = await runtime.listSurfaces(workspaceId);
  const pane = surfaces.find((s) => s.title === want) ?? null;
  if (!pane) {
    throw new Error(
      `Side session '${name}' not found for ${project}. Run 'cockpit side list ${project}'.`,
    );
  }
  await runtime.closePane(pane);
  // Prune the scratch worktree if this was a debug session. Detection is
  // filesystem-based: debug spawns create a worktree at the deterministic path;
  // research spawns do not. If the path exists, remove it (best-effort).
  if (proj) {
    const wtPath = worktreePath(
      proj.path,
      config.defaults.worktreeDir ?? ".worktrees",
      project,
      name,
    );
    if (fs.existsSync(wtPath)) {
      try {
        removeWorktree(proj.path, wtPath);
      } catch (e) {
        process.stderr.write(`(worktree remove failed: ${(e as Error).message})\n`);
      }
    }
  }
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
