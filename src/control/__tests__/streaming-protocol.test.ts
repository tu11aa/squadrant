import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrames, type AttachFrame } from "../protocol.js";

describe("streaming protocol frames", () => {
  it("encode/decode round-trips an attach-out frame", () => {
    const f: AttachFrame = { type: "delta", taskId: "t1", text: "hello" };
    expect(decodeFrames(encodeFrame(f))).toEqual([f]);
  });
  it("decodes a turn-completed frame", () => {
    const wire = '{"type":"turn-completed","taskId":"t1"}\n';
    expect(decodeFrames(wire)).toEqual([{ type: "turn-completed", taskId: "t1" }]);
  });
  it("ignores blank and malformed lines", () => {
    const wire = '\n{"type":"turn-completed","taskId":"t1"}\nbogus\n';
    expect(decodeFrames(wire)).toEqual([{ type: "turn-completed", taskId: "t1" }]);
  });
});
