import { describe, it, expect, vi } from "vitest";
import { createEventsSource } from "../source.js";
import type { FactAdapter } from "../fact.js";
import type { ControlEvent } from "@squadrant/shared";

const sse: FactAdapter = {
  name: "opencode-sse",
  origin: "agent",
  translate(raw) {
    const t = (raw as { type?: string } | null)?.type;
    if (t === "session.idle") return [{ kind: "turn.ended", turnId: "ses_1" }];
    return [{ kind: "unknown", name: typeof t === "string" ? t : "non-object" }];
  },
};

const boom: FactAdapter = {
  name: "pane", origin: "inferred",
  translate() { throw new Error("adapter exploded"); },
};

function harness(adapters: FactAdapter[]) {
  const emitted: ControlEvent[] = [];
  const violations: { code: string }[] = [];
  const src = createEventsSource({
    adapters,
    emit: (ev) => emitted.push(ev),
    onViolation: (v) => violations.push(v),
    now: () => 5000,
  });
  src.start({ resolve: () => ({ id: "t1" }), report: () => {} });
  return { src, emitted, violations };
}

describe("events facade", () => {
  it("translates a raw frame into a ControlEvent", () => {
    const { src, emitted } = harness([sse]);
    src.ingest("opencode-sse", { type: "session.idle" }, { taskId: "t1" });
    expect(emitted).toEqual([{ type: "task.turn.completed", id: "t1", turnId: "ses_1" }]);
  });

  it("stamps a contiguous seq per crew", () => {
    const { src } = harness([sse]);
    src.ingest("opencode-sse", { type: "session.idle" }, { taskId: "t1" });
    src.ingest("opencode-sse", { type: "session.idle" }, { taskId: "t1" });
    expect(src.recent("t1").map((f) => f.seq)).toEqual([0, 1]);
  });

  it("stamps the adapter's origin, never the frame's", () => {
    const { src } = harness([sse]);
    src.ingest("opencode-sse", { type: "session.idle" }, { taskId: "t1" });
    expect(src.recent("t1")[0]!.origin).toBe("agent");
  });

  it("records an unrecognised frame as unknown and reports I5", () => {
    const { src, violations } = harness([sse]);
    src.ingest("opencode-sse", { type: "wat" }, { taskId: "t1" });
    expect(src.recent("t1")[0]).toMatchObject({ kind: "unknown", name: "wat" });
    expect(violations.map((v) => v.code)).toEqual(["I5"]);
  });

  it("contains a throwing adapter: no rethrow, a synthetic unknown, a violation", () => {
    const { src, violations } = harness([boom]);
    expect(() => src.ingest("pane", {}, { taskId: "t1" })).not.toThrow();
    expect(src.recent("t1")[0]).toMatchObject({ kind: "unknown" });
    expect(violations.map((v) => v.code)).toEqual(["I5"]);
  });

  it("drops a frame it cannot correlate to a crew", () => {
    const emitted: ControlEvent[] = [];
    const src = createEventsSource({
      adapters: [sse], emit: (ev) => emitted.push(ev), onViolation: () => {}, now: () => 1,
    });
    src.start({ resolve: () => undefined, report: () => {} });
    src.ingest("opencode-sse", { type: "session.idle" }, {});
    expect(emitted).toEqual([]);
  });

  it("ignores a frame for an unregistered source", () => {
    const { src, emitted } = harness([sse]);
    src.ingest("cmux-events", { type: "session.idle" }, { taskId: "t1" });
    expect(emitted).toEqual([]);
  });
});
