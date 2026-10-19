import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepRefs, danglingRefs, moveMap, type RefSite } from "../ref-sweep.js";

// #998: the reference sweep on a fixture home. Nothing outside the temp dir is read or written.
describe("ref-sweep (#998)", () => {
  let home: string;
  let archive: string;
  const savedArchive = process.env.SQUADRANT_ARCHIVE_DIR;

  const put = (rel: string, body: string) => {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  const site = (...files: string[]): RefSite[] => [{ site: "memory:claude", files }];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-ref-sweep-"));
    archive = path.join(home, "squadrant", "archive");
    process.env.SQUADRANT_ARCHIVE_DIR = archive;
  });
  afterEach(() => {
    process.env.SQUADRANT_ARCHIVE_DIR = savedArchive;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("finds the ~/, absolute, $HOME and file: forms plus sub-paths, keeping each form", () => {
    const mem = put(".claude/projects/p/memory/a.md", [
      "see ~/a/work",
      `abs ${home}/a/work/x.md here`,
      "ref: file:~/a/work/notes/y.md",
      "env $HOME/a/work/z.md.",
      '{"p": "~/a/work/q.json"}',
    ].join("\n"));
    const { hits } = sweepRefs(new Map([[path.join(home, "a", "work"), path.join(home, "b", "art")]]), site(mem), { dryRun: true, home });
    expect(hits.map((h) => [h.line, h.old, h.new])).toEqual([
      [1, "~/a/work", "~/b/art"],
      [2, `${home}/a/work/x.md`, `${home}/b/art/x.md`],
      [3, "~/a/work/notes/y.md", "~/b/art/notes/y.md"],
      [4, "$HOME/a/work/z.md", "$HOME/b/art/z.md"],
      [5, "~/a/work/q.json", "~/b/art/q.json"],
    ]);
    expect(hits.every((h) => h.action === "would-rewrite" && h.file === mem)).toBe(true);
  });

  it("respects path boundaries: a sibling prefix, a longer file name or a nested path is not a match", () => {
    const mem = put("m.md", [
      "~/a/workshop/x.md",
      "~/a/work.md",
      "~/a/work-old/",
      "/srv/x/a/work",
      `/other${home}/a/work`,
      "~~/a/work",
    ].join("\n"));
    expect(sweepRefs(new Map([[path.join(home, "a", "work"), path.join(home, "b")]]), site(mem), { dryRun: true, home }).hits).toEqual([]);
  });

  it("apply mode backs the original up under archiveRoot()/<date>/ref-sweep/<path from home> before rewriting", () => {
    const body = "cite ~/a/work/x.md and ~/a/workshop\n";
    const mem = put(".claude/projects/p/memory/a.md", body);
    const { hits } = sweepRefs(new Map([[path.join(home, "a", "work"), path.join(home, "b")]]), site(mem), { home, today: "2026-10-19" });
    expect(hits).toMatchObject([{ action: "rewritten", old: "~/a/work/x.md", new: "~/b/x.md" }]);
    expect(fs.readFileSync(mem, "utf8")).toBe("cite ~/b/x.md and ~/a/workshop\n");
    const backup = path.join(archive, "2026-10-19", "ref-sweep", ".claude/projects/p/memory/a.md");
    expect(fs.readFileSync(backup, "utf8")).toBe(body);

    // a second rewrite of the same file the same day keeps the first backup
    fs.writeFileSync(mem, "again ~/a/work\n");
    sweepRefs(new Map([[path.join(home, "a", "work"), path.join(home, "b")]]), site(mem), { home, today: "2026-10-19" });
    expect(fs.readFileSync(backup, "utf8")).toBe(body);
    expect(fs.readFileSync(`${backup}.1`, "utf8")).toBe("again ~/a/work\n");
  });

  it("read-only sites are reported, never rewritten; a pinned (skipped) sub-path keeps its reference", () => {
    const archived = put("ws/p/handoffs/2026-10-01.json", '{"x": "~/a/work/1.md"}');
    const live = put("ws/p/handoff.json", '{"x": "~/a/work/kept.md", "y": "~/a/work/1.md"}');
    const map = moveMap([
      { from: path.join(home, "a", "work"), to: path.join(home, "b"), action: "moved" },
      { from: path.join(home, "a", "work", "kept.md"), to: path.join(home, "b", "kept.md"), action: "skipped" },
    ]);
    const { hits } = sweepRefs(map, [{ site: "workspace-archive", files: [archived], readOnly: true }, { site: "workspace", files: [live] }], { home });
    expect(hits.map((h) => [h.site, h.action, h.old])).toEqual([
      ["workspace-archive", "report-only", "~/a/work/1.md"],
      ["workspace", "rewritten", "~/a/work/1.md"],
    ]);
    expect(fs.readFileSync(archived, "utf8")).toBe('{"x": "~/a/work/1.md"}');
    expect(fs.readFileSync(live, "utf8")).toBe('{"x": "~/a/work/kept.md", "y": "~/b/1.md"}');
  });

  it("danglingRefs lists missing home paths, ignoring globs, placeholders, temp paths and existing ones", () => {
    put("real/file.md", "x");
    const mem = put("m.md", [
      "gone: ~/saitex/kb/extracted/pr-rules.md §13",
      "ok: ~/real/file.md:12 and `~/real/file.md#top`.",
      `gone abs: ${home}/nope/x`,
      "glob ~/x/*.md, placeholder ~/squadrant/workspace/<p>/handoff.json, brace ~/x/{a,b}, elided ~/x/.../y",
      "temp ~/tmp/x and ~/work/scratchpad/y",
    ].join("\n"));
    expect(danglingRefs(site(mem), home)).toEqual([
      { site: "memory:claude", file: mem, line: 1, ref: "~/saitex/kb/extracted/pr-rules.md" },
      { site: "memory:claude", file: mem, line: 3, ref: `${home}/nope/x` },
    ]);
    expect(danglingRefs([{ site: "workspace-archive", files: [mem], readOnly: true }], home)).toEqual([]);
  });
});
