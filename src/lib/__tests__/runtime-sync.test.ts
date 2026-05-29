import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mirrorDir, mirrorFlat, ensureRuntimeSynced } from "../runtime-sync.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-sync-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe("mirrorDir", () => {
  it("copies a new file from src into a non-existent dest", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, "a.txt"), "hello");

    mirrorDir(src, dest);

    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf-8")).toBe("hello");
  });

  it("overwrites a file whose content changed in src", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, "a.txt"), "new");
    write(path.join(dest, "a.txt"), "old");

    mirrorDir(src, dest);

    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf-8")).toBe("new");
  });

  it("prunes a file present in dest but absent in src", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, "keep.txt"), "keep");
    write(path.join(dest, "keep.txt"), "keep");
    write(path.join(dest, "stale.txt"), "stale");

    mirrorDir(src, dest);

    expect(fs.existsSync(path.join(dest, "stale.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "keep.txt"))).toBe(true);
  });

  it("prunes a directory present in dest but absent in src", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, "a.txt"), "a");
    write(path.join(dest, "a.txt"), "a");
    write(path.join(dest, "gone", "nested.txt"), "x");

    mirrorDir(src, dest);

    expect(fs.existsSync(path.join(dest, "gone"))).toBe(false);
  });

  it("mirrors nested directories including dotfiles", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, ".claude-plugin", "plugin.json"), "{}");

    mirrorDir(src, dest);

    expect(
      fs.readFileSync(path.join(dest, ".claude-plugin", "plugin.json"), "utf-8"),
    ).toBe("{}");
  });

  it("does not rewrite an unchanged file (idempotent, no mtime churn)", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, "a.txt"), "same");
    mirrorDir(src, dest);
    const before = fs.statSync(path.join(dest, "a.txt")).mtimeMs;

    mirrorDir(src, dest);

    expect(fs.statSync(path.join(dest, "a.txt")).mtimeMs).toBe(before);
  });
});

describe("mirrorFlat", () => {
  it("copies only files matching the pattern, ignoring others", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, "a.sh"), "sh");
    write(path.join(src, "README.md"), "readme");
    write(path.join(src, "b.sh"), "sh2");

    mirrorFlat(src, dest, /\.sh$/);

    expect(fs.existsSync(path.join(dest, "a.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "b.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(false);
  });

  it("prunes a dest file no longer in the matched source set", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, "keep.sh"), "k");
    write(path.join(dest, "keep.sh"), "k");
    write(path.join(dest, "gone.sh"), "g");

    mirrorFlat(src, dest, /\.sh$/);

    expect(fs.existsSync(path.join(dest, "keep.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "gone.sh"))).toBe(false);
  });

  it("applies chmod to copied files when specified", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, "x.sh"), "echo");

    mirrorFlat(src, dest, /\.sh$/, 0o755);

    expect(fs.statSync(path.join(dest, "x.sh")).mode & 0o777).toBe(0o755);
  });

  it("does not rewrite an unchanged matched file (idempotent)", () => {
    const src = path.join(tmp, "src");
    const dest = path.join(tmp, "dest");
    write(path.join(src, "a.sh"), "x");
    mirrorFlat(src, dest, /\.sh$/);
    const before = fs.statSync(path.join(dest, "a.sh")).mtimeMs;

    mirrorFlat(src, dest, /\.sh$/);

    expect(fs.statSync(path.join(dest, "a.sh")).mtimeMs).toBe(before);
  });
});

