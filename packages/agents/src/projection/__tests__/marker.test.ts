import { describe, it, expect } from "vitest";
import { mergeWithMarkers, MARKER_START, MARKER_END } from "../marker.js";

describe("mergeWithMarkers", () => {
  it("wraps generated content in markers when existing is null", () => {
    const out = mergeWithMarkers(null, "hello");
    expect(out).toBe(`${MARKER_START}\nhello\n${MARKER_END}\n`);
  });

  it("wraps generated content in markers when existing is empty string", () => {
    const out = mergeWithMarkers("", "hello");
    expect(out).toBe(`${MARKER_START}\nhello\n${MARKER_END}\n`);
  });

  it("appends marker block when existing has no markers", () => {
    const existing = "# User notes\n\nunrelated.\n";
    const out = mergeWithMarkers(existing, "generated");
    expect(out).toBe(`# User notes\n\nunrelated.\n\n${MARKER_START}\ngenerated\n${MARKER_END}\n`);
  });

  it("replaces content between markers while preserving surrounding text", () => {
    const existing =
      `# User notes\n\nbefore\n${MARKER_START}\nOLD GENERATED\n${MARKER_END}\nafter\n`;
    const out = mergeWithMarkers(existing, "NEW");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD GENERATED");
  });

  it("is idempotent — re-merging the same content produces identical output", () => {
    const existing = "preamble\n";
    const once = mergeWithMarkers(existing, "body");
    const twice = mergeWithMarkers(once, "body");
    expect(twice).toBe(once);
  });

  it("throws on start marker without end marker (corrupted)", () => {
    const bad = `prefix\n${MARKER_START}\nbody without end\n`;
    expect(() => mergeWithMarkers(bad, "x")).toThrow(/corrupted|end/i);
  });

  it("throws on end marker without start marker (corrupted)", () => {
    const bad = `prefix\nbody\n${MARKER_END}\n`;
    expect(() => mergeWithMarkers(bad, "x")).toThrow(/corrupted|start/i);
  });

  it("trims trailing whitespace in generated content", () => {
    const out = mergeWithMarkers(null, "hello\n\n\n");
    expect(out).toBe(`${MARKER_START}\nhello\n${MARKER_END}\n`);
  });
});
