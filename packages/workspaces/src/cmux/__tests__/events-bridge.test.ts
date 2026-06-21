// Tests for the cmux native-events → ControlEvent bridge (audit B1).
// The bridge subscribes ONCE to `cmux events` (a single global newline-delimited
// JSON stream over the cmux socket) and correlates each agent hook frame to a
// crew TaskRecord by cwd, mapping `agent.hook.Stop` → `task.turn.completed`.
// This is the events-stream alternative to scraping a crew's pane for idle.
import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { CmuxEventsBridge, deriveRunState } from "../events-bridge.js";
import { reduce } from "@squadrant/core";
import { evaluateStall } from "@squadrant/core";
import type { ControlEvent, TaskRecord } from "@squadrant/shared";

/** A fake `cmux events` child: stdout streams the given lines, then exits. */
function fakeChild(lines: string[]) {
  const stdout = Readable.from(lines.map((l) => Buffer.from(l)));
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    kill: () => void;
  };
  child.stdout = stdout;
  child.kill = vi.fn(() => stdout.destroy());
  // Emit "exit" once stdout drains, mirroring a real child whose stream ended.
  stdout.on("end", () => child.emit("exit", 0, null));
  return child;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const ack =
  '{"type":"ack","protocol":"cmux-events","resume":{"latest_seq":1,"gap":false}}\n';

function stopFrame(cwd: string, phase = "completed", name = "agent.hook.Stop") {
  return (
    JSON.stringify({
      type: "event",
      category: "agent",
      name,
      seq: 2,
      source: "claude",
      workspace_id: "ws1",
      payload: { _source: "claude", session_id: "claude-abc", cwd, phase },
    }) + "\n"
  );
}

/** A "working" agent hook frame (PreToolUse / UserPromptSubmit). */
function workingFrame(cwd: string, name = "agent.hook.PreToolUse", phase = "completed") {
  return stopFrame(cwd, phase, name);
}

describe("CmuxEventsBridge", () => {
  it("maps agent.hook.Stop → task.turn.completed for the matching crew cwd", async () => {
    const events: ControlEvent[] = [];
    const resolve = (e: { cwd?: string }) =>
      e.cwd === "/wt/crew-a" ? { id: "task-a" } : undefined;
    const spawnImpl = vi.fn((_bin: string, _args: string[]) =>
      fakeChild([ack, stopFrame("/wt/crew-a")]),
    );

    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve,
      cursorFile: "/tmp/seq",
      spawnImpl: spawnImpl as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();

    // It invoked `cmux events` with reconnect + cursor-file + agent category.
    const args = spawnImpl.mock.calls[0][1];
    expect(args).toContain("events");
    expect(args).toContain("--reconnect");
    expect(args).toContain("--cursor-file");
    expect(args).toContain("/tmp/seq");
    expect(args).toEqual(expect.arrayContaining(["--category", "agent"]));

    expect(events).toEqual([
      { type: "task.turn.completed", id: "task-a", turnId: "claude-abc" },
    ]);
    bridge.stop();
  });

  it("ignores frames with no matching crew, the ack, and SubagentStop", async () => {
    const events: ControlEvent[] = [];
    const resolve = (e: { cwd?: string }) =>
      e.cwd === "/wt/known" ? { id: "t" } : undefined;
    const lines = [
      ack,
      stopFrame("/wt/unknown"), // no matching record
      stopFrame("/wt/known", "completed", "agent.hook.SubagentStop"), // subagent ≠ turn
      stopFrame("/wt/known"), // the only one that should fire
    ];
    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve,
      cursorFile: "/tmp/seq",
      spawnImpl: (() => fakeChild(lines)) as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();
    expect(events).toEqual([
      { type: "task.turn.completed", id: "t", turnId: "claude-abc" },
    ]);
    bridge.stop();
  });

  it("emits once per Stop, ignoring the received-phase duplicate", async () => {
    const events: ControlEvent[] = [];
    const lines = [
      ack,
      stopFrame("/wt/x", "received"), // the paired received frame — must NOT fire
      stopFrame("/wt/x", "completed"),
    ];
    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve: () => ({ id: "x" }),
      cursorFile: "/tmp/seq",
      spawnImpl: (() => fakeChild(lines)) as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();
    expect(events.filter((e) => e.type === "task.turn.completed")).toHaveLength(1);
    bridge.stop();
  });

  it("survives a malformed line without emitting", async () => {
    const events: ControlEvent[] = [];
    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve: () => ({ id: "x" }),
      cursorFile: "/tmp/seq",
      spawnImpl: (() => fakeChild([ack, "not json\n", stopFrame("/wt/x")])) as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();
    expect(events).toHaveLength(1);
    bridge.stop();
  });

  it("buffers partial lines across chunk boundaries", async () => {
    const events: ControlEvent[] = [];
    const full = stopFrame("/wt/x");
    const mid = Math.floor(full.length / 2);
    // Split one JSON frame across two stdout chunks.
    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve: () => ({ id: "x" }),
      cursorFile: "/tmp/seq",
      spawnImpl: (() =>
        fakeChild([ack, full.slice(0, mid), full.slice(mid)])) as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();
    expect(events).toHaveLength(1);
    bridge.stop();
  });
});

