import { describe, it, expect } from "vitest";
import { THINKING_LEVELS, isThinkingLevel, parseThinkingLevel } from "../config.js";

describe("thinking level", () => {
  it("enumerates exactly the five levels the claude CLI accepts", () => {
    expect(THINKING_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("accepts every valid level", () => {
    for (const level of THINKING_LEVELS) {
      expect(isThinkingLevel(level)).toBe(true);
      expect(parseThinkingLevel(level)).toBe(level);
    }
  });

  // Fail fast rather than passing a typo through for the claude CLI to warn
  // about and silently ignore.
  it("rejects an invalid level with a message listing the valid values", () => {
    expect(() => parseThinkingLevel("bogus")).toThrow(
      "Invalid --thinking value 'bogus'. Valid values: low, medium, high, xhigh, max",
    );
    expect(isThinkingLevel("bogus")).toBe(false);
  });

  // `defaults.effort` is the crew tokenomics dial (max|balance|low) — a
  // different concept that happens to share the word "max".
  it("does not accept the tokenomics-dial values that aren't also thinking levels", () => {
    expect(isThinkingLevel("balance")).toBe(false);
  });
});
