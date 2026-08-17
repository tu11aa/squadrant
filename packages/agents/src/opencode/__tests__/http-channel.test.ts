// Tests for OpencodeHttpChannel (#667 slice 2).
// fetch is injected everywhere — no real opencode server, no real port.
// A test that reaches a real port lies on CI (2026-08-13 incident).
import { describe, it, expect, vi } from "vitest";
import { OpencodeHttpChannel } from "../http-channel.js";

const TASK = "task-1";
const PORT = 4096;

/** Minimal fetch stub: route → Response. */
function stubFetch(routes: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) return new Response("no route", { status: 500 });
    const r = routes[key];
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
}

function channel(routes: Parameters<typeof stubFetch>[0], portFor?: () => number | undefined) {
  const fetchImpl = stubFetch(routes);
  const ch = new OpencodeHttpChannel({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    portFor: portFor ?? (() => PORT),
  });
  return { ch, fetchImpl };
}

describe("OpencodeHttpChannel — identity", () => {
  it("is named opencode-http and serves the opencode provider", () => {
    const { ch } = channel({});
    expect(ch.name).toBe("opencode-http");
    expect(ch.agent).toBe("opencode");
  });
});

describe("OpencodeHttpChannel — send", () => {
  it("204 from prompt_async maps to accepted", async () => {
    const { ch } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 204 },
    });
    expect(await ch.send(TASK, "hello")).toEqual({ status: "accepted", via: "opencode-http" });
  });

  it("404 maps to gone — a dead session is REPORTED dead, not guessed at", async () => {
    const { ch } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 404, body: { name: "NotFoundError" } },
    });
    expect(await ch.send(TASK, "hello")).toEqual({ status: "gone" });
  });

  it("uses prompt_async, never /tui/* — /tui targets the FOCUSED session (#649 risk)", async () => {
    const { ch, fetchImpl } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 204 },
    });
    await ch.send(TASK, "hello");
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/prompt_async"))).toBe(true);
    expect(urls.some((u) => u.includes("/tui/"))).toBe(false);
  });

  it("sends the message in opencode's parts shape", async () => {
    const { ch, fetchImpl } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 204 },
    });
    await ch.send(TASK, "hello world");
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/prompt_async"))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      parts: [{ type: "text", text: "hello world" }],
    });
  });

  it("no known port maps to unsupported — the caller falls back to the pane", async () => {
    const { ch } = channel({}, () => undefined);
    expect(await ch.send(TASK, "hello")).toEqual({ status: "unsupported" });
  });

  it("an unreachable server maps to gone, not a throw", async () => {
    const ch = new OpencodeHttpChannel({
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      portFor: () => PORT,
    });
    expect(await ch.send(TASK, "hello")).toEqual({ status: "gone" });
  });

  it("caches the resolved session id across sends", async () => {
    const { ch, fetchImpl } = channel({
      "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] },
      "/prompt_async": { status: 204 },
    });
    await ch.send(TASK, "one");
    await ch.send(TASK, "two");
    const listCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/session?"));
    expect(listCalls).toHaveLength(1);
  });

  it("re-resolves the session after a 404 instead of caching a dead id forever", async () => {
    let promptStatus = 404;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/prompt_async")) return new Response(null, { status: promptStatus });
      return new Response(JSON.stringify([{ id: "ses_1", time: { updated: 2 } }]), { status: 200 });
    });
    const ch = new OpencodeHttpChannel({ fetchImpl: fetchImpl as unknown as typeof fetch, portFor: () => PORT });
    expect(await ch.send(TASK, "one")).toEqual({ status: "gone" });
    promptStatus = 204;
    expect(await ch.send(TASK, "two")).toEqual({ status: "accepted", via: "opencode-http" });
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/session?"))).toHaveLength(2);
  });

  it("picks the most recently updated session when several exist", async () => {
    const { ch, fetchImpl } = channel({
      "/session?": { status: 200, body: [
        { id: "ses_old", time: { updated: 1 } },
        { id: "ses_new", time: { updated: 9 } },
      ] },
      "/prompt_async": { status: 204 },
    });
    await ch.send(TASK, "hello");
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/prompt_async"))!;
    expect(String(call[0])).toContain("ses_new");
  });

  it("an empty session list maps to gone", async () => {
    const { ch } = channel({ "/session?": { status: 200, body: [] } });
    expect(await ch.send(TASK, "hello")).toEqual({ status: "gone" });
  });
});

describe("OpencodeHttpChannel — probe (shadow mode must never deliver)", () => {
  it("reports reachable when a session resolves", async () => {
    const { ch } = channel({ "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] } });
    expect(await ch.probe(TASK)).toEqual({ status: "reachable", via: "opencode-http" });
  });

  it("issues only GETs — a probe that POSTs would double-deliver in shadow mode", async () => {
    const { ch, fetchImpl } = channel({ "/session?": { status: 200, body: [{ id: "ses_1", time: { updated: 2 } }] } });
    await ch.probe(TASK);
    for (const call of fetchImpl.mock.calls) {
      const method = ((call[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      expect(method).toBe("GET");
    }
  });

  it("reports gone when the server is unreachable", async () => {
    const ch = new OpencodeHttpChannel({
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      portFor: () => PORT,
    });
    expect(await ch.probe(TASK)).toEqual({ status: "gone" });
  });

  it("reports unsupported when no port is known", async () => {
    const { ch } = channel({}, () => undefined);
    expect(await ch.probe(TASK)).toEqual({ status: "unsupported" });
  });
});