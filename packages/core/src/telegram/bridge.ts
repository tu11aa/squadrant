// Daemon-internal Telegram subsystem (modeled on CmuxEventsBridge). Owns one
// outbound hook (pushLifecycle) and one inbound getUpdates long-poll. Opt-in and
// crash-contained: no send/poll error may escape into the daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { ControlEvent, CrewTier, NotifyConfig, TelegramConfig } from "@squadrant/shared";
import { resolveNotify, loadProjectOverride, saveProjectOverride, loadConfig } from "@squadrant/shared";
import { TelegramApiError, type TelegramClient } from "./client.js";
import { isAuthorized, isControlEnabled } from "./auth.js";
import { parseCommand, stripBotMention } from "./commands.js";
import type { EnsureResult } from "./ensure-captain.js";
import type { InboundLifecycle } from "./inbound-lifecycle.js";
import type { DeliveryOutcome } from "../control-channel.js";

/** Stage-2 ACK text (#838 Option B). Deliberately ONE short line: stage 1 is the
 *  attached reaction, so the operator sees both ends of the hop without this
 *  path becoming the phone flood the original quiet-by-design rule avoided. */
export const CAPTAIN_RECEIVED_ACK = "✅ captain received";

/**
 * What to tell the phone about an inbound message's fate.
 *
 * Deliberately quiet on the happy path: a receipt for every message would flood
 * the operator's phone, and the pre-slice behaviour was silence. Only the three
 * states the operator can ACT on get a message.
 */
export function formatInboundReceipt(project: string, outcome?: DeliveryOutcome): string | undefined {
  if (!outcome) return undefined;
  switch (outcome.status) {
    case "held":
      return `⏸ Your message to ${project} is HELD awaiting approval in that session: ${outcome.reason}`;
    case "gone":
      return `⚠ ${project}'s captain is not reachable — your message went to its mailbox instead`;
    case "accepted":
      return outcome.confirmed === false
        ? `… Your message reached ${project}'s session but no turn was observed yet`
        : undefined;
    case "queued":
    case "unsupported":
      return undefined;
  }
}

import { formatInbound, formatLifecycle, formatUsageLine, topicName } from "./format.js";
import type { ProjectUsage } from "../router/usage-ledger.js";
import { buildSpawnPrompt, effortPanel, notifyPanel, parseCallback, parseSpawnPrompt, projectPicker, spawnPicker, type PickAction } from "./panels.js";
import { findProjectByThread, loadState, saveState, setLastUserId, setNotify, setTopic, topicKey } from "./state.js";
import { tierIncludes } from "./tiers.js";

/** A Telegram callback_query (button tap). Narrowed to the fields the bridge uses. */
interface CallbackQuery {
  id: string;
  from?: { id: number };
  message?: { chat: { id: number }; message_id: number; message_thread_id?: number };
  data?: string;
}

/** Read-only poll-loop health (B3 — dashboard visibility). A silently-dying
 *  getUpdates loop otherwise looks identical to a healthy quiet one from outside. */
