import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveTextInput } from "@squadrant/shared";
import type { PanePlacement } from "@squadrant/shared";
import { createCmuxDriver, RuntimeRegistry, resolveCaptainWorkspace, sendFirstTurnWhenReady, confirmedSendToPane, getFreePort } from "@squadrant/workspaces";
import { CapabilityRegistry, createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver } from "@squadrant/agents";
import {
  runCrewSpawn as coreRunCrewSpawn,
  runCrewSend as coreRunCrewSend,
  runCrewRead as coreRunCrewRead,
  runCrewClose as coreRunCrewClose,
  runCrewList as coreRunCrewList,
  type CrewSpawnInput,
  type ResolvedAgent,
} from "@squadrant/core";
import type { TaskRecord } from "@squadrant/shared";
import { buildDispatchRequest, squadrantdCall, sendCodexFirstTurn } from "./crew-control.js";
import { tailLines } from "./crew-output.js";
import { writePerCrewSettingsLocal, writePerCrewOpencodeConfig } from "../lib/per-crew-settings.js";

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
    onRouted: (route) =>
      console.log(
        chalk.dim(
          `routed: tier=${route.tier} → ${route.agent}${route.model ? `/${route.model}` : ""} (rule: "${route.matchedRule}")`,
        ),
      ),
  });
}

export async function runCrewSend(project: string, name: string, message: string): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  return coreRunCrewSend(project, name, message, runtime, workspaceId, {
    listTasks: async (p) => (await squadrantdCall({ kind: "list", project: p })) as TaskRecord[],
    emitEvent: async (p, event) => { await squadrantdCall({ kind: "event", project: p, event }); },
    // #448: use paste-settle-Enter confirmation for follow-up sends (same guard
    // as first-turn #447) so large messages don't strand in paste mode.
    sendToPane: (pane, msg) => confirmedSendToPane(runtime, pane, msg),
  });
}

export async function runCrewRead(project: string, name: string): Promise<string> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  return coreRunCrewRead(project, name, runtime, workspaceId);
}

export async function runCrewClose(project: string, name: string): Promise<void> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  return coreRunCrewClose(project, name, runtime, workspaceId, {
    listTasks: async (p) => (await squadrantdCall({ kind: "list", project: p })) as TaskRecord[],
    emitEvent: async (p, event) => { await squadrantdCall({ kind: "event", project: p, event }); },
    closeCodexThread: async (taskId) => { await squadrantdCall({ kind: "codex-close", taskId }); },
  });
}

export async function runCrewList(project: string): Promise<Array<{ name: string; surfaceId: string }>> {
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  return coreRunCrewList(project, runtime, workspaceId);
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
