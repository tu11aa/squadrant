// src/control/__tests__/headless-registry.test.ts
import { describe, it, expect } from "vitest";
import { getHeadlessAdapter } from "../headless/registry.js";

describe("headless registry", () => {
  it("resolves claude/opencode/codex adapters", () => {
    expect(getHeadlessAdapter("claude").provider).toBe("claude");
    expect(getHeadlessAdapter("opencode").provider).toBe("opencode");
    expect(getHeadlessAdapter("codex").provider).toBe("codex");
  });

  it("codex buildCommand: `codex exec --json --skip-git-repo-check <prompt>` (codex-cli 0.130.0)", () => {
    const argv = getHeadlessAdapter("codex").buildCommand("do x");
    expect(argv.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(argv).toContain("--json");
    // REQUIRED: daemon cwd under launchd is not a git repo (real prod failure).
    expect(argv).toContain("--skip-git-repo-check");
    // prompt is the trailing positional, not consumed by a flag.
    expect(argv[argv.length - 1]).toBe("do x");
    // no bogus `--session` flag (resume is a subcommand in real codex CLI).
    expect(argv).not.toContain("--session");
    // codex exec defaults to a READ-ONLY sandbox → must request workspace-write
    // or a crew can analyze/spec but never edit code (real prod finding).
    expect(argv.join(" ")).toContain("--sandbox workspace-write");
  });

  it("codex buildCommand with sessionId uses the `resume` subcommand, not --session", () => {
    const argv = getHeadlessAdapter("codex").buildCommand("more", "sess-9");
    expect(argv.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
    expect(argv).toContain("sess-9");
    expect(argv).not.toContain("--session");
  });

  it("codex parseResult: exit 0 → done; exit≠0 → failed", () => {
    const a = getHeadlessAdapter("codex");
    expect(a.parseResult("{}", 0).outcome).toBe("done");
    expect(a.parseResult("err", 3)).toMatchObject({ outcome: "failed", exitCode: 3 });
  });

  it("codex parseResult: exit 0 success → sessionId is undefined", () => {
    const a = getHeadlessAdapter("codex");
    const out = a.parseResult("{}", 0);
    expect(out.outcome).toBe("done");
    expect(out.sessionId).toBeUndefined();
  });

  it("unknown provider throws", () => {
    expect(() => getHeadlessAdapter("nonexistent")).toThrow(/no headless adapter/i);
  });
});
