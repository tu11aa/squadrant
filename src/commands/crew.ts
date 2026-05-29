import { Command } from "commander";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import {
  createClaudeDriver,
  createCodexDriver,
  createGeminiDriver,
  createOpencodeDriver,
  CapabilityRegistry,
} from "../drivers/index.js";
import type { PaneRef, PanePlacement, RuntimeDriver } from "../runtimes/types.js";
import { buildDispatchRequest, cockpitdCall, sendCodexFirstTurn } from "./crew-control.js";
import { writePerCrewSettingsLocal, writePerCrewOpencodeConfig } from "../lib/per-crew-settings.js";
import { TERMINAL_STATES, type TaskRecord } from "../control/types.js";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");

// Poll-based first-turn delivery: after launching the CLI, poll the pane
// until the agent is ready to accept input. Replaces a fixed delay (was 3s).
// The stabilised-screen check is heuristic: non-empty + unchanged between two
// consecutive reads suggests the TUI finished booting and is idle at its prompt.
const SEND_FIRST_TURN_FLOOR_MS = 1500;
const POLL_INTERVAL_MS = 750;
const SEND_FIRST_TURN_TIMEOUT_MS = 20000;
const POST_SEND_CHECK_MS = 750;

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

export async function sendFirstTurnWhenReady(
  runtime: RuntimeDriver,
  pane: PaneRef,
  task: string,
  preLaunchScreen: string,
): Promise<void> {
  await new Promise((r) => setTimeout(r, SEND_FIRST_TURN_FLOOR_MS));

  const maxPolls = Math.floor(
    (SEND_FIRST_TURN_TIMEOUT_MS - SEND_FIRST_TURN_FLOOR_MS) / POLL_INTERVAL_MS,
  );
  let previousScreen = "";
  let stable = false;

  for (let i = 0; i < maxPolls && !stable; i++) {
    const screen = (await runtime.readPaneScreen(pane)) ?? "";
    // Ready = the agent prompt is actually up: screen is non-empty, settled
    // (unchanged between two consecutive reads), AND has advanced past the
    // un-entered launch command line. The last condition prevents sending the
    // task onto the shell line before the TUI takes over — which concatenates
    // onto the launch command and triggers a shell parse error (opencode
    // boot-race). A momentarily static launch line is not readiness.
    if (screen.length > 0 && screen === previousScreen && screen !== preLaunchScreen) {
      stable = true;
    } else {
      previousScreen = screen;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // Snapshot the screen immediately before sending so the post-send check can
  // tell whether the keystrokes were received. Comparing against the raw task
  // text is unreliable: sendToPane collapses newlines to spaces (#136), so a
  // multi-line task never appears verbatim in the single-line pane render and
  // the check would always re-send a duplicate first turn (#168).
  const preSendScreen = (await runtime.readPaneScreen(pane)) ?? "";
  await runtime.sendToPane(pane, task);

  await new Promise((r) => setTimeout(r, POST_SEND_CHECK_MS));
  const afterScreen = (await runtime.readPaneScreen(pane)) ?? "";
  if (afterScreen === preSendScreen) {
    // Screen unchanged after sending → nothing was received at all; re-send once.
    await runtime.sendToPane(pane, task);
  }
}

export interface CrewSpawnInput {
  project: string;
  task: string;
  name?: string;
  direction?: PanePlacement;
  agent?: string;
  approvalPolicy?: string;
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
    opencode: createOpencodeDriver(),
  });
  const agentName = input.agent ?? "claude";
  const agent = agents.get(agentName);
  if (!agent) {
    throw new Error(`Unknown agent '${agentName}'. Known: claude, codex, gemini, opencode.`);
  }

  // Codex: route through the interactive control-plane daemon (PR #98) instead
  // of the print-mode CLI path. The dispatched task is driven via the
  // crew-attach renderer running in the captain tab, so 'crew send' / 'crew
  // read' / 'crew close' work identically to the Claude crew UX.
  if (agentName === "codex") {
    // Mirror claude's --append-system-prompt-file: read the crew role template
    // and forward it to codex via thread/start.developerInstructions so the
    // session knows it's a crew member, not a bare shell.
    const codexRoleFile = path.join(TEMPLATES_DIR, `crew.${agent.templateSuffix}.md`);
    const roleInstructions = fs.existsSync(codexRoleFile)
      ? fs.readFileSync(codexRoleFile, "utf8")
      : undefined;
    return runCodexInteractiveSpawn({
      project: input.project,
      task: input.task,
      cwd: proj.path,
      runtime,
      workspaceId: captain.id,
      name,
      direction: input.direction ?? "tab",
      approvalPolicy: input.approvalPolicy,
      roleInstructions,
    });
  }

  const promptFile = path.join(TEMPLATES_DIR, `crew.${agent.templateSuffix}.md`);
  // Claude crews run interactively (no -p) so the session stays alive between
  // turns; the task is sent via cmux after the CLI boots. Other agents that
  // don't yet honor `interactive` will keep their existing print-mode shape —
  // a known limitation tracked for future work.
  const interactive = agent.name === "claude" || agent.name === "opencode";
  // Honor configured model routing only when the spawn agent matches the
  // configured role agent — model names are agent-specific (e.g. "sonnet" is
  // a Claude alias; codex/gemini have their own routing). Cross-agent crews
  // fall back to the agent's own default to avoid passing an invalid model arg.
  const crewRole = config.defaults.roles?.crew;
  const crewModel = crewRole && crewRole.agent === agent.name ? crewRole.model : undefined;

  // Claude crews route through the control-plane daemon (PR #85 + this spec)
  // so the captain learns terminal state via `cockpit crew status` instead
  // of scraping the pane. The cmux tab still does the actual CLI launch —
  // the daemon doesn't own Claude's PID (Approach 3 boundary). Hook bridge
  // (per-crew settings.json with Stop/SubagentStop/SessionEnd → cockpit
  // crew _hook) keeps the daemon's heartbeat fresh; explicit
  // `cockpit crew signal done` from the crew template emits terminal state.
  if (agentName === "claude") {
    const req = buildDispatchRequest({
      provider: "claude",
      mode: "interactive",
      project: input.project,
      cwd: proj.path,
      task: input.task,
      name,
    });
    // Fail loud if daemon unreachable — refusal-to-degrade.
    const rec = (await cockpitdCall(req)) as TaskRecord;
    // Write cockpit hooks to <cwd>/.claude/settings.local.json so they are
    // auto-loaded as a project-local settings source. The cmux claude wrapper
    // injects its own hooks via --settings (level 2 precedence), but hooks
    // merge across *different* settings sources — only multiple --settings
    // flags collide. .claude/settings.local.json is gitignored and merges
    // with any existing user hooks (#134).
    writePerCrewSettingsLocal({ projectCwd: proj.path });
    const cliCommand = agent.buildCommand({
      prompt: input.task,
      workdir: proj.path,
      role: "crew",
      promptFile,
      interactive: true,
      ...(crewModel ? { model: crewModel } : {}),
    });
    const direction: PanePlacement = input.direction ?? "tab";
    const title = titleFor(input.project, name);
    const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });
    // Prefix the CLI command with env so the hook bridge + signal verb
    // running inside the crew's cmux tab can identify their task.
    const envPrefix = `COCKPIT_CREW_TASK_ID=${rec.id} COCKPIT_CREW_PROJECT=${input.project}`;
    await runtime.sendToPane(pane, `${envPrefix} ${cliCommand}`);
    const preLaunchScreen = (await runtime.readPaneScreen(pane)) ?? "";
    await sendFirstTurnWhenReady(runtime, pane, input.task, preLaunchScreen);
    return { ...pane, title };
  }

  // Opencode crews route through the control-plane daemon so the captain
  // learns terminal state via `cockpit crew status` instead of scraping the
  // pane. Same approach as claude: daemon owns the state ledger, cmux tab
  // does the actual CLI launch. No hook bridge (opencode has no hooks); the
  // crew template instructs explicit `cockpit crew signal done|blocked|failed`.
  if (agentName === "opencode") {
    const req = buildDispatchRequest({
      provider: "opencode",
      mode: "interactive",
      project: input.project,
      cwd: proj.path,
      task: input.task,
      name,
      // opencode has no heartbeat hook, so a normal budget would false-stall
      // every crew after 5min; use a 24h budget to effectively disable stall
      // detection until a plugin-based liveness bridge exists.
      budgetMs: 86400000,
    });
    const rec = (await cockpitdCall(req)) as TaskRecord;
    const opencodeConfigPath = writePerCrewOpencodeConfig({
      stateRoot: path.join(os.homedir(), ".config", "cockpit", "state"),
      project: input.project,
      taskId: rec.id,
    });
    const cliCommand = agent.buildCommand({
      prompt: input.task,
      workdir: proj.path,
      role: "crew",
      promptFile,
      interactive: true,
      model: crewModel,
    });
    const direction: PanePlacement = input.direction ?? "tab";
    const title = titleFor(input.project, name);
    const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });
    const envPrefix = `COCKPIT_CREW_TASK_ID=${rec.id} COCKPIT_CREW_PROJECT=${input.project}`;
    await runtime.sendToPane(pane, `${envPrefix} OPENCODE_CONFIG=${opencodeConfigPath} ${cliCommand}`);
    const preLaunchScreen = (await runtime.readPaneScreen(pane)) ?? "";
    await sendFirstTurnWhenReady(runtime, pane, input.task, preLaunchScreen);
    return { ...pane, title };
  }

  const cliCommand = agent.buildCommand({
    prompt: input.task,
    workdir: proj.path,
    role: "crew",
    promptFile,
    interactive,
    model: crewModel,
  });

  const direction: PanePlacement = input.direction ?? "tab";
  const title = titleFor(input.project, name);
  const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });

  // Step 1: launch the CLI in the new tab.
  await runtime.sendToPane(pane, cliCommand);

  // Step 2: for interactive sessions, poll until the CLI is ready, then send
  // the task as the first prompt. For non-interactive (legacy) the prompt is
  // already baked into cliCommand, so we're done.
  if (interactive) {
    const preLaunchScreen = (await runtime.readPaneScreen(pane)) ?? "";
    await sendFirstTurnWhenReady(runtime, pane, input.task, preLaunchScreen);
  }

  return { ...pane, title };
}

