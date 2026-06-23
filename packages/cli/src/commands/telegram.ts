import { join, dirname } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, DEFAULT_CONFIG_PATH, saveProjectOverride, resolveNotify, loadProjectOverride, isQuieter } from "@squadrant/shared";
import type { SquadrantConfig, TelegramConfig, NotifyConfig, CrewTier } from "@squadrant/shared";
import { createTelegramClient, loadState, setTopic, topicKey, topicName, detectGroupAndUser, writeTelegramConfig, maskToken, isNotifyActive, setNotify, BOT_COMMANDS, resolveSetupGroup } from "@squadrant/core";
import type { TelegramClient } from "@squadrant/core";
import { restartDaemonIfRunning, type RestartOutcome } from "../control/restart-daemon.js";

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

/** Write a deliberate per-project notification preference (crew tier / cap) to
 *  projects/<name>.json. Distinct from live on|off state (telegram-state.json). */
export function runTelegramNotifyPref(
  args: { project: string; dimension: "crew" | "cap"; value: string; root?: string },
): { ok: true } | { ok: false; message: string } {
  const { project, dimension, value, root } = args;
  if (dimension === "crew") {
    if (!["all", "alert_only", "done_only", "none"].includes(value))
      return { ok: false, message: "crew must be all|alert_only|done_only|none" };
    saveProjectOverride(project, { telegram: { notify: { crew: value as any } } }, root);
    return { ok: true };
  }
  if (value !== "on" && value !== "off") return { ok: false, message: "cap must be on|off" };
  saveProjectOverride(project, { telegram: { notify: { cap: value === "on" } } }, root);
  return { ok: true };
}

/** Resolved `cap` for a project — whether explicit captain messages may be sent.
 *  `cap=false` is the deliberate "don't let the captain DM me" switch; live
 *  idle-mute (active) is intentionally NOT consulted here (an explicit push
 *  shouldn't be dropped just because the topic is idle-muted). */
