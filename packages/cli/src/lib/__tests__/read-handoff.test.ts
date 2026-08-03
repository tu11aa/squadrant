import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Exercises the real shell script (not a mock) — this is the compatibility
// contract #650 depends on: stdout must stay byte-identical for every
// existing caller while the destructive `rm` becomes a non-destructive
// archive.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../../../../scripts/read-handoff.sh");

function run(vault: string, ...args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("bash", [SCRIPT, vault, ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

describe("read-handoff.sh", () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-handoff-"));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it("prints the exact not-exists sentinel when no handoff.json exists", () => {
    const { stdout } = run(vault);
    expect(stdout).toBe('{"exists": false}\n');
  });

  it("prints the handoff content byte-identically when it exists", () => {
    const content = '{"written_at": "2026-08-03T00:00:00+00:00", "session": {"a": 1}}';
    fs.writeFileSync(path.join(vault, "handoff.json"), content);

    const { stdout } = run(vault);

    expect(stdout).toBe(content);
  });

  it("archives (does not delete) the handoff after a default read", () => {
    const content = '{"written_at": "2026-08-03T00:00:00+00:00", "session": {"a": 1}}';
    fs.writeFileSync(path.join(vault, "handoff.json"), content);

    run(vault);

    expect(fs.existsSync(path.join(vault, "handoff.json"))).toBe(false);

    const archiveDir = path.join(vault, "handoffs");
    expect(fs.existsSync(archiveDir)).toBe(true);
    const archived = fs.readdirSync(archiveDir);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.json$/);
    expect(fs.readFileSync(path.join(archiveDir, archived[0]), "utf8")).toBe(content);
  });

  it("keeps the handoff in place and does not archive when --keep is passed", () => {
    const content = '{"written_at": "2026-08-03T00:00:00+00:00", "session": {"a": 1}}';
    fs.writeFileSync(path.join(vault, "handoff.json"), content);

    run(vault, "--keep");

    expect(fs.readFileSync(path.join(vault, "handoff.json"), "utf8")).toBe(content);
    expect(fs.existsSync(path.join(vault, "handoffs"))).toBe(false);
  });

  it("creates the handoffs/ archive directory when it does not yet exist", () => {
    fs.writeFileSync(path.join(vault, "handoff.json"), "{}");
    expect(fs.existsSync(path.join(vault, "handoffs"))).toBe(false);

    run(vault);

    expect(fs.existsSync(path.join(vault, "handoffs"))).toBe(true);
  });

  // Multi-session days (compacts, relaunches) are the norm, not the
  // exception — a second same-day read must never clobber the first
  // archive. That would silently destroy exactly what #650 exists to
  // preserve, just moved one layer down from read-handoff's old `rm`.
  it("does not clobber a same-day archive on a second read — both survive", () => {
    const first = '{"written_at": "2026-08-03T08:00:00+00:00", "session": {"a": 1}}';
    fs.writeFileSync(path.join(vault, "handoff.json"), first);
    run(vault);

    const second = '{"written_at": "2026-08-03T16:00:00+00:00", "session": {"a": 2}}';
    fs.writeFileSync(path.join(vault, "handoff.json"), second);
    run(vault);

    const archiveDir = path.join(vault, "handoffs");
    const archived = fs.readdirSync(archiveDir);
    expect(archived).toHaveLength(2);
    const contents = archived
      .map((f) => fs.readFileSync(path.join(archiveDir, f), "utf8"))
      .sort();
    expect(contents).toEqual([first, second].sort());
  });
});
