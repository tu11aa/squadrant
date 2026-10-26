import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "@squadrant/shared";
import { taskTitle, readTaskBrief, readTaskBriefSync, firstTurnResendMessage, TASK_TITLE_MAX_CHARS } from "../task-brief.js";
import { writeInitPrompt } from "../first-turn-init.js";
import { appendDispatchEntry } from "../mailbox.js";

const root = () => mkdtempSync(join(tmpdir(), "task-brief-"));
const BRIEF = "## Objective\nDo the thing\n\n- (a) $HOME `x` ===\n";

const rec = (o: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "t1", project: "p", provider: "claude", mode: "interactive", state: "working",
  task: "## Objective", createdAt: 1, lastHeartbeat: 1, lastEvent: "dispatch", heartbeatBudgetMs: 1000,
  attempts: [], ...o,
} as TaskRecord);

describe("taskTitle", () => {
  it("is the first non-empty line, trimmed", () => {
    expect(taskTitle("\n\n  Fix the bug  \nmore")).toBe("Fix the bug");
  });
  it("skips headings and rules in a structured (Template-M) brief", () => {
    const m = "## Objective\nBuild the first-turn title fix\n\n---\n## Steps\n- one\n";
    expect(taskTitle(m)).toBe("Build the first-turn title fix");
    expect(taskTitle("---\n\n- Do it now\n")).toBe("Do it now");
  });
  it("falls back to the heading text when nothing else is left", () => {
    expect(taskTitle("## Objective\n---\n")).toBe("Objective");
  });
  it("caps at TASK_TITLE_MAX_CHARS", () => {
    expect(taskTitle("x".repeat(500))).toHaveLength(TASK_TITLE_MAX_CHARS);
  });
  it("is idempotent, and safe on empty input", () => {
    expect(taskTitle(taskTitle(BRIEF))).toBe(taskTitle(BRIEF));
    expect(taskTitle("")).toBe("");
    expect(taskTitle(undefined)).toBe("");
  });
});

describe("readTaskBrief", () => {
  it("prefers brief.md", async () => {
    const r = root();
    writeInitPrompt({ stateRoot: r, project: "p", taskId: "t1", brief: BRIEF, fromFile: true, completionProtocol: "P" });
    expect(await readTaskBrief(r, rec({ briefSeq: 9 }))).toEqual({ text: BRIEF, source: "brief-file" });
    expect(readTaskBriefSync(r, rec())).toBe(BRIEF);
  });

  it("falls back to the task.dispatched entry (briefSeq) when brief.md is missing", async () => {
    const r = root();
    const seq = await appendDispatchEntry({ stateRoot: r, project: "p", taskRecord: rec({ task: BRIEF }) });
    expect(await readTaskBrief(r, rec({ briefSeq: seq }))).toEqual({ text: BRIEF, source: "mailbox" });
  });

  it("ignores a dispatch entry that belongs to another task", async () => {
    const r = root();
    const seq = await appendDispatchEntry({ stateRoot: r, project: "p", taskRecord: rec({ id: "other", task: BRIEF }) });
    expect((await readTaskBrief(r, rec({ briefSeq: seq }))).source).toBe("record");
  });

  it("an old record that holds the full text keeps working (no brief.md, no briefSeq)", async () => {
    expect(await readTaskBrief(root(), rec({ task: BRIEF }))).toEqual({ text: BRIEF, source: "record" });
    expect(readTaskBriefSync(root(), rec({ task: BRIEF }))).toBe(BRIEF);
  });

  it("last resort is the record's title, reported as source 'record'", async () => {
    expect(await readTaskBrief(root(), rec({ briefSeq: 404 }))).toEqual({ text: "## Objective", source: "record" });
  });
});

describe("firstTurnResendMessage (#466 self-heal)", () => {
  it("resends the launched init.md when it exists", async () => {
    const r = root();
    const w = writeInitPrompt({ stateRoot: r, project: "p", taskId: "t1", brief: BRIEF, fromFile: true, completionProtocol: "PROTO" });
    expect(await firstTurnResendMessage(r, rec())).toBe(w.initText);
  });

  it("without init.md, frames the brief from the dispatch entry (record holds only a title)", async () => {
    const r = root();
    const seq = await appendDispatchEntry({ stateRoot: r, project: "p", taskRecord: rec({ task: BRIEF }) });
    const msg = await firstTurnResendMessage(r, rec({ briefSeq: seq }));
    expect(msg).toContain(BRIEF);
    expect(msg).toContain("COMPLETION PROTOCOL");
  });

  it("an old full-text record is resent whole", async () => {
    const msg = await firstTurnResendMessage(root(), rec({ task: BRIEF }));
    expect(msg).toContain(BRIEF);
  });
});