describe("ensureRuntimeSynced", () => {
  function setupSource(): { sourceRoot: string; runtimeRoot: string } {
    const sourceRoot = path.join(tmp, "src-root");
    const runtimeRoot = path.join(tmp, "rt-root");
    // plugin: tree target
    write(path.join(sourceRoot, "plugin", "skills", "captain-ops", "SKILL.md"), "captain");
    write(path.join(sourceRoot, "plugin", ".claude-plugin", "plugin.json"), '{"name":"cockpit"}');
    // templates: flat target sourced from orchestrator/, filtered by extension
    write(path.join(sourceRoot, "orchestrator", "captain.claude.md"), "tmpl");
    write(path.join(sourceRoot, "orchestrator", "notes.txt"), "ignore me");
    // scripts: flat target, only *.sh, chmod 0o755
    write(path.join(sourceRoot, "scripts", "learn.sh"), "echo");
    write(path.join(sourceRoot, "scripts", "README.md"), "ignore me");
    fs.mkdirSync(runtimeRoot, { recursive: true });
    return { sourceRoot, runtimeRoot };
  }

  it("syncs all managed subtrees on first run (no state file)", () => {
    const { sourceRoot, runtimeRoot } = setupSource();

    ensureRuntimeSynced({ sourceRoot, runtimeRoot });

    expect(
      fs.readFileSync(path.join(runtimeRoot, "plugin", ".claude-plugin", "plugin.json"), "utf-8"),
    ).toBe('{"name":"cockpit"}');
    // templates sourced from orchestrator/, filtered
    expect(fs.existsSync(path.join(runtimeRoot, "templates", "captain.claude.md"))).toBe(true);
    expect(fs.existsSync(path.join(runtimeRoot, "templates", "notes.txt"))).toBe(false);
    // scripts filtered to *.sh and made executable
    expect(fs.existsSync(path.join(runtimeRoot, "scripts", "learn.sh"))).toBe(true);
    expect(fs.existsSync(path.join(runtimeRoot, "scripts", "README.md"))).toBe(false);
    expect(fs.statSync(path.join(runtimeRoot, "scripts", "learn.sh")).mode & 0o777).toBe(0o755);
  });

  it("is a no-op when source is unchanged (does not rewrite runtime files)", () => {
    const { sourceRoot, runtimeRoot } = setupSource();
    ensureRuntimeSynced({ sourceRoot, runtimeRoot });
    const target = path.join(runtimeRoot, "plugin", "skills", "captain-ops", "SKILL.md");
    const mtimeBefore = fs.statSync(target).mtimeMs;

    ensureRuntimeSynced({ sourceRoot, runtimeRoot });

    expect(fs.statSync(target).mtimeMs).toBe(mtimeBefore);
  });

  it("syncs only the subtree whose source changed", () => {
    const { sourceRoot, runtimeRoot } = setupSource();
    ensureRuntimeSynced({ sourceRoot, runtimeRoot });
    const tmplTarget = path.join(runtimeRoot, "templates", "captain.claude.md");
    const tmplMtime = fs.statSync(tmplTarget).mtimeMs;

    // change only the plugin subtree in source
    write(path.join(sourceRoot, "plugin", "skills", "new-skill", "SKILL.md"), "new");
    ensureRuntimeSynced({ sourceRoot, runtimeRoot });

    expect(fs.existsSync(path.join(runtimeRoot, "plugin", "skills", "new-skill", "SKILL.md"))).toBe(true);
    expect(fs.statSync(tmplTarget).mtimeMs).toBe(tmplMtime);
  });

  it("never touches user/runtime state files outside managed subtrees", () => {
    const { sourceRoot, runtimeRoot } = setupSource();
    write(path.join(runtimeRoot, "config.json"), '{"user":"data"}');
    write(path.join(runtimeRoot, "sessions.json"), '{"s":1}');
    fs.mkdirSync(path.join(runtimeRoot, "spokes", "oneplan"), { recursive: true });

    ensureRuntimeSynced({ sourceRoot, runtimeRoot });

    expect(fs.readFileSync(path.join(runtimeRoot, "config.json"), "utf-8")).toBe('{"user":"data"}');
    expect(fs.readFileSync(path.join(runtimeRoot, "sessions.json"), "utf-8")).toBe('{"s":1}');
    expect(fs.existsSync(path.join(runtimeRoot, "spokes", "oneplan"))).toBe(true);
  });

  it("does not throw when a managed source dir is missing", () => {
    const { sourceRoot, runtimeRoot } = setupSource();
    fs.rmSync(path.join(sourceRoot, "scripts"), { recursive: true, force: true });

    expect(() => ensureRuntimeSynced({ sourceRoot, runtimeRoot })).not.toThrow();
    expect(fs.existsSync(path.join(runtimeRoot, "plugin", ".claude-plugin"))).toBe(true);
  });

  it("self-heals an incomplete dest even when source is unchanged", () => {
    const { sourceRoot, runtimeRoot } = setupSource();
    ensureRuntimeSynced({ sourceRoot, runtimeRoot });
    // simulate runtime corruption: a synced file goes missing
    const victim = path.join(runtimeRoot, "plugin", ".claude-plugin", "plugin.json");
    fs.rmSync(victim);
    expect(fs.existsSync(victim)).toBe(false);

    // source is unchanged — must still repair (no state cache that can lie)
    ensureRuntimeSynced({ sourceRoot, runtimeRoot });

    expect(fs.readFileSync(victim, "utf-8")).toBe('{"name":"cockpit"}');
  });

  it("does not write a .sync-state.json (no cache)", () => {
    const { sourceRoot, runtimeRoot } = setupSource();
    ensureRuntimeSynced({ sourceRoot, runtimeRoot });
    expect(fs.existsSync(path.join(runtimeRoot, ".sync-state.json"))).toBe(false);
  });
});
