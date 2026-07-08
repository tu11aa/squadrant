import { describe, it, expect } from "vitest";
import { isCaptainAliveFromHealth } from "../control.js";
import type { ComponentHealth } from "../../liveness.js";

const row = (state: string): ComponentHealth =>
  ({ kind: "captain", project: "p", ref: "c", state: state as any, lastSeenMs: null });

describe("isCaptainAliveFromHealth", () => {
  it("alive → true", () => expect(isCaptainAliveFromHealth([row("alive")], "p")).toBe(true));
  it("gone (crash) → false → boot", () => expect(isCaptainAliveFromHealth([row("gone")], "p")).toBe(false));
  it("stopped (closed) → false → boot", () => expect(isCaptainAliveFromHealth([row("stopped")], "p")).toBe(false));
  it("unknown/missing → false", () => expect(isCaptainAliveFromHealth([], "p")).toBe(false));
});
