import { join, dirname } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, DEFAULT_CONFIG_PATH } from "@squadrant/shared";
import type { SquadrantConfig, TelegramConfig } from "@squadrant/shared";
import { createTelegramClient, loadState, setTopic, topicKey, topicName, detectGroupAndUser, writeTelegramConfig, maskToken, isNotifyActive, setNotify } from "@squadrant/core";
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

/** Send a message to a project's linked Telegram topic. */
export async function runTelegramSend(opts: {
  project: string;
  message: string;
  cfg: TelegramConfig;
  client: TelegramClient;
  stateRoot: string;
}): Promise<{ chatId: number; topicId: number }> {
  const topicId = loadState(opts.stateRoot).topics[topicKey(opts.project)];
  if (topicId === undefined) {
    throw new Error(`project "${opts.project}" is not linked — run: squadrant telegram link ${opts.project}`);
  }
  await opts.client.sendMessage(opts.cfg.supergroupId, topicId, opts.message);
  return { chatId: opts.cfg.supergroupId, topicId };
}

/** Set a project's notification flag in telegram-state.json. */
export function runTelegramNotifySet(opts: { project: string; active: boolean; stateRoot: string }): void {
  setNotify(opts.stateRoot, opts.project, opts.active);
}

/** List every known project (union of linked topics and notify keys) with its state. */
export function runTelegramNotifyStatus(opts: { stateRoot: string }): Array<{ project: string; active: boolean }> {
  const s = loadState(opts.stateRoot);
  const projects = new Set<string>();
  for (const key of Object.keys(s.topics)) {
    const sep = key.indexOf("::");
    projects.add(sep === -1 ? key : key.slice(0, sep));
  }
  for (const p of Object.keys(s.notify)) projects.add(p);
  return [...projects].map((project) => ({ project, active: s.notify[project] === true }));
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

// Reads a secret from stdin, printing "*" per character. The caller must print
// the visible label before calling this — raw mode is active only during input.
export async function questionMasked(): Promise<string> {
  return new Promise<string>((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let answer = "";

    const onKeypress = (_str: string | undefined, key: { name: string; ctrl: boolean; meta: boolean; sequence: string }) => {
      if (key.ctrl && key.name === "c") {
        process.stdin.removeListener("keypress", onKeypress as any);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        process.exit(130);
      } else if (key.name === "return" || key.name === "enter") {
        process.stdin.removeListener("keypress", onKeypress as any);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(answer);
      } else if (key.name === "backspace") {
        if (answer.length > 0) {
          answer = answer.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (!key.ctrl && !key.meta && key.sequence) {
        answer += key.sequence;
        process.stdout.write("*");
      }
    };

    process.stdin.on("keypress", onKeypress as any);
  });
}

// Visible yes/no prompt (default No). Used for opt-ins where masking is wrong.
// Pauses stdin afterward so the process can exit cleanly (prior wizard-hang fix).
async function questionYesNo(prompt: string): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(ans.trim()));
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

    // Banner
    console.log();
    console.log(chalk.bold("Telegram setup") + " — connect squadrant to a Telegram bot for notifications + remote control");
    console.log();
    console.log("Before you start you need:");
    console.log("  1. A bot token from @BotFather (send /newbot)");
    console.log("  2. A forum supergroup with the bot added as an admin (Topics enabled)");
    console.log("  3. Bot privacy mode set to OFF (@BotFather → /setprivacy → Disable)");
    console.log();

    // Step 1/3 — Bot token
    console.log(chalk.bold("Step 1/3 — Bot token"));
    console.log("Paste your bot token then press Enter (input is hidden):");
    const token = await questionMasked();
    if (!token) {
      console.error(chalk.red("token required"));
      process.exit(1);
    }

    const client = createTelegramClient({ token });
    let botUser: { id: number; username: string };
    try {
      botUser = await client.getMe();
    } catch (e) {
      console.error(chalk.red(`token rejected: ${(e as Error).message}`));
      process.exit(1);
    }
    console.log(chalk.green(`Connected as @${botUser.username}`));
    console.log();

    // Step 2/3 — Find group
    console.log(chalk.bold("Step 2/3 — Find your group"));
    console.log("Add the bot to your forum supergroup, then send any message in it.");
    console.log(chalk.dim("Waiting for a message (up to 60s)…"));
    let supergroupId: number;
    let userId: number | undefined;
    try {
      ({ supergroupId, userId } = await detectGroupAndUser(client, { timeoutMs: 60_000 }));
    } catch {
      console.error(chalk.red("Timed out — no supergroup message received within 60s."));
      console.error(chalk.yellow("Check: bot is an admin in the group · privacy mode is OFF · Topics enabled"));
      process.exit(1);
    }
    console.log(chalk.green(`Found group: ${supergroupId}`));
    console.log();

    // Step 3/3 — Remote control (opt-in, #321) + Save
    console.log(chalk.bold("Step 3/3 — Remote control + Save"));
    console.log(chalk.dim("Remote control enables auto-launching captains and the General command channel"));
    console.log(chalk.dim("from your phone — gated to your Telegram user-id only (fail-closed)."));
    let users: number[] | undefined;
    let remoteControl: boolean | undefined;
    if (userId === undefined) {
      console.log(chalk.yellow("Could not read your user-id from that message — skipping remote control."));
      console.log(chalk.yellow("Re-run setup once it's available, or edit telegram.users in config manually."));
    } else {
      const enable = await questionYesNo(
        `Enable remote control for your user-id ${userId}? [y/N] `,
      );
      if (enable) {
        users = [userId];
        remoteControl = true;
      }
    }

    writeTelegramConfig(DEFAULT_CONFIG_PATH, { token, supergroupId, users, remoteControl });
    console.log(chalk.green(`Wrote telegram config — token: ${maskToken(token)}  group: ${supergroupId}`));
    if (remoteControl) {
      console.log(chalk.green(`Remote control: ON (allowlisted user-id ${users?.[0]})`));
    } else {
      console.log(chalk.dim("Remote control: off (default). Re-run setup to enable later."));
    }
    console.log();
    console.log(`Next: ${chalk.cyan("squadrant telegram link <project>")}`);
  });