export function capAllowed(project: string, globalNotify: TelegramConfig["notify"], root?: string): boolean {
  return resolveNotify(globalNotify, loadProjectOverride(project, root)).cap;
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

function confirmationText(project: string, before: NotifyConfig, after: NotifyConfig, dim: "active" | "cap" | "crew"): string {
  if (dim === "active") return `🔕 ${project} — all notifications muted here. Unmute: squadrant telegram notify ${project} on`;
  if (dim === "cap")    return `🔕 ${project} — captain messages muted here. Re-enable: squadrant telegram notify ${project} cap on`;
  return `🔕 ${project} — crew notifications now '${after.crew}' (was '${before.crew}'). Re-enable: squadrant telegram notify ${project} crew ${before.crew}`;
}

/** Send a one-time mute confirmation directly to the project topic, bypassing all delivery gates.
 *  Returns true if the message was sent, false if skipped (not quieter / no topic) or failed. */
export async function runNotifyConfirmation(opts: {
  project: string;
  before: NotifyConfig;
  after: NotifyConfig;
  cfg: TelegramConfig;
  client: TelegramClient;
  stateRoot: string;
}): Promise<boolean> {
  const { quieter, dim } = isQuieter(opts.before, opts.after);
  if (!quieter || dim === null) return false;
  const topicId = loadState(opts.stateRoot).topics[topicKey(opts.project)];
  if (topicId === undefined) return false;
  const text = confirmationText(opts.project, opts.before, opts.after, dim);
  try {
    await opts.client.sendMessage(opts.cfg.supergroupId, topicId, text);
    return true;
  } catch {
    console.warn(`[squadrant] mute-confirmation send failed for ${opts.project} — notification preference was still saved`);
    return false;
  }
}

export function resolveSetupToken(
  existingToken: string | undefined,
  opts: { resetToken: boolean },
): "prompt" | "try-reuse" {
  if (opts.resetToken || !existingToken) return "prompt";
  return "try-reuse";
}

/**
 * Precedence: explicit --user-id flag > detected userId (first-run getUpdates) >
 * lastUserId persisted in telegram-state.json by the bridge poll (passive capture).
 */
export function resolveSetupUserId(
  flagUserId: number | undefined,
  detectedUserId: number | undefined,
  stateRoot: string,
): number | undefined {
  return flagUserId ?? detectedUserId ?? loadState(stateRoot).lastUserId;
}

export async function runRegisterCommands(opts: { client: TelegramClient }): Promise<void> {
  await opts.client.setMyCommands(BOT_COMMANDS);
}

export function runTelegramPostSetup(opts: {
  doRestart?: (o: { reason: string }) => RestartOutcome;
}): void {
  const doRestart = opts.doRestart ?? restartDaemonIfRunning;
  const outcome = doRestart({ reason: "telegram config" });
  if (outcome === "skipped-not-running") {
    console.log(chalk.dim("(daemon not running — change applies on next start)"));
  } else if (outcome === "skipped-opt-out") {
    console.log(chalk.dim("(run 'squadrant heal daemon' to apply)"));
  }
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
  .option("--reset-token", "force re-entry of the bot token even if one already exists")
  .option("--redetect", "force group re-detection even when a supergroup is already configured")
  .option("--user-id <id>", "allowlist user-id — enables remote control on a re-run without getUpdates detection", (v: string) => parseInt(v, 10))
  .action(async (opts: { resetToken?: boolean; redetect?: boolean; userId?: number }) => {
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

    // Step 1/3 — Bot token (reuse if present unless --reset-token)
    console.log(chalk.bold("Step 1/3 — Bot token"));
    const existingCfg = loadConfig().telegram;
    const existingToken = existingCfg?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    const decision = resolveSetupToken(existingToken, { resetToken: opts.resetToken ?? false });

    let token: string;
    let client: TelegramClient;
    let botUser: { id: number; username: string };

    if (decision === "try-reuse") {
      client = createTelegramClient({ token: existingToken! });
      try {
        botUser = await client.getMe();
        token = existingToken!;
        console.log(chalk.green(`Using existing bot token (@${botUser.username})`));
        console.log();
      } catch {
        console.log(chalk.yellow("Existing token is invalid — please enter a new one."));
        console.log("Paste your bot token then press Enter (input is hidden):");
        token = await questionMasked();
        if (!token) { console.error(chalk.red("token required")); process.exit(1); }
        client = createTelegramClient({ token });
        try {
          botUser = await client.getMe();
        } catch (e) {
          console.error(chalk.red(`token rejected: ${(e as Error).message}`));
          process.exit(1);
        }
        console.log(chalk.green(`Connected as @${botUser.username}`));
        console.log();
      }
    } else {
      console.log("Paste your bot token then press Enter (input is hidden):");
      token = await questionMasked();
      if (!token) { console.error(chalk.red("token required")); process.exit(1); }
      client = createTelegramClient({ token });
      try {
        botUser = await client.getMe();
      } catch (e) {
        console.error(chalk.red(`token rejected: ${(e as Error).message}`));
        process.exit(1);
      }
      console.log(chalk.green(`Connected as @${botUser.username}`));
      console.log();
    }

    // Step 2/3 — Supergroup (reuse if already configured and --redetect not passed)
    console.log(chalk.bold("Step 2/3 — Supergroup"));
    const groupDecision = resolveSetupGroup(existingCfg?.supergroupId, { redetect: opts.redetect ?? false });
    let supergroupId: number;
    let detectedUserId: number | undefined;

    if (groupDecision === "reuse") {
      supergroupId = existingCfg!.supergroupId;
      console.log(chalk.green(`Using existing group: ${supergroupId}`));
      console.log();
    } else {
      console.log("Add the bot to your forum supergroup, then send any message in it.");
      console.log(chalk.dim("Waiting for a message (up to 60s)…"));
      try {
        ({ supergroupId, userId: detectedUserId } = await detectGroupAndUser(client, { timeoutMs: 60_000 }));
      } catch {
        console.error(chalk.red("Timed out — no supergroup message received within 60s."));
        console.error(chalk.yellow("Check: bot is an admin in the group · privacy mode is OFF · Topics enabled"));
        process.exit(1);
      }
      console.log(chalk.green(`Found group: ${supergroupId}`));
      console.log();
    }

    // Step 3/3 — Remote control (opt-in, #321) + Save
    // Precedence for userId: --user-id flag > detected (detect mode only) > lastUserId from state
    console.log(chalk.bold("Step 3/3 — Remote control + Save"));
    console.log(chalk.dim("Remote control enables auto-launching captains and the General command channel"));
    console.log(chalk.dim("from your phone — gated to your Telegram user-id only (fail-closed)."));

    const finalUserId = resolveSetupUserId(opts.userId, detectedUserId, defaultStateRoot());
    let users: number[] | undefined;
    let remoteControl: boolean | undefined;
    let printedRemoteControlState = false;

    if (finalUserId !== undefined) {
      const enable = await questionYesNo(
        `Enable remote control for your user-id ${finalUserId}? [y/N] `,
      );
      if (enable) {
        users = [finalUserId];
        remoteControl = true;
      }
    } else if (groupDecision === "detect") {
      // Detection ran but no userId came back from the message
      console.log(chalk.yellow("Could not read your user-id from that message — skipping remote control."));
      console.log(chalk.yellow("Re-run with --user-id <id> to enable, or edit telegram.users in config manually."));
      printedRemoteControlState = true;
    } else {
      // Reuse mode, no --user-id: existing users/remoteControl preserved by writeTelegramConfig
      const existingUsers = existingCfg?.users;
      if (existingUsers && existingUsers.length > 0) {
        console.log(chalk.dim(`Remote control: already configured (user-id ${existingUsers[0]}). Use --user-id to update.`));
      } else {
        console.log(chalk.dim("Remote control: off. Re-run with --user-id <id> to enable."));
      }
      printedRemoteControlState = true;
    }

    writeTelegramConfig(DEFAULT_CONFIG_PATH, { token, supergroupId, users, remoteControl });
    console.log(chalk.green(`Wrote telegram config — token: ${maskToken(token)}  group: ${supergroupId}`));

    if (!printedRemoteControlState) {
      if (remoteControl) {
        console.log(chalk.green(`Remote control: ON (allowlisted user-id ${users![0]})`));
      } else {
        console.log(chalk.dim("Remote control: off (default). Re-run with --user-id <id> to enable."));
      }
    }

    try {
      await runRegisterCommands({ client });
      console.log(chalk.dim("Registered the /command menu."));
    } catch (e) {
      console.log(chalk.yellow(`command-menu registration skipped: ${(e as Error).message}`));
    }

    // Topic summary — show existing links so re-running setup is informative
    const topics = loadState(defaultStateRoot()).topics;
    const topicEntries = Object.entries(topics);
    if (topicEntries.length > 0) {
      const summary = topicEntries
        .map(([key, id]) => {
          const project = key.slice(0, key.indexOf("::"));
          return `${project}→${id}`;
        })
        .join(", ");
      console.log(chalk.dim(`Existing topics: ${summary} (already created — not recreated)`));
    } else {
      console.log(chalk.dim("No project topics yet — they're created on first delivery or via: squadrant telegram link <project>"));
    }

    runTelegramPostSetup({});
    console.log();
    console.log(`Next: ${chalk.cyan("squadrant telegram link <project>")}`);
  });

telegramCommand
  .command("register-commands")
  .description("Register (or re-register) the bot's / command menu with Telegram")
  .action(async () => {
    const cfg = loadConfig().telegram;
    if (!cfg) {
      console.error(chalk.red("telegram config absent — run: squadrant telegram setup"));
      process.exit(1);
    }
    const token = cfg.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error(chalk.red("no botToken in config and TELEGRAM_BOT_TOKEN is unset"));
      process.exit(1);
    }
    const client = createTelegramClient({ token });
    await runRegisterCommands({ client });
    console.log(chalk.green(`registered ${BOT_COMMANDS.length} bot commands`));
  });

telegramCommand
  .command("notify")
  .argument("[project]", "project to toggle")
  .argument("[state]", "on | off | crew | cap")
  .argument("[value]", "tier for crew (all|alert_only|done_only|none) or on|off for cap")
  .option("--status", "list notification state for all projects")
  .description("Live on|off (state), or crew <tier> / cap <on|off> preference (per-project config)")
  .action(async (project: string | undefined, state: string | undefined, value: string | undefined, opts: { status?: boolean }) => {
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

    const tgCfg = loadConfig().telegram;
    const globalNotify = tgCfg?.notify;
    const token = tgCfg?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;

    // Deliberate preference (per-project config file): crew tier / cap.
    if (state === "crew" || state === "cap") {
      if (value === undefined) {
        console.error(chalk.red(`usage: squadrant telegram notify <project> ${state} <value>`));
        process.exit(1);
      }
      const resolved = resolveNotify(globalNotify, loadProjectOverride(project));
      const before: NotifyConfig = { ...resolved, active: isNotifyActive(stateRoot, project) };
      const res = runTelegramNotifyPref({ project, dimension: state, value });
      if (!res.ok) {
        console.error(chalk.red(res.message));
        process.exit(1);
      }
      console.log(chalk.green(`${project} ${state} = ${value}`));
      const after: NotifyConfig = state === "crew"
        ? { ...before, crew: value as CrewTier }
        : { ...before, cap: value === "on" };
      if (tgCfg && token) {
        const client = createTelegramClient({ token });
        const sent = await runNotifyConfirmation({ project, before, after, cfg: tgCfg, client, stateRoot });
        if (sent) console.log(chalk.dim(`→ notified ${project} topic`));
      }
      return;
    }

    // Live session toggle (telegram-state.json), unchanged.
    if (state !== "on" && state !== "off") {
      console.error(chalk.red("usage: squadrant telegram notify <project> <on|off|crew <tier>|cap <on|off>>"));
      process.exit(1);
    }
    const resolved = resolveNotify(globalNotify, loadProjectOverride(project));
    const before: NotifyConfig = { ...resolved, active: isNotifyActive(stateRoot, project) };
    const after: NotifyConfig = { ...before, active: state === "on" };
    runTelegramNotifySet({ project, active: state === "on", stateRoot });
    console.log(chalk.green(`${project} notifications ${state === "on" ? "ON" : "OFF"}`));
    if (tgCfg && token) {
      const client = createTelegramClient({ token });
      const sent = await runNotifyConfirmation({ project, before, after, cfg: tgCfg, client, stateRoot });
      if (sent) console.log(chalk.dim(`→ notified ${project} topic`));
    }
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

    if (!capAllowed(project, cfg.notify)) {
      console.log(chalk.dim(`${project}: captain messages muted (cap=off) — not sent`));
      return;
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
