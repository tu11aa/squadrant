// #899 eval: labelled T0 matching cases (glob / anchor / lexical), budget, once-per-session, overflow.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import {
  computeRulesInjection, kbRulesDir, globMatches, applyBudget, formatSessionContext, type RulesInjectInput,
} from "../knowledge/index.js";

let root: string;
const cfg = (): SquadrantConfig => {
  const c = getDefaultConfig();
  c.hubVault = path.join(root, "hub");
  c.knowledgeBases = { biz: { path: path.join(root, "kb", "biz") } };
  c.projects = {
    shop: { path: path.join(root, "shop"), captainName: "s", spokeVault: path.join(root, "spoke"), host: "local", knowledge: ["biz"] },
    other: { path: path.join(root, "other"), captainName: "o", spokeVault: path.join(root, "spoke2"), host: "local", knowledge: ["biz"] },
  };
  return c;
};
interface R { id: string; mod?: string; kw?: string[]; globs?: string[]; when?: string; paths?: string[]; symbols?: string[]; anchorProject?: string }
function put(r: R) {
  const dir = path.join(kbRulesDir(cfg(), "biz"), "x");
  fs.mkdirSync(dir, { recursive: true });
  const trig = [r.kw && `  keywords: [${r.kw.join(", ")}]`, r.globs && `  globs: [${r.globs.map((g) => `'${g}'`).join(", ")}]`, r.when && `  when: ${r.when}`].filter(Boolean);
  const anchors = r.paths || r.symbols
    ? `anchors:\n  ${r.anchorProject ?? "shop"}:\n${r.paths ? `    paths: [${r.paths.join(", ")}]\n` : ""}${r.symbols ? `    symbols: [${r.symbols.join(", ")}]\n` : ""}` : "";
  fs.writeFileSync(path.join(dir, `${r.id}.md`),
    `---\nid: ${r.id}\ndomain: biz\nmodality: ${r.mod ?? "must"}\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n`
    + (trig.length ? `triggers:\n${trig.join("\n")}\n` : "") + anchors + `---\nStatement for ${r.id}.\n`);
}
const input = (over: Partial<RulesInjectInput>): RulesInjectInput => ({
  event: "prompt-submit", payload: { session_id: "s" }, cfg: cfg(), env: {}, cwd: path.join(root, "shop"),
  stateRoot: path.join(root, "state"),
  audit: { dir: path.join(root, "audit"), now: () => new Date("2026-10-10T00:00:00Z"), machineId: "m" }, ...over,
});
let n = 0;
const ids = (text: string | null) => (text ?? "").split("\n").map((l) => /^(?:MUST-NOT|MUST|SHOULD|MAY) (\S+):/.exec(l)?.[1]).filter(Boolean) as string[];
const prompt = (text: string) => ids(computeRulesInjection(input({ payload: { session_id: `p${n++}`, prompt: text } })));
const read = (file: string, project = "shop") =>
  ids(computeRulesInjection(input({
    event: "post-read", cwd: path.join(root, project),
    payload: { session_id: `r${n++}`, tool_name: "Read", tool_input: { file_path: path.join(root, project, file) } },
  })));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-eval-"));
  put({ id: "biz.vnd-rounding", kw: ["invoice", "vnd", "rounding"], symbols: ["computeTotal"], paths: ["src/billing/total.ts"] });
  put({ id: "biz.contract-sol", globs: ["contracts/**/*.sol"], mod: "must-not" });
  put({ id: "biz.migrations", globs: ["db/migrations/*.sql"] });
  put({ id: "biz.env-files", globs: [".env*"] });
  put({ id: "biz.other-anchor", symbols: ["legacyFn"], paths: ["src/legacy.ts"], anchorProject: "other" });
  put({ id: "biz.refund-window", kw: ["refund", "chargeback"], when: "handling customer refunds" });
  put({ id: "biz.tax-id", kw: ["mst", "taxcode"], symbols: ["validateTaxId"] });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("globMatches", () => {
  it.each([
    ["contracts/**/*.sol", "contracts/a/b/V.sol", true],
    ["contracts/**/*.sol", "contracts/V.sol", true],
    ["contracts/**/*.sol", "src/V.sol", false],
    ["*.md", "docs/readme.md", true],
    ["src/*.ts", "src/a/b.ts", false],
    [".env*", "apps/web/.env.local", true],
  ])("%s vs %s → %s", (g, p, want) => expect(globMatches(g, p)).toBe(want));
});

