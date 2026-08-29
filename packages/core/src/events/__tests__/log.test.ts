import { describe, it, expect } from "vitest";
import { FactLog } from "../log.js";
import type { AgentFact } from "../fact.js";

const f = (seq: number, taskId = "t1"): AgentFact => ({
  kind: "activity", seq, taskId, at: 1000 + seq, source: "pane", origin: "inferred",
});

describe("FactLog", () => {
  it("keeps facts per crew, newest last", () => {
    const log = new FactLog({ capacity: 4 });
    log.push(f(0)); log.push(f(1));
    expect(log.recent("t1").map((x) => x.seq)).toEqual([0, 1]);
  });

  it("drops the oldest fact once capacity is exceeded", () => {
    const log = new FactLog({ capacity: 3 });
    for (let i = 0; i < 5; i++) log.push(f(i));
    expect(log.recent("t1").map((x) => x.seq)).toEqual([2, 3, 4]);
  });

  it("keeps crews isolated from each other", () => {
    const log = new FactLog({ capacity: 2 });
    log.push(f(0, "a")); log.push(f(1, "b"));
    expect(log.recent("a").map((x) => x.seq)).toEqual([0]);
    expect(log.recent("b").map((x) => x.seq)).toEqual([1]);
  });

  it("serializes to newline-delimited JSON, one fact per line", () => {
    const log = new FactLog({ capacity: 4 });
    log.push(f(0)); log.push(f(1));
    const lines = log.serialize("t1").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).seq).toBe(0);
  });

  it("returns an empty array for an unknown crew", () => {
    expect(new FactLog({ capacity: 2 }).recent("nope")).toEqual([]);
  });

  it("frees a crew's buffer on drop", () => {
    const log = new FactLog({ capacity: 2 });
    log.push(f(0));
    log.drop("t1");
    expect(log.recent("t1")).toEqual([]);
  });
});
