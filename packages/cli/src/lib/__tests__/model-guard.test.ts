import { describe, it, expect } from "vitest";
import { isAnthropicModel, anthropicFallbackMessage, isBlockedFallback } from "../model-guard.js";

describe("isAnthropicModel", () => {
  it("is true for opencode-style anthropic/* model strings", () => {
    expect(isAnthropicModel("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isAnthropicModel("anthropic/claude-opus-4-8")).toBe(true);
  });

  it("is false for non-anthropic models", () => {
    expect(isAnthropicModel("gpt-5")).toBe(false);
    expect(isAnthropicModel("openai/gpt-5")).toBe(false);
    expect(isAnthropicModel("ollama/llama3")).toBe(false);
  });

  it("is false for undefined (no model resolved)", () => {
    expect(isAnthropicModel(undefined)).toBe(false);
  });
});

describe("anthropicFallbackMessage", () => {
  it("names the agent and the actual resolved model", () => {
    const msg = anthropicFallbackMessage("opencode", "anthropic/claude-sonnet-4-5");
    expect(msg).toContain("opencode");
    expect(msg).toContain("anthropic/claude-sonnet-4-5");
  });
});

describe("isBlockedFallback", () => {
  it("is true for a non-claude agent resolving to an anthropic model (opencode/codex/gemini)", () => {
    expect(isBlockedFallback("opencode", "anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isBlockedFallback("codex", "anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isBlockedFallback("gemini", "anthropic/claude-sonnet-4-5")).toBe(true);
  });

  it("is false for claude on an anthropic model — claude depending on Anthropic is expected, not a trap", () => {
    expect(isBlockedFallback("claude", "anthropic/claude-sonnet-4-5")).toBe(false);
  });

  it("is false for a non-claude agent on a non-anthropic model", () => {
    expect(isBlockedFallback("opencode", "gpt-5")).toBe(false);
    expect(isBlockedFallback("codex", undefined)).toBe(false);
  });
});
