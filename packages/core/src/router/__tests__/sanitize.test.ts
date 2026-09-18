import { describe, it, expect } from "vitest";
import { sanitizeRequest } from "../sanitize.js";

const nonAnthropic = { baseUrl: "https://opencode.ai/zen/go", apiKey: "k", isAnthropic: false };
const anthropic = { baseUrl: "https://api.anthropic.com", apiKey: "k", isAnthropic: true };

describe("sanitizeRequest", () => {
  it("strips Anthropic-only fields and server tools for non-Anthropic upstreams", () => {
    const body = {
      model: "deepseek-v4.1-flash",
      container: "c",
      context_management: {},
      mcp_servers: [],
      tools: [
        { type: "custom", name: "mcp__foo", input_schema: {} },
        { type: "web_search_20250305", name: "web_search" },
        { type: "bash_20250124", name: "bash" },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = sanitizeRequest(body, nonAnthropic);
    expect(out.container).toBeUndefined();
    expect(out.context_management).toBeUndefined();
    expect(out.mcp_servers).toBeUndefined();
    expect((out.tools as Array<{ type: string }>).map((t) => t.type)).toEqual(["custom"]);
  });

  it("keeps server tools when the upstream is real Anthropic", () => {
    const out = sanitizeRequest({ tools: [{ type: "bash_20250124", name: "bash" }] }, anthropic);
    expect((out.tools as unknown[]).length).toBe(1);
  });

  it("leaves cache_control untouched", () => {
    const body = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }] };
    const out = sanitizeRequest(body, nonAnthropic);
    expect((out.system as Array<{ cache_control: unknown }>)[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
