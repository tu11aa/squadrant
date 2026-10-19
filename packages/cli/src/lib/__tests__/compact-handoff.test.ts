// #1010: SessionStart(source=compact) injects the handoff for captains only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactHandoffContext, appendAdditionalContext, COMPACT_NOTE } from "../compact-handoff.js";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "compact-handoff-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const ws = () => home;
const cap = { SQUADRANT_ROLE: "captain" } as NodeJS.ProcessEnv;
const handoff = { currentState: "mid-PR", nextSteps: ["merge #7"] };

describe("compactHandoffContext", () => {
  it("injects the live handoff.json for a captain on source=compact", () => {
    fs.writeFileSync(path.join(home, "handoff.json"), JSON.stringify(handoff));
    const out = compactHandoffContext({ source: "compact" }, cap, "demo", ws);
    expect(out).toContain(COMPACT_NOTE);
    expect(out).toContain("merge #7");
  });

  it("falls back to the newest archived handoff", () => {
    fs.mkdirSync(path.join(home, "handoffs"));
    fs.writeFileSync(path.join(home, "handoffs", "2026-10-19.json"), JSON.stringify(handoff));
    expect(compactHandoffContext({ source: "compact" }, cap, "demo", ws)).toContain("mid-PR");
  });

  it("injects nothing for crews, plain sessions, other sources, or no handoff", () => {
    fs.writeFileSync(path.join(home, "handoff.json"), JSON.stringify(handoff));
    expect(compactHandoffContext({ source: "compact" }, { ...cap, SQUADRANT_CREW_TASK_ID: "t" }, "demo", ws)).toBe("");
    expect(compactHandoffContext({ source: "compact" }, {}, "demo", ws)).toBe("");
    for (const source of ["startup", "resume", "clear", undefined]) {
      expect(compactHandoffContext({ source }, cap, "demo", ws)).toBe("");
    }
    expect(compactHandoffContext({ source: "compact" }, cap, null, ws)).toBe("");
    fs.rmSync(path.join(home, "handoff.json"));
    expect(compactHandoffContext({ source: "compact" }, cap, "demo", ws)).toBe("");
  });
});

describe("appendAdditionalContext", () => {
  it("keeps one JSON document and preserves existing rules context", () => {
    const rules = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "RULES" } });
    const o = JSON.parse(appendAdditionalContext(rules, "HANDOFF"));
    expect(o.hookSpecificOutput.additionalContext).toBe("RULES\n\nHANDOFF");
    expect(JSON.parse(appendAdditionalContext("", "HANDOFF")).hookSpecificOutput.additionalContext).toBe("HANDOFF");
    expect(appendAdditionalContext(rules, "")).toBe(rules);
  });
});
