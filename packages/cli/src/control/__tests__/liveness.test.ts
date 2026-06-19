// src/control/__tests__/liveness.test.ts
import { describe, it, expect } from "vitest";
import {
  classifyHealth,
  projectHealth,
  type ComponentHealth,
} from "@cockpit/core";

const find = (cs: ComponentHealth[], kind: ComponentHealth["kind"]) =>
  cs.find((c) => c.kind === kind);

describe("classifyHealth (pure)", () => {
  it("null last-seen → unknown", () => {
    expect(classifyHealth(null, 10_000, 1_000, 2_000)).toBe("unknown");
  });
  it("within stale window → alive", () => {
    expect(classifyHealth(1_000, 1_500, 1_000, 2_000)).toBe("alive");
  });
  it("exactly at stale boundary → alive (inclusive)", () => {
    expect(classifyHealth(1_000, 2_000, 1_000, 2_000)).toBe("alive");
  });
  it("past stale but within gone window → stale", () => {
    expect(classifyHealth(1_000, 2_500, 1_000, 2_000)).toBe("stale");
  });
  it("exactly at gone boundary → stale (inclusive)", () => {
    expect(classifyHealth(1_000, 3_000, 1_000, 2_000)).toBe("stale");
  });
  it("past gone window → gone", () => {
    expect(classifyHealth(1_000, 3_001, 1_000, 2_000)).toBe("gone");
  });
});

describe("projectHealth (pure projection)", () => {
  const base = {
    project: "p",
    captainName: "p-captain",
    commandPresent: null as boolean | null,
    crews: [],
  };

  it("captainStopped=false → captain alive", () => {
    const cs = projectHealth({ ...base, now: 1_000, captainStopped: false });
    expect(find(cs, "captain")!.state).toBe("alive");
  });

  it("captainStopped=true → captain gone", () => {
    const cs = projectHealth({ ...base, now: 1_000, captainStopped: true });
    expect(find(cs, "captain")!.state).toBe("gone");
  });

  it("captainStopped=null → captain unknown (no signal yet)", () => {
    const cs = projectHealth({ ...base, now: 1_000, captainStopped: null });
    expect(find(cs, "captain")!.state).toBe("unknown");
  });

  it("command omitted (commandPresent null) → no command row (command is on-demand)", () => {
    const cs = projectHealth({ ...base, now: 1, captainStopped: null, commandPresent: null });
    expect(find(cs, "command")).toBeUndefined();
  });

  it("emits one crew row per non-terminal crew, skipping terminal ones", () => {
    const cs = projectHealth({
      ...base,
      now: 1_000,
      captainStopped: false,
      crews: [
        { id: "a1", name: "alpha", state: "working", lastHeartbeat: 900, mode: "interactive" },
        { id: "b2", name: "beta", state: "done", lastHeartbeat: 900, mode: "interactive" },
        { id: "c3", name: "gamma", state: "awaiting-input", lastHeartbeat: 900, mode: "interactive" },
      ],
    });
    const crews = cs.filter((c) => c.kind === "crew");
    expect(crews.map((c) => c.ref).sort()).toEqual(["alpha", "gamma"]);
  });

  it("no relay row emitted (relay kind removed)", () => {
    const cs = projectHealth({ ...base, now: 1_000, captainStopped: null });
    const kinds = cs.map((c) => c.kind);
    expect(kinds).not.toContain("relay" as never);
  });
});
