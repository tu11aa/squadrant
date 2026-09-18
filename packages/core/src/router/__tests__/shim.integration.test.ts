// packages/core/src/router/__tests__/shim.integration.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createRouterShim, type RouterShim } from "../shim.js";
import type { RouterUsage } from "../types.js";

async function startMockUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

async function freePort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

let shim: RouterShim | null = null;
let upstream: { url: string; close: () => Promise<void> } | null = null;
afterEach(async () => {
  await shim?.stop();
  shim = null;
  await upstream?.close();
  upstream = null;
});

const tokens = new Map([["tok-1", "proj-a"]]);

describe("router shim integration", () => {
  it("rejects a missing/invalid token with a 401 Anthropic envelope", async () => {
    upstream = await startMockUpstream((_q, s) => s.end("{}"));
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe("authentication_error");
  });

  it("forwards a non-stream request and returns the upstream body", async () => {
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(200, { "content-type": "application/json" });
      s.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "ok" }] }));
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: Array<{ text: string }> };
    expect(json.content[0].text).toBe("ok");
  });

  it("forwards the sanitized body (strips Anthropic-only fields + server tools) upstream", async () => {
    let received: Record<string, unknown> | undefined;
    upstream = await startMockUpstream((req, s) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        s.writeHead(200, { "content-type": "application/json" });
        s.end("{}");
      });
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        model: "m",
        container: "c",
        context_management: {},
        mcp_servers: [],
        tools: [
          { type: "custom", name: "mcp__foo", input_schema: {} },
          { type: "web_search_20250305", name: "web_search" },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(received?.container).toBeUndefined();
    expect(received?.context_management).toBeUndefined();
    expect(received?.mcp_servers).toBeUndefined();
    expect((received?.tools as Array<{ type: string }>).map((t) => t.type)).toEqual(["custom"]);
  });

  it("uses configured authHeader + extraHeaders and forwards anthropic-* headers", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    upstream = await startMockUpstream((req, s) => {
      seen = req.headers;
      s.writeHead(200, { "content-type": "application/json" });
      s.end("{}");
    });
    shim = createRouterShim({
      upstream: {
        baseUrl: upstream.url,
        apiKey: "go-key",
        authHeader: "x-api-key",
        extraHeaders: { "x-opencode-session": "sess-1" },
        isAnthropic: false,
      },
      projectTokens: tokens,
    });
    await shim.start();
    await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok-1",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(seen["x-api-key"]).toBe("go-key");
    expect(seen["x-opencode-session"]).toBe("sess-1");
    expect(seen["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(seen["authorization"]).toBeUndefined();
  });

  it("sends the default Authorization: Bearer <apiKey> upstream header", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    upstream = await startMockUpstream((req, s) => {
      seen = req.headers;
      s.writeHead(200, { "content-type": "application/json" });
      s.end("{}");
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(seen["authorization"]).toBe("Bearer k");
  });

  it("rejects a non-object JSON body with 400 without marking upstream unreachable", async () => {
    upstream = await startMockUpstream((_q, s) => s.end("{}"));
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: "null",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
    expect((await shim.health()).upstreamReachable).toBe(true);
  });

  it("maps an upstream error status to an Anthropic envelope using the structured error.message", async () => {
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(400, { "content-type": "application/json" });
      s.end(JSON.stringify({ error: { message: "thinking must be passed back" } }));
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("api_error");
    expect(json.error.message).toContain("thinking must be passed back");
    expect(json.error.message).toBe("thinking must be passed back");
  });

  it("maps an upstream 5xx to a 502 envelope and flips upstreamReachable false", async () => {
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(500, { "content-type": "application/json" });
      s.end(JSON.stringify({ error: { message: "boom" } }));
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("api_error");
    expect(json.error.message).toBe("boom");
    expect((await shim.health()).upstreamReachable).toBe(false);
  });

  it("keeps a 4xx status pass-through without poisoning upstreamReachable", async () => {
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(400, { "content-type": "application/json" });
      s.end(JSON.stringify({ error: { message: "bad" } }));
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("api_error");
    expect((await shim.health()).upstreamReachable).toBe(true);
  });

  it("returns a 502 Anthropic envelope when the upstream is unreachable", async () => {
    shim = createRouterShim({
      upstream: { baseUrl: "http://127.0.0.1:1", apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("api_error");
  });

  it("does not let client headers override configured extraHeaders", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    upstream = await startMockUpstream((req, s) => {
      seen = req.headers;
      s.writeHead(200, { "content-type": "application/json" });
      s.end("{}");
    });
    shim = createRouterShim({
      upstream: {
        baseUrl: upstream.url,
        apiKey: "go-key",
        authHeader: "x-api-key",
        extraHeaders: { "x-opencode-session": "sess-1", "anthropic-beta": "configured" },
        isAnthropic: false,
      },
      projectTokens: tokens,
    });
    await shim.start();
    await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok-1",
        "x-opencode-session": "evil",
        "anthropic-beta": "evil",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(seen["x-opencode-session"]).toBe("sess-1");
    expect(seen["anthropic-beta"]).toBe("configured");
  });

  it("streams upstream SSE bytes through to the client byte-faithfully", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(200, { "content-type": "text/event-stream" });
      s.end(sse);
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(sse);
  });

  it("tees usage/cost from a streamed response to onUsage", async () => {
    const sse =
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2},"cost":"0.0004"}\n\n';
    upstream = await startMockUpstream((_q, s) => {
      s.writeHead(200, { "content-type": "text/event-stream" });
      s.end(sse);
    });
    const usages: RouterUsage[] = [];
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
      onUsage: (u) => usages.push(u),
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(sse);
    await new Promise((r) => setTimeout(r, 50));
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ project: "proj-a", outputTokens: 2, costUsd: 0.0004 });
  });

  it("serves GET /healthz reporting readiness after start()", async () => {
    upstream = await startMockUpstream((_q, s) => s.end("{}"));
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; upstreamReachable: boolean };
    expect(body.ready).toBe(true);
    expect(body.upstreamReachable).toBe(true);
  });

  it("falls back to text/event-stream when the upstream omits a content-type", async () => {
    const sse = 'data: {"type":"message_stop"}\n\n';
    upstream = await startMockUpstream((_q, s) => {
      s.end(sse);
    });
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    const res = await fetch(`${shim.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(sse);
  });

  it("is safe to call start() and stop() more than once", async () => {
    upstream = await startMockUpstream((_q, s) => s.end("{}"));
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
      port: await freePort(),
    });
    await Promise.all([shim.start(), shim.start()]);
    expect((await shim.health()).ready).toBe(true);
    expect(shim.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await shim.stop();
    await shim.stop();
    expect((await shim.health()).ready).toBe(false);
  });
});
