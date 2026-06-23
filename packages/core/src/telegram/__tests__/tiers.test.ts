import { describe, it, expect } from "vitest";
import { tierIncludes } from "../tiers.js";

describe("tierIncludes", () => {
  it("none lets nothing through", () => {
    expect(tierIncludes("none", "task.done")).toBe(false);
    expect(tierIncludes("none", "task.blocked")).toBe(false);
  });
  it("done_only = terminal outcomes only", () => {
    expect(tierIncludes("done_only", "task.done")).toBe(true);
    expect(tierIncludes("done_only", "task.failed")).toBe(true);
    expect(tierIncludes("done_only", "task.blocked")).toBe(false);
    expect(tierIncludes("done_only", "task.progress")).toBe(false);
  });
  it("alert_only adds the needs-you events, still drops noise", () => {
    expect(tierIncludes("alert_only", "task.blocked")).toBe(true);
    expect(tierIncludes("alert_only", "task.approval.requested")).toBe(true);
    expect(tierIncludes("alert_only", "task.input.requested")).toBe(true);
    expect(tierIncludes("alert_only", "task.timeout")).toBe(true);
    expect(tierIncludes("alert_only", "task.done")).toBe(true);
    expect(tierIncludes("alert_only", "task.progress")).toBe(false);
    expect(tierIncludes("alert_only", "task.idle")).toBe(false);
  });
  it("all lets everything through", () => {
    expect(tierIncludes("all", "task.progress")).toBe(true);
    expect(tierIncludes("all", "heartbeat")).toBe(true);
  });
});
