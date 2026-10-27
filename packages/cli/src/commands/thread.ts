// `squadrant thread` (#1016) — captain discussion threads. CLI edge only:
// concrete drivers, captain-session lookup and agent commands; the algorithm
// lives in @squadrant/core (threads.ts).
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { loadConfig, stateRoot, workspacePath, resolveTextInput, threadSessionName } from "@squadrant/shared";
import type { SquadrantConfig } from "@squadrant/shared";
import {
  createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver,
  CapabilityRegistry, buildAgentCmd,
} from "@squadrant/agents";
import { resolveCaptainWorkspace, sendFirstTurnWhenReady } from "@squadrant/workspaces";
import {
  openThread, requestPark, parkThread, resumeThread, closeThread,
  listThreads, requireThread, parseDecisionRecord, formatDecisionMessage,
  DEFAULT_MAX_THREADS, threadTitleFor, threadsDir,
  type ThreadDeps, type ThreadLaunch, type ThreadRecord,
} from "@squadrant/core";
import { captainSession } from "../lib/captain-context.js";
import { resolveLaunchAgent } from "../lib/launch-agent-resolve.js";
import { resolveCaptainAgent } from "../lib/captain-channel-factory.js";
import { compactLedgerContext } from "./hooks.js";

const TEMPLATES_DIR = path.join(os.homedir(), ".config", "squadrant", "templates");

function registry(): CapabilityRegistry {
  return new CapabilityRegistry({
    claude: createClaudeDriver(),
    codex: createCodexDriver(),
    gemini: createGeminiDriver(),
    opencode: createOpencodeDriver(),
  });
}

/**
 * The thread's launch command. Claude builds the captain's own command (same
 * system prompt, plugins, model, effort) so a fork reuses the captain's
 * prompt-cache prefix, minus the captain's peer socket, and with its own
 * `-n` name so the thread never shows up as the captain.
 * The captain prompt file is passed as a byte-identical copy named
 * `thread.claude.md`: cmux liveness classifies a session's role from that
 * basename (store-fingerprint.ts), and `captain.*` would register the thread as
 * a second captain. The cache keys on content, not path (verified live).
 * Other agents get a plain interactive session (seed mode).
 */
export function threadAgentCommand(
  launch: ThreadLaunch,
  agentName: string,
  config: SquadrantConfig,
  cwd: string,
  promptDir: string,
  reg: CapabilityRegistry = registry(),
  templatesDir: string = TEMPLATES_DIR,
  sessionName?: string,
): string {
  const roleConfig = config.defaults.roles?.captain;
  const { model, thinking } = resolveLaunchAgent({}, roleConfig, config.defaults.models?.captain);
  const permissionMode = config.defaults.permissions?.captain || "auto";
  if (agentName === "claude") {
    let cmd = buildAgentCmd("claude", reg, "captain", true, permissionMode, model, templatesDir,
      undefined, sessionName, thinking);
    const promptFile = cmd.match(/--append-system-prompt-file (\S+)/)?.[1];
    if (promptFile) {
      const copy = path.join(promptDir, "thread.claude.md");
      fs.mkdirSync(promptDir, { recursive: true });
      fs.copyFileSync(promptFile, copy);
      cmd = cmd.replace(`--append-system-prompt-file ${promptFile}`, `--append-system-prompt-file ${copy}`);
    }
    const flags = launch.kind === "fork"
      ? ` --resume ${launch.fromSessionId} --fork-session --session-id ${launch.sessionId}`
      : launch.kind === "resume" ? ` --resume ${launch.sessionId}` : "";
    return `claude${flags}${cmd.slice("claude".length)}`;
  }
  if (agentName === "opencode") {
    return reg.get(agentName)!.buildCommand({
      prompt: "",
      workdir: cwd,
      role: "side",
      interactive: true,
      permissionMode,
      ...(model ? { model } : {}),
    });
  }
  // codex/gemini drivers only build headless one-shot commands; a thread is a
  // conversation, so run the plain interactive CLI and type the first turn in.
  return agentName;
}

