// src/control/__tests__/headless-opencode.test.ts
import { describe, it, expect } from "vitest";
import { opencodeHeadless } from "../headless/opencode.js";

describe("opencode headless adapter", () => {
  it("parseResult: non-zero exit → failed with exitCode", () => {
    const out = opencodeHeadless.parseResult("some error", 1);
    expect(out).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  it("parseResult: clean JSON string result → done + string payload + sessionId from sessionID", () => {
    const out = opencodeHeadless.parseResult('{"result":"done text","sessionID":"oc-1"}', 0);
    expect(out.outcome).toBe("done");
    expect(out.payload).toBe("done text");
    expect(out.sessionId).toBe("oc-1");
  });

  it("parseResult: object result → JSON-stringified payload", () => {
    const out = opencodeHeadless.parseResult('{"result":{"files":["a.ts"]},"sessionID":"oc-2"}', 0);
    expect(out.outcome).toBe("done");
    expect(out.payload).toBe('{"files":["a.ts"]}');
  });

  it("parseResult: session_id fallback key works", () => {
    const out = opencodeHeadless.parseResult('{"result":"ok","session_id":"oc-3"}', 0);
    expect(out.outcome).toBe("done");
    expect(out.sessionId).toBe("oc-3");
  });

  it("parseResult: unparseable + exit 0 → done with parseWarning + payload=stdout", () => {
    const raw = "not valid json";
    const out = opencodeHeadless.parseResult(raw, 0);
    expect(out.outcome).toBe("done");
    expect(out.parseWarning).toBe(true);
    expect(out.payload).toBe(raw);
  });
});
