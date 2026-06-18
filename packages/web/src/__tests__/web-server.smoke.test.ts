// packages/web/src/__tests__/web-server.smoke.test.ts
//
// Gate 4 — web-server smoke test (committed).
// Boots startWebServer on an ephemeral port with a nonexistent sockPath (so the
// daemon is unreachable — graceful degradation). Fetches / and asserts HTML.
// Uses the same fakeRunners pattern as web-server.test.ts so there is no real
// I/O beyond the HTTP request.
import { describe, it, expect, afterAll } from "vitest";
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

describe("web-server smoke (Gate 4)", () => {
  let handle: WebServerHandle | undefined;

  afterAll(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("binds on an ephemeral port and serves HTML on /", async () => {
    const sockPath = `/tmp/cockpit-smoke-${process.pid}.sock`;
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
});
