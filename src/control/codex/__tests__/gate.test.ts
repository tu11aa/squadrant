import { describe, it, expect } from "vitest";
import { makeGate, resolveGate, timeoutGate } from "@cockpit/core";

describe("gate helpers (pure)", () => {
  it("makeGate creates a pending gate with given id, createdAt, kind, question", () => {
    const g = makeGate({ taskId: "t1", kind: "input", question: "ok?", now: 1, mkId: () => "g1" });
    expect(g).toEqual({
      gateId: "g1", taskId: "t1", kind: "input", question: "ok?",
      state: "pending", createdAt: 1,
    });
  });
  it("resolveGate flips state to 'resolved' and stamps resolution + resolvedBy", () => {
    const g = makeGate({ taskId: "t1", kind: "approval", question: "?", now: 1, mkId: () => "g2" });
    const r = resolveGate(g, { resolvedBy: "captain", resolution: { decision: "approve" } });
    expect(r.state).toBe("resolved");
    expect(r.resolvedBy).toBe("captain");
    expect(r.resolution).toEqual({ decision: "approve" });
    expect(g.state).toBe("pending"); // pure: original unchanged
  });
  it("timeoutGate flips state to 'timeout' and leaves other fields", () => {
    const g = makeGate({ taskId: "t1", kind: "input", question: "?", now: 1, mkId: () => "g3" });
    const t = timeoutGate(g);
    expect(t.state).toBe("timeout");
    expect(t.gateId).toBe("g3");
  });
});
