// Crew spawn and session orchestration — driver-agnostic algorithm (#367 command-thinning).
// CLI-edge concerns (concrete driver construction, daemon calls, settings writers,
// agent commands) are injected as closures; core only imports from @squadrant/shared
// and core-internal modules. The algorithm is IDENTICAL to the prior crew.ts
// implementation — zero behavior change.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type SquadrantConfig,
  loadConfig,
  type TaskRecord,
  type Provider,
  type PaneRef,
  type PanePlacement,
  type RuntimeDriver,
  type ControlEvent,
  addWorktree,
  resolveWorktreeBase,
  removeWorktree,
  TERMINAL_STATES,
} from "@squadrant/shared";
import { resolveCrewRoute, type CrewRouteResult } from "./crew-routing.js";
import {
  buildCompletionProtocol,
  shellQuote,
  titleFor,
  isCrewTitle,
  nameFromTitle,
  nextAutoName,
  type TurnAcceptanceConfig,
} from "./crew-protocol.js";
import { reapCrewChildren } from "./crew-lifecycle.js";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "squadrant", "templates");
const STATE_ROOT = path.join(os.homedir(), ".config", "squadrant", "state");

// ─── ResolvedAgent ────────────────────────────────────────────────────────────

/** Minimal agent shape needed by spawn orchestration. CLI constructs from AgentDriver.
 *
 *  Note on `buildCommand` typing: AgentDriver (from @squadrant/agents) declares
 *  role as Role (a union); this interface uses `string` to avoid importing from
 *  agents in core. The only value ever passed at the call sites is "crew", which
 *  satisfies Role at runtime. CLI callers use `as unknown as ResolvedAgent` to
 *  bridge the type gap safely. */
export interface ResolvedAgent {
  name: string;
  templateSuffix: string;
  buildCommand(opts: {
    prompt: string;
    workdir: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    role: any;
    promptFile: string;
    interactive: boolean;
    permissionMode?: string;
    model?: string;
    port?: number;
  }): string;
}

// ─── CrewSpawnInput ───────────────────────────────────────────────────────────

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
  /** Per-spawn model override — takes precedence over defaults.roles.crew.model. */
  model?: string;
  /** True when --agent was explicitly passed by the caller; suppresses crew routing. */
  agentExplicit?: boolean;
}

// ─── CrewSpawnDeps ───────────────────────────────────────────────────────────

export interface CrewSpawnDeps {
  runtime: RuntimeDriver;
  /**
   * CLI-edge: look up a resolved agent by name. Returns null if unknown.
   * Wraps CapabilityRegistry.get() from @squadrant/agents.
   */
  resolveAgent(name: string): ResolvedAgent | null;
  /**
   * CLI-edge: dispatch a crew task via the daemon.
   * Wraps buildDispatchRequest + squadrantdCall from crew-control.ts.
   */
  dispatchCrew(opts: {
    provider: Provider;
    mode: "interactive";
    project: string;
    cwd: string;
    task: string;
    name: string;
    budgetMs?: number;
    serverPort?: number;
    approvalPolicy?: string;
    roleInstructions?: string;
  }): Promise<TaskRecord>;
  /** CLI-edge: write squadrant hooks to <cwd>/.claude/settings.local.json (#134). */
  writeSettingsLocal(projectCwd: string): void;
  /** CLI-edge: write opencode permission config for an interactive crew. */
  writeOpencodeConfig(opts: { stateRoot: string; project: string; taskId: string; gateBash?: boolean }): string;
  /** CLI-edge: deliver the first turn once the agent pane is ready. */
  sendFirstTurn(pane: PaneRef, firstTurn: string, preLaunchScreen: string, opts?: TurnAcceptanceConfig): Promise<void>;
  /** CLI-edge: reserve an ephemeral TCP port for opencode's embedded HTTP server. */
  getFreePort(): Promise<number>;
  /** CLI-edge: deliver the task to a freshly-dispatched codex thread. */
  sendCodexFirstTurn(taskId: string, task: string): Promise<void>;
  /** Optional: called after routing to log the selected route (e.g. chalk.dim(...)). */
  onRouted?(route: CrewRouteResult): void;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function listCrewPanes(runtime: RuntimeDriver, workspaceId: string, project: string): Promise<PaneRef[]> {
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces.filter((s) => s.title && isCrewTitle(project, s.title));
}

async function findCrewPane(
  runtime: RuntimeDriver,
  workspaceId: string,
  project: string,
  name: string,
): Promise<PaneRef | null> {
  const want = titleFor(project, name);
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces.find((s) => s.title === want) ?? null;
}

// ─── Codex interactive spawn (private) ───────────────────────────────────────

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
  dispatchCrew: CrewSpawnDeps["dispatchCrew"];
  sendCodexFirstTurn: CrewSpawnDeps["sendCodexFirstTurn"];
}): Promise<PaneRef> {
  const rec = await o.dispatchCrew({
    provider: "codex",
    mode: "interactive",
    project: o.project,
    cwd: o.cwd,
    task: o.task,
    name: o.name,
    ...(o.approvalPolicy ? { approvalPolicy: o.approvalPolicy } : {}),
    ...(o.roleInstructions ? { roleInstructions: o.roleInstructions } : {}),
  });
  const title = titleFor(o.project, o.name);
  const pane = await o.runtime.newPane({
    workspaceId: o.workspaceId,
    direction: o.direction,
    title,
  });
  await o.runtime.sendToPane(pane, `squadrant crew attach ${rec.id}`);
  // Match the claude UX where the task arg becomes the first turn. The codex
  // dispatch only opens the thread; the task text never reaches the model
  // unless we send it. Fire-and-forget: the renderer in the tab picks up
  // streamed deltas once it attaches.
  if (o.task && o.task !== "(interactive)") {
    void o.sendCodexFirstTurn(rec.id, o.task).catch((e: unknown) => {
      process.stderr.write(`(first-turn delivery failed: ${(e as Error).message})\n`);
    });
  }
  return { ...pane, title };
}