// B4/A3 — run-state derivation: PreToolUse/UserPromptSubmit → working, Stop → idle.
describe("deriveRunState", () => {
  it("maps PreToolUse and UserPromptSubmit to working", () => {
    expect(deriveRunState("agent.hook.PreToolUse")).toBe("working");
    expect(deriveRunState("agent.hook.UserPromptSubmit")).toBe("working");
  });
  it("maps Stop to idle", () => {
    expect(deriveRunState("agent.hook.Stop")).toBe("idle");
  });
  it("ignores SubagentStop and unknown names (subagent end ≠ turn end)", () => {
    expect(deriveRunState("agent.hook.SubagentStop")).toBeNull();
    expect(deriveRunState("agent.hook.PostToolUse")).toBeNull();
    expect(deriveRunState("")).toBeNull();
  });
});

// B4/A3 — the bridge emits task.progress for a working hook so the crew's
// liveness clock stays fresh while a turn is live (false-stall suppression).
describe("CmuxEventsBridge working hooks → task.progress", () => {
  it("maps agent.hook.PreToolUse → task.progress for the matching crew cwd", async () => {
    const events: ControlEvent[] = [];
    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve: (h) => (h.cwd === "/wt/crew-a" ? { id: "task-a" } : undefined),
      cursorFile: "/tmp/seq",
      spawnImpl: (() => fakeChild([ack, workingFrame("/wt/crew-a")])) as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();
    expect(events).toEqual([{ type: "task.progress", id: "task-a", note: "agent.hook.PreToolUse" }]);
    bridge.stop();
  });

  it("#354: carries the tool name from a PreToolUse frame onto task.progress", async () => {
    const events: ControlEvent[] = [];
    const frame = JSON.stringify({
      type: "event", category: "agent", name: "agent.hook.PreToolUse", seq: 3, source: "claude",
      payload: { _source: "claude", session_id: "claude-abc", cwd: "/wt/crew-a", phase: "completed", tool_name: "Bash" },
    }) + "\n";
    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve: () => ({ id: "task-a" }),
      cursorFile: "/tmp/seq",
      spawnImpl: (() => fakeChild([ack, frame])) as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();
    expect(events).toEqual([{ type: "task.progress", id: "task-a", note: "agent.hook.PreToolUse", tool: "Bash" }]);
    bridge.stop();
  });

  it("maps agent.hook.UserPromptSubmit → task.progress", async () => {
    const events: ControlEvent[] = [];
    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve: () => ({ id: "t" }),
      cursorFile: "/tmp/seq",
      spawnImpl: (() =>
        fakeChild([ack, workingFrame("/wt/x", "agent.hook.UserPromptSubmit")])) as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();
    expect(events).toEqual([{ type: "task.progress", id: "t", note: "agent.hook.UserPromptSubmit" }]);
    bridge.stop();
  });

  it("ignores the received-phase duplicate of a working hook (emits once)", async () => {
    const events: ControlEvent[] = [];
    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve: () => ({ id: "x" }),
      cursorFile: "/tmp/seq",
      spawnImpl: (() =>
        fakeChild([ack, workingFrame("/wt/x", "agent.hook.PreToolUse", "received"), workingFrame("/wt/x")])) as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();
    expect(events.filter((e) => e.type === "task.progress")).toHaveLength(1);
    bridge.stop();
  });

  it("does not emit for a working hook whose cwd matches no crew", async () => {
    const events: ControlEvent[] = [];
    const bridge = new CmuxEventsBridge({
      emit: (e) => events.push(e),
      resolve: () => undefined,
      cursorFile: "/tmp/seq",
      spawnImpl: (() => fakeChild([ack, workingFrame("/wt/unknown")])) as never,
      stopAfterFirstRun: true,
    });
    bridge.start();
    await flush();
    await flush();
    expect(events).toHaveLength(0);
    bridge.stop();
  });
});

// B4/A3 — end-to-end suppression: a working hook's task.progress refreshes the
// liveness clock the watchdog keys off, so evaluateStall stops false-idling a
// crew that is mid long tool-call but quiet on screen (#292 false-stalled).
describe("working-hook run-state suppresses false-stall (#292)", () => {
  function workingCrew(lastHeartbeatAt: number): TaskRecord {
    return {
      id: "task-a",
      name: "crew-a",
      project: "squadrant",
      provider: "claude",
      mode: "interactive",
      state: "working",
      task: "do a thing",
      createdAt: 0,
      lastHeartbeat: lastHeartbeatAt,
      lastEvent: "task.started",
      heartbeatBudgetMs: 60_000,
      attempts: [{ attemptId: "a0", startedAt: 0, lastHeartbeatAt }],
    };
  }

  it("a quiet crew past budget with no tool in flight is NOT stalled by the watchdog (#354)", () => {
    const now = 100_000; // 100s since the last heartbeat at t=0, budget 60s
    // Post-#354 the watchdog never flips a quiet interactive crew to awaiting-input;
    // a deep-thinking turn stays working (the sweep surfaces CREW QUIET instead).
    expect(evaluateStall(workingCrew(0), now)).toBeNull();
  });

  it("a PreToolUse-derived task.progress opens a tool window that does NOT immediately stall (#292/#354)", () => {
    const now = 100_000;
    // The bridge's working-hook event lands as task.progress just before the sweep.
    const progressed = reduce(workingCrew(0), { type: "task.progress", id: "task-a", note: "agent.hook.PreToolUse", tool: "Bash" }, now);
    // The tool window just opened (since=now) → well within the tool-stall budget.
    expect(progressed.pendingTool).toEqual({ name: "Bash", since: now });
    expect(evaluateStall(progressed, now)).toBeNull();
    expect(progressed.state).toBe("working");
  });
});
