import { describe, it, expect } from "vitest";
import { stampFact } from "../fact.js";

describe("stampFact", () => {
  it("stamps identity fields the adapter must not set", () => {
    const out = stampFact(
      { kind: "turn.ended", turnId: "ses_1" },
      { seq: 7, taskId: "t-42", source: "opencode-sse", origin: "agent", at: 1000 },
    );
    expect(out).toEqual({
      kind: "turn.ended", turnId: "ses_1",
      seq: 7, taskId: "t-42", source: "opencode-sse", origin: "agent", at: 1000,
    });
  });

  it("does not let a raw fact override stamped identity", () => {
    const sneaky = { kind: "activity", origin: "agent", taskId: "hacked" } as never;
    const out = stampFact(sneaky, {
      seq: 1, taskId: "t-1", source: "pane", origin: "inferred", at: 5,
    });
    expect(out.origin).toBe("inferred");
    expect(out.taskId).toBe("t-1");
  });
});
