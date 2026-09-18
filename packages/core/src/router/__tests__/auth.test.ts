import { describe, it, expect } from "vitest";
import { mintToken, parseBearer, resolveProject } from "../auth.js";

describe("router auth", () => {
  it("mints high-entropy unique tokens", () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it("parses a bearer header case-insensitively", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer   abc123 ")).toBe("abc123");
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });

  it("resolves the project for a known token and rejects unknown", () => {
    const tokens = new Map([["t1", "proj-a"]]);
    expect(resolveProject(tokens, "Bearer t1")).toBe("proj-a");
    expect(resolveProject(tokens, "Bearer nope")).toBeNull();
    expect(resolveProject(tokens, undefined)).toBeNull();
  });
});
