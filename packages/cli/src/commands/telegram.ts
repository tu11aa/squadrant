import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, DEFAULT_CONFIG_PATH } from "@squadrant/shared";
import type { SquadrantConfig, TelegramConfig } from "@squadrant/shared";
import { createTelegramClient, loadState, setTopic, topicKey, topicName, detectGroupId, writeTelegramConfig, maskToken } from "@squadrant/core";
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

async function questionMasked(prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    process.stdout.write(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const origWrite = (rl as any)._writeToOutput.bind(rl);
    (rl as any)._writeToOutput = (s: string) => {
      if (s.length === 1 && s.charCodeAt(0) < 32) {
        origWrite(s);
      } else {
        origWrite("*".repeat(Math.max(s.length, 0)));
      }
    };
    rl.question("", (answer) => {
      (rl as any)._writeToOutput = origWrite;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
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

telegramCommand
  .command("setup")
  .description("Interactive wizard — bot token, validate, auto-detect supergroup, write config")
  .action(async () => {
    if (!process.stdin.isTTY) {
      console.error(chalk.red("setup requires a TTY — pipe input is not supported"));
      process.exit(1);
    }

    // Step 1: masked token prompt
    const token = await questionMasked("Enter bot token from @BotFather (input hidden): ");
    if (!token) {
      console.error(chalk.red("token required"));
      process.exit(1);
    }

    // Step 2: validate via getMe()
    const client = createTelegramClient({ token });
    let botUser: { id: number; username: string };
    try {
      botUser = await client.getMe();
    } catch (e) {
      console.error(chalk.red(`token rejected: ${(e as Error).message}`));
      process.exit(1);
    }
    console.log(chalk.green(`Connected: @${botUser.username}`));

    // Step 3: auto-detect supergroup id
    console.log(chalk.cyan("Add the bot to your forum supergroup as admin (with Manage Topics)"));
    console.log(chalk.cyan("then send any message in that group. Waiting up to 60s…"));
    let supergroupId: number;
    try {
      supergroupId = await detectGroupId(client, { timeoutMs: 60_000 });
    } catch {
      console.error(chalk.red("timed out waiting for a supergroup message — make sure the bot is an admin"));
      process.exit(1);
    }
    console.log(chalk.green(`Detected supergroup id: ${supergroupId}`));

    // Step 4: write config
    writeTelegramConfig(DEFAULT_CONFIG_PATH, { token, supergroupId });
    console.log(chalk.green(`Config written to ${DEFAULT_CONFIG_PATH}`));

    // Step 5: masked display + next step
    console.log();
    console.log(`  token:      ${chalk.green(maskToken(token))}`);
    console.log(`  supergroup: ${chalk.green(String(supergroupId))}`);
    console.log();
    console.log(chalk.cyan("Next: run `squadrant telegram link <project>` for each project"));
  });
