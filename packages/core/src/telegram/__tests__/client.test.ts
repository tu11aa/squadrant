import { describe, it, expect } from "vitest";
import { createTelegramClient, TelegramApiError } from "../client.js";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake fetch that records calls and returns a configured Bot API response. */
function fakeFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: Call[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body));
}

describe("createTelegramClient.getMe", () => {
  it("POSTs to /getMe and returns the bot user", async () => {
    const botUser = { id: 12345, is_bot: true, first_name: "MyBot", username: "my_bot" };
    const { fn, calls } = fakeFetch({ ok: true, result: botUser });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    const got = await client.getMe();

    expect(got).toEqual({ id: 12345, username: "my_bot" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/getMe");
    expect(calls[0].init?.method).toBe("POST");
  });
});

describe("createTelegramClient.getUpdates", () => {
  it("POSTs to /getUpdates with offset and timeout, returning the result array", async () => {
    const updates = [{ update_id: 1 }, { update_id: 2 }];
    const { fn, calls } = fakeFetch({ ok: true, result: updates });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    const got = await client.getUpdates(5, 30);

    expect(got).toEqual(updates);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/getUpdates");
    expect(calls[0].init?.method).toBe("POST");
    expect(bodyOf(calls[0])).toMatchObject({ offset: 5, timeout: 30 });
  });
});

describe("createTelegramClient.getUpdates abort (#830)", () => {
  it("threads an AbortSignal through to fetch", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: [] });
    const client = createTelegramClient({ token: "TKN", fetch: fn });
    const ac = new AbortController();

    await client.getUpdates(0, 5, ac.signal);

    expect(calls[0].init?.signal).toBe(ac.signal);
  });

  it("throws a TelegramApiError carrying the numeric error_code", async () => {
    const { fn } = fakeFetch({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    const err = await client.getUpdates(0).catch((e) => e);

    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).code).toBe(409);
  });
});

describe("createTelegramClient.sendMessage", () => {
  it("POSTs chat_id, message_thread_id and text when a thread is given", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: {} });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.sendMessage(-100, 7, "hello");

    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/sendMessage");
    expect(bodyOf(calls[0])).toEqual({ chat_id: -100, message_thread_id: 7, text: "hello" });
  });

  it("omits message_thread_id when no thread is given", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: {} });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.sendMessage(-100, undefined, "hello");

    expect(bodyOf(calls[0])).toEqual({ chat_id: -100, text: "hello" });
  });
});

describe("createTelegramClient.sendMessage reply_markup", () => {
  it("includes reply_markup when given a 4th arg", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: {} });
    const client = createTelegramClient({ token: "TKN", fetch: fn });
    const kb = { inline_keyboard: [[{ text: "x", callback_data: "e:max" }]] };

    await client.sendMessage(5, 9, "hi", kb);

    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/sendMessage");
    expect(bodyOf(calls[0])).toEqual({ chat_id: 5, message_thread_id: 9, text: "hi", reply_markup: kb });
  });

  it("omits reply_markup when not given", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: {} });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.sendMessage(5, undefined, "hi");

    expect(bodyOf(calls[0])).toEqual({ chat_id: 5, text: "hi" });
  });
});

describe("createTelegramClient.answerCallbackQuery", () => {
  it("POSTs callback_query_id and text", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: true });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.answerCallbackQuery("cb1", "done");

    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/answerCallbackQuery");
    expect(bodyOf(calls[0])).toMatchObject({ callback_query_id: "cb1", text: "done" });
  });

  it("omits text when not given", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: true });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.answerCallbackQuery("cb1");

    expect(bodyOf(calls[0])).toEqual({ callback_query_id: "cb1" });
  });
});

describe("createTelegramClient.editMessageReplyMarkup", () => {
  it("POSTs chat_id, message_id and reply_markup", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: {} });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.editMessageReplyMarkup(5, 42, { inline_keyboard: [] });

    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/editMessageReplyMarkup");
    expect(bodyOf(calls[0])).toMatchObject({ chat_id: 5, message_id: 42, reply_markup: { inline_keyboard: [] } });
  });
});

