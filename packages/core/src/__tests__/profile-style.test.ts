import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializeTrait, viewSizes, styleViewSizes, validateTrait, type Trait } from "../knowledge/profile.js";
import { styledPromptFile, styleSummary, styleReport, formatStyleRow } from "../knowledge/profile-style.js";
import { computeProfileInjection } from "../knowledge/profile-inject.js";
import { addTrait, editItem } from "../knowledge/profile-write.js";
import { getDefaultConfig } from "@squadrant/shared";

let base: string; let root: string; let out: string; let roleFile: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "pstyle-"));
  root = path.join(base, "_user");
  out = path.join(base, "styled");
  fs.mkdirSync(path.join(root, "profile"), { recursive: true });
  roleFile = path.join(base, "captain.claude.md");
  fs.writeFileSync(roleFile, "ROLE PROMPT\n");
});
const mk = (id: string, over: Partial<Trait> = {}): Trait => ({
  id: `prof.${id}`, domain: "profile", level: "shared", status: "active", kind: "style", confirmed: true, summary: `Style ${id}.`,
  audience: "all", tier: "core", sources: [], created: "2026-10-14", updated: "2026-10-14", body: "", ...over,
});
const put = (t: Trait) => fs.writeFileSync(path.join(root, "profile", `${t.id.slice(5)}.md`), serializeTrait(t));
const env = () => ({ SQUADRANT_USER_KB_DIR: root });
const cfg = getDefaultConfig();

describe("styledPromptFile", () => {
  it("no style section: returns the role file untouched and writes nothing", () => {
    put(mk("pref", { kind: "preference" }));
    expect(styledPromptFile(roleFile, "captain", { env: env(), cfg, outDir: out })).toBe(roleFile);
    expect(fs.existsSync(out)).toBe(false);
  });
  it("style set: role prompt + style block land in a generated file inside outDir; role file is not modified", () => {
    put(mk("lang", { summary: "Chat in English.", body: "Switch to Vietnamese for complex explanations.\n" }));
    const f = styledPromptFile(roleFile, "captain", { env: env(), cfg, outDir: out });
    expect(f).toBe(path.join(out, "captain.claude.md"));
    const text = fs.readFileSync(f, "utf8");
    expect(text.startsWith("ROLE PROMPT\n")).toBe(true);
    expect(text).toContain("Chat in English.");
    expect(text).toContain("Switch to Vietnamese for complex explanations.");
    expect(fs.readFileSync(roleFile, "utf8")).toBe("ROLE PROMPT\n");
  });
  it("per role: an audience:captain style is absent for crew, an audience:crew style is absent for captain/side/command", () => {
    put(mk("cap", { audience: "captain", summary: "CAPTAIN ONLY" }));
    put(mk("crw", { audience: "crew", summary: "CREW ONLY" }));
    const crewFile = path.join(base, "crew.claude.md");
    fs.writeFileSync(crewFile, "CREW ROLE\n");
    const c = fs.readFileSync(styledPromptFile(roleFile, "captain", { env: env(), cfg, outDir: out }), "utf8");
    const w = fs.readFileSync(styledPromptFile(crewFile, "crew", { env: env(), cfg, outDir: out }), "utf8");
    expect(c).toContain("CAPTAIN ONLY"); expect(c).not.toContain("CREW ONLY");
    expect(w).toContain("CREW ONLY"); expect(w).not.toContain("CAPTAIN ONLY");
    for (const r of ["side", "command"]) expect(styleSummary(root, r).chars).toBeGreaterThan(0);
  });
  it("crew with only a captain style: returns the role file (crew may get none)", () => {
    put(mk("cap", { audience: "captain" }));
    const crewFile = path.join(base, "crew.claude.md");
    fs.writeFileSync(crewFile, "CREW ROLE\n");
    expect(styledPromptFile(crewFile, "crew", { env: env(), cfg, outDir: out })).toBe(crewFile);
  });
  it("fails open: unreadable role file returns it as-is", () => {
    put(mk("lang"));
    const missing = path.join(base, "nope.md");
    expect(styledPromptFile(missing, "captain", { env: env(), cfg, outDir: out })).toBe(missing);
  });
  it("archived/proposed style traits are ignored", () => {
    fs.mkdirSync(path.join(root, "profile", "_archive"), { recursive: true });
    fs.mkdirSync(path.join(root, "profile", "_proposed"), { recursive: true });
    fs.writeFileSync(path.join(root, "profile", "_archive", "old.md"), serializeTrait(mk("old", { status: "archived" })));
    fs.writeFileSync(path.join(root, "profile", "_proposed", "new.md"), serializeTrait(mk("new", { status: "proposed" })));
    expect(styledPromptFile(roleFile, "captain", { env: env(), cfg, outDir: out })).toBe(roleFile);
  });
});

describe("styleReport", () => {
  it("lists every role with its agent; style is delivered only to claude", () => {
    put(mk("lang", { audience: "captain" }));
    const c = getDefaultConfig();
    c.defaults.roles = { ...c.defaults.roles, side: { agent: "codex" } } as never;
    const rows = styleReport(c, env());
    expect(rows.map((r) => r.role)).toEqual(["captain", "command", "crew", "side"]);
    const by = Object.fromEntries(rows.map((r) => [r.role, r]));
    expect(by.captain).toMatchObject({ ids: ["prof.lang"], delivered: true });
    expect(by.crew).toMatchObject({ ids: [], delivered: false });
    expect(by.side).toMatchObject({ agent: "codex", ids: ["prof.lang"], delivered: false });
    expect(formatStyleRow(by.crew)).toBe("crew (claude): no style");
    expect(formatStyleRow(by.side)).toContain("not delivered");
  });
});

describe("style is outside the core profile", () => {
  it("does not count toward the core cap and is not injected at SessionStart", () => {
    put(mk("lang", { summary: "x".repeat(100) }));
    expect(viewSizes([mk("lang", { summary: "x".repeat(100) })]).captain).toBe(0);
    expect(styleViewSizes([mk("lang", { summary: "x".repeat(100) })]).captain).toBe(100);
    expect(computeProfileInjection({ cfg, env: env(), cwd: base, payload: {}, agent: "claude", audit: { dir: path.join(base, "audit") } })).toBeNull();
  });
  it("kind style validates", () => {
    expect(validateTrait(mk("lang"), "lang")).toEqual([]);
  });
});

describe("addTrait for style", () => {
  const ctx = () => ({ cfg, env: { ...env(), HOME: base }, cwd: base, now: () => new Date("2026-11-16T00:00:00Z"), audit: { dir: path.join(base, "audit") } });
  it("migration: review --edit with kind: style moves an existing core trait into the style section", () => {
    put(mk("output-language", { kind: "preference", summary: "Chat in English; explain complex logic in Vietnamese." }));
    const r = editItem(ctx() as never, "prof.output-language", "---\nkind: style\n---\n");
    expect(r.ok).toBe(true);
    expect(styleSummary(root, "captain").ids).toEqual(["prof.output-language"]);
    expect(computeProfileInjection({ cfg, env: env(), cwd: base, payload: {}, agent: "claude", audit: { dir: path.join(base, "audit") } })).toBeNull();
  });
  it("refuses a style over its own cap, independent of the core cap", () => {
    const r = addTrait(ctx() as never, { kind: "style", apply: true, id: "big", summary: "Big.", text: `---\nsummary: Big.\n---\n${"y".repeat(1600)}` });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/style/);
  });
});