telegramCommand
  .command("notify")
  .argument("[project]", "project to toggle")
  .argument("[state]", "on | off")
  .option("--status", "list notification state for all projects")
  .description("Per-project lifecycle notifications: on|off, or --status to list")
  .action((project: string | undefined, state: string | undefined, opts: { status?: boolean }) => {
    const stateRoot = defaultStateRoot();
    if (opts.status || !project) {
      const rows = runTelegramNotifyStatus({ stateRoot });
      if (rows.length === 0) {
        console.log("no projects linked");
        return;
      }
      for (const r of rows) {
        console.log(`  ${r.project}: ${r.active ? chalk.green("on") : chalk.dim("off (muted)")}`);
      }
      return;
    }
    if (state !== "on" && state !== "off") {
      console.error(chalk.red("usage: squadrant telegram notify <project> <on|off>"));
      process.exit(1);
    }
    runTelegramNotifySet({ project, active: state === "on", stateRoot });
    console.log(chalk.green(`${project} notifications ${state === "on" ? "ON" : "OFF"}`));
  });

telegramCommand
  .command("send")
  .argument("<project>", "project whose topic receives the message")
  .argument("[message...]", "message text (omit to read from stdin)")
  .description("Send a message to a project's linked Telegram topic")
  .action(async (project: string, messageParts: string[]) => {
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

    let message: string;
    if (messageParts.length > 0) {
      message = messageParts.join(" ");
    } else if (!process.stdin.isTTY) {
      const { createInterface } = await import("node:readline");
      const lines: string[] = [];
      const rl = createInterface({ input: process.stdin });
      for await (const line of rl) lines.push(line);
      message = lines.join("\n").trimEnd();
      if (!message) {
        console.error(chalk.red("no message provided (stdin was empty)"));
        process.exit(1);
      }
    } else {
      console.error(chalk.red("message required — pass as argument or pipe via stdin"));
      process.exit(1);
    }

    const client = createTelegramClient({ token });
    try {
      const { chatId, topicId } = await runTelegramSend({ project, message, cfg, client, stateRoot: defaultStateRoot() });
      console.log(chalk.green(`sent to group ${chatId} topic ${topicId}`));
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exit(1);
    }
  });
