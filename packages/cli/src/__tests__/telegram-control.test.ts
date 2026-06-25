import { describe, it, expect } from "vitest";
import { capOutput } from "@squadrant/core";

describe("capOutput", () => {
  it("returns trimmed stdout when present", () => {
    expect(capOutput("  hello\n", "")).toBe("hello");
  });

  it("appends a stderr tail when stderr is non-empty", () => {
    const out = capOutput("ok", "a warning");
    expect(out).toContain("ok");
    expect(out).toContain("a warning");
  });

  it("falls back to a placeholder when both streams are empty", () => {
    expect(capOutput("", "")).toBe("(no output)");
  });

  it("caps overly long output and marks truncation", () => {
    const long = "x".repeat(5000);
    const out = capOutput(long, "", 3500);
    expect(out.length).toBeLessThanOrEqual(3500 + 20);
    expect(out).toContain("truncated");
  });
});