export interface TelegramBridgeHealth {
  polling: boolean;
  lastSuccessfulPollAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface TelegramBridge {
  start(): void;
  stop(): void;
  /** Outbound, best-effort: a Telegram failure is swallowed (logged), never thrown. */
  pushLifecycle(project: string, ev: ControlEvent): void;
  /** Outbound, best-effort, out-of-band, fault-class alert — for system faults
   *  (e.g. #579/#484's DELIVERY STUCK), not routine crew notifications. Bypasses
   *  BOTH the crew-tier filter AND per-project mute: mute is a user's choice to
   *  silence routine notification *noise* (crew progress/done/blocked), a
   *  choice about volume. It was never a choice to hide "your instructions
   *  can't reach the captain" — an operational fault, not noise. A muted
   *  project with a stuck delivery must still alert, or muting silently
   *  reintroduces the exact silent-stall bug this alert exists to prevent.
   *  Never touches the mailbox/pane path (so it can't itself get stuck). */
  pushRaw(project: string, text: string): void;
  health(): TelegramBridgeHealth;
}

export interface TelegramBridgeOptions {
  cfg: TelegramConfig;
  stateRoot: string;
  /** Root for per-project override files. Defaults to ~/.config/squadrant. */
  configRoot?: string;
  client: TelegramClient;
  appendCaptainMessage: (a: { stateRoot: string; project: string; text: string; source: "telegram" | "daemon" | "cli" }) => Promise<void | number>;
  log: (msg: string) => void;
  // ── Control surfaces (#402/#403/#321) — all optional. When undefined the bridge
  // keeps exact v1 behavior (queue-only project topics, General topic dropped).
  /** Boot-if-down before delivering to a project topic. Injected by the daemon host. */
  ensureCaptainAlive?: (project: string) => Promise<EnsureResult>;
  /** Execute a curated squadrant CLI argv and return capped output. */
  runCommand?: (argv: string[]) => Promise<string>;
  /** Post a reply to the General topic (threadId undefined) or a project topic.
   *  The optional replyMarkup attaches an inline-button panel (tap-first commands). */
  sendReply?: (threadId: number | undefined, text: string, replyMarkup?: unknown) => Promise<void>;
  /** #667 slice 4: native channel delivery. Injected by the daemon host. */
  deliverInbound?: (project: string, text: string) => Promise<{ handled: boolean; outcome?: import("../control-channel.js").DeliveryOutcome }>;
  /** U5: routed usage/cost for a project. Appended to terminal (done/failed)
   *  crew events. Injected by the daemon host; absent ⇒ unchanged output. */
  usageFor?: (project: string) => ProjectUsage | undefined;
  /** #838/#839: typing keep-alive + reply signal + watchdog. Injected by the
   *  daemon host. start()/stop() ride the bridge's own lifecycle so its boot pass
   *  (resume-or-clear persisted state) still runs while another daemon holds the
   *  poll lock — a stranded pending entry must never keep a phantom typing alive.
   *  Absent ⇒ the bridge skips the stage-2 typing handoff (text + reaction still
   *  fire). */
  lifecycle?: InboundLifecycle;
}

// Bot API long-poll window. The loop also sleeps cfg.pollMs between iterations so
// a fast-returning poll can't busy-loop.
const LONG_POLL_SEC = 50;

// #830 single-consumer guard: getUpdates is single-consumer per bot token, so a
// stray second poller makes both sides 409-storm. The lock lives in the OS temp
// dir keyed by a token hash, so it works across processes (dev harnesses,
// manually-started daemons) — not just within one daemon.
const POLL_LOCK_STALE_MS = 2 * 60_000;
// Consecutive 409s before the poll is declared terminal. The storm in #830 was
// ~11.6k log lines from looping forever; a couple of retries absorb a transient
// race, then we stop and log once.
const CONFLICT_409_TERMINAL_AFTER = 3;

/** Exclusive lockfile path for a bot token's single getUpdates consumer. */
export function telegramPollLockPath(token: string): string {
  const hash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `squadrant-telegram-poll-${hash}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM ⇒ the pid exists but belongs to another user (still alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is held iff its owner pid is alive, or (pid unreadable) it is younger
 *  than the stale window. Missing/unreadable ⇒ free. */
function lockIsHeld(file: string): boolean {
  let pid: number | undefined;
  let ageMs: number;
  try {
    const parsed = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    pid = Number.isFinite(parsed) ? parsed : undefined;
    ageMs = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return false;
  }
  if (pid !== undefined) return pidAlive(pid);
  return ageMs < POLL_LOCK_STALE_MS;
}

/** Take the poll lock atomically (O_EXCL). Returns a release fn, or null when a
 *  live consumer already holds it. A stale lock is reclaimed at most once. */
function acquirePollLock(token: string): (() => void) | null {
  const file = telegramPollLockPath(token);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
      if (attempt === 0 && !lockIsHeld(file)) {
        try { fs.unlinkSync(file); } catch { /* raced with another reclaimer */ }
        continue;
      }
      return null;
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CREW_TIERS = ["all", "alert_only", "done_only", "none"];

// Channel commands that may run in ANY topic (#cmds-anytopic). mute/unmute/notify
// are intentionally absent: in a project topic they carry topic-scoped semantics
// (handled before delegating). Matched against the slash-stripped first token.
const RECOGNIZED_CHANNEL_COMMANDS = new Set(["status", "projects", "crews", "launch", "effort", "spawn"]);

/** Parse a `/notify crew <tier>` or `/notify cap <on|off>` preference command.
 *  Returns null for anything else (ordinary message or malformed). */
export function parseNotifyPref(text: string): { dimension: "crew" | "cap"; value: string } | null {
  const parts = text.trim().split(/\s+/);
  if (stripBotMention(parts[0] ?? "").toLowerCase() !== "/notify") return null;
  const dimension = parts[1]?.toLowerCase();
  if ((dimension === "crew" || dimension === "cap") && parts[2]) return { dimension, value: parts[2].toLowerCase() };
  return null;
}

/** True for a bare `/spawn` (no project/task args) — the guided-picker trigger.
 *  Strips the `@botname` suffix Telegram appends to menu-tapped commands. */
export function isBareSpawn(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const tokens = trimmed.slice(1).split(/\s+/).filter((t) => t.length > 0);
  return stripBotMention(tokens[0] ?? "").toLowerCase() === "spawn" && tokens.length === 1;
}

/** Recognize the two in-topic notification toggles. Returns the desired active
 *  state, or null if the text is an ordinary message. */
export function notifyToggle(text: string): boolean | null {
  const first = stripBotMention(text.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (first === "/unmute") return true;
  if (first === "/mute") return false;
  return null;
}

export function createTelegramBridge(opts: TelegramBridgeOptions): TelegramBridge {
  const { cfg, stateRoot, client, appendCaptainMessage, log, ensureCaptainAlive, runCommand, sendReply } = opts;
  const lifecycle = opts.lifecycle;
  const configRoot = opts.configRoot ?? path.join(os.homedir(), ".config", "squadrant");
  const pollMs = cfg.pollMs ?? 1000;
  // Same token resolution as the daemon host: a config token, else the env fallback.
  const lockToken = cfg.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  let releasePollLock: (() => void) | null = null;
  let pollAbort: AbortController | null = null;
  let running = false;
  let conflictCount = 0;
  let lastSuccessfulPollAt: number | null = null;
  let lastError: string | null = null;
  let lastErrorAt: number | null = null;

  function persistOffset(next: number): void {
    const s = loadState(stateRoot);
    s.offset = next;
    saveState(stateRoot, s);
  }

  // Resolve (or lazily create) a project's topic and send raw text into it.
  async function sendToTopic(project: string, text: string): Promise<void> {
    let threadId = loadState(stateRoot).topics[topicKey(project)];
    if (threadId === undefined) {
      threadId = await client.createForumTopic(cfg.supergroupId, topicName(project));
      setTopic(stateRoot, project, threadId);
    }
    await client.sendMessage(cfg.supergroupId, threadId, text);
  }

  // Outbound: resolve active (live state wins over config default) + crew-tier
  // filter, then resolve (or lazily create) the project's topic and send.
  async function deliverOutbound(project: string, ev: ControlEvent): Promise<void> {
    const resolved = resolveNotify(cfg.notify, loadProjectOverride(project, configRoot));
    const live = loadState(stateRoot).notify[project]; // boolean | undefined
    const active = live ?? resolved.active;
    if (!active) return;                                // muted → no topic create, no send
    if (!tierIncludes(resolved.crew, ev.type)) return; // tier filter
    let text = formatLifecycle(project, ev);
    if ((ev.type === "task.done" || ev.type === "task.failed") && opts.usageFor) {
      const usage = opts.usageFor(project);
      if (usage && usage.requests > 0) text += `\n${formatUsageLine(usage)}`;
    }
    await sendToTopic(project, text);
  }

  // Outbound, out-of-band, fault-class: bypasses BOTH the crew-tier filter AND
  // mute (see the pushRaw docstring for why mute must not silence a fault).
  async function deliverRawOutbound(project: string, text: string): Promise<void> {
    await sendToTopic(project, text);
  }

  // Live notify state for a project: resolved config (built-in→global→override)
  // with the live `active` overlay (state wins over config default).
  function resolveLiveNotify(project: string): NotifyConfig {
    const resolved = resolveNotify(cfg.notify, loadProjectOverride(project, configRoot));
    const live = loadState(stateRoot).notify[project]; // boolean | undefined
    return { ...resolved, active: live ?? resolved.active };
  }

  // Re-render a panel's keyboard, swallowing the Bot API "message is not
  // modified" error that fires when the new keyboard equals the old one.
  async function editMarkup(chatId: number, messageId: number, markup: unknown): Promise<void> {
    try {
      await client.editMessageReplyMarkup(chatId, messageId, markup);
    } catch (e) {
      const msg = (e as Error).message;
      if (!/not modified/i.test(msg)) throw e;
    }
  }

  // callback_query (inline-button tap). ALWAYS answerCallbackQuery on every path
  // (else the spinner hangs ~15s). Gate on the TAPPER's user-id, never the panel.
  // Render state fresh. Never throw into the poll loop.
  async function handleCallback(cq: CallbackQuery): Promise<void> {
    try {
      if (!cq.data || !cq.message) {
        await client.answerCallbackQuery(cq.id);
        return;
      }
      if (!isControlEnabled(cfg) || !isAuthorized(cq.from?.id, cfg)) {
        await client.answerCallbackQuery(cq.id, "⛔ not authorized");
        return;
      }
      const action = parseCallback(cq.data);
      if (!action) {
        await client.answerCallbackQuery(cq.id);
        return;
      }
      const chatId = cq.message.chat.id;
      const messageId = cq.message.message_id;

      if (action.t === "notify") {
        const resolved = findProjectByThread(stateRoot, cq.message.message_thread_id ?? -1);
        if (!resolved) {
          await client.answerCallbackQuery(cq.id, "no project for this topic");
          return;
        }
        const project = resolved.project;
        if (action.dim === "active") {
          setNotify(stateRoot, project, action.val === "on");
        } else if (action.dim === "cap") {
          saveProjectOverride(project, { telegram: { notify: { cap: action.val === "on" } } }, configRoot);
        } else {
          saveProjectOverride(project, { telegram: { notify: { crew: action.val as CrewTier } } }, configRoot);
        }
        await client.answerCallbackQuery(cq.id, `✅ ${action.dim} = ${action.val}`);
        await editMarkup(chatId, messageId, notifyPanel(resolveLiveNotify(project)));
        return;
      }

      if (action.t === "effort") {
        if (runCommand) await runCommand(["effort", action.mode]);
        await client.answerCallbackQuery(cq.id, `✅ effort = ${action.mode}`);
        await editMarkup(chatId, messageId, effortPanel(action.mode as "max" | "balance" | "low"));
        return;
      }

      if (action.t === "spawn") {
        // Send a ForceReply prompt carrying the project; the reply is routed to
        // `crew spawn` statelessly via parseSpawnPrompt (no pending-state map).
        await reply(cq.message.message_thread_id, buildSpawnPrompt(action.project), { force_reply: true, selective: true });
        await client.answerCallbackQuery(cq.id);
        return;
      }

      // action.t === "pick" — General-topic project actions.
      const { action: act, project } = action;
      if (act === "cr") {
        const out = runCommand ? await runCommand(["crew", "list", project]) : "(command runner unavailable)";
        await client.answerCallbackQuery(cq.id);
        await reply(undefined, out);
      } else if (act === "lc") {
        if (runCommand) await runCommand(["launch", project]);
        await client.answerCallbackQuery(cq.id, `launching ${project}`);
      } else if (act === "mu") {
        setNotify(stateRoot, project, false);
        await client.answerCallbackQuery(cq.id, `🔕 muted ${project}`);
      } else {
        setNotify(stateRoot, project, true);
        await client.answerCallbackQuery(cq.id, `🔔 unmuted ${project}`);
      }
    } catch (e) {
      log(`telegram callback failed data=${cq.data}: ${(e as Error).message}`);
      try {
        await client.answerCallbackQuery(cq.id, "⚠️ failed");
      } catch {
        /* answer failed too — already logged; never throw into the poll loop */
      }
    }
  }

  // Reply best-effort: a send failure must never escape into the poll loop.
  async function reply(threadId: number | undefined, text: string, replyMarkup?: unknown): Promise<void> {
    if (!sendReply) return;
    try {
      // Keep the 2-arg call shape when there's no panel (markup undefined).
      if (replyMarkup !== undefined) await sendReply(threadId, text, replyMarkup);
      else await sendReply(threadId, text);
    } catch (e) {
      log(`telegram reply failed: ${(e as Error).message}`);
    }
  }

  /** Current global effort dial (falls back to today's "balance"). */
  function currentEffort(): "max" | "balance" | "low" {
    try {
      return loadConfig(path.join(configRoot, "config.json")).defaults.effort ?? "balance";
    } catch {
      return "balance";
    }
  }

  /** Registered project names for the General-topic pickers. */
  function projectNames(): string[] {
    try {
      return Object.keys(loadConfig(path.join(configRoot, "config.json")).projects);
    } catch {
      return [];
    }
  }

  /** Guided /spawn: reply the project picker (works in General or a project topic). */
  async function replySpawnPicker(threadId: number | undefined): Promise<void> {
    const projects = projectNames();
    if (projects.length === 0) {
      await reply(threadId, "no projects registered");
      return;
    }
    await reply(threadId, "Pick a project to spawn a crew on:", spawnPicker(projects));
  }

  // Curated command channel (#402), shared by the General topic (threadId
  // undefined) and project topics (#cmds-anytopic). Fail-closed — a command runs
  // ONLY when remoteControl is on AND the sender is allowlisted. Tap-first: a
  // parameterized command with NO argument replies a button panel instead of a
  // usage error; typed forms (with an arg) fall through to run. Replies land in
  // the given thread; failures are caught here so they can't escape the poll loop.
  async function runChannelCommand(text: string, fromId: number | undefined, threadId: number | undefined): Promise<void> {
    if (!isControlEnabled(cfg) || !isAuthorized(fromId, cfg)) {
      await reply(threadId, "⛔ not authorized");
      return;
    }
    const tokens = text.trim().slice(1).split(/\s+/).filter((t) => t.length > 0);
    const name = stripBotMention(tokens[0] ?? "").toLowerCase();
    const noArg = tokens.length === 1;
    if (noArg && name === "effort") {
      await reply(threadId, "Effort mode:", effortPanel(currentEffort()));
      return;
    }
    if (noArg && name === "spawn") {
      await replySpawnPicker(threadId);
      return;
    }
    const PICKERS: Record<string, PickAction> = { crews: "cr", launch: "lc", mute: "mu", unmute: "um" };
    if (noArg && name in PICKERS) {
      const projects = projectNames();
      if (projects.length === 0) {
        await reply(threadId, "no projects registered");
        return;
      }
      await reply(threadId, `Pick a project:`, projectPicker(PICKERS[name], projects));
      return;
    }
    const parsed = parseCommand(text);
    if (parsed.kind !== "ok") {
      await reply(threadId, parsed.message);
      return;
    }
    try {
      const out = runCommand ? await runCommand(parsed.argv) : "(command runner unavailable)";
      await reply(threadId, out);
    } catch (e) {
      await reply(threadId, `⚠️ command failed: ${(e as Error).message}`);
      log(`telegram command failed argv=${JSON.stringify(parsed.argv)}: ${(e as Error).message}`);
    }
  }

  // General topic (no thread id): freeform text gets a /help hint (never silently
  // dropped); slash commands run through the shared channel-command dispatcher.
  async function handleGeneral(text: string, fromId: number | undefined): Promise<void> {
    if (!text.startsWith("/")) {
      await reply(undefined, "Send /help for commands.");
      return;
    }
    await runChannelCommand(text, fromId, undefined);
  }

  // Project topic: the v1 captain.message flow + Gap-1 auto-launch (#403). When
  // control is off OR the sender isn't allowlisted, behaves exactly as v1
  // (append only). The append throws on delivery-infra failure so the caller can
  // decline to advance the offset (at-least-once); auto-launch failures are
  // contained and never block the append.
  async function handleProjectTopic(text: string, threadId: number, fromId: number | undefined, messageId?: number): Promise<void> {
    const resolved = findProjectByThread(stateRoot, threadId);
    if (!resolved) return; // no project bound to this topic

    if (isBareSpawn(text)) {
      // Guided /spawn — picker, never appended. Fail-closed like the toggles.
      if (!isControlEnabled(cfg) || !isAuthorized(fromId, cfg)) {
        await reply(threadId, "⛔ not authorized");
        return;
      }
      await replySpawnPicker(threadId);
      return;
    }

    const toggle = notifyToggle(text);
    if (toggle !== null) {
      // Explicit toggle command — fail-closed, never appended as a captain message.
      if (!isControlEnabled(cfg) || !isAuthorized(fromId, cfg)) {
        await reply(threadId, "⛔ not authorized");
        return;
      }
      setNotify(stateRoot, resolved.project, toggle);
      await reply(threadId, toggle ? `🔔 ${resolved.project} notifications ON` : `🔕 ${resolved.project} notifications OFF`);
      return;
    }

    // Any /notify attempt (including an incomplete one like a bare `/notify`) is
    // handled here and NEVER appended as a captain message. The first token is
    // matched after stripping a `@botname` suffix Telegram adds in groups.
    if (stripBotMention(text.trim().split(/\s+/)[0] ?? "").toLowerCase() === "/notify") {
      // Fail-closed: only an allowlisted sender under remoteControl may proceed.
      if (!isControlEnabled(cfg) || !isAuthorized(fromId, cfg)) {
        await reply(threadId, "⛔ not authorized");
        return;
      }
      const pref = parseNotifyPref(text);
      if (pref === null) {
        // Incomplete (bare `/notify`, or a dimension with no value) → tap-first panel.
        // Typed forms (`/notify cap on`) still parse below for power users.
        await reply(threadId, `🔔 ${resolved.project} notifications`, notifyPanel(resolveLiveNotify(resolved.project)));
        return;
      }
      // Deliberate preference change — writes the per-project config file (not live state).
      if (pref.dimension === "crew") {
        if (!CREW_TIERS.includes(pref.value)) {
          await reply(threadId, "crew must be all|alert_only|done_only|none");
          return;
        }
        saveProjectOverride(resolved.project, { telegram: { notify: { crew: pref.value as never } } }, configRoot);
      } else {
        if (pref.value !== "on" && pref.value !== "off") {
          await reply(threadId, "cap must be on|off");
          return;
        }
        saveProjectOverride(resolved.project, { telegram: { notify: { cap: pref.value === "on" } } }, configRoot);
      }
      await reply(threadId, `✅ ${pref.dimension} = ${pref.value}`);
      return;
    }

    // Recognized channel commands run in this topic too (#cmds-anytopic), with the
    // reply landing here instead of falling through to a captain message. mute/
    // unmute/notify are handled above (topic-scoped) and excluded from the set.
    const firstTok = stripBotMention(text.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (firstTok.startsWith("/") && RECOGNIZED_CHANNEL_COMMANDS.has(firstTok.slice(1))) {
      await runChannelCommand(text, fromId, threadId);
      return;
    }

    // #838 stage 1 — daemon received it. A reaction rides ON the operator's own
    // message (no new message ⇒ zero extra noise), and is best-effort: a client
    // without setMessageReaction, or a Bot API that rejects it, must never stop
    // the delivery below.
    if (messageId !== undefined) {
      void Promise.resolve(client.setMessageReaction?.(cfg.supergroupId, messageId, "👍")).catch((e) =>
        log(`telegram stage-1 reaction failed project=${resolved.project}: ${(e as Error).message}`),
      );
    }
    setNotify(stateRoot, resolved.project, true); // engagement → auto-unmute (sticky)
    if (ensureCaptainAlive && isControlEnabled(cfg) && isAuthorized(fromId, cfg)) {
      try {
        const r = await ensureCaptainAlive(resolved.project);
        // The ensure() result IS the delivery signal — "live captain reachable",
        // not "message read" (no cap-side ack protocol). Surfacing it means a
        // false-positive isAlive (#517) fails loud in Telegram instead of silently
        // stranding the message in the mailbox.
        if (r === "timeout") {
          await reply(threadId, `❌ couldn't reach ${resolved.project} captain — saved to mailbox, will deliver when you open the workspace.`);
        } else if (r === "unknown") {
          // #834: a transient/unobservable health state is NOT evidence the
          // captain is dead. Stay quiet — the mailbox fallback below delivers.
        } else {
          await reply(threadId, `📨 delivered to ${resolved.project} captain`);
        }
      } catch (e) {
        log(`telegram auto-launch failed project=${resolved.project}: ${(e as Error).message}`);
      }
    }
    
    let handled = false;
    let outcome: DeliveryOutcome | undefined;
    if (opts.deliverInbound) {
      const res = await opts.deliverInbound(resolved.project, formatInbound(text));
      handled = res.handled;
      outcome = res.outcome;
    }
    
    if (!handled) {
      // The channel declined (gone / unsupported / off). This append IS the pane
      // fallback and its success is the FINAL verdict — the #332 delivery loop
      // drains it into the captain. A pre-fallback `gone` outcome must never be
      // rendered as terminal "not reachable", or the operator is told a message
      // that is queued (and will deliver) failed (#834).
      await appendCaptainMessage({ stateRoot, project: resolved.project, text: formatInbound(text), source: "telegram" });
      outcome = undefined;
    }
    
    const receipt = formatInboundReceipt(resolved.project, outcome);
    if (receipt && sendReply) {
      await sendReply(threadId, receipt).catch((e) =>
        log(`telegram receipt failed project=${resolved.project}: ${(e as Error).message}`)
      );
    }

    // #838 stage 2 — "captain received" must mean the message is genuinely with
    // the captain. A `held` outcome is the one state where it is NOT: the message
    // is sitting behind an open modal (the #546/#486 case), and the HELD receipt
    // above already told the operator so. Acking it here would contradict that
    // line AND arm a typing/watchdog for a message nobody has read yet — the
    // watchdog would then warn about a captain that was never given the turn.
    // Everything else (accepted / queued / gone→mailbox / no channel) leaves the
    // message somewhere the captain will actually pick up.
    if (outcome?.status === "held") return;

    // One short text — the failure receipts above are unchanged and additive —
    // then hand the typing keep-alive + watchdog to the lifecycle. `begin()` IS
    // the shared signal: typing stops and the watchdog disarms when the captain
    // replies (clearPending) — there is no second detector.
    await reply(threadId, CAPTAIN_RECEIVED_ACK);
    lifecycle?.begin(resolved.project, threadId);
  }

  // Inbound: classify by thread id. General topic → command channel; project
  // topic → captain.message (+ auto-launch). Throws only on append failure.
  async function handleUpdate(u: { message?: { chat: { id: number }; message_thread_id?: number; message_id?: number; text?: string; from?: { id: number }; reply_to_message?: { text?: string } }; callback_query?: CallbackQuery }): Promise<void> {
    if (u.callback_query) {
      await handleCallback(u.callback_query);
      return;
    }
    const m = u.message;
    if (!m || m.text === undefined) return;
    if (!cfg.chats.includes(m.chat.id)) return; // not an allowlisted chat (coarse filter)
    // Passively capture the sender's user-id for setup auto-population (#user-id).
    if (m.from?.id !== undefined && loadState(stateRoot).lastUserId !== m.from.id) {
      setLastUserId(stateRoot, m.from.id);
    }
    // A reply to a guided-/spawn ForceReply prompt → `crew spawn`, gated, never
    // appended. Runs before the thread-id branch because a reply can land in
    // General (no thread id) OR a project topic.
    const spawnProject = parseSpawnPrompt(m.reply_to_message?.text);
    if (spawnProject) {
      const threadId = m.message_thread_id;
      if (!isControlEnabled(cfg) || !isAuthorized(m.from?.id, cfg)) {
        await reply(threadId, "⛔ not authorized");
        return;
      }
      const task = m.text.trim();
      if (!task) {
        await reply(threadId, "spawn cancelled — empty task");
        return;
      }
      if (runCommand) await runCommand(["crew", "spawn", spawnProject, task]);
      await reply(threadId, `🆕 spawning a crew on ${spawnProject}…`);
      return; // NOT appended as a captain message
    }
    if (m.message_thread_id === undefined) {
      await handleGeneral(m.text, m.from?.id);
      return;
    }
    await handleProjectTopic(m.text, m.message_thread_id, m.from?.id, m.message_id);
  }

  async function pollLoop(): Promise<void> {
    while (running) {
      const ac = new AbortController();
      pollAbort = ac;
      try {
        const offset = loadState(stateRoot).offset;
        const updates = await client.getUpdates(offset, LONG_POLL_SEC, ac.signal);
        conflictCount = 0;
        for (const u of updates) {
          await handleUpdate(u);
          persistOffset(u.update_id + 1);
        }
        lastSuccessfulPollAt = Date.now();
      } catch (e) {
        if (ac.signal.aborted) break; // stop() cancelled an in-flight long-poll — not an error
        const msg = (e as Error).message;
        lastError = msg;
        lastErrorAt = Date.now();
        // #830: repeated 409 means a second consumer holds the token's poll slot.
        // Retrying forever is the 11.6k-line storm; log once and stop.
        if (e instanceof TelegramApiError && e.code === 409) {
          conflictCount += 1;
          if (conflictCount >= CONFLICT_409_TERMINAL_AFTER) {
            log(`telegram inbound poll stopped: repeated 409 conflict (another getUpdates consumer holds this token) — ${msg}`);
            break;
          }
        } else {
          log(`telegram inbound poll failed: ${msg}`);
        }
      } finally {
        pollAbort = null;
      }
      if (running) await sleep(pollMs);
    }
    running = false;
    releasePollLock?.();
    releasePollLock = null;
  }

  return {
    start() {
      if (running) return;
      if (lockToken) {
        releasePollLock = acquirePollLock(lockToken);
        if (!releasePollLock) {
          log("telegram inbound poll disabled: another consumer already polls this bot token (single-consumer guard, #830)");
          return;
        }
      }
      running = true;
      // #838 §4 restart safety: the lifecycle's boot pass (resume or clear a
      // persisted pending entry) is bound to the daemon, not to the poll loop —
      // it must run even while another daemon holds the poll lock, or a stranded
      // pending entry could keep a phantom typing alive forever.
      try { lifecycle?.start(); }
      catch (e) { log(`telegram lifecycle start failed: ${(e as Error).message}`); }
      void pollLoop();
    },
    stop() {
      running = false;
      try { lifecycle?.stop(); }
      catch (e) { log(`telegram lifecycle stop failed: ${(e as Error).message}`); }
      pollAbort?.abort();
      releasePollLock?.();
      releasePollLock = null;
    },
    pushLifecycle(project, ev) {
      // Fire-and-forget; all errors swallowed so outbound can never throw into
      // the daemon's notify path.
      void deliverOutbound(project, ev).catch((e) => {
        log(`telegram outbound failed project=${project}: ${(e as Error).message}`);
      });
    },
    pushRaw(project, text) {
      void deliverRawOutbound(project, text).catch((e) => {
        log(`telegram raw push failed project=${project}: ${(e as Error).message}`);
      });
    },
    health() {
      return { polling: running, lastSuccessfulPollAt, lastError, lastErrorAt };
    },
  };
}
