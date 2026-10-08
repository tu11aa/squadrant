// #890: a recovered captain must get the current truth, not a chronological
// replay of every stale event that queued while delivery was blocked.
import { describe, it, expect } from "vitest";
import { coalesceBacklog } from "../backlog-coalesce.js";
import { STUCK_ALERT_TEXT } from "../delivery-loop.js";
import type { MailboxEntry } from "../../mailbox.js";
import type { TaskState } from "@squadrant/shared";

const NOW = Date.parse("2026-10-08T10:00:00Z");
const MIN = 60_000;

function task(seq: number, kind: MailboxEntry["kind"], taskId = "t1", ageMs = 0): MailboxEntry {
  return {
    seq, ts: new Date(NOW - ageMs).toISOString(), taskId, kind,
    provider: "claude", message: `${kind} #${seq}`,
  };
}

function daemonMsg(seq: number, message: string, ageMs = 0): MailboxEntry {
  return { seq, ts: new Date(NOW - ageMs).toISOString(), kind: "captain.message", payload: { source: "daemon" }, message };
}

const states = (m: Record<string, TaskState>) => (id: string) => m[id];

describe("coalesceBacklog (#890)", () => {
  it("collapses quiet/idle/review ×N + done for one task to the done — and never drops the done", () => {
    const backlog = [
      task(1, "task.review"), task(2, "task.turn.completed"), task(3, "task.quiet"),
      task(4, "task.review"), task(5, "task.turn.completed"), task(6, "task.quiet"),
      task(7, "task.review"), task(8, "task.done"),
    ];
    const out = coalesceBacklog(backlog, { now: NOW, taskState: states({ t1: "done" }) });
    expect(out.filter((d) => d.action === "deliver").map((d) => d.entry.seq)).toEqual([8]);
    expect(out.filter((d) => d.action === "skip").every((d) => d.action === "skip" && d.reason === "superseded")).toBe(true);
    expect(out).toHaveLength(backlog.length);
  });

  it("keeps the latest review when nothing newer supersedes it; quiet/idle after it are dropped only if followed", () => {
    const backlog = [task(1, "task.review"), task(2, "task.quiet"), task(3, "task.review"), task(4, "task.turn.completed")];
    const out = coalesceBacklog(backlog, { now: NOW, taskState: states({ t1: "awaiting-input" }) });
    expect(out.filter((d) => d.action === "deliver").map((d) => d.entry.seq)).toEqual([3, 4]);
  });

  it("supersession is per task — another task's events are untouched", () => {
    const backlog = [task(1, "task.quiet", "a"), task(2, "task.quiet", "b"), task(3, "task.review", "a")];
    const out = coalesceBacklog(backlog, { now: NOW, taskState: states({ a: "review", b: "working" }) });
    expect(out.filter((d) => d.action === "deliver").map((d) => d.entry.seq)).toEqual([2, 3]);
  });

  it("never drops must-deliver kinds, even when followed by newer events", () => {
    const backlog = [task(1, "task.blocked"), task(2, "task.done"), task(3, "task.failed"), task(4, "task.quiet")];
    const out = coalesceBacklog(backlog, { now: NOW, taskState: states({ t1: "failed" }) });
    expect(out.filter((d) => d.action === "deliver").map((d) => d.entry.seq)).toEqual([1, 2, 3]);
  });

  it("annotates events for a task that has since gone terminal; drops its trailing quiet/idle", () => {
    const backlog = [task(1, "task.review"), task(2, "task.blocked", "t2"), task(3, "task.quiet"), task(4, "task.turn.completed", "t3")];
    const out = coalesceBacklog(backlog, {
      now: NOW, taskState: states({ t1: "cancelled", t2: "done", t3: "cancelled" }),
    });
    const delivered = out.filter((d) => d.action === "deliver");
    expect(delivered.map((d) => d.entry.seq)).toEqual([1, 2]);
    expect(delivered[0].entry.message).toBe("[task now cancelled] task.review #1");
    expect(delivered[1].entry.message).toBe("[task now done] task.blocked #2");
    const skipped = out.filter((d) => d.action === "skip");
    expect(skipped.map((d) => d.action === "skip" && d.reason)).toEqual(["task-terminal", "task-terminal"]);
  });

  it("annotates a terminal event whose task has since moved to a different terminal state", () => {
    const out = coalesceBacklog([task(1, "task.done")], { now: NOW, taskState: states({ t1: "cancelled" }) });
    expect(out[0]).toMatchObject({ action: "deliver", entry: { message: "[task now cancelled] task.done #1" } });
  });

  it("does not annotate when the task record is missing or matches the event", () => {
    const out = coalesceBacklog([task(1, "task.done"), task(2, "task.review", "gone")], {
      now: NOW, taskState: states({ t1: "done" }),
    });
    expect(out.map((d) => d.entry.message)).toEqual(["task.done #1", "task.review #2"]);
  });

  it("prefixes task events older than the stale threshold, like daemon captain.message", () => {
    const out = coalesceBacklog([task(1, "task.done", "t1", 8 * 60 * MIN), task(2, "task.review", "t2", 5 * MIN)], {
      now: NOW, taskState: states({ t1: "done", t2: "review" }),
    });
    expect(out[0].entry.message).toBe("[stale — generated 8h ago] task.done #1");
    expect(out[1].entry.message).toBe("task.review #2");
  });

  it("stale prefix comes before the terminal annotation", () => {
    const out = coalesceBacklog([task(1, "task.review", "t1", 2 * 60 * MIN)], { now: NOW, taskState: states({ t1: "cancelled" }) });
    expect(out[0].entry.message).toBe("[stale — generated 2h ago] [task now cancelled] task.review #1");
  });

  it("keeps the existing stale prefix for daemon captain.message, and leaves human/cli messages alone", () => {
    const cli: MailboxEntry = { seq: 2, ts: new Date(NOW - 3 * 60 * MIN).toISOString(), kind: "captain.message", payload: { source: "cli" }, message: "hi" };
    const out = coalesceBacklog([daemonMsg(1, "⚠️ Daemon restarted", 2 * 60 * MIN), cli], { now: NOW, taskState: states({}) });
    expect(out.map((d) => d.entry.message)).toEqual(["[stale — generated 2h ago] ⚠️ Daemon restarted", "hi"]);
  });

  it("drops every DELIVERY STUCK / NOT DELIVERABLE self-alert — reaching it means its blocker already cleared", () => {
    const alerts = Object.values(STUCK_ALERT_TEXT).map((fn, i) => daemonMsg(i + 1, fn(300)));
    const out = coalesceBacklog(alerts, { now: NOW, taskState: states({}) });
    expect(out.every((d) => d.action === "skip" && d.reason === "moot-stuck-alert")).toBe(true);
  });

  it("does not mutate the input entries", () => {
    const e = task(1, "task.review", "t1", 2 * 60 * MIN);
    coalesceBacklog([e], { now: NOW, taskState: states({ t1: "done" }) });
    expect(e.message).toBe("task.review #1");
  });
});
