import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryClaudeMem, CLAUDE_MEM_RECENCY_LIMIT } from "../handoff-claude-mem.js";

function makeFixtureDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      request TEXT,
      completed TEXT,
      next_steps TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      narrative TEXT,
      facts TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
  `);
  return db;
}

function insertSummary(db: DatabaseSync, row: { project: string; request?: string; completed?: string; nextSteps?: string; createdAt: string; epoch: number }): void {
  db.prepare(
    `INSERT INTO session_summaries (project, request, completed, next_steps, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.project, row.request ?? null, row.completed ?? null, row.nextSteps ?? null, row.createdAt, row.epoch);
}

function insertObservation(db: DatabaseSync, row: { project: string; type: string; title?: string; narrative?: string; facts?: string[]; createdAt: string; epoch: number }): void {
  db.prepare(
    `INSERT INTO observations (project, type, title, narrative, facts, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.project, row.type, row.title ?? null, row.narrative ?? null, row.facts ? JSON.stringify(row.facts) : null, row.createdAt, row.epoch);
}

describe("queryClaudeMem", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-claudemem-"));
    dbPath = path.join(dir, "claude-mem.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the db file does not exist (graceful degradation)", () => {
    const result = queryClaudeMem(path.join(dir, "missing.db"), "squadrant");
    expect(result).toBeNull();
  });

  it("returns empty result (not null) when the db exists but has no rows for the project", () => {
    const db = makeFixtureDb(dbPath);
    insertSummary(db, { project: "other-project", completed: "did stuff", createdAt: "2026-08-01T00:00:00.000Z", epoch: 1 });
    db.close();

    const result = queryClaudeMem(dbPath, "squadrant");

    expect(result).toEqual({ latestSessionSummary: null, recentDecisions: [], oldestCreatedAt: null });
  });

  it("returns the most recent session summary for the project", () => {
    const db = makeFixtureDb(dbPath);
    insertSummary(db, { project: "squadrant", completed: "older work", createdAt: "2026-08-01T00:00:00.000Z", epoch: 1 });
    insertSummary(db, { project: "squadrant", request: "fix the bug", completed: "fixed the bug", nextSteps: "ship it\nwrite tests", createdAt: "2026-08-02T00:00:00.000Z", epoch: 2 });
    db.close();

    const result = queryClaudeMem(dbPath, "squadrant");

    expect(result?.latestSessionSummary).toEqual({
      request: "fix the bug",
      completed: "fixed the bug",
      nextSteps: "ship it\nwrite tests",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
  });

  it("maps decision-type observations, joining facts into the decision text", () => {
    const db = makeFixtureDb(dbPath);
    insertObservation(db, {
      project: "squadrant", type: "decision", title: "Trust order",
      narrative: "long narrative should be ignored when facts present",
      facts: ["live repo wins", "claude-mem is second"],
      createdAt: "2026-08-02T00:00:00.000Z", epoch: 2,
    });
    insertObservation(db, { project: "squadrant", type: "discovery", title: "not a decision", createdAt: "2026-08-02T00:00:00.000Z", epoch: 2 });
    db.close();

    const result = queryClaudeMem(dbPath, "squadrant");

    expect(result?.recentDecisions).toEqual([
      { title: "Trust order", text: "live repo wins; claude-mem is second", createdAt: "2026-08-02T00:00:00.000Z" },
    ]);
  });

  it("falls back to narrative when a decision has no facts", () => {
    const db = makeFixtureDb(dbPath);
    insertObservation(db, { project: "squadrant", type: "decision", title: "T", narrative: "the narrative text", createdAt: "2026-08-02T00:00:00.000Z", epoch: 2 });
    db.close();

    const result = queryClaudeMem(dbPath, "squadrant");

    expect(result?.recentDecisions).toEqual([{ title: "T", text: "the narrative text", createdAt: "2026-08-02T00:00:00.000Z" }]);
  });

  it("caps decisions at CLAUDE_MEM_RECENCY_LIMIT, newest first", () => {
    const db = makeFixtureDb(dbPath);
    for (let i = 0; i < CLAUDE_MEM_RECENCY_LIMIT + 5; i++) {
      insertObservation(db, {
        project: "squadrant", type: "decision", title: `D${i}`, facts: [`fact ${i}`],
        createdAt: `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`, epoch: i,
      });
    }
    db.close();

    const result = queryClaudeMem(dbPath, "squadrant");

    expect(result?.recentDecisions).toHaveLength(CLAUDE_MEM_RECENCY_LIMIT);
    expect(result?.recentDecisions[0].title).toBe(`D${CLAUDE_MEM_RECENCY_LIMIT + 4}`);
  });

  it("computes oldestCreatedAt across the summary and considered decisions", () => {
    const db = makeFixtureDb(dbPath);
    insertSummary(db, { project: "squadrant", completed: "x", createdAt: "2026-08-02T00:00:00.000Z", epoch: 2 });
    insertObservation(db, { project: "squadrant", type: "decision", title: "D", facts: ["f"], createdAt: "2026-08-01T00:00:00.000Z", epoch: 1 });
    db.close();

    const result = queryClaudeMem(dbPath, "squadrant");

    expect(result?.oldestCreatedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});
