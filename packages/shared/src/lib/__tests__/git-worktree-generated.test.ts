import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  removeWorktree,
  worktreeDirtyFiles,
  removeGeneratedWorktreeFiles,
} from "../git-worktree.js";

// #889: real temp repos — the close guard + `git worktree remove` interplay
// with the file squadrant itself writes into every claude crew worktree.
const GEN = ".claude/settings.local.json";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();

let tmp: string;
let repo: string;
let wt: string;

function write(root: string, rel: string, body = "{}\n"): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sq-gen-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  write(repo, "README.md", "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  wt = path.join(tmp, "wt");
  git(repo, "worktree", "add", "-q", "-b", "crew/x", wt);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("squadrant-generated worktree files (#889)", () => {
  it("untracked generated file alone is not dirty; removal then succeeds without --force", () => {
    write(wt, GEN);
    expect(worktreeDirtyFiles(wt)).toEqual([]);
    removeGeneratedWorktreeFiles(wt);
    removeWorktree(repo, wt);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("generated file + another untracked file still reports the other file and keeps both", () => {
    write(wt, GEN);
    write(wt, ".env", "SECRET=1\n");
    expect(worktreeDirtyFiles(wt)).toEqual([".env"]);
  });

  it("removeGeneratedWorktreeFiles never touches other files, and removal still refuses", () => {
    write(wt, GEN);
    write(wt, ".env", "SECRET=1\n");
    removeGeneratedWorktreeFiles(wt);
    expect(fs.existsSync(path.join(wt, GEN))).toBe(false);
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(() => removeWorktree(repo, wt)).toThrow();
  });

  it("tracked + modified settings.local.json is the user's: still dirty, never deleted", () => {
    write(wt, GEN, '{"a":1}\n');
    git(wt, "add", GEN);
    git(wt, "commit", "-q", "-m", "track it");
    write(wt, GEN, '{"a":2}\n');
    expect(worktreeDirtyFiles(wt)).toEqual([GEN]);
    removeGeneratedWorktreeFiles(wt);
    expect(fs.readFileSync(path.join(wt, GEN), "utf8")).toBe('{"a":2}\n');
    expect(() => removeWorktree(repo, wt)).toThrow();
  });
});
