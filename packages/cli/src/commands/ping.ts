// src/commands/ping.ts
//
// Cross-project reach, fire-and-forget tier: deliver a message into ANY
// registered project's captain pane. No tracked task, no report-back.
// Reuses the same delivery mechanism as `squadrant runtime send`.

import { join, dirname } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, DEFAULT_CONFIG_PATH, resolveCaptainChannelMode } from "@squadrant/shared";
import { appendCaptainMessage, deliverToCaptain, type DeliveryOutcome, describeOutcome } from "@squadrant/core";
import { buildRegistry, resolveTarget, needRef } from "./runtime.js";
import { requireDaemon } from "../lib/require-daemon.js";
import { buildCaptainChannel } from "../lib/captain-channel-factory.js";

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

export async function runPing(project: string, message: string): Promise<DeliveryOutcome | undefined> {
  const config = loadConfig();
  const registry = buildRegistry();
  const resolved = resolveTarget(registry, config, project, false);
  
  await requireDaemon();
  await needRef(resolved);
  
  const mode = resolveCaptainChannelMode(config.defaults);
  const { handled, outcome } = await deliverToCaptain(project, message, {
    channel: mode === "off" ? undefined : await buildCaptainChannel(project),
    mode,
    log: (m) => console.error(chalk.dim(m)),
  });

  if (!handled) {
    const stateRoot = join(dirname(DEFAULT_CONFIG_PATH), "state");
    await appendCaptainMessage({
      stateRoot,
      project,
      text: message,
      source: "cli",
    });
  }
  return outcome;
}

export const pingCommand = new Command("ping")
  .description("Fire-and-forget: deliver a message into a registered project's captain pane (no tracked task, no report-back)")
  .argument("<project>", "Target project name (must be registered)")
  .argument("<message>", "Message to deliver")
  .action(async (project: string, message: string) => {
    try {
      const outcome = await runPing(project, message);
      console.log(formatPingResult(project, outcome));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
