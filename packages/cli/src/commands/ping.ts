// src/commands/ping.ts
//
// Cross-project reach, fire-and-forget tier: deliver a message into ANY
// registered project's captain pane. No tracked task, no report-back.
// Reuses the same delivery mechanism as `squadrant runtime send`.

import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveCaptainChannelMode, stateRoot as defaultStateRoot } from "@squadrant/shared";
import { appendCaptainMessage, deliverToCaptain, frameMessage, isValidSender, resolveCurrentProject, type DeliveryOutcome, describeOutcome, type ControlChannel } from "@squadrant/core";
import { buildRegistry, resolveTarget, needRef } from "./runtime.js";
import { requireDaemon } from "../lib/require-daemon.js";
import { buildCaptainChannels } from "../lib/captain-channel-factory.js";

/** Pure so it is testable without a socket. */
export function formatPingResult(project: string, outcome?: DeliveryOutcome): string {
  if (!outcome) return `✔ Pinged '${project}'`;
  switch (outcome.status) {
    case "accepted":
      return outcome.confirmed === false
        ? `✔ Sent to '${project}' (${describeOutcome(outcome)})`
        : `✔ Delivered to '${project}' (${describeOutcome(outcome)})`;
    case "queued":
      return `✔ Queued for '${project}' (${describeOutcome(outcome)})`;
    case "held":
      return `⏸ Held for '${project}' — awaiting approval in that session: ${outcome.reason}`;
    case "gone":
      return `⚠ Captain for '${project}' is not reachable — fell back to its pane mailbox`;
    case "unsupported":
      return `✔ Pinged '${project}'`;
  }
}

/** Inside a registered project's directory the sender is that project's captain (`captain:<project>`); a plain terminal is `cli`. */
export function defaultSender(config: ReturnType<typeof loadConfig>): string {
  const current = resolveCurrentProject(config);
  return current ? `captain:${current}` : "cli";
}

export async function runPing(project: string, message: string, fromOpt?: string): Promise<DeliveryOutcome | undefined> {
  if (fromOpt !== undefined && !isValidSender(fromOpt)) throw new Error(`Invalid --from '${fromOpt}' — use a label like side:research-1`);
  const config = loadConfig();
  const from = fromOpt ?? defaultSender(config);
  const registry = buildRegistry();
  const resolved = resolveTarget(registry, config, project, false);
  
  await requireDaemon();
  await needRef(resolved);
  
  const mode = resolveCaptainChannelMode(config.defaults);
  // #786: route by the captain's agent (launch record, else config) so an
  // opencode captain is reached over its HTTP channel, not the claude socket.
  const stateRoot = defaultStateRoot();
  const { channels, agentFor } = mode === "off"
    ? { channels: {} as Record<string, ControlChannel>, agentFor: () => undefined }
    : await buildCaptainChannels({ stateRoot, configAgent: config.defaults.roles?.captain?.agent });
  const channel = channels[agentFor(project) ?? ""];
  const { handled, outcome } = await deliverToCaptain(project, frameMessage({ from, project, kind: "captain.message" }, message), {
    channel,
    mode,
    log: (m) => console.error(chalk.dim(m)),
  });

  if (!handled) {
    await appendCaptainMessage({
      stateRoot,
      project,
      text: message,
      source: "cli",
      from,
    });
  }
  return outcome;
}

export const pingCommand = new Command("ping")
  .description("Fire-and-forget: deliver a message into a registered project's captain pane (no tracked task, no report-back)")
  .argument("<project>", "Target project name (must be registered)")
  .argument("<message>", "Message to deliver")
  .option("--from <sender>", "Sender label shown to the captain, e.g. side:research-1 (default: captain:<current project>, else cli)")
  .action(async (project: string, message: string, opts: { from?: string }) => {
    try {
      const outcome = await runPing(project, message, opts.from);
      console.log(formatPingResult(project, outcome));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
