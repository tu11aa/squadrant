// src/commands/__tests__/notify-relay-probe.test.ts
//
// Phase 2b (relocated): the in-cmux notify-relay runs a probe loop that scrapes
// quiet interactive crew panes and surfaces a permission/question wait as
// task.blocked. The daemon can't do this (launchd can't connect to cmux), so the
// detection lives here, where createCmuxDriver works.
//
// These tests drive the PURE probe core: createInteractiveProbe takes injected
// {listTasks, readPaneTail, sendEvent, now} so the cmux + daemon I/O is faked.

import { describe, it, expect, vi } from "vitest";
import { createInteractiveProbe } from "../notify-relay.js";
import type { TaskRecord, ControlEvent } from "../../control/types.js";

// A claude permission dialog (box-drawing chrome included) — classifyPaneTail
// recognises this as an approval wait.
const APPROVAL_TAIL = [
  "● I'll create the file now.",
  "╭──────────────────────────────────────────────────────╮",
  "│ Do you want to create newfile.txt?                     │",
  "│ ❯ 1. Yes                                               │",
  "│   2. No, and tell Claude what to do differently        │",
  "╰──────────────────────────────────────────────────────╯",
  "  accept edits on (shift+tab to cycle)                    ",
].join("\n");

const NOW = 1_000_000;
const QUIET = 20_000;

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    name: "alpha",
    project: "demo",
    provider: "claude",
    mode: "interactive",
    state: "working",
    task: "do a thing",
    createdAt: 0,
    lastHeartbeat: NOW - QUIET - 1, // quiet by default
    lastEvent: "heartbeat",
    heartbeatBudgetMs: 60000,
    attempts: [],
    ...over,
  };
}

interface Harness {
  sendEvent: ReturnType<typeof vi.fn>;
  readPaneTail: ReturnType<typeof vi.fn>;
  tick: () => Promise<void>;
}

function harness(opts: {
  tasks: TaskRecord[];
  readPaneTail?: (rec: TaskRecord) => Promise<string | null>;
  listTasks?: () => Promise<TaskRecord[]>;
  sendEvent?: (e: ControlEvent) => Promise<void>;
}): Harness {
  const sendEvent = vi.fn(opts.sendEvent ?? (async () => {}));
  const readPaneTail = vi.fn(opts.readPaneTail ?? (async () => APPROVAL_TAIL));
  const probe = createInteractiveProbe({
    project: "demo",
    listTasks: opts.listTasks ?? (async () => opts.tasks),
    readPaneTail,
    sendEvent,
    now: () => NOW,
    log: () => {},
    quietMs: QUIET,
  });
  return { sendEvent, readPaneTail, tick: probe.tick };
}

describe("createInteractiveProbe", () => {
  it("sends exactly one task.blocked for a quiet working interactive crew at a prompt", async () => {
    const h = harness({ tasks: [task()] });
    await h.tick();
    expect(h.sendEvent).toHaveBeenCalledTimes(1);
    const ev = h.sendEvent.mock.calls[0][0] as ControlEvent;
    expect(ev).toMatchObject({
      type: "task.blocked",
      id: "task-1",
      reason: "crew awaiting permission (pane-detected)",
      question: "Do you want to create newfile.txt?",
    });
  });

  it("does not re-send when the tail is unchanged on the next tick (change-detection)", async () => {
    const h = harness({ tasks: [task()] });
    await h.tick();
    await h.tick();
    expect(h.sendEvent).toHaveBeenCalledTimes(1);
  });

  it("does not read a task whose heartbeat is recent (not quiet)", async () => {
    const h = harness({ tasks: [task({ lastHeartbeat: NOW - 5_000 })] });
    await h.tick();
    expect(h.readPaneTail).not.toHaveBeenCalled();
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it("skips non-interactive, non-working, and unnamed tasks", async () => {
    const h = harness({
      tasks: [
        task({ id: "a", mode: "headless" }),
        task({ id: "b", state: "blocked" }),
        task({ id: "c", state: "done" }),
        task({ id: "d", name: undefined }),
      ],
    });
    await h.tick();
    expect(h.readPaneTail).not.toHaveBeenCalled();
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it("sends a question-reason block when the pane ends in a trailing question", async () => {
    const questionTail = [
      "I looked at both options for the cache layer.",
      "Should I use Redis or an in-memory LRU for this?",
    ].join("\n");
    const h = harness({ tasks: [task()], readPaneTail: async () => questionTail });
    await h.tick();
    expect(h.sendEvent).toHaveBeenCalledTimes(1);
    const ev = h.sendEvent.mock.calls[0][0] as ControlEvent;
    expect(ev).toMatchObject({
      type: "task.blocked",
      reason: "crew asked a question (pane-detected)",
      question: "Should I use Redis or an in-memory LRU for this?",
    });
  });

  it("does not block a working pane with no prompt or question", async () => {
    const h = harness({ tasks: [task()], readPaneTail: async () => "● running the tests next" });
    await h.tick();
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it("swallows a readPaneTail error and never throws", async () => {
    const h = harness({
      tasks: [task()],
      readPaneTail: async () => {
        throw new Error("cmux down");
      },
    });
    await expect(h.tick()).resolves.toBeUndefined();
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it("swallows a listTasks error and never throws", async () => {
    const h = harness({
      tasks: [],
      listTasks: async () => {
        throw new Error("daemon down");
      },
    });
    await expect(h.tick()).resolves.toBeUndefined();
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it("swallows a sendEvent error and never throws", async () => {
    const h = harness({
      tasks: [task()],
      sendEvent: async () => {
        throw new Error("daemon refused");
      },
    });
    await expect(h.tick()).resolves.toBeUndefined();
  });
});
