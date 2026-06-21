import { describe, it, expect } from "vitest";
import { tailLines, formatTaskLine, filterTasks, formatCompactTasks } from "../crew-output.js";
import type { TaskRecord, TaskState } from "@squadrant/shared";

// ─── tailLines ───────────────────────────────────────────────────

describe("tailLines", () => {
  it("returns input unchanged when fewer lines than max", () => {
    const text = "line1\nline2\nline3";
    expect(tailLines(text, 10, 4096)).toBe(text);
  });

  it("returns last N lines when more lines than max", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    expect(tailLines(text, 3, 4096)).toBe("line3\nline4\nline5");
  });

  it("returns last N lines when equal to max", () => {
    const text = "line1\nline2\nline3";
    expect(tailLines(text, 3, 4096)).toBe(text);
  });

  it("respects byte cap (truncates at boundary)", () => {
    const text = "a\nb\nc\nd\ne";
    // Cap 5 bytes: last 5 bytes of the tail is "d\ne" (3 bytes) but
    // we need to ensure the full last lines fit.
    const result = tailLines(text, 100, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("returns empty string for empty input", () => {
    expect(tailLines("", 40, 4096)).toBe("");
  });

  it("handles single line text", () => {
    expect(tailLines("hello", 40, 4096)).toBe("hello");
  });

  it("handles trailing newline gracefully", () => {
    const text = "a\nb\nc\n";
    expect(tailLines(text, 2, 4096)).toBe("b\nc");
  });

  it("defaults to 40 lines and 4096 bytes", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(`line-${i}`);
    const text = lines.join("\n");
    const result = tailLines(text);
    expect(result.split("\n").length).toBe(40);
    expect(result).toBe(lines.slice(10).join("\n"));
  });
});

// ─── formatTaskLine ──────────────────────────────────────────────

describe("formatTaskLine", () => {
  const base = {
    id: "abc12345-def6-7890-abcd-ef1234567890",
    name: "my-crew",
    project: "testproj",
    provider: "claude" as const,
    mode: "interactive" as const,
    state: "working" as TaskState,
    task: "Implement the feature",
    createdAt: 1000,
    lastHeartbeat: 2000,
    lastEvent: "task.started",
    heartbeatBudgetMs: 300000,
    attempts: [{ attemptId: "att1", startedAt: 1000, lastHeartbeatAt: 1500 }],
  } satisfies TaskRecord;

  it("includes short id, provider, state, lastEvent and truncated title", () => {
    const line = formatTaskLine(base);
    expect(line).toContain("abc12345");
    expect(line).toContain("claude");
    expect(line).toContain("working");
    expect(line).toContain("Implem");
  });

  it("truncates task title to ~60 chars", () => {
    const long = "A".repeat(200);
    const record = { ...base, task: long };
    const line = formatTaskLine(record);
    // Should contain the truncated title (first line, ~60 chars)
    expect(line.length).toBeLessThan(200);
    expect(line).toContain("A".repeat(60));
  });

  it("collapses multi-line task to first line only", () => {
    const record = { ...base, task: "first line\nsecond line\nthird line" };
    const line = formatTaskLine(record);
    expect(line).toContain("first line");
    expect(line).not.toContain("second line");
    expect(line).not.toContain("third line");
  });

  it("produces a single-line output", () => {
    const line = formatTaskLine(base);
    expect(line).not.toContain("\n");
  });

  it("handles missing name gracefully", () => {
    const record = { ...base, task: "task" };
    delete (record as { name?: string }).name;
    const line = formatTaskLine(record);
    expect(line).toContain("abc12345");
  });

  it("includes empty state indicator for empty lastEvent", () => {
    const record = { ...base, lastEvent: "", state: "submitted" as TaskState };
    const line = formatTaskLine(record);
    expect(line).toContain("submitted");
  });
});

// ─── filterTasks ─────────────────────────────────────────────────

describe("filterTasks", () => {
  const records: TaskRecord[] = [
    {
      id: "aaa-111", name: "crew-a", project: "p", provider: "claude",
      mode: "interactive", state: "working" as TaskState, task: "task a",
      createdAt: 1, lastHeartbeat: 1, lastEvent: "task.started",
      heartbeatBudgetMs: 300000, attempts: [],
    },
    {
      id: "bbb-222", name: "crew-b", project: "p", provider: "codex",
      mode: "interactive", state: "done" as TaskState, task: "task b",
      createdAt: 2, lastHeartbeat: 2, lastEvent: "task.done",
      heartbeatBudgetMs: 300000, attempts: [],
    },
    {
      id: "ccc-333", name: "crew-c", project: "p", provider: "opencode",
      mode: "interactive", state: "blocked" as TaskState, task: "task c",
      createdAt: 3, lastHeartbeat: 3, lastEvent: "task.blocked",
      heartbeatBudgetMs: 300000, attempts: [],
    },
  ];

  it("returns all records when no filters", () => {
    expect(filterTasks(records, {}).length).toBe(3);
  });

  it("filters by id (prefix match)", () => {
    const r = filterTasks(records, { id: "aaa" });
    expect(r.length).toBe(1);
    expect(r[0].id).toBe("aaa-111");
  });

  it("filters by state", () => {
    const r = filterTasks(records, { state: "done" });
    expect(r.length).toBe(1);
    expect(r[0].state).toBe("done");
  });

  it("filters by id and state combined", () => {
    const r = filterTasks(records, { id: "bbb", state: "working" });
    expect(r.length).toBe(0);
  });

  it("returns empty array when no match", () => {
    expect(filterTasks(records, { id: "zzz" })).toEqual([]);
  });

  it("finds stateOnly record by id (includes full state string)", () => {
    const r = filterTasks(records, { id: "ccc", stateOnly: true });
    expect(r.length).toBe(1);
    expect(r[0].state).toBe("blocked");
  });
});

// ─── formatCompactTasks ──────────────────────────────────────────

describe("formatCompactTasks", () => {
  const records: TaskRecord[] = [
    {
      id: "aaa-111", name: "crew-a", project: "p", provider: "claude",
      mode: "interactive", state: "working" as TaskState, task: "task a",
      createdAt: 1, lastHeartbeat: 1, lastEvent: "task.started",
      heartbeatBudgetMs: 300000, attempts: [],
    },
  ];

  it("formats compact list by default", () => {
    const out = formatCompactTasks(records, {});
    expect(out).toContain("aaa-111");
    expect(out).not.toContain("\"id\"");
  });

  it("formats JSON when compact is false", () => {
    const out = formatCompactTasks(records, { compact: false });
    expect(out).toContain("\"id\"");
    expect(out).toContain("\"aaa-111\"");
  });

  it("shows single state line when stateOnly is true", () => {
    const out = formatCompactTasks(records, { stateOnly: true });
    expect(out).toBe("working");
  });

  it("prints clear message for empty list", () => {
    const out = formatCompactTasks([], {});
    expect(out).toContain("no tasks");
  });

  it("prints clear message for empty list even with JSON", () => {
    const out = formatCompactTasks([], { compact: false });
    expect(out).toContain("no tasks");
  });
});
