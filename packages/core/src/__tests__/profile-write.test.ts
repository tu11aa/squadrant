import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import { getDefaultConfig } from "@squadrant/shared";
import { serializeTrait, parseTrait, type Trait } from "../knowledge/profile.js";
import { addTrait, reviewQueue, keepItems, dropItems, editItem, checkProfile, type ProfileCtx } from "../knowledge/profile-write.js";

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" })) process.env[k] = v;

const git = (root: string, ...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
const commits = (root: string) => git(root, "log", "--format=%s").trim().split("\n").filter(Boolean);
const NOW = new Date("2026-10-15T10:00:00Z");

let root: string;
let auditDir: string;
let ctx: ProfileCtx;
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pw-"));
  root = path.join(base, "_user");
  auditDir = path.join(base, "audit");
  ctx = { cfg: getDefaultConfig(), env: { SQUADRANT_USER_KB_DIR: root }, cwd: base, now: () => NOW, audit: { dir: auditDir, now: () => NOW } };
});

const audit = () => fs.readdirSync(auditDir).flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
const read = (rel: string) => parseTrait(fs.readFileSync(path.join(root, "profile", rel), "utf8"));
const input = (summary: string, body = "Why: reasons.\n", extra = "") => `---\nsummary: ${JSON.stringify(summary)}\n${extra}---\n${body}`;

function trait(id: string, summary: string, over: Partial<Trait> = {}): Trait {
  return { id: `prof.${id}`, domain: "profile", level: "shared", status: "active", kind: "preference", confirmed: true,
    last_confirmed: "2026-10-01", summary, audience: "all", tier: "core", sources: [], created: "2026-10-01", updated: "2026-10-01", body: "b\n", ...over };
}
/** Seed active traits directly (committed) so the views total `chars` in the given audience. */
function seed(chars: number, audience: Trait["audience"] = "all"): void {
  addTrait(ctx, { text: input("seed"), kind: "preference", apply: true, id: "seed" }); // creates the repo
  fs.rmSync(path.join(root, "profile", "seed.md"));
  let i = 0;
  while (chars > 0) {
    const n = Math.min(140, chars);
    fs.writeFileSync(path.join(root, "profile", `s${i}.md`), serializeTrait(trait(`s${i}`, "x".repeat(n), { audience })));
    chars -= n; i++;
  }
  git(root, "add", "-A"); git(root, "commit", "-qm", "seed");
}