async function threadDeps(project: string): Promise<ThreadDeps> {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  const { runtime, workspaceId } = await resolveCaptainWorkspace(project);
  const root = stateRoot();
  const agent = resolveCaptainAgent(root, project, config.defaults.roles?.captain?.agent) ?? "claude";
  const reg = registry();
  if (!reg.get(agent)) throw new Error(`Unknown captain agent '${agent}'.`);
  const session = agent === "claude" ? captainSession(project) : null;
  // Inside the captain itself, its own session id is ground truth (the registry can lag, #1023).
  const sessionId = agent === "claude"
    ? (process.env.SQUADRANT_ROLE === "captain" && process.env.CLAUDE_CODE_SESSION_ID) || session?.sessionId || null
    : null;
  const cwd = session?.cwd ?? proj.path;
  return {
    stateRoot: root,
    runtime,
    workspaceId,
    cwd,
    agent,
    captainSessionId: sessionId,
    maxThreads: config.defaults.maxThreads ?? DEFAULT_MAX_THREADS,
    agentCommand: (launch, id) =>
      threadAgentCommand(launch, agent, config, cwd, threadsDir(root, project), reg, TEMPLATES_DIR, threadSessionName(project, id)),
    sendFirstTurn: (pane, text, pre) => sendFirstTurnWhenReady(runtime, pane, text, pre),
    ledger: () => compactLedgerContext(project),
    newSessionId: randomUUID,
    now: () => new Date(),
  };
}

/** Best-effort captain workspace: a park/close must still record when the captain is down. */
async function captainWorkspaceOrNull(project: string) {
  try {
    return await resolveCaptainWorkspace(project);
  } catch {
    return null;
  }
}

/** `thread open`: fork the captain into a new tab for one topic. */
export async function runThreadOpen(project: string, topic: string, crews: string[] = []): Promise<{ thread: ThreadRecord; note?: string }> {
  return openThread({ project, topic: topic.trim(), crews }, await threadDeps(project));
}

/** `thread resume`: reopen a parked thread. */
export async function runThreadResume(project: string, id: string): Promise<{ thread: ThreadRecord; note?: string }> {
  return resumeThread(project, id, await threadDeps(project));
}

/**
 * `thread park`. Without a decision record: ask the thread to write its record. With one (raw JSON): deliver it to the
 * captain and close the tab. Returns the confirmation line.
 */
export async function runThreadPark(project: string, id: string, decisionRaw?: string): Promise<string> {
  const root = stateRoot();
  if (decisionRaw === undefined) {
    const ws = await resolveCaptainWorkspace(project);
    await requestPark(project, id, { stateRoot: root, runtime: ws.runtime, workspaceId: ws.workspaceId });
    return `✔ Asked thread '${id}' to write its decision record and park (pasted into its pane; receipt not confirmed).`;
  }
  const now = new Date();
  const decision = parseDecisionRecord(decisionRaw, now.toISOString());
  const ws = await captainWorkspaceOrNull(project);
  const { thread, seq } = await parkThread(project, id, decision, {
    stateRoot: root,
    // No live captain workspace ⇒ nothing to close; the record and message still land.
    runtime: ws?.runtime ?? ({ closePane: async () => {} } as unknown as ThreadDeps["runtime"]),
    workspaceId: ws?.workspaceId ?? "",
    workspaceDir: workspacePath(project),
    now: () => now,
  });
  return `✔ Thread '${thread.id}' parked; decision queued to the captain (seq=${seq}) and added to the handoff.`;
}

/** `thread list`: one entry per thread (closed ones only with `all`). */
export function threadListLines(project: string, all = false): string[] {
  return listThreads(stateRoot(), project).filter((t) => all || t.state !== "closed").map(formatThreadLine);
}

function fail(err: unknown): never {
  console.error(chalk.red((err as Error).message));
  process.exit(1);
}

export function formatOpened(project: string, thread: ThreadRecord, note?: string): { head: string; note?: string } {
  return {
    head: `✔ Thread '${thread.id}' open in tab "${threadTitleFor(project, thread.id)}" (${thread.mode}, ${thread.agent})`,
    ...(note ? { note: `  note: ${note}` } : {}),
  };
}

function printOpened(project: string, thread: ThreadRecord, note?: string): void {
  const o = formatOpened(project, thread, note);
  console.log(chalk.green(o.head));
  if (o.note) console.log(chalk.yellow(o.note));
}

