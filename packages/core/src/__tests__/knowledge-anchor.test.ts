import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { computeAnchor } from "../knowledge/index.js";

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

  it("falls back to the walk (skipping .venv/venv/__pycache__) when not a git repo", () => {
    put("src/real.py");
    put(".venv/lib/leak.py");
    put("venv/lib/leak.py");
    put("__pycache__/leak.py");
    expect(computeAnchor(repo, TRIG)!.paths).toEqual(["src/real.py"]);
  });
});
