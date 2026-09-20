import { describe, it, expect } from "vitest";
import {
  CMUX_PRESERVE_CLAUDE_AUTH_ENV,
  buildRouterEnv,
  formatCustomHeaders,
  mergeClaudeEnvRouterSettings,
  renderEnvAssignments,
} from "../env.js";

describe("buildRouterEnv", () => {
  it("proxy: shim url + minted token + explicitly-empty API key + model", () => {
    const env = buildRouterEnv(
      { backend: "proxy", baseUrl: "http://127.0.0.1:53421", token: "minted-tok" },
      "deepseek-v4.1-flash",
    );
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:53421",
      ANTHROPIC_AUTH_TOKEN: "minted-tok",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "deepseek-v4.1-flash",
      [CMUX_PRESERVE_CLAUDE_AUTH_ENV]: "1",
    });
    // Explicitly empty, never unset — an unset key falls back to Anthropic auth.
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect("ANTHROPIC_API_KEY" in env).toBe(true);
  });

  it("direct: upstream baseUrl + real credential + custom headers", () => {
    const env = buildRouterEnv(
      {
        backend: "direct",
        baseUrl: "https://opencode.ai/zen/go",
        apiKey: "sk-live",
        extraHeaders: { "x-opencode-session": "squadrant" },
      },
      "deepseek-v4.1-flash",
    );
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
      ANTHROPIC_API_KEY: "sk-live",
      ANTHROPIC_CUSTOM_HEADERS: "x-opencode-session: squadrant",
      ANTHROPIC_MODEL: "deepseek-v4.1-flash",
      [CMUX_PRESERVE_CLAUDE_AUTH_ENV]: "1",
    });
  });

  it("omits ANTHROPIC_MODEL when no model resolved", () => {
    const env = buildRouterEnv({ backend: "proxy", baseUrl: "http://x", token: "t" }, undefined);
    expect("ANTHROPIC_MODEL" in env).toBe(false);
  });

  it("omits ANTHROPIC_CUSTOM_HEADERS when there are no extra headers", () => {
    const env = buildRouterEnv({ backend: "direct", baseUrl: "http://x", apiKey: "k" }, "m");
    expect("ANTHROPIC_CUSTOM_HEADERS" in env).toBe(false);
  });
});

// #772 D1: the per-spawn --settings env block REPLACES ~/.claude/settings.json's
// env wholesale, so a routed spawn must carry the operator's non-ANTHROPIC_*
// defaults.claudeEnv keys itself — otherwise Claude Code's unknown-model-window
// enforcement is back on and the routed model is rejected client-side.
describe("mergeClaudeEnvRouterSettings (#772 D1)", () => {
  it("folds non-ANTHROPIC claudeEnv keys into the router env", () => {
    const merged = mergeClaudeEnvRouterSettings(
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:53421", ANTHROPIC_API_KEY: "" },
      {
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
        CLAUDE_AFK_TIMEOUT_MS: "240000",
      },
    );
    expect(merged).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:53421",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
      CLAUDE_AFK_TIMEOUT_MS: "240000",
    });
  });

  it("never lets a claudeEnv ANTHROPIC_* key shadow the router (router wins)", () => {
    const merged = mergeClaudeEnvRouterSettings(
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:53421", ANTHROPIC_MODEL: "deepseek-v4.1-flash" },
      {
        ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
        ANTHROPIC_API_KEY: "sk-upstream",
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
      },
    );
    expect(merged.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:53421");
    expect(merged.ANTHROPIC_MODEL).toBe("deepseek-v4.1-flash");
    expect("ANTHROPIC_API_KEY" in merged).toBe(false);
  });

  it("returns a fresh object and tolerates an absent claudeEnv", () => {
    const routerEnv = { ANTHROPIC_BASE_URL: "http://x" };
    const merged = mergeClaudeEnvRouterSettings(routerEnv, undefined);
    expect(merged).toEqual(routerEnv);
    expect(merged).not.toBe(routerEnv);
    expect(mergeClaudeEnvRouterSettings(routerEnv, {})).not.toBe(routerEnv);
  });
});

describe("formatCustomHeaders", () => {
  it("joins pairs with newlines in the Name: Value format Claude Code expects", () => {
    expect(formatCustomHeaders({ "x-api-key": "a", "x-session": "b" })).toBe(
      "x-api-key: a\nx-session: b",
    );
  });

  it("returns undefined for empty/absent headers", () => {
    expect(formatCustomHeaders(undefined)).toBeUndefined();
    expect(formatCustomHeaders({})).toBeUndefined();
  });
});

describe("renderEnvAssignments", () => {
  it("renders a deterministic single-line prefix", () => {
    expect(renderEnvAssignments({ B: "2", A: "1" })).toBe("A=$'1' B=$'2'");
  });

  it("keeps a newline inside a value from becoming a command separator", () => {
    const line = renderEnvAssignments({ ANTHROPIC_CUSTOM_HEADERS: "a: 1\nb: 2" });
    // `\x0a` (not `\n`) — cmux's sanitizeForCmuxSend() would collapse a literal
    // `\n` escape to a space and silently drop every header but the first.
    expect(line).toBe("ANTHROPIC_CUSTOM_HEADERS=$'a: 1\\x0ab: 2'");
    expect(line).not.toContain("\n");
  });

  it("escapes quotes and backslashes", () => {
    expect(renderEnvAssignments({ K: "it's\\ok" })).toBe("K=$'it\\'s\\\\ok'");
  });
});
