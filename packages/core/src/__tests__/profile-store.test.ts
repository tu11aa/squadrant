import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import {
  ensureUserKb, profileWritePath, validateTrait, parseTrait, serializeTrait, viewSizes, commitProfilePaths, loadProfile,
  PROFILE_CORE_CAP, type Trait,
} from "../knowledge/profile.js";

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" })) process.env[k] = v;

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (root: string, ...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });

function cfgWith(projects: Record<string, string>, kbs: Record<string, string> = {}): SquadrantConfig {
  const cfg = getDefaultConfig();
  cfg.projects = Object.fromEntries(Object.entries(projects).map(([n, p]) => [n, { path: p } as never]));
  cfg.knowledgeBases = Object.fromEntries(Object.entries(kbs).map(([n, p]) => [n, { path: p }]));
  return cfg;
}

function trait(over: Partial<Trait> = {}): Trait {
  return {
    id: "prof.x", domain: "profile", level: "shared", status: "active", kind: "preference", confirmed: true,
    last_confirmed: "2026-10-15", summary: "Do the thing.", audience: "all", tier: "core", sources: [],
    created: "2026-10-15", updated: "2026-10-15", body: "Why: because.\n", ...over,
  };
}

describe("ensureUserKb (K6)", () => {
  it("creates a local git repo with the proposals ignored and an initial commit", () => {
    const root = path.join(tmp("ukb-"), "_user");
    expect(ensureUserKb(cfgWith({}), { SQUADRANT_USER_KB_DIR: root })).toBe(root);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("profile/_proposed/");
    expect(fs.existsSync(path.join(root, "profile"))).toBe(true);
    expect(git(root, "log", "--oneline")).toMatch(/profile: init/);
    expect(git(root, "remote")).toBe("");
    ensureUserKb(cfgWith({}), { SQUADRANT_USER_KB_DIR: root }); // idempotent
    expect(git(root, "log", "--oneline").trim().split("\n")).toHaveLength(1);
  });
  it("refuses a _user path inside a registered project (env or config)", () => {
    const proj = tmp("proj-");
    expect(() => ensureUserKb(cfgWith({ p: proj }), { SQUADRANT_USER_KB_DIR: path.join(proj, "kb") })).toThrow(/inside project p/);
    const cfg = cfgWith({ p: proj }, { _user: path.join(proj, "docs", "_user") });
    expect(() => ensureUserKb(cfg, {})).toThrow(/inside project p/);
  });
  it("refuses a _user path inside another KB dir", () => {
    const kb = tmp("kb-");
    expect(() => ensureUserKb(cfgWith({}, { saitex: kb }), { SQUADRANT_USER_KB_DIR: path.join(kb, "_user") })).toThrow(/inside KB saitex/);
  });
});

describe("profileWritePath (K6)", () => {
  it("resolves inside <userKb>/profile and throws for anything outside", () => {
    const root = "/kb/_user";
    expect(profileWritePath(root, "x.md")).toBe("/kb/_user/profile/x.md");
    expect(profileWritePath(root, "_proposed/x.md")).toBe("/kb/_user/profile/_proposed/x.md");
    expect(() => profileWritePath(root, "../x.md")).toThrow(/outside/);
    expect(() => profileWritePath(root, "/repo/docs/x.md")).toThrow(/outside/);
    expect(() => profileWritePath(root, "../../saitex/shared/rules/x.md")).toThrow(/outside/);
  });
});

describe("validateTrait", () => {
  it("accepts a valid trait", () => expect(validateTrait(trait(), "x")).toEqual([]));
  it("refuses a missing / long / multi-line summary, a bad enum, an id/file mismatch", () => {
    expect(validateTrait(trait({ summary: "" }), "x").join()).toMatch(/summary/);
    expect(validateTrait(trait({ summary: "a".repeat(141) }), "x").join()).toMatch(/140/);
    expect(validateTrait(trait({ summary: "a\nb" }), "x").join()).toMatch(/one line/);
    expect(validateTrait(trait({ kind: "habit" as never }), "x").join()).toMatch(/kind/);
    expect(validateTrait(trait({ audience: "boss" as never }), "x").join()).toMatch(/audience/);
    expect(validateTrait(trait({ tier: "hot" as never }), "x").join()).toMatch(/tier/);
    expect(validateTrait(trait({ confirmed: "yes" as never }), "x").join()).toMatch(/confirmed/);
    expect(validateTrait(trait(), "y").join()).toMatch(/file name/);
    expect(validateTrait(trait({ id: "x" }), "x").join()).toMatch(/prof\./);
    // review fix: dates are sorted on at injection, so a missing or malformed one must make the file invalid
    expect(validateTrait(trait({ updated: undefined as never }), "x").join()).toMatch(/updated/);
    expect(validateTrait(trait({ created: "15/10/2026" }), "x").join()).toMatch(/created/);
    expect(validateTrait(trait({ last_confirmed: 20261015 as never }), "x").join()).toMatch(/last_confirmed/);
  });
  it("round-trips through serialize/parse with dates kept as strings", () => {
    const t = trait({ sources: ["memory:-Users-a/x.md#abc123abc123"], triggers: { keywords: ["html"] } });
    const back = parseTrait(serializeTrait(t));
    expect(back).toEqual({ ...t });
    expect(typeof back.created).toBe("string");
  });
});

