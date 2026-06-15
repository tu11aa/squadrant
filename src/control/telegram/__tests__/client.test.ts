// src/control/telegram/__tests__/client.test.ts
import { describe, it, expect, vi } from "vitest";
import { createTelegramClient } from "../client.js";

function fakeFetch(responses: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: { body?: string }) => {
    const method = url.split("/").pop()!;
    const body = init?.body ? JSON.parse(init.body) : {};
    const result = responses[method];
    return {
      ok: true,
      json: async () => ({ ok: true, result, _sentBody: body }),
    } as unknown as Response;
  });
}

describe("telegram client", () => {
  it("createForumTopic returns the message_thread_id", async () => {
    const f = fakeFetch({ createForumTopic: { message_thread_id: 42, name: "🔧 crew-1" } });
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    const id = await c.createForumTopic(-100, "🔧 crew-1");
    expect(id).toBe(42);
    expect(f).toHaveBeenCalledWith(
      "https://api.telegram.org/botT/createForumTopic",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sendMessage includes message_thread_id when given", async () => {
    const f = fakeFetch({ sendMessage: { message_id: 1 } });
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    await c.sendMessage(-100, "hi", 42);
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ chat_id: -100, text: "hi", message_thread_id: 42 });
  });

  it("sendMessage omits message_thread_id when undefined", async () => {
    const f = fakeFetch({ sendMessage: { message_id: 1 } });
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    await c.sendMessage(-100, "hi");
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ chat_id: -100, text: "hi" });
  });

  it("getUpdates returns the result array", async () => {
    const updates = [{ update_id: 7, message: { chat: { id: -100 }, text: "yo" } }];
    const f = fakeFetch({ getUpdates: updates });
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    const got = await c.getUpdates(5, 0);
    expect(got).toEqual(updates);
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ offset: 5, timeout: 0 });
  });

  it("throws on a Telegram error response", async () => {
    const f = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    } as unknown as Response));
    const c = createTelegramClient("T", f as unknown as typeof fetch);
    await expect(c.getMe()).rejects.toThrow("Unauthorized");
  });
});
