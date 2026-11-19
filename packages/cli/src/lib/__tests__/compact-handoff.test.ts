// #1010: SessionStart(source=compact) injects the handoff for captains only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactHandoffContext, compactCoreContext, prependAdditionalContext, appendAdditionalContext, COMPACT_NOTE, CORE_NOTE } from "../compact-handoff.js";

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

// #1109: the captain-ops core must survive a compact, ahead of a large handoff.
describe("compactCoreContext", () => {
  const skill = () => {
    const f = path.join(home, "SKILL.md");
    fs.writeFileSync(f, "---\nname: captain-ops\ndescription: d\n---\n\n# core\n| Before you… | Read first |\nCORE-END\n");
    return f;
  };

  it("returns the core (without frontmatter) for a captain compact start", () => {
    const out = compactCoreContext({ source: "compact" }, cap, "demo", skill());
    expect(out).toContain(CORE_NOTE);
    expect(out).toContain("CORE-END");
    expect(out).not.toContain("description: d");
  });

  it("returns nothing for crews, other sources, plain sessions or a missing file", () => {
    const f = skill();
    expect(compactCoreContext({ source: "compact" }, { ...cap, SQUADRANT_CREW_TASK_ID: "t" }, "demo", f)).toBe("");
    expect(compactCoreContext({ source: "startup" }, cap, "demo", f)).toBe("");
    expect(compactCoreContext({ source: "compact" }, {}, "demo", f)).toBe("");
    expect(compactCoreContext({ source: "compact" }, cap, "demo", path.join(home, "nope.md"))).toBe("");
  });

  it("the real shipped core is injected and carries the trigger table", () => {
    const real = path.resolve(__dirname, "../../../../../plugin/skills/captain-ops/SKILL.md");
    expect(compactCoreContext({ source: "compact" }, cap, "demo", real)).toContain("Trigger table");
  });

  it("goes first, so a large handoff and rules cannot cut it off, and the handoff is still there", () => {
    fs.writeFileSync(path.join(home, "handoff.json"), JSON.stringify({ currentState: "x".repeat(30_000), nextSteps: ["merge #7"] }));
    const rules = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "RULES" } });
    let out = prependAdditionalContext(rules, compactCoreContext({ source: "compact" }, cap, "demo", skill()));
    out = appendAdditionalContext(out, compactHandoffContext({ source: "compact" }, cap, "demo", ws));
    const text: string = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(text.indexOf("CORE-END")).toBeGreaterThan(-1);
    expect(text.indexOf("CORE-END")).toBeLessThan(1000);
    expect(text.indexOf("CORE-END")).toBeLessThan(text.indexOf("RULES"));
    expect(text).toContain("merge #7");
  });

  it("a crew compact start gets neither the core nor the handoff", () => {
    fs.writeFileSync(path.join(home, "handoff.json"), JSON.stringify(handoff));
    const crew = { ...cap, SQUADRANT_CREW_TASK_ID: "t" } as NodeJS.ProcessEnv;
    expect(compactCoreContext({ source: "compact" }, crew, "demo", skill()) + compactHandoffContext({ source: "compact" }, crew, "demo", ws)).toBe("");
  });
});
