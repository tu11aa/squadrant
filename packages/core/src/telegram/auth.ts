// Pure auth predicates for the Telegram CONTROL surfaces (auto-launch, general
// commands). No I/O. Fail-closed: control requires both the master switch and a
// user-id match — chat membership alone is never enough for control.
import type { TelegramConfig } from "@squadrant/shared";

export function isControlEnabled(cfg: TelegramConfig): boolean {
  return cfg.remoteControl === true;
}

export function isAuthorized(fromId: number | undefined, cfg: TelegramConfig): boolean {
  if (fromId === undefined) return false;
  return Array.isArray(cfg.users) && cfg.users.includes(fromId);
}
