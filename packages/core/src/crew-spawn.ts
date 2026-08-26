// Crew spawn and session orchestration — driver-agnostic algorithm (#367 command-thinning).
// CLI-edge concerns (concrete driver construction, daemon calls, settings writers,
// agent commands) are injected as closures; core only imports from @squadrant/shared
// and core-internal modules. The algorithm is IDENTICAL to the prior crew.ts
// implementation — zero behavior change.

import { fallsBackToPane, describeOutcome } from "./control-channel.js";
import type { ControlChannel, ControlChannelMode } from "./control-channel.js";

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
  worktreeDirtyFiles,
  TERMINAL_STATES,
  crewSessionName,
} from "@squadrant/shared";
import { randomUUID } from "node:crypto";
import { resolveCrewRoute, type CrewRouteResult } from "./crew-routing.js";

/**
 * Where claude sessions' UDS inboxes live. Squadrant's own receipt listener MUST
 * bind inside this same directory — the receiver refuses to send a receipt to a
 * `from` address outside its own socket namespace (verified 2026-08-08).
 *
 * That makes this directory a trust boundary. Hardening its permissions is #675,
 * which is live today and NOT addressed by this slice.
 */
export const CC_SOCKS_DIR = "/tmp/cc-socks";

import {
  buildCompletionProtocol,
  shellQuote,
  niceCrewCommand,
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
    messagingSocketPath?: string;
    sessionName?: string;
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
  /** Path to the task file when --task-file was used (not '-' for stdin). Set by
   *  the CLI so runCrewSpawn can copy the file into the isolated worktree root,
   *  enabling the crew to `Read ./<basename>` without hunting the main checkout (#458).
   *  Ignored for --shared spawns and when absent. */
  taskFile?: string;
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
    messagingSocketPath?: string;
    approvalPolicy?: string;
    roleInstructions?: string;
  }): Promise<TaskRecord>;
  /** CLI-edge: write squadrant hooks to <cwd>/.claude/settings.local.json (#134). */
  writeSettingsLocal(projectCwd: string): void;
  /** CLI-edge: write opencode permission config for an interactive crew. */
  writeOpencodeConfig(opts: { stateRoot: string; project: string; taskId: string; gateBash?: boolean }): string;
  /** CLI-edge: deliver the first turn once the agent pane is ready. Returns
   *  { delivered: true } when positively confirmed, { delivered: false } when
   *  all retry paths exhausted without confirmation (#466). */
  sendFirstTurn(pane: PaneRef, firstTurn: string, preLaunchScreen: string, opts?: TurnAcceptanceConfig): Promise<{ delivered: boolean }>;
  /** CLI-edge: reserve an ephemeral TCP port for opencode's embedded HTTP server. */
  getFreePort(): Promise<number>;
  /** CLI-edge: deliver the task to a freshly-dispatched codex thread. */
  sendCodexFirstTurn(taskId: string, task: string): Promise<void>;
  /** Optional: called after routing to log the selected route (e.g. chalk.dim(...)). */
  onRouted?(route: CrewRouteResult): void;
  /** #627 item B: called once agent/model resolution is final for a non-claude
   *  spawn, before the agent CLI command is built. Lets the CLI edge warn when
   *  a fallback agent silently resolves to an Anthropic model — `model` is
   *  undefined when nothing resolved one (e.g. opencode falling through to its
   *  own global config default), not just when an explicit flag was anthropic. */
  onModelResolved?(o: { agentName: string; model: string | undefined }): void;
  /** #466: optional — when provided, called with task.first-turn.confirmed after
   *  positively confirmed delivery so the daemon can stamp firstTurnConfirmedAt. */
  emitEvent?(project: string, event: ControlEvent): Promise<void>;
  /** Optional: called when worktree base is resolved. */
  onBaseResolved?(base: string): void;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function listCrewPanes(runtime: RuntimeDriver, workspaceId: string, project: string): Promise<PaneRef[]> {
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces.filter((s) => s.title && isCrewTitle(project, s.title));
}

