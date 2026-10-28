// #979 2a §4.4: the generic matcher and injection over KbItem, plus cross-company isolation.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, type KbItem, type SquadrantConfig } from "@squadrant/shared";
import {
  applyBudget, computeRulesInjection, matchPaths, searchRules, LIVE_ITEM_STATUSES, PRECEDENCE_LINE, type RulesInjectInput,
} from "../knowledge/index.js";
import { serializeTrait } from "../knowledge/profile.js";

let root: string;
const NOW = new Date("2026-10-28T01:02:03Z");

const rule = (id: string, modality: string, body: string, keywords: string[]) =>
  `---\nid: ${id}\ndomain: coding\nmodality: ${modality}\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n`
  + `triggers:\n  keywords: [${keywords.join(", ")}]\n---\n${body}\n`;
const decision = (id: string, summary: string, keywords: string[], status = "accepted", globs: string[] = []) =>
  `---\nid: ${id}\nstatus: ${status}\nsources: ["issue:1"]\ncreated: 2026-10-01\nupdated: 2026-10-01\nsummary: ${summary}\n`
  + `triggers:\n  keywords: [${keywords.join(", ")}]\n${globs.length ? `  globs: [${globs.map((g) => `"${g}"`).join(", ")}]\n` : ""}---\n# ${summary}\n\nWhy.\n`;
function write(rel: string, text: string) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

