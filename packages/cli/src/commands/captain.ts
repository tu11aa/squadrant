// captain.ts — captain session controls.
//
// `squadrant captain compact <project> [--focus <text>]` (#1010) asks the daemon to
// /compact a Claude captain once its turn has ended and its input box is clear.
// Returns immediately; the daemon owns the wait and the pane typing (see
// core/daemon/captain-compact.ts).
//
// `squadrant captain restart <project>` (#1137) restarts the captain into a fresh
// session. A detached helper (lib/captain-restart.ts) waits for the captain to go
// idle, then runs `launch --fresh`; no daemon code is involved.
import { Command, Option } from "commander";
import chalk from "chalk";
import { spawn } from "node:child_process";
import { loadConfig, stateRoot as defaultStateRoot, workspacePath } from "@squadrant/shared";
import { readCaptainAddress, resolveCurrentProject } from "@squadrant/core";
import { RuntimeRegistry, createCmuxDriver, cmuxLocal, createCmuxNotifier, NotifierRegistry } from "@squadrant/workspaces";
import { squadrantdCall } from "./crew-control.js";
import { runPing, formatPingResult } from "./ping.js";
import { readCaptainSessionRegistry } from "../lib/captain-session-registry.js";
import {
  startCaptainRestart, runRestartHelper, releaseRestartLock, restartPaths, resolveCaptainSessionId,
  cmuxSessionLifecycle, type StartRestartResult,
} from "../lib/captain-restart.js";

export async function runCaptainCompact(
  project: string,
  focus: string | undefined,
  call: (req: unknown) => Promise<unknown> = squadrantdCall,
): Promise<void> {
  if (!loadConfig().projects[project]) {
    throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  }
  await call({ kind: "captain-compact", project, focus });
}

export const compactQueuedLine = (project: string): string => `✔ Compact queued for '${project}' — it runs once the captain's turn ends.`;

function parseTimeoutMs(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--timeout-ms must be a positive integer, got '${v}'`);
  return n;
}

/** #1137: validate, then spawn the detached restart helper. Claude captains only. */
export function runCaptainRestart(project: string, opts: { focus?: boolean; timeoutMs?: string }): StartRestartResult {
  const config = loadConfig();
  if (!config.projects[project]) {
    throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  }
  const stateRoot = defaultStateRoot();
  const agent = readCaptainAddress(stateRoot, project)?.agent ?? config.defaults.roles?.captain?.agent ?? "claude";
  if (agent !== "claude") {
    throw new Error(
      `captain restart supports Claude captains only — '${project}' runs ${agent}. The idle check reads Claude Code's hook state and pane; ` +
        `for ${agent}, end the turn and run 'squadrant launch ${project} --fresh' from another terminal.`,
    );
  }
  const sessionId = resolveCaptainSessionId(
    process.env,
    resolveCurrentProject(config) === project,
    readCaptainSessionRegistry(workspacePath(project)),
  );
  return startCaptainRestart({
    project, stateRoot, cliPath: process.argv[1], sessionId, focus: opts.focus, timeoutMs: parseTimeoutMs(opts.timeoutMs),
  });
}

export function restartResultLine(project: string, r: StartRestartResult): string {
  return r.status === "started"
    ? `✔ Restart queued for '${project}' — helper pid ${r.pid} relaunches the captain fresh once its turn ends. Log: ${r.log}`
    : `⏸ A restart for '${project}' is already pending (helper pid ${r.holder.pid}, since ${r.holder.startedAt}) — not queued again. Log: ${r.holder.log}`;
}

export const captainCommand = new Command("captain").description("Captain session controls (#1010, #1137)");

captainCommand
  .command("compact <project>")
  .description("Queue a /compact for the project's Claude captain; typed by the daemon once the captain is idle (returns immediately)")
  .option("--focus <text>", "focus text passed to /compact")
  .action(async (project: string, opts: { focus?: string }) => {
    try {
      await runCaptainCompact(project, opts.focus);
      console.log(chalk.green(compactQueuedLine(project)));
    } catch (e) {
      console.error(chalk.red(`✖ ${(e as Error).message}`));
      process.exit(1);
    }
  });

captainCommand
  .command("restart <project>")
  .description("Restart the project's Claude captain into a fresh session once its turn ends (detached helper; returns immediately)")
  .option("--focus", "switch to the new captain workspace once it is up")
  .addOption(new Option("--timeout-ms <ms>", "give up if the captain is not idle within this time (default 10 min)").hideHelp())
  .action((project: string, opts: { focus?: boolean; timeoutMs?: string }) => {
    try {
      const r = runCaptainRestart(project, opts);
      console.log(r.status === "started" ? chalk.green(restartResultLine(project, r)) : chalk.yellow(restartResultLine(project, r)));
    } catch (e) {
      console.error(chalk.red(`✖ ${(e as Error).message}`));
      process.exit(1);
    }
  });

// The detached helper itself — started by `captain restart`, never by hand.
captainCommand
  .command("restart-run <project>", { hidden: true })
  .option("--session <id>")
  .option("--focus")
  .option("--timeout-ms <ms>")
  .action(async (project: string, opts: { session?: string; focus?: boolean; timeoutMs?: string }) => {
    const { lock } = restartPaths(defaultStateRoot(), project);
    const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
    let ok = false;
    try {
      const config = loadConfig();
      const captainName = config.projects[project]?.captainName ?? `${project}-captain`;
      const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, config);
      const outcome = await runRestartHelper({
        project,
        captainName,
        sessionId: opts.session,
        runtime,
        lifecycle: (id) => cmuxSessionLifecycle(id),
        launchFresh: () => new Promise<number>((resolve) => {
          const c = spawn(process.execPath, [process.argv[1], "launch", project, "--fresh", "--headless"], { stdio: ["ignore", "inherit", "inherit"] });
          c.on("error", (e) => { log(`launch did not start: ${e.message}`); resolve(1); });
          c.on("exit", (code) => resolve(code ?? 1));
        }),
        focus: opts.focus ? (id) => { cmuxLocal(["select-workspace", "--workspace", id]); } : undefined,
        notify: async (text) => {
          await new NotifierRegistry({ cmux: createCmuxNotifier }).get(config).notify(text)
            .catch((e: unknown) => log(`operator notice failed: ${(e as Error).message}`));
          await runPing(project, text, "cli:captain-restart")
            .then((o) => log(formatPingResult(project, o)))
            .catch((e: unknown) => log(`captain notice failed: ${(e as Error).message}`));
        },
        log,
        timeoutMs: parseTimeoutMs(opts.timeoutMs),
      });
      log(`done: ${outcome}`);
      ok = outcome === "restarted";
    } catch (e) {
      log(`failed: ${(e as Error).message}`);
    } finally {
      releaseRestartLock(lock, process.pid);
    }
    process.exit(ok ? 0 : 1);
  });
