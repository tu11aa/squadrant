// This registry lives in @squadrant/cli, not @squadrant/core: enforcing it
// against every wired FactAdapter means importing adapters from every agent
// package (today: @squadrant/agents). core may not import agents (one-way
// DAG — see CLAUDE.md); cli is the one package downstream of both, and it is
// already where the daemon wires these adapters together (squadrantd.ts).
import { describe, it, expect } from "vitest";
import { runAdapterConformance } from "@squadrant/core";
import type { FactAdapter, FactSource } from "@squadrant/core";
import { createOpencodeFactAdapter } from "@squadrant/agents";

/**
 * THE enforcement rule (spec §9): every adapter registers a conformance fixture
 * here, or the build fails. This is the whole governance layer — keep it small.
 */
const REGISTRY: Array<{ adapter: FactAdapter; samples: unknown[] }> = [
  {
    adapter: createOpencodeFactAdapter({ nextRequestId: () => 1 }),
    samples: [
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { type: "permission.asked", properties: { id: "p", sessionID: "s", permission: "bash" } },
      { type: "permission.replied" },
    ],
  },
];

/** Adapters wired into the daemon today. Grow this as phases land. */
const WIRED: FactSource[] = ["opencode-sse"];

describe("adapter registry", () => {
  it("every wired adapter has a conformance fixture", () => {
    const registered = REGISTRY.map((r) => r.adapter.name);
    const missing = WIRED.filter((w) => !registered.includes(w));
    expect(missing).toEqual([]);
  });

  for (const { adapter, samples } of REGISTRY) {
    for (const c of runAdapterConformance(adapter, samples)) {
      it(c.name, () => c.run());
    }
  }
});
