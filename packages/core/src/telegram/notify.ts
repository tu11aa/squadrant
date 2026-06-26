import { resolveNotify, loadProjectOverride, saveProjectOverride, isQuieter } from "@squadrant/shared";
import type { SquadrantConfig, TelegramConfig, NotifyConfig } from "@squadrant/shared";
import { loadState, setNotify, topicKey, setTopic } from "./state.js";
import { topicName } from "./format.js";
import type { TelegramClient } from "./client.js";

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

/** Resolved `cap` for a project — whether explicit captain messages may be sent.
 *  `cap=false` is the deliberate "don't let the captain DM me" switch; live
 *  idle-mute (active) is intentionally NOT consulted here (an explicit push
 *  shouldn't be dropped just because the topic is idle-muted). */
export function capAllowed(project: string, globalNotify: TelegramConfig["notify"], root?: string): boolean {
  return resolveNotify(globalNotify, loadProjectOverride(project, root)).cap;
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
