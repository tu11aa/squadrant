import { describe, it, expect } from "vitest";
import { resolveContextBudget, DEFAULT_CONTEXT_BUDGET } from "../index.js";

describe("resolveContextBudget (#1015)", () => {
  it("defaults: enabled, 150k soft, 350k hard, 150k crew", () => {
    expect(resolveContextBudget(undefined, {})).toEqual({ enabled: true, captainSoft: 150_000, captainHard: 350_000, crewSoft: 150_000, crewGate: 250_000, warmNudge: true, warmNudgeIdleMin: 50, warmNudgeCtx: 100_000 });
    expect(DEFAULT_CONTEXT_BUDGET.captainHard).toBe(350_000);
  });
  it("layers built-in → global → project, per key", () => {
    const b = resolveContextBudget({ captainSoft: 120_000, crewSoft: 100_000 }, { contextBudget: { captainSoft: 200_000, enabled: false } });
    expect(b).toEqual({ enabled: false, captainSoft: 200_000, captainHard: 350_000, crewSoft: 100_000, crewGate: 250_000, warmNudge: true, warmNudgeIdleMin: 50, warmNudgeCtx: 100_000 });
  });
  it("crewGate layers per project like the other thresholds (#1126)", () => {
    expect(resolveContextBudget({ crewGate: 300_000 }, { contextBudget: { crewGate: 200_000 } }).crewGate).toBe(200_000);
    expect(resolveContextBudget({ crewGate: -1 }, {}).crewGate).toBe(250_000);
  });
  it("ignores junk values instead of silently disabling a limit", () => {
    const b = resolveContextBudget({ captainSoft: -1, captainHard: NaN, crewSoft: "x" as unknown as number }, {});
    expect(b).toEqual(DEFAULT_CONTEXT_BUDGET);
  });
});
