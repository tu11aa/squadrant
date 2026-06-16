// src/dashboard/__tests__/web-server.test.ts
//
// Thin integration smoke (no live daemon, no live network egress): the server
// binds 127.0.0.1:0, the daemon socket is absent (→ unreachable), and the probe
// runners are injected fakes. Asserts the page renders and degrades gracefully.
import { describe, it, expect, afterEach } from "vitest";
import { get } from "node:http";
import { startWebServer, type WebServerHandle } from "../web-server.js";
import type { ProbeRunners } from "../probes.js";

function fakeRunners(): ProbeRunners {
  return {
    probeCmuxBin: async () => true,
    probeOnPath: async () => true,
    pathExists: () => true,
    loadConfig: () => { throw new Error("no config in test"); },
    loadSessionsHashes: () => [],
  };
}

function fetchText(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

describe("startWebServer smoke", () => {
  let handle: WebServerHandle | undefined;
  afterEach(async () => { await handle?.close(); handle = undefined; });

  it("serves the page on 127.0.0.1 and degrades when the daemon is unreachable", async () => {
    handle = await startWebServer({
      port: 0,
      intervalMs: 60_000, // long — the test does one request then closes
      sockPath: "/tmp/cockpit-nonexistent.sock",
      runners: fakeRunners(),
    });
    const html = await fetchText(handle.port, "/");
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("COCKPIT SYSTEM HEALTH");
    expect(html).toContain("DAEMON UNREACHABLE"); // no daemon socket → degraded, not blank
    expect(html).toContain("cmux"); // Tier 3 probes still rendered
  });

  it("returns 404 for unknown paths", async () => {
    handle = await startWebServer({
      port: 0,
      intervalMs: 60_000,
      sockPath: "/tmp/cockpit-nonexistent.sock",
      runners: fakeRunners(),
    });
    const status = await new Promise<number>((resolve, reject) => {
      get({ host: "127.0.0.1", port: handle!.port, path: "/nope" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    expect(status).toBe(404);
  });
});