describe("viewSizes", () => {
  it("counts active core summaries per audience view; situational and archived do not count", () => {
    const s = viewSizes([
      trait({ id: "prof.a", summary: "a".repeat(10) }),
      trait({ id: "prof.b", summary: "b".repeat(20), audience: "captain" }),
      trait({ id: "prof.c", summary: "c".repeat(40), audience: "crew" }),
      trait({ id: "prof.d", summary: "d".repeat(80), tier: "situational" }),
      trait({ id: "prof.e", summary: "e".repeat(80), status: "archived" }),
    ]);
    expect(s).toEqual({ captain: 30, crew: 50 });
    expect(PROFILE_CORE_CAP).toBe(3000);
  });
});

describe("commitProfilePaths", () => {
  let root: string;
  beforeEach(() => { root = path.join(tmp("ukb-"), "_user"); ensureUserKb(cfgWith({}), { SQUADRANT_USER_KB_DIR: root }); });
  it("commits only its own paths with the five trailers; another writer's staged file is not swept in", () => {
    fs.writeFileSync(path.join(root, "profile", "other.md"), "other");
    git(root, "add", "profile/other.md");
    fs.writeFileSync(path.join(root, "profile", "x.md"), "x");
    const r = commitProfilePaths(root, ["profile/x.md"], { verb: "add", id: "prof.x", session: "s1", approvedBy: "operator" });
    expect(r.ok).toBe(true);
    expect(git(root, "show", "--name-only", "--format=", "HEAD").trim()).toBe("profile/x.md");
    const msg = git(root, "log", "-1", "--format=%B");
    expect(msg).toMatch(/^profile: add prof\.x/);
    for (const t of ["Domain: profile", "Item: prof.x", "Level: shared", "Session: s1", "Approved-by: operator"]) expect(msg).toContain(t);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("profile/other.md");
  });
  it("on failure the file stands and a warning is returned", () => {
    fs.writeFileSync(path.join(root, "profile", "y.md"), "y");
    fs.rmSync(path.join(root, ".git"), { recursive: true });
    const r = commitProfilePaths(root, ["profile/y.md"], { verb: "add", id: "prof.y", approvedBy: "operator" });
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/commit failed/);
    expect(fs.existsSync(path.join(root, "profile", "y.md"))).toBe(true);
  });
});

describe("loadProfile", () => {
  it("loads active, archived and proposed traits; skips invalid files and reports them", () => {
    const root = path.join(tmp("ukb-"), "_user");
    fs.mkdirSync(path.join(root, "profile", "_archive"), { recursive: true });
    fs.mkdirSync(path.join(root, "profile", "_proposed"), { recursive: true });
    fs.writeFileSync(path.join(root, "profile", "a.md"), serializeTrait(trait({ id: "prof.a" })));
    fs.writeFileSync(path.join(root, "profile", "bad.md"), "---\nid: prof.bad\n---\n");
    fs.writeFileSync(path.join(root, "profile", "_archive", "b.md"), serializeTrait(trait({ id: "prof.b", status: "archived" })));
    fs.writeFileSync(path.join(root, "profile", "_proposed", "c.md"), serializeTrait(trait({ id: "prof.c", status: "proposed", confirmed: false })));
    const p = loadProfile(root);
    expect(p.active.map((t) => t.id)).toEqual(["prof.a"]);
    expect(p.archived.map((t) => t.id)).toEqual(["prof.b"]);
    expect(p.proposed.map((t) => t.id)).toEqual(["prof.c"]);
    expect(p.errors.map((e) => path.basename(e.file))).toEqual(["bad.md"]);
  });
  it("returns empty for a missing KB", () => {
    expect(loadProfile("/nonexistent/_user")).toMatchObject({ active: [], archived: [], proposed: [], errors: [] });
  });
});
