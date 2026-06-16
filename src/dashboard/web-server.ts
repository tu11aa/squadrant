// src/dashboard/web-server.ts
//
// The `cockpit dashboard --web` process: a localhost-only HTTP + SSE server that,
// on each tick, queries the daemon's read-only `snapshot` verb, runs the Tier 3/4
// external probes (which the daemon cannot — lineage wall), merges them, and
// pushes the result to every connected browser. Crash-isolated from the daemon
// (separate PID, read-only socket client) and bound to 127.0.0.1 with no auth.
// Zero new deps: Node's built-in `http` + `EventSource` on the client.
import { createServer, type Server, type ServerResponse } from "node:http";
import { sendRequest } from "../control/protocol.js";
import type { DaemonSnapshot } from "../control/snapshot.js";
import { mergeSnapshot, type FullSnapshot } from "./snapshot-merge.js";
import { runExternalProbes, type ProbeRunners } from "./probes.js";
import { renderHtml, renderTickJson } from "./web-render.js";

/**
 * Query the daemon's read-only snapshot verb. Returns "unreachable" when the
 * daemon socket can't be reached — the page degrades (banner + Tier 3/4) rather
 * than blanking. Mirrors queryHealth() in health-view.ts.
 */
export async function querySnapshot(sockPath: string): Promise<DaemonSnapshot | "unreachable"> {
  try {
    const reply = await sendRequest(sockPath, { kind: "snapshot" });
    return reply as DaemonSnapshot;
  } catch {
    return "unreachable";
  }
}

export interface WebServerOpts {
  port: number;
  intervalMs: number;
  sockPath: string;
  runners: ProbeRunners;
  host?: string;
  now?: () => number;
  probeTimeoutMs?: number;
}

export interface WebServerHandle {
  /** The actually-bound port (useful when port 0 was requested in tests). */
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the dashboard web server. Binds 127.0.0.1 only, serves the static page on
 * GET /, an SSE stream on GET /events, and pushes a fresh snapshot every
 * intervalMs. Returns a handle whose close() stops the tick loop and the server.
 */
export async function startWebServer(opts: WebServerOpts): Promise<WebServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const now = opts.now ?? (() => Date.now());
  const clients = new Set<ServerResponse>();
  let latest: FullSnapshot | null = null;

  async function tick(): Promise<void> {
    const daemon = await querySnapshot(opts.sockPath);
    const external = await runExternalProbes(opts.runners, opts.probeTimeoutMs);
    latest = mergeSnapshot(daemon, external, now());
    const payload = `data: ${renderTickJson(latest)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* client gone; pruned on close */ }
    }
  }

  const server: Server = createServer((req, res) => {
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(latest ? renderHtml(latest, { port: opts.port }) : "<!DOCTYPE html><body>starting…</body>");
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      if (latest) res.write(`data: ${renderTickJson(latest)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, resolve);
  });
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;

  // Prime `latest` before the first request lands, then start the loop.
  await tick();
  const timer = setInterval(() => { void tick().catch(() => { /* a tick must never crash the loop */ }); }, opts.intervalMs);
  timer.unref?.();

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        for (const res of clients) { try { res.end(); } catch { /* already closed */ } }
        clients.clear();
        server.close(() => resolve());
      }),
  };
}
