// packages/web/src/__tests__/log-tail.test.ts
//
// The daemon-log tailer behind the dashboard Logs tab (#519). Uses a real temp
// file — appends are the whole point, and mocking fs would test the mock.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTailer } from "../log-tail.js";

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-log-tail-"));
  log = join(dir, "squadrantd.log");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("LogTailer", () => {
  it("seeds the backlog from existing complete lines and pins the cursor at EOF", () => {
    writeFileSync(log, "one\ntwo\n");
    const t = new LogTailer(log);
    t.init();
    expect(t.backlog()).toEqual(["one", "two"]);
    expect(t.poll()).toEqual([]); // nothing new since init
  });

  it("returns only the lines appended since the last poll", () => {
    writeFileSync(log, "one\n");
    const t = new LogTailer(log);
    t.init();
    appendFileSync(log, "two\nthree\n");
    expect(t.poll()).toEqual(["two", "three"]);
    expect(t.poll()).toEqual([]); // drained
  });

  it("completes a partially-written trailing line without loss or duplication", () => {
    writeFileSync(log, "one\npart");
    const t = new LogTailer(log);
    t.init();
    expect(t.backlog()).toEqual(["one"]); // the partial line is not emitted yet
    appendFileSync(log, "ial\n");
    expect(t.poll()).toEqual(["partial"]);
    expect(t.backlog()).toEqual(["one", "partial"]);
  });

  it("resets cleanly when the log is truncated/rotated", () => {
    writeFileSync(log, "old-1\nold-2\n");
    const t = new LogTailer(log);
    t.init();
    expect(t.backlog()).toEqual(["old-1", "old-2"]);
    writeFileSync(log, "fresh\n"); // truncate + rewrite
    expect(t.poll()).toEqual(["fresh"]);
  });

  it("tolerates a missing log file and picks up lines once it appears", () => {
    const t = new LogTailer(log);
    t.init();
    expect(t.backlog()).toEqual([]);
    expect(t.poll()).toEqual([]);
    writeFileSync(log, "late\n");
    expect(t.poll()).toEqual(["late"]);
  });

  it("bounds the in-memory ring", () => {
    const t = new LogTailer(log, 2);
    writeFileSync(log, "a\n");
    t.init();
    appendFileSync(log, "b\nc\nd\n");
    t.poll();
    expect(t.backlog()).toEqual(["c", "d"]);
  });
});
