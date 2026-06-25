import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { addWorktree, removeWorktree, resolveWorktreeBase, resolveTextInput, TERMINAL_STATES } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import { resolveCrewRoute } from "@squadrant/core";
import { createCmuxDriver, RuntimeRegistry } from "@squadrant/workspaces";
import { listProjectCrews, findCrew, resolveCaptainWorkspace, sendFirstTurnWhenReady, getFreePort } from "@squadrant/workspaces";
import type { PaneRef, PanePlacement, RuntimeDriver } from "@squadrant/workspaces";
import {
  createClaudeDriver,
  createCodexDriver,
  createGeminiDriver,
  createOpencodeDriver,
  CapabilityRegistry,
} from "@squadrant/agents";
import { buildDispatchRequest, squadrantdCall, sendCodexFirstTurn } from "./crew-control.js";
import { tailLines } from "./crew-output.js";
import { writePerCrewSettingsLocal, writePerCrewOpencodeConfig } from "../lib/per-crew-settings.js";
import { buildCompletionProtocol, shellQuote, titleFor, nameFromTitle, nextAutoName, reapCrewChildren } from "@squadrant/core";
import type { TurnAcceptanceConfig } from "@squadrant/core";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "squadrant", "templates");

// Base branch for `--worktree` crew branches is derived at spawn time from
// origin/HEAD so repos using main, trunk, etc. work out of the box (#359).
// Still avoids "current HEAD" deliberately — basing off the captain's volatile
// HEAD would reintroduce the coupling this isolation feature exists to remove.

export interface CrewSpawnInput {
  project: string;
  task: string;
  name?: string;
  direction?: PanePlacement;
  agent?: string;
  approvalPolicy?: string;
  /** Opt-out (#296): run this crew in the root checkout instead of an isolated
   *  worktree. Pass true for small/one-off tasks that don't need branch isolation.
   *  Default (undefined/false) = isolated worktree — parallel-safe. */
  shared?: boolean;
  /** CP3 opt-in: gate risky tools (bash) so the captain approves them.
   *  codex maps this to approvalPolicy='untrusted'; opencode maps it to a
   *  bash:"ask" per-crew config. Default (false) = fully autonomous. */
  approval?: boolean;
  /** Per-spawn model override — takes precedence over defaults.roles.crew.model.
   *  Agent-specific alias (e.g. "sonnet", "opus" for claude; "gpt-5.5" for codex). */
  model?: string;
  /** True when --agent was explicitly passed by the caller; suppresses crew routing. */
  agentExplicit?: boolean;
}

