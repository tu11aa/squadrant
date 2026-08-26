import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveTextInput, resolveControlChannelMode } from "@squadrant/shared";
import type { PanePlacement } from "@squadrant/shared";
import { createCmuxDriver, RuntimeRegistry, resolveCaptainWorkspace, sendFirstTurnWhenReady, confirmedSendToPane, paneHasOpenModal, readModalOptions, getFreePort } from "@squadrant/workspaces";
import { CapabilityRegistry, createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver, OpencodeHttpChannel, ClaudePeerChannel, ClaudeReceiptListener, readClaudeStatus, writeLine } from "@squadrant/agents";
import { createServer, connect as netConnect } from "node:net";
import { randomUUID } from "node:crypto";
import {
  runCrewSpawn as coreRunCrewSpawn,
  runCrewSend as coreRunCrewSend,
  runCrewRead as coreRunCrewRead,
  runCrewClose as coreRunCrewClose,
  runCrewList as coreRunCrewList,
  runCrewAnswer as coreRunCrewAnswer,
  type CrewSpawnInput,
  type ResolvedAgent,
  type CrewAnswerResult,
} from "@squadrant/core";
import type { TaskRecord } from "@squadrant/shared";
import { buildDispatchRequest, squadrantdCall, sendCodexFirstTurn, resolveApproveTarget } from "./crew-control.js";
import { tailLines } from "./crew-output.js";
import { writePerCrewSettingsLocal, writePerCrewOpencodeConfig, readGlobalOpencodeModel } from "../lib/per-crew-settings.js";
import { isBlockedFallback, anthropicFallbackMessage } from "../lib/model-guard.js";

export type { CrewSpawnInput };

// ─── thin wrappers ────────────────────────────────────────────────────────────
// Each function constructs CLI-edge deps (concrete drivers, daemon closures,
// settings writers) and delegates the orchestration algorithm to @squadrant/core.

export async function runCrewSpawn(input: CrewSpawnInput): Promise<{ title?: string; surfaceId: string; workspaceId: string }> {
  const config = loadConfig();
  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(input.project, config);
  const agents = new CapabilityRegistry({
    claude: createClaudeDriver(),
    codex: createCodexDriver(),
    gemini: createGeminiDriver(),
    opencode: createOpencodeDriver(),
  });
  return coreRunCrewSpawn(input, config, {
    runtime,
    // AgentDriver satisfies ResolvedAgent structurally; `role: any` in ResolvedAgent
    // bridges the Role vs string gap — only "crew" is ever passed at call sites.
    resolveAgent: (name) => (agents.get(name) as unknown as ResolvedAgent) ?? null,
    dispatchCrew: async (o) => {
      const req = buildDispatchRequest(o);
      return (await squadrantdCall(req)) as TaskRecord;
    },
    writeSettingsLocal: (cwd) => writePerCrewSettingsLocal({ projectCwd: cwd }),
    writeOpencodeConfig: writePerCrewOpencodeConfig,
    sendFirstTurn: (pane, firstTurn, preLaunchScreen, opts) =>
      sendFirstTurnWhenReady(runtime, pane, firstTurn, preLaunchScreen, opts),
    getFreePort,
    sendCodexFirstTurn,
    // #466: wire delivery confirmation so the daemon stamps firstTurnConfirmedAt.
    emitEvent: async (p, event) => { await squadrantdCall({ kind: "event", project: p, event }); },
    onRouted: (route) =>
      console.log(
        chalk.dim(
          `routed: tier=${route.tier} → ${route.agent}${route.model ? `/${route.model}` : ""} (rule: "${route.matchedRule}")`,
        ),
      ),
    onBaseResolved: (base) => console.log(chalk.dim(`base: ${base}`)),
    // #627 item B: warn (don't block) when a fallback crew silently resolves to
    // an Anthropic model — less catastrophic than a captain on the same path,
    // and more often intentional, so it just needs to be visible.
    onModelResolved: ({ agentName, model }) => {
      const effectiveModel = model ?? (agentName === "opencode" ? readGlobalOpencodeModel() : undefined);
      if (isBlockedFallback(agentName, effectiveModel)) {
        console.error(
          chalk.yellow(
            `  ⚠ ${anthropicFallbackMessage(agentName, effectiveModel!)} (crew — not blocked; pass --model to pin a different provider)`,
          ),
        );
      }
    },
  });
}

export async function runCrewSend(project: string, name: string, message: string, opts?: { force?: boolean }): Promise<{ reopened: boolean }> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const cfg = loadConfig();
  // #667 slice 2: the channel needs the crew's opencode port, which the daemon
  // already persists on the TaskRecord (rec.serverPort). Resolved lazily so the
  // off path does no work at all.
  let tasks: TaskRecord[] = [];

  const receipts = new ClaudeReceiptListener({
    socketPath: "/tmp/cc-socks/squadrantd.sock",
    createServer: (h) => createServer(h),
    log: (m) => console.error(chalk.dim(m)),
  });
  await receipts.start();

  const controlChannels = [
    new OpencodeHttpChannel({
      portFor: (taskId) => tasks.find((t) => t.id === taskId)?.serverPort,
      log: (m) => console.error(chalk.dim(m)),
    }),
    new ClaudePeerChannel({
      socketPathFor: (taskId) => tasks.find((t) => t.id === taskId)?.messagingSocketPath,
      sessionIdFor: (taskId) => tasks.find((t) => t.id === taskId)?.sessionId,
      statusFor: (taskId) => readClaudeStatus(tasks.find((t) => t.id === taskId)),
      wire: (p, e) => writeLine(p, e, { connect: (path) => netConnect(path) }),
      receipts,
      newMsgId: () => randomUUID(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (m) => console.error(chalk.dim(m)),
    }),
  ];

  try {
    return await coreRunCrewSend(project, name, message, runtime, workspaceId, {
      listTasks: async (p) => {
        tasks = (await squadrantdCall({ kind: "list", project: p })) as TaskRecord[];
        return tasks;
      },
      emitEvent: async (p, event) => { await squadrantdCall({ kind: "event", project: p, event }); },
      sendToPane: (pane, msg) => confirmedSendToPane(runtime, pane, msg),
      isBlockedByModal: (pane) => paneHasOpenModal(runtime, pane),
      controlChannels,
      controlChannelMode: (agent) => resolveControlChannelMode(cfg.defaults.controlChannel, agent),
      onChannelLog: (m) => console.error(chalk.dim(m)),
    }, opts);
  } finally {
    receipts.stop();
  }
}