export async function findCrewPane(
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
  /** Override for first-turn delivery to the model. When set (e.g. "Read ./file.md
   *  to get your task brief"), used instead of `task` for sendCodexFirstTurn so large
   *  file contents aren't sent verbatim. The daemon dispatch always uses `task`. */
  firstTurn?: string;
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
  const firstTurnText = o.firstTurn ?? o.task;
  if (firstTurnText && firstTurnText !== "(interactive)") {
    void o.sendCodexFirstTurn(rec.id, firstTurnText).catch((e: unknown) => {
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
  let base = "";
  if (!input.shared) {
    base = resolveWorktreeBase(proj.path);
    deps.onBaseResolved?.(base);
  }

  const spawnCwd = !input.shared
    ? addWorktree({
        repoRoot: proj.path,
        worktreeDir: config.defaults.worktreeDir ?? ".worktrees",
        project: input.project,
        name,
        base,
      })
    : proj.path;

  // #458: For isolated-worktree spawns with a task file, copy the file into the
  // worktree root so the crew can find it via `Read ./<basename>` without having
  // to discover the main checkout path. Use a short first-turn message referencing
  // the local path to avoid large-paste issues on big task files.
  // Guards: skip for --shared (file is in the main checkout, already reachable),
  // skip for stdin ('-') since there is no file to copy.
  let firstTurnTask = input.task;
  if (input.taskFile && input.taskFile !== "-" && !input.shared) {
    const absTaskFile = path.resolve(input.taskFile);
    const basename = path.basename(absTaskFile);
    fs.copyFileSync(absTaskFile, path.join(spawnCwd, basename));
    firstTurnTask = `Read ./${basename} to get your task brief, then execute it.`;
  }

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
      firstTurn: firstTurnTask !== input.task ? firstTurnTask : undefined,
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

  if (agentName !== "claude") {
    deps.onModelResolved?.({ agentName, model: crewModel });
  }

  // Claude crews route through the control-plane daemon (PR #85) so the captain
  // learns terminal state via `squadrant crew status`. The cmux tab still does
  // the actual CLI launch — the daemon doesn't own Claude's PID. Hook bridge
  // (per-crew settings.json → Stop/SubagentStop/SessionEnd → squadrant crew _hook)
  // keeps the daemon's heartbeat fresh; `squadrant crew signal done` emits
  // terminal state.
  if (agentName === "claude") {
    fs.mkdirSync(CC_SOCKS_DIR, { recursive: true });
    // Same directory as the crews' own sockets — receipts are only delivered
    // within one socket namespace, so our listener must live there too.
    const messagingSocketPath = path.join(CC_SOCKS_DIR, `squadrant-${randomUUID()}.sock`);

    const rec = await deps.dispatchCrew({
      provider: "claude",
      mode: "interactive",
      project: input.project,
      cwd: spawnCwd,
      task: input.task,
      name,
      messagingSocketPath,
    });
    // Write squadrant hooks to <cwd>/.claude/settings.local.json so they are
    // auto-loaded as a project-local settings source. Merges with any existing
    // hooks — does not clobber the user's own personal hooks (#134).
    // #472: capture whether hook installation succeeded — when it does, the
    // UserPromptSubmit hook is the SOLE first-turn confirmation source for
    // claude crews. If the write fails (rare OS error), fall back to scrape.
    let hooksInstalled = false;
    try {
      deps.writeSettingsLocal(spawnCwd);
      hooksInstalled = true;
    } catch {
      // Hook file write failed — scrape confirmation remains as fallback.
    }
    const cliCommand = agent.buildCommand({
      prompt: input.task,
      workdir: spawnCwd,
      role: "crew",
      promptFile,
      interactive: true,
      messagingSocketPath,
      // Permission mode is config-driven so squadrant can default crews to 'auto'
      // or keep the semi-automatic 'acceptEdits' gate. Falls back to 'acceptEdits'.
      permissionMode: config.defaults.permissions?.crew ?? "acceptEdits",
      // #708: self-describing name so ListAgents/the registry can tell this
      // crew apart from an unrelated session instead of an auto-derived cwd
      // basename (only the claude driver reads this — other agents ignore it).
      sessionName: crewSessionName(input.project, name),
      ...(crewModel ? { model: crewModel } : {}),
    });
    const direction: PanePlacement = input.direction ?? "tab";
    const title = titleFor(input.project, name);
    const pane = await deps.runtime.newPane({ workspaceId: captain.id, direction, title });
    // Prefix the CLI command with env so the hook bridge + signal verb running
    // inside the crew's cmux tab can identify their task.
    const envPrefix = `SQUADRANT_CREW_TASK_ID=${rec.id} SQUADRANT_CREW_PROJECT=${input.project}`;
    await deps.runtime.sendToPane(pane, `cd ${shellQuote(spawnCwd)} && ${envPrefix} ${niceCrewCommand(cliCommand)}`);
    const preLaunchScreen = (await deps.runtime.readPaneScreen(pane)) ?? "";
    const claudeResult = await deps.sendFirstTurn(pane, `${firstTurnTask}\n\n${buildCompletionProtocol(rec.id, input.project)}`, preLaunchScreen);
    // #466: surface non-delivery explicitly instead of silently returning success.
    if (!claudeResult.delivered) {
      process.stderr.write(`⚠️  First turn not delivered for crew '${name}' — use 'squadrant crew send ${input.project} ${name}' to re-send the task.\n`);
    } else if (!hooksInstalled) {
      // #472: hooks unavailable — scrape is the only confirmation source for this crew.
      await deps.emitEvent?.(input.project, { type: "task.first-turn.confirmed", id: rec.id });
    }
    // When hooksInstalled=true: UserPromptSubmit hook stamps firstTurnConfirmedAt.
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
    await deps.runtime.sendToPane(pane, `cd ${shellQuote(spawnCwd)} && ${envPrefix} OPENCODE_CONFIG=${opencodeConfigPath} ${niceCrewCommand(cliCommand)}`);
    const preLaunchScreen = (await deps.runtime.readPaneScreen(pane)) ?? "";
    const opencodeResult = await deps.sendFirstTurn(pane, `${firstTurnTask}\n\n${buildCompletionProtocol(rec.id, input.project)}`, preLaunchScreen, {
      // #235: confirm-on-delivery — sendFirstTurnWhenReady polls until the idle
      // splash leaves the screen, re-sending every ~3s to cover slow boots
      // without duplicating the task. See crew-pane.ts SPLASH_MAX_CHECKS/EVERY_N.
      // #499: match a stable substring ("ask anything", case/whitespace/ellipsis
      // -insensitive via screenHasSplashMarker) rather than the exact wording —
      // opencode's real placeholder rotates through example prompts and uses
      // three ASCII dots ("Ask anything...") or a longer command hint ("Ask
      // anything, / for commands, @ for context..."), never the literal
      // "Ask anything…" (U+2026) this used to hardcode, which never matched.
      splashMarker: "Ask anything",
    } satisfies TurnAcceptanceConfig);
    // #466: surface non-delivery; emit confirmed event on success.
    if (!opencodeResult.delivered) {
      process.stderr.write(`⚠️  First turn not delivered for crew '${name}' — use 'squadrant crew send ${input.project} ${name}' to re-send the task.\n`);
    } else {
      await deps.emitEvent?.(input.project, { type: "task.first-turn.confirmed", id: rec.id });
    }
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
  await deps.runtime.sendToPane(pane, niceCrewCommand(cliCommand));
  if (interactive) {
    const preLaunchScreen = (await deps.runtime.readPaneScreen(pane)) ?? "";
    const genericResult = await deps.sendFirstTurn(pane, firstTurnTask, preLaunchScreen);
    // Generic branch has no daemon task record — only warn on non-delivery.
    if (!genericResult.delivered) {
      process.stderr.write(`⚠️  First turn not delivered for crew '${name}' — use 'squadrant crew send ${input.project} ${name}' to re-send the task.\n`);
    }
  }
  return { ...pane, title };
}

// ─── crew session operations ──────────────────────────────────────────────────

// #574: the single record-selection rule for "which task record is THE record
// for this crew name" when duplicates exist (e.g. an orphaned record left by a
// close/respawn race, #513). Every call site that resolves a crew name to a
// task record MUST go through this helper — runCrewSend and runCrewClose used
// to each inline their own pick (first-match vs most-recent), and disagreed on
// live vs. stale duplicates, causing the two sides of a crew's lifecycle to
// silently track different ids.
function pickMostRecentTask(tasks: TaskRecord[]): TaskRecord {
  return tasks.reduce((a, b) => ((b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a));
}

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
    sendToPane?: (pane: PaneRef, message: string) => Promise<{ delivered: boolean; blockedByModal?: boolean }>;
    // #516: optional side-effect-free precheck for an open AskUserQuestion/
    // permission modal. Checked BEFORE the daemon-state emit block below so a
    // modal-blocked send is a true no-op on daemon state, not just on the pane.
    // Deliberately separate from sendToPane: that closure only reports
    // blockedByModal AFTER attempting delivery, which is too late here — the
    // emit block must never run for a message that never reached the crew.
    isBlockedByModal?: (pane: PaneRef) => Promise<boolean>;
    /**
     * #667: one channel per agent with a native control API. Selected by the
     * crew's own provider — slice 2 shipped a single channel because opencode was
     * the only implementation; slice 3 adds claude, so selection is explicit.
     */
    controlChannels?: ControlChannel[];
    /** Per-agent rollout position. Absent ⇒ always "off". */
    controlChannelMode?: (agent: string) => ControlChannelMode;
    /** Where channel decisions and disagreements are recorded. */
    onChannelLog?: (msg: string) => void;
  },
  opts?: { force?: boolean }
): Promise<{ reopened: boolean }> {
  const crew = await findCrewPane(runtime, workspaceId, project, name);
  if (!crew) {
    throw new Error(`Crew '${name}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  }
  // #592: the old "wait for the prompt to close" advice was unactionable — it
  // only closes when answered, and answering is exactly what this refusal
  // blocks. Point at the deliberate escape hatch instead.
  const blockedByModalMessage = () =>
    `Crew '${name}' has an interactive prompt open (AskUserQuestion/permission) — message NOT delivered, to avoid confirming its default option. To answer it deliberately: squadrant crew read ${project} ${name} to see the options, then squadrant crew answer ${project} ${name} <n>.`;
  if (deps.isBlockedByModal && (await deps.isBlockedByModal(crew))) {
    throw new Error(blockedByModalMessage());
  }

  let task: TaskRecord | undefined;
  try {
    const matches = (await deps.listTasks(project)).filter((t) => t.name === name);
    task = matches.length > 0 ? pickMostRecentTask(matches) : undefined;
  } catch {
    // Swallow daemon errors so crews without a daemon or offline daemon
    // still receive the sent message.
  }

  if (task && task.operatorHold && !opts?.force) {
    const heldForMin = Math.round((Date.now() - task.operatorHold.since) / 60000);
    throw new Error(
      `Crew '${name}' is under operator takeover (held ${heldForMin}m` +
        `${task.operatorHold.note ? `: ${task.operatorHold.note}` : ""}). ` +
        `The operator is working in that tab — sending a message disrupts their conversation. ` +
        `Ask them to run 'squadrant crew handback ${project} ${name}', or pass --force if they told you to.`,
    );
  }

  // Best-effort attention-state handling before delivering the captain's answer.
  // Terminal task (done/failed): reopen so the next signal done fires CREW DONE (#148).
  // Blocked task: emit task.started to clear blocked→working so a subsequent real
  // permission prompt re-fires CREW BLOCKED (#182).
  // #595: `reopened` is reported back to the caller (CLI output) so it can
  // truthfully confirm a reopen happened instead of a bare "✔ Sent" that gave
  // no signal either way — the guard message that tells a blocked crew to
  // "ask the captain to run crew send to reopen it" is only actually true if
  // that outcome is visible, not silently swallowed with everything else.
  let reopened = false;
  try {
    if (task) {
      if (TERMINAL_STATES.has(task.state)) {
        await deps.emitEvent(project, { type: "task.reopened", id: task.id });
        reopened = true;
      } else if (task.state === "blocked" || task.state === "awaiting-input" || task.state === "review") {
        // #599: feedback on a 'review' task is the reject path — clear it back
        // to working the same way an answer clears 'blocked'.
        await deps.emitEvent(project, { type: "task.started", id: task.id });
      }
    }
  } catch {
    // Swallow daemon errors so crews without a daemon or offline daemon
    // still receive the sent message. `reopened` stays false — a failed
    // reopen attempt must never be reported as a success (#595).
  }
  const deliver: (pane: PaneRef, msg: string) => Promise<{ delivered: boolean; blockedByModal?: boolean }> =
    deps.sendToPane ?? ((pane, msg) => runtime.sendToPane(pane, msg).then(() => ({ delivered: true })));

  // ── #667 slice 2: control channel ────────────────────────────────────────
  // Three positions, resolved per send from the crew's own provider:
  //   off     the block below is not entered at all
  //   shadow  the pane still sends and still decides; the channel runs a
  //           NON-MUTATING probe and any disagreement is logged. Deliberately
  //           NOT a real channel send — that would deliver the message twice.
  //   on      the channel leads; the pane becomes the fallback
  const agent = task?.provider;
  const channel = agent ? deps.controlChannels?.find((c) => c.agent === agent) : undefined;
  // No channel for this provider (codex, gemini, …) ⇒ off, regardless of config.
  // The flag cannot opt an agent in that has no implementation.
  const mode: ControlChannelMode =
    channel && agent && deps.controlChannelMode ? deps.controlChannelMode(agent) : "off";
  const channelLog = deps.onChannelLog ?? (() => {});

  if (mode === "on" && channel && task) {
    let outcome;
    try {
      outcome = await channel.send(task.id, message);
      channelLog(`crew send ${name}: ${describeOutcome(outcome)}`);
    } catch (e) {
      channelLog(`crew send ${name}: threw, falling back to pane — ${(e as Error).message}`);
      outcome = { status: "gone" as const };
    }
    if (outcome.status === "held") {
      // Never retried, never fallen back — the operator must act. Retrying a
      // held message is how duplicates are manufactured.
      throw new Error(
        `Message to crew '${name}' is held: ${outcome.reason}. ` +
          `Resolve it in the crew's session, then re-send.`,
      );
    }
    if (!fallsBackToPane(outcome)) {
      // accepted / queued: it reached the agent. Done — do NOT also use the pane.
      return { reopened };
    }
    // gone / unsupported: fall back to the pane ONCE, already logged above.
  }

  if (mode === "shadow" && channel && task) {
    // Probe FIRST so the comparison reflects the session's state at send time,
    // and so a slow probe cannot delay a message that already went out.
    let probe;
    try {
      probe = await channel.probe(task.id);
    } catch (e) {
      channelLog(`crew send ${name}: threw, falling back to pane — ${(e as Error).message}`);
      probe = { status: "gone" as const };
    }
    const { delivered: paneOk, blockedByModal: paneModal } = await deliver(crew, message);
    const channelWouldSay = probe.status === "reachable" ? "deliverable" : probe.status;
    if (paneOk !== (probe.status === "reachable")) {
      // The measurement this mode exists for: countable evidence for #514/#657.
      channelLog(
        `crew send ${name}: DISAGREEMENT — pane=${paneOk ? "delivered" : "not delivered"}, ` +
          `channel=${channelWouldSay}`,
      );
    } else {
      channelLog(`crew send ${name}: agree (pane=${paneOk}, channel=${channelWouldSay})`);
    }
    if (paneModal) throw new Error(blockedByModalMessage());
    if (!paneOk) {
      throw new Error(`Message not delivered to crew '${name}' — the paste/submit could not be confirmed. Re-send with 'squadrant crew send ${project} ${name}'.`);
    }
    return { reopened };
  }

  const { delivered, blockedByModal } = await deliver(crew, message);
  // #516 backstop: covers the TOCTOU window between the precheck above and this
  // delivery attempt, and callers that don't inject isBlockedByModal at all.
  if (blockedByModal) {
    throw new Error(blockedByModalMessage());
  }
  if (!delivered) {
    // #566: a follow-up send has no self-heal sweep behind it — a stderr-only
    // warning let the CLI print "✔ Sent" and exit 0 for a message that was never
    // submitted. Throw so the caller fails loudly instead.
    throw new Error(`Message not delivered to crew '${name}' — the paste/submit could not be confirmed. Re-send with 'squadrant crew send ${project} ${name}'.`);
  }
  return { reopened };
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

// #513: close's listTasks() lookup can race a same-name crew's own dispatch —
// closing immediately after spawn may snapshot the daemon before the task
// record is registered. A few short retries close that window without adding
// meaningful latency to the common (already-registered) case.
const CLOSE_LOOKUP_RETRIES = 3;
const CLOSE_LOOKUP_RETRY_DELAY_MS = 150;

function buildRecoveryHint(sessId: string | undefined, provider: string | undefined, worktreeCwd: string | undefined): string {
  if (!sessId || !worktreeCwd) return "";
  // opencode keeps sessions in a sqlite db so there is no transcript file path to print.
  if (provider === "claude") {
    const escaped = worktreeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    const transcriptPath = path.join(os.homedir(), ".claude", "projects", escaped, `${sessId}.jsonl`);
    return `\ntranscript: ${transcriptPath}\nresume:     claude --resume ${sessId}   (run from the worktree path above)\n`;
  }
  return "";
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
    /** Injectable for tests; defaults to a real delay. */
    sleep?: (ms: number) => Promise<void>;
  },
  opts?: { force?: boolean }
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // resolveCaptainWorkspace already validated the project exists; reload for its
  // root path so we can tell a worktree crew (cwd != root) from a root crew.
  const projRoot = loadConfig().projects[project]?.path;

  let matches: TaskRecord[] = [];
  try {
    matches = (await deps.listTasks(project)).filter((t) => t.name === name);
    // #513: the record may not be registered yet (close raced spawn's own
    // dispatch). Retry briefly before concluding this crew has no daemon task.
    for (let attempt = 0; attempt < CLOSE_LOOKUP_RETRIES && matches.length === 0; attempt++) {
      await sleep(CLOSE_LOOKUP_RETRY_DELAY_MS);
      matches = (await deps.listTasks(project)).filter((t) => t.name === name);
    }
  } catch {
    // Swallow daemon errors — a crew without a daemon must still close.
  }

  let taskId: string | undefined;
  let worktreeCwd: string | undefined;
  let sessId: string | undefined;
  let provider: string | undefined;

  if (matches.length > 0) {
    // #513: a name can match more than one record (e.g. an orphaned record
    // left by a prior close that raced dispatch, followed by a same-name
    // respawn). Terminalize every non-terminal match so none linger to fire
    // a phantom CREW STALLED/IDLE later. Reap/worktree cleanup below anchors
    // on the most-recently-dispatched match — the one the live pane belongs to.
    const primary = pickMostRecentTask(matches);
    taskId = primary.id;
    sessId = primary.sessionId;
    provider = primary.provider;
    if (primary.cwd && projRoot && primary.cwd !== projRoot) {
      worktreeCwd = primary.cwd;
    }

    if (primary.operatorHold && !opts?.force) {
      const heldForMin = Math.round((Date.now() - primary.operatorHold.since) / 60000);
      throw new Error(
        `Crew '${name}' is under operator takeover (held ${heldForMin}m` +
          `${primary.operatorHold.note ? `: ${primary.operatorHold.note}` : ""}). ` +
          `The operator is working in that tab — closing it kills their session and prunes the worktree. ` +
          `Ask them to run 'squadrant crew handback ${project} ${name}', or pass --force if they told you to.`,
      );
    }
  }

  // Pre-check dirty worktree before ANY mutation (#649)
  if (worktreeCwd && projRoot) {
    const dirty = worktreeDirtyFiles(worktreeCwd);
    if (dirty.length > 0 && !opts?.force) {
      const transcriptStr = buildRecoveryHint(sessId, provider, worktreeCwd);
      throw new Error(
        `Worktree '${worktreeCwd}' has uncommitted files:\n${dirty.map(f => `  ${f}`).join("\n")}\n` +
        `Why are they uncommitted? Commit them, or pass --force to destroy them.\n${transcriptStr}`
      );
    }
  }

  // Terminalize the daemon task FIRST — before (and independent of) finding the
  // cmux pane (#184, hardened for #139). Without this, non-terminal tasks
  // (blocked/working/awaiting-input) linger in the daemon ledger and keep firing
  // phantom CREW BLOCKED/IDLE/STALLED pushes. A DEAD crew's pane is already gone,
  // so gating terminalization on findCrew (the old order) left zombie records
  // dangling forever. 'cancelled' is terminal but NOT in ATTENTION_STATES, so
  // firePush stays silent — captain initiated the close.
  if (matches.length > 0) {
    try {
      for (const task of matches) {
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
      removeWorktree(projRoot, worktreeCwd, opts);
    } catch (e) {
      process.stderr.write(`(worktree remove failed: ${(e as Error).message})\n`);
    }
  }

  const hint = buildRecoveryHint(sessId, provider, worktreeCwd);
  if (hint) {
    process.stdout.write(hint);
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
