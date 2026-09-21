// src/dashboard/__tests__/web-server.test.ts
//
// Thin integration smoke (no live daemon, no live network egress): the server
// binds 127.0.0.1:0, the daemon socket is absent (→ unreachable), and the probe
// runners are injected fakes. Asserts the page renders and degrades gracefully.
import { describe, it, expect, afterEach } from "vitest";
import { get } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      sockPath: "/tmp/squadrant-nonexistent.sock",
      runners: fakeRunners(),
    });
    const html = await fetchText(handle.port, "/");
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("SQUADRANT SYSTEM HEALTH");
    expect(html).toContain("DAEMON UNREACHABLE"); // no daemon socket → degraded, not blank
    expect(html).toContain("cmux"); // Tier 3 probes still rendered
  });

  it("returns 404 for unknown paths", async () => {
    handle = await startWebServer({
      port: 0,
      intervalMs: 60_000,
      sockPath: "/tmp/squadrant-nonexistent.sock",
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

  it("streams the daemon-log backlog on /logs as SSE (#519)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-logs-"));
    const logPath = join(dir, "squadrantd.log");
    writeFileSync(logPath, "[squadrantd] boot\n[squadrantd] sweep ok\n");
    try {
      handle = await startWebServer({
        port: 0,
        intervalMs: 60_000,
        sockPath: "/tmp/squadrant-nonexistent.sock",
        runners: fakeRunners(),
        logPath,
      });
      const { contentType, data } = await firstEvent(handle.port, "/logs");
      expect(contentType).toContain("text/event-stream");
      expect(JSON.parse(data).lines).toEqual(["[squadrantd] boot", "[squadrantd] sweep ok"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Read the first `data:` event from an SSE endpoint, then hang up. */
function firstEvent(port: number, path: string): Promise<{ contentType: string; data: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      let buf = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => {
        buf += c;
        const m = buf.match(/^data: (.*)$/m);
        if (m) {
          res.destroy();
          resolve({ contentType: String(res.headers["content-type"] ?? ""), data: m[1] });
        }
      });
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "ECONNRESET") reject(e);
    });
  });
}
