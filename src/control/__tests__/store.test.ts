// src/control/__tests__/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store.js";
import type { TaskRecord } from "../types.js";

function rec(id: string): TaskRecord {
  return {
    id, project: "proj", provider: "claude", mode: "headless",
    state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
  };
}

describe("store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-store-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("put then get round-trips a record", () => {
    const s = createStore(dir);
    s.put(rec("t1"));
    expect(s.get("proj", "t1")?.state).toBe("submitted");
  });

  it("get returns undefined for missing task", () => {
    const s = createStore(dir);
    expect(s.get("proj", "nope")).toBeUndefined();
  });

  it("list returns all records for a project", () => {
    const s = createStore(dir);
    s.put(rec("t1")); s.put(rec("t2"));
    expect(s.list("proj").map((r) => r.id).sort()).toEqual(["t1", "t2"]);
  });

  it("a corrupt task file does not break listing of sibling tasks", () => {
    const s = createStore(dir);
    s.put(rec("good"));
    // hand-write a corrupt sibling
    writeFileSync(join(dir, "proj", "bad.json"), "{not json");
    const ids = s.list("proj").map((r) => r.id);
    expect(ids).toContain("good");
    expect(ids).not.toContain("bad");
  });

  it("quarantine() renames a corrupt file out of the way", () => {
    const s = createStore(dir);
    mkdirSync(join(dir, "proj"), { recursive: true });
    writeFileSync(join(dir, "proj", "bad.json"), "{not json");
    s.quarantine("proj", "bad");
    expect(s.get("proj", "bad")).toBeUndefined();
    // listing still works, no throw
    expect(s.list("proj")).toEqual([]);
  });

  it("listAll returns records across multiple projects", () => {
    const s = createStore(dir);
    s.put({ ...rec("t1"), project: "p1" });
    s.put({ ...rec("t2"), project: "p2" });
    expect(s.listAll().map((r) => r.id).sort()).toEqual(["t1", "t2"]);
  });
});