function cfg(): SquadrantConfig {
  const c = getDefaultConfig();
  c.hubVault = path.join(root, "hub");
  c.knowledgeBases = { acme: { path: path.join(root, "kb", "acme") }, globex: { path: path.join(root, "kb", "globex") } };
  c.groups = { acme: { kb: "acme" }, globex: { kb: "globex" } };
  c.projects = {
    projA: { path: path.join(root, "projA"), captainName: "a", spokeVault: path.join(root, "spoke"), host: "local", group: "acme" },
    projB: { path: path.join(root, "projB"), captainName: "b", spokeVault: path.join(root, "spoke"), host: "local", group: "globex" },
  } as SquadrantConfig["projects"];
  return c;
}
const userKb = () => path.join(root, "user-kb");
const auditDir = () => path.join(root, "audit");
const input = (over: Partial<RulesInjectInput>): RulesInjectInput => ({
  event: "session-start", payload: { session_id: "s1" }, cfg: cfg(), env: { SQUADRANT_USER_KB_DIR: userKb() },
  cwd: path.join(root, "projA"), stateRoot: path.join(root, "state"),
  audit: { dir: auditDir(), now: () => NOW, machineId: "m1" }, ...over,
});
const events = () => {
  const f = path.join(auditDir(), "2026-10.m1.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};
const ALL = { index: ["decisions" as const], match: ["rules" as const, "decisions" as const] };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-items-inject-"));
  write("kb/acme/shared/rules/coding/coding.tabs.md", rule("coding.tabs", "must", "Indent with tabs.", ["indent", "tabs"]));
  write("kb/acme/shared/decisions/dec.acme-db.md", decision("dec.acme-db", "Use Postgres for every service database.", ["postgres", "database"], "accepted", ["db/**"]));
  write("kb/acme/shared/decisions/dec.acme-old.md", decision("dec.acme-old", "Use MySQL.", ["mysql"], "superseded"));
  write("kb/globex/shared/rules/coding/coding.globex-only.md", rule("coding.globex-only", "must", "Globex spaces only.", ["indent", "tabs"]));
  write("kb/globex/shared/decisions/dec.globex-db.md", decision("dec.globex-db", "Globex postgres database cluster.", ["postgres", "database"], "accepted", ["db/**"]));
  fs.mkdirSync(path.join(userKb(), "profile"), { recursive: true });
  fs.writeFileSync(path.join(userKb(), "profile", "tabs.md"), serializeTrait({
    id: "prof.tabs", domain: "profile", level: "shared", status: "active", kind: "preference", confirmed: true,
    summary: "Operator likes postgres database tabs.", audience: "all", tier: "core", sources: [], created: "2026-10-14", updated: "2026-10-14", body: "b\n",
  }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const item = (over: Partial<KbItem>): KbItem => ({
  id: "dec.x", kbDomain: "decisions", kb: "acme", level: "shared", status: "accepted", sources: [], summary: "Use queues for jobs.",
  body: "# Use queues for jobs.\n\nWhy.", path: "/x", origin: "acme/shared", ...over,
});

describe("generic matcher over KbItem", () => {
  it("searchRules scores an item's summary and triggers; accepted is live, superseded is not", () => {
    const items = [item({ triggers: { keywords: ["queue"] } }), item({ id: "dec.y", status: "superseded", summary: "Use queues for mail." })];
    const hits = searchRules(items, "queues jobs", { statuses: LIVE_ITEM_STATUSES });
    expect(hits.map((h) => h.rule.id)).toEqual(["dec.x"]);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(searchRules(items, "queues jobs")).toEqual([]); // Phase 1 default statuses (active, stale) unchanged
  });
  it("matchPaths takes accepted decisions, never superseded ones; applyBudget takes items", () => {
    const items = [item({ triggers: { globs: ["db/**"] } }), item({ id: "dec.y", status: "superseded", triggers: { globs: ["db/**"] } })];
    const hits = matchPaths(items, "projA", ["db/schema.sql"]);
    expect(hits).toEqual([{ rule: items[0], via: "glob" }]);
    expect(applyBudget(hits, (r) => r.summary!.length, 1).shown).toHaveLength(1);
  });
});

describe("computeRulesInjection — session start (#979)", () => {
  it("carries the arch §6 precedence line; the default index is empty in 2a", () => {
    const text = computeRulesInjection(input({}))!;
    expect(text.split("\n")).toContain(PRECEDENCE_LINE);
    expect(PRECEDENCE_LINE).toBe("Precedence: Rules (must) > Decisions (accepted) > the operator's live instruction > Profile > Wiki > Recall (incl. native memory).");
    expect(text).toContain("MUST coding.tabs: Indent with tabs.");
    expect(text).not.toContain("dec.acme-db");
    expect(text).not.toContain("Other knowledge");
  });
  it("an index domain adds one `[id] summary` line per live item; profile and rules are never indexed", () => {
    const text = computeRulesInjection(input({ domains: { index: ["decisions", "profile", "rules"] } }))!;
    expect(text).toContain("[dec.acme-db] Use Postgres for every service database.");
    expect(text).not.toContain("dec.acme-old");
    expect(text).not.toContain("prof.tabs");
    expect(text.match(/coding\.tabs/g)).toHaveLength(1);
    const ev = events().filter((e) => e.itemId === "dec.acme-db");
    expect(ev).toEqual([expect.objectContaining({ kb: "acme", level: "shared", domain: "decisions", event: "item.surfaced", trigger: "session", project: "projA" })]);
    expect(events().find((e) => e.itemId === "coding.tabs")).toMatchObject({ kb: "acme", level: "shared", domain: "rules", category: "coding" });
  });
  it("the index shares the ≈800-token budget with rule lines; overflow points at knowledge list and is logged suppressed", () => {
    for (let n = 0; n < 40; n++) write(`kb/acme/shared/decisions/dec.long-${n}.md`, decision(`dec.long-${String(n).padStart(2, "0")}`, `Long decision ${n} ${"x".repeat(100)}`, ["k"]));
    const text = computeRulesInjection(input({ domains: { index: ["decisions"] } }))!;
    const shown = text.split("\n").filter((l) => l.startsWith("[dec."));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(41);
    const more = /\+(\d+) more: squadrant knowledge list/.exec(text);
    expect(Number(more![1])).toBe(41 - shown.length);
    const chars = text.split("\n").filter((l) => /^(MUST|\[dec\.)/.test(l)).reduce((n, l) => n + l.length, 0);
    expect(chars).toBeLessThanOrEqual(3200);
    expect(events().filter((e) => e.domain === "decisions" && e.event === "item.suppressed")).toHaveLength(41 - shown.length);
  });
});

describe("computeRulesInjection — prompt and Read (#979)", () => {
  const prompt = (text: string, over: Partial<RulesInjectInput> = {}) =>
    computeRulesInjection(input({ event: "prompt-submit", payload: { session_id: "p1", prompt: text }, ...over }));
  it("only rules are opted in by default: a decision's triggers do not match", () => {
    expect(prompt("which postgres database should the service use")).toBeNull();
  });
  it("an opted-in domain matches by triggers, renders `[id] summary`, audits its domain, and is seen once per session", () => {
    const text = prompt("which postgres database should the service use", { domains: ALL })!;
    expect(text).toContain("[dec.acme-db] Use Postgres for every service database.");
    expect(events().find((e) => e.itemId === "dec.acme-db" && e.event === "item.surfaced"))
      .toMatchObject({ kb: "acme", level: "shared", domain: "decisions", trigger: "prompt", project: "projA" });
    expect(JSON.parse(fs.readFileSync(path.join(root, "state", "rules-inject", "p1.json"), "utf8"))).toEqual(["dec.acme-db"]);
    expect(prompt("which postgres database should the service use", { domains: ALL })).toBeNull();
  });
  it("after Read, an opted-in item's glob matches the file", () => {
    const read = (session: string, domains?: RulesInjectInput["domains"]) => computeRulesInjection(input({
      event: "post-read", domains, payload: { session_id: session, tool_name: "Read", tool_input: { file_path: path.join(root, "projA", "db", "schema.sql") } },
    }));
    expect(read("r1")).toBeNull();
    expect(read("r2", ALL)).toContain("[dec.acme-db]");
  });
});

describe("isolation: two company KBs (#979 §8)", () => {
  const run = (project: "projA" | "projB", event: RulesInjectInput["event"], payload: Record<string, unknown>) =>
    computeRulesInjection(input({ event, domains: ALL, cwd: path.join(root, project), payload: { session_id: `${project}-${event}`, ...payload } })) ?? "";
  it("no cross-company item reaches a session, a prompt or a Read", () => {
    const db = { tool_name: "Read" };
    const a = [run("projA", "session-start", {}), run("projA", "prompt-submit", { prompt: "postgres database indent tabs" }),
      run("projA", "post-read", { ...db, tool_input: { file_path: path.join(root, "projA", "db", "a.sql") } })].join("\n");
    const b = [run("projB", "session-start", {}), run("projB", "prompt-submit", { prompt: "postgres database indent tabs" }),
      run("projB", "post-read", { ...db, tool_input: { file_path: path.join(root, "projB", "db", "a.sql") } })].join("\n");
    expect(a).toContain("dec.acme-db");
    expect(a).toContain("coding.tabs");
    expect(a).not.toMatch(/globex/);
    expect(b).toContain("dec.globex-db");
    expect(b).toContain("coding.globex-only");
    expect(b).not.toMatch(/acme|coding\.tabs/);
    expect(events().filter((e) => e.project === "projA").every((e) => e.kb === "acme")).toBe(true);
    expect(events().filter((e) => e.project === "projB").every((e) => e.kb === "globex")).toBe(true);
  });
});
