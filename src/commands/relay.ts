import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, type CockpitConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import { runNotifyRelay, DEFAULT_STATE_ROOT } from "./notify-relay.js";
import { runRelaySupervisor } from "../control/relay-supervisor-loop.js";
import type { RuntimeDriver } from "../runtimes/types.js";

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
          const relayArgs = buildRelaySuperviseArgs({
            project,
            subscriber: opts.as,
            config,
            stateRoot: opts.stateRoot,
          });

          const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
          const runtime = registry.forProject(project, config);

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
              });
              return innerStop;
            },
            sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
            log: (m: string) =>
              process.stdout.write(`[relay supervise ${project}] ${m}\n`),
          });

          process.on("SIGTERM", () => {
            if (stop) stop();
            process.exit(0);
          });

          // Process stays alive on the relay's setInterval handles.
          // When the relay exits or crashes, the process exits and the
          // captain's run_in_background wakes and relaunches.
        } catch (err) {
          console.error(chalk.red(`relay supervise: ${(err as Error).message}`));
          process.exit(1);
        }
      }),
  );
