import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneClaudeProjects } from "../dev.js";

describe("pruneClaudeProjects (#1046 dev down)", () => {
  const setup = (data: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "claude-json-"));
    const file = join(dir, ".claude.json");
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    return { dir, file };
  };

  it("removes only the projects under the dev root and keeps every other key", () => {
    const { dir, file } = setup({
      theme: "dark",
      projects: {
        "/tmp/sqdev": { a: 1 },
        "/tmp/sqdev/devtest": { hasTrustDialogAccepted: true },
        "/tmp/sqdev-other/x": { keep: true },
        "/Users/me/real": { keep: true },
      },
    });
    expect(pruneClaudeProjects(["/tmp/sqdev"], file)).toBe(2);
    const out = JSON.parse(readFileSync(file, "utf8"));
    expect(out.theme).toBe("dark");
    expect(Object.keys(out.projects).sort()).toEqual(["/Users/me/real", "/tmp/sqdev-other/x"]);
    expect(readdirSync(dir)).toEqual([".claude.json"]); // no temp file left behind
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("matches the resolved spelling too, and leaves the file untouched when nothing matches", () => {
    const { file } = setup({ projects: { "/private/tmp/sqdev/devtest": {} } });
    expect(pruneClaudeProjects(["/tmp/sqdev", "/private/tmp/sqdev"], file)).toBe(1);
    const before = readFileSync(file, "utf8");
    expect(pruneClaudeProjects(["/tmp/sqdev"], file)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("is a no-op when ~/.claude.json is missing or unparseable", () => {
    const { dir, file } = setup({});
    expect(pruneClaudeProjects(["/tmp/x"], join(dir, "nope.json"))).toBe(0);
    writeFileSync(file, "{not json");
    expect(pruneClaudeProjects(["/tmp/x"], file)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });
});
