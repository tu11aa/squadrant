// verify-cli.test.ts — #1136: argv-level tests for `squadrant verify` subcommands.
// The parent `verify` declares --base/--repo too; subcommand options must not be swallowed by it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { verifyCommand } from "../verify.js";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

async function run(argv: string[]): Promise<{ out: string; code: number | undefined }> {
  const program = new Command().exitOverride();
  program.addCommand(verifyCommand());
  const logs: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => { logs.push(String(s)); });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  let code: number | undefined;
  const exit = vi.spyOn(process, "exit").mockImplementation(((c?: number) => { code = c; throw new Error("exit"); }) as never);
  try { await program.parseAsync(argv, { from: "user" }); } catch { /* exit */ }
  finally { log.mockRestore(); err.mockRestore(); exit.mockRestore(); }
  return { out: logs.join("\n"), code };
}

describe("verify risk CLI (#1136)", () => {
  let dir: string, decoy: string, base: string;
  const write = (rel: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), c); };
  const commit = (msg: string) => { sh(dir, "add", "-A"); sh(dir, "commit", "-qm", msg); };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-cli-")));
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "t@t"); sh(dir, "config", "user.name", "t");
    write(".squadrant/risk-map.json", JSON.stringify({ entries: [
      { glob: "src/core/**", tier: "high", invariants: ["inv-1", "inv-2"], requiredSteps: ["db"] },
      { glob: "src/core/state/**", tier: "high", invariants: ["inv-3"] },
      { glob: "docs/**", tier: "low" },
    ] }));
    write("README.md", "x");
    commit("init");
    base = sh(dir, "rev-parse", "HEAD");
    // cwd is a separate decoy repo: a swallowed --repo acts on the decoy, never on the real checkout.
    decoy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-cli-decoy-")));
    sh(decoy, "init", "-q", "-b", "main");
    vi.spyOn(process, "cwd").mockReturnValue(decoy);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(decoy, { recursive: true, force: true });
  });

  it("`verify risk --base <sha> --repo <dir>` uses both options (not swallowed by parent)", async () => {
    write("src/core/state/a.ts", "x");
    commit("touch core");
    // cwd is a decoy and there is no `develop` branch: only honoured --repo/--base can produce this diff.
    const r = await run(["verify", "risk", "--base", base, "--repo", dir]);
    expect(r.code).toBeUndefined();
    const j = JSON.parse(r.out);
    expect(j.label).toBe("high");
    expect(j.files).toEqual(["src/core/state/a.ts"]);
    expect(j.requiredSteps).toEqual(["db"]);
  });

  it("invariants is always a flat array of { file, glob, invariant }", async () => {
    write("docs/a.md", "x");
    commit("docs");
    const low = JSON.parse((await run(["verify", "risk", "--base", base, "--repo", dir])).out);
    expect(low).toEqual({ label: "low", files: ["docs/a.md"], invariants: [], requiredSteps: [] });

    write("src/core/state/a.ts", "x");
    commit("core");
    const high = JSON.parse((await run(["verify", "risk", "--base", base, "--repo", dir])).out);
    expect(high.invariants).toEqual([
      { file: "src/core/state/a.ts", glob: "src/core/**", invariant: "inv-1" },
      { file: "src/core/state/a.ts", glob: "src/core/**", invariant: "inv-2" },
      { file: "src/core/state/a.ts", glob: "src/core/state/**", invariant: "inv-3" },
    ]);
  });

  it("`verify install-hook --mode check --repo <dir>` uses --repo", async () => {
    const r = await run(["verify", "install-hook", "--mode", "check", "--repo", dir]);
    expect(r.code).toBeUndefined();
    expect(fs.existsSync(path.join(dir, ".git", "hooks", "pre-push"))).toBe(true);
    expect(fs.existsSync(path.join(decoy, ".git", "hooks", "pre-push"))).toBe(false);
  });
});
