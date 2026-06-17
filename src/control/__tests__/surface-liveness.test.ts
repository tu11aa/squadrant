// src/control/__tests__/surface-liveness.test.ts
import { describe, it, expect } from "vitest";
import { surfaceVerdict } from "@cockpit/core";

// #139: the pure decision behind the daemon's interactive surface-liveness
// backstop. "gone" must mean PROVABLY absent (cmux answered, the crew's pane is
// not among the surfaces) — never an "I couldn't tell" — so a transient cmux
// outage can never false-reap a live crew.
describe("surfaceVerdict (#139)", () => {
  const WANT = "🔧 brove:crew-1";

  it("present surface list containing the crew's title → alive", () => {
    expect(surfaceVerdict(["🔧 brove:crew-1", "some-other-tab"], WANT)).toBe("alive");
  });

  it("present surface list NOT containing the crew's title → gone (provably absent)", () => {
    expect(surfaceVerdict(["some-other-tab"], WANT)).toBe("gone");
  });

  it("empty surface list (cmux up, captain found, no crew pane) → gone", () => {
    expect(surfaceVerdict([], WANT)).toBe("gone");
  });

  it("null surfaces (could not enumerate — cmux down / no captain) → unknown, never reaps", () => {
    expect(surfaceVerdict(null, WANT)).toBe("unknown");
  });

  it("null want-title (crew has no name) → unknown", () => {
    expect(surfaceVerdict(["anything"], null)).toBe("unknown");
  });
});
