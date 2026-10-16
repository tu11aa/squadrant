import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import { loadProfile, parseTrait } from "../knowledge/profile.js";
import { keepItems, dropItems, type ProfileCtx } from "../knowledge/profile-write.js";
import { runProfileBridge, maybeRunProfileBridge, bootProfileBridge, allowlistedDirs, coveredNativeFiles, PROFILE_BRIDGE_INTERVAL_MS } from "../knowledge/profile-bridge.js";

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" })) process.env[k] = v;

const HOME = "/Users/tu";
const NOW = new Date("2026-10-15T10:00:00Z");
let base: string, native: string, ukb: string, stateRoot: string, cfg: SquadrantConfig, env: NodeJS.ProcessEnv;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "pbr-"));
  native = path.join(base, "projects");
  ukb = path.join(base, "_user");
  stateRoot = path.join(base, "state");
  fs.mkdirSync(stateRoot);
  cfg = getDefaultConfig();
  cfg.projects = { squadrant: { path: "/Users/tu/me/squadrant" } as never, flooros: { path: "/Users/tu/saitex/flooros" } as never };
  env = { SQUADRANT_USER_KB_DIR: ukb, SQUADRANT_NATIVE_MEMORY_ROOT: native };
});

function mem(dir: string, file: string, type: string, description: string, body: string, nested = true, extra = ""): void {
  const d = path.join(native, dir, "memory");
  fs.mkdirSync(d, { recursive: true });
  const typeLine = nested ? `metadata:\n  type: ${type}\n${extra}` : `type: ${type}\n${extra}`;
  fs.writeFileSync(path.join(d, file), `---\nname: ${file.slice(0, -3)}\ndescription: ${description}\n${typeLine}---\n${body}\n`);
}
const run = () => runProfileBridge({ cfg, env, home: HOME, now: () => NOW, audit: { dir: path.join(base, "audit") } });
const proposed = () => fs.existsSync(path.join(ukb, "profile", "_proposed")) ? fs.readdirSync(path.join(ukb, "profile", "_proposed")).sort() : [];
const ctx = (): ProfileCtx => ({ cfg, env, cwd: base, now: () => NOW, audit: { dir: path.join(base, "audit") } });
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") + fs.statSync(f).mtimeMs;
  } };
  walk(dir);
  return out;
}

describe("allowlist (P14)", () => {
  it("is each registered project's encoded Claude dir plus $HOME", () => {
    expect(allowlistedDirs(cfg, HOME)).toEqual(["-Users-tu-me-squadrant", "-Users-tu-saitex-flooros", "-Users-tu"]);
  });
});

