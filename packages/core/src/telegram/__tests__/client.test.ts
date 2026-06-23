import { describe, it, expect } from "vitest";
import { createTelegramClient } from "../client.js";

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
