import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SquadrantConfig } from "@squadrant/shared";
import { migrateKb, type MigrateKbEntry } from "../migrate-kb.js";

// #983 6b: `squadrant migrate kb` on a fixture home — the KB spec §10 path-move table.
// Everything lives under a temp dir; the env points workspace + archive roots there too.
describe("migrateKb (#983)", () => {
  let tmp: string;
  let hub: string;
  let ws: string;
  let archive: string;
  let configDir: string;
  let cfg: SquadrantConfig;
  const saved = { ws: process.env.SQUADRANT_WORKSPACE_DIR, ar: process.env.SQUADRANT_ARCHIVE_DIR };
  const opts = (dryRun: boolean) => ({ dryRun, configDir, today: "2026-10-15" });

  const put = (p: string, body = path.basename(p)) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  /** path -> content for every file under tmp (the KB's git internals excluded: `git init` is not operator data). */
  const snapshot = () => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== ".git") walk(full); } else out[path.relative(tmp, full)] = fs.readFileSync(full, "utf8");
      }
    };
    walk(tmp);
    return out;
  };
  const done = (rows: MigrateKbEntry[]) => rows.filter((r) => ["moved", "copied", "archived"].includes(r.action));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-migrate-kb-"));
    hub = path.join(tmp, "squadrant-hub");
    ws = path.join(tmp, "workspace");
    archive = path.join(tmp, "archive");
    configDir = path.join(tmp, ".config", "squadrant");
    process.env.SQUADRANT_WORKSPACE_DIR = ws;
    process.env.SQUADRANT_ARCHIVE_DIR = archive;

    // hub-level: archived per §10 (dashboard.md is not in the table: untouched)
    put(path.join(hub, "CLAUDE.md"));
    put(path.join(hub, "dashboard.md"));
    put(path.join(hub, "projects", "alpha.md"));
    put(path.join(hub, "projects", "notes.txt"));
    put(path.join(hub, "daily-logs", "2026-10-01.md"));
    put(path.join(hub, "wiki", "index.md"));
    put(path.join(hub, "wiki", "log.md"));
    put(path.join(hub, "wiki", "pages", ".gitkeep"), "");
    put(path.join(hub, "learnings", "real-learning.md")); // has content: left for phase 4b
    put(path.join(hub, "knowledge", "saitex", "rules", "coding.md")); // legacy KB (#936 fold-in)

    // spoke: exchange + artifacts move, learnings stay
    const spoke = path.join(hub, "spokes", "alpha");
    put(path.join(spoke, "handoff.json"), "{}");
    put(path.join(spoke, "captain-sessions.jsonl"), '{"sessionId":"old"}\n');
    put(path.join(spoke, "handoffs", "2026-10-01.json"), "old-1");
    put(path.join(spoke, "handoffs", "2026-10-02.json"), "old-2");
    put(path.join(spoke, "side-handoffs", "topic.md"));
    put(path.join(spoke, "reports", "r1.md"));
    put(path.join(spoke, "daily-logs", "2026-10-02.md"));
    put(path.join(spoke, "artifacts", "2026-10-12-x.md"));
    put(path.join(spoke, "learnings", "l1.md"));

    // a captain already ran on the new version: workspace has a registry and a same-name archive
    put(path.join(ws, "alpha", "captain-sessions.jsonl"), '{"sessionId":"new"}\n');
    put(path.join(ws, "alpha", "handoffs", "2026-10-01.json"), "new-1");

    // ~/.config state: moves in 6a, reported as pending here
    put(path.join(configDir, "config.json"), "{}");
    put(path.join(configDir, "daemon.db"));
    put(path.join(configDir, "squadrantd.log"));

    cfg = {
      hubVault: hub,
      projects: { alpha: { path: path.join(tmp, "repo"), captainName: "a", spokeVault: spoke, host: "local" } },
      knowledgeBases: { saitex: { path: path.join(tmp, "kb", "saitex") } },
    } as unknown as SquadrantConfig;
  });

  afterEach(() => {
    process.env.SQUADRANT_WORKSPACE_DIR = saved.ws;
    process.env.SQUADRANT_ARCHIVE_DIR = saved.ar;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("--dry-run prints the full move/archive report and changes nothing", () => {
    const before = snapshot();
    const rows = migrateKb(cfg, opts(true));
    expect(snapshot()).toEqual(before);

    const spoke = path.join(hub, "spokes", "alpha");
    const day = path.join(archive, "2026-10-15");
    const row = (from: string) => rows.find((r) => r.from === from);
    expect(row(path.join(spoke, "handoff.json"))).toMatchObject({ action: "would-move", to: path.join(ws, "alpha", "handoff.json") });
    expect(row(path.join(spoke, "captain-sessions.jsonl"))).toMatchObject({ action: "would-move", note: expect.stringContaining("merge") });
    expect(row(path.join(spoke, "handoffs"))).toMatchObject({ action: "would-move", to: path.join(ws, "alpha", "handoffs"), note: "1 file" });
    expect(row(path.join(spoke, "handoffs", "2026-10-01.json"))).toMatchObject({ action: "skipped" });
    expect(row(path.join(spoke, "side-handoffs"))).toMatchObject({ action: "would-move", to: path.join(ws, "alpha", "side-handoffs") });
    expect(row(path.join(spoke, "reports"))).toMatchObject({ action: "would-move", to: path.join(ws, "alpha", "artifacts", "reports") });
    expect(row(path.join(spoke, "daily-logs"))).toMatchObject({ action: "would-move", to: path.join(ws, "alpha", "artifacts", "daily-logs") });
    expect(row(path.join(spoke, "artifacts"))).toMatchObject({ action: "would-move", to: path.join(ws, "alpha", "artifacts") });
    expect(row(path.join(hub, "CLAUDE.md"))).toMatchObject({ action: "would-archive", to: path.join(day, "hub", "CLAUDE.md") });
    expect(row(path.join(hub, "projects"))).toMatchObject({ action: "would-archive", note: "1 file" });
    expect(row(path.join(hub, "daily-logs"))).toMatchObject({ action: "would-archive" });
    expect(row(path.join(hub, "wiki"))).toMatchObject({ action: "would-archive", note: "3 files" });
    expect(row(path.join(hub, "learnings"))).toMatchObject({ action: "skipped" });
    expect(rows.find((r) => r.kb === "state")).toMatchObject({ action: "pending", note: expect.stringContaining("6a") });
    expect(rows.find((r) => r.kb === "saitex")).toMatchObject({ action: "would-move" });
    expect(rows.some((r) => r.from.includes("learnings") && r.from.includes("spokes"))).toBe(false);
  });

  it("the real run does everything the dry run listed, deletes nothing, and a second run is a no-op", () => {
    const before = snapshot();
    const planned = migrateKb(cfg, opts(true));
    const rows = migrateKb(cfg, opts(false));

    // every planned move/archive happened, at the same from -> to
    const key = (r: MigrateKbEntry) => `${r.kb}|${r.from}|${r.to}`;
    expect(done(rows).map(key).sort()).toEqual(planned.filter((r) => r.action.startsWith("would-")).map(key).sort());

    const after = snapshot();
    const kbExtras = Object.keys(after).filter((p) => p === path.join("kb", "saitex", ".gitignore"));
    expect(Object.keys(after).length - kbExtras.length).toBe(Object.keys(before).length); // nothing deleted

    const spoke = path.join(hub, "spokes", "alpha");
    expect(fs.readFileSync(path.join(ws, "alpha", "handoffs", "2026-10-01.json"), "utf8")).toBe("new-1"); // never overwritten
    expect(fs.readFileSync(path.join(spoke, "handoffs", "2026-10-01.json"), "utf8")).toBe("old-1"); // conflict left in place
    expect(fs.readFileSync(path.join(ws, "alpha", "handoffs", "2026-10-02.json"), "utf8")).toBe("old-2");
    expect(fs.readFileSync(path.join(ws, "alpha", "captain-sessions.jsonl"), "utf8").split("\n").filter(Boolean).sort())
      .toEqual(['{"sessionId":"new"}', '{"sessionId":"old"}']);
    expect(fs.existsSync(path.join(archive, "2026-10-15", "spokes", "alpha", "captain-sessions.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "alpha", "artifacts", "reports", "r1.md"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "alpha", "artifacts", "daily-logs", "2026-10-02.md"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "alpha", "artifacts", "2026-10-12-x.md"))).toBe(true);
    expect(fs.existsSync(path.join(archive, "2026-10-15", "hub", "wiki", "pages", ".gitkeep"))).toBe(true);
    expect(fs.existsSync(path.join(spoke, "learnings", "l1.md"))).toBe(true);
    expect(fs.existsSync(path.join(hub, "dashboard.md"))).toBe(true);
    expect(fs.existsSync(path.join(hub, "projects", "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(configDir, "daemon.db"))).toBe(true);

    const settled = snapshot();
    const again = migrateKb(cfg, opts(false));
    expect(done(again)).toEqual([]);
    expect(again.filter((r) => r.action.startsWith("would-"))).toEqual([]);
    expect(snapshot()).toEqual(settled);
  });

  it("is a no-op on a home with nothing to migrate", () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    expect(migrateKb(cfg, opts(false))).toEqual([]);
  });
});
