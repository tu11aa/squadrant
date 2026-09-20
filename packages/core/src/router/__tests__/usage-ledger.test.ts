// packages/core/src/router/__tests__/usage-ledger.test.ts
import { describe, it, expect } from "vitest";
import { createUsageLedger } from "../usage-ledger.js";

describe("createUsageLedger", () => {
  it("accumulates requests and cost per project, grouped by model", () => {
    const ledger = createUsageLedger();
    ledger.record({ project: "p", model: "m-a", costUsd: 0.01, inputTokens: 10, outputTokens: 2 });
    ledger.record({ project: "p", model: "m-a", costUsd: 0.02, inputTokens: 5, outputTokens: 1 });
    ledger.record({ project: "p", model: "m-b", costUsd: 0.03, inputTokens: 7, outputTokens: 3 });

    const u = ledger.project("p");
    expect(u).toBeDefined();
    expect(u!.requests).toBe(3);
    expect(u!.costUsd).toBeCloseTo(0.06);
    expect(u!.models["m-a"]).toMatchObject({ requests: 2, costUsd: 0.03, inputTokens: 15, outputTokens: 3 });
    expect(u!.models["m-b"]).toMatchObject({ requests: 1, costUsd: 0.03, inputTokens: 7, outputTokens: 3 });
  });

  it("buckets requests with no model under 'unknown'", () => {
    const ledger = createUsageLedger();
    ledger.record({ project: "p", costUsd: 0.004 });
    expect(ledger.project("p")!.models.unknown).toMatchObject({ requests: 1, costUsd: 0.004 });
  });

  it("keeps projects separate and returns undefined for an unseen project", () => {
    const ledger = createUsageLedger();
    ledger.record({ project: "a", model: "m", costUsd: 0.5 });
    ledger.record({ project: "b", model: "m", costUsd: 0.7 });
    expect(ledger.project("a")!.costUsd).toBe(0.5);
    expect(ledger.project("b")!.costUsd).toBe(0.7);
    expect(ledger.project("c")).toBeUndefined();
  });

  it("treats a missing cost as 0 but still counts the request", () => {
    const ledger = createUsageLedger();
    ledger.record({ project: "p", model: "m", outputTokens: 4 });
    expect(ledger.project("p")).toMatchObject({ requests: 1, costUsd: 0 });
    expect(ledger.project("p")!.models.m).toMatchObject({ requests: 1, costUsd: 0, outputTokens: 4 });
  });

  it("snapshot lists every project seen", () => {
    const ledger = createUsageLedger();
    ledger.record({ project: "a", costUsd: 1 });
    ledger.record({ project: "b", costUsd: 2 });
    expect(ledger.snapshot().map((p) => p.project).sort()).toEqual(["a", "b"]);
  });
});
