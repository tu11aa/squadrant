# Rules KB 1/6 (Store, Schema, Layers, Basic CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the on-disk rules knowledge base and its schema, project/KB layer resolution, `index.json` compile, and the read-only CLI (`squadrant knowledge init|subscribe|sources`, `squadrant rules show|search`), plus `doctor` checks. Issue #896.

**Architecture:**
- The pure types and validators live in `@squadrant/shared` (`knowledge.ts`), and `config.ts` gains the `knowledge` config fields.
- File IO lives in `@squadrant/core/src/knowledge/`: paths, the rule loader (gray-matter frontmatter), layer resolution, index compile, search, and the sources loader. `@squadrant/core` re-exports these.
- The CLI commands in `@squadrant/cli` are thin wrappers that follow the `effort.ts` pattern: an exported `runX()` function that tests call directly, plus a commander `Command`.
- Nothing reads outside the KB or the spoke dirs.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, commander, gray-matter (already a root and cli dependency), js-yaml v4 (new dependency of core).

**Spec:** `docs/specs/2026-10-07-rules-kb-design.md` (§3; decisions D2, D3, D10). Epic #893.

## Global Constraints

- **Package DAG:** shared ◄ core ◄ cli. Shared imports nothing internal. Core never imports cli.
- **KB location:** `<hubVault>/knowledge/<kb>/` containing `sources.yaml`, `raw/`, `rules/<domain>/<id>.md`, `rules/_proposed/`, `index.json`.
- **Project layer location:** `<spokeVault>/knowledge/rules/`. A project rule with the same `id` replaces the KB rule entirely. `rulesDisabled: [id]` removes a rule.
- **KBs are not tied to `group`.** A project subscribes with `ProjectConfig.knowledge: string[]`.
- **KB config:** `SquadrantConfig.knowledge: Record<kb, { homeProject?, domainCap? }>`.
  - `domainCap` defaults to **150**.
  - `homeProject` defaults to the first project in `config.projects` insertion order that subscribes to the KB.
- **Allowed values:**
  - modality: `must | must-not | should | may`
  - status: `proposed | active | stale | retired`
  - priority: `company > project > agent`
  - approvedBy: `auto | reviewer-agent | human`
- **Rule ids are stable slugs** matching `/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/`.
- **Rule body:** the first paragraph is the statement, and the remainder is the rationale.
- **Search and show:**
  - By default they cover `active` and `stale` only. `--all` adds `proposed` and `retired`.
  - Delivery and matching are out of scope here; they belong to #899.
