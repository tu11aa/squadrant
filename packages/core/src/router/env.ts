// packages/core/src/router/env.ts
// U3: build the process-env contract a routed `claude` spawn must carry.
// The names are U1's contract (docs/specs/2026-09-11-router-transport-u1-design.md
// §"Env contract"). Pure — no I/O — so the contract is unit-testable in isolation.

/** cmux's claude wrapper unsets ANTHROPIC_API_KEY / ANTHROPIC_MODEL /
 *  ANTHROPIC_SMALL_FAST_MODEL / CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
 *  when IN_CMUX=1 unless this is set (#775 precondition 2). Without it the wrapper
 *  silently drops the auth selection and claude reports "Not logged in". */
export const CMUX_PRESERVE_CLAUDE_AUTH_ENV = "CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV";

/** Router credential shape this module consumes (structurally RouterCredentials). */
export interface RouterEnvCredentials {
  backend: "direct" | "proxy";
  baseUrl: string;
  /** proxy: the daemon-minted per-project bearer token. */
  token?: string;
  /** direct: the real upstream credential. */
  apiKey?: string;
  /** direct: static headers placed in ANTHROPIC_CUSTOM_HEADERS. */
  extraHeaders?: Record<string, string>;
}

/** Build the env assignments a routed claude spawn must carry.
 *  `proxy` points claude at the daemon's loopback shim; `direct` at the upstream.
 *  `native` never reaches here — it injects nothing (byte-for-byte unchanged). */
export function buildRouterEnv(
  creds: RouterEnvCredentials,
  model: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: creds.baseUrl,
    // Empty string, never unset: an unset key lets Claude Code fall back to
    // authenticating against Anthropic directly (U1 §Env contract).
    ANTHROPIC_API_KEY: creds.backend === "direct" ? (creds.apiKey ?? "") : "",
    [CMUX_PRESERVE_CLAUDE_AUTH_ENV]: "1",
  };
  if (creds.backend === "proxy") {
    env.ANTHROPIC_AUTH_TOKEN = creds.token ?? "";
  } else {
    const headers = formatCustomHeaders(creds.extraHeaders);
    if (headers) env.ANTHROPIC_CUSTOM_HEADERS = headers;
  }
  if (model) env.ANTHROPIC_MODEL = model;
  return env;
}

/** `ANTHROPIC_CUSTOM_HEADERS` is one `Name: Value` pair per line. */
export function formatCustomHeaders(
  headers: Record<string, string> | undefined,
): string | undefined {
  const entries = Object.entries(headers ?? {});
  if (entries.length === 0) return undefined;
  return entries.map(([name, value]) => `${name}: ${value}`).join("\n");
}

/** Render env assignments as a single-line shell prefix.
 *  Values are ANSI-C quoted (`$'…'`) so spaces, quotes, and the newline inside
 *  ANTHROPIC_CUSTOM_HEADERS survive — the spawn line is typed into a terminal, so
 *  a literal newline would be read as Enter and submit a truncated command. */
export function renderEnvAssignments(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${ansiCQuote(env[key] ?? "")}`)
    .join(" ");
}

function ansiCQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");
  return `$'${escaped}'`;
}
