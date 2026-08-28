import { describe, it, expect } from "vitest";
import { resolveLaunchAgent } from "../launch-agent-resolve.js";

describe("resolveLaunchAgent", () => {
  it("falls back to config exactly as today when no CLI flags are passed", () => {
    const result = resolveLaunchAgent({}, { agent: "codex", model: "gpt-5-high" }, "sonnet");
    expect(result).toEqual({ agentName: "codex", model: "gpt-5-high" });
  });

  it("falls back to 'claude' and the role's default model when config has no roleConfig at all", () => {
    const result = resolveLaunchAgent({}, undefined, "sonnet");
    expect(result).toEqual({ agentName: "claude", model: "sonnet" });
  });

  it("an explicit --agent flag wins over defaults.roles.captain.agent", () => {
    const result = resolveLaunchAgent({ agent: "opencode" }, { agent: "claude", model: "sonnet" }, undefined);
    expect(result.agentName).toBe("opencode");
  });

  it("an explicit --model flag wins over defaults.roles.captain.model", () => {
    const result = resolveLaunchAgent({ model: "gpt-5" }, { agent: "codex", model: "gpt-5-high" }, undefined);
    expect(result.model).toBe("gpt-5");
  });

  it("both explicit flags win together", () => {
    const result = resolveLaunchAgent(
      { agent: "opencode", model: "kimi-k2" },
      { agent: "claude", model: "sonnet" },
      "opus",
    );
    expect(result).toEqual({ agentName: "opencode", model: "kimi-k2" });
  });

  it("--agent without --model still falls back to config's model for that role", () => {
    const result = resolveLaunchAgent({ agent: "opencode" }, { agent: "claude", model: "sonnet" }, undefined);
    expect(result).toEqual({ agentName: "opencode", model: "sonnet" });
  });

  it("picks up defaults.roles.captain.thinking when no --thinking flag is passed", () => {
    const result = resolveLaunchAgent({}, { agent: "claude", model: "fable", thinking: "medium" }, undefined);
    expect(result.thinking).toBe("medium");
  });

  it("an explicit --thinking flag wins over defaults.roles.captain.thinking", () => {
    const result = resolveLaunchAgent(
      { thinking: "max" },
      { agent: "claude", model: "fable", thinking: "medium" },
      undefined,
    );
    expect(result.thinking).toBe("max");
  });

  it("leaves thinking undefined when neither flag nor config sets it (no built-in default)", () => {
    const result = resolveLaunchAgent({}, { agent: "claude", model: "sonnet" }, undefined);
    expect(result.thinking).toBeUndefined();
  });
});