describe("runProfileBridge", () => {
  it("file filter: only allowlisted user/feedback files (top-level or metadata.type) are proposed", () => {
    mem("-Users-tu-me-squadrant", "full-drive.md", "feedback", "Drive autonomously when busy", "Why: busy.");
    mem("-Users-tu", "no-attribution.md", "user", "No Claude attribution lines", "Never.", false);
    mem("-Users-tu-me-squadrant", "kb-priorities.md", "project", "KB priorities", "x");
    mem("-Users-tu-me-squadrant", "dashboard.md", "reference", "Grafana", "x");
    mem("-Users-tu-saitex", "clickup.md", "feedback", "ClickUp in English", "x");
    mem("-private-tmp-scratch", "tmp.md", "feedback", "tmp", "x");
    fs.writeFileSync(path.join(native, "-Users-tu", "memory", "MEMORY.md"), "- [x](x.md)\n");
    const r = run();
    expect(r.proposed.sort()).toEqual(["prof.full-drive", "prof.no-attribution"]);
    expect(proposed()).toEqual(["full-drive.md", "no-attribution.md"]);
    const t = parseTrait(fs.readFileSync(path.join(ukb, "profile", "_proposed", "full-drive.md"), "utf8"));
    expect(t).toMatchObject({ status: "proposed", kind: "preference", audience: "all", tier: "core", confirmed: false, summary: "Drive autonomously when busy" });
    expect(t.sources).toEqual([expect.stringMatching(/^memory:-Users-tu-me-squadrant\/full-drive\.md#[0-9a-f]{12}$/)]);
  });
  it("grouping: the same file name in two dirs with different bodies is one proposal with two sources and two ## From sections", () => {
    mem("-Users-tu-me-squadrant", "html.md", "feedback", "Interactive HTML explainers", "Squadrant body.");
    mem("-Users-tu-saitex-flooros", "html.md", "feedback", "Explainers must be interactive", "Flooros body.");
    expect(run().proposed).toEqual(["prof.html"]);
    const t = parseTrait(fs.readFileSync(path.join(ukb, "profile", "_proposed", "html.md"), "utf8"));
    expect(t.sources).toHaveLength(2);
    expect(t.body).toContain("## From -Users-tu-me-squadrant\n\nSquadrant body.");
    expect(t.body).toContain("## From -Users-tu-saitex-flooros\n\nFlooros body.");
    expect(t.summary).toBe("Interactive HTML explainers");
  });
  it("drafts the summary from the description, cut at a word boundary to <=140 chars", () => {
    mem("-Users-tu", "long.md", "user", `${"word ".repeat(40)}end`, "b");
    run();
    const t = parseTrait(fs.readFileSync(path.join(ukb, "profile", "_proposed", "long.md"), "utf8"));
    expect(t.summary.length).toBeLessThanOrEqual(140);
    expect(t.summary.endsWith("word")).toBe(true);
  });
  it("dedup: a second run proposes nothing; a metadata.modified-only change proposes nothing", () => {
    mem("-Users-tu", "a.md", "user", "A", "body");
    expect(run().proposed).toEqual(["prof.a"]);
    expect(run().proposed).toEqual([]);
    mem("-Users-tu", "a.md", "user", "A", "body", true, "  modified: 2026-10-16\noriginSessionId: abc\n");
    expect(run().proposed).toEqual([]);
  });
  it("a body change of a kept trait gives an update proposal that keeps the summary; keep applies it", () => {
    mem("-Users-tu-me-squadrant", "html.md", "feedback", "Interactive explainers", "Old body A.");
    mem("-Users-tu-saitex-flooros", "html.md", "feedback", "Interactive explainers", "Body B.");
    run();
    keepItems(ctx(), ["prof.html"]);
    mem("-Users-tu-me-squadrant", "html.md", "feedback", "Interactive explainers", "New body A.");
    expect(run().proposed).toEqual(["prof.html.update"]);
    const u = parseTrait(fs.readFileSync(path.join(ukb, "profile", "_proposed", "html.update.md"), "utf8"));
    expect(u.updates).toBe("prof.html");
    // regenerated from all of the trait's memory sources (Q7)
    expect(u.body).toContain("New body A.");
    expect(u.body).toContain("Body B.");
    expect(u.sources).toHaveLength(2);
    keepItems(ctx(), ["prof.html.update"]);
    const live = loadProfile(ukb).active.find((t) => t.id === "prof.html")!;
    expect(live.summary).toBe("Interactive explainers");
    expect(live.body).toContain("New body A.");
    expect(run().proposed).toEqual([]);
  });
  it("dropping an update proposal records only the changed source and does not block later updates (review 6)", () => {
    mem("-Users-tu-me-squadrant", "html.md", "feedback", "Interactive explainers", "Body A.");
    mem("-Users-tu-saitex-flooros", "html.md", "feedback", "Interactive explainers", "Body B.");
    run();
    keepItems(ctx(), ["prof.html"]);
    mem("-Users-tu-me-squadrant", "html.md", "feedback", "Interactive explainers", "Body A2.");
    expect(run().proposed).toEqual(["prof.html.update"]);
    expect(dropItems(ctx(), ["prof.html.update"], "not better")[0].ok).toBe(true);
    const dropped = yaml.load(fs.readFileSync(path.join(ukb, "profile", "_dropped.yaml"), "utf8")) as Record<string, string>[];
    expect(dropped).toEqual([expect.objectContaining({ source: "memory:-Users-tu-me-squadrant/html.md", updates: "prof.html", reason: "not better" })]);
    expect(run().proposed).toEqual([]); // the same change is not asked again
    mem("-Users-tu-me-squadrant", "html.md", "feedback", "Interactive explainers", "Body A3.");
    expect(run().proposed).toEqual(["prof.html.update"]); // a new change is
  });
  it("after deleting profile-bridge.json nothing kept or dropped is re-proposed", async () => {
    mem("-Users-tu", "keep.md", "user", "Keep me", "k");
    mem("-Users-tu", "drop.md", "user", "Drop me", "d");
    await maybeRunProfileBridge({ cfg, env, stateRoot, home: HOME, now: () => NOW, force: true });
    keepItems(ctx(), ["prof.keep"]);
    dropItems(ctx(), ["prof.drop"], "route: saitex rules");
    fs.rmSync(path.join(stateRoot, "profile-bridge.json"));
    expect(run().proposed).toEqual([]);
    expect(proposed()).toEqual([]);
  });
  it("a dropped or archived note is skipped by path even after it is edited (Q5)", () => {
    mem("-Users-tu", "drop.md", "user", "Drop me", "d");
    mem("-Users-tu", "arch.md", "user", "Archive me", "a");
    run();
    dropItems(ctx(), ["prof.drop"], "not profile");
    keepItems(ctx(), ["prof.arch"]);
    dropItems(ctx(), ["prof.arch"], "retired");
    mem("-Users-tu", "drop.md", "user", "Drop me", "edited");
    mem("-Users-tu", "arch.md", "user", "Archive me", "edited");
    expect(run().proposed).toEqual([]);
  });
  it("a name that collides with an unrelated live trait is proposed as <name>-2 (Q6)", () => {
    mem("-Users-tu", "seed.md", "user", "Native seed", "n");
    fs.mkdirSync(path.join(ukb, "profile"), { recursive: true });
    keepItems(ctx(), []); // creates the repo
    const write = (id: string) => fs.writeFileSync(path.join(ukb, "profile", `${id}.md`),
      `---\nid: prof.${id}\ndomain: profile\nlevel: shared\nstatus: active\nkind: preference\nconfirmed: true\nsummary: Hand trait\naudience: all\ntier: core\nsources: []\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n`);
    write("seed");
    expect(run().proposed).toEqual(["prof.seed-2"]);
  });
  it("two native names with the same slug in one run get distinct proposals (review 7)", () => {
    mem("-Users-tu", "a_b.md", "user", "Underscore", "u");
    mem("-Users-tu", "a-b.md", "user", "Dash", "d");
    expect(run().proposed.sort()).toEqual(["prof.a-b", "prof.a-b-2"]);
    expect(proposed()).toEqual(["a-b-2.md", "a-b.md"]);
    expect(run().proposed).toEqual([]);
  });
  it("safety: native memory is byte-identical after the run, and proposals are never committed", () => {
    mem("-Users-tu-me-squadrant", "a.md", "feedback", "A", "a");
    mem("-Users-tu", "b.md", "user", "B", "b");
    const before = snapshot(native);
    run();
    expect(snapshot(native)).toEqual(before);
    expect(execFileSync("git", ["-C", ukb, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["-C", ukb, "log", "--format=%s"], { encoding: "utf8" }).trim()).toBe("profile: init _user KB");
  });
  it("creates nothing when there is nothing to propose", () => {
    expect(run().proposed).toEqual([]);
    expect(fs.existsSync(ukb)).toBe(false);
  });
  it("coveredNativeFiles lists native files backing a kept trait", () => {
    mem("-Users-tu", "a.md", "user", "A", "a");
    run();
    keepItems(ctx(), ["prof.a"]);
    expect(coveredNativeFiles(cfg, env)).toEqual([path.join(native, "-Users-tu", "memory", "a.md")]);
  });
});

describe("maybeRunProfileBridge timing", () => {
  it("boot runs without an inbox dir; the 60-minute throttle and the no-overlap guard hold", async () => {
    mem("-Users-tu", "a.md", "user", "A", "a");
    expect(fs.existsSync(path.join(stateRoot, "inbox"))).toBe(false);
    expect((await bootProfileBridge({ cfg, env, stateRoot, home: HOME, now: () => NOW })).status).toBe("ran");
    expect(JSON.parse(fs.readFileSync(path.join(stateRoot, "profile-bridge.json"), "utf8")).lastRun).toBe(NOW.toISOString());
    const at = (ms: number) => () => new Date(NOW.getTime() + ms);
    expect((await maybeRunProfileBridge({ cfg, env, stateRoot, home: HOME, now: at(PROFILE_BRIDGE_INTERVAL_MS - 1000) })).status).toBe("throttled");
    expect(PROFILE_BRIDGE_INTERVAL_MS).toBe(60 * 60 * 1000);
    const a = maybeRunProfileBridge({ cfg, env, stateRoot, home: HOME, now: at(PROFILE_BRIDGE_INTERVAL_MS) });
    const b = maybeRunProfileBridge({ cfg, env, stateRoot, home: HOME, now: at(PROFILE_BRIDGE_INTERVAL_MS) });
    expect((await b).status).toBe("running");
    expect((await a).status).toBe("ran");
  });
  it("a refused _user path is logged, never thrown", async () => {
    mem("-Users-tu", "a.md", "user", "A", "a");
    const logs: string[] = [];
    const bad = { ...env, SQUADRANT_USER_KB_DIR: "/Users/tu/me/squadrant/kb" };
    const r = await maybeRunProfileBridge({ cfg, env: bad, stateRoot, home: HOME, now: () => NOW, force: true, log: (m) => logs.push(m) });
    expect(r.status).toBe("error");
    expect(logs.join()).toMatch(/inside project squadrant/);
  });
});
