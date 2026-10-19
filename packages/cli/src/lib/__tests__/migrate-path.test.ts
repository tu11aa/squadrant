import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SquadrantConfig } from "@squadrant/shared";
import { encodeClaudeDir, keepItems, loadProfile, nativeNoteHash, runProfileBridge } from "@squadrant/core";
import { migrateKb, migratePath } from "../migrate-kb.js";
import { moveMap, sweepMoves } from "../ref-sweep.js";

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" })) process.env[k] = v;

// #998: `migrate path` and the `migrate kb` sweep on a hermetic HOME fixture. Every root squadrant
// reads (native memory, workspace, archive, KBs, project repos) is pointed inside the temp dir.
describe("migratePath + reference sweep (#998)", () => {
  let home: string;
  let cfg: SquadrantConfig;
  const envKeys = ["SQUADRANT_NATIVE_MEMORY_ROOT", "SQUADRANT_WORKSPACE_DIR", "SQUADRANT_ARCHIVE_DIR", "SQUADRANT_USER_KB_DIR"] as const;
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const h = (rel: string) => path.join(home, rel);
  const put = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(h(rel)), { recursive: true });
    fs.writeFileSync(h(rel), body);
  };
  const read = (rel: string) => fs.readFileSync(h(rel), "utf8");
  const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", h(repo), "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  /** sha256 over every path + content under home (symlinks as their target text). */
  const hashTree = () => {
    const hash = crypto.createHash("sha256");
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(d, e.name);
        hash.update(path.relative(home, full));
        if (e.isSymbolicLink()) hash.update(fs.readlinkSync(full));
        else if (e.isDirectory()) walk(full);
        else hash.update(fs.readFileSync(full));
      }
    };
    walk(home);
    return hash.digest("hex");
  };
  const run = (dryRun: boolean, from = "~/saitex/kb/work", to = "~/squadrant/workspace/flooros/artifacts/work") =>
    migratePath(cfg, from.replace("~", home), to.replace("~", home), { dryRun, home, today: "2026-10-19" });
  const OLD = new Date("2026-10-01T10:00:00Z");
  const NEWEST = new Date("2026-10-19T09:00:00Z");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-migrate-path-"));
    process.env.SQUADRANT_NATIVE_MEMORY_ROOT = h(".claude/projects");
    process.env.SQUADRANT_WORKSPACE_DIR = h("squadrant/workspace");
    process.env.SQUADRANT_ARCHIVE_DIR = h("squadrant/archive");
    process.env.SQUADRANT_USER_KB_DIR = h("squadrant/kb/_user");

    // the operator-made dir being moved
    put("saitex/kb/work/plan.md", "plan");
    put("saitex/kb/work/sub/y.md", "y");
    put("saitex/kb/workshop/z.md", "sibling, never moved");

    // reference sites
    put(".claude/projects/-flooros/memory/work.md", `plans live in ~/saitex/kb/work/plan.md\nabs: ${home}/saitex/kb/work/sub/y.md\nsibling: ~/saitex/kb/workshop/z.md\n`);
    put("squadrant/workspace/flooros/handoff.json", '{"next": "read ~/saitex/kb/work"}\n');
    put("squadrant/workspace/flooros/side-handoffs/topic.md", "see $HOME/saitex/kb/work/sub/y.md\n");
    // archived handoffs: the newest is the live checkpoint `handoff facts` reads, the older one is history
    put("squadrant/workspace/flooros/handoffs/2026-10-01.json", '{"then": "~/saitex/kb/work/plan.md"}\n');
    put("squadrant/workspace/flooros/handoffs/2026-10-19.json", '{"next": "~/saitex/kb/work/sub/y.md"}\n');
    fs.utimesSync(h("squadrant/workspace/flooros/handoffs/2026-10-01.json"), OLD, OLD);
    fs.utimesSync(h("squadrant/workspace/flooros/handoffs/2026-10-19.json"), NEWEST, NEWEST);
    put("squadrant/kb/saitex/shared/decisions/d1.md", "sources: [file:~/saitex/kb/work/plan.md]\n");
    put("squadrant/kb/saitex/errata.yaml", "- ref: file:~/saitex/kb/work/sub/y.md\n");
    put("squadrant/kb/saitex/sources.yaml", "- path: ~/saitex/kb/work\n");
    put("squadrant/kb/saitex/index.json", '{"ref": "~/saitex/kb/work/plan.md"}'); // derived: never touched
    put("squadrant/kb/saitex/raw/doc.md", "~/saitex/kb/work/plan.md"); // raw source (sha-cited): never touched
    git("squadrant/kb/saitex", "init", "-q");
    git("squadrant/kb/saitex", "add", "-A");
    git("squadrant/kb/saitex", "commit", "-q", "-m", "init");
    fs.writeFileSync(h("squadrant/kb/saitex/.git/description"), "~/saitex/kb/work"); // git internals: never touched
    put("repo/AGENTS.md", "Artifacts: ~/saitex/kb/work/\n");
    fs.symlinkSync("AGENTS.md", h("repo/CLAUDE.md"));

    cfg = {
      projects: { flooros: { path: h("repo"), captainName: "f", host: "local" } },
      knowledgeBases: { saitex: { path: h("squadrant/kb/saitex") } },
    } as unknown as SquadrantConfig;
  });

  afterEach(() => {
    for (const k of envKeys) process.env[k] = saved[k];
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("--dry-run changes no bytes, commits nothing, and reports the move, the prune and every reference", () => {
    const before = hashTree();
    const { rows, refs, notes } = run(true);
    expect(hashTree()).toBe(before);
    expect(notes).toEqual([]);
    expect(rows).toMatchObject([
      { action: "would-move", from: h("saitex/kb/work"), to: h("squadrant/workspace/flooros/artifacts/work"), note: "2 files" },
      { action: "would-prune", from: h("saitex/kb/work"), note: expect.stringMatching(/^2 empty dirs/) },
    ]);
    expect(refs.map((r) => [r.action, path.relative(home, r.file), r.line, r.old, r.new])).toEqual([
      ["would-rewrite", ".claude/projects/-flooros/memory/work.md", 1, "~/saitex/kb/work/plan.md", "~/squadrant/workspace/flooros/artifacts/work/plan.md"],
      ["would-rewrite", ".claude/projects/-flooros/memory/work.md", 2, `${home}/saitex/kb/work/sub/y.md`, `${home}/squadrant/workspace/flooros/artifacts/work/sub/y.md`],
      ["would-rewrite", "squadrant/workspace/flooros/handoff.json", 1, "~/saitex/kb/work", "~/squadrant/workspace/flooros/artifacts/work"],
      ["would-rewrite", "squadrant/workspace/flooros/side-handoffs/topic.md", 1, "$HOME/saitex/kb/work/sub/y.md", "$HOME/squadrant/workspace/flooros/artifacts/work/sub/y.md"],
      ["would-rewrite", "squadrant/workspace/flooros/handoffs/2026-10-19.json", 1, "~/saitex/kb/work/sub/y.md", "~/squadrant/workspace/flooros/artifacts/work/sub/y.md"],
      ["report-only", "squadrant/workspace/flooros/handoffs/2026-10-01.json", 1, "~/saitex/kb/work/plan.md", "~/squadrant/workspace/flooros/artifacts/work/plan.md"],
      ["would-rewrite", "squadrant/kb/saitex/errata.yaml", 1, "~/saitex/kb/work/sub/y.md", "~/squadrant/workspace/flooros/artifacts/work/sub/y.md"],
      ["would-rewrite", "squadrant/kb/saitex/shared/decisions/d1.md", 1, "~/saitex/kb/work/plan.md", "~/squadrant/workspace/flooros/artifacts/work/plan.md"],
      ["would-rewrite", "squadrant/kb/saitex/sources.yaml", 1, "~/saitex/kb/work", "~/squadrant/workspace/flooros/artifacts/work"],
      ["would-rewrite", "repo/AGENTS.md", 1, "~/saitex/kb/work/", "~/squadrant/workspace/flooros/artifacts/work/"],
    ]);
  });

  it("the real run moves the dir, prunes its empty dirs, rewrites every hit, commits the KB; a second run is a no-op", () => {
    const dry = run(true).refs;
    const { rows, refs, notes } = run(false);
    expect(rows).toMatchObject([{ action: "moved", note: "2 files" }, { action: "pruned", note: expect.stringMatching(/^2 empty dirs/) }]);
    expect(read("squadrant/workspace/flooros/artifacts/work/plan.md")).toBe("plan");
    expect(read("squadrant/workspace/flooros/artifacts/work/sub/y.md")).toBe("y");
    expect(fs.existsSync(h("saitex/kb/work"))).toBe(false);
    expect(read("saitex/kb/workshop/z.md")).toBe("sibling, never moved");
    expect(refs.map((r) => [r.file, r.line, r.old])).toEqual(dry.map((r) => [r.file, r.line, r.old]));

    for (const r of refs) {
      const line = fs.readFileSync(r.file, "utf8").split("\n")[r.line - 1];
      if (r.action === "report-only") expect(line).toContain(r.old);
      else expect(line).toContain(r.new);
      // the backup holds the original
      if (r.action === "rewritten") expect(fs.readFileSync(path.join(home, "squadrant/archive/2026-10-19/ref-sweep", path.relative(home, r.file)), "utf8")).toContain(r.old);
    }
    expect(read(".claude/projects/-flooros/memory/work.md")).toContain("sibling: ~/saitex/kb/workshop/z.md");
    expect(read("squadrant/kb/saitex/index.json")).toContain("~/saitex/kb/work/plan.md");
    expect(read("squadrant/kb/saitex/raw/doc.md")).toBe("~/saitex/kb/work/plan.md");
    expect(read("squadrant/kb/saitex/.git/description")).toBe("~/saitex/kb/work");
    expect(read("repo/CLAUDE.md")).toBe("Artifacts: ~/squadrant/workspace/flooros/artifacts/work/\n");

    // the checkpoint handoff is rewritten with its mtime kept (handoff facts dates the checkpoint by it); history is not
    expect(read("squadrant/workspace/flooros/handoffs/2026-10-19.json")).toBe('{"next": "~/squadrant/workspace/flooros/artifacts/work/sub/y.md"}\n');
    expect(fs.statSync(h("squadrant/workspace/flooros/handoffs/2026-10-19.json")).mtime).toEqual(NEWEST);
    expect(read("squadrant/workspace/flooros/handoffs/2026-10-01.json")).toBe('{"then": "~/saitex/kb/work/plan.md"}\n');

    // KB rewrites are committed (index.json untouched, so nothing is left dirty); never pushed
    expect(notes).toEqual([`committed 3 file(s) in ${h("squadrant/kb/saitex")}: ref-sweep: ~/saitex/kb/work -> ~/squadrant/workspace/flooros/artifacts/work (#998)`]);
    expect(git("squadrant/kb/saitex", "log", "-1", "--format=%s")).toBe("ref-sweep: ~/saitex/kb/work -> ~/squadrant/workspace/flooros/artifacts/work (#998)\n");
    expect(git("squadrant/kb/saitex", "status", "--porcelain")).toBe("");

    const after = hashTree();
    const again = run(false);
    expect(hashTree()).toBe(after);
    expect(again.rows).toEqual([]);
    expect(again.notes).toEqual([]);
    expect(again.refs.map((r) => r.action)).toEqual(["report-only"]);
  });

  it("a KB file with uncommitted edits before the sweep is rewritten but not committed", () => {
    fs.appendFileSync(h("squadrant/kb/saitex/errata.yaml"), "- operator edit in progress\n");
    const { notes } = run(false);
    expect(notes).toEqual([
      `committed 2 file(s) in ${h("squadrant/kb/saitex")}: ref-sweep: ~/saitex/kb/work -> ~/squadrant/workspace/flooros/artifacts/work (#998)`,
      `not committed in ${h("squadrant/kb/saitex")} (untracked, or it had uncommitted edits before the sweep): errata.yaml`,
    ]);
    expect(git("squadrant/kb/saitex", "status", "--porcelain")).toBe(" M errata.yaml\n");
  });

  it("rewrite-only: <from> already gone and <to> present rewrites the references, moves nothing", () => {
    fs.mkdirSync(h("squadrant/workspace/flooros/artifacts"), { recursive: true });
    fs.renameSync(h("saitex/kb/work"), h("squadrant/workspace/flooros/artifacts/work"));
    const { rows, refs } = run(false);
    expect(rows).toEqual([]);
    expect(refs.filter((r) => r.action === "rewritten")).toHaveLength(9);
    expect(read("squadrant/kb/saitex/shared/decisions/d1.md")).toBe("sources: [file:~/squadrant/workspace/flooros/artifacts/work/plan.md]\n");
  });

  it("a target file that exists is skipped: it and its dir stay, references to it keep the old path", () => {
    put("squadrant/workspace/flooros/artifacts/work/plan.md", "other plan");
    const { rows } = run(false);
    expect(rows).toMatchObject([
      { action: "moved", note: "1 file" },
      { action: "skipped", from: h("saitex/kb/work/plan.md") },
      { action: "pruned", note: expect.stringMatching(/^1 empty dir;/) },
    ]);
    expect(read("saitex/kb/work/plan.md")).toBe("plan");
    expect(fs.existsSync(h("saitex/kb/work/sub"))).toBe(false);
    expect(read("squadrant/kb/saitex/shared/decisions/d1.md")).toBe("sources: [file:~/saitex/kb/work/plan.md]\n");
    expect(read("squadrant/kb/saitex/errata.yaml")).toBe("- ref: file:~/squadrant/workspace/flooros/artifacts/work/sub/y.md\n");
  });

  it("errors when both paths are missing, or when <to> is inside <from>", () => {
    expect(() => run(false, "~/nope", "~/also-nope")).toThrow(/neither/);
    expect(() => run(false, "~/saitex/kb/work", "~/saitex/kb/work/inner")).toThrow(/inside/);
  });

  it("rewriting a memory note behind an active profile trait refreshes its source hash: the bridge proposes no update", () => {
    const enc = encodeClaudeDir(home); // $HOME's Claude dir is on the bridge allowlist
    put(`.claude/projects/${enc}/memory/work-location.md`,
      "---\nname: work-location\ndescription: Work notes live in ~/saitex/kb/work\nmetadata:\n  type: feedback\n---\nKeep plans under ~/saitex/kb/work/plan.md\n");
    const env = { SQUADRANT_USER_KB_DIR: h("squadrant/kb/_user"), SQUADRANT_NATIVE_MEMORY_ROOT: h(".claude/projects") };
    const bridge = () => runProfileBridge({ cfg, env, home, audit: { dir: h("audit") } });
    expect(bridge().proposed).toEqual(["prof.work-location"]);
    expect(keepItems({ cfg, env, audit: { dir: h("audit") } }, ["prof.work-location"])[0]).toMatchObject({ ok: true });
    const sourceOf = () => loadProfile(h("squadrant/kb/_user")).active.find((t) => t.id === "prof.work-location")!.sources[0];
    const was = sourceOf();

    const { refs, notes } = run(false);
    expect(refs).toContainEqual(expect.objectContaining({ site: "profile", action: "rewritten", old: was }));
    expect(sourceOf()).not.toBe(was);
    expect(sourceOf()).toMatch(new RegExp(`^memory:${enc}/work-location\\.md#[0-9a-f]{12}$`));
    expect(bridge().proposed).toEqual([]);
    expect(notes).toContainEqual(expect.stringMatching(new RegExp(`^committed 1 file\\(s\\) in ${h("squadrant/kb/_user").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `)));
    expect(git("squadrant/kb/_user", "status", "--porcelain")).toBe("");
  });

  it("a dropped update's hash in _dropped.yaml follows the rewrite too (drop = stop asking survives the sweep)", () => {
    const note = "---\nname: n\ndescription: d\nmetadata:\n  type: feedback\n---\nsee ~/saitex/kb/work/plan.md\n";
    put(".claude/projects/-flooros/memory/n.md", note);
    const was = nativeNoteHash(note)!;
    put("squadrant/kb/_user/profile/_dropped.yaml", `- source: memory:-flooros/n.md\n  hash: ${was}\n  reason: r\n  date: 2026-10-01\n`);
    run(false);
    const now = nativeNoteHash(read(".claude/projects/-flooros/memory/n.md"))!;
    expect(now).not.toBe(was);
    expect(read("squadrant/kb/_user/profile/_dropped.yaml")).toBe(`- source: memory:-flooros/n.md\n  hash: ${now}\n  reason: r\n  date: 2026-10-01\n`);
  });

  it("migrate kb's moves feed the same sweep (dry-run reports, real run rewrites)", () => {
    put("squadrant-hub/spokes/flooros/side-handoffs/spoke-topic.md", "t");
    put(".claude/projects/-flooros/memory/side.md", "see ~/squadrant-hub/spokes/flooros/side-handoffs/spoke-topic.md\n");
    cfg.hubVault = h("squadrant-hub");
    cfg.projects.flooros.spokeVault = h("squadrant-hub/spokes/flooros");
    const kbOpts = (dryRun: boolean) => ({ dryRun, configDir: h(".config/squadrant"), stateRoot: h(".local/state/squadrant"), launchdLogPath: () => null, today: "2026-10-19" });
    const sweep = (dryRun: boolean) => sweepMoves(cfg, moveMap(migrateKb(cfg, kbOpts(dryRun))), { dryRun, home, today: "2026-10-19" }).refs;

    expect(sweep(true)).toMatchObject([{ action: "would-rewrite", old: "~/squadrant-hub/spokes/flooros/side-handoffs/spoke-topic.md", new: "~/squadrant/workspace/flooros/side-handoffs/spoke-topic.md" }]);
    expect(read(".claude/projects/-flooros/memory/side.md")).toContain("squadrant-hub");
    expect(sweep(false)).toMatchObject([{ action: "rewritten" }]);
    expect(read(".claude/projects/-flooros/memory/side.md")).toBe("see ~/squadrant/workspace/flooros/side-handoffs/spoke-topic.md\n");
  });
});
