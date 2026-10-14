import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { computeAnchor, type AnchorCache } from "../knowledge/index.js";

const TRIG = { keywords: ["secret"], expanded: [] as string[] };
let repo: string;
const put = (rel: string, body = "const secret = 1;\n") => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });

beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-")); });
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("computeAnchor file listing", () => {
  it("in a git repo, ignores gitignored dirs and keeps tracked + untracked-not-ignored files", () => {
    git("init", "-q");
    put(".gitignore", "env-local/\n");
    put("src/tracked.py");
    put("src/untracked.py");
    put("env-local/lib/site-packages/leak.py");
    git("add", ".gitignore", "src/tracked.py");
    expect(computeAnchor(repo, TRIG)!.paths).toEqual(["src/tracked.py", "src/untracked.py"]);
  });

  it("in a git repo, drops tracked files under SKIP_DIRS segments (parity with the walk)", () => {
    git("init", "-q");
    put("src/real.py");
    put("dist/bundle.js");
    put("packages/a/node_modules/x/leak.js");
    put("build/out.py");
    git("add", ".");
    expect(computeAnchor(repo, TRIG)!.paths).toEqual(["src/real.py"]);
  });

  it("falls back to the walk (skipping .venv/venv/__pycache__) when not a git repo", () => {
    put("src/real.py");
    put(".venv/lib/leak.py");
    put("venv/lib/leak.py");
    put("__pycache__/leak.py");
    expect(computeAnchor(repo, TRIG)!.paths).toEqual(["src/real.py"]);
  });

  it("anchors files past the old 5000 mark (cap is high and injectable)", () => {
    git("init", "-q");
    for (let i = 0; i < 12; i++) put(`a${String(i).padStart(2, "0")}.py`, "x = 1\n");
    put("zz/late.py");
    git("add", ".");
    expect(computeAnchor(repo, TRIG, undefined, 5)).toBeNull(); // 5-file cap cuts the late file
    expect(computeAnchor(repo, TRIG, undefined, 100)!.paths).toEqual(["zz/late.py"]);
  });

  it("warns once when the safety cap truncates", () => {
    git("init", "-q");
    for (let i = 0; i < 6; i++) put(`f${i}.py`);
    git("add", ".");
    const warns: string[] = [];
    const orig = console.warn; console.warn = (m: string) => { warns.push(m); };
    try { computeAnchor(repo, TRIG, undefined, 3); } finally { console.warn = orig; }
    expect(warns).toHaveLength(1);
  });

  it("a shared cache yields the same anchors as uncached", () => {
    git("init", "-q");
    put("src/a.py", "def secret_a(): pass\n");
    put("src/b.py", "token = 1\n");
    git("add", ".");
    const cache: AnchorCache = new Map();
    const t1 = { keywords: ["secret"], expanded: [] as string[] };
    const t2 = { keywords: ["token"], expanded: ["secret"] };
    for (const t of [t1, t2]) expect(computeAnchor(repo, t, cache)).toEqual(computeAnchor(repo, t));
    expect(cache.size).toBe(1);
  });
});