// [label, expected ids] — 30 labelled cases through the real hook entry point.
describe("T0 matching eval", () => {
  const cases: [string, () => string[], string[]][] = [
    ["glob: nested sol file", () => read("contracts/vault/Vault.sol"), ["biz.contract-sol"]],
    ["glob: top-level sol file", () => read("contracts/Token.sol"), ["biz.contract-sol"]],
    ["glob: sql migration", () => read("db/migrations/001_init.sql"), ["biz.migrations"]],
    ["glob: nested sql is not a migration", () => read("db/migrations/old/001.sql"), []],
    ["glob: dotenv basename", () => read("apps/web/.env.local"), ["biz.env-files"]],
    ["anchor path: read the anchored file", () => read("src/billing/total.ts"), ["biz.vnd-rounding"]],
    ["anchor path: other file silent", () => read("src/billing/other.ts"), []],
    ["anchor path: another project's anchor does not fire", () => read("src/legacy.ts"), []],
    ["anchor path: that project's own anchor fires", () => read("src/legacy.ts", "other"), ["biz.other-anchor"]],
    ["read: unrelated file silent", () => read("README.md"), []],
    ["read: file outside the project silent", () => ids(computeRulesInjection(input({
      event: "post-read", payload: { session_id: "o1", tool_name: "Read", tool_input: { file_path: "/etc/hosts" } } }))), []],
    ["read: non-Read tool silent", () => ids(computeRulesInjection(input({
      event: "post-read", payload: { session_id: "o2", tool_name: "Edit", tool_input: { file_path: path.join(root, "shop", "contracts", "A.sol") } } }))), []],
    ["read: crew worktree path strips .worktrees/<crew>/", () => ids(computeRulesInjection(input({
      event: "post-read", cwd: path.join(root, "shop", ".worktrees", "c1"),
      payload: { session_id: "w1", tool_name: "Read", tool_input: { file_path: path.join(root, "shop", ".worktrees", "c1", "contracts", "A.sol") } } }))), ["biz.contract-sol"]],
    ["anchor symbol: computeTotal without the word invoice", () => prompt("why does computeTotal return a float?"), ["biz.vnd-rounding"]],
    ["anchor symbol: in a sentence with punctuation", () => prompt("can you refactor computeTotal()? thanks"), ["biz.vnd-rounding"]],
    ["anchor symbol: case matters (computetotal is not the symbol)", () => prompt("what does computetotal do"), []],
    ["anchor symbol: substring is not an identifier", () => prompt("explain computeTotalPrice please"), []],
    ["anchor symbol: another project's symbol silent", () => prompt("remove legacyFn from the codebase"), []],
    ["anchor symbol: second rule", () => prompt("validateTaxId crashes on empty input"), ["biz.tax-id"]],
    ["path in prompt: anchored file", () => prompt("look at src/billing/total.ts and tell me what it does"), ["biz.vnd-rounding"]],
    ["path in prompt: glob match", () => prompt("add a test next to contracts/vault/Vault.sol"), ["biz.contract-sol"]],
    ["lexical: two curated keywords", () => prompt("round the invoice total in vnd"), ["biz.vnd-rounding"]],
    ["lexical: when + keyword", () => prompt("we are handling a refund chargeback for a customer"), ["biz.refund-window"]],
    ["lexical: single weak keyword stays silent", () => prompt("print the invoice"), []],
    ["lexical: chit-chat", () => prompt("thanks, looks good!"), []],
    ["lexical: empty prompt", () => prompt(""), []],
    ["lexical: code fence is ignored", () => prompt("```\nrefund chargeback invoice vnd\n```"), []],
    ["system notice is never matched", () => prompt("CREW DONE [x]: computeTotal invoice vnd"), []],
    ["structural + lexical on one prompt rank structural first", () => prompt("computeTotal: handle the refund chargeback case"), ["biz.vnd-rounding", "biz.refund-window"]],
    ["two structural hits in one prompt", () => prompt("computeTotal and validateTaxId both fail"), ["biz.tax-id", "biz.vnd-rounding"]],
    ["same rule matched twice is listed once", () => prompt("computeTotal in src/billing/total.ts, the invoice vnd rounding"), ["biz.vnd-rounding"]],
  ];
  it("has ~30 labelled cases", () => expect(cases.length).toBeGreaterThanOrEqual(30));
  it.each(cases)("%s", (_label, run, want) => expect(run()).toEqual(want));
});

