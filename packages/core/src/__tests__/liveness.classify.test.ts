// packages/core/src/__tests__/liveness.classify.test.ts
import { describe, it, expect } from "vitest";
import {
  classifyHealth,
  projectHealth,
  type ComponentHealth,
} from "../liveness.js";

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

  it("captainStopped=true → captain stopped (intentional close, distinct from fault)", () => {
    const cs = projectHealth({ ...base, now: 1_000, captainStopped: true });
    const captain = find(cs, "captain")!;
    expect(captain.state).toBe("stopped");
    // A stopped captain carries a calm, explanatory detail — not an alarm.
    expect(captain.detail).toMatch(/closed/i);
  });

  // #579/#484 Gap 3: a stuck captain-delivery deferral must surface as a
  // human-visible `detail` on the (otherwise "alive") captain row — the
  // config-free, un-muteable pull surface for `squadrant doctor` /
  // `squadrant status --detailed`.
  it("captainDeferral.stuck=true → captain row carries a DELIVERY STUCK detail even though the captain is alive", () => {
    const cs = projectHealth({
      ...base, now: 1_000, captainStopped: false,
      captainDeferral: { stuck: true, maxDeferCount: 300 },
    });
    const captain = find(cs, "captain")!;
    expect(captain.state).toBe("alive"); // captain itself is fine — delivery is what's stuck
    expect(captain.detail).toMatch(/delivery stuck/i);
    expect(captain.detail).toContain("300");
  });

  it("captainDeferral.stuck=false (or omitted) → no stuck detail on an otherwise-healthy captain", () => {
    const withStats = projectHealth({
      ...base, now: 1_000, captainStopped: false,
      captainDeferral: { stuck: false, maxDeferCount: 2 },
    });
    expect(find(withStats, "captain")!.detail).toBeUndefined();

    const omitted = projectHealth({ ...base, now: 1_000, captainStopped: false });
    expect(find(omitted, "captain")!.detail).toBeUndefined();
  });

  it("captainStopped=true wins over a stuck deferral — an intentional close explains the detail, not a stale defer count", () => {
    const cs = projectHealth({
      ...base, now: 1_000, captainStopped: true,
      captainDeferral: { stuck: true, maxDeferCount: 300 },
    });
    expect(find(cs, "captain")!.detail).toMatch(/closed/i);
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

  it("B2: flags a quiet-past-budget interactive crew with no confirmed first turn as undelivered", () => {
    const cs = projectHealth({
      ...base,
      now: 100_000,
      captainStopped: false,
      crews: [
        {
          id: "a1", name: "alpha", state: "submitted", mode: "interactive",
          lastHeartbeat: 0, heartbeatBudgetMs: 60_000, firstTurnConfirmedAt: undefined,
        },
      ],
    });
    const crew = find(cs, "crew")!;
    expect(crew.detail).toMatch(/undelivered/i);
  });

  it("B2: a crew with a confirmed first turn is never flagged undelivered, even if quiet past budget", () => {
    const cs = projectHealth({
      ...base,
      now: 100_000,
      captainStopped: false,
      crews: [
        {
          id: "a1", name: "alpha", state: "working", mode: "interactive",
          lastHeartbeat: 0, heartbeatBudgetMs: 60_000, firstTurnConfirmedAt: 1,
        },
      ],
    });
    const crew = find(cs, "crew")!;
    expect(crew.detail).not.toMatch(/undelivered/i);
  });

  it("B2: a crew still within its heartbeat budget is never flagged undelivered", () => {
    const cs = projectHealth({
      ...base,
      now: 10_000,
      captainStopped: false,
      crews: [
        {
          id: "a1", name: "alpha", state: "submitted", mode: "interactive",
          lastHeartbeat: 0, heartbeatBudgetMs: 60_000, firstTurnConfirmedAt: undefined,
        },
      ],
    });
    const crew = find(cs, "crew")!;
    expect(crew.detail).not.toMatch(/undelivered/i);
  });
});
