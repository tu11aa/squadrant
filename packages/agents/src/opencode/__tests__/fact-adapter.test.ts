import { describe, it, expect } from "vitest";
import { runAdapterConformance } from "@squadrant/core";
import { createOpencodeFactAdapter } from "../fact-adapter.js";

const make = () => {
  let n = 1;
  return createOpencodeFactAdapter({ nextRequestId: () => n++ });
};

describe("opencode fact adapter", () => {
  it("declares its identity and trust rank", () => {
    const a = make();
    expect(a.name).toBe("opencode-sse");
    expect(a.origin).toBe("agent");
  });

  it("session.idle becomes turn.ended carrying the session id", () => {
    expect(make().translate({ type: "session.idle", properties: { sessionID: "ses_7" } }))
      .toEqual([{ kind: "turn.ended", turnId: "ses_7" }]);
  });

  it("session.idle without a sessionID still ends the turn", () => {
    expect(make().translate({ type: "session.idle" }))
      .toEqual([{ kind: "turn.ended", turnId: undefined }]);
  });

  it("permission.asked becomes permission.requested with the same wording as today", () => {
    const out = make().translate({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls -la"] },
    });
    expect(out).toEqual([{
      kind: "permission.requested",
      question: "opencode requests permission to run bash: ls -la",
      requestId: 1,
      tool: "bash",
    }]);
  });

  it("permission.asked without patterns omits the command suffix", () => {
    const out = make().translate({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1", permission: "bash" },
    });
    expect(out[0]).toMatchObject({ question: "opencode requests permission to run bash" });
  });

  it("permission.asked missing id or sessionID is unknown, not a silent drop", () => {
    const out = make().translate({ type: "permission.asked", properties: { permission: "bash" } });
    expect(out).toEqual([{ kind: "unknown", name: "permission.asked:incomplete" }]);
  });

  it("permission.replied is liveness only", () => {
    expect(make().translate({ type: "permission.replied" })).toEqual([{ kind: "activity" }]);
  });

  it("an unrecognised frame becomes unknown carrying its type", () => {
    expect(make().translate({ type: "session.error" }))
      .toEqual([{ kind: "unknown", name: "session.error" }]);
  });

  it("does not consume a requestId for frames that are not permission requests", () => {
    const a = make();
    a.translate({ type: "session.idle" });
    const out = a.translate({
      type: "permission.asked",
      properties: { id: "p", sessionID: "s", permission: "bash" },
    });
    expect(out[0]).toMatchObject({ requestId: 1 });
  });
});

describe("opencode fact adapter — conformance", () => {
  for (const c of runAdapterConformance(make(), [
    { type: "session.idle", properties: { sessionID: "ses_1" } },
    { type: "permission.asked", properties: { id: "p", sessionID: "s", permission: "bash" } },
    { type: "permission.replied" },
  ])) {
    it(c.name, () => c.run());
  }
});
