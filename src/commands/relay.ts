import { Command } from "commander";
import { createConnection } from "node:net";
import chalk from "chalk";
import { loadConfig, type CockpitConfig } from "@cockpit/shared";
import { createCmuxDriver, RuntimeRegistry } from "@cockpit/workspaces";
import type { RuntimeDriver } from "@cockpit/workspaces";
import { runNotifyRelay, DEFAULT_STATE_ROOT } from "./notify-relay.js";
import { runRelaySupervisor } from "../control/relay-supervisor-loop.js";
import {
  createRelayLogBroadcaster,
  relayLogSockPath,
} from "../control/relay-log-broadcaster.js";

export interface RelaySuperviseArgs {
  project: string;
  subscriber?: string;
  config: CockpitConfig;
  stateRoot: string;
}

export function buildRelaySuperviseArgs(opts: RelaySuperviseArgs): {
  project: string;
  subscriber: string;
  captainName: string;
  stateRoot: string;
} {
  const { project, subscriber, config, stateRoot } = opts;
  const projCfg = config.projects[project];
  if (!projCfg) throw new Error(`unknown project '${project}'`);
  return {
    project,
    subscriber: subscriber ?? "captain",
    captainName: projCfg.captainName,
    stateRoot,
  };
}

const NO_RELAY_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

async function connectAndStream(
  sockPath: string,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const conn = createConnection(sockPath);
    let settled = false;
    conn.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    conn.on("data", (chunk: Buffer | string) => {
      stdout.write(chunk as string);
    });
    // Ensure full close after server half-closes (conn.end() on server side).
    conn.on("end", () => { conn.destroy(); });
    conn.on("close", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}

export async function readRelayLogs(opts: {
  sockPath: string;
  follow: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  sleep: (ms: number) => Promise<void>;
  shouldContinue?: () => boolean;
}): Promise<void> {
  const { sockPath, follow, stdout, stderr, sleep } = opts;
  const shouldContinue = opts.shouldContinue ?? (() => true);
  const project = sockPath.match(/relay-(.+)\.sock$/)?.[1] ?? sockPath;

  while (shouldContinue()) {
    try {
      await connectAndStream(sockPath, stdout);
      if (!follow) return;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code && NO_RELAY_CODES.has(code)) {
        if (!follow) {
          stderr.write(`no live relay for '${project}' — start the captain first\n`);
          return;
        }
        // follow: fall through to sleep + retry
      } else {
        throw e;
      }
    }
    await sleep(2000);
  }
}

export const relayCommand = new Command("relay")
  .description("Manage the notify-relay supervisor for a project captain")
  .addCommand(
    new Command("supervise")
      .description(
        "Run the notify-relay in an in-process restart loop. " +
          "Captains run this as a run_in_background process on startup.",
      )
      .argument("<project>", "Project to supervise relay for")
      .option("--as <subscriber>", "subscriber name", "captain")
      .option("--state-root <path>", "override state root", DEFAULT_STATE_ROOT)
      .action(async (project: string, opts: { as: string; stateRoot: string }) => {
        try {
          const config = loadConfig();
          if (config.defaults?.daemonDirectCmux) {
            console.log(chalk.blue("daemon-direct active; relay disabled (#332)"));
            return;
          }
          const relayArgs = buildRelaySuperviseArgs({
            project,
            subscriber: opts.as,
            config,
            stateRoot: opts.stateRoot,
          });

          const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
          const runtime = registry.forProject(project, config);

          const broadcaster = await createRelayLogBroadcaster(project);

          const teeLog = (prefix: string) => (m: string) => {
            const line = `${prefix} ${m}`;
            process.stdout.write(line + "\n");
            broadcaster.log(line);
          };

          const stop = await runRelaySupervisor({
            delayMs: 3000,
            bootRelay: async () => {
              const innerStop = await runNotifyRelay({
                project: relayArgs.project,
                subscriber: relayArgs.subscriber,
                stateRoot: relayArgs.stateRoot,
                runtime: runtime as unknown as RuntimeDriver,
                captainName: relayArgs.captainName,
                pollMs: 1000,
                log: teeLog(`[notify-relay ${project}]`),
              });
              return innerStop;
            },
            sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
            log: teeLog(`[relay supervise ${project}]`),
          });

          process.on("SIGTERM", () => {
            if (stop) stop();
            broadcaster.close().finally(() => process.exit(0));
          });

          // Process stays alive on the relay's setInterval handles.
          // When the relay exits or crashes, the process exits and the
          // captain's run_in_background wakes and relaunches.
        } catch (err) {
          console.error(chalk.red(`relay supervise: ${(err as Error).message}`));
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command("logs")
      .description(
        "Stream live relay log output to this terminal. " +
          "Connects to the running relay's log socket; exit with Ctrl+C.",
      )
      .argument("<project>", "Project to stream relay logs for")
      .option("-f, --follow", "auto-reconnect if the relay restarts")
      .action(async (project: string, opts: { follow?: boolean }) => {
        const sockPath = relayLogSockPath(project);
        let hadError = false;
        await readRelayLogs({
          sockPath,
          follow: opts.follow ?? false,
          stdout: process.stdout,
          stderr: {
            write: (s: string) => {
              hadError = true;
              return process.stderr.write(s);
            },
          } as unknown as NodeJS.WritableStream,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
        if (hadError) process.exit(1);
      }),
  );