export async function runCrewRead(project: string, name: string): Promise<string> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  return coreRunCrewRead(project, name, runtime, workspaceId);
}

export async function runCrewClose(project: string, name: string, opts?: { force?: boolean }): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  return coreRunCrewClose(project, name, runtime, workspaceId, {
    listTasks: async (p) => (await squadrantdCall({ kind: "list", project: p })) as TaskRecord[],
    emitEvent: async (p, event) => { await squadrantdCall({ kind: "event", project: p, event }); },
    closeCodexThread: async (taskId) => { await squadrantdCall({ kind: "codex-close", taskId }); },
  }, opts);
}

export async function runCrewList(project: string): Promise<Array<{ name: string; surfaceId: string }>> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  return coreRunCrewList(project, runtime, workspaceId);
}

export async function runCrewAnswer(
  project: string,
  name: string,
  option: string,
  opts?: { expect?: string; text?: string },
): Promise<CrewAnswerResult> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  return coreRunCrewAnswer(
    project,
    name,
    option,
    runtime,
    workspaceId,
    {
      readModalOptions: (pane) => readModalOptions(runtime, pane),
      log: (m) => console.log(chalk.dim(m)),
    },
    opts,
  );
}

// ─── CLI command definitions ──────────────────────────────────────────────────

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
          // #458: pass the raw file path (not stdin) so runCrewSpawn can copy it
          // into the isolated worktree root for relative-path access.
          ...(opts.taskFile && opts.taskFile !== "-" ? { taskFile: opts.taskFile } : {}),
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
      
      const tasks = await squadrantdCall({ kind: "list", project }).catch(() => []) as TaskRecord[];
      const active: any[] = [];
      const held: any[] = [];

      for (const c of crews) {
        const task = tasks.find(t => t.name === c.name); // pickMostRecent?
        const t = task ? resolveApproveTarget(tasks, c.name) : undefined;
        if (t?.operatorHold) {
          held.push({ c, t });
        } else {
          active.push({ c, t });
        }
      }

      if (active.length > 0) {
        console.log(`active (${active.length}):`);
        for (const { c, t } of active) {
          console.log(`  ${c.name.padEnd(10)} ${t ? t.state : "unknown"}  (${c.surfaceId})`);
        }
      }
      if (held.length > 0) {
        console.log(`HELD BY OPERATOR (${held.length}) — not counted toward maxCrew:`);
        for (const { c, t } of held) {
          const m = Math.round((Date.now() - t.operatorHold.since) / 60000);
          const hm = m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
          const note = t.operatorHold.note ? ` · "${t.operatorHold.note}"` : "";
          console.log(`  ${c.name.padEnd(10)} ${t.state} · held ${hm}${note}  (${c.surfaceId})`);
        }
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
  .option("--force", "override an operator takeover (only when the operator told you to)", false)
  .action(async (project: string, name: string, message: string | undefined, opts: { messageFile?: string; force?: boolean }) => {
    try {
      const resolvedMessage = await resolveTextInput({ positional: message, filePath: opts.messageFile, label: "message" });
      const { reopened } = await runCrewSend(project, name, resolvedMessage, opts);
      // #595: make the reopen outcome visible instead of a bare "✔ Sent" that
      // gave the captain no way to tell a stale terminal record was revived.
      if (reopened) console.log(chalk.cyan(`↻ Task was terminal — reopened to working`));
      console.log(chalk.green(`✔ Sent to ${project}:${name}`));
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exit(1);
    }
  });

crewCommand
  .command("answer")
  .description(
    "Deliberately answer a crew's open AskUserQuestion/permission prompt (#592) — never an implicit default",
  )
  .argument("<project>", "Project name")
  .argument("<name>", "Crew name")
  .argument("<option>", "1-based option index, or an exact/prefix match of the option's text")
  .option("--expect <text>", "Refuse unless the resolved option's label contains this text (guards against option order shifting)")
  .option("--text <answer>", "For a free-text option (e.g. 'Type something.'): select it, then type this answer and submit")
  .action(async (project: string, name: string, option: string, opts: { expect?: string; text?: string }) => {
    try {
      const { selected, closed } = await runCrewAnswer(project, name, option, opts);
      if (closed) {
        console.log(chalk.green(`✔ Answered ${project}:${name} with ${selected.index}. "${selected.label}" — prompt closed`));
      } else {
        console.log(chalk.yellow(`⚠ Sent ${selected.index}. "${selected.label}" to ${project}:${name}, but the prompt still appears open — read it again with 'squadrant crew read ${project} ${name}'`));
      }
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
  .option("--force", "override an operator takeover (only when the operator told you to)", false)
  .action(async (project: string, name: string, opts: { force?: boolean }) => {
    try {
      await runCrewClose(project, name, opts);
      console.log(chalk.green(`✔ Closed ${project}:${name}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
