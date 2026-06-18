# Config Drift Detection & Reconciliation — Implementation Plan

> **✅ Shipped** (PR #230, 2026-06-06). Archived 2026-06-18 — historical; describes the design as built and may predate the monorepo reorg.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every task. Steps use checkbox (`- [ ]`) syntax for tracking. This repo also mandates `plugin/skills/karpathy-principles` (think → simplest thing → surgical → goal-driven) — every changed line must trace to this plan.

**Goal:** When a user updates cockpit to a new version, detect divergence between their `~/.config/cockpit/config.json` and the current default schema, surface it once per version bump as a non-blocking terminal banner, let `cockpit config check --fix` auto-apply the safe changes, and route judgment calls to a `config-doctor` skill.

**Architecture:** A pure, I/O-free drift engine (`config-drift.ts`) diffs the user config against `getDefaultConfig()` over an allowlist of managed schema paths (never user-data paths). A version-stamp module (`config-version.ts`) gates the check so it only fires after a version change. The CLI entrypoint prints a one-line banner; a new `cockpit config check` command reports and `--fix`es the safe tier; the `config-doctor` skill handles advisory/invalid items with agent judgment.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Commander for CLI, Vitest for tests, chalk for output. No new dependencies.

**Approach decision (locked during brainstorming):** Approach A — structural diff against `getDefaultConfig()` as the source of truth, plus a tiny `KNOWN_DEFAULT_HISTORY` constant only for `changed-default` value comparisons. No per-version migration manifest.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/lib/config-drift.ts` | **NEW.** Pure engine: `detectDrift(user, def)` → `DriftItem[]`. No file I/O, no printing. Owns `MANAGED_PATHS`, `KNOWN_DEPRECATED`, `KNOWN_DEFAULT_HISTORY`, `KNOWN_DRIVERS`, classification. |
| `src/lib/__tests__/config-drift.test.ts` | **NEW.** Unit tests for every drift kind via fixtures. |
| `src/lib/config-version.ts` | **NEW.** Stamp lifecycle: `needsCheck`, `readStamp`, `writeStamp` against the `_cockpitVersion` field. |
| `src/lib/__tests__/config-version.test.ts` | **NEW.** Unit tests for stamp logic. |
| `src/config.ts` | **MODIFY.** Add optional `_cockpitVersion?: string` to `CockpitConfig`. |
| `src/commands/config.ts` | **NEW.** `cockpit config check [--fix] [--accept] [--json]`. The detect/report/apply surface. |
| `src/commands/__tests__/config.test.ts` | **NEW.** Tests for `--fix`/`--accept` mutation + `--json` output (using a temp config file). |
| `src/index.ts` | **MODIFY.** Register `configCommand`; add the non-throwing `driftCheckBanner()` block after `ensureRuntimeSynced`. |
| `plugin/skills/config-doctor/SKILL.md` | **NEW.** Portable skill playbook for reconciling advisory/invalid items. |

**Note on package version:** `src/index.ts` already loads `pkg.version` (line ~31: `const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json")...))`). Reuse that — do **not** re-read package.json elsewhere. The banner block must receive `pkg.version` as input.

---

## Type Contracts (defined once, used everywhere)

These live in `src/lib/config-drift.ts` and are imported by the command + tests. Do not redefine them elsewhere.

```typescript
export type DriftKind = "missing" | "deprecated" | "changed-default" | "invalid";
export type DriftSeverity = "info" | "advisory" | "warn";

export interface DriftItem {
  path: string;            // dotted config path, e.g. "defaults.roles.review"
  kind: DriftKind;
  severity: DriftSeverity; // missing/deprecated → info; changed-default → advisory; invalid → warn
  current?: unknown;       // value currently in user config (undefined for `missing`)
  suggested?: unknown;     // value to apply (default value for `missing`; undefined for `deprecated`)
  note?: string;           // human explanation (esp. for invalid/changed-default)
}

// Safe tier — the only kinds `--fix` applies:
export const SAFE_KINDS: DriftKind[] = ["missing", "deprecated"];
```

---

### Task 1: Add `_cockpitVersion` to the config type

**Files:**
- Modify: `src/config.ts` (the `CockpitConfig` interface, ~line 44)

- [ ] **Step 1: Add the optional field**

In `src/config.ts`, inside `export interface CockpitConfig {`, add as the first field:

```typescript
export interface CockpitConfig {
  /** Package version that last reconciled this config. Absent on legacy/fresh configs. */
  _cockpitVersion?: string;
  commandName: string;
  // ... rest unchanged
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run lint`
Expected: PASS (no type errors). `getDefaultConfig()` does not set the field — that is intentional (fresh configs are stamped on first run by the banner).

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add optional _cockpitVersion stamp field"
```

---

### Task 2: Version-stamp module (TDD)

**Files:**
- Create: `src/lib/config-version.ts`
- Test: `src/lib/__tests__/config-version.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/config-version.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readStamp, needsCheck, withStamp } from "../config-version.js";
import type { CockpitConfig } from "../../config.js";

