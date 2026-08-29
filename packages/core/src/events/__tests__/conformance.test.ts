import { describe, it, expect } from "vitest";
import { runAdapterConformance } from "../conformance.js";
import type { FactAdapter } from "../fact.js";

const good: FactAdapter = {
  name: "opencode-sse",
  origin: "agent",
  translate(raw) {
    const t = (raw as { type?: string } | null)?.type;
    if (t === "session.idle") return [{ kind: "turn.ended" }];
    return [{ kind: "unknown", name: typeof t === "string" ? t : "non-object" }];
  },
};

const throws: FactAdapter = {
  name: "pane", origin: "inferred",
  translate() { throw new Error("boom"); },
};

const returnsNull: FactAdapter = {
  name: "pane", origin: "inferred",
  translate() { return null as never; },
};

const swallows: FactAdapter = {
  name: "pane", origin: "inferred",
  translate(raw) {
    return (raw as { type?: string } | null)?.type === "session.idle"
      ? [{ kind: "turn.ended" }]
      : [];   // silently drops — the #542 shape
  },
};

const run = (a: FactAdapter) =>
  runAdapterConformance(a, [{ type: "session.idle" }]).map((c) => {
    try { c.run(); return { name: c.name, ok: true }; }
    catch { return { name: c.name, ok: false }; }
  });

describe("adapter conformance", () => {
  it("a well-behaved adapter passes every case", () => {
    expect(run(good).every((r) => r.ok)).toBe(true);
  });

  it("fails an adapter that throws on garbage", () => {
    expect(run(throws).some((r) => !r.ok)).toBe(true);
  });

  it("fails an adapter that returns null", () => {
    expect(run(returnsNull).some((r) => !r.ok)).toBe(true);
  });

  it("fails an adapter that silently drops an unrecognised frame", () => {
    const results = run(swallows);
    expect(results.find((r) => r.name.includes("unknown"))!.ok).toBe(false);
  });
});
