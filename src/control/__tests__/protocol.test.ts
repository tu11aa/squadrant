// src/control/__tests__/protocol.test.ts
import { describe, it, expect } from "vitest";
import { encodeMsg, createDecoder } from "@cockpit/core";

describe("framing", () => {
  it("encodeMsg appends a newline and JSON-encodes", () => {
    expect(encodeMsg({ a: 1 })).toBe('{"a":1}\n');
  });

  it("decoder yields complete messages, buffers partials", () => {
    const dec = createDecoder();
    expect(dec.push('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }]);
    expect(dec.push("\n")).toEqual([{ b: 2 }]);
  });

  it("decoder skips malformed lines without throwing", () => {
    const dec = createDecoder();
    expect(dec.push("not json\n{\"ok\":true}\n")).toEqual([{ ok: true }]);
  });

  it("decoder silently discards { type: '_keepalive' } frames (#94)", () => {
    const dec = createDecoder();
    expect(dec.push('{"type":"_keepalive"}\n{"ok":true}\n')).toEqual([{ ok: true }]);
  });

  // ── Issue #87: remainder() exposes unprocessed buffer content ────────────
  it("decoder remainder() returns buffered bytes not yet terminated with a newline (#87)", () => {
    const dec = createDecoder();
    dec.push('{"partial":true}'); // no newline — stays buffered
    expect(dec.remainder()).toBe('{"partial":true}');
  });

  it("decoder remainder() returns empty string when buffer is empty", () => {
    const dec = createDecoder();
    expect(dec.remainder()).toBe("");
  });

  it("decoder remainder() returns empty string after a complete newline-terminated message is consumed", () => {
    const dec = createDecoder();
    dec.push('{"ok":true}\n');
    expect(dec.remainder()).toBe("");
  });
});
