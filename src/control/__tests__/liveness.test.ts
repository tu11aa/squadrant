// src/control/__tests__/liveness.test.ts
import { describe, it, expect } from "vitest";
import {
  classifyHealth,
  projectHealth,
  relayActionable,
  RELAY_STALE_MS,
  RELAY_GONE_MS,
  type RelayHealth,
  type ComponentHealth,
} from "../liveness.js";

const relay = (o: Partial<RelayHealth> = {}): RelayHealth => ({
  project: "p",
  pid: 123,
  startedAt: 0,
  lastSeenMs: 1_000,
  ...o,
});

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

describe("relayActionable", () => {
  it("names the project and the recovery command", () => {
    const msg = relayActionable("brove");
    expect(msg).toContain("brove");
    expect(msg).toContain("cockpit launch brove");
  });
});

describe("projectHealth (pure projection)", () => {
  const base = {
    project: "p",
    captainName: "p-captain",
    captainPresent: true as boolean | null,
    commandPresent: null as boolean | null,
    crews: [],
  };

  it("registered relay seen recently → relay alive", () => {
    const now = 1_000 + RELAY_STALE_MS; // exactly at stale boundary = alive
    const cs = projectHealth({ ...base, now, relay: relay({ lastSeenMs: 1_000 }) });
    const r = find(cs, "relay")!;
    expect(r.state).toBe("alive");
    expect(r.lastSeenMs).toBe(1_000);
  });

  it("registered relay gone silent → relay gone WITH actionable detail (never silently blind)", () => {
    const now = 1_000 + RELAY_GONE_MS + 1;
    const cs = projectHealth({ ...base, now, relay: relay({ lastSeenMs: 1_000 }) });
    const r = find(cs, "relay")!;
    expect(r.state).toBe("gone");
    expect(r.detail).toContain("cockpit launch p");
  });

  it("no relay registered but captain live → relay gone (a live captain SHOULD have a relay)", () => {
    const cs = projectHealth({ ...base, now: 10_000, relay: null, captainPresent: true });
    expect(find(cs, "relay")!.state).toBe("gone");
  });

  it("no relay registered and captain absent → relay unknown (nothing should be running)", () => {
    const cs = projectHealth({ ...base, now: 10_000, relay: null, captainPresent: false });
    expect(find(cs, "relay")!.state).toBe("unknown");
  });

  it("captain presence maps directly (no timestamp): true→alive, false→gone, null→unknown", () => {
    expect(find(projectHealth({ ...base, now: 1, relay: null, captainPresent: true }), "captain")!.state).toBe("alive");
    expect(find(projectHealth({ ...base, now: 1, relay: null, captainPresent: false }), "captain")!.state).toBe("gone");
    expect(find(projectHealth({ ...base, now: 1, relay: null, captainPresent: null }), "captain")!.state).toBe("unknown");
  });

  it("command omitted (commandPresent null) → no command row (command is on-demand)", () => {
    const cs = projectHealth({ ...base, now: 1, relay: null, commandPresent: null });
    expect(find(cs, "command")).toBeUndefined();
  });

  it("emits one crew row per non-terminal crew, skipping terminal ones", () => {
    const cs = projectHealth({
      ...base,
      now: 1_000,
      relay: relay(),
      crews: [
        { id: "a1", name: "alpha", state: "working", lastHeartbeat: 900, mode: "interactive" },
        { id: "b2", name: "beta", state: "done", lastHeartbeat: 900, mode: "interactive" },
        { id: "c3", name: "gamma", state: "awaiting-input", lastHeartbeat: 900, mode: "interactive" },
      ],
    });
    const crews = cs.filter((c) => c.kind === "crew");
    expect(crews.map((c) => c.ref).sort()).toEqual(["alpha", "gamma"]);
  });
});
