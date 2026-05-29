// src/control/__tests__/crew-control.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildDispatchRequest, buildStatusRequest, buildGateResolveRequest } from "../../commands/crew-control.js";

describe("crew-control request builders", () => {
  it("dispatch request carries project/provider/mode/task and a generated id", () => {
    const r = buildDispatchRequest({ project: "p", provider: "codex", mode: "headless", task: "fix x" });
    expect(r.kind).toBe("dispatch");
    expect(r.record.project).toBe("p");
    expect(r.record.provider).toBe("codex");
    expect(r.record.mode).toBe("headless");
    expect(r.record.task).toBe("fix x");
    expect(r.record.state).toBe("submitted");
    expect(typeof r.record.id).toBe("string");
    expect(r.record.id.length).toBeGreaterThan(0);
  });

  it("carries cwd onto the record when provided (codex needs it to edit code)", () => {
    const r = buildDispatchRequest({ project: "p", provider: "codex", mode: "headless", task: "t", cwd: "/work/wt" });
    expect(r.record.cwd).toBe("/work/wt");
  });

  it("cwd is omitted when not provided (inherit daemon cwd)", () => {
    const r = buildDispatchRequest({ project: "p", provider: "codex", mode: "headless", task: "t" });
    expect(r.record.cwd).toBeUndefined();
  });

  it("status request targets a task id", () => {
    expect(buildStatusRequest("p", "t9")).toEqual({ kind: "status", project: "p", id: "t9" });
  });

  it("carries approvalPolicy onto the record when set (--approval gate-primitive flow)", () => {
    const r = buildDispatchRequest({
      project: "p", provider: "codex", mode: "interactive", task: "(interactive)",
      approvalPolicy: "untrusted",
    });
    expect(r.record.approvalPolicy).toBe("untrusted");
  });

  it("approvalPolicy is omitted when not provided (default auto-approve)", () => {
    const r = buildDispatchRequest({ project: "p", provider: "codex", mode: "interactive", task: "t" });
    expect(r.record.approvalPolicy).toBeUndefined();
  });

  it("gate-resolve payload derives decision='approve' from message so codex receives a valid approval (matches crew-attach renderer)", () => {
    const r = buildGateResolveRequest({ project: "p", gateId: "g1", message: "approve" });
    expect(r.kind).toBe("gate-resolve");
    expect(r.gateId).toBe("g1");
    expect(r.payload).toEqual({ text: "approve", decision: "approve" });
  });
});