describe("profile add", () => {
  it("--kind preference --apply is live, confirmed, committed once with only its path, and not queued", () => {
    const r = addTrait(ctx, { text: input("Lead with a proposal when asking."), kind: "preference", apply: true, session: "s1" });
    expect(r.ok).toBe(true);
    expect(r.line).toBe('applied prof.lead-with-a-proposal-when-asking: "Lead with a proposal when asking." (captain 33/3,000 · crew 33/3,000)');
    const t = read("lead-with-a-proposal-when-asking.md");
    expect(t).toMatchObject({ confirmed: true, status: "active", kind: "preference", last_confirmed: "2026-10-15", audience: "all", tier: "core", sources: ["session:s1"] });
    expect(commits(root)[0]).toBe("profile: add prof.lead-with-a-proposal-when-asking");
    expect(git(root, "show", "--name-only", "--format=", "HEAD").trim()).toBe("profile/lead-with-a-proposal-when-asking.md");
    expect(reviewQueue(ctx)).toEqual([]);
    expect(audit()).toContainEqual(expect.objectContaining({ event: "item.applied", kb: "_user", domain: "profile", level: "shared", itemId: "prof.lead-with-a-proposal-when-asking" }));
  });
  it("--kind correction --apply is live unconfirmed, queued, and applies even at the cap with a warning", () => {
    seed(3000);
    const r = addTrait(ctx, { text: input("Never write ~/.claude/CLAUDE.md."), kind: "correction", apply: true, id: "no-global" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/over cap: merge pending/);
    expect(read("no-global.md")).toMatchObject({ confirmed: false, kind: "correction", status: "active" });
    expect(read("no-global.md").last_confirmed).toBeUndefined();
    expect(reviewQueue(ctx).map((q) => [q.id, q.type])).toEqual([["prof.no-global", "unconfirmed"]]);
  });
  it("refuses a preference that would pass 3,000 with the merge message; a crew-only trait counts against the crew view", () => {
    seed(2950, "crew");
    const r = addTrait(ctx, { text: input("y".repeat(100)), kind: "preference", apply: true, id: "big", audience: "crew" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("core profile is 2,950/3,000 chars: merge or archive traits first (squadrant profile list)");
    expect(fs.existsSync(path.join(root, "profile", "big.md"))).toBe(false);
    expect(addTrait(ctx, { text: input("y".repeat(100)), kind: "preference", apply: true, id: "cap", audience: "captain" }).ok).toBe(true);
  });
  it("without --apply lands in _proposed/, uncommitted and never tracked", () => {
    addTrait(ctx, { text: input("seed"), kind: "preference", apply: true, id: "seed" });
    const before = commits(root).length;
    const r = addTrait(ctx, { text: input("Guess: likes tables."), kind: "preference", id: "tables" });
    expect(r.line).toMatch(/^proposed prof\.tables: "Guess: likes tables\."/);
    expect(fs.existsSync(path.join(root, "profile", "_proposed", "tables.md"))).toBe(true);
    expect(commits(root)).toHaveLength(before);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(audit()).toContainEqual(expect.objectContaining({ event: "item.proposed", itemId: "prof.tables" }));
  });
  it("crew guard: --apply inside a crew session is downgraded to a proposal", () => {
    const r = addTrait({ ...ctx, env: { ...ctx.env, SQUADRANT_CREW_TASK_ID: "t1" } }, { text: input("Crew thinks X."), kind: "correction", apply: true, id: "x" });
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/^proposed prof\.x/);
    expect(r.warnings.join()).toMatch(/crew/);
    expect(fs.existsSync(path.join(root, "profile", "x.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "profile", "_proposed", "x.md"))).toBe(true);
  });
  it("validation: refuses a missing, long or multi-line summary, a bad enum, an existing id", () => {
    expect(addTrait(ctx, { text: "---\n---\nbody", kind: "preference", apply: true, id: "a" }).error).toMatch(/summary/);
    expect(addTrait(ctx, { text: input("a".repeat(141)), kind: "preference", apply: true, id: "a" }).error).toMatch(/140/);
    expect(addTrait(ctx, { text: input("a\nb"), kind: "preference", apply: true, id: "a" }).error).toMatch(/one line/);
    expect(addTrait(ctx, { text: input("ok"), kind: "habit" as never, apply: true, id: "a" }).error).toMatch(/kind/);
    expect(addTrait(ctx, { text: input("ok"), kind: "preference", apply: true, id: "a", audience: "boss" as never }).error).toMatch(/audience/);
    expect(addTrait(ctx, { text: input("ok"), kind: "preference", apply: true, id: "a" }).ok).toBe(true);
    expect(addTrait(ctx, { text: input("ok"), kind: "preference", apply: true, id: "a" }).error).toMatch(/exists/);
  });
  it("flags override file fields", () => {
    addTrait(ctx, { text: input("from file", "b\n", "audience: crew\n"), kind: "preference", apply: true, id: "f", summary: "from flag", tier: "situational" });
    expect(read("f.md")).toMatchObject({ summary: "from flag", audience: "crew", tier: "situational" });
  });
});

describe("profile review", () => {
  function propose(id: string, over: Partial<Trait> = {}): void {
    fs.mkdirSync(path.join(root, "profile", "_proposed"), { recursive: true });
    const slug = id.replace(/^prof\./, "");
    fs.writeFileSync(path.join(root, "profile", "_proposed", `${slug}.md`),
      serializeTrait(trait(slug, `Summary of ${slug}.`, { status: "proposed", confirmed: false, ...over })));
  }
  beforeEach(() => { addTrait(ctx, { text: input("seed"), kind: "preference", apply: true, id: "seed" }); });

  it("the queue lists proposals and unconfirmed traits with ids, kinds and source dirs", () => {
    propose("p1", { sources: ["memory:-Users-tu/p1.md#aaaaaaaaaaaa", "memory:-Users-tu-me-x/p1.md#bbbbbbbbbbbb"], body: "SECRET-BODY\n" });
    addTrait(ctx, { text: input("Don't do Y."), kind: "correction", apply: true, id: "c1" });
    const q = reviewQueue(ctx);
    expect(q.map((x) => [x.id, x.type, x.kind])).toEqual([["prof.p1", "new", "preference"], ["prof.c1", "unconfirmed", "correction"]]);
    expect(q[0].sourceDirs).toEqual(["-Users-tu", "-Users-tu-me-x"]);
  });
  it("--keep of a new proposal moves it live, confirmed, one commit with only its path", () => {
    propose("p1");
    const [r] = keepItems(ctx, ["prof.p1"]);
    expect(r.ok).toBe(true);
    expect(read("p1.md")).toMatchObject({ status: "active", confirmed: true, last_confirmed: "2026-10-15" });
    expect(fs.existsSync(path.join(root, "profile", "_proposed", "p1.md"))).toBe(false);
    expect(git(root, "show", "--name-only", "--format=%s", "HEAD").trim().split("\n").filter(Boolean)).toEqual(["profile: keep prof.p1", "profile/p1.md"]);
  });
  it("--keep refuses a proposal whose id already exists", () => {
    propose("seed");
    expect(keepItems(ctx, ["prof.seed"])[0].error).toMatch(/exists/);
  });
  it("--keep of an update proposal replaces body and sources but keeps the summary", () => {
    fs.mkdirSync(path.join(root, "profile", "_proposed"), { recursive: true });
    fs.writeFileSync(path.join(root, "profile", "_proposed", "seed.update.md"), serializeTrait(trait("seed.update", "Bridge draft summary.", {
      status: "proposed", confirmed: false, updates: "prof.seed", sources: ["memory:-Users-tu/seed.md#cccccccccccc"], body: "New native body.\n" })));
    expect(keepItems(ctx, ["prof.seed.update"])[0].ok).toBe(true);
    expect(read("seed.md")).toMatchObject({ summary: "seed", body: "New native body.\n", sources: ["memory:-Users-tu/seed.md#cccccccccccc"], last_confirmed: "2026-10-15" });
    expect(fs.existsSync(path.join(root, "profile", "_proposed", "seed.update.md"))).toBe(false);
  });
  it("--keep of an unconfirmed correction confirms it", () => {
    addTrait(ctx, { text: input("Don't do Y."), kind: "correction", apply: true, id: "c1" });
    keepItems(ctx, ["prof.c1"]);
    expect(read("c1.md")).toMatchObject({ confirmed: true, last_confirmed: "2026-10-15" });
    expect(reviewQueue(ctx)).toEqual([]);
  });
  it("--drop of a proposal writes only {source, hash, reason, date}; its body never reaches git history", () => {
    propose("p1", { sources: ["memory:-Users-tu-saitex/p1.md#aaaaaaaaaaaa"], body: "SAITEX-COMPANY-SECRET\n" });
    const [r] = dropItems(ctx, ["prof.p1"], "route: saitex rules");
    expect(r.ok).toBe(true);
    const dropped = yaml.load(fs.readFileSync(path.join(root, "profile", "_dropped.yaml"), "utf8"));
    expect(dropped).toEqual([{ source: "memory:-Users-tu-saitex/p1.md", hash: "aaaaaaaaaaaa", reason: "route: saitex rules", date: "2026-10-15" }]);
    expect(fs.existsSync(path.join(root, "profile", "_proposed", "p1.md"))).toBe(false);
    expect(git(root, "log", "-p", "--all")).not.toContain("SAITEX-COMPANY-SECRET");
    expect(git(root, "show", "--name-only", "--format=", "HEAD").trim()).toBe("profile/_dropped.yaml");
    expect(audit()).toContainEqual(expect.objectContaining({ event: "item.rejected", itemId: "prof.p1", reason: "route: saitex rules" }));
  });
  it("--drop of an agent proposal without memory sources records a body hash, not the body", () => {
    propose("p2", { body: "inferred\n" });
    dropItems(ctx, ["prof.p2"], "not true");
    const [e] = yaml.load(fs.readFileSync(path.join(root, "profile", "_dropped.yaml"), "utf8")) as Record<string, string>[];
    expect(e.source).toBe("proposal:prof.p2");
    expect(e.hash).toMatch(/^[0-9a-f]{12}$/);
  });
  it("--drop of an active trait archives it in one commit", () => {
    dropItems(ctx, ["prof.seed"], "no longer true");
    expect(fs.existsSync(path.join(root, "profile", "seed.md"))).toBe(false);
    expect(parseTrait(fs.readFileSync(path.join(root, "profile", "_archive", "seed.md"), "utf8"))).toMatchObject({ status: "archived" });
    expect(git(root, "show", "--no-renames", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["profile/_archive/seed.md", "profile/seed.md"]);
    expect(audit()).toContainEqual(expect.objectContaining({ event: "item.archived", itemId: "prof.seed" }));
  });
  it("--drop needs a reason", () => {
    propose("p1");
    expect(dropItems(ctx, ["prof.p1"], "")[0].error).toMatch(/reason/);
  });
  it("--edit replaces fields and body, then keeps", () => {
    propose("p1");
    const r = editItem(ctx, "prof.p1", input("Edited wording.", "Edited body.\n"));
    expect(r.ok).toBe(true);
    expect(read("p1.md")).toMatchObject({ summary: "Edited wording.", body: "Edited body.\n", confirmed: true, status: "active" });
    expect(commits(root)[0]).toBe("profile: edit prof.p1");
  });
  it("--edit refuses a proposal whose id already exists as a live trait (review 5)", () => {
    propose("seed", { body: "proposal body\n" });
    const r = editItem(ctx, "prof.seed", input("Clobber."));
    expect(r.error).toMatch(/exists/);
    expect(read("seed.md").summary).toBe("seed");
  });
  it("crew sessions are refused for keep, drop, edit and check --fix", () => {
    propose("p1");
    const crew = { ...ctx, env: { ...ctx.env, SQUADRANT_CREW_TASK_ID: "t1" } };
    expect(keepItems(crew, ["prof.p1"])[0].error).toMatch(/crew/);
    expect(dropItems(crew, ["prof.p1"], "x")[0].error).toMatch(/crew/);
    expect(editItem(crew, "prof.p1", input("x")).error).toMatch(/crew/);
    expect(() => checkProfile(crew, true)).toThrow(/crew/);
    expect(fs.existsSync(path.join(root, "profile", "_proposed", "p1.md"))).toBe(true);
  });
});

describe("profile list --check", () => {
  it("reports invalid and uncommitted trait files; --fix commits the uncommitted ones", () => {
    addTrait(ctx, { text: input("seed"), kind: "preference", apply: true, id: "seed" });
    fs.writeFileSync(path.join(root, "profile", "hand.md"), serializeTrait(trait("hand", "Hand written.")));
    fs.writeFileSync(path.join(root, "profile", "bad.md"), "no frontmatter");
    const r = checkProfile(ctx, false);
    expect(r.problems.join("\n")).toMatch(/bad\.md/);
    expect(r.uncommitted).toEqual(["profile/bad.md", "profile/hand.md"]);
    const f = checkProfile(ctx, true);
    expect(f.fixed).toEqual(["profile/hand.md"]);
    expect(git(root, "status", "--porcelain", "--", "profile/hand.md")).toBe("");
  });
  it("--fix never commits _proposed/ bodies, even when .gitignore is gone (review M2)", () => {
    addTrait(ctx, { text: input("seed"), kind: "preference", apply: true, id: "seed" });
    addTrait(ctx, { text: input("Proposed body."), kind: "preference", id: "prop" });
    fs.rmSync(path.join(root, ".gitignore"));
    git(root, "commit", "-qam", "drop ignore");
    const r = checkProfile(ctx, true);
    expect(r.fixed).toEqual([]);
    expect(r.problems.join()).toMatch(/\.gitignore/);
    expect(git(root, "log", "--all", "--name-only", "--format=")).not.toContain("_proposed");
  });
});
