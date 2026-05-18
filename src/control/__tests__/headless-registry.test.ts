// src/control/__tests__/headless-registry.test.ts
import { describe, it, expect } from "vitest";
import { getHeadlessAdapter } from "../headless/registry.js";

describe("headless registry", () => {
  it("resolves claude/opencode/codex adapters", () => {
    expect(getHeadlessAdapter("claude").provider).toBe("claude");
    expect(getHeadlessAdapter("opencode").provider).toBe("opencode");
    expect(getHeadlessAdapter("codex").provider).toBe("codex");
  });

  it("codex buildCommand uses `codex exec --json`", () => {
    const argv = getHeadlessAdapter("codex").buildCommand("do x");
    expect(argv.join(" ")).toContain("codex exec");
    expect(argv.join(" ")).toContain("--json");
  });

  it("codex parseResult: exit 0 → done; exit≠0 → failed", () => {
    const a = getHeadlessAdapter("codex");
    expect(a.parseResult("{}", 0).outcome).toBe("done");
    expect(a.parseResult("err", 3)).toMatchObject({ outcome: "failed", exitCode: 3 });
  });

  it("unknown provider throws", () => {
    expect(() => getHeadlessAdapter("aider")).toThrow(/no headless adapter/i);
  });
});
