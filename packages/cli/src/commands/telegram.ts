import { join, dirname } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, DEFAULT_CONFIG_PATH } from "@squadrant/shared";
import type { SquadrantConfig, TelegramConfig } from "@squadrant/shared";
import { createTelegramClient, loadState, setTopic, topicKey, topicName } from "@squadrant/core";
import type { TelegramClient } from "@squadrant/core";

/** Daemon state root (mirrors buildContext): ~/.config/squadrant/state. */
function defaultStateRoot(): string {
  return join(dirname(DEFAULT_CONFIG_PATH), "state");
}

export interface TelegramStatusResult {
  tokenSet: boolean;
  supergroupId: number | null;
  links: Array<{ project: string; scope: string; topicId: number }>;
}

export function runTelegramStatus(opts: {
  config: SquadrantConfig;
  stateRoot: string;
  env?: NodeJS.ProcessEnv;
}): TelegramStatusResult {
  const tg = opts.config.telegram;
  const env = opts.env ?? process.env;
  const tokenSet = !!(tg?.botToken ?? env.TELEGRAM_BOT_TOKEN);
  const links = Object.entries(loadState(opts.stateRoot).topics).map(([key, topicId]) => {
    const sep = key.indexOf("::");
    return { project: key.slice(0, sep), scope: key.slice(sep + 2), topicId };
  });
  return { tokenSet, supergroupId: tg?.supergroupId ?? null, links };
}

/** Bind a project to a forum topic, creating it on first link. Idempotent. */
export async function runTelegramLink(opts: {
  project: string;
  cfg: TelegramConfig;
  client: TelegramClient;
  stateRoot: string;
}): Promise<{ topicId: number; created: boolean }> {
  const existing = loadState(opts.stateRoot).topics[topicKey(opts.project)];
  if (existing !== undefined) return { topicId: existing, created: false };
  const topicId = await opts.client.createForumTopic(opts.cfg.supergroupId, topicName(opts.project));
  setTopic(opts.stateRoot, opts.project, topicId);
  return { topicId, created: true };
}

export const telegramCommand = new Command("telegram")
  .description("Two-way Telegram integration: push crew events to a topic and reply into the captain pane");

telegramCommand
  .command("status")
  .description("Show Telegram config and linked projects")
  .action(() => {
    const { tokenSet, supergroupId, links } = runTelegramStatus({ config: loadConfig(), stateRoot: defaultStateRoot() });
    console.log(`token: ${tokenSet ? chalk.green("set") : chalk.yellow("unset")}`);
    console.log(`supergroup: ${supergroupId ?? chalk.yellow("unset")}`);
    if (links.length === 0) {
      console.log("no projects linked");
      return;
    }
    for (const l of links) console.log(`  ${l.project} (${l.scope}) → topic ${l.topicId}`);
  });

telegramCommand
  .command("link")
  .argument("<project>", "project to bind to a Telegram topic")
  .description("Create (or reuse) a forum topic for a project and bind it")
  .action(async (project: string) => {
    const cfg = loadConfig().telegram;
    if (!cfg) {
      console.error(chalk.red("telegram config absent — add a `telegram` block to ~/.config/squadrant/config.json"));
      process.exit(1);
    }
    const token = cfg.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error(chalk.red("no botToken in config and TELEGRAM_BOT_TOKEN is unset"));
      process.exit(1);
    }
    const client = createTelegramClient({ token });
    const { topicId, created } = await runTelegramLink({ project, cfg, client, stateRoot: defaultStateRoot() });
    console.log(chalk.green(`${created ? "linked" : "already linked"}: ${project} → topic ${topicId}`));
  });