export async function runCrewSpawn(input: CrewSpawnInput): Promise<PaneRef> {
  const config = loadConfig();
  const proj = config.projects[input.project];
  if (!proj) {
    throw new Error(`Project '${input.project}' not found. Run 'squadrant projects list'.`);
  }

  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(input.project, config);
  const captain = await runtime.status(proj.captainName);
  if (!captain) {
    throw new Error(
      `Captain workspace '${proj.captainName}' is not running. Run 'squadrant launch ${input.project}' first.`,
    );
  }

  const existing = await listProjectCrews(runtime, captain.id, input.project);
  const existingTitles = existing.map((s) => s.title!);
  if (input.name) {
    const wantTitle = titleFor(input.project, input.name);
    if (existingTitles.includes(wantTitle)) {
      throw new Error(
        `Crew '${input.name}' already exists for ${input.project}. Use 'squadrant crew send ${input.project} ${input.name}' to send a follow-up, or pick a different --name.`,
      );
    }
  }
  const name = input.name ?? nextAutoName(existingTitles, input.project);

  // Crews run in an isolated worktree+branch by default so multiple parallel
  // crews never collide on a shared HEAD (#296). Pass shared:true (CLI: --shared)
  // for small/one-off tasks that should run on the root checkout.
  // Build/daemon still run from the MAIN checkout's dist (#216): worktrees edit
  // source only. The worktree path becomes the crew's cwd via the existing cwd
  // plumbing (dispatch record + buildCommand workdir).
  const spawnCwd = !input.shared
    ? addWorktree({
        repoRoot: proj.path,
        worktreeDir: config.defaults.worktreeDir ?? ".worktrees",
        project: input.project,
        name,
        base: resolveWorktreeBase(proj.path),
      })
    : proj.path;

  // #275 leveled crew routing: consult routing rules when agent/model were not
  // explicitly provided by the caller. Explicit --agent or --model always win.
  const route = !input.agentExplicit && !input.model
    ? resolveCrewRoute(input.task, config)
    : null;
  if (route) {
    console.log(chalk.dim(`routed: tier=${route.tier} → ${route.agent}${route.model ? `/${route.model}` : ""} (rule: "${route.matchedRule}")`));
  }

  const agents = new CapabilityRegistry({
    claude: createClaudeDriver(),
    codex: createCodexDriver(),
    gemini: createGeminiDriver(),
    opencode: createOpencodeDriver(),
  });
  const agentName = route?.agent ?? input.agent ?? "claude";
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
      cwd: spawnCwd,
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
  const configModel = crewRole && crewRole.agent === agent.name ? crewRole.model : undefined;
  const crewModel = input.model ?? route?.model ?? configModel;

  // Claude crews route through the control-plane daemon (PR #85 + this spec)
  // so the captain learns terminal state via `squadrant crew status` instead
  // of scraping the pane. The cmux tab still does the actual CLI launch —
  // the daemon doesn't own Claude's PID (Approach 3 boundary). Hook bridge
  // (per-crew settings.json with Stop/SubagentStop/SessionEnd → squadrant
  // crew _hook) keeps the daemon's heartbeat fresh; explicit
  // `squadrant crew signal done` from the crew template emits terminal state.
  if (agentName === "claude") {
    const req = buildDispatchRequest({
      provider: "claude",
      mode: "interactive",
      project: input.project,
      cwd: spawnCwd,
      task: input.task,
      name,
    });
    // Fail loud if daemon unreachable — refusal-to-degrade.
    const rec = (await squadrantdCall(req)) as TaskRecord;
    // Write squadrant hooks to <cwd>/.claude/settings.local.json so they are
    // auto-loaded as a project-local settings source. The cmux claude wrapper
    // injects its own hooks via --settings (level 2 precedence), but hooks
    // merge across *different* settings sources — only multiple --settings
    // flags collide. .claude/settings.local.json is gitignored and merges
    // with any existing user hooks (#134).
    writePerCrewSettingsLocal({ projectCwd: spawnCwd });
    const cliCommand = agent.buildCommand({
      prompt: input.task,
      workdir: spawnCwd,
      role: "crew",
      promptFile,
      interactive: true,
      // Permission mode is config-driven (defaults.permissions.crew) so squadrant
      // can default crews to 'auto' or keep the semi-automatic 'acceptEdits'
      // gate (auto-accept edits, still prompt for risky ops). Falls back to
      // 'acceptEdits' when unset.
      permissionMode: config.defaults.permissions?.crew ?? "acceptEdits",
      ...(crewModel ? { model: crewModel } : {}),
    });
    const direction: PanePlacement = input.direction ?? "tab";
    const title = titleFor(input.project, name);
    const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });
    // Prefix the CLI command with env so the hook bridge + signal verb
    // running inside the crew's cmux tab can identify their task.
    const envPrefix = `SQUADRANT_CREW_TASK_ID=${rec.id} SQUADRANT_CREW_PROJECT=${input.project}`;
    await runtime.sendToPane(pane, `cd ${shellQuote(spawnCwd)} && ${envPrefix} ${cliCommand}`);
    const preLaunchScreen = (await runtime.readPaneScreen(pane)) ?? "";
    await sendFirstTurnWhenReady(runtime, pane, `${input.task}\n\n${buildCompletionProtocol(rec.id, input.project)}`, preLaunchScreen);
    return { ...pane, title };
  }

  // Opencode crews route through the control-plane daemon so the captain
  // learns terminal state via `squadrant crew status` instead of scraping the
  // pane. Same approach as claude: daemon owns the state ledger, cmux tab
  // does the actual CLI launch. No hook bridge (opencode has no hooks); the
  // crew template instructs explicit `squadrant crew signal done|blocked|failed`.
  if (agentName === "opencode") {
    // Bind the crew's embedded opencode HTTP server on a known port so the
    // daemon's SSE bridge can subscribe to /event for turn-end detection.
    const serverPort = await getFreePort();
    const req = buildDispatchRequest({
      provider: "opencode",
      mode: "interactive",
      project: input.project,
      cwd: spawnCwd,
      task: input.task,
      name,
      // opencode has no heartbeat hook, so a normal budget would false-stall
      // every crew after 5min; use a 24h budget to effectively disable stall
      // detection. The SSE bridge (serverPort) provides turn-end liveness.
      budgetMs: 86400000,
      serverPort,
    });
    const rec = (await squadrantdCall(req)) as TaskRecord;
    const opencodeConfigPath = writePerCrewOpencodeConfig({
      stateRoot: path.join(os.homedir(), ".config", "squadrant", "state"),
      project: input.project,
      taskId: rec.id,
      // CP3 opt-in: --approval gates bash so the captain approves shell commands.
      // Without it, bash stays auto-approved (default behavior unchanged).
      ...(input.approval ? { gateBash: true } : {}),
    });
    const cliCommand = agent.buildCommand({
      prompt: input.task,
      workdir: spawnCwd,
      role: "crew",
      promptFile,
      interactive: true,
      model: crewModel,
      port: serverPort,
    });
    const direction: PanePlacement = input.direction ?? "tab";
    const title = titleFor(input.project, name);
    const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });
    const envPrefix = `SQUADRANT_CREW_TASK_ID=${rec.id} SQUADRANT_CREW_PROJECT=${input.project}`;
    await runtime.sendToPane(pane, `cd ${shellQuote(spawnCwd)} && ${envPrefix} OPENCODE_CONFIG=${opencodeConfigPath} ${cliCommand}`);
    const preLaunchScreen = (await runtime.readPaneScreen(pane)) ?? "";
    await sendFirstTurnWhenReady(runtime, pane, `${input.task}\n\n${buildCompletionProtocol(rec.id, input.project)}`, preLaunchScreen, {
      // #235: opencode's idle splash ("Ask anything…") keeps mutating (cursor
      // blink, status line toggle), so the old screen-changed check would always
      // see a *different* screen and never re-send a dropped turn. The splashMarker
      // confirms the TUI actually left splash before declaring acceptance.
      splashMarker: "Ask anything…",
      // opencode has a wider boot-race window than claude, so allow 3 retries
      // instead of the default 2.
      retryLimit: 3,
    } satisfies TurnAcceptanceConfig);
    return { ...pane, title };
  }

  const cliCommand = agent.buildCommand({
    prompt: input.task,
    workdir: spawnCwd,
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
  const rec = (await squadrantdCall(req)) as TaskRecord;
  const title = titleFor(o.project, o.name);
  const pane = await o.runtime.newPane({
    workspaceId: o.workspaceId,
    direction: o.direction,
    title,
  });
  await o.runtime.sendToPane(pane, `squadrant crew attach ${rec.id}`);
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
    throw new Error(`Crew '${name}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  }
  // Best-effort attention-state handling before delivering the captain's answer.
  // Terminal task (done/failed): reopen so the next signal done fires CREW DONE (#148).
  // Blocked task: emit task.started to clear blocked→working so a subsequent real
  // permission prompt re-fires CREW BLOCKED (#182). Without this the second block
  // hits the idempotency guard (state-machine:69) and the captain misses it.
  // Awaiting-input task: same resume — crew re-enters working so the next block fires.
  try {
    const tasks = (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
    const task = tasks.find((t) => t.name === name);
    if (task) {
      if (TERMINAL_STATES.has(task.state)) {
        await squadrantdCall({ kind: "event", project, event: { type: "task.reopened", id: task.id } });
      } else if (task.state === "blocked" || task.state === "awaiting-input") {
        await squadrantdCall({ kind: "event", project, event: { type: "task.started", id: task.id } });
      }
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
    throw new Error(`Crew '${name}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  }
  return runtime.readPaneScreen(crew);
}

export async function runCrewClose(project: string, name: string): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  // resolveCaptainWorkspace already validated the project exists; reload for its
  // root path so we can tell a worktree crew (cwd != root) from a root crew.
  const projRoot = loadConfig().projects[project]?.path;
  // Terminalize the daemon task FIRST — before (and independent of) finding the
  // cmux pane (#184, hardened for #139). Without this, non-terminal tasks
  // (blocked/working/awaiting-input) linger in the daemon ledger and keep firing
  // phantom CREW BLOCKED/IDLE/STALLED pushes. Crucially, a DEAD crew's pane is
  // already gone, so gating terminalization on findCrew (the old order) left that
  // zombie record dangling forever. 'cancelled' is terminal but NOT in
  // ATTENTION_STATES, so firePush stays silent — captain initiated the close.
  let taskId: string | undefined;
  // Worktree to clean up after the pane closes — set only when this crew ran in
  // its own worktree (cwd recorded by the daemon differs from the root checkout).
  // A non-worktree crew has cwd === root (or unset), so this stays undefined and
  // close is unaffected (#216).
  let worktreeCwd: string | undefined;
  try {
    const tasks = (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
    const task = tasks.find((t) => t.name === name);
    if (task) {
      taskId = task.id;
      if (task.cwd && projRoot && task.cwd !== projRoot) {
        worktreeCwd = task.cwd;
      }
      if (!TERMINAL_STATES.has(task.state)) {
        await squadrantdCall({ kind: "event", project, event: { type: "task.cancelled", id: task.id, reason: "closed by captain" } });
      }
      // Codex teardown: the pane only hosts the `crew attach` renderer; the thread
      // (and its per-thread MCP servers) live on the shared app-server, so closing
      // the pane alone leaks them. Tell the daemon to archive the thread. Fires for
      // terminal and non-terminal crews alike (a finished codex crew still holds a
      // live thread until archived).
      if (task.provider === "codex") {
        await squadrantdCall({ kind: "codex-close", taskId: task.id });
      }
    }
  } catch {
    // Swallow daemon errors — a crew without a daemon must still close.
  }
  // Close the cmux pane if it still exists. A dead crew's pane is already gone —
  // that is not an error (the record is terminalized above); proceed to reap
  // children / clean the worktree. Only a genuine miss (no pane AND no daemon
  // task) is a typo → surface the not-found error.
  const crew = await findCrew(runtime, workspaceId, project, name);
  if (crew) {
    await runtime.closePane(crew);
  } else if (taskId === undefined) {
    throw new Error(`Crew '${name}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  }
  // Reap any surviving child processes (vitest workers, node subprocs, etc.)
  // that the cmux pane-close cascade may have missed.
  if (taskId !== undefined) {
    await reapCrewChildren(taskId);
  }
  // Auto-clean the crew's worktree AFTER its processes are gone, so we don't
  // yank a dir out from under a live shell. Best-effort: a failed removal must
  // not break close (the branch is preserved regardless).
  if (worktreeCwd && projRoot) {
    try {
      removeWorktree(projRoot, worktreeCwd);
    } catch (e) {
      process.stderr.write(`(worktree remove failed: ${(e as Error).message})\n`);
    }
  }
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
  .argument("[task]", "Initial task prompt for the crew session (omit with --task-file)")
  .option("--name <name>", "Crew name (default: auto-generated crew-N)")
  .option("--direction <dir>", "Placement: tab (default) or split direction (right|left|up|down)", "tab")
  .option("--agent <name>", "Agent CLI to use (claude|codex|gemini|opencode)", "claude")
  .option("--approval", "gate risky tools so the captain approves them (codex: approvalPolicy='untrusted'; opencode: bash:'ask')", false)
  .option("--shared", "run the crew in the root checkout instead of an isolated worktree (for small/one-off tasks)", false)
  .option("--task-file <path>", "Read task prompt from file instead of positional arg ('-' for stdin)")
  .option("--model <alias>", "Override crew model for this spawn (e.g. sonnet, opus); takes precedence over config defaults.roles.crew.model")
  .action(
    async (
      project: string,
      task: string | undefined,
      opts: { name?: string; direction: PanePlacement; agent: string; approval: boolean; shared: boolean; taskFile?: string; model?: string },
      cmd: Command,
    ) => {
      try {
        const resolvedTask = await resolveTextInput({ positional: task, filePath: opts.taskFile, label: "task" });
        const agentExplicit = cmd.getOptionValueSource("agent") === "cli";
        const pane = await runCrewSpawn({
          project,
          task: resolvedTask,
          name: opts.name,
          direction: opts.direction,
          agent: opts.agent,
          agentExplicit,
          // --approval is provider-agnostic: codex consumes approvalPolicy,
          // opencode consumes the `approval` flag (→ bash:"ask" per-crew config).
          ...(opts.approval ? { approvalPolicy: "untrusted", approval: true } : {}),
          ...(opts.shared ? { shared: true } : {}),
          ...(opts.model ? { model: opts.model } : {}),
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
  .argument("[message]", "Message to send (omit with --message-file)")
  .option("--message-file <path>", "Read message from file instead of positional arg ('-' for stdin)")
  .action(async (project: string, name: string, message: string | undefined, opts: { messageFile?: string }) => {
    try {
      const resolvedMessage = await resolveTextInput({ positional: message, filePath: opts.messageFile, label: "message" });
      await runCrewSend(project, name, resolvedMessage);
      console.log(chalk.green(`✔ Sent to ${project}:${name}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

crewCommand
  .command("read")
  .description("Read the current screen of a crew session (tail by default; use --full for the entire scrollback)")
  .argument("<project>", "Project name")
  .argument("<name>", "Crew name")
  .option("--lines <N>", "Number of trailing lines to show", "40")
  .option("--full", "Show the entire scrollback (overrides --lines)")
  .action(async (project: string, name: string, opts: { lines?: string; full?: boolean }) => {
    try {
      const screen = await runCrewRead(project, name);
      const out = opts.full ? screen : tailLines(screen, Number(opts.lines ?? 40));
      console.log(out);
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
