import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToMailbox } from "../mailbox.js";
import type { TaskRecord, ControlEvent } from "../types.js";

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
});
