// Tests for the cmux native-events → ControlEvent bridge (audit B1).
// The bridge subscribes ONCE to `cmux events` (a single global newline-delimited
// JSON stream over the cmux socket) and correlates each agent hook frame to a
// crew TaskRecord by cwd, mapping `agent.hook.Stop` → `task.turn.completed`.
// This is the events-stream alternative to scraping a crew's pane for idle.
import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { CmuxEventsBridge } from "../events-bridge.js";
import type { ControlEvent } from "../../types.js";

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
