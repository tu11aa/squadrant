// packages/core/src/router/service.ts
import type { RouterConfig } from "@squadrant/shared";
import { mintToken } from "./auth.js";
import { createRouterShim } from "./shim.js";
import type { RouterHealth, RouterShim, RouterUpstream } from "./types.js";

export interface RouterCredentials {
  backend: "direct" | "proxy";
  baseUrl: string;
  /** proxy: daemon-minted per-project bearer token. */
  token?: string;
  /** direct: the upstream credential (no shim to swap auth). */
  apiKey?: string;
  /** direct: static headers to place in ANTHROPIC_CUSTOM_HEADERS. */
  extraHeaders?: Record<string, string>;
}

export interface RouterService {
  start(): Promise<void>;
  stop(): Promise<void>;
  url(): string;
  health(): Promise<RouterHealth>;
  credentialsFor(project: string, backend: "direct" | "proxy"): RouterCredentials;
}

/** Map the config block to the shim's input shape, deriving kind-based defaults. */
export function resolveRouterUpstream(router: RouterConfig, env: NodeJS.ProcessEnv = process.env): RouterUpstream {
  const credential = router.apiKey ?? (router.apiKeyEnv ? env[router.apiKeyEnv] : undefined) ?? "";
  const authHeader = router.authHeader ?? (router.kind === "opencode-go" ? "x-api-key" : "Authorization");
  return {
    baseUrl: router.baseUrl,
    apiKey: credential,
    authHeader,
    extraHeaders: router.extraHeaders,
    isAnthropic: router.isAnthropic ?? false,
  };
}

/**
 * Daemon-internal router service. Construct only when defaults.router exists.
 * Mints one token per project for the shim and exposes spawn-time credentials.
 */
export function createRouterService(
  router: RouterConfig,
  projects: string[],
  deps: { log?: (m: string) => void; fetch?: typeof fetch } = {},
): RouterService {
  const log = deps.log ?? (() => {});
  const upstream = resolveRouterUpstream(router);
  if (!upstream.apiKey) {
    log("router: no credential configured (set defaults.router.apiKey or apiKeyEnv) — routed spawns will fail");
  }

  const tokenByProject = new Map<string, string>();
  const projectTokens = new Map<string, string>();
  for (const p of projects) {
    const t = mintToken();
    tokenByProject.set(p, t);
    projectTokens.set(t, p);
  }

  const shim: RouterShim = createRouterShim({
    upstream,
    projectTokens,
    port: router.port ?? 0,
    log,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  let started = false;

  return {
    async start() {
      await shim.start();
      started = true;
    },
    async stop() {
      await shim.stop();
      started = false;
    },
    url: () => shim.url(),
    health: () => shim.health(),
    credentialsFor(project, backend) {
      if (!upstream.apiKey) {
        throw new Error("defaults.router credential is missing (set apiKey or apiKeyEnv)");
      }
      if (backend === "direct") {
        return { backend, baseUrl: router.baseUrl, apiKey: upstream.apiKey, extraHeaders: upstream.extraHeaders };
      }
      if (!started) {
        throw new Error("router service not started");
      }
      const token = tokenByProject.get(project);
      if (!token) {
        throw new Error(`router service has no token for project '${project}'`);
      }
      return { backend, baseUrl: shim.url(), token };
    },
  };
}
