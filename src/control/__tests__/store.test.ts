// src/control/__tests__/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@cockpit/core";
import type { TaskRecord } from "@cockpit/shared";

function rec(id: string): TaskRecord {
  return {
    id, project: "proj", provider: "claude", mode: "headless",
    state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
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

  // Red-team #1 (Critical): project/id are attacker-controlled via the socket.
  // Every fs op must reject path-escaping segments and write nothing outside root.
  describe("path-traversal hardening", () => {
    const evil = ["..", "../../etc", "/abs/path", ".", "a/b", "a\\b", "x\0y", ""];

    for (const bad of evil) {
      it(`put rejects malicious project ${JSON.stringify(bad)} and writes nothing`, () => {
        const s = createStore(dir);
        const before = readdirSync(dir).sort();
        expect(() => s.put({ ...rec("t1"), project: bad })).toThrow(/invalid project|escapes state root/);
        expect(readdirSync(dir).sort()).toEqual(before); // no fs mutation
      });

      it(`put rejects malicious id ${JSON.stringify(bad)}`, () => {
        const s = createStore(dir);
        expect(() => s.put({ ...rec(bad), project: "proj" })).toThrow(/invalid id|escapes state root/);
      });

      it(`get/list/quarantine reject malicious project ${JSON.stringify(bad)}`, () => {
        const s = createStore(dir);
        expect(() => s.get(bad, "t1")).toThrow(/invalid project|escapes state root/);
        expect(() => s.list(bad)).toThrow(/invalid project|escapes state root/);
        expect(() => s.quarantine(bad, "t1")).toThrow(/invalid project|escapes state root/);
      });
    }

    it("a crafted ../ id cannot read a file outside the state root", () => {
      const s = createStore(dir);
      const secret = join(tmpdir(), `cp-secret-${Date.now()}.json`);
      writeFileSync(secret, JSON.stringify({ id: "leaked" }));
      try {
        // attempt to traverse out and read the secret as a "task"
        expect(() => s.get("proj", `../../../../../../..${secret.replace(/\.json$/, "")}`))
          .toThrow(/invalid id|escapes state root/);
      } finally {
        rmSync(secret, { force: true });
      }
    });

    it("legitimate uuid id + hyphenated project still work", () => {
      const s = createStore(dir);
      const id = "3f1b9c2a-0d4e-4a8b-9c1d-2e3f4a5b6c7d";
      s.put({ ...rec(id), project: "scaffold-stark" });
      expect(s.get("scaffold-stark", id)?.id).toBe(id);
    });
  });
});
