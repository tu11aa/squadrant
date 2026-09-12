// packages/core/src/router/__tests__/service.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { resolveRouterUpstream, createRouterService, type RouterService } from "../service.js";
import type { RouterConfig } from "@squadrant/shared";

async function mockUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

describe("resolveRouterUpstream", () => {
  it("defaults authHeader by kind and resolves apiKeyEnv", () => {
    const go = resolveRouterUpstream({ kind: "opencode-go", baseUrl: "https://go.test", apiKeyEnv: "K" }, { K: "secret" } as NodeJS.ProcessEnv);
    expect(go).toMatchObject({ baseUrl: "https://go.test", apiKey: "secret", authHeader: "x-api-key", isAnthropic: false });

    const or = resolveRouterUpstream({ kind: "openrouter", baseUrl: "https://or.test", apiKey: "plain" }, {} as NodeJS.ProcessEnv);
    expect(or).toMatchObject({ apiKey: "plain", authHeader: "Authorization" });
  });

  it("honours an explicit isAnthropic", () => {
    const u = resolveRouterUpstream({ kind: "custom", baseUrl: "https://a.test", apiKey: "k", isAnthropic: true }, {} as NodeJS.ProcessEnv);
    expect(u.isAnthropic).toBe(true);
  });
});

describe("createRouterService", () => {
  let upstream: { url: string; close: () => Promise<void> } | null = null;
  let service: RouterService | null = null;
  afterEach(async () => { await service?.stop(); service = null; await upstream?.close(); upstream = null; });

  it("proxy credentials carry the loopback url + a per-project token", async () => {
    upstream = await mockUpstream();
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: upstream.url, apiKey: "k" };
    service = createRouterService(cfg, ["proj-a", "proj-b"]);
    await service.start();
    const a = service.credentialsFor("proj-a", "proxy");
    const b = service.credentialsFor("proj-b", "proxy");
    expect(a.backend).toBe("proxy");
    expect(a.baseUrl).toContain("127.0.0.1");
    expect(a.token).toBeTruthy();
    expect(a.token).not.toBe(b.token);
  });

  it("direct credentials carry the upstream url, apiKey, and extraHeaders", () => {
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: "https://go.test", apiKey: "k", extraHeaders: { "x-opencode-session": "squadrant" } };
    service = createRouterService(cfg, ["proj-a"]);
    const d = service.credentialsFor("proj-a", "direct");
    expect(d).toEqual({ backend: "direct", baseUrl: "https://go.test", apiKey: "k", extraHeaders: { "x-opencode-session": "squadrant" } });
  });

  it("throws for proxy credentials before start (url port is still 0)", () => {
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: "https://go.test", apiKey: "k" };
    service = createRouterService(cfg, ["proj-a"]);
    expect(() => service!.credentialsFor("proj-a", "proxy")).toThrow(/not started/);
  });

  it("throws when no credential is configured", () => {
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: "https://go.test" };
    service = createRouterService(cfg, ["proj-a"]);
    expect(() => service!.credentialsFor("proj-a", "direct")).toThrow(/credential is missing/);
  });

  it("throws for url() before start", () => {
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: "https://go.test", apiKey: "k" };
    service = createRouterService(cfg, ["proj-a"]);
    expect(() => service!.url()).toThrow(/not started/);
  });

  it("returns a usable loopback url after start", async () => {
    upstream = await mockUpstream();
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: upstream.url, apiKey: "k" };
    service = createRouterService(cfg, ["proj-a"]);
    await service.start();
    const url = service.url();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url.endsWith(":0")).toBe(false);
  });

  it("throws for url() after stop", async () => {
    upstream = await mockUpstream();
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: upstream.url, apiKey: "k" };
    service = createRouterService(cfg, ["proj-a"]);
    await service.start();
    await service.stop();
    expect(() => service!.url()).toThrow(/not started/);
  });

  it("throws for a project with no minted token", async () => {
    upstream = await mockUpstream();
    const cfg: RouterConfig = { kind: "opencode-go", baseUrl: upstream.url, apiKey: "k" };
    service = createRouterService(cfg, ["proj-a"]);
    await service.start();
    expect(() => service!.credentialsFor("proj-zzz", "proxy")).toThrow(/no token for project 'proj-zzz'/);
  });
});
