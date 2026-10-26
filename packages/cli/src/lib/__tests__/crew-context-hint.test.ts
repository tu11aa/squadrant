import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONTEXT_BUDGET } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import { crewSendHint, hintForCrewSend } from "../crew-context-hint.js";
import { formatTaskLine, formatCompactTasks } from "../../commands/crew-output.js";

const meter = (tokens: number) => ({ tokens, measuredAt: 1 });
const budget = DEFAULT_CONTEXT_BUDGET;

describe("crewSendHint", () => {
  it("hints at/above the crew soft floor", () => {
    expect(crewSendHint("noise", meter(210_000), budget)).toBe("crew noise at 210k; consider 'squadrant crew compact' or a fresh crew with a brief instead of reusing it as is");
    expect(crewSendHint("noise", meter(150_000), budget)).not.toBeNull();
  });
  it("is silent below the floor, when unknown, or when disabled", () => {
    expect(crewSendHint("noise", meter(149_999), budget)).toBeNull();
    expect(crewSendHint("noise", "unknown", budget)).toBeNull();
    expect(crewSendHint("noise", meter(900_000), { ...budget, enabled: false })).toBeNull();
  });
  it("hintForCrewSend tolerates a missing task and a non-claude crew", () => {
    expect(hintForCrewSend("x", undefined, budget)).toBeNull();
    expect(hintForCrewSend("x", null, budget)).toBeNull();
    const t = { provider: "opencode", cwd: "/w" } as TaskRecord;
    expect(hintForCrewSend("x", t, budget)).toBeNull();
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