// ─── runCrewSpawn ─────────────────────────────────────────────────────────────

export async function runCrewSpawn(
  input: CrewSpawnInput,
  config: SquadrantConfig,
  deps: CrewSpawnDeps,
): Promise<PaneRef> {
  const proj = config.projects[input.project];
  if (!proj) {
    throw new Error(`Project '${input.project}' not found. Run 'squadrant projects list'.`);
  }

  const captain = await deps.runtime.status(proj.captainName);
  if (!captain) {
    throw new Error(
      `Captain workspace '${proj.captainName}' is not running. Run 'squadrant launch ${input.project}' first.`,
    );
  }

  const existing = await listCrewPanes(deps.runtime, captain.id, input.project);
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
    deps.onRouted?.(route);
  }

  const agentName = route?.agent ?? input.agent ?? "claude";
  const agent = deps.resolveAgent(agentName);
  if (!agent) {
    throw new Error(`Unknown agent '${agentName}'. Known: claude, codex, gemini, opencode.`);
  }

  // Codex: route through the interactive control-plane daemon (PR #98) instead
  // of the print-mode CLI path. The dispatched task is driven via the
  // crew-attach renderer running in the captain tab, so 'crew send' / 'crew
  // read' / 'crew close' work identically to the Claude crew UX.
  if (agentName === "codex") {
    const codexRoleFile = path.join(TEMPLATES_DIR, `crew.${agent.templateSuffix}.md`);
    const roleInstructions = fs.existsSync(codexRoleFile)
      ? fs.readFileSync(codexRoleFile, "utf8")
      : undefined;
    return runCodexInteractiveSpawn({
      project: input.project,
      task: input.task,
      cwd: spawnCwd,
      runtime: deps.runtime,
      workspaceId: captain.id,
      name,
      direction: input.direction ?? "tab",
      approvalPolicy: input.approvalPolicy,
      roleInstructions,
      dispatchCrew: deps.dispatchCrew,
      sendCodexFirstTurn: deps.sendCodexFirstTurn,
    });
  }

  const promptFile = path.join(TEMPLATES_DIR, `crew.${agent.templateSuffix}.md`);
  // Claude crews run interactively (no -p) so the session stays alive between
  // turns; the task is sent via cmux after the CLI boots. Other agents that
  // don't yet honor `interactive` will keep their existing print-mode shape.
  const interactive = agent.name === "claude" || agent.name === "opencode";
  // Honor configured model routing only when the spawn agent matches the
  // configured role agent — model names are agent-specific. Cross-agent crews
  // fall back to the agent's own default to avoid passing an invalid model arg.
  const crewRole = config.defaults.roles?.crew;
  const configModel = crewRole && crewRole.agent === agent.name ? crewRole.model : undefined;
  const crewModel = input.model ?? route?.model ?? configModel;

  // Claude crews route through the control-plane daemon (PR #85) so the captain
  // learns terminal state via `squadrant crew status`. The cmux tab still does
  // the actual CLI launch — the daemon doesn't own Claude's PID. Hook bridge
  // (per-crew settings.json → Stop/SubagentStop/SessionEnd → squadrant crew _hook)
  // keeps the daemon's heartbeat fresh; `squadrant crew signal done` emits
  // terminal state.
  if (agentName === "claude") {
    const rec = await deps.dispatchCrew({
      provider: "claude",
      mode: "interactive",
      project: input.project,
      cwd: spawnCwd,
      task: input.task,
      name,
    });
    // Write squadrant hooks to <cwd>/.claude/settings.local.json so they are
    // auto-loaded as a project-local settings source. Merges with any existing
    // hooks — does not clobber the user's own personal hooks (#134).
    deps.writeSettingsLocal(spawnCwd);
    const cliCommand = agent.buildCommand({
      prompt: input.task,
      workdir: spawnCwd,
      role: "crew",
      promptFile,
      interactive: true,
      // Permission mode is config-driven so squadrant can default crews to 'auto'
      // or keep the semi-automatic 'acceptEdits' gate. Falls back to 'acceptEdits'.
      permissionMode: config.defaults.permissions?.crew ?? "acceptEdits",
      ...(crewModel ? { model: crewModel } : {}),
    });
    const direction: PanePlacement = input.direction ?? "tab";
    const title = titleFor(input.project, name);
    const pane = await deps.runtime.newPane({ workspaceId: captain.id, direction, title });
    // Prefix the CLI command with env so the hook bridge + signal verb running
    // inside the crew's cmux tab can identify their task.
    const envPrefix = `SQUADRANT_CREW_TASK_ID=${rec.id} SQUADRANT_CREW_PROJECT=${input.project}`;
    await deps.runtime.sendToPane(pane, `cd ${shellQuote(spawnCwd)} && ${envPrefix} ${cliCommand}`);
    const preLaunchScreen = (await deps.runtime.readPaneScreen(pane)) ?? "";
    await deps.sendFirstTurn(pane, `${input.task}\n\n${buildCompletionProtocol(rec.id, input.project)}`, preLaunchScreen);
    return { ...pane, title };
  }

  // Opencode crews route through the control-plane daemon so the captain learns
  // terminal state via `squadrant crew status`. No hook bridge (opencode has no
  // hooks); the crew template instructs explicit `squadrant crew signal done|blocked|failed`.
  if (agentName === "opencode") {
    // Bind the crew's embedded opencode HTTP server on a known port so the
    // daemon's SSE bridge can subscribe to /event for turn-end detection.
    const serverPort = await deps.getFreePort();
    const rec = await deps.dispatchCrew({
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
    const opencodeConfigPath = deps.writeOpencodeConfig({
      stateRoot: STATE_ROOT,
      project: input.project,
      taskId: rec.id,
      // CP3 opt-in: --approval gates bash so the captain approves shell commands.
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
    const pane = await deps.runtime.newPane({ workspaceId: captain.id, direction, title });
    const envPrefix = `SQUADRANT_CREW_TASK_ID=${rec.id} SQUADRANT_CREW_PROJECT=${input.project}`;
    await deps.runtime.sendToPane(pane, `cd ${shellQuote(spawnCwd)} && ${envPrefix} OPENCODE_CONFIG=${opencodeConfigPath} ${cliCommand}`);
    const preLaunchScreen = (await deps.runtime.readPaneScreen(pane)) ?? "";
    await deps.sendFirstTurn(pane, `${input.task}\n\n${buildCompletionProtocol(rec.id, input.project)}`, preLaunchScreen, {
      // #235: confirm-on-delivery — sendFirstTurnWhenReady polls until "Ask
      // anything…" leaves the screen, re-sending every ~3s to cover slow boots
      // without duplicating the task. See crew-pane.ts SPLASH_MAX_CHECKS/EVERY_N.
      splashMarker: "Ask anything…",
    } satisfies TurnAcceptanceConfig);
    return { ...pane, title };
  }

  // Generic / fallback branch — agents that don't yet have a first-class branch.
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
  const pane = await deps.runtime.newPane({ workspaceId: captain.id, direction, title });
  await deps.runtime.sendToPane(pane, cliCommand);
  if (interactive) {
    const preLaunchScreen = (await deps.runtime.readPaneScreen(pane)) ?? "";
    await deps.sendFirstTurn(pane, input.task, preLaunchScreen);
  }
  return { ...pane, title };
}

// ─── crew session operations ──────────────────────────────────────────────────

export async function runCrewSend(
  project: string,
  name: string,
  message: string,
  runtime: RuntimeDriver,
  workspaceId: string,
  deps: {
    listTasks(project: string): Promise<TaskRecord[]>;
    emitEvent(project: string, event: ControlEvent): Promise<void>;
    // Optional confirmed-submit override (#448). When provided, used instead of
    // runtime.sendToPane so the caller can inject paste-settle-Enter hardening.
    // Falls back to runtime.sendToPane when absent (preserves existing behaviour
    // for callers that don't inject it, e.g. unit tests).
    sendToPane?: (pane: PaneRef, message: string) => Promise<void>;
  },
): Promise<void> {
  const crew = await findCrewPane(runtime, workspaceId, project, name);
  if (!crew) {
    throw new Error(`Crew '${name}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  }
  // Best-effort attention-state handling before delivering the captain's answer.
  // Terminal task (done/failed): reopen so the next signal done fires CREW DONE (#148).
  // Blocked task: emit task.started to clear blocked→working so a subsequent real
  // permission prompt re-fires CREW BLOCKED (#182).
  try {
    const tasks = await deps.listTasks(project);
    const task = tasks.find((t) => t.name === name);
    if (task) {
      if (TERMINAL_STATES.has(task.state)) {
        await deps.emitEvent(project, { type: "task.reopened", id: task.id });
      } else if (task.state === "blocked" || task.state === "awaiting-input") {
        await deps.emitEvent(project, { type: "task.started", id: task.id });
      }
    }
  } catch {
    // Swallow daemon errors so crews without a daemon or offline daemon
    // still receive the sent message.
  }
  const deliver = deps.sendToPane ?? ((pane, msg) => runtime.sendToPane(pane, msg));
  await deliver(crew, message);
}

export async function runCrewRead(
  project: string,
  name: string,
  runtime: RuntimeDriver,
  workspaceId: string,
): Promise<string> {
  const crew = await findCrewPane(runtime, workspaceId, project, name);
  if (!crew) {
    throw new Error(`Crew '${name}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  }
  return runtime.readPaneScreen(crew);
}

export async function runCrewClose(
  project: string,
  name: string,
  runtime: RuntimeDriver,
  workspaceId: string,
  deps: {
    listTasks(project: string): Promise<TaskRecord[]>;
    emitEvent(project: string, event: ControlEvent): Promise<void>;
    closeCodexThread(taskId: string): Promise<void>;
  },
): Promise<void> {
  // resolveCaptainWorkspace already validated the project exists; reload for its
  // root path so we can tell a worktree crew (cwd != root) from a root crew.
  const projRoot = loadConfig().projects[project]?.path;
  // Terminalize the daemon task FIRST — before (and independent of) finding the
  // cmux pane (#184, hardened for #139). Without this, non-terminal tasks
  // (blocked/working/awaiting-input) linger in the daemon ledger and keep firing
  // phantom CREW BLOCKED/IDLE/STALLED pushes. A DEAD crew's pane is already gone,
  // so gating terminalization on findCrew (the old order) left zombie records
  // dangling forever. 'cancelled' is terminal but NOT in ATTENTION_STATES, so
  // firePush stays silent — captain initiated the close.
  let taskId: string | undefined;
  // Worktree to clean up after the pane closes — set only when this crew ran in
  // its own worktree (cwd recorded by the daemon differs from the root checkout).
  let worktreeCwd: string | undefined;
  try {
    const tasks = await deps.listTasks(project);
    const task = tasks.find((t) => t.name === name);
    if (task) {
      taskId = task.id;
      if (task.cwd && projRoot && task.cwd !== projRoot) {
        worktreeCwd = task.cwd;
      }
      if (!TERMINAL_STATES.has(task.state)) {
        await deps.emitEvent(project, { type: "task.cancelled", id: task.id, reason: "closed by captain" });
      }
      // Codex teardown: the pane only hosts the `crew attach` renderer; the thread
      // (and its per-thread MCP servers) live on the shared app-server, so closing
      // the pane alone leaks them. Tell the daemon to archive the thread.
      if (task.provider === "codex") {
        await deps.closeCodexThread(task.id);
      }
    }
  } catch {
    // Swallow daemon errors — a crew without a daemon must still close.
  }
  // Close the cmux pane if it still exists. A dead crew's pane is already gone —
  // that is not an error (the record is terminalized above); proceed to reap
  // children / clean the worktree. Only a genuine miss (no pane AND no daemon
  // task) is a typo → surface the not-found error.
  const crew = await findCrewPane(runtime, workspaceId, project, name);
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

export async function runCrewList(
  project: string,
  runtime: RuntimeDriver,
  workspaceId: string,
): Promise<Array<{ name: string; surfaceId: string }>> {
  const crews = await listCrewPanes(runtime, workspaceId, project);
  return crews.map((c) => ({
    name: nameFromTitle(project, c.title!),
    surfaceId: c.surfaceId,
  }));
}
