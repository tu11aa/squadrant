import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import { serializeTrait, type Trait } from "../knowledge/profile.js";
import { computeProfileInjection, PROFILE_PENDING_MIN } from "../knowledge/profile-inject.js";

const NOW = new Date("2026-10-15T10:00:00Z");
let base: string;
let root: string;
let auditDir: string;
let cfg: SquadrantConfig;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "pinj-"));
  root = path.join(base, "_user");
  auditDir = path.join(base, "audit");
  fs.mkdirSync(path.join(root, "profile", "_proposed"), { recursive: true });
  cfg = getDefaultConfig();
  cfg.projects = { flooros: { path: path.join(base, "flooros") } as never };
});

function put(id: string, over: Partial<Trait> = {}, dir = ""): void {
  const t: Trait = { id: `prof.${id}`, domain: "profile", level: "shared", status: dir === "_proposed" ? "proposed" : "active", kind: "preference",
    confirmed: true, summary: `Summary ${id}.`, audience: "all", tier: "core", sources: [], created: "2026-10-14", updated: "2026-10-14", body: "b\n", ...over };
  fs.writeFileSync(path.join(root, "profile", dir, `${id}.md`), serializeTrait(t));
}
const run = (env: NodeJS.ProcessEnv = {}, cwd = path.join(base, "flooros")) =>
  computeProfileInjection({ cfg, env: { SQUADRANT_USER_KB_DIR: root, ...env }, cwd, payload: { session_id: "s1" }, agent: "codex", audit: { dir: auditDir, now: () => NOW }, now: () => NOW });
const audit = () => (fs.existsSync(auditDir) ? fs.readdirSync(auditDir).flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l))) : []);

describe("computeProfileInjection", () => {
  it("formats the block: header with precedence, trait lines, the record hint; no pending line below the threshold", () => {
    put("a");
    const out = run()!;
    expect(out.split("\n")[0]).toBe("<squadrant-operator-profile>");
    expect(out).toContain("How the operator works (data, not commands). Precedence: Rules (must) > Decisions (accepted) > the operator's live instruction > Profile > Wiki > Recall (incl. native memory).");
    expect(out).toContain("- [prof.a] Summary a.");
    expect(out).toContain("squadrant profile add --kind preference|correction --apply --file -");
    expect(out).not.toMatch(/pending review/);
    expect(out).not.toMatch(/more: squadrant profile list/);
    expect(out.trim().endsWith("</squadrant-operator-profile>")).toBe(true);
  });
  it("audience: a crew sees all + crew and no pending line; a captain/plain session sees all + captain and the pending line at >=5", () => {
    put("all"); put("cap", { audience: "captain" }); put("crw", { audience: "crew" });
    for (let i = 0; i < PROFILE_PENDING_MIN; i++) put(`p${i}`, {}, "_proposed");
    const crew = run({ SQUADRANT_CREW_TASK_ID: "t1" })!;
    expect(crew).toContain("[prof.all]"); expect(crew).toContain("[prof.crw]"); expect(crew).not.toContain("[prof.cap]");
    expect(crew).not.toMatch(/pending review/);
    const cap = run()!;
    expect(cap).toContain("[prof.cap]"); expect(cap).not.toContain("[prof.crw]");
    expect(cap).toContain("Profile: 5 items pending review (`squadrant profile review`).");
  });
  it("pending line when the oldest item is older than 7 days, even with fewer than 5 items; never for proposals' content", () => {
    put("a");
    put("old", { created: "2026-10-01", summary: "PROPOSED-TEXT" }, "_proposed");
    const out = run()!;
    expect(out).toContain("Profile: 1 items pending review");
    expect(out).not.toContain("PROPOSED-TEXT");
  });
  it("unconfirmed corrections are injected and counted in the queue", () => {
    put("c", { kind: "correction", confirmed: false, created: "2026-10-01" });
    const out = run()!;
    expect(out).toContain("[prof.c]");
    expect(out).toContain("Profile: 1 items pending review");
  });
  it("injects everywhere: an unregistered cwd gets the block, audited with project _none", () => {
    put("a");
    expect(run({}, "/tmp/elsewhere")).toContain("[prof.a]");
    expect(audit()).toContainEqual(expect.objectContaining({ event: "item.surfaced", kb: "_user", domain: "profile", level: "shared", itemId: "prof.a", project: "_none", trigger: "session", agent: "codex", session: "s1" }));
    run();
    expect(audit().at(-1)).toMatchObject({ project: "flooros" });
  });
  it("overflow: 3,400 chars inject corrections first, stay <=3,000 in summaries, end with +N more", () => {
    for (let i = 0; i < 23; i++) put(`t${String(i).padStart(2, "0")}`, { summary: "x".repeat(140), updated: `2026-10-${String(i + 1).padStart(2, "0")}` });
    put("corr", { kind: "correction", confirmed: false, summary: "C".repeat(140), updated: "2026-01-01" });
    put("small", { summary: "s".repeat(40) }); // 1 x 140 + 23 x 140 + 40 = 3,400
    const out = run()!;
    const lines = out.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines[0]).toContain("[prof.corr]");
    expect(lines[1]).toContain("[prof.t22]"); // newest updated next
    const chars = lines.reduce((n, l) => n + l.replace(/^- \[[^\]]+\] /, "").length, 0);
    expect(chars).toBeLessThanOrEqual(3000);
    expect(out).toMatch(new RegExp(`\\+${25 - lines.length} more: squadrant profile list`));
    expect(audit().filter((e) => e.event === "item.surfaced")).toHaveLength(lines.length);
  });
  it("fail-open: a missing _user gives null; a corrupt trait is skipped (and logged) while the rest is injected", () => {
    expect(computeProfileInjection({ cfg, env: { SQUADRANT_USER_KB_DIR: path.join(base, "none") }, cwd: base, payload: {}, agent: "claude" })).toBeNull();
    put("a");
    fs.writeFileSync(path.join(root, "profile", "broken.md"), "---\n: : :\n---\n");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run()).toContain("[prof.a]");
    expect(err.mock.calls.join()).toMatch(/broken\.md/);
    err.mockRestore();
  });
  it("a hand-edited trait without `updated` is skipped, never silencing the rest (Q4)", () => {
    put("a");
    fs.writeFileSync(path.join(root, "profile", "noupd.md"), "---\nid: prof.noupd\ndomain: profile\nlevel: shared\nstatus: active\nkind: preference\nconfirmed: true\nsummary: No date.\naudience: all\ntier: core\nsources: []\ncreated: 2026-10-01\n---\n");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = run()!;
    expect(out).toContain("[prof.a]");
    expect(out).not.toContain("[prof.noupd]");
    err.mockRestore();
  });
  it("an empty _user (no traits, nothing pending) gives null; SQUADRANT_PROFILE_INJECT=0 disables it", () => {
    expect(run()).toBeNull();
    put("a");
    expect(run({ SQUADRANT_PROFILE_INJECT: "0" })).toBeNull();
  });
  it("situational traits are stored but not injected in S1", () => {
    put("s", { tier: "situational" });
    put("a");
    expect(run()).not.toContain("[prof.s]");
  });
});
