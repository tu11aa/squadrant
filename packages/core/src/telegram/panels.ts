// Pure inline-keyboard builders + callback_data codec for tap-first Telegram
// commands. No I/O — unit-tested independent of the bridge. callback_data is
// prefix-routed and kept ≤64 bytes (Bot API limit).
import type { NotifyConfig, CrewTier } from "@squadrant/shared";

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export type PickAction = "cr" | "lc" | "mu" | "um";

export type ParsedCallback =
  | { t: "notify"; dim: "cap" | "crew" | "active"; val: string }
  | { t: "effort"; mode: string }
  | { t: "pick"; action: PickAction; project: string }
  | { t: "spawn"; project: string };

/** Prefix the label with a bullet when it represents the current state. */
const mark = (on: boolean, label: string): string => (on ? `• ${label}` : label);

// Curated crew-tier subset shown as a pick-one row (done_only is reachable via
// the typed `/notify crew done_only` form for power users).
const TIERS: CrewTier[] = ["none", "alert_only", "all"];

export function notifyPanel(s: NotifyConfig): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: `Captain: ${s.cap ? "ON" : "OFF"}`, callback_data: `n:cap:${s.cap ? "off" : "on"}` }],
      TIERS.map((t) => ({ text: mark(s.crew === t, `crew:${t}`), callback_data: `n:crew:${t}` })),
      [{ text: s.active ? "🔕 Mute topic" : "🔔 Unmute", callback_data: `n:active:${s.active ? "off" : "on"}` }],
    ],
  };
}

export function effortPanel(current: "max" | "balance" | "low"): InlineKeyboard {
  const modes = ["max", "balance", "low"] as const;
  return {
    inline_keyboard: [modes.map((m) => ({ text: mark(current === m, m), callback_data: `e:${m}` }))],
  };
}

export function projectPicker(action: PickAction, projects: string[]): InlineKeyboard {
  return { inline_keyboard: projects.map((p) => [{ text: p, callback_data: `${action}:${p}` }]) };
}

// Guided /spawn (slice 2). The picker emits `sp:<project>`; tapping one sends a
// ForceReply prompt whose text encodes the project behind SPAWN_PROMPT_PREFIX, so
// the reply can be routed to `crew spawn` statelessly (no pending-spawn map).
export const SPAWN_PROMPT_PREFIX = "🆕 Reply with the task for a crew on: ";

export function buildSpawnPrompt(project: string): string {
  return `${SPAWN_PROMPT_PREFIX}${project}`;
}

export function parseSpawnPrompt(text: string | undefined): string | null {
  if (!text || !text.startsWith(SPAWN_PROMPT_PREFIX)) return null;
  const project = text.slice(SPAWN_PROMPT_PREFIX.length).trim();
  return project.length > 0 ? project : null;
}

export function spawnPicker(projects: string[]): InlineKeyboard {
  return { inline_keyboard: projects.map((p) => [{ text: p, callback_data: `sp:${p}` }]) };
}

const PICK_ACTIONS: PickAction[] = ["cr", "lc", "mu", "um"];

export function parseCallback(data: string): ParsedCallback | null {
  const parts = data.split(":");
  if (parts[0] === "n" && (parts[1] === "cap" || parts[1] === "crew" || parts[1] === "active") && parts[2]) {
    return { t: "notify", dim: parts[1], val: parts[2] };
  }
  if (parts[0] === "e" && parts[1]) return { t: "effort", mode: parts[1] };
  if (PICK_ACTIONS.includes(parts[0] as PickAction) && parts[1]) {
    return { t: "pick", action: parts[0] as PickAction, project: parts.slice(1).join(":") };
  }
  if (parts[0] === "sp" && parts[1]) return { t: "spawn", project: parts.slice(1).join(":") };
  return null;
}