async function runCodexInteractiveSpawn(o: {
  project: string;
  task: string;
  cwd: string;
  runtime: RuntimeDriver;
  workspaceId: string;
  name: string;
  direction: PanePlacement;
  approvalPolicy?: string;
  roleInstructions?: string;
}): Promise<PaneRef> {
  const req = buildDispatchRequest({
    provider: "codex",
    mode: "interactive",
    project: o.project,
    cwd: o.cwd,
    task: o.task,
    name: o.name,
    ...(o.approvalPolicy ? { approvalPolicy: o.approvalPolicy } : {}),
    ...(o.roleInstructions ? { roleInstructions: o.roleInstructions } : {}),
  });
  const rec = (await cockpitdCall(req)) as TaskRecord;
  const title = titleFor(o.project, o.name);
  const pane = await o.runtime.newPane({
    workspaceId: o.workspaceId,
    direction: o.direction,
    title,
  });
  await o.runtime.sendToPane(pane, `cockpit crew attach ${rec.id}`);
  // Match the claude UX where the task arg becomes the first turn. The codex
  // dispatch only opens the thread; the task text never reaches the model
  // unless we send it. Fire-and-forget: the renderer in the tab will pick up
  // streamed deltas once it attaches. Skip the deprecated "(interactive)"
  // placeholder which `crew chat` passes when no task was provided.
  if (o.task && o.task !== "(interactive)") {
    void sendCodexFirstTurn(rec.id, o.task).catch((e: unknown) => {
      process.stderr.write(`(first-turn delivery failed: ${(e as Error).message})\n`);
    });
  }
  return { ...pane, title };
}

