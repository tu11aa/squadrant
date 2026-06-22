// Pure helpers for the interactive `squadrant telegram setup` wizard.
// These are exported for testing with injected dependencies.
// getUpdates is single-consumer — setup runs before the daemon starts polling (#321).
import fs from "node:fs";
import type { TelegramClient } from "./client.js";

/**
 * Poll getUpdates until a supergroup message arrives, returning both the chat id
 * and the sender's user id (the latter seeds the control allowlist, #321).
 * Injects `sleep` for testability; never used with real delays in tests.
 */
export async function detectGroupAndUser(
  client: TelegramClient,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ supergroupId: number; userId: number | undefined }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  while (Date.now() < deadline) {
    const updates = await client.getUpdates(offset, 10);
    for (const u of updates) {
      if (u.update_id >= offset) offset = u.update_id + 1;
      if (u.message?.chat?.type === "supergroup") {
        return { supergroupId: u.message.chat.id, userId: u.message.from?.id };
      }
    }
    await sleep(2000);
  }

  throw new Error("Timed out waiting for the bot to receive a message in a supergroup");
}

/** Convenience wrapper that returns only the supergroup id. */
export async function detectGroupId(
  client: TelegramClient,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  return (await detectGroupAndUser(client, opts)).supergroupId;
}

/**
 * Write or update the telegram block in a squadrant config file.
 * Preserves all existing keys; creates the file with defaults if absent.
 */
export function writeTelegramConfig(
  configPath: string,
  opts: { token: string; supergroupId: number; users?: number[]; remoteControl?: boolean },
): void {
  let config: Record<string, unknown>;
  let raw: string | null = null;

  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`refusing to overwrite unreadable config at ${configPath}: ${String(err)}`);
    }
  }

  if (raw !== null) {
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch (err: unknown) {
      throw new Error(`refusing to overwrite corrupt config at ${configPath}: ${String(err)}`);
    }
  } else {
    config = {};
  }

  // Idempotent: re-running setup updates the token/group but preserves existing
  // control fields (users/remoteControl) unless this run supplies new ones.
  const prev = (config.telegram && typeof config.telegram === "object")
    ? (config.telegram as Record<string, unknown>) : {};
  const next: Record<string, unknown> = {
    botToken: opts.token,
    supergroupId: opts.supergroupId,
    chats: [opts.supergroupId],
  };
  const users = opts.users ?? prev.users;
  const remoteControl = opts.remoteControl ?? prev.remoteControl;
  if (users !== undefined) next.users = users;
  if (remoteControl !== undefined) next.remoteControl = remoteControl;
  config.telegram = next;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}
