// packages/core/src/router/shim.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RouterHealth, RouterShim, RouterShimOptions, RouterUpstream, RouterUsage } from "./types.js";
export type { RouterShim } from "./types.js";
import { resolveProject } from "./auth.js";
import { anthropicError } from "./errors.js";

/** Append an Anthropic path to a base URL without dropping a base path
 *  (https://opencode.ai/zen/go + /v1/messages => https://opencode.ai/zen/go/v1/messages). */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const DEFAULT_AUTH_HEADER = "Authorization";

/** Build upstream request headers: content negotiation, configured auth
 *  (authHeader + extraHeaders), and a whitelist of client `anthropic-*`
 *  headers (so `anthropic-beta` rides along). */
function buildUpstreamHeaders(
  req: IncomingMessage,
  upstream: RouterUpstream,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key.startsWith("anthropic-") && typeof v === "string") headers[key] = v;
  }
  for (const [k, v] of Object.entries(upstream.extraHeaders ?? {})) headers[k.toLowerCase()] = v;
  const authName = (upstream.authHeader ?? DEFAULT_AUTH_HEADER).toLowerCase();
  headers[authName] = authName === "authorization" ? `Bearer ${upstream.apiKey}` : upstream.apiKey;
  if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
  return headers;
}

export function createRouterShim(opts: RouterShimOptions): RouterShim {
  const fetchImpl = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  let server: Server | undefined;
  let starting: Promise<void> | undefined;
  let boundPort = 0;
  let lastError: string | undefined;
  let upstreamReachable = true;
  const upstreamUrl = joinUrl(opts.upstream.baseUrl, "/v1/messages");

  function emitUsage(u: RouterUsage): void {
    try {
      opts.onUsage?.(u);
    } catch {
      /* best-effort */
    }
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const project = resolveProject(opts.projectTokens, req.headers.authorization);
    if (!project) {
      const e = anthropicError(401, "authentication_error", "invalid squadrant router token");
      writeJson(res, e.status, e.body);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      const e = anthropicError(400, "invalid_request_error", "malformed JSON body");
      writeJson(res, e.status, e.body);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      const e = anthropicError(400, "invalid_request_error", "request body must be a JSON object");
      writeJson(res, e.status, e.body);
      return;
    }
    const body = parsed as Record<string, unknown>;
    const wantsStream = body.stream === true;

    let upstreamRes: Response;
    try {
      upstreamRes = await fetchImpl(upstreamUrl, {
        method: "POST",
        headers: buildUpstreamHeaders(req, opts.upstream, wantsStream),
        body: JSON.stringify(body),
      });
    } catch (err) {
      upstreamReachable = false;
      lastError = err instanceof Error ? err.message : String(err);
      const e = anthropicError(502, "api_error", `router upstream unreachable: ${lastError}`);
      writeJson(res, e.status, e.body);
      return;
    }
    upstreamReachable = true;

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text();
      log(`router upstream ${upstreamRes.status}: ${text.slice(0, 500)}`);
      const e = anthropicError(upstreamRes.status, "api_error", text.slice(0, 500) || "upstream error");
      writeJson(res, e.status, e.body);
      return;
    }

    const text = await upstreamRes.text();
    let upstreamBody: Record<string, unknown>;
    try {
      upstreamBody = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const e = anthropicError(502, "api_error", "upstream returned non-JSON");
      writeJson(res, e.status, e.body);
      return;
    }
    void emitUsage;
    void project;
    writeJson(res, upstreamRes.status, upstreamBody);
  }

  function handler(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "POST" && req.url === "/v1/messages") {
      void handleMessages(req, res).catch((err) => {
        log(`router internal error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          const e = anthropicError(502, "api_error", "router internal error");
          writeJson(res, e.status, e.body);
        } else {
          res.end();
        }
      });
      return;
    }
    writeJson(res, 404, anthropicError(404, "not_found_error", "not found").body);
  }

  return {
    async start() {
      if (server) return;
      if (starting) return starting;
      starting = new Promise<void>((resolve, reject) => {
        const s = createServer(handler);
        const onStartupError = (err: Error): void => {
          s.off("error", onStartupError);
          reject(err);
        };
        s.once("error", onStartupError);
        s.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
          s.off("error", onStartupError);
          s.on("error", (err: Error) => log(`router server error: ${err.message}`));
          server = s;
          const addr = s.address();
          boundPort = typeof addr === "object" && addr ? addr.port : 0;
          resolve();
        });
      });
      try {
        await starting;
      } finally {
        starting = undefined;
      }
    },
    async stop() {
      const s = server;
      if (!s) return;
      server = undefined;
      boundPort = 0;
      s.closeAllConnections?.();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
    url() {
      return `http://${opts.host ?? "127.0.0.1"}:${boundPort}`;
    },
    async health(): Promise<RouterHealth> {
      return { ready: server?.listening === true, upstreamReachable, lastError };
    },
  };
}
