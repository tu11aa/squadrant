// src/control/__tests__/protocol.test.ts
import { describe, it, expect } from "vitest";
import { encodeMsg, createDecoder } from "../protocol.js";

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
});
