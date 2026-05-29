import { describe, it, expect } from "vitest";
import { normalizeAppServerNotification } from "../normalize.js";

describe("normalizeAppServerNotification", () => {
  it("maps turn/started → task.turn.started (turnId from params.turn.id)", () => {
    expect(
      normalizeAppServerNotification("X", {
        method: "turn/started",
        params: { threadId: "t", turn: { id: "u" } },
      })
    ).toEqual({ type: "task.turn.started", id: "X", turnId: "u" });
  });

  it("maps turn/completed → task.turn.completed (turnId from params.turn.id)", () => {
    expect(
      normalizeAppServerNotification("X", {
        method: "turn/completed",
        params: { threadId: "t", turn: { id: "u" } },
      })
    ).toEqual({ type: "task.turn.completed", id: "X", turnId: "u" });
  });

  it("maps item/agentMessage/delta → task.delta (chunk from params.delta)", () => {
    expect(
      normalizeAppServerNotification("X", {
        method: "item/agentMessage/delta",
        params: { threadId: "t", turnId: "u", itemId: "i", delta: "hi" },
      })
    ).toEqual({ type: "task.delta", id: "X", turnId: "u", chunk: "hi" });
  });

  it("maps item/reasoning/textDelta → task.delta (chunk from params.delta)", () => {
    expect(
      normalizeAppServerNotification("X", {
        method: "item/reasoning/textDelta",
        params: { threadId: "t", turnId: "u", itemId: "i", delta: "think", contentIndex: 0 },
      })
    ).toEqual({ type: "task.delta", id: "X", turnId: "u", chunk: "think" });
  });

  it("maps item/commandExecution/outputDelta → task.delta (chunk from params.delta)", () => {
    expect(
      normalizeAppServerNotification("X", {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "t", turnId: "u", itemId: "i", delta: "ls output" },
      })
    ).toEqual({ type: "task.delta", id: "X", turnId: "u", chunk: "ls output" });
  });

  it("maps error → task.failed", () => {
    expect(
      normalizeAppServerNotification("X", {
        method: "error",
        params: { error: { message: "boom" }, willRetry: false, threadId: "t", turnId: "u" },
      })
    ).toEqual({ type: "task.failed", id: "X", error: expect.any(String) });
  });

  it("returns null for thread/tokenUsage/updated (status-line only)", () => {
    expect(
      normalizeAppServerNotification("X", {
        method: "thread/tokenUsage/updated",
        params: { threadId: "t", turnId: "u", tokenUsage: {} },
      })
    ).toBeNull();
  });

  it("returns null for thread/compacted (status-line only)", () => {
    expect(
      normalizeAppServerNotification("X", {
        method: "thread/compacted",
        params: { threadId: "t", turnId: "u" },
      })
    ).toBeNull();
  });

  it("returns null for thread/status/changed (status-line only)", () => {
    expect(
      normalizeAppServerNotification("X", {
        method: "thread/status/changed",
        params: { threadId: "t" },
      })
    ).toBeNull();
  });

  it("returns null for unknown method (forward-compat)", () => {
    expect(
      normalizeAppServerNotification("X", { method: "future/unknown", params: {} })
    ).toBeNull();
  });

  // Anti-#2576 invariant: NO codex notification maps to task.done
  it("never maps any notification to task.done", () => {
    const methods = [
      "turn/started",
      "turn/completed",
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "item/commandExecution/outputDelta",
      "command/exec/outputDelta",
      "error",
      "thread/tokenUsage/updated",
      "thread/compacted",
      "thread/status/changed",
    ];
    for (const method of methods) {
      const result = normalizeAppServerNotification("X", {
        method,
        params: { turn: { id: "u" }, threadId: "t", turnId: "u", delta: "", deltaBase64: "", processId: "p", stream: "stdout", capReached: false },
      });
      if (result !== null) {
        expect(result.type).not.toBe("task.done");
      }
    }
  });
});