- **Doctor checks:**
  - Shown only when `config.knowledge` has at least one KB. They must not add a FAIL for users who never configured a KB (compare #876).
  - `markitdown` missing is a warning line, not a FAIL.
- `knowledge init` prints the privacy notice: "Sources are sent to the extraction crew's model; mark `sensitivity: local-only` to keep a source on local models only."

## Review Focus

1. **A malformed rule file** (bad YAML, missing `id`, unknown modality) must not crash `rules search`. Skip it and report it in `errors`. Covered by a Task 2 test.
2. **The same id in two domain folders of one KB** must resolve deterministically: the lexicographically first path wins, and the duplicate is reported as an error. Covered by a Task 2 test.
3. **A project that subscribes to a KB that doesn't exist**, or whose `rulesDisabled` names an unknown id, gets a warning, not an exception. Covered by a Task 3 test.
4. **Files in `rules/_proposed/`** must never appear in the default resolution. Covered by a Task 2 test.
5. **`rules search` run outside any registered project,** with no `--project` and no `SQUADRANT_CREW_PROJECT`, must fail with a clear message naming `--project`. Covered by a Task 7 test.

---

### Task 1: Shared schema, config types, validators

**Files:**
- Create: `packages/shared/src/knowledge.ts`
- Modify: `packages/shared/src/config.ts` (add `knowledge?`/`rulesDisabled?` to `ProjectConfig`; add `knowledge?` to `SquadrantConfig`)
- Modify: `packages/shared/src/index.ts` (export `./knowledge.js`)
- Test: `packages/shared/src/__tests__/knowledge.test.ts`

**Interfaces:**
- Produces:
  - Types: `RuleModality`, `RuleStatus`, `RuleApprover`, `SourcePriority`, `RuleSourceRef`, `RuleTriggers`, `RuleAnchors`, `RuleFrontmatter`, `Rule`, `KnowledgeSourceEntry`, `KnowledgeKbConfig`
  - Constants: `RULE_MODALITIES`, `RULE_STATUSES`, `SOURCE_PRIORITIES`, `RULE_ID_RE`, `KB_NAME_RE`, `DEFAULT_DOMAIN_CAP`
  - Functions:
    - `validateRuleFrontmatter(fm: unknown): string[]`
    - `validateSourceEntry(e: unknown): string[]`
    - `subscribedKbs(cfg: SquadrantConfig, project: string): string[]`
    - `resolveKbConfig(cfg: SquadrantConfig, kb: string): { homeProject?: string; domainCap: number }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/knowledge.test.ts
import { describe, it, expect } from "vitest";
import {
  validateRuleFrontmatter, validateSourceEntry, subscribedKbs, resolveKbConfig,
  DEFAULT_DOMAIN_CAP, getDefaultConfig,
} from "../index.js";
import type { SquadrantConfig } from "../index.js";

const good = {
  id: "biz.invoice.vnd-rounding", domain: "business", modality: "must", status: "active",
  triggers: { keywords: ["invoice"], when: "Computing VND amounts" },
  sources: [{ ref: "raw/p.pdf", sha: "9f2c", loc: "p.12", offset: [10, 40], quote: "All VND amounts shall be rounded half-up." }],
};

describe("validateRuleFrontmatter", () => {
  it("accepts a well-formed rule", () => {
    expect(validateRuleFrontmatter(good)).toEqual([]);
  });
  it("rejects a bad id, modality, status and empty sources", () => {
    const problems = validateRuleFrontmatter({ ...good, id: "Bad Id", modality: "maybe", status: "live", sources: [] });
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("id"), expect.stringContaining("modality"),
      expect.stringContaining("status"), expect.stringContaining("sources"),
    ]));
  });
  it("rejects a source without a quote and a malformed offset", () => {
    const problems = validateRuleFrontmatter({ ...good, sources: [{ ref: "r", sha: "s", offset: [1] }] });
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("quote"), expect.stringContaining("offset"),
    ]));
  });
  it("rejects non-object input", () => {
    expect(validateRuleFrontmatter(null)).toEqual(["frontmatter must be an object"]);
  });
});

describe("validateSourceEntry", () => {
  it("accepts path+priority and optional fields", () => {
    expect(validateSourceEntry({ path: "raw/**", priority: "company", domain: "coding", sensitivity: "local-only" })).toEqual([]);
  });
  it("rejects missing path and unknown priority/sensitivity", () => {
    const p = validateSourceEntry({ priority: "boss", sensitivity: "secret" });
    expect(p).toEqual(expect.arrayContaining([
      expect.stringContaining("path"), expect.stringContaining("priority"), expect.stringContaining("sensitivity"),
    ]));
  });
});

describe("subscription + kb config", () => {
  function cfg(): SquadrantConfig {
    const c = getDefaultConfig();
    c.projects = {
      alpha: { path: "/a", captainName: "a", spokeVault: "/v/a", host: "local" },
      flooros: { path: "/f", captainName: "f", spokeVault: "/v/f", host: "local", knowledge: ["saitex"] },
      core: { path: "/c", captainName: "c", spokeVault: "/v/c", host: "local", knowledge: ["saitex", "x"] },
    };
    return c;
  }
  it("subscribedKbs returns the project's list or []", () => {
    expect(subscribedKbs(cfg(), "core")).toEqual(["saitex", "x"]);
    expect(subscribedKbs(cfg(), "alpha")).toEqual([]);
  });
  it("homeProject defaults to the first subscriber; domainCap defaults to 150", () => {
    expect(resolveKbConfig(cfg(), "saitex")).toEqual({ homeProject: "flooros", domainCap: DEFAULT_DOMAIN_CAP });
  });
  it("explicit kb config wins", () => {
    const c = cfg();
    c.knowledge = { saitex: { homeProject: "core", domainCap: 20 } };
    expect(resolveKbConfig(c, "saitex")).toEqual({ homeProject: "core", domainCap: 20 });
  });
  it("homeProject is undefined when nobody subscribes", () => {
    expect(resolveKbConfig(cfg(), "nobody").homeProject).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/knowledge.test.ts`
Expected: FAIL. `validateRuleFrontmatter` is not exported, and `knowledge` is not a property of `ProjectConfig` (type error at runtime import).

- [ ] **Step 3: Add the config fields**

In `packages/shared/src/config.ts`, add these lines inside `interface ProjectConfig`, after `acceptDelegations?: boolean;`:

```ts
  /** #896 Rules KB: named knowledge bases this project subscribes to (spec D2). */
  knowledge?: string[];
  /** #896 Rules KB: KB rule ids switched off for this project. */
  rulesDisabled?: string[];
```

Add this import at the top, after the existing imports:

```ts
import type { KnowledgeKbConfig } from "./knowledge.js";
```

Add this inside `interface SquadrantConfig`, after `projection?: {...};`:

```ts
  /** #896 Rules KB: per-KB settings, keyed by KB name. Absent ⇒ no KB configured. */
  knowledge?: Record<string, KnowledgeKbConfig>;
```

- [ ] **Step 4: Write `knowledge.ts`**

```ts
// packages/shared/src/knowledge.ts
// #896 Rules KB — pure schema types + validators. Spec: docs/specs/2026-10-07-rules-kb-design.md §3.
import type { SquadrantConfig } from "./config.js";

export type RuleModality = "must" | "must-not" | "should" | "may";
export type RuleStatus = "proposed" | "active" | "stale" | "retired";
export type RuleApprover = "auto" | "reviewer-agent" | "human";
export type SourcePriority = "company" | "project" | "agent";

export const RULE_MODALITIES: readonly RuleModality[] = ["must", "must-not", "should", "may"];
export const RULE_STATUSES: readonly RuleStatus[] = ["proposed", "active", "stale", "retired"];
export const SOURCE_PRIORITIES: readonly SourcePriority[] = ["company", "project", "agent"];
export const RULE_APPROVERS: readonly RuleApprover[] = ["auto", "reviewer-agent", "human"];
export const RULE_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const KB_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const DEFAULT_DOMAIN_CAP = 150;

export interface RuleSourceRef {
  ref: string;
  sha: string;
  loc?: string;
  /** Char span [start, end) in the converted source — used for mechanical id matching (#897). */
  offset?: [number, number];
  quote: string;
}

export interface RuleTriggers {
  globs?: string[];
  keywords?: string[];
  expanded?: string[];
  when?: string;
}

/** Per-project anchors, keyed by project name. */
export type RuleAnchors = Record<string, { paths?: string[]; symbols?: string[] }>;

export interface RuleFrontmatter {
  id: string;
  domain: string;
  modality: RuleModality;
  status: RuleStatus;
  triggers?: RuleTriggers;
  anchors?: RuleAnchors;
  sources: RuleSourceRef[];
  approvedBy?: RuleApprover;
  justification?: string;
  supersedes?: string[];
  conflictsWith?: string[];
}

export interface Rule extends RuleFrontmatter {
  /** First paragraph of the body. */
  statement: string;
  /** Full markdown body (statement + rationale). */
  body: string;
  /** Absolute path of the rule file. */
  file: string;
  /** Where it came from: `kb:<name>` or `project:<name>`. */
  layer: string;
}

export interface KnowledgeSourceEntry {
  path: string;
  priority: SourcePriority;
  domain?: string;
  sensitivity?: "local-only";
}

export interface KnowledgeKbConfig {
  homeProject?: string;
  domainCap?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

export function validateRuleFrontmatter(fm: unknown): string[] {
  if (!isObj(fm)) return ["frontmatter must be an object"];
  const p: string[] = [];
  if (typeof fm.id !== "string" || !RULE_ID_RE.test(fm.id)) p.push(`id must match ${RULE_ID_RE}`);
  if (typeof fm.domain !== "string" || !/^[a-z][a-z0-9-]*$/.test(fm.domain)) p.push("domain must be a lowercase slug");
  if (!RULE_MODALITIES.includes(fm.modality as RuleModality)) p.push(`modality must be one of ${RULE_MODALITIES.join("|")}`);
  if (!RULE_STATUSES.includes(fm.status as RuleStatus)) p.push(`status must be one of ${RULE_STATUSES.join("|")}`);
  if (fm.approvedBy !== undefined && !RULE_APPROVERS.includes(fm.approvedBy as RuleApprover)) {
    p.push(`approvedBy must be one of ${RULE_APPROVERS.join("|")}`);
  }
  if (fm.triggers !== undefined) {
    if (!isObj(fm.triggers)) p.push("triggers must be an object");
    else {
      for (const k of ["globs", "keywords", "expanded"] as const) {
        if (fm.triggers[k] !== undefined && !isStrArr(fm.triggers[k])) p.push(`triggers.${k} must be a string array`);
      }
      if (fm.triggers.when !== undefined && typeof fm.triggers.when !== "string") p.push("triggers.when must be a string");
    }
  }
  for (const k of ["supersedes", "conflictsWith"] as const) {
    if (fm[k] !== undefined && !isStrArr(fm[k])) p.push(`${k} must be a string array`);
  }
  if (!Array.isArray(fm.sources) || fm.sources.length === 0) {
    p.push("sources must be a non-empty array");
  } else {
    fm.sources.forEach((s, i) => {
      if (!isObj(s)) { p.push(`sources[${i}] must be an object`); return; }
      for (const k of ["ref", "sha", "quote"] as const) {
        if (typeof s[k] !== "string" || s[k] === "") p.push(`sources[${i}].${k} must be a non-empty string`);
      }
      if (s.offset !== undefined) {
        const o = s.offset;
        if (!Array.isArray(o) || o.length !== 2 || !o.every((n) => Number.isInteger(n) && n >= 0) || o[0] > o[1]) {
          p.push(`sources[${i}].offset must be [start, end] integers with start <= end`);
        }
      }
    });
  }
  return p;
}

export function validateSourceEntry(e: unknown): string[] {
  if (!isObj(e)) return ["source entry must be an object"];
  const p: string[] = [];
  if (typeof e.path !== "string" || e.path === "") p.push("path must be a non-empty string");
  if (!SOURCE_PRIORITIES.includes(e.priority as SourcePriority)) p.push(`priority must be one of ${SOURCE_PRIORITIES.join("|")}`);
  if (e.domain !== undefined && typeof e.domain !== "string") p.push("domain must be a string");
  if (e.sensitivity !== undefined && e.sensitivity !== "local-only") p.push("sensitivity must be 'local-only' when set");
  return p;
}

export function subscribedKbs(cfg: SquadrantConfig, project: string): string[] {
  return cfg.projects[project]?.knowledge ?? [];
}

export function resolveKbConfig(cfg: SquadrantConfig, kb: string): { homeProject?: string; domainCap: number } {
  const explicit = cfg.knowledge?.[kb] ?? {};
  const firstSubscriber = Object.entries(cfg.projects).find(([, p]) => p.knowledge?.includes(kb))?.[0];
  return {
    homeProject: explicit.homeProject ?? firstSubscriber,
    domainCap: explicit.domainCap ?? DEFAULT_DOMAIN_CAP,
  };
}
```

In `packages/shared/src/index.ts`, add after `export * from "./effort.js";`:

```ts
export * from "./knowledge.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/shared/src/__tests__/knowledge.test.ts && pnpm lint`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/knowledge.ts packages/shared/src/config.ts packages/shared/src/index.ts packages/shared/src/__tests__/knowledge.test.ts
git commit -m "feat(shared): rules KB schema, validators, knowledge config (#896)"
```

---

### Task 2: Core paths and rule-file loader

**Files:**
- Create: `packages/core/src/knowledge/paths.ts`
- Create: `packages/core/src/knowledge/store.ts`
- Modify: `packages/core/package.json` (add `"gray-matter": "^4.0.3"` to dependencies)
- Modify: `packages/core/src/index.ts` (add `export * from "./knowledge/index.js";`)
- Create: `packages/core/src/knowledge/index.ts`
- Test: `packages/core/src/__tests__/knowledge-store.test.ts`

**Interfaces:**
- Consumes: `Rule`, `validateRuleFrontmatter` (Task 1)
- Produces:
  - Path helpers: `kbDir(hubVault, kb)`, `kbRulesDir(hubVault, kb)`, `projectRulesDir(spokeVault)`, `PROPOSED_DIR = "_proposed"`
  - `interface RuleLoadError { file: string; problems: string[] }`
  - `interface RuleLoadResult { rules: Rule[]; errors: RuleLoadError[] }`
  - `splitStatement(body: string): string`
  - `loadRulesDir(dir: string, layer: string, opts?: { includeProposed?: boolean }): RuleLoadResult`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/knowledge-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadRulesDir, splitStatement, kbRulesDir, projectRulesDir } from "../knowledge/index.js";

let dir: string;
function write(rel: string, text: string) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
export function ruleMd(id: string, extra = "", body = "Statement here.\n\nRationale.") {
  return `---\nid: ${id}\ndomain: ${id.split(".")[0] === "biz" ? "business" : "coding"}\nmodality: must\nstatus: active\n${extra}sources:\n  - { ref: raw/a.md, sha: abc, quote: "q" }\n---\n${body}\n`;
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-store-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("paths", () => {
  it("builds kb and project layer dirs", () => {
    expect(kbRulesDir("/hub", "saitex")).toBe(path.join("/hub", "knowledge", "saitex", "rules"));
    expect(projectRulesDir("/spoke")).toBe(path.join("/spoke", "knowledge", "rules"));
  });
});

describe("splitStatement", () => {
  it("returns the first paragraph, trimmed and single-lined", () => {
    expect(splitStatement("\n VND amounts are\nrounded half-up.\n\nWhy: tax.")).toBe("VND amounts are rounded half-up.");
  });
});

describe("loadRulesDir", () => {
  it("returns empty for a missing dir", () => {
    expect(loadRulesDir(path.join(dir, "nope"), "kb:x")).toEqual({ rules: [], errors: [] });
  });

  it("loads valid rules with statement, layer and file", () => {
    write("business/biz.a.md", ruleMd("biz.a"));
    const r = loadRulesDir(dir, "kb:saitex");
    expect(r.errors).toEqual([]);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]).toMatchObject({ id: "biz.a", statement: "Statement here.", layer: "kb:saitex" });
    expect(r.rules[0].file).toBe(path.join(dir, "business/biz.a.md"));
  });

  it("skips malformed files and reports them (Review Focus 1)", () => {
    write("coding/bad.md", "---\nid: [unclosed\n---\nx");
    write("coding/nomod.md", "---\nid: coding.x\ndomain: coding\nstatus: active\nsources: []\n---\nx");
    write("coding/coding.ok.md", ruleMd("coding.ok"));
    const r = loadRulesDir(dir, "kb:x");
    expect(r.rules.map((x) => x.id)).toEqual(["coding.ok"]);
    expect(r.errors.map((e) => path.basename(e.file)).sort()).toEqual(["bad.md", "nomod.md"]);
  });

  it("duplicate id: first path (sorted) wins, duplicate reported (Review Focus 2)", () => {
    write("a-domain/one.md", ruleMd("coding.dup"));
    write("b-domain/two.md", ruleMd("coding.dup"));
    const r = loadRulesDir(dir, "kb:x");
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0].file).toContain("a-domain");
    expect(r.errors[0].problems[0]).toContain("duplicate id coding.dup");
  });

  it("excludes _proposed by default (Review Focus 4), includes on request", () => {
    write("coding/coding.live.md", ruleMd("coding.live"));
    write("_proposed/coding.pending@abc.md", ruleMd("coding.pending"));
    expect(loadRulesDir(dir, "kb:x").rules.map((r) => r.id)).toEqual(["coding.live"]);
    expect(loadRulesDir(dir, "kb:x", { includeProposed: true }).rules.map((r) => r.id).sort())
      .toEqual(["coding.live", "coding.pending"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/knowledge-store.test.ts`
Expected: FAIL with "Cannot find module '../knowledge/index.js'".

- [ ] **Step 3: Implement**

Add `"gray-matter": "^4.0.3"` to `packages/core/package.json` → `dependencies`, then run `pnpm install`.

```ts
// packages/core/src/knowledge/paths.ts
import path from "node:path";

export const PROPOSED_DIR = "_proposed";
export function kbDir(hubVault: string, kb: string): string {
  return path.join(hubVault, "knowledge", kb);
}
export function kbRulesDir(hubVault: string, kb: string): string {
  return path.join(kbDir(hubVault, kb), "rules");
}
export function projectRulesDir(spokeVault: string): string {
  return path.join(spokeVault, "knowledge", "rules");
}
```

```ts
// packages/core/src/knowledge/store.ts
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { validateRuleFrontmatter, type Rule, type RuleFrontmatter } from "@squadrant/shared";
import { PROPOSED_DIR } from "./paths.js";

export interface RuleLoadError { file: string; problems: string[] }
export interface RuleLoadResult { rules: Rule[]; errors: RuleLoadError[] }

export function splitStatement(body: string): string {
  const first = body.trim().split(/\n\s*\n/)[0] ?? "";
  return first.replace(/\s+/g, " ").trim();
}

function listMarkdown(dir: string, includeProposed: boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === PROPOSED_DIR && !includeProposed) continue;
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

export function loadRulesDir(dir: string, layer: string, opts: { includeProposed?: boolean } = {}): RuleLoadResult {
  if (!fs.existsSync(dir)) return { rules: [], errors: [] };
  const rules: Rule[] = [];
  const errors: RuleLoadError[] = [];
  const seen = new Map<string, string>();
  for (const file of listMarkdown(dir, opts.includeProposed ?? false)) {
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(fs.readFileSync(file, "utf8"));
    } catch (e) {
      errors.push({ file, problems: [`frontmatter parse error: ${(e as Error).message}`] });
      continue;
    }
    const problems = validateRuleFrontmatter(parsed.data);
    if (problems.length) { errors.push({ file, problems }); continue; }
    const fm = parsed.data as RuleFrontmatter;
    const prior = seen.get(fm.id);
    if (prior) { errors.push({ file, problems: [`duplicate id ${fm.id} (also in ${prior})`] }); continue; }
    seen.set(fm.id, file);
    rules.push({ ...fm, statement: splitStatement(parsed.content), body: parsed.content.trim(), file, layer });
  }
  return { rules, errors };
}
```

```ts
// packages/core/src/knowledge/index.ts
export * from "./paths.js";
export * from "./store.js";
```

In `packages/core/src/index.ts`, add:

```ts
export * from "./knowledge/index.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/knowledge-store.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/knowledge packages/core/src/index.ts packages/core/src/__tests__/knowledge-store.test.ts
git commit -m "feat(core): rules KB paths and rule-file loader (#896)"
```

---

### Task 3: Layer resolution (KB subscriptions + project override + disable)

**Files:**
- Create: `packages/core/src/knowledge/layers.ts`
- Modify: `packages/core/src/knowledge/index.ts` (export layers)
- Test: `packages/core/src/__tests__/knowledge-layers.test.ts`

**Interfaces:**
- Consumes: `loadRulesDir`, `kbRulesDir`, `projectRulesDir`, `RuleLoadError` (Task 2); `subscribedKbs` (Task 1); `resolveHome` (shared)
- Produces:
  - `interface ResolvedRules { rules: Rule[]; errors: RuleLoadError[]; warnings: string[] }`
  - `resolveProjectRules(cfg: SquadrantConfig, project: string, opts?: { includeProposed?: boolean }): ResolvedRules`, where rules are sorted by id
  - `loadKbRules(cfg: SquadrantConfig, kb: string, opts?: { includeProposed?: boolean }): RuleLoadResult`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/knowledge-layers.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import { resolveProjectRules, kbRulesDir, projectRulesDir } from "../knowledge/index.js";

let root: string;
const rule = (id: string, body = "KB text.") =>
  `---\nid: ${id}\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n---\n${body}\n`;
function put(dir: string, id: string, body?: string) {
  fs.mkdirSync(path.join(dir, "coding"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coding", `${id}.md`), rule(id, body));
}
function cfg(over: Partial<SquadrantConfig["projects"][string]> = {}): SquadrantConfig {
  const c = getDefaultConfig();
  c.hubVault = path.join(root, "hub");
  c.projects = { flooros: { path: "/f", captainName: "f", spokeVault: path.join(root, "spoke"), host: "local", knowledge: ["saitex"], ...over } };
  return c;
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-layers-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("resolveProjectRules", () => {
  it("merges subscribed KB rules, sorted by id", () => {
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.b");
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.a");
    expect(resolveProjectRules(cfg(), "flooros").rules.map((r) => r.id)).toEqual(["coding.a", "coding.b"]);
  });

  it("project layer replaces a KB rule with the same id (whole-file)", () => {
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.a", "KB text.");
    put(projectRulesDir(path.join(root, "spoke")), "coding.a", "Project text.");
    const r = resolveProjectRules(cfg(), "flooros").rules;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ statement: "Project text.", layer: "project:flooros" });
  });

  it("rulesDisabled removes a KB rule; unknown ids warn (Review Focus 3)", () => {
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.a");
    const res = resolveProjectRules(cfg({ rulesDisabled: ["coding.a", "coding.ghost"] }), "flooros");
    expect(res.rules).toEqual([]);
    expect(res.warnings).toEqual(["rulesDisabled: unknown rule id 'coding.ghost'"]);
  });

  it("missing KB warns, does not throw (Review Focus 3)", () => {
    const res = resolveProjectRules(cfg({ knowledge: ["nope"] }), "flooros");
    expect(res.rules).toEqual([]);
    expect(res.warnings[0]).toContain("knowledge base 'nope' not found");
  });

  it("same id in two subscribed KBs: first subscription wins, warns", () => {
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.a", "Saitex.");
    put(kbRulesDir(path.join(root, "hub"), "other"), "coding.a", "Other.");
    const res = resolveProjectRules(cfg({ knowledge: ["saitex", "other"] }), "flooros");
    expect(res.rules[0].statement).toBe("Saitex.");
    expect(res.warnings[0]).toContain("coding.a");
  });

  it("throws on unknown project", () => {
    expect(() => resolveProjectRules(cfg(), "ghost")).toThrow(/Unknown project 'ghost'/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/knowledge-layers.test.ts`
Expected: FAIL. `resolveProjectRules` is not exported.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/knowledge/layers.ts
import fs from "node:fs";
import { resolveHome, subscribedKbs, type Rule, type SquadrantConfig } from "@squadrant/shared";
import { kbDir, kbRulesDir, projectRulesDir } from "./paths.js";
import { loadRulesDir, type RuleLoadError, type RuleLoadResult } from "./store.js";

export interface ResolvedRules { rules: Rule[]; errors: RuleLoadError[]; warnings: string[] }

export function loadKbRules(cfg: SquadrantConfig, kb: string, opts: { includeProposed?: boolean } = {}): RuleLoadResult {
  return loadRulesDir(kbRulesDir(resolveHome(cfg.hubVault), kb), `kb:${kb}`, opts);
}

export function resolveProjectRules(
  cfg: SquadrantConfig,
  project: string,
  opts: { includeProposed?: boolean } = {},
): ResolvedRules {
  const pc = cfg.projects[project];
  if (!pc) throw new Error(`Unknown project '${project}'`);
  const byId = new Map<string, Rule>();
  const errors: RuleLoadError[] = [];
  const warnings: string[] = [];

  for (const kb of subscribedKbs(cfg, project)) {
    if (!fs.existsSync(kbDir(resolveHome(cfg.hubVault), kb))) {
      warnings.push(`knowledge base '${kb}' not found (run: squadrant knowledge init ${kb})`);
      continue;
    }
    const res = loadKbRules(cfg, kb, opts);
    errors.push(...res.errors);
    for (const r of res.rules) {
      const prior = byId.get(r.id);
      if (prior) { warnings.push(`rule '${r.id}' in kb:${kb} shadowed by ${prior.layer}`); continue; }
      byId.set(r.id, r);
    }
  }

  const proj = loadRulesDir(projectRulesDir(resolveHome(pc.spokeVault)), `project:${project}`, opts);
  errors.push(...proj.errors);
  for (const r of proj.rules) byId.set(r.id, r);

  for (const id of pc.rulesDisabled ?? []) {
    if (!byId.delete(id)) warnings.push(`rulesDisabled: unknown rule id '${id}'`);
  }

  const rules = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { rules, errors, warnings };
}
```

Add `export * from "./layers.js";` to `packages/core/src/knowledge/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/knowledge-layers.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/knowledge packages/core/src/__tests__/knowledge-layers.test.ts
git commit -m "feat(core): rules KB layer resolution — subscriptions, project override, disable (#896)"
```

---

### Task 4: Index compile and text search

**Files:**
- Create: `packages/core/src/knowledge/index-file.ts`
- Create: `packages/core/src/knowledge/search.ts`
- Modify: `packages/core/src/knowledge/index.ts` (export both)
- Test: `packages/core/src/__tests__/knowledge-index-search.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleStatus` (Task 1); `kbDir` (Task 2)
- Produces:
  - `interface RuleIndexEntry { id; domain; modality; status; statement; triggers?; anchors?; file }`
  - `interface RuleIndex { kb: string; compiledAt: string; rules: RuleIndexEntry[] }`
  - `compileIndex(kb: string, rules: Rule[], now?: Date): RuleIndex`
  - `writeIndex(hubVault: string, kb: string, index: RuleIndex): string`
  - `readIndex(hubVault: string, kb: string): { index: RuleIndex | null; problem?: string }`
  - `interface SearchHit { rule: Rule; score: number }`
  - `searchRules(rules: Rule[], query: string, opts?: { statuses?: RuleStatus[] }): SearchHit[]`
  - `DEFAULT_SEARCH_STATUSES: RuleStatus[] = ["active", "stale"]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/knowledge-index-search.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Rule } from "@squadrant/shared";
import { compileIndex, writeIndex, readIndex, searchRules, kbDir } from "../knowledge/index.js";

const mk = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, domain: "business", modality: "must", status: "active",
  sources: [{ ref: "r", sha: "s", quote: "q" }],
  statement: "VND amounts are rounded half-up.", body: "", file: `/x/${id}.md`, layer: "kb:saitex",
  ...over,
});

let hub: string;
beforeEach(() => { hub = fs.mkdtempSync(path.join(os.tmpdir(), "kb-idx-")); });
afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

describe("index", () => {
  it("compiles, writes, reads back", () => {
    const idx = compileIndex("saitex", [mk("biz.a")], new Date("2026-10-08T00:00:00Z"));
    expect(idx).toMatchObject({ kb: "saitex", compiledAt: "2026-10-08T00:00:00.000Z" });
    expect(idx.rules[0]).toMatchObject({ id: "biz.a", statement: "VND amounts are rounded half-up." });
    fs.mkdirSync(kbDir(hub, "saitex"), { recursive: true });
    const file = writeIndex(hub, "saitex", idx);
    expect(file).toBe(path.join(kbDir(hub, "saitex"), "index.json"));
    expect(readIndex(hub, "saitex")).toEqual({ index: idx });
  });
  it("reports missing and corrupt index", () => {
    expect(readIndex(hub, "saitex").problem).toContain("missing");
    fs.mkdirSync(kbDir(hub, "saitex"), { recursive: true });
    fs.writeFileSync(path.join(kbDir(hub, "saitex"), "index.json"), "{not json");
    expect(readIndex(hub, "saitex").problem).toContain("corrupt");
  });
});

describe("searchRules", () => {
  const rules = [
    mk("biz.invoice.vnd-rounding", { triggers: { keywords: ["invoice", "vnd"], when: "Computing monetary amounts" } }),
    mk("coding.api.result-type", { domain: "coding", statement: "Use the Result type for errors.", triggers: { keywords: ["error"] } }),
    mk("biz.old", { status: "retired", triggers: { keywords: ["invoice"] } }),
  ];
  it("ranks keyword hits above statement hits, excludes retired by default", () => {
    const hits = searchRules(rules, "invoice rounding");
    expect(hits.map((h) => h.rule.id)).toEqual(["biz.invoice.vnd-rounding"]);
  });
  it("matches the when sentence", () => {
    expect(searchRules(rules, "monetary")[0].rule.id).toBe("biz.invoice.vnd-rounding");
  });
  it("includes other statuses when asked", () => {
    const ids = searchRules(rules, "invoice", { statuses: ["active", "stale", "proposed", "retired"] }).map((h) => h.rule.id);
    expect(ids).toContain("biz.old");
  });
  it("empty query returns nothing", () => {
    expect(searchRules(rules, "   ")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/knowledge-index-search.test.ts`
Expected: FAIL. `compileIndex` is not exported.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/knowledge/index-file.ts
import fs from "node:fs";
import path from "node:path";
import type { Rule, RuleAnchors, RuleModality, RuleStatus, RuleTriggers } from "@squadrant/shared";
import { kbDir } from "./paths.js";

export interface RuleIndexEntry {
  id: string; domain: string; modality: RuleModality; status: RuleStatus;
  statement: string; triggers?: RuleTriggers; anchors?: RuleAnchors; file: string;
}
export interface RuleIndex { kb: string; compiledAt: string; rules: RuleIndexEntry[] }

export function compileIndex(kb: string, rules: Rule[], now: Date = new Date()): RuleIndex {
  return {
    kb,
    compiledAt: now.toISOString(),
    rules: rules.map(({ id, domain, modality, status, statement, triggers, anchors, file }) =>
      ({ id, domain, modality, status, statement, triggers, anchors, file })),
  };
}

export function writeIndex(hubVault: string, kb: string, index: RuleIndex): string {
  const file = path.join(kbDir(hubVault, kb), "index.json");
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

export function readIndex(hubVault: string, kb: string): { index: RuleIndex | null; problem?: string } {
  const file = path.join(kbDir(hubVault, kb), "index.json");
  if (!fs.existsSync(file)) return { index: null, problem: `index.json missing for kb '${kb}'` };
  try {
    const index = JSON.parse(fs.readFileSync(file, "utf8")) as RuleIndex;
    if (!Array.isArray(index.rules)) return { index: null, problem: `index.json corrupt for kb '${kb}' (no rules array)` };
    return { index };
  } catch {
    return { index: null, problem: `index.json corrupt for kb '${kb}' (invalid JSON)` };
  }
}
```

```ts
// packages/core/src/knowledge/search.ts
import type { Rule, RuleStatus } from "@squadrant/shared";

export interface SearchHit { rule: Rule; score: number }
export const DEFAULT_SEARCH_STATUSES: RuleStatus[] = ["active", "stale"];

const lower = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());

export function searchRules(rules: Rule[], query: string, opts: { statuses?: RuleStatus[] } = {}): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const statuses = opts.statuses ?? DEFAULT_SEARCH_STATUSES;
  const hits: SearchHit[] = [];
  for (const rule of rules) {
    if (!statuses.includes(rule.status)) continue;
    const keywords = lower(rule.triggers?.keywords);
    const expanded = lower(rule.triggers?.expanded);
    const when = (rule.triggers?.when ?? "").toLowerCase();
    const statement = rule.statement.toLowerCase();
    const id = rule.id.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (id.includes(t)) score += 3;
      if (keywords.includes(t)) score += 3;
      if (expanded.includes(t)) score += 2;
      if (when.includes(t)) score += 2;
      if (statement.includes(t)) score += 1;
    }
    if (score > 0) hits.push({ rule, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));
}
```

Add `export * from "./index-file.js";` and `export * from "./search.js";` to `packages/core/src/knowledge/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/knowledge-index-search.test.ts && pnpm lint`
Expected: PASS. In the first search test, "rounding" scores against the id and statement and "invoice" against the keyword, and the retired rule is excluded.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/knowledge packages/core/src/__tests__/knowledge-index-search.test.ts
git commit -m "feat(core): rules KB index compile and text search (#896)"
```

---

### Task 5: `sources.yaml` loader

**Files:**
- Create: `packages/core/src/knowledge/sources.ts`
- Modify: `packages/core/package.json` (add `"js-yaml": "^4.1.0"` to dependencies); root `package.json` devDependencies (add `"@types/js-yaml": "^4.0.9"`)
- Modify: `packages/core/src/knowledge/index.ts`
- Test: `packages/core/src/__tests__/knowledge-sources.test.ts`

**Interfaces:**
- Consumes: `validateSourceEntry`, `KnowledgeSourceEntry` (Task 1); `kbDir` (Task 2)
- Produces:
  - `SOURCES_TEMPLATE: string`
  - `loadSources(hubVault: string, kb: string): { sources: KnowledgeSourceEntry[]; errors: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/knowledge-sources.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSources, kbDir, SOURCES_TEMPLATE } from "../knowledge/index.js";

let hub: string;
const write = (text: string) => {
  fs.mkdirSync(kbDir(hub, "saitex"), { recursive: true });
  fs.writeFileSync(path.join(kbDir(hub, "saitex"), "sources.yaml"), text);
};
beforeEach(() => { hub = fs.mkdtempSync(path.join(os.tmpdir(), "kb-src-")); });
afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

describe("loadSources", () => {
  it("missing file → empty", () => {
    expect(loadSources(hub, "saitex")).toEqual({ sources: [], errors: [] });
  });
  it("template parses to an empty list", () => {
    write(SOURCES_TEMPLATE);
    expect(loadSources(hub, "saitex")).toEqual({ sources: [], errors: [] });
  });
  it("loads valid entries and reports invalid ones by index", () => {
    write(`- path: raw/finance/**\n  priority: company\n- path: raw/x.pdf\n  priority: boss\n- path: raw/c/**\n  priority: company\n  sensitivity: local-only\n`);
    const r = loadSources(hub, "saitex");
    expect(r.sources.map((s) => s.path)).toEqual(["raw/finance/**", "raw/c/**"]);
    expect(r.errors).toEqual([expect.stringMatching(/^entry 1: priority/)]);
  });
  it("non-list YAML is an error, not a throw", () => {
    write("path: oops\n");
    expect(loadSources(hub, "saitex").errors[0]).toContain("must be a YAML list");
  });
  it("invalid YAML is an error, not a throw", () => {
    write("- path: [unclosed\n");
    expect(loadSources(hub, "saitex").errors[0]).toContain("YAML parse error");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/__tests__/knowledge-sources.test.ts`
Expected: FAIL. `loadSources` is not exported.

- [ ] **Step 3: Implement**

Run: `pnpm --filter @squadrant/core add js-yaml@^4.1.0 && pnpm add -D -w @types/js-yaml@^4.0.9`

```ts
// packages/core/src/knowledge/sources.ts
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { validateSourceEntry, type KnowledgeSourceEntry } from "@squadrant/shared";
import { kbDir } from "./paths.js";

export const SOURCES_TEMPLATE = `# Trusted sources for this knowledge base (spec §3). Only these can produce rules.
# priority: company > project > agent (decides conflicts).
# sensitivity: local-only  → never sent to a hosted model (D12).
#
# - path: raw/finance/**
#   priority: company
# - path: ~/work/flooros/docs/handbook/**
#   priority: project
#   domain: coding
[]
`;

export function loadSources(hubVault: string, kb: string): { sources: KnowledgeSourceEntry[]; errors: string[] } {
  const file = path.join(kbDir(hubVault, kb), "sources.yaml");
  if (!fs.existsSync(file)) return { sources: [], errors: [] };
  let data: unknown;
  try {
    data = yaml.load(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { sources: [], errors: [`YAML parse error: ${(e as Error).message.split("\n")[0]}`] };
  }
  if (data == null) return { sources: [], errors: [] };
  if (!Array.isArray(data)) return { sources: [], errors: ["sources.yaml must be a YAML list of entries"] };
  const sources: KnowledgeSourceEntry[] = [];
  const errors: string[] = [];
  data.forEach((entry, i) => {
    const problems = validateSourceEntry(entry);
    if (problems.length) errors.push(...problems.map((p) => `entry ${i}: ${p}`));
    else sources.push(entry as KnowledgeSourceEntry);
  });
  return { sources, errors };
}
```

Add `export * from "./sources.js";` to `packages/core/src/knowledge/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/knowledge-sources.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml packages/core/package.json packages/core/src/knowledge packages/core/src/__tests__/knowledge-sources.test.ts
git commit -m "feat(core): rules KB sources.yaml loader (#896)"
```

---

### Task 6: `squadrant knowledge init | subscribe | sources`

**Files:**
- Create: `packages/cli/src/commands/knowledge.ts`
- Modify: `packages/cli/src/index.ts` (import `knowledgeCommand`, then `program.addCommand(knowledgeCommand);` next to the other `addCommand` lines)
- Test: `packages/cli/src/commands/__tests__/knowledge.test.ts`

**Interfaces:**
- Consumes:
  - `kbDir`, `kbRulesDir`, `PROPOSED_DIR`, `SOURCES_TEMPLATE`, `loadSources` (core)
  - `KB_NAME_RE`, `loadConfig`, `saveConfig`, `resolveHome`, `DEFAULT_CONFIG_PATH` (shared)
- Produces:
  - `KNOWLEDGE_PRIVACY_NOTICE: string`
  - `runKnowledgeInit(kb: string, configPath?: string): { dir: string; created: string[] }`
  - `runKnowledgeSubscribe(kb: string, project: string, configPath?: string): string[]`, which returns the project's new knowledge list
  - `runKnowledgeSources(kb: string, configPath?: string): { sources: KnowledgeSourceEntry[]; errors: string[] }`
  - `knowledgeCommand: Command`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/commands/__tests__/knowledge.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, saveConfig, loadConfig } from "@squadrant/shared";
import { runKnowledgeInit, runKnowledgeSubscribe, runKnowledgeSources } from "../knowledge.js";

let dir: string;
let cfgPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-knowledge-"));
  cfgPath = path.join(dir, "config.json");
  const c = getDefaultConfig();
  c.hubVault = path.join(dir, "hub");
  c.projects = { flooros: { path: "/f", captainName: "f", spokeVault: "/v", host: "local" } };
  saveConfig(c, cfgPath);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("knowledge init", () => {
  it("creates the layout, sources.yaml template, and a config entry", () => {
    const r = runKnowledgeInit("saitex", cfgPath);
    for (const rel of ["raw", "rules", "rules/_proposed", "sources.yaml"]) {
      expect(fs.existsSync(path.join(r.dir, rel))).toBe(true);
    }
    expect(loadConfig(cfgPath).knowledge).toEqual({ saitex: {} });
  });
  it("is idempotent and never overwrites sources.yaml", () => {
    const r = runKnowledgeInit("saitex", cfgPath);
    fs.writeFileSync(path.join(r.dir, "sources.yaml"), "- { path: raw/a.md, priority: company }\n");
    const again = runKnowledgeInit("saitex", cfgPath);
    expect(again.created).toEqual([]);
    expect(fs.readFileSync(path.join(r.dir, "sources.yaml"), "utf8")).toContain("raw/a.md");
  });
  it("rejects an invalid kb name", () => {
    expect(() => runKnowledgeInit("Bad Name", cfgPath)).toThrow(/Invalid knowledge base name/);
  });
});

describe("knowledge subscribe", () => {
  it("adds the kb once to the project", () => {
    runKnowledgeInit("saitex", cfgPath);
    expect(runKnowledgeSubscribe("saitex", "flooros", cfgPath)).toEqual(["saitex"]);
    expect(runKnowledgeSubscribe("saitex", "flooros", cfgPath)).toEqual(["saitex"]);
    expect(loadConfig(cfgPath).projects.flooros.knowledge).toEqual(["saitex"]);
  });
  it("errors on unknown project or uninitialised kb", () => {
    expect(() => runKnowledgeSubscribe("saitex", "ghost", cfgPath)).toThrow(/Unknown project 'ghost'/);
    expect(() => runKnowledgeSubscribe("nokb", "flooros", cfgPath)).toThrow(/knowledge init nokb/);
  });
});

describe("knowledge sources", () => {
  it("returns parsed sources", () => {
    const r = runKnowledgeInit("saitex", cfgPath);
    fs.writeFileSync(path.join(r.dir, "sources.yaml"), "- { path: raw/a.md, priority: company }\n");
    expect(runKnowledgeSources("saitex", cfgPath).sources).toEqual([{ path: "raw/a.md", priority: "company" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/cli/src/commands/__tests__/knowledge.test.ts`
Expected: FAIL with "Cannot find module '../knowledge.js'".

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/commands/knowledge.ts
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig, saveConfig, resolveHome, KB_NAME_RE, DEFAULT_CONFIG_PATH,
  type KnowledgeSourceEntry,
} from "@squadrant/shared";
import { kbDir, kbRulesDir, PROPOSED_DIR, SOURCES_TEMPLATE, loadSources } from "@squadrant/core";

export const KNOWLEDGE_PRIVACY_NOTICE =
  "Sources are sent to the extraction crew's model; mark `sensitivity: local-only` to keep a source on local models only.";

export function runKnowledgeInit(kb: string, configPath = DEFAULT_CONFIG_PATH): { dir: string; created: string[] } {
  if (!KB_NAME_RE.test(kb)) throw new Error(`Invalid knowledge base name '${kb}' (use lowercase letters, digits, '-')`);
  const cfg = loadConfig(configPath);
  const hub = resolveHome(cfg.hubVault);
  const dir = kbDir(hub, kb);
  const created: string[] = [];
  for (const d of [path.join(dir, "raw"), kbRulesDir(hub, kb), path.join(kbRulesDir(hub, kb), PROPOSED_DIR)]) {
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); created.push(path.relative(dir, d)); }
  }
  const sourcesFile = path.join(dir, "sources.yaml");
  if (!fs.existsSync(sourcesFile)) { fs.writeFileSync(sourcesFile, SOURCES_TEMPLATE); created.push("sources.yaml"); }
  if (!cfg.knowledge?.[kb]) {
    cfg.knowledge = { ...(cfg.knowledge ?? {}), [kb]: {} };
    saveConfig(cfg, configPath);
  }
  return { dir, created };
}

export function runKnowledgeSubscribe(kb: string, project: string, configPath = DEFAULT_CONFIG_PATH): string[] {
  const cfg = loadConfig(configPath);
  const pc = cfg.projects[project];
  if (!pc) throw new Error(`Unknown project '${project}'`);
  if (!fs.existsSync(kbDir(resolveHome(cfg.hubVault), kb))) {
    throw new Error(`Knowledge base '${kb}' does not exist. Run: squadrant knowledge init ${kb}`);
  }
  const list = pc.knowledge ?? [];
  if (!list.includes(kb)) {
    pc.knowledge = [...list, kb];
    saveConfig(cfg, configPath);
  }
  return pc.knowledge ?? list;
}

export function runKnowledgeSources(kb: string, configPath = DEFAULT_CONFIG_PATH): { sources: KnowledgeSourceEntry[]; errors: string[] } {
  const cfg = loadConfig(configPath);
  return loadSources(resolveHome(cfg.hubVault), kb);
}

export const knowledgeCommand = new Command("knowledge").description("Manage rules knowledge bases (#893)");

knowledgeCommand
  .command("init <kb>")
  .description("Create a knowledge base under <hubVault>/knowledge/<kb>/")
  .action((kb: string) => {
    const { dir, created } = runKnowledgeInit(kb);
    console.log(created.length ? chalk.green(`Initialised ${dir} (${created.join(", ")})`) : `Already initialised: ${dir}`);
    console.log(chalk.dim(KNOWLEDGE_PRIVACY_NOTICE));
  });

knowledgeCommand
  .command("subscribe <kb>")
  .description("Subscribe a project to a knowledge base")
  .requiredOption("--project <name>", "project to subscribe")
  .action((kb: string, opts: { project: string }) => {
    const list = runKnowledgeSubscribe(kb, opts.project);
    console.log(`${opts.project} knowledge: ${list.join(", ")}`);
  });

knowledgeCommand
  .command("sources <kb>")
  .description("List the trusted sources of a knowledge base")
  .action((kb: string) => {
    const { sources, errors } = runKnowledgeSources(kb);
    if (!sources.length && !errors.length) console.log("(no sources — edit sources.yaml)");
    for (const s of sources) {
      console.log(`  ${s.priority.padEnd(8)} ${s.path}${s.domain ? `  [${s.domain}]` : ""}${s.sensitivity ? chalk.yellow("  local-only") : ""}`);
    }
    for (const e of errors) console.log(chalk.red(`  ✘ ${e}`));
    if (errors.length) process.exitCode = 1;
  });
```

In `packages/cli/src/index.ts`, add `import { knowledgeCommand } from "./commands/knowledge.js";` next to the other command imports, and `program.addCommand(knowledgeCommand);` next to the other `addCommand` calls.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/__tests__/knowledge.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/knowledge.ts packages/cli/src/index.ts packages/cli/src/commands/__tests__/knowledge.test.ts
git commit -m "feat(cli): squadrant knowledge init|subscribe|sources (#896)"
```

---

### Task 7: `squadrant rules show | search`

**Files:**
- Create: `packages/cli/src/commands/rules.ts`
- Modify: `packages/cli/src/index.ts` (import `rulesCommand`, then `program.addCommand(rulesCommand);`)
- Test: `packages/cli/src/commands/__tests__/rules.test.ts`

**Interfaces:**
- Consumes: `resolveProjectRules`, `searchRules`, `DEFAULT_SEARCH_STATUSES`, `kbRulesDir`, `projectRulesDir` (core); `detectCurrentProject` (`packages/cli/src/commands/work.ts`); `RULE_STATUSES`, `loadConfig` (shared)
- Produces:
  - `resolveRulesProject(cfg: SquadrantConfig, opts: { project?: string; cwd?: string; env?: NodeJS.ProcessEnv }): string`
  - `formatRule(rule: Rule): string`
  - `runRulesShow(id: string, opts: { project?: string; all?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }, configPath?: string): Rule`
  - `runRulesSearch(query: string, opts: { project?: string; all?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }, configPath?: string): SearchHit[]`
  - `rulesCommand: Command`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/commands/__tests__/rules.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, saveConfig, loadConfig } from "@squadrant/shared";
import { kbRulesDir } from "@squadrant/core";
import { runRulesSearch, runRulesShow, resolveRulesProject, formatRule } from "../rules.js";

let dir: string;
let cfgPath: string;
const rule = (id: string, status = "active", extra = "") =>
  `---\nid: ${id}\ndomain: business\nmodality: must\nstatus: ${status}\n${extra}sources:\n  - { ref: raw/Policy-v3.pdf, sha: s, loc: "p.12", quote: q }\n---\nVND amounts are rounded half-up.\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-rules-"));
  cfgPath = path.join(dir, "config.json");
  const c = getDefaultConfig();
  c.hubVault = path.join(dir, "hub");
  c.projects = { flooros: { path: path.join(dir, "flooros"), captainName: "f", spokeVault: path.join(dir, "spoke"), host: "local", knowledge: ["saitex"] } };
  saveConfig(c, cfgPath);
  const rd = path.join(kbRulesDir(c.hubVault, "saitex"), "business");
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, "biz.invoice.vnd-rounding.md"), rule("biz.invoice.vnd-rounding", "active", "triggers:\n  keywords: [invoice]\n"));
  fs.writeFileSync(path.join(rd, "biz.old.md"), rule("biz.old", "retired", "triggers:\n  keywords: [invoice]\n"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("resolveRulesProject", () => {
  it("prefers --project, then SQUADRANT_CREW_PROJECT, then cwd", () => {
    const c = loadConfig(cfgPath);
    expect(resolveRulesProject(c, { project: "flooros", env: {} })).toBe("flooros");
    expect(resolveRulesProject(c, { env: { SQUADRANT_CREW_PROJECT: "flooros" }, cwd: "/" })).toBe("flooros");
    expect(resolveRulesProject(c, { env: {}, cwd: path.join(dir, "flooros", "src") })).toBe("flooros");
  });
  it("fails clearly outside any project (Review Focus 5)", () => {
    expect(() => resolveRulesProject(loadConfig(cfgPath), { env: {}, cwd: "/" })).toThrow(/--project/);
  });
});

describe("rules search/show", () => {
  it("search returns active rules by default, all with --all", () => {
    expect(runRulesSearch("invoice", { project: "flooros" }, cfgPath).map((h) => h.rule.id)).toEqual(["biz.invoice.vnd-rounding"]);
    expect(runRulesSearch("invoice", { project: "flooros", all: true }, cfgPath).map((h) => h.rule.id).sort())
      .toEqual(["biz.invoice.vnd-rounding", "biz.old"]);
  });
  it("show finds by id and formats with modality and source", () => {
    const r = runRulesShow("biz.invoice.vnd-rounding", { project: "flooros" }, cfgPath);
    const text = formatRule(r);
    expect(text).toContain("MUST VND amounts are rounded half-up.");
    expect(text).toContain("raw/Policy-v3.pdf p.12");
  });
  it("show errors on an unknown id", () => {
    expect(() => runRulesShow("nope", { project: "flooros" }, cfgPath)).toThrow(/No rule 'nope'/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/cli/src/commands/__tests__/rules.test.ts`
Expected: FAIL with "Cannot find module '../rules.js'".

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/commands/rules.ts
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, DEFAULT_CONFIG_PATH, RULE_STATUSES, type Rule, type SquadrantConfig } from "@squadrant/shared";
import { resolveProjectRules, searchRules, DEFAULT_SEARCH_STATUSES, type SearchHit } from "@squadrant/core";
import { detectCurrentProject } from "./work.js";

interface RulesOpts { project?: string; all?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }

export function resolveRulesProject(cfg: SquadrantConfig, opts: RulesOpts): string {
  const env = opts.env ?? process.env;
  const name = opts.project ?? env.SQUADRANT_CREW_PROJECT ?? detectCurrentProject(cfg, opts.cwd ?? process.cwd());
  if (!name) throw new Error("Not inside a registered project. Pass --project <name>.");
  if (!cfg.projects[name]) throw new Error(`Unknown project '${name}'`);
  return name;
}

export function formatRule(rule: Rule): string {
  const src = rule.sources.map((s) => `${s.ref}${s.loc ? ` ${s.loc}` : ""}`).join("; ");
  return [
    `${rule.modality.toUpperCase()} ${rule.statement}`,
    `  ${rule.id} · ${rule.domain} · ${rule.status} · ${rule.layer}`,
    `  source: ${src}`,
  ].join("\n");
}

function loadFor(opts: RulesOpts, configPath: string): { rules: Rule[]; warnings: string[] } {
  const cfg = loadConfig(configPath);
  const project = resolveRulesProject(cfg, opts);
  const res = resolveProjectRules(cfg, project, { includeProposed: opts.all });
  return { rules: res.rules, warnings: [...res.warnings, ...res.errors.map((e) => `${e.file}: ${e.problems.join("; ")}`)] };
}

export function runRulesSearch(query: string, opts: RulesOpts, configPath = DEFAULT_CONFIG_PATH): SearchHit[] {
  const { rules } = loadFor(opts, configPath);
  return searchRules(rules, query, { statuses: opts.all ? [...RULE_STATUSES] : DEFAULT_SEARCH_STATUSES });
}

export function runRulesShow(id: string, opts: RulesOpts, configPath = DEFAULT_CONFIG_PATH): Rule {
  const { rules } = loadFor({ ...opts, all: true }, configPath);
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error(`No rule '${id}' for this project`);
  return rule;
}

export const rulesCommand = new Command("rules").description("Look up rules from subscribed knowledge bases (#893)");

rulesCommand
  .command("search <query...>")
  .description("Search rules by keyword")
  .option("--project <name>", "project (default: from cwd or SQUADRANT_CREW_PROJECT)")
  .option("--all", "include proposed and retired rules")
  .action((query: string[], opts: RulesOpts) => {
    const hits = runRulesSearch(query.join(" "), opts);
    if (!hits.length) { console.log("(no matching rules)"); return; }
    for (const h of hits) console.log(formatRule(h.rule) + "\n");
  });

rulesCommand
  .command("show <ids...>")
  .description("Show one or more rules in full")
  .option("--project <name>", "project (default: from cwd or SQUADRANT_CREW_PROJECT)")
  .action((ids: string[], opts: RulesOpts) => {
    for (const id of ids) {
      const r = runRulesShow(id, opts);
      console.log(formatRule(r));
      console.log(chalk.dim(r.body) + "\n");
    }
  });
```

Register it in `packages/cli/src/index.ts`, next to `knowledgeCommand`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/__tests__/rules.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/rules.ts packages/cli/src/index.ts packages/cli/src/commands/__tests__/rules.test.ts
git commit -m "feat(cli): squadrant rules show|search (#896)"
```

---

### Task 8: `doctor` knowledge checks and index compile on `knowledge reindex`

`index.json` must be producible in v1 so that `doctor` can validate it. This task adds `squadrant knowledge reindex <kb>`, which #897 will later call automatically after extraction, and the doctor section.

**Files:**
- Modify: `packages/cli/src/commands/knowledge.ts` (add `runKnowledgeReindex` and a `reindex` subcommand)
- Modify: `packages/cli/src/commands/doctor.ts` (add `knowledgeDoctorLines` and call it inside the action, after the projection block)
- Test: `packages/cli/src/commands/__tests__/knowledge.test.ts` (append), `packages/cli/src/commands/__tests__/doctor-knowledge.test.ts`

**Interfaces:**
- Consumes: `loadKbRules`, `compileIndex`, `writeIndex`, `readIndex` (core)
- Produces:
  - `runKnowledgeReindex(kb: string, configPath?: string): { file: string; count: number; errors: number }`
  - `knowledgeDoctorLines(cfg: SquadrantConfig, hasCommand: (cmd: string) => boolean): { label: string; ok: boolean; hint?: string; warnOnly?: boolean }[]`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/commands/__tests__/knowledge.test.ts`:

```ts
import { runKnowledgeReindex } from "../knowledge.js";
import { kbRulesDir, readIndex } from "@squadrant/core";

describe("knowledge reindex", () => {
  it("compiles index.json from the KB's rules", () => {
    runKnowledgeInit("saitex", cfgPath);
    const hub = loadConfig(cfgPath).hubVault;
    fs.mkdirSync(path.join(kbRulesDir(hub, "saitex"), "coding"), { recursive: true });
    fs.writeFileSync(path.join(kbRulesDir(hub, "saitex"), "coding", "coding.a.md"),
      "---\nid: coding.a\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n---\nUse Result.\n");
    const r = runKnowledgeReindex("saitex", cfgPath);
    expect(r).toMatchObject({ count: 1, errors: 0 });
    expect(readIndex(hub, "saitex").index?.rules[0].id).toBe("coding.a");
  });
});
```

```ts
// packages/cli/src/commands/__tests__/doctor-knowledge.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig } from "@squadrant/shared";
import { kbDir } from "@squadrant/core";
import { knowledgeDoctorLines } from "../doctor.js";

let hub: string;
beforeEach(() => { hub = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kb-")); });
afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

describe("knowledgeDoctorLines", () => {
  it("emits nothing when no KB is configured (no new FAILs, cf. #876)", () => {
    expect(knowledgeDoctorLines(getDefaultConfig(), () => false)).toEqual([]);
  });
  it("flags a missing index and a missing markitdown (warn only)", () => {
    const c = getDefaultConfig();
    c.hubVault = hub;
    c.knowledge = { saitex: {} };
    fs.mkdirSync(kbDir(hub, "saitex"), { recursive: true });
    const lines = knowledgeDoctorLines(c, () => false);
    expect(lines).toEqual([
      expect.objectContaining({ label: "markitdown installed (rules KB conversion)", ok: false, warnOnly: true }),
      expect.objectContaining({ label: "KB 'saitex' index.json valid", ok: false }),
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/__tests__/knowledge.test.ts packages/cli/src/commands/__tests__/doctor-knowledge.test.ts`
Expected: FAIL. Neither `runKnowledgeReindex` nor `knowledgeDoctorLines` is exported.

- [ ] **Step 3: Implement**

Append to `packages/cli/src/commands/knowledge.ts`, and add `loadKbRules, compileIndex, writeIndex` to its `@squadrant/core` import:

```ts
export function runKnowledgeReindex(kb: string, configPath = DEFAULT_CONFIG_PATH): { file: string; count: number; errors: number } {
  const cfg = loadConfig(configPath);
  const hub = resolveHome(cfg.hubVault);
  if (!fs.existsSync(kbDir(hub, kb))) throw new Error(`Knowledge base '${kb}' does not exist. Run: squadrant knowledge init ${kb}`);
  const { rules, errors } = loadKbRules(cfg, kb);
  const file = writeIndex(hub, kb, compileIndex(kb, rules));
  return { file, count: rules.length, errors: errors.length };
}

knowledgeCommand
  .command("reindex <kb>")
  .description("Recompile index.json from the KB's rule files")
  .action((kb: string) => {
    const r = runKnowledgeReindex(kb);
    console.log(`${r.file}: ${r.count} rules${r.errors ? chalk.red(`, ${r.errors} invalid files skipped`) : ""}`);
  });
```

In `packages/cli/src/commands/doctor.ts`:
- Add `import { readIndex } from "@squadrant/core";`.
- Make sure `resolveHome` and `type SquadrantConfig` are imported from `@squadrant/shared`.
- Add this exported function above `doctorCommand`:

```ts
/** #896: rules-KB doctor lines. Empty when no KB is configured, so users without a KB see no new FAILs (#876). */
export function knowledgeDoctorLines(
  cfg: SquadrantConfig,
  hasCommand: (cmd: string) => boolean,
): { label: string; ok: boolean; hint?: string; warnOnly?: boolean }[] {
  const kbs = Object.keys(cfg.knowledge ?? {});
  if (!kbs.length) return [];
  const lines: { label: string; ok: boolean; hint?: string; warnOnly?: boolean }[] = [{
    label: "markitdown installed (rules KB conversion)",
    ok: hasCommand("markitdown"),
    hint: "pip install 'markitdown[all]'",
    warnOnly: true,
  }];
  for (const kb of kbs) {
    const { problem } = readIndex(resolveHome(cfg.hubVault), kb);
    lines.push({ label: `KB '${kb}' index.json valid`, ok: !problem, hint: problem ? `${problem} — run: squadrant knowledge reindex ${kb}` : undefined });
  }
  return lines;
}
```

Inside the `doctorCommand` action, right before the `"Squadrant config exists"` check, add:

```ts
    try {
      const cfgForKb = loadConfig();
      for (const l of knowledgeDoctorLines(cfgForKb, commandExists)) {
        if (l.warnOnly && !l.ok) console.log(`  ${chalk.yellow("! WARN")}  ${l.label}${l.hint ? chalk.dim(` → ${l.hint}`) : ""}`);
        else results.push(check(l.label, l.ok, l.hint));
      }
    } catch { /* no config yet — the config check below reports it */ }
```

If `loadConfig` is not already imported in `doctor.ts`, add it to the `@squadrant/shared` import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/__tests__/knowledge.test.ts packages/cli/src/commands/__tests__/doctor-knowledge.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Run the full suite and build**

Run: `pnpm test && pnpm build`
Expected: everything passes except the known relay-proxy baseline (3 failures, per CLAUDE.md), and the build succeeds.

- [ ] **Step 6: Manual smoke test** (on a scratch config)

```bash
export SQUADRANT_CONFIG=$(mktemp -d)/config.json
node dist/index.js init --yes 2>/dev/null || true
node dist/index.js knowledge init demo
node dist/index.js knowledge sources demo     # → "(no sources — edit sources.yaml)"
node dist/index.js knowledge reindex demo     # → "...index.json: 0 rules"
node dist/index.js doctor | grep -i "KB\|markitdown"
```

Expected: the KB lines appear in doctor. A missing markitdown shows as WARN, not FAIL.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/knowledge.ts packages/cli/src/commands/doctor.ts packages/cli/src/commands/__tests__/knowledge.test.ts packages/cli/src/commands/__tests__/doctor-knowledge.test.ts
git commit -m "feat(cli): knowledge reindex + doctor KB checks (#896)"
```

---

## Out of scope for this plan (separate plans, written when each issue starts)

- #897: ingest, conversion, extraction, quote verification, anchors
- #898: reconcile, scheduler, reviewer
- #899: matcher and Claude delivery
- #900: delivery for the other agents
- #901: audit and scoring
- #902: deferred follow-ups
