// src/control/__tests__/headless-claude.test.ts
import { describe, it, expect } from "vitest";
import { claudeHeadless } from "../headless/claude.js";

describe("claude headless adapter", () => {
  it("buildCommand emits print + json + the task", () => {
    const argv = claudeHeadless.buildCommand("fix the bug");
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("-p");
    expect(argv.join(" ")).toContain("--output-format json");
    expect(argv).toContain("fix the bug");
  });

  it("buildCommand with sessionId adds --resume", () => {
    const argv = claudeHeadless.buildCommand("more", "sess-1");
    expect(argv.join(" ")).toContain("--resume sess-1");
  });

  it("parseResult: exit 0 + JSON result → done with sessionId", () => {
    const out = claudeHeadless.parseResult('{"result":"ok","session_id":"s9","is_error":false}', 0);
    expect(out).toEqual({ outcome: "done", sessionId: "s9", payload: "ok" });
  });

  it("parseResult: is_error true → failed", () => {
    const out = claudeHeadless.parseResult('{"result":"bad","is_error":true}', 0);
    expect(out.outcome).toBe("failed");
  });

  it("parseResult: non-zero exit → failed with exitCode", () => {
    const out = claudeHeadless.parseResult("crashed", 1);
    expect(out).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  it("parseResult: exit 0 but unparseable → done with parseWarning", () => {
    const out = claudeHeadless.parseResult("not json", 0);
    expect(out).toMatchObject({ outcome: "done", parseWarning: true });
  });

  it("parseResult: object result → JSON-stringified payload (not [object Object])", () => {
    const out = claudeHeadless.parseResult('{"result":{"key":"val"},"session_id":"s1","is_error":false}', 0);
    expect(out.outcome).toBe("done");
    expect(out.payload).toBe('{"key":"val"}');
    expect(out.payload).not.toBe("[object Object]");
  });

  it("parseResult: null result → payload is empty string", () => {
    const out = claudeHeadless.parseResult('{"result":null,"session_id":"s2","is_error":false}', 0);
    expect(out.outcome).toBe("done");
    expect(out.payload).toBe("");
  });

  it("parseResult: success JSON with no session_id → sessionId undefined", () => {
    const out = claudeHeadless.parseResult('{"result":"hi","is_error":false}', 0);
    expect(out.outcome).toBe("done");
    expect(out.sessionId).toBeUndefined();
  });

  it("parseResult: is_error true with no result field → outcome failed with fallback error", () => {
    const out = claudeHeadless.parseResult('{"is_error":true}', 0);
    expect(out.outcome).toBe("failed");
    expect(out.error).toBe("is_error");
  });
});
