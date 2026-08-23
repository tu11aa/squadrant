import { describe, it, expect } from "vitest";
import { isAnthropicModel, anthropicFallbackMessage, isBlockedFallback, anthropicRefusalMessage } from "../model-guard.js";

describe("isAnthropicModel", () => {
  it("is true for opencode-style anthropic/* model strings", () => {
    expect(isAnthropicModel("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isAnthropicModel("anthropic/claude-opus-4-8")).toBe(true);
  });

  it("is true for bare claude-* model strings with no provider prefix", () => {
    expect(isAnthropicModel("claude-sonnet-4-5")).toBe(true);
    expect(isAnthropicModel("claude-opus-4-8")).toBe(true);
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

  it("is true for a non-claude agent resolving to a bare claude-* model name (no provider prefix)", () => {
    expect(isBlockedFallback("opencode", "claude-sonnet-4-5")).toBe(true);
    expect(isBlockedFallback("codex", "claude-opus-4-8")).toBe(true);
  });

  it("is false for claude on an anthropic model — claude depending on Anthropic is expected, not a trap", () => {
    expect(isBlockedFallback("claude", "anthropic/claude-sonnet-4-5")).toBe(false);
    expect(isBlockedFallback("claude", "claude-sonnet-4-5")).toBe(false);
  });

  it("is false for a non-claude agent on a non-anthropic model", () => {
    expect(isBlockedFallback("opencode", "gpt-5")).toBe(false);
    expect(isBlockedFallback("codex", undefined)).toBe(false);
  });
});

describe("anthropicRefusalMessage — role-agnostic by design (#627 follow-up)", () => {
  it("applies identically to captain, command, and side — no per-role branching", () => {
    for (const role of ["captain", "command", "side"]) {
      const msg = anthropicRefusalMessage(role, "myproj-captain", "opencode", "anthropic/claude-sonnet-4-5");
      expect(msg).toContain(`Refusing to launch ${role} 'myproj-captain'`);
      expect(msg).toContain("opencode");
      expect(msg).toContain("anthropic/claude-sonnet-4-5");
    }
  });
});
