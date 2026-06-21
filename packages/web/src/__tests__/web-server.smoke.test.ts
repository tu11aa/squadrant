// packages/web/src/__tests__/web-server.smoke.test.ts
//
// Gate 4 — web-server smoke test (committed).
// Boots startWebServer on an ephemeral port with a nonexistent sockPath (so the
// daemon is unreachable — graceful degradation). Fetches / and asserts HTML.
// Also connects to /events and asserts ≥1 SSE frame arrives.
// Uses the same fakeRunners pattern as web-server.test.ts so there is no real
// I/O beyond the HTTP request.
import { describe, it, expect, afterAll } from "vitest";
import { get as httpGet } from "node:http";
import { startWebServer, type WebServerHandle } from "../web-server.js";
import type { ProbeRunners } from "../probes.js";

function fakeRunners(): ProbeRunners {
  return {
    probeCmuxBin: async () => false,
    probeOnPath: async () => false,
    pathExists: () => false,
    loadConfig: () => { throw new Error("no config in smoke test"); },
    loadSessionsHashes: () => [],
  };
}

/** Read the first `data:` line from an SSE endpoint using node:http. */
function readFirstSseFrame(port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE frame timeout")), timeoutMs);
    const req = httpGet(`http://127.0.0.1:${port}/events`, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        const dataLine = buf.split("\n").find(l => l.startsWith("data: "));
        if (dataLine) {
          clearTimeout(timer);
          req.destroy();
          resolve(dataLine);
        }
      });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

describe("web-server smoke (Gate 4)", () => {
  let handle: WebServerHandle | undefined;

  afterAll(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("binds on an ephemeral port and serves HTML on /", async () => {
    const sockPath = `/tmp/squadrant-smoke-${process.pid}.sock`;
    handle = await startWebServer({
      port: 0,            // OS picks an ephemeral port
      intervalMs: 60_000, // long interval — we close immediately after one tick
      sockPath,           // nonexistent — daemon unreachable → graceful degrade
      runners: fakeRunners(),
    });

    // handle.port is the actually-bound port (resolved from port: 0)
    const port = handle.port;
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<!DOCTYPE html>/i);
    expect(html).toMatch(/<html/i);
    // Degrades gracefully — daemon unreachable banner expected
    expect(html).toContain("DAEMON UNREACHABLE");
  }, 15_000);

  it("serves ≥1 SSE frame on /events", async () => {
    // handle is set by the previous test; if not, boot a fresh server
    if (!handle) {
      const sockPath = `/tmp/squadrant-smoke-sse-${process.pid}.sock`;
      handle = await startWebServer({
        port: 0,
        intervalMs: 60_000,
        sockPath,
        runners: fakeRunners(),
      });
    }
    const port = handle.port;
    // startWebServer calls tick() before returning, so `latest` is already set.
    // The /events handler writes the latest snapshot immediately on connect.
    const frame = await readFirstSseFrame(port, 10_000);
    expect(frame).toMatch(/^data: /);
    // Frame must be valid JSON after stripping the "data: " prefix
    const json = JSON.parse(frame.slice("data: ".length));
    expect(json).toBeDefined();
  }, 15_000);
});
