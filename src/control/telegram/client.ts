// src/control/telegram/client.ts

export interface TgChat {
  id: number;
  type: string;
  title?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    chat: TgChat;
    message_thread_id?: number;
    text?: string;
    from?: { id: number; username?: string };
  };
  /** Emitted when the bot is added to / removed from a chat — used by `telegram link`. */
  my_chat_member?: {
    chat: TgChat;
    new_chat_member?: { status: string };
  };
}

export interface TelegramClient {
  getMe(): Promise<void>;
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, threadId?: number): Promise<void>;
  /** Returns the new topic's message_thread_id. */
  createForumTopic(chatId: number, name: string): Promise<number>;
  closeForumTopic(chatId: number, threadId: number): Promise<void>;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export function createTelegramClient(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  const base = `https://api.telegram.org/bot${botToken}`;

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as TgResponse<T>;
    if (!json.ok) throw new Error(json.description ?? `telegram ${method} failed`);
    return json.result as T;
  }

  return {
    async getMe() {
      await call<unknown>("getMe", {});
    },
    async getUpdates(offset, timeoutS, signal) {
      return call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutS }, signal);
    },
    async sendMessage(chatId, text, threadId) {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (threadId !== undefined) body.message_thread_id = threadId;
      await call<unknown>("sendMessage", body);
    },
    async createForumTopic(chatId, name) {
      const r = await call<{ message_thread_id: number }>("createForumTopic", { chat_id: chatId, name });
      return r.message_thread_id;
    },
    async closeForumTopic(chatId, threadId) {
      await call<unknown>("closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
    },
  };
}
