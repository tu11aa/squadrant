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
} from "@cockpit/core";

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

  it("no relay registered → relay unknown (no cmux probe available from daemon; #239)", () => {
    // Without captainPresent (cmux-denied from launchd), we can't distinguish
    // "captain alive but relay dead" from "nothing running" → unknown, not gone.
    const cs = projectHealth({ ...base, now: 10_000, relay: null });
    expect(find(cs, "relay")!.state).toBe("unknown");
  });

  it("command omitted (commandPresent null) → no command row (command is on-demand)", () => {
    const cs = projectHealth({ ...base, now: 1, relay: null, commandPresent: null });
    expect(find(cs, "command")).toBeUndefined();
  });

  // ── captain liveness from relay heartbeat (Phase A / #239) ────────────────

  it("relay heartbeat fresh → captain alive", () => {
    const now = 1_000 + RELAY_STALE_MS; // exactly at stale boundary = alive
    const cs = projectHealth({ ...base, now, relay: relay({ lastSeenMs: 1_000 }) });
    const c = find(cs, "captain")!;
    expect(c.state).toBe("alive");
    expect(c.lastSeenMs).toBe(1_000); // relay timestamp surfaces as captain's last-seen
  });

  it("relay heartbeat gone → captain gone (relay-presence IS the captain signal)", () => {
    const now = 1_000 + RELAY_GONE_MS + 1; // relay past gone window
    const cs = projectHealth({ ...base, now, relay: relay({ lastSeenMs: 1_000 }) });
    expect(find(cs, "captain")!.state).toBe("gone");
  });

  it("no relay registered → captain unknown (no signal, no alarm)", () => {
    const cs = projectHealth({ ...base, now: 10_000, relay: null });
    expect(find(cs, "captain")!.state).toBe("unknown");
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
