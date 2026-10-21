import { describe, it, expect, vi } from "vitest";
import { DEFAULT_CONTEXT_BUDGET } from "@squadrant/shared";
import {
  decideContextAdvice, emptyAdvisorState, boundaryOf, createContextAdvisor,
  BOUNDARY_TTL_MS, type AdvisorState,
} from "../context-suggest.js";

const budget = { ...DEFAULT_CONTEXT_BUDGET }; // soft 150k, hard 350k
const atBoundary = (): AdvisorState => ({ ...emptyAdvisorState(), boundary: { kind: "crew done", at: 0 } });
const input = (tokens: number | null, over: object = {}) =>
  ({ now: 1000, tokens, budget, openQuestion: false, mailboxBacklog: false, ...over });

describe("boundaryOf", () => {
  it("done / closed / answered question are boundaries; plain transitions are not", () => {
    expect(boundaryOf("working", "done")).toBe("crew done");
    expect(boundaryOf("working", "cancelled")).toBe("crew closed");
    expect(boundaryOf("blocked", "working")).toBe("crew question answered");
    expect(boundaryOf("blocked", "failed")).toBeNull();
    expect(boundaryOf("working", "blocked")).toBeNull();
    expect(boundaryOf("done", "done")).toBeNull();
    expect(boundaryOf(undefined, "done")).toBeNull();
  });
});

describe("soft suggestion", () => {
  it("fires once at a boundary above the soft floor, one line pointing at rollover", () => {
    const d = decideContextAdvice(atBoundary(), input(182_000));
    expect(d.message).toBe("Context 182k ≥ 150k at a boundary (crew done). Good moment: write the handoff, then /squadrant:rollover.");
    expect(d.state.boundary).toBeNull();
    expect(d.state.softAt).toBe(182_000);
  });
  it("does nothing without a boundary", () => {
    expect(decideContextAdvice(emptyAdvisorState(), input(182_000)).message).toBeNull();
  });
  it("clears the boundary silently below the soft floor", () => {
    const d = decideContextAdvice(atBoundary(), input(90_000));
    expect(d.message).toBeNull();
    expect(d.state.boundary).toBeNull();
  });
  it("is suppressed while a crew question is open or the mailbox has a backlog, and keeps the boundary", () => {
    for (const over of [{ openQuestion: true }, { mailboxBacklog: true }]) {
      const d = decideContextAdvice(atBoundary(), input(182_000, over));
      expect(d.message).toBeNull();
      expect(d.state.boundary).not.toBeNull();
    }
    // …and fires once the suppression lifts.
    expect(decideContextAdvice(atBoundary(), input(182_000)).message).not.toBeNull();
  });
  it("rate-limits: no re-suggest until +50k, then yes", () => {
    const after = decideContextAdvice(atBoundary(), input(182_000)).state;
    const next = (t: number) => decideContextAdvice({ ...after, boundary: { kind: "crew done", at: 0 } }, input(t));
    expect(next(220_000).message).toBeNull();
    expect(next(232_000).message).toMatch(/^Context 232k/);
  });
  it("a boundary goes stale after the TTL", () => {
    const d = decideContextAdvice(atBoundary(), input(182_000, { now: BOUNDARY_TTL_MS + 1 }));
    expect(d.message).toBeNull();
  });
  it("starts over after a rollover (context shrinks below the last mark)", () => {
    const s: AdvisorState = { boundary: { kind: "crew done", at: 0 }, softAt: 300_000, hardAt: null };
    expect(decideContextAdvice(s, input(160_000)).message).toMatch(/^Context 160k/);
  });
  it("respects enabled:false and unknown context", () => {
    expect(decideContextAdvice(atBoundary(), input(182_000, { budget: { ...budget, enabled: false } })).message).toBeNull();
    expect(decideContextAdvice(atBoundary(), input(null)).message).toBeNull();
  });
});

describe("hard warning", () => {
  it("fires without a boundary, even with a backlog, once per +100k", () => {
    const first = decideContextAdvice(emptyAdvisorState(), input(360_000, { mailboxBacklog: true }));
    expect(first.message).toMatch(/^⚠ Context 360k ≥ hard limit 350k/);
    expect(first.message).toMatch(/nothing is compacted automatically/);
    const again = (t: number) => decideContextAdvice(first.state, input(t));
    expect(again(420_000).message).toBeNull();
    expect(again(459_000).message).toBeNull();
    expect(again(460_000).message).toMatch(/^⚠ Context 460k/);
  });
  it("no soft suggestion between hard warnings", () => {
    const s: AdvisorState = { boundary: { kind: "crew done", at: 0 }, softAt: 360_000, hardAt: 360_000 };
    const d = decideContextAdvice(s, input(430_000));
    expect(d.message).toBeNull();
    expect(d.state.boundary).toBeNull();
  });
  it("replaces the soft suggestion rather than stacking with it", () => {
    const d = decideContextAdvice(atBoundary(), input(400_000));
    expect(d.message).toMatch(/^⚠/);
    expect(d.state.boundary).toBeNull();
  });
});

describe("createContextAdvisor", () => {
  const mk = (over: Partial<Parameters<typeof createContextAdvisor>[0]> = {}) => {
    const enqueue = vi.fn(async () => 1);
    const adv = createContextAdvisor({
      now: () => 1000, budgetFor: () => budget, captainTokens: () => 182_000,
      hasOpenQuestion: () => false, mailboxBacklog: async () => false, enqueue, ...over,
    });
    return { adv, enqueue };
  };

  it("enqueues exactly one line per boundary", async () => {
    const { adv, enqueue } = mk();
    adv.noteBoundary("p", "crew done");
    await adv.tick(["p"]);
    await adv.tick(["p"]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("p", expect.stringMatching(/\/squadrant:rollover/));
  });
  it("waits out a backlog, then fires", async () => {
    let backlog = true;
    const { adv, enqueue } = mk({ mailboxBacklog: async () => backlog });
    adv.noteBoundary("p", "crew closed");
    await adv.tick(["p"]);
    expect(enqueue).not.toHaveBeenCalled();
    backlog = false;
    await adv.tick(["p"]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it("is quiet with no boundary and never throws on a failing dependency", async () => {
    const log = vi.fn();
    const { adv, enqueue } = mk({ captainTokens: () => { throw new Error("boom"); }, log });
    adv.noteBoundary("p", "crew done");
    await adv.tick(["p"]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
  it("isolates projects", async () => {
    const { adv, enqueue } = mk();
    adv.noteBoundary("a", "crew done");
    await adv.tick(["a", "b"]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("a", expect.any(String));
  });
});
