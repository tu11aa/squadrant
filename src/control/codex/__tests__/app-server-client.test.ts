import { describe, it, expect } from "vitest";
import { _parseChunk } from "../app-server-client.js";

describe("app-server-client._parseChunk", () => {
  it("parses one newline-terminated JSON object", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, '{"a":1}\n')).toEqual([{ a: 1 }]);
    expect(acc.buf).toBe("");
  });
  it("accumulates partial lines across chunks", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, '{"a":')).toEqual([]);
    expect(_parseChunk(acc, '1}\n')).toEqual([{ a: 1 }]);
  });
  it("skips non-JSON lines defensively", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, 'noise\n{"ok":true}\nmore noise\n')).toEqual([{ ok: true }]);
  });
  it("returns multiple objects from one chunk", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, '{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
