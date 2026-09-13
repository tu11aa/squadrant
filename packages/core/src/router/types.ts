// packages/core/src/router/types.ts
// U1 public surface. The seam is "any endpoint that speaks Anthropic Messages";
// squadrant never speaks the OpenAI protocol (spec decision 1).
export type { BackendMode } from "@squadrant/shared";

export interface RouterUpstream {
  /** Origin + base path, WITH NO VERSION SEGMENT (`/v1` is appended by the
   *  client automatically). e.g. "https://opencode.ai/zen/go" or
   *  "http://127.0.0.1:3456". Never include `/v1`, or the request becomes
   *  `/…/v1/v1/messages` and 404s. */
  baseUrl: string;
  /** Upstream credential. Sent in the header named by `authHeader`. */
  apiKey: string;
  /** Header used to send `apiKey`. `"Authorization"` → `Authorization: Bearer <key>`
   *  (default); `"x-api-key"` → `x-api-key: <key>` (opencode-go). */
  authHeader?: string;
  /** Extra headers merged into every upstream request, e.g.
   *  { "x-opencode-session": "<id>" } — required by opencode-go (missing ⇒ 400
   *  MissingSessionID). */
  extraHeaders?: Record<string, string>;
  /** true when the upstream is real Anthropic. When false/absent, Anthropic-only
   *  server tools + request fields are stripped (spec decision 5). */
  isAnthropic?: boolean;
}

export interface RouterUsage {
  project: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface RouterHealth {
  ready: boolean;
  upstreamReachable: boolean;
  lastError?: string;
}

export interface RouterShimOptions {
  upstream: RouterUpstream;
  /** Bearer token -> project id. Minted by the daemon; never logged. */
  projectTokens: Map<string, string>;
  /** 0 => ephemeral port (default). */
  port?: number;
  /** Default "127.0.0.1". */
  host?: string;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
  /** Best-effort usage/cost sink. Must never throw. */
  onUsage?: (u: RouterUsage) => void;
  log?: (m: string) => void;
}

export interface RouterShim {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Base URL clients point ANTHROPIC_BASE_URL at, e.g. http://127.0.0.1:53421 */
  url(): string;
  health(): Promise<RouterHealth>;
}
