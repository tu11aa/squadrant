import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToMailbox } from "../mailbox.js";
import { readCursor, writeCursor } from "../mailbox.js";
import { readFromCursor } from "../mailbox.js";
import { rotateIfNeeded, mailboxStats } from "../mailbox.js";
import { statSync } from "node:fs";
import type { TaskRecord, ControlEvent } from "@squadrant/shared";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "mbox-"));
}

const sampleRecord: TaskRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  project: "demo",
  provider: "claude",
  mode: "interactive",
  state: "working",
  task: "smoke test task description",
  cwd: "/tmp",
  createdAt: 1000,
  lastHeartbeat: 1000,
  lastEvent: "task.progress",
  heartbeatBudgetMs: 60000,
  attempts: [],
};

const doneEvent: ControlEvent = {
  type: "task.done",
  id: sampleRecord.id,
  resultRef: "/tmp/result.txt",
};

describe("appendToMailbox", () => {
  it("creates inbox/<project>.log on first append and assigns seq=1", async () => {
    const stateRoot = freshState();
    const seq = await appendToMailbox({
      stateRoot,
      project: "demo",
      taskRecord: sampleRecord,
      event: doneEvent,
    });
    expect(seq).toBe(1);
    const logPath = join(stateRoot, "inbox", "demo.log");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.seq).toBe(1);
    expect(entry.taskId).toBe(sampleRecord.id);
    expect(entry.kind).toBe("task.done");
    expect(entry.provider).toBe("claude");
    expect(entry.payload.resultRef).toBe("/tmp/result.txt");
    expect(typeof entry.ts).toBe("string");
  });

  it("persists the daemon-rendered message verbatim on the entry (unified-formatter)", async () => {
    const stateRoot = freshState();
    await appendToMailbox({
      stateRoot,
      project: "demo",
      taskRecord: sampleRecord,
      event: doneEvent,
      message: "CREW DONE [claude/abc]: shipped it",
    });
    const logPath = join(stateRoot, "inbox", "demo.log");
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.message).toBe("CREW DONE [claude/abc]: shipped it");
  });

  it("stores message:null when the daemon passes no message", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const logPath = join(stateRoot, "inbox", "demo.log");
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.message).toBeNull();
  });

  it("assigns monotonically increasing seq on subsequent appends", async () => {
    const stateRoot = freshState();
    const s1 = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const s2 = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const s3 = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    expect([s1, s2, s3]).toEqual([1, 2, 3]);
  });

  it("isolates seq per project", async () => {
    const stateRoot = freshState();
    const a = await appendToMailbox({ stateRoot, project: "a", taskRecord: sampleRecord, event: doneEvent });
    const b = await appendToMailbox({ stateRoot, project: "b", taskRecord: sampleRecord, event: doneEvent });
    const a2 = await appendToMailbox({ stateRoot, project: "a", taskRecord: sampleRecord, event: doneEvent });
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(a2).toBe(2);
  });

  it("resumes seq from max in file after daemon restart simulation", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const s3 = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    expect(s3).toBe(3);
  });

  it("assigns unique monotonic seq under concurrent appends (no TOCTOU race)", async () => {
    const stateRoot = freshState();
    // Fire 20 concurrent appends; with a TOCTOU race some would get duplicate seqs
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent })
      )
    );
    // All seqs unique, exactly 1..20
    const sorted = [...results].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // File has exactly 20 lines, all parseable, with seqs 1..20
    const logPath = join(stateRoot, "inbox", "demo.log");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(20);
    const seqs = lines.map((l) => JSON.parse(l).seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe("cursor read/write", () => {
  it("readCursor returns null when file does not exist", async () => {
    const stateRoot = freshState();
    const c = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(c).toBeNull();
  });

  it("writeCursor then readCursor round-trips lastAckedSeq", async () => {
    const stateRoot = freshState();
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 42 });
    const c = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(c?.lastAckedSeq).toBe(42);
  });

  it("writeCursor uses atomic rename (no leftover .tmp file)", async () => {
    const stateRoot = freshState();
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 1 });
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 2 });
    const c = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(c?.lastAckedSeq).toBe(2);
    const tmpExists = existsSync(join(stateRoot, "inbox", "demo.captain.cursor.tmp"));
    expect(tmpExists).toBe(false);
  });

  it("isolates cursors per subscriber", async () => {
    const stateRoot = freshState();
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 10 });
    await writeCursor({ stateRoot, project: "demo", subscriber: "telegram", lastAckedSeq: 5 });
    const cap = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    const tg = await readCursor({ stateRoot, project: "demo", subscriber: "telegram" });
    expect(cap?.lastAckedSeq).toBe(10);
    expect(tg?.lastAckedSeq).toBe(5);
  });

  // BUG 1 (#332 storm): a 0-byte or corrupt cursor file must not throw — it
  // would crash the relay boot / delivery loop. Treat it like a missing file.
  it("readCursor returns null on an empty (0-byte) cursor file instead of throwing", async () => {
    const stateRoot = freshState();
    const inbox = join(stateRoot, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "demo.captain.cursor"), "");
    const c = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(c).toBeNull();
  });

  it("readCursor returns null on a corrupt (unparseable) cursor file instead of throwing", async () => {
    const stateRoot = freshState();
    const inbox = join(stateRoot, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "demo.captain.cursor"), "{not valid json");
    const c = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(c).toBeNull();
  });

  // BUG 2 (#332 storm): overlapping writeCursor calls used a SHARED tmp path,
  // so one rename consumed the tmp the other expected → ENOENT, leaving a
  // 0-byte/corrupt cursor. Concurrent writes must all succeed and leave a
  // valid cursor with no leftover tmp files.
  it("writeCursor survives concurrent overlapping writes (no shared-tmp rename race)", async () => {
    const stateRoot = freshState();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: i + 1 })
      )
    );
    const c = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(c).not.toBeNull();
    expect(c!.lastAckedSeq).toBeGreaterThanOrEqual(1);
    // No leftover unique-tmp files accumulated.
    const inbox = join(stateRoot, "inbox");
    const leftovers = readdirSync(inbox).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("readFromCursor", () => {
  it("returns empty iterable when file does not exist", async () => {
    const stateRoot = freshState();
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 1 }));
    expect(items).toEqual([]);
  });

  it("returns all entries with seq >= fromSeq", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 2 }));
    expect(items.map((i) => i.seq)).toEqual([2, 3]);
  });

  it("skips entries with seq < fromSeq", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 100 }));
    expect(items).toEqual([]);
  });

  it("tolerates a partial last line (mid-write crash)", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const file = join(stateRoot, "inbox", "demo.log");
    await (await import("node:fs/promises")).appendFile(file, '{"seq":2,"ts":"2026', "utf-8");
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 1 }));
    expect(items.map((i) => i.seq)).toEqual([1]);
  });
});

