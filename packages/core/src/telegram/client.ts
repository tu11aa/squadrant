// Telegram Bot API over plain fetch — no runtime SDK (keeps the tsup single
// binary lean). @grammyjs/types is a devDependency: type-only, erased at build.
import type { Update } from "@grammyjs/types";

export interface TelegramClient {
  /** Long-poll for updates. timeoutSec is the Bot API `timeout` (default 50s). */
  getUpdates(offset: number, timeoutSec?: number): Promise<Update[]>;
  sendMessage(chatId: number, threadId: number | undefined, text: string, replyMarkup?: unknown): Promise<void>;
  /** Answer a callback_query — REQUIRED on every tap path or the spinner hangs ~15s. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** Replace an existing message's inline keyboard (panel re-render). */
  editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: unknown): Promise<void>;
  /** Returns the new topic's message_thread_id. */
  createForumTopic(chatId: number, name: string): Promise<number>;
  /** Verify the bot token and return the bot identity. */
  getMe(): Promise<{ id: number; username: string }>;
  /** Register the bot's command menu with Telegram. */
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
  /** Send a chat action (e.g. "typing") to show activity to the user. */
  sendChatAction(chatId: number, threadId: number | undefined, action: string): Promise<void>;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export function createTelegramClient(opts: { token: string; fetch?: typeof fetch }): TelegramClient {
  const fetchImpl = opts.fetch ?? fetch;
  const base = `https://api.telegram.org/bot${opts.token}`;

  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as TgResponse<T>;
    if (!res.ok || !json.ok) {
      const code = json.error_code ?? res.status;
      const desc = json.description ?? "unknown error";
      throw new Error(`telegram ${method} failed (${code}): ${desc}`);
    }
    return json.result as T;
  }

  return {
    async getMe() {
      const r = await call<{ id: number; username: string }>("getMe", {});
      return { id: r.id, username: r.username };
    },
    getUpdates(offset, timeoutSec = 50) {
      return call<Update[]>("getUpdates", { offset, timeout: timeoutSec });
    },
    async sendMessage(chatId, threadId, text, replyMarkup) {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (threadId !== undefined) body.message_thread_id = threadId;
      if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
      await call<unknown>("sendMessage", body);
    },
    async answerCallbackQuery(callbackQueryId, text) {
      const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
      if (text !== undefined) body.text = text;
      await call<unknown>("answerCallbackQuery", body);
    },
    async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
      await call<unknown>("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
    },
    async createForumTopic(chatId, name) {
      const r = await call<{ message_thread_id: number }>("createForumTopic", { chat_id: chatId, name });
      return r.message_thread_id;
    },
    async setMyCommands(commands) {
      await call<boolean>("setMyCommands", { commands });
    },
    async sendChatAction(chatId, threadId, action) {
      const body: Record<string, unknown> = { chat_id: chatId, action };
      if (threadId !== undefined) body.message_thread_id = threadId;
      await call<unknown>("sendChatAction", body);
    },
  };
}
