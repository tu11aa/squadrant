import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readNewestArchivedHandoff } from "../handoff-archive.js";

const NOW = Date.parse("2026-08-03T16:00:00.000Z");

// The newest archived handoff is the CHECKPOINT — it already covers history
// up to the moment it was written, so it's read in full with no window
// bound (an old checkpoint is still a valid baseline; it just means the gap
// of unread sessions since it will be correspondingly larger).
describe("readNewestArchivedHandoff", () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-archive-"));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it("returns null when there is no handoffs/ directory", () => {
    expect(readNewestArchivedHandoff(vault, NOW)).toBeNull();
  });

  it("returns null when handoffs/ exists but is empty", () => {
    fs.mkdirSync(path.join(vault, "handoffs"));
    expect(readNewestArchivedHandoff(vault, NOW)).toBeNull();
  });

  it("picks the newest archived handoff by mtime when several exist", () => {
    const dir = path.join(vault, "handoffs");
    fs.mkdirSync(dir);
    const older = path.join(dir, "2026-08-01.json");
    const newer = path.join(dir, "2026-08-02.json");
    fs.writeFileSync(older, JSON.stringify({ session: { currentState: "older" } }));
    fs.writeFileSync(newer, JSON.stringify({ session: { currentState: "newer" } }));
    fs.utimesSync(older, new Date(NOW - 2 * 86_400_000), new Date(NOW - 2 * 86_400_000));
    fs.utimesSync(newer, new Date(NOW - 1 * 86_400_000), new Date(NOW - 1 * 86_400_000));

    const out = readNewestArchivedHandoff(vault, NOW);

    expect(out?.filename).toBe("2026-08-02.json");
  });

  it("returns an old checkpoint too — no recency bound, it's still the baseline", () => {
    const dir = path.join(vault, "handoffs");
    fs.mkdirSync(dir);
    const ancient = path.join(dir, "2026-01-01.json");
    fs.writeFileSync(ancient, JSON.stringify({}));
    fs.utimesSync(ancient, new Date(NOW - 200 * 86_400_000), new Date(NOW - 200 * 86_400_000));

    expect(readNewestArchivedHandoff(vault, NOW)?.filename).toBe("2026-01-01.json");
  });

  it("reports filename/path/ageMs and the raw untouched content", () => {
    const dir = path.join(vault, "handoffs");
    fs.mkdirSync(dir);
    const content = { written_at: "2026-08-01T00:00:00.000Z", session: { currentState: "mid-flight" } };
    const file = path.join(dir, "2026-08-01.json");
    fs.writeFileSync(file, JSON.stringify(content));
    const mtime = new Date(NOW - 6 * 60 * 60 * 1000);
    fs.utimesSync(file, mtime, mtime);

    const out = readNewestArchivedHandoff(vault, NOW);

    expect(out?.filename).toBe("2026-08-01.json");
    expect(out?.path).toBe(file);
    expect(out?.ageMs).toBe(6 * 60 * 60 * 1000);
    expect(out?.content).toEqual(content);
  });

  it("skips a corrupt newest file and falls back to the next-newest valid one", () => {
    const dir = path.join(vault, "handoffs");
    fs.mkdirSync(dir);
    const corrupt = path.join(dir, "2026-08-02.json");
    const valid = path.join(dir, "2026-08-01.json");
    fs.writeFileSync(corrupt, "{not valid json");
    fs.writeFileSync(valid, JSON.stringify({ ok: true }));
    fs.utimesSync(corrupt, new Date(NOW - 1 * 86_400_000), new Date(NOW - 1 * 86_400_000));
    fs.utimesSync(valid, new Date(NOW - 2 * 86_400_000), new Date(NOW - 2 * 86_400_000));

    expect(readNewestArchivedHandoff(vault, NOW)?.filename).toBe("2026-08-01.json");
  });

  it("ignores non-.json files in handoffs/", () => {
    const dir = path.join(vault, "handoffs");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
    expect(readNewestArchivedHandoff(vault, NOW)).toBeNull();
  });
});
