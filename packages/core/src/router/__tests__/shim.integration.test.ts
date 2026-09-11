// packages/core/src/router/__tests__/shim.integration.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createRouterShim, type RouterShim } from "../shim.js";

async function startMockUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
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

  it("is safe to call start() and stop() more than once", async () => {
    upstream = await startMockUpstream((_q, s) => s.end("{}"));
    shim = createRouterShim({
      upstream: { baseUrl: upstream.url, apiKey: "k", isAnthropic: false },
      projectTokens: tokens,
    });
    await shim.start();
    await shim.start();
    await shim.stop();
    await shim.stop();
  });
});