export function formatThreadLine(t: ThreadRecord): string {
  const last = t.decisions.at(-1);
  return `  ${t.id.padEnd(28)} ${t.state.padEnd(7)} ${t.topic}${t.crews.length ? `  [${t.crews.join(", ")}]` : ""}${last ? `\n      ↳ ${last.decision}` : ""}`;
}

export const threadCommand = new Command("thread").description(
  "Captain discussion threads (#1016): fork the captain per topic, settle a decision with the operator, park it back as one decision record",
);

threadCommand
  .command("open")
  .description("Fork the captain into a new tab for one topic (claude: --resume --fork-session; other agents: seeded session)")
  .argument("<project>", "Project name")
  .argument("[topic]", "Topic of the discussion (omit with --topic-file)")
  .option("--crew <name...>", "Related crew name(s)")
  .option("--topic-file <path>", "Read topic from file ('-' for stdin)")
  .action(async (project: string, topic: string | undefined, opts: { crew?: string[]; topicFile?: string }) => {
    try {
      const resolved = await resolveTextInput({ positional: topic, filePath: opts.topicFile, label: "topic" });
      const { thread, note } = await runThreadOpen(project, resolved, opts.crew ?? []);
      printOpened(project, thread, note);
    } catch (err) {
      fail(err);
    }
  });

threadCommand
  .command("park")
  .description("Park a thread. Without --decision-file: ask the thread to write its decision record. With it: deliver the record to the captain (one message + one handoff line) and close the tab")
  .argument("<project>", "Project name")
  .argument("<id>", "Thread id")
  .option("--decision-file <path>", "Decision record JSON ('-' for stdin)")
  .action(async (project: string, id: string, opts: { decisionFile?: string }) => {
    try {
      const raw = opts.decisionFile
        ? await resolveTextInput({ positional: undefined, filePath: opts.decisionFile, label: "decision record" })
        : undefined;
      console.log(chalk.green(await runThreadPark(project, id, raw)));
    } catch (err) {
      fail(err);
    }
  });

threadCommand
  .command("resume")
  .description("Reopen a parked thread: same session + delta within ~1h, else a fresh fork with this topic's earlier decisions")
  .argument("<project>", "Project name")
  .argument("<id>", "Thread id")
  .action(async (project: string, id: string) => {
    try {
      const { thread, note } = await runThreadResume(project, id);
      printOpened(project, thread, note);
    } catch (err) {
      fail(err);
    }
  });

threadCommand
  .command("close")
  .description("Mark a thread closed (topic finished) and close its tab if open")
  .argument("<project>", "Project name")
  .argument("<id>", "Thread id")
  .action(async (project: string, id: string) => {
    try {
      const ws = await captainWorkspaceOrNull(project);
      await closeThread(project, id, { stateRoot: stateRoot(), now: () => new Date(), runtime: ws?.runtime, workspaceId: ws?.workspaceId });
      console.log(chalk.green(`✔ Thread '${id}' closed.`));
    } catch (err) {
      fail(err);
    }
  });

threadCommand
  .command("list")
  .description("List a project's threads (closed ones only with --all)")
  .argument("<project>", "Project name")
  .option("--all", "Include closed threads")
  .action((project: string, opts: { all?: boolean }) => {
    try {
      const lines = threadListLines(project, opts.all);
      if (lines.length === 0) {
        console.log(chalk.yellow(`No threads for ${project}.`));
        return;
      }
      for (const l of lines) console.log(l);
    } catch (err) {
      fail(err);
    }
  });

threadCommand
  .command("show")
  .description("Show one thread with its decision records")
  .argument("<project>", "Project name")
  .argument("<id>", "Thread id")
  .option("--json", "Raw JSON record")
  .action((project: string, id: string, opts: { json?: boolean }) => {
    try {
      const t = requireThread(stateRoot(), project, id);
      if (opts.json) {
        console.log(JSON.stringify(t, null, 2));
        return;
      }
      console.log(formatThreadLine(t));
      console.log(`  mode=${t.mode} agent=${t.agent} session=${t.sessionId ?? "-"} forkedAt=${t.forkedAt} lastActiveAt=${t.lastActiveAt}`);
      for (const d of t.decisions) console.log(`\n${formatDecisionMessage(t, d)}`);
    } catch (err) {
      fail(err);
    }
  });
