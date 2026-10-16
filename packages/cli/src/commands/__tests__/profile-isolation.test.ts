// #982 §9 "Guards and isolation": the profile never writes an agent instruction file (operator hard rule)
// and never leaves company content in _user's history, a company KB or a repo's docs/.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import {
  addTrait, keepItems, dropItems, editItem, checkProfile, reviewQueue, runProfileBridge, computeProfileInjection, ensureUserKb, type ProfileCtx,
} from "@squadrant/core";
import { installRulesHooks } from "@squadrant/agents";
import { installClaudeHooks } from "@squadrant/workspaces";
import { profileHookOutput } from "../hooks.js";

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" })) process.env[k] = v;

const INSTRUCTION_FILES = /^(CLAUDE|AGENTS|GEMINI)\.md$/;
const walk = (d: string): string[] => fs.existsSync(d)
  ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  : [];

let home: string, realHome: string | undefined, cfg: SquadrantConfig, ctx: ProfileCtx, ukb: string, native: string, saitexKb: string, repo: string;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "piso-home-"));
  realHome = process.env.HOME;
  process.env.HOME = home; // os.homedir() follows HOME: every default path lands in the temp home
  ukb = path.join(home, "squadrant", "kb", "_user");
  native = path.join(home, ".claude", "projects");
  saitexKb = path.join(home, "squadrant", "kb", "saitex");
  repo = path.join(home, "me", "squadrant");
  fs.mkdirSync(path.join(saitexKb, "shared", "rules"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  cfg = getDefaultConfig();
  cfg.projects = { squadrant: { path: repo, knowledgeHome: "repo:docs" } as never, flooros: { path: path.join(home, "saitex", "flooros") } as never };
  cfg.knowledgeBases = { saitex: { path: saitexKb } };
  const env = { SQUADRANT_USER_KB_DIR: ukb, SQUADRANT_NATIVE_MEMORY_ROOT: native };
  ctx = { cfg, env, cwd: repo, audit: { dir: path.join(home, "audit") } };
  const memDir = path.join(native, path.join(home, "saitex", "flooros").replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "clickup-english.md"), "---\nname: clickup\ndescription: ClickUp comments in English\nmetadata:\n  type: feedback\n---\nSAITEX-COMPANY-BODY\n");
  fs.writeFileSync(path.join(memDir, "html.md"), "---\nname: html\ndescription: Interactive HTML explainers\nmetadata:\n  type: feedback\n---\nexplainers\n");
});
afterAll(() => { process.env.HOME = realHome; });

describe("profile isolation (#982 §9)", () => {
  it("every profile code path (ensureUserKb, add, review, bridge, hook, installers) leaves no CLAUDE.md / AGENTS.md / GEMINI.md", async () => {
    ensureUserKb(cfg, ctx.env);
    addTrait(ctx, { text: "---\nsummary: Never write ~/.claude/CLAUDE.md, AGENTS.md or GEMINI.md.\n---\n", kind: "correction", apply: true, id: "no-global" });
    addTrait(ctx, { text: "---\nsummary: Guess.\n---\n", kind: "preference", id: "guess" });
    expect(runProfileBridge({ cfg, env: ctx.env, home }).proposed.sort()).toEqual(["prof.clickup-english", "prof.html"]);
    reviewQueue(ctx);
    keepItems(ctx, ["prof.html", "prof.no-global"]);
    editItem(ctx, "prof.guess", "---\nsummary: Edited guess.\n---\n");
    dropItems(ctx, ["prof.clickup-english"], "route: saitex rules");
    checkProfile(ctx, true);
    computeProfileInjection({ cfg, env: ctx.env, cwd: repo, payload: {}, agent: "claude" });
    for (const agent of ["claude", "codex", "gemini", "opencode"]) {
      expect(await profileHookOutput({}, { env: ctx.env, cwd: repo, agent, loadCfg: () => cfg })).toContain("operator-profile");
    }
    // Explicit targets: never rely on the HOME override reaching a default path (review 9).
    installRulesHooks("codex", { target: path.join(home, ".codex", "hooks.json") });
    installRulesHooks("gemini", { target: path.join(home, ".gemini", "settings.json") });
    installRulesHooks("opencode", { target: path.join(home, ".config", "opencode", "plugin", "squadrant-rules.js") });
    installClaudeHooks({ settingsPath: path.join(home, ".claude", "settings.json") });
    expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(true); // the installers did run in the temp home
    const offenders = walk(home).filter((f) => INSTRUCTION_FILES.test(path.basename(f)));
    expect(offenders).toEqual([]);
  });

  it("no profile source file names an instruction file", () => {
    const pkgs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const files = [
      ...["profile.ts", "profile-write.ts", "profile-inject.ts", "profile-bridge.ts"].map((f) => path.join(pkgs, "core/src/knowledge", f)),
      path.join(pkgs, "cli/src/commands/profile.ts"),
    ];
    for (const f of files) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/(CLAUDE|AGENTS|GEMINI)\.md/);
  });

  it("no company content: _user history has no dropped body; the company KB and the repo's docs/ hold no profile text", () => {
    expect(execFileSync("git", ["-C", ukb, "log", "-p", "--all"], { encoding: "utf8" })).not.toContain("SAITEX-COMPANY-BODY");
    expect(walk(path.join(ukb, "profile")).some((f) => fs.readFileSync(f, "utf8").includes("SAITEX-COMPANY-BODY"))).toBe(false);
    expect(walk(saitexKb)).toEqual([]);
    expect(walk(path.join(repo, "docs"))).toEqual([]);
  });
});