export async function runCrewSend(project: string, name: string, message: string): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const crew = await findCrew(runtime, workspaceId, project, name);
  if (!crew) {
    throw new Error(`Crew '${name}' not found for ${project}. Run 'cockpit crew list ${project}'.`);
  }
  // Best-effort: if the daemon task for this crew is terminal, reopen it so
  // the next signal done is a real transition and fires CREW DONE (#148).
  try {
    const tasks = (await cockpitdCall({ kind: "list", project })) as TaskRecord[];
    const task = tasks.find((t) => t.name === name && TERMINAL_STATES.has(t.state));
    if (task) {
      await cockpitdCall({ kind: "event", project, event: { type: "task.reopened", id: task.id } });
    }
  } catch {
    // Swallow daemon errors so crews without a daemon or offline daemon
    // still receive the sent message.
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
  .option("--agent <name>", "Agent CLI to use (claude|codex|gemini|opencode)", "claude")
  .option("--approval", "force codex approvalPolicy='untrusted' (codex only; exercises gate primitive)", false)
  .action(
    async (
      project: string,
      task: string,
      opts: { name?: string; direction: PanePlacement; agent: string; approval: boolean },
    ) => {
      try {
        const pane = await runCrewSpawn({
          project,
          task,
          name: opts.name,
          direction: opts.direction,
          agent: opts.agent,
          ...(opts.approval ? { approvalPolicy: "untrusted" } : {}),
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