const base = (over: Partial<CockpitConfig> = {}): CockpitConfig =>
  ({ commandName: "x", hubVault: "/h", projects: {}, defaults: {} as any, metrics: { enabled: false, path: "/m" }, ...over });

describe("config-version", () => {
  it("readStamp returns the stamp or null", () => {
    expect(readStamp(base({ _cockpitVersion: "0.5.2" }))).toBe("0.5.2");
    expect(readStamp(base())).toBeNull();
  });

  it("needsCheck is true when stamp is missing (legacy config)", () => {
    expect(needsCheck(base(), "0.5.3")).toBe(true);
  });

  it("needsCheck is true when stamp differs from pkg version", () => {
    expect(needsCheck(base({ _cockpitVersion: "0.5.2" }), "0.5.3")).toBe(true);
  });

  it("needsCheck is false when stamp equals pkg version", () => {
    expect(needsCheck(base({ _cockpitVersion: "0.5.3" }), "0.5.3")).toBe(false);
  });

  it("withStamp returns a new config object with the stamp set (no mutation)", () => {
    const input = base();
    const out = withStamp(input, "0.5.3");
    expect(out._cockpitVersion).toBe("0.5.3");
    expect(input._cockpitVersion).toBeUndefined(); // original untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/config-version.test.ts`
Expected: FAIL — `Cannot find module '../config-version.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/config-version.ts`:

```typescript
import type { CockpitConfig } from "../config.js";

/** The package version that last reconciled this config, or null if never stamped. */
export function readStamp(config: CockpitConfig): string | null {
  return config._cockpitVersion ?? null;
}

/**
 * True when the config should be drift-checked: either it has never been
 * stamped (legacy/fresh) or the stamp differs from the running package
 * version (just updated). False on the common steady-state path.
 */
export function needsCheck(config: CockpitConfig, pkgVersion: string): boolean {
  return readStamp(config) !== pkgVersion;
}

/** Return a copy of `config` with the version stamp set. Does not mutate input. */
export function withStamp(config: CockpitConfig, pkgVersion: string): CockpitConfig {
  return { ...config, _cockpitVersion: pkgVersion };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/config-version.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/config-version.ts src/lib/__tests__/config-version.test.ts
git commit -m "feat(config): version-stamp module for drift-check gating"
```

---

### Task 3: Drift engine — `missing` and `deprecated` (TDD)

**Files:**
- Create: `src/lib/config-drift.ts`
- Test: `src/lib/__tests__/config-drift.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/config-drift.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectDrift } from "../config-drift.js";
import { getDefaultConfig } from "../../config.js";

// Helper: a realistic user config = defaults + real user data.
function userConfig() {
  const c = getDefaultConfig();
  c.projects = { brove: { path: "/p", captainName: "x", spokeVault: "/v", host: "local" } };
  c.hubVault = "/Users/me/cockpit-hub";
  c.commandName = "🏛️ command";
  return c;
}

describe("detectDrift — missing", () => {
  it("flags a managed default key absent from user config", () => {
    const u = userConfig();
    delete (u.defaults.roles as any).review; // a default the user lacks (roles has no review today — use models.review instead)
    delete (u.defaults as any).worktreeDir;  // simulate a missing managed key
    const items = detectDrift(u, getDefaultConfig());
    const paths = items.filter((i) => i.kind === "missing").map((i) => i.path);
    expect(paths).toContain("defaults.worktreeDir");
  });

  it("does NOT flag user-data sections as drift", () => {
    const u = userConfig(); // has projects, hubVault, commandName all different from defaults
    const items = detectDrift(u, getDefaultConfig());
    const paths = items.map((i) => i.path);
    expect(paths.some((p) => p.startsWith("projects"))).toBe(false);
    expect(paths).not.toContain("hubVault");
    expect(paths).not.toContain("commandName");
  });
});

describe("detectDrift — deprecated", () => {
  it("flags a known-deprecated key present in user config", () => {
    const u = userConfig();
    (u.defaults as any).models = { command: "opus", captain: "opus", crew: "opus", exploration: "haiku", review: "opus" };
    (u.defaults as any).roles = getDefaultConfig().defaults.roles; // roles present → models is deprecated
    const items = detectDrift(u, getDefaultConfig());
    const dep = items.find((i) => i.kind === "deprecated" && i.path === "defaults.models");
    expect(dep).toBeDefined();
  });

  it("does NOT flag an unknown key it has no opinion about", () => {
    const u = userConfig();
    (u as any).someFutureKey = { a: 1 };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.path === "someFutureKey")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/config-drift.test.ts`
Expected: FAIL — `Cannot find module '../config-drift.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/config-drift.ts`:

```typescript
import type { CockpitConfig } from "../config.js";

export type DriftKind = "missing" | "deprecated" | "changed-default" | "invalid";
export type DriftSeverity = "info" | "advisory" | "warn";

export interface DriftItem {
  path: string;
  kind: DriftKind;
  severity: DriftSeverity;
  current?: unknown;
  suggested?: unknown;
  note?: string;
}

export const SAFE_KINDS: DriftKind[] = ["missing", "deprecated"];

/**
 * Managed schema paths the drift engine is allowed to compare. Dotted paths;
 * a trailing `.*` means "every key under this object". User-data sections
 * (projects, hubVault, commandName, metrics, _cockpitVersion) are deliberately
 * absent — they are never drift.
 */
const MANAGED_PATHS: string[] = [
  "defaults.maxCrew",
  "defaults.worktreeDir",
  "defaults.teammateMode",
  "defaults.permissions.*",
  "defaults.roles.*",
  "agents.*",
  "workspace",
  "notifier",
  "runtime",
];

/**
 * Keys that are known-removed/renamed and should be pruned when present.
 * Each entry: the dotted path, and an optional predicate gating the flag
 * (e.g. only deprecate `defaults.models` once `defaults.roles` exists).
 */
const KNOWN_DEPRECATED: Array<{ path: string; when?: (u: CockpitConfig) => boolean; note: string }> = [
  {
    path: "defaults.models",
    when: (u) => u.defaults?.roles !== undefined,
    note: "superseded by defaults.roles",
  },
];

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

function hasPath(obj: unknown, dotted: string): boolean {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const k of parts) {
    if (!cur || typeof cur !== "object" || !(k in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[k];
  }
  return true;
}

/** Expand a `foo.bar.*` managed path against the default config into concrete leaf paths. */
function expandManaged(managed: string, def: CockpitConfig): string[] {
  if (!managed.endsWith(".*")) return [managed];
  const parent = managed.slice(0, -2);
  const node = getPath(def, parent);
  if (!node || typeof node !== "object") return [];
  return Object.keys(node as Record<string, unknown>).map((k) => `${parent}.${k}`);
}

/**
 * Compare a user config against the default schema and return every drift item.
 * Pure: no file I/O, no printing, no mutation. `def` is normally getDefaultConfig().
 */
export function detectDrift(user: CockpitConfig, def: CockpitConfig): DriftItem[] {
  const items: DriftItem[] = [];

  // missing: a concrete managed default leaf the user lacks.
  for (const managed of MANAGED_PATHS) {
    for (const leaf of expandManaged(managed, def)) {
      const inDefault = hasPath(def, leaf);
      if (inDefault && !hasPath(user, leaf)) {
        items.push({ path: leaf, kind: "missing", severity: "info", suggested: getPath(def, leaf) });
      }
    }
  }

  // deprecated: a known-removed key still present in user config.
  for (const dep of KNOWN_DEPRECATED) {
    if (hasPath(user, dep.path) && (dep.when ? dep.when(user) : true)) {
      items.push({ path: dep.path, kind: "deprecated", severity: "info", current: getPath(user, dep.path), note: dep.note });
    }
  }

  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/config-drift.test.ts`
Expected: PASS. If the `missing` test for `defaults.roles.review` is noisy (roles has no `review` key in defaults today), rely on the `defaults.worktreeDir` assertion — that is the canonical missing-key check.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config-drift.ts src/lib/__tests__/config-drift.test.ts
git commit -m "feat(config): drift engine — missing + deprecated detection"
```

---

### Task 4: Drift engine — `changed-default` and `invalid` (TDD)

**Files:**
- Modify: `src/lib/config-drift.ts`
- Modify: `src/lib/__tests__/config-drift.test.ts`

- [ ] **Step 1: Write the failing tests (append to the existing test file)**

Append to `src/lib/__tests__/config-drift.test.ts`:

```typescript
describe("detectDrift — changed-default", () => {
  it("flags a field whose value equals the OLD default but the default changed", () => {
    const u = userConfig();
    (u.defaults.roles as any).crew = { agent: "claude", model: "sonnet" }; // old default was sonnet
    const items = detectDrift(u, getDefaultConfig()); // new default is opus
    const cd = items.find((i) => i.kind === "changed-default" && i.path === "defaults.roles.crew.model");
    expect(cd).toBeDefined();
    expect(cd?.severity).toBe("advisory");
    expect(cd?.suggested).toBe("opus");
  });

  it("does NOT flag a field the user customized to a third value", () => {
    const u = userConfig();
    (u.defaults.roles as any).crew = { agent: "claude", model: "haiku" }; // neither old nor new default
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "changed-default" && i.path === "defaults.roles.crew.model")).toBe(false);
  });
});

describe("detectDrift — invalid", () => {
  it("flags an agent whose driver is not a known driver", () => {
    const u = userConfig();
    (u.agents as any).aider = { cli: "aider", driver: "aider" }; // aider driver removed
    const items = detectDrift(u, getDefaultConfig());
    const inv = items.find((i) => i.kind === "invalid" && i.path === "agents.aider.driver");
    expect(inv).toBeDefined();
    expect(inv?.severity).toBe("warn");
  });

  it("flags a role whose agent is not present in agents", () => {
    const u = userConfig();
    (u.defaults.roles as any).captain = { agent: "ghost", model: "opus" };
    const items = detectDrift(u, getDefaultConfig());
    const inv = items.find((i) => i.kind === "invalid" && i.path === "defaults.roles.captain.agent");
    expect(inv).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/config-drift.test.ts`
Expected: FAIL — the new `changed-default`/`invalid` items are not produced yet.

- [ ] **Step 3: Extend the implementation**

In `src/lib/config-drift.ts`, add these constants near the top (after `KNOWN_DEPRECATED`):

```typescript
/**
 * Fields whose recommended default value has meaningfully changed across
 * versions. `oldDefaults` lists prior default values; if the user's value
 * matches one of them (i.e. they inherited an old default rather than
 * customizing) AND it differs from the current default, flag changed-default.
 * This is the ONLY place version history is tracked — kept minimal on purpose.
 */
const KNOWN_DEFAULT_HISTORY: Array<{ path: string; oldDefaults: unknown[] }> = [
  { path: "defaults.roles.crew.model", oldDefaults: ["sonnet"] },
  { path: "defaults.roles.captain.model", oldDefaults: ["sonnet"] },
];

/** Drivers cockpit ships. An agent referencing anything else is invalid. */
const KNOWN_DRIVERS = new Set(["claude", "codex", "gemini", "opencode"]);
```

Then, in `detectDrift`, before `return items;`, add:

```typescript
  // changed-default: user value equals a prior default but the default moved.
  for (const hist of KNOWN_DEFAULT_HISTORY) {
    if (!hasPath(user, hist.path) || !hasPath(def, hist.path)) continue;
    const cur = getPath(user, hist.path);
    const nowDefault = getPath(def, hist.path);
    if (cur !== nowDefault && hist.oldDefaults.includes(cur)) {
      items.push({
        path: hist.path,
        kind: "changed-default",
        severity: "advisory",
        current: cur,
        suggested: nowDefault,
        note: `default changed from ${JSON.stringify(cur)} to ${JSON.stringify(nowDefault)}`,
      });
    }
  }

  // invalid: agent.driver not a known driver; role.agent not present in agents.
  const agents = (user.agents ?? {}) as Record<string, { driver?: string }>;
  for (const [name, entry] of Object.entries(agents)) {
    if (entry?.driver && !KNOWN_DRIVERS.has(entry.driver)) {
      items.push({
        path: `agents.${name}.driver`,
        kind: "invalid",
        severity: "warn",
        current: entry.driver,
        note: `unknown driver '${entry.driver}'; known: ${[...KNOWN_DRIVERS].join(", ")}`,
      });
    }
  }
  const roles = (user.defaults?.roles ?? {}) as Record<string, { agent?: string }>;
  for (const [role, asn] of Object.entries(roles)) {
    if (asn?.agent && !(asn.agent in agents)) {
      items.push({
        path: `defaults.roles.${role}.agent`,
        kind: "invalid",
        severity: "warn",
        current: asn.agent,
        note: `references agent '${asn.agent}' which is not defined in agents`,
      });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/config-drift.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/config-drift.ts src/lib/__tests__/config-drift.test.ts
git commit -m "feat(config): drift engine — changed-default + invalid detection"
```

---

### Task 5: `applyFix` helper — apply only the safe tier (TDD)

**Files:**
- Modify: `src/lib/config-drift.ts`
- Modify: `src/lib/__tests__/config-drift.test.ts`

- [ ] **Step 1: Write the failing test (append)**

Append to `src/lib/__tests__/config-drift.test.ts`:

```typescript
import { applySafeFixes } from "../config-drift.js";

describe("applySafeFixes", () => {
  it("adds missing keys and removes deprecated keys, leaving other drift untouched", () => {
    const u = userConfig();
    delete (u.defaults as any).worktreeDir;                 // missing → should be added
    (u.defaults as any).models = { command: "opus" } as any; // deprecated → should be removed
    (u.defaults.roles as any).crew = { agent: "claude", model: "sonnet" }; // changed-default → untouched

    const def = getDefaultConfig();
    const items = detectDrift(u, def);
    const { config, applied } = applySafeFixes(u, items, def);

    expect((config.defaults as any).worktreeDir).toBe(def.defaults.worktreeDir); // added
    expect((config.defaults as any).models).toBeUndefined();                     // removed
    expect((config.defaults.roles as any).crew.model).toBe("sonnet");            // advisory left alone
    expect(applied).toContain("defaults.worktreeDir");
    expect(applied).toContain("defaults.models");
    expect(u === config).toBe(false); // input not mutated (deep copy returned)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/config-drift.test.ts -t applySafeFixes`
Expected: FAIL — `applySafeFixes` is not exported.

- [ ] **Step 3: Implement `applySafeFixes`**

Add to `src/lib/config-drift.ts`:

```typescript
function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj: Record<string, unknown>, dotted: string): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> | undefined = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]] as Record<string, unknown> | undefined;
    if (!cur || typeof cur !== "object") return;
  }
  delete cur[parts[parts.length - 1]];
}

/**
 * Return a deep copy of `user` with every SAFE_KINDS drift item applied
 * (missing → set to default value; deprecated → deleted). Advisory/invalid
 * items are NOT applied. Does not mutate the input. `def` supplies values
 * for `missing` items (each item already carries `suggested`).
 */
export function applySafeFixes(
  user: CockpitConfig,
  items: DriftItem[],
  _def: CockpitConfig,
): { config: CockpitConfig; applied: string[] } {
  const config = JSON.parse(JSON.stringify(user)) as CockpitConfig;
  const applied: string[] = [];
  const root = config as unknown as Record<string, unknown>;
  for (const item of items) {
    if (!SAFE_KINDS.includes(item.kind)) continue;
    if (item.kind === "missing") setPath(root, item.path, item.suggested);
    else if (item.kind === "deprecated") deletePath(root, item.path);
    applied.push(item.path);
  }
  return { config, applied };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/config-drift.test.ts`
Expected: PASS (all blocks including applySafeFixes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/config-drift.ts src/lib/__tests__/config-drift.test.ts
git commit -m "feat(config): applySafeFixes — apply missing+deprecated only"
```

---

### Task 6: `cockpit config check` command (TDD)

**Files:**
- Create: `src/commands/config.ts`
- Test: `src/commands/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/commands/__tests__/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runConfigCheck } from "../config.js";
import { getDefaultConfig } from "../../config.js";

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-cfg-"));
  cfgPath = path.join(dir, "config.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeUser(over: (c: ReturnType<typeof getDefaultConfig>) => void) {
  const c = getDefaultConfig();
  over(c);
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
}

describe("runConfigCheck", () => {
  it("reports drift without mutating when no flags given", () => {
    writeUser((c) => { delete (c.defaults as any).worktreeDir; });
    const res = runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: false, accept: false });
    expect(res.items.some((i) => i.path === "defaults.worktreeDir" && i.kind === "missing")).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.worktreeDir).toBeUndefined(); // unchanged
  });

  it("--fix applies safe items, writes config, and stamps when clean", () => {
    writeUser((c) => { delete (c.defaults as any).worktreeDir; });
    const res = runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: true, accept: false });
    expect(res.applied).toContain("defaults.worktreeDir");
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk.defaults.worktreeDir).toBe(getDefaultConfig().defaults.worktreeDir);
    expect(onDisk._cockpitVersion).toBe("0.5.3"); // no remaining drift → stamped
  });

  it("--fix does NOT stamp when advisory/invalid drift remains", () => {
    writeUser((c) => { (c.defaults.roles as any).crew = { agent: "claude", model: "sonnet" }; });
    const res = runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: true, accept: false });
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk._cockpitVersion).toBeUndefined(); // advisory remains → not stamped
    expect(res.remaining.some((i) => i.kind === "changed-default")).toBe(true);
  });

  it("--accept stamps without changing config", () => {
    writeUser((c) => { (c.defaults.roles as any).crew = { agent: "claude", model: "sonnet" }; });
    runConfigCheck({ configPath: cfgPath, pkgVersion: "0.5.3", fix: false, accept: true });
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(onDisk._cockpitVersion).toBe("0.5.3");
    expect(onDisk.defaults.roles.crew.model).toBe("sonnet"); // value preserved
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/__tests__/config.test.ts`
Expected: FAIL — `Cannot find module '../config.js'` (the command).

- [ ] **Step 3: Implement the command**

Create `src/commands/config.ts`:

```typescript
import { Command } from "commander";
import fs from "node:fs";
import chalk from "chalk";
import { DEFAULT_CONFIG_PATH, getDefaultConfig, loadConfig, type CockpitConfig } from "../config.js";
import { detectDrift, applySafeFixes, type DriftItem } from "../lib/config-drift.js";
import { withStamp } from "../lib/config-version.js";

export interface ConfigCheckOptions {
  configPath: string;
  pkgVersion: string;
  fix: boolean;
  accept: boolean;
}

export interface ConfigCheckResult {
  items: DriftItem[];      // all drift found before any fix
  applied: string[];       // safe items applied (when --fix)
  remaining: DriftItem[];  // drift left after fix/accept
  stamped: boolean;        // whether the version stamp was written
}

/** Pure-ish core: reads configPath, optionally mutates+writes, returns the result. */
export function runConfigCheck(opts: ConfigCheckOptions): ConfigCheckResult {
  const raw = JSON.parse(fs.readFileSync(opts.configPath, "utf-8")) as CockpitConfig;
  const def = getDefaultConfig();
  const items = detectDrift(raw, def);

  let working = raw;
  let applied: string[] = [];

  if (opts.fix) {
    const r = applySafeFixes(raw, items, def);
    working = r.config;
    applied = r.applied;
  }

  const remaining = detectDrift(working, def);

  // Stamp when no drift remains (clean after fix), or when the user explicitly accepts.
  let stamped = false;
  if (opts.accept || remaining.length === 0) {
    working = withStamp(working, opts.pkgVersion);
    stamped = true;
  }

  if (opts.fix || opts.accept || stamped) {
    fs.writeFileSync(opts.configPath, JSON.stringify(working, null, 2) + "\n");
  }

  return { items, applied, remaining, stamped };
}

const SEV_COLOR: Record<string, (s: string) => string> = {
  info: chalk.green,
  advisory: chalk.yellow,
  warn: chalk.red,
};
const KIND_GLYPH: Record<string, string> = {
  missing: "+",
  deprecated: "-",
  "changed-default": "~",
  invalid: "✗",
};

function printItems(items: DriftItem[]): void {
  for (const i of items) {
    const color = SEV_COLOR[i.severity] ?? ((s: string) => s);
    const detail = i.note ? `  (${i.note})` : i.suggested !== undefined ? `  → ${JSON.stringify(i.suggested)}` : "";
    console.log("  " + color(`${KIND_GLYPH[i.kind]} ${i.kind}: ${i.path}`) + chalk.dim(detail));
  }
}

export const configCommand = new Command("config").description("Inspect and reconcile cockpit config");

configCommand
  .command("check")
  .description("Detect config drift vs the current default schema")
  .option("--fix", "Apply the safe tier (add missing, remove deprecated)", false)
  .option("--accept", "Stamp the current version without changing config (dismiss advisories)", false)
  .option("--json", "Output drift items as JSON", false)
  .action((opts: { fix: boolean; accept: boolean; json: boolean }) => {
    const pkgVersion = readPkgVersion();
    if (!fs.existsSync(DEFAULT_CONFIG_PATH)) {
      console.log(chalk.yellow("No config found — run `cockpit init` first."));
      return;
    }
    const res = runConfigCheck({ configPath: DEFAULT_CONFIG_PATH, pkgVersion, fix: opts.fix, accept: opts.accept });

    if (opts.json) {
      console.log(JSON.stringify(res.items, null, 2));
      return;
    }

    if (res.items.length === 0) {
      console.log(chalk.green("✔ Config is in sync with the current schema."));
      return;
    }

    console.log(chalk.bold("\nConfig drift:\n"));
    printItems(res.items);

    if (opts.fix && res.applied.length) {
      console.log(chalk.green(`\n✔ Applied ${res.applied.length} safe item(s): ${res.applied.join(", ")}`));
    }
    const judgment = res.remaining.filter((i) => i.kind === "changed-default" || i.kind === "invalid");
    if (judgment.length) {
      console.log(chalk.yellow(`\n${judgment.length} item(s) need review — run the config-doctor skill, or \`cockpit config check --accept\` to keep your values.`));
    } else if (res.stamped) {
      console.log(chalk.green("\n✔ Config reconciled and stamped."));
    }
  });

function readPkgVersion(): string {
  // Resolve package.json relative to this file (dist/commands → ../../package.json).
  const url = new URL("../../package.json", import.meta.url);
  return JSON.parse(fs.readFileSync(url, "utf-8")).version as string;
}
```

> Note: `loadConfig` is imported for parity with other commands but `runConfigCheck` reads raw JSON directly so it can round-trip unknown keys faithfully. If the linter flags the unused import, remove it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/commands/__tests__/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/config.ts src/commands/__tests__/config.test.ts
git commit -m "feat(config): cockpit config check command with --fix/--accept/--json"
```

---

### Task 7: Wire the command + the startup banner into the entrypoint

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Register the command**

In `src/index.ts`, add the import alongside the other command imports:

```typescript
import { configCommand } from "./commands/config.js";
```

And register it next to the others (after `program.addCommand(projectsCommand);`):

```typescript
program.addCommand(configCommand);
```

- [ ] **Step 2: Add the non-throwing banner block**

In `src/index.ts`, immediately AFTER the existing `ensureRuntimeSynced({...})` call and BEFORE `ensureDaemon()`, add:

```typescript
// Non-blocking config-drift banner. Fires only when the running package
// version differs from the version stamped in config.json (i.e. just after
// an update or on a legacy unstamped config). Detect + print only — never
// mutates config and never throws; the CLI must stay usable regardless.
try {
  const cfgPath = join(homedir(), ".config", "cockpit", "config.json");
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    if (needsCheck(cfg, pkg.version)) {
      const items = detectDrift(cfg, getDefaultConfig());
      if (items.length === 0) {
        // No drift — silently advance the stamp so we stay quiet next run.
        writeFileSync(cfgPath, JSON.stringify(withStamp(cfg, pkg.version), null, 2) + "\n");
      } else {
        const from = cfg._cockpitVersion ?? "an earlier version";
        process.stderr.write(
          `\n⚡ cockpit updated ${from} → ${pkg.version} — ${items.length} config change(s) detected.\n` +
          `   Run \`cockpit config check\` (or use the config-doctor skill) to reconcile.\n\n`,
        );
      }
    }
  }
} catch {
  // Drift banner is best-effort; never block the CLI.
}
```

- [ ] **Step 3: Add the imports the block needs**

At the top of `src/index.ts`, extend the `node:fs` import and add the new module imports:

```typescript
import { readFileSync, existsSync, writeFileSync } from "node:fs";
// ... existing imports ...
import { detectDrift } from "./lib/config-drift.js";
import { needsCheck, withStamp } from "./lib/config-version.js";
import { getDefaultConfig } from "./config.js";
```

(`readFileSync` is already imported — just add `existsSync, writeFileSync` to the same statement. `homedir` and `join` are already imported.)

- [ ] **Step 4: Build and verify the CLI still runs**

Run: `npm run build && node dist/index.js --help`
Expected: build clean; help lists a `config` command; no crash, no banner noise (your dev config is already stamped or has no drift).

- [ ] **Step 5: Manual smoke — force a drift and see the banner**

Run:
```bash
# Back up, inject drift, observe banner, then restore.
cp ~/.config/cockpit/config.json /tmp/cockpit-config.bak
node -e "const f='$HOME/.config/cockpit/config.json';const c=JSON.parse(require('fs').readFileSync(f));c._cockpitVersion='0.0.1';delete c.defaults.worktreeDir;require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
node dist/index.js status   # expect the ⚡ banner on stderr
node dist/index.js config check   # expect: + missing: defaults.worktreeDir
node dist/index.js config check --fix   # applies it, stamps
node dist/index.js status   # banner gone
cp /tmp/cockpit-config.bak ~/.config/cockpit/config.json   # RESTORE original
```
Expected: banner appears, `--fix` resolves it, banner disappears, original config restored.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(config): startup drift banner + register config command"
```

---

### Task 8: The `config-doctor` skill

**Files:**
- Create: `plugin/skills/config-doctor/SKILL.md`

> This is portable markdown per the multi-agent direction (Claude reads via Skill tool; other agents via AGENTS.md). It is synced to `~/.config/cockpit/plugin/...` automatically by `ensureRuntimeSynced` on the next CLI run — no extra wiring.

- [ ] **Step 1: Write the skill**

Create `plugin/skills/config-doctor/SKILL.md`:

```markdown
---
name: config-doctor
description: Reconcile cockpit config drift that needs human judgment — changed defaults and invalid values surfaced by `cockpit config check`. Use when the drift banner says "items need review" or the user asks to fix config drift.
---

# Config Doctor

Reconcile the config-drift items that `cockpit config check --fix` deliberately does NOT auto-apply: `changed-default` (you may have customized on purpose) and `invalid` (a value that no longer resolves). The safe tier (missing/deprecated) is already handled by `--fix`; do not duplicate it.

## Steps

1. **Get structured drift:**
   ```bash
   cockpit config check --json
   ```
   This prints a `DriftItem[]`. Focus only on items with `kind` of `changed-default` or `invalid`.

2. **Apply the safe tier first (if any missing/deprecated remain):**
   ```bash
   cockpit config check --fix
   ```
   Re-run `--json` afterward to see what judgment items remain.

3. **For each `changed-default` item:**
   - Show the user: `path`, their `current` value, the new `suggested` default, and the `note`.
   - Ask: *adopt the new default, or keep your value?*
   - If keep → no edit needed (it will be dismissed in step 5 via `--accept`).
   - If adopt → edit `~/.config/cockpit/config.json`, setting `path` to `suggested`. Edit ONLY that path.

4. **For each `invalid` item:**
   - Explain why it's invalid (the `note` says, e.g. "unknown driver 'aider'").
   - Propose the correct value (e.g. switch driver to `claude`/`codex`/`opencode`, or remove the dead agent).
   - On confirmation, edit `~/.config/cockpit/config.json` for that path only. Never touch `projects`, `hubVault`, `commandName`, or other user-data sections.

5. **Finalize:**
   ```bash
   cockpit config check          # confirm zero remaining drift
   cockpit config check --accept # stamp the version so the banner goes quiet
   ```
   If `check` still shows items the user intentionally kept, `--accept` is the correct way to dismiss them.

## Rules

- Edit only the exact dotted paths flagged. One concern per edit.
- Never auto-decide a `changed-default` — it is the user's call.
- After reconciling, the stamp must equal the running cockpit version or the banner returns.
```

- [ ] **Step 2: Verify the skill is well-formed and syncs**

Run:
```bash
test -f plugin/skills/config-doctor/SKILL.md && echo "skill present"
node dist/index.js doctor >/dev/null 2>&1   # any cockpit call triggers ensureRuntimeSynced
test -f ~/.config/cockpit/plugin/skills/config-doctor/SKILL.md && echo "skill synced to runtime"
```
Expected: both echos print — the skill exists in source and was mirrored to the runtime plugin dir.

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/config-doctor/SKILL.md
git commit -m "feat(config): config-doctor skill for judgment-call drift reconciliation"
```

---

### Task 9: Full verification & cleanup

- [ ] **Step 1: Run the full test suite once**

Run: `npx vitest run`
Expected: all tests green, including the new `config-drift`, `config-version`, and `config` command suites. Do NOT run the suite repeatedly or concurrently.

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no type errors.

- [ ] **Step 3: Confirm no orphaned processes**

Run: `pgrep -fl vitest || echo "no vitest workers"`
Expected: no leftover vitest workers (kill any that remain).

- [ ] **Step 4: Confirm working tree is clean and on a feature branch**

Run: `git status -sb && git log --oneline -9`
Expected: branch is `feat/config-drift-detection`, 8 feature commits present, no stray uncommitted files.

---

## Self-Review Notes (for the executor)

- **Spec coverage:** all four drift kinds (missing/deprecated/changed-default/invalid) → Tasks 3–4. Version-stamp trigger → Task 2 + Task 7 banner. `--fix` safe tier → Task 5–6. `--accept` escape hatch → Task 6. Skill for judgment → Task 8. Managed-paths firewall → Task 3 (`MANAGED_PATHS`, user-data exclusion test).
- **The `_def` param in `applySafeFixes`** is unused today (each item carries `suggested`); it is kept for signature stability and may be prefixed `_` to satisfy the linter (already done).
- **`changed-default` requires `KNOWN_DEFAULT_HISTORY`** — only crew/captain model entries are seeded; add more entries as defaults change in future releases. This is the single intentional spot of version history.
- **Branch:** create `feat/config-drift-detection` off `develop` before Task 1.
```
