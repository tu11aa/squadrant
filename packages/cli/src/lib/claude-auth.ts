// packages/cli/src/lib/claude-auth.ts
// #826: credential detection for `squadrant init`. A fresh install must not
// silently default to preset A (Claude Code Pro/Max) when the machine has no
// Anthropic credential. `claude auth status` prints a small JSON object with a
// `loggedIn` boolean; we treat anything else as "not authenticated" so a probe
// failure can never be mistaken for real Claude access (fail-closed).

import { execSync } from "node:child_process";

export interface ClaudeAuthStatus {
  /** true ONLY when the CLI explicitly reports a logged-in session. */
  authenticated: boolean;
  method?: string;
  provider?: string;
  /** Set when the probe could not produce a trustworthy status. */
  reason?: string;
}

/** Parse `claude auth status` stdout. Returns null when it isn't a JSON object
 *  carrying a boolean `loggedIn` — never guesses. Pure. */
export function parseClaudeAuthStatus(raw: string): ClaudeAuthStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.loggedIn !== "boolean") return null;
  return {
    authenticated: obj.loggedIn,
    method: typeof obj.authMethod === "string" ? obj.authMethod : undefined,
    provider: typeof obj.apiProvider === "string" ? obj.apiProvider : undefined,
  };
}

export interface ClaudeAuthProbe {
  /** Injected in tests: return stdout or throw. Defaults to spawning the CLI. */
  run?: () => string;
}

/** Probe the local `claude` CLI for an Anthropic credential. Never throws —
 *  a missing/unreadable/erroring CLI degrades to `{ authenticated: false }`. */
export function detectClaudeAuth(probe: ClaudeAuthProbe = {}): ClaudeAuthStatus {
  const run =
    probe.run ??
    (() =>
      execSync("claude auth status", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }));
  try {
    const parsed = parseClaudeAuthStatus(run());
    return parsed ?? { authenticated: false, reason: "unreadable `claude auth status` output" };
  } catch {
    return { authenticated: false, reason: "`claude auth status` unavailable" };
  }
}
