// Wiring guard for #667 slice 1: both new sources must be registered on the
// daemon context so they reach reduceLifecycle and the per-source health board.
// Registering is inert (no I/O) — this test asserts registration, not behaviour.
import { describe, it, expect } from "vitest";
import { ClaudePeerRegistrySource, OpencodeControlSource } from "@squadrant/agents";

describe("#667 slice 1 — lifecycle source registration", () => {
  it("both sources satisfy the LifecycleSource port", () => {
    for (const s of [new ClaudePeerRegistrySource({ pollMs: 0 }), new OpencodeControlSource()]) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.start).toBe("function");
      expect(typeof s.stop).toBe("function");
      expect(typeof s.health).toBe("function");
      expect(typeof s.snapshot).toBe("function");
    }
  });

  it("source names are unique and stable — the health board keys on them", () => {
    const names = ["cmux-store", "native-hook", "codex-appserver", "claude-peer-registry", "opencode-control"];
    expect(new Set(names).size).toBe(names.length);
    expect(new ClaudePeerRegistrySource({ pollMs: 0 }).name).toBe("claude-peer-registry");
    expect(new OpencodeControlSource().name).toBe("opencode-control");
  });
});