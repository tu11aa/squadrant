import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendFirstTurnWhenReady } from "../crew-pane.js";
import type { PaneRef } from "@cockpit/shared";

describe("sendFirstTurnWhenReady", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let sendToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    sendToPane = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls until pane stabilizes then sends the task once", async () => {
    let callCount = 0;
    readPaneScreen.mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) return "";
      if (callCount <= 3) return "> ";        // stable prompt, advanced past launch
      if (callCount === 4) return "> ";       // preSend snapshot
      return "> do the thing";                // after-send: screen changed → no re-send
    });

    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane },
      pane,
      "do the thing",
      "$ launch",
    );

    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    expect(sendToPane).toHaveBeenCalledTimes(1);
    expect(sendToPane).toHaveBeenCalledWith(pane, "do the thing");
  });

  it("falls back to sending even if pane never stabilises", async () => {
    readPaneScreen.mockResolvedValue("");

    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane },
      pane,
      "do the thing",
      "$ launch",
    );

    await vi.advanceTimersByTimeAsync(21000);
    await promise;

    // Two calls: fallback send + one re-send (post-send check sees an unchanged screen)
    expect(sendToPane).toHaveBeenCalledTimes(2);
    expect(sendToPane).toHaveBeenNthCalledWith(1, pane, "do the thing");
    expect(sendToPane).toHaveBeenNthCalledWith(2, pane, "do the thing");
  }, 15000);

  it("re-sends once when the screen is unchanged after the first send", async () => {
    readPaneScreen.mockResolvedValue("> ");

    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane },
      pane,
      "do the thing",
      "$ launch",
    );

    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    // Two calls: initial send + one re-send (preSend === afterScreen)
    expect(sendToPane).toHaveBeenCalledTimes(2);
    expect(sendToPane).toHaveBeenNthCalledWith(1, pane, "do the thing");
    expect(sendToPane).toHaveBeenNthCalledWith(2, pane, "do the thing");
  });

  // #168: sendToPane (since #136) collapses newlines to spaces, so a multi-line
  // task never appears verbatim in the pane render. The old post-send check
  // `!afterScreen.includes(task)` therefore always re-sent → duplicate first
  // turn. The fix compares the screen before vs after sending instead.
  it("does NOT re-send a multi-line task when the pane render collapses newlines", async () => {
    const task = "line one\nline two\nline three";
    let callCount = 0;
    readPaneScreen.mockImplementation(async () => {
      callCount++;
      // reads 1-2: poll (stable), read 3: preSend snapshot — all the bare prompt.
      if (callCount <= 3) return "> ";
      return "> line one line two line three";               // after-send: collapsed render
    });

    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane },
      pane,
      task,
      "$ launch",
    );

    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    // The screen changed after the send (task was received), so no re-send —
    // even though `afterScreen.includes(task)` is false for the multi-line task.
    expect(sendToPane).toHaveBeenCalledTimes(1);
    expect(sendToPane).toHaveBeenCalledWith(pane, task);
  });

  // opencode boot-race: the screen can be momentarily static while the launch
  // command still sits un-entered on the shell line. Sending then concatenates
  // onto that line → shell parse error. The readiness gate must require the
  // screen to ADVANCE past the launch-line snapshot, not merely be static.
  it("does NOT send the first turn while the pane still shows the un-entered launch line", async () => {
    const launchLine = "$ COCKPIT_CREW_TASK_ID=t1 opencode";
    readPaneScreen.mockResolvedValue(launchLine);

    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane },
      pane,
      "do the thing",
      launchLine,
    );

    // Well under the 20s timeout: the screen never advanced past the launch
    // line, so the readiness gate must not have fired yet.
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendToPane).not.toHaveBeenCalled();

    // Drain to the timeout so the fallback send fires and the promise resolves.
    await vi.advanceTimersByTimeAsync(20000);
    await promise;
  }, 15000);
});

describe("sendFirstTurnWhenReady — post-send acceptance retry", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let sendToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    sendToPane = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries up to retryLimit when opencode splash persists (splashMarker set)", async () => {
    readPaneScreen.mockResolvedValue("Ask anything…");

    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane },
      pane,
      "do the thing",
      "$ opencode",       // preLaunchScreen
      { splashMarker: "Ask anything…", retryLimit: 3 },
    );

    // Floor (1500) + 2 poll cycles (1500) + 3 retry checks (2250) = 5250ms
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    // 3 full retry rounds: initial send + 2 re-sends = 3 total
    expect(sendToPane).toHaveBeenCalledTimes(3);
  });

  it("exits early on acceptance instead of exhausting retries", async () => {
    let callCount = 0;
    readPaneScreen.mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) return "booting…";        // preLaunchScreen
      if (callCount <= 3) return "Ask anything…";    // poll 1-2 (stabilizing)
      if (callCount === 4) return "Ask anything…";   // preSend snapshot
      return "> do the thing";                        // after-send: accepted
    });

    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane },
      pane,
      "do the thing",
      "booting…",
      { splashMarker: "Ask anything…", retryLimit: 3 },
    );

    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    // 1 send only: acceptance detected on first retry check
    expect(sendToPane).toHaveBeenCalledTimes(1);
  });
});