describe("rotateIfNeeded", () => {
  it("returns rotated=false when file under thresholds", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const r = await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 1024 * 1024, maxAgeMs: 24 * 60 * 60 * 1000, keepCount: 3 });
    expect(r.rotated).toBe(false);
  });

  it("rotates when size exceeds maxBytes", async () => {
    const stateRoot = freshState();
    for (let i = 0; i < 10; i++) {
      await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    }
    const sizeBefore = statSync(join(stateRoot, "inbox", "demo.log")).size;
    expect(sizeBefore).toBeGreaterThan(200);
    const r = await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 200, maxAgeMs: 999999999, keepCount: 3 });
    expect(r.rotated).toBe(true);
    expect(existsSync(join(stateRoot, "inbox", "demo.log.1"))).toBe(true);
    expect(statSync(join(stateRoot, "inbox", "demo.log")).size).toBe(0);
  });

  it("seq is monotonic across rotation boundary", async () => {
    const stateRoot = freshState();
    for (let i = 0; i < 10; i++) {
      await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    }
    await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 200, maxAgeMs: 999999999, keepCount: 3 });
    const s = await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    expect(s).toBe(11);
  });

  it("keeps only keepCount rotated files", async () => {
    const stateRoot = freshState();
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 5; i++) {
        await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
      }
      await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 100, maxAgeMs: 999999999, keepCount: 2 });
    }
    expect(existsSync(join(stateRoot, "inbox", "demo.log.1"))).toBe(true);
    expect(existsSync(join(stateRoot, "inbox", "demo.log.2"))).toBe(true);
    expect(existsSync(join(stateRoot, "inbox", "demo.log.3"))).toBe(false);
  });

  it("readFromCursor reads across rotated files", async () => {
    const stateRoot = freshState();
    for (let i = 0; i < 5; i++) {
      await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    }
    await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 50, maxAgeMs: 999999999, keepCount: 3 });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const items = await collect(readFromCursor({ stateRoot, project: "demo", fromSeq: 1 }));
    expect(items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("mailboxStats", () => {
  it("returns zeros for a project with no mailbox", async () => {
    const stateRoot = freshState();
    expect(await mailboxStats(stateRoot, "demo")).toEqual({
      maxSeq: 0,
      sizeBytes: 0,
      oldestEntryAgeMs: 0,
      rotationCount: 0,
    });
  });

  it("reports maxSeq, a positive size and zero rotations for a live mailbox", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const stats = await mailboxStats(stateRoot, "demo");
    expect(stats.maxSeq).toBe(2);
    expect(stats.sizeBytes).toBeGreaterThan(0);
    expect(stats.rotationCount).toBe(0);
    expect(stats.oldestEntryAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("counts rotated segments and keeps maxSeq across them", async () => {
    const stateRoot = freshState();
    for (let i = 0; i < 5; i++) {
      await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    }
    await rotateIfNeeded({ stateRoot, project: "demo", maxBytes: 50, maxAgeMs: 999999999, keepCount: 3 });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: sampleRecord, event: doneEvent });
    const stats = await mailboxStats(stateRoot, "demo");
    expect(stats.rotationCount).toBe(1);
    expect(stats.maxSeq).toBe(6);
  });
});
