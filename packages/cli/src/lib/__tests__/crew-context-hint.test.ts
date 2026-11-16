import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONTEXT_BUDGET } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import { checkCrewSend, crewTokens } from "../crew-context-hint.js";
import { formatTaskLine, formatCompactTasks } from "../../commands/crew-output.js";

const budget = DEFAULT_CONTEXT_BUDGET;
const rec = (state: string) => ({ id: "t1", provider: "claude", state } as TaskRecord);
const chk = (state: string, tokens: number | null, o: { noCompact?: boolean; alreadyWarned?: boolean; b?: typeof budget } = {}) =>
  checkCrewSend("p", "noise", rec(state), tokens, o.b ?? budget, { noCompact: o.noCompact, alreadyWarned: o.alreadyWarned ?? false });

describe("checkCrewSend (#1126)", () => {
  it("is silent below the soft floor, when unmeasurable, or when disabled", () => {
    expect(chk("done", 149_999)).toEqual({});
    expect(chk("done", null)).toEqual({});
    expect(chk("done", 900_000, { b: { ...budget, enabled: false } })).toEqual({});
  });
  it("warns once per task between the soft floor and the gate, then stays silent", () => {
    const first = chk("done", 210_000);
    expect(first.hint).toContain("crew noise at 210k");
    expect(first.hint).toContain("squadrant crew compact p noise --keep");
    expect(first.warned).toBe("t1");
    expect(first.refuse).toBeUndefined();
    expect(chk("done", 210_000, { alreadyWarned: true })).toEqual({});
    expect(chk("working", 400_000, { alreadyWarned: true })).toEqual({});
  });
  it("refuses a send that reopens a finished crew at/above the gate", () => {
    for (const state of ["done", "failed", "cancelled"]) {
      const r = chk(state, 250_000);
      expect(r.refuse).toContain("crew noise is at 250k ctx; compact first: squadrant crew compact p noise --keep");
      expect(r.refuse).toContain("--no-compact");
    }
    expect(chk("done", 249_999).refuse).toBeUndefined();
    // refusal repeats: it is a gate, not a one-time warning
    expect(chk("done", 300_000, { alreadyWarned: true }).refuse).toBeDefined();
  });
  it("the override passes (and still warns once)", () => {
    const r = chk("done", 300_000, { noCompact: true });
    expect(r.refuse).toBeUndefined();
    expect(r.hint).toBeDefined();
  });
  it("never gates a live crew", () => {
    for (const state of ["working", "awaiting-input", "review", "blocked", "stalled"]) expect(chk(state, 600_000).refuse).toBeUndefined();
  });
  it("honours a configured gate", () => {
    expect(chk("done", 120_000, { b: { ...budget, crewSoft: 50_000, crewGate: 100_000 } }).refuse).toBeDefined();
  });
});

describe("crewTokens", () => {
  it("is null for a non-claude crew and never throws", () => {
    expect(crewTokens({ provider: "opencode", cwd: "/w" } as TaskRecord)).toBeNull();
    expect(crewTokens({} as TaskRecord)).toBeNull();
  });
});

describe("ctx column", () => {
  const rec = { id: "abcdef123456", provider: "claude", state: "working", lastEvent: "task.started", task: "do it" } as TaskRecord;
  it("formatTaskLine adds the column only when given", () => {
    expect(formatTaskLine(rec)).toBe("abcdef12  claude  working  task.started  do it");
    expect(formatTaskLine(rec, "182k")).toBe("abcdef12  claude  working  task.started  ctx 182k  do it");
  });
  it("formatCompactTasks threads ctxLabel through, including unknown", () => {
    const out = formatCompactTasks([rec], { compact: true, ctxLabel: () => "unknown" });
    expect(out).toContain("ctx unknown");
  });
});