describe("budget, once per session, overflow", () => {
  it("applyBudget caps count and chars, always keeps the first rule", () => {
    const items = Array.from({ length: 8 }, (_, k) => ({ rule: { id: `r${k}` } as never }));
    expect(applyBudget(items, () => 10).shown).toHaveLength(5);
    expect(applyBudget(items, () => 1500, 5, 3200).shown).toHaveLength(2);
    expect(applyBudget(items, () => 9999).shown).toHaveLength(1);
  });
  it("a prompt hitting 7 symbols shows 5 and collapses the rest into one line", () => {
    for (let k = 0; k < 7; k++) put({ id: `bulk.r${k}`, symbols: [`symbolNumber${k}`] });
    const text = computeRulesInjection(input({ payload: { session_id: "ov", prompt: Array.from({ length: 7 }, (_, k) => `symbolNumber${k}`).join(" ") } }))!;
    expect(ids(text)).toHaveLength(5);
    expect(text).toMatch(/\+2 more: squadrant rules show bulk\.r\d bulk\.r\d\n/);
    // the overflow rules were not marked seen: a follow-up prompt surfaces them
    const next = computeRulesInjection(input({ payload: { session_id: "ov", prompt: "symbolNumber5 symbolNumber6 symbolNumber0" } }));
    expect(ids(next)).toHaveLength(2);
  });
  it("each rule once per session across prompt and read", () => {
    const sess = { session_id: "once" };
    const a = computeRulesInjection(input({ payload: { ...sess, prompt: "fix computeTotal" } }));
    const b = computeRulesInjection(input({ event: "post-read", payload: { ...sess, tool_name: "Read", tool_input: { file_path: path.join(root, "shop", "src/billing/total.ts") } } }));
    expect(ids(a)).toEqual(["biz.vnd-rounding"]);
    expect(b).toBeNull();
  });
  it("the session block obeys the token budget and reports the hidden count", () => {
    const rules = Array.from({ length: 20 }, (_, k) => ({ id: `a.r${k}`, modality: "must", status: "active", statement: "x".repeat(300), layer: "kb:biz" }));
    const { ids: shown, hiddenIds, text } = formatSessionContext(["biz"], rules as never);
    expect(shown.length).toBeLessThan(20);
    expect(shown.length + hiddenIds.length).toBe(20);
    expect(text).toContain(`+${hiddenIds.length} more`);
  });
  it("audits read injections with trigger 'tool'", () => {
    read("contracts/A.sol");
    const f = fs.readdirSync(path.join(root, "audit"))[0];
    const evs = fs.readFileSync(path.join(root, "audit", f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(evs).toContainEqual(expect.objectContaining({ event: "item.surfaced", trigger: "tool", itemId: "biz.contract-sol" }));
  });
});
