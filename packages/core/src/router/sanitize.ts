// packages/core/src/router/sanitize.ts
import type { RouterUpstream } from "./types.js";

// Anthropic executes these server-side; a third-party upstream cannot, and
// rejects the request when they are present (OpenRouter #31380; same class for
// opencode-go).
export const SERVER_TOOL_TYPE_RE = /^(bash|text_editor|str_replace_editor|computer|web_search|code_execution|memory)_\d+/;

/** Request fields only real Anthropic understands. */
export const ANTHROPIC_ONLY_REQUEST_FIELDS = ["container", "context_management", "mcp_servers"] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strip the outbound request for a non-Anthropic upstream. `cache_control` is
 *  deliberately preserved — the upstream maps cache breakpoints to its own
 *  provider-native caching (spec decision 5). */
export function sanitizeRequest(
  body: Record<string, unknown>,
  upstream: RouterUpstream,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (!upstream.isAnthropic) {
    for (const f of ANTHROPIC_ONLY_REQUEST_FIELDS) delete out[f];
    if (Array.isArray(out.tools)) {
      out.tools = out.tools.filter(
        (t) => !(isObj(t) && typeof t.type === "string" && SERVER_TOOL_TYPE_RE.test(t.type)),
      );
    }
  }
  return out;
}
