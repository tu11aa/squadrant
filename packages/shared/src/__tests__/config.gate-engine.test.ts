// P6 part C (#828): the `GateConfig.engine` selector. `router` (default) keeps
// the U7 path; `auto-gate` hands the decision to the standalone package.
import { describe, it, expect } from "vitest";
import { GATE_ENGINES, isGateEngine } from "../config.js";

describe("gate engine", () => {
  it("enumerates exactly the two engines", () => {
    expect(GATE_ENGINES).toEqual(["router", "auto-gate"]);
  });

  it("accepts every valid engine", () => {
    for (const engine of GATE_ENGINES) expect(isGateEngine(engine)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isGateEngine("routerr")).toBe(false);
    expect(isGateEngine("")).toBe(false);
    expect(isGateEngine("autogate")).toBe(false);
  });
});
