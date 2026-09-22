import { describe, it, expect } from "vitest";
import { isCaptainAliveFromHealth, captainAliveStateFromHealth } from "../control.js";
import type { ComponentHealth } from "../../liveness.js";

const row = (state: string): ComponentHealth =>
  ({ kind: "captain", project: "p", ref: "c", state: state as any, lastSeenMs: null });

describe("isCaptainAliveFromHealth", () => {
  it("alive → true", () => expect(isCaptainAliveFromHealth([row("alive")], "p")).toBe(true));
  it("gone (crash) → false → boot", () => expect(isCaptainAliveFromHealth([row("gone")], "p")).toBe(false));
  it("stopped (closed) → false → boot", () => expect(isCaptainAliveFromHealth([row("stopped")], "p")).toBe(false));
  it("unknown/missing → false", () => expect(isCaptainAliveFromHealth([], "p")).toBe(false));
});

// #834: a transient/unknown probe must not be reported as "unreachable". The
// tri-state distinguishes a definitively-down captain from one we simply could
// not observe.
describe("captainAliveStateFromHealth", () => {
  it("alive → 'alive'", () => expect(captainAliveStateFromHealth([row("alive")], "p")).toBe("alive"));
  it("gone (crash) → 'dead'", () => expect(captainAliveStateFromHealth([row("gone")], "p")).toBe("dead"));
  it("stopped (closed) → 'dead'", () => expect(captainAliveStateFromHealth([row("stopped")], "p")).toBe("dead"));
  it("unknown → 'unknown' (not dead)", () => expect(captainAliveStateFromHealth([row("unknown")], "p")).toBe("unknown"));
  it("stale → 'unknown' (not dead)", () => expect(captainAliveStateFromHealth([row("stale")], "p")).toBe("unknown"));
  it("missing row → 'unknown' (not dead)", () => expect(captainAliveStateFromHealth([], "p")).toBe("unknown"));
});