describe("createTelegramClient.createForumTopic", () => {
  it("POSTs chat_id and name and returns the new message_thread_id", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: { message_thread_id: 42 } });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    const threadId = await client.createForumTopic(-100, "squadrant");

    expect(threadId).toBe(42);
    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/createForumTopic");
    expect(bodyOf(calls[0])).toEqual({ chat_id: -100, name: "squadrant" });
  });
});

describe("createTelegramClient.deleteForumTopic (#321 link race)", () => {
  it("POSTs chat_id and message_thread_id", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: true });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.deleteForumTopic!(-100, 42);

    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/deleteForumTopic");
    expect(bodyOf(calls[0])).toEqual({ chat_id: -100, message_thread_id: 42 });
  });
});

describe("rate-limit hint (#321)", () => {
  it("carries the Bot API's retry_after so the poll can honor it", async () => {
    const { fn } = fakeFetch({
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 7",
      parameters: { retry_after: 7 },
    });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    const err = await client.getUpdates(0).catch((e) => e);

    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).code).toBe(429);
    expect((err as TelegramApiError).retryAfterSec).toBe(7);
  });

  it("leaves retryAfterSec undefined when the API sent no hint", async () => {
    const { fn } = fakeFetch({ ok: false, error_code: 429, description: "Too Many Requests" });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    const err = await client.getUpdates(0).catch((e) => e);

    expect((err as TelegramApiError).retryAfterSec).toBeUndefined();
  });

  it("leaves retryAfterSec undefined on a non-rate-limit error", async () => {
    const { fn } = fakeFetch({ ok: false, error_code: 409, description: "Conflict", parameters: {} });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    const err = await client.getUpdates(0).catch((e) => e);

    expect((err as TelegramApiError).retryAfterSec).toBeUndefined();
  });
});

describe("createTelegramClient.sendChatAction", () => {
  it("POSTs chat_id, message_thread_id, and action when a thread is given", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: true });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.sendChatAction(-100, 7, "typing");

    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/sendChatAction");
    expect(bodyOf(calls[0])).toEqual({ chat_id: -100, message_thread_id: 7, action: "typing" });
  });

  it("omits message_thread_id when no thread is given", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: true });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.sendChatAction(-100, undefined, "typing");

    expect(bodyOf(calls[0])).toEqual({ chat_id: -100, action: "typing" });
  });
});

describe("createTelegramClient.setMessageReaction (#838 stage-1 ACK)", () => {
  it("POSTs chat_id, message_id and a single-emoji reaction", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: true });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await client.setMessageReaction!(-100, 42, "👍");

    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/setMessageReaction");
    expect(bodyOf(calls[0])).toEqual({
      chat_id: -100,
      message_id: 42,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  });
});

describe("createTelegramClient.setMyCommands", () => {
  it("POSTs commands array under the setMyCommands method and resolves", async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: true });
    const client = createTelegramClient({ token: "TKN", fetch: fn });
    const cmds = [{ command: "status", description: "squadrant status" }];

    await client.setMyCommands(cmds);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/setMyCommands");
    expect(calls[0].init?.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual({ commands: cmds });
  });

  it("rejects when the Bot API returns ok:false", async () => {
    const { fn } = fakeFetch({ ok: false, error_code: 401, description: "Unauthorized" });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await expect(client.setMyCommands([])).rejects.toThrow("telegram setMyCommands failed (401): Unauthorized");
  });
});

describe("error surfacing", () => {
  it("rejects on a non-2xx HTTP response, including error_code and description", async () => {
    const { fn } = fakeFetch({ ok: false, error_code: 502, description: "Bad Gateway" }, { ok: false, status: 502 });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await expect(client.getUpdates(0)).rejects.toThrow("telegram getUpdates failed (502): Bad Gateway");
  });

  it("rejects when the Bot API returns ok:false with error_code and description in the message", async () => {
    const { fn } = fakeFetch({ ok: false, error_code: 400, description: "not enough rights to create a topic" });
    const client = createTelegramClient({ token: "TKN", fetch: fn });

    await expect(client.createForumTopic(-100, "test"))
      .rejects.toThrow("telegram createForumTopic failed (400): not enough rights to create a topic");
  });
});
