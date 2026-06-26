import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendFirstTurnWhenReady } from "../crew-pane.js";
import type { PaneRef } from "@squadrant/shared";

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
    const launchLine = "$ SQUADRANT_CREW_TASK_ID=t1 opencode";
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

  // #235: confirm-on-delivery — when the splash persists, sendFirstTurnWhenReady
  // polls every 750ms but re-sends only every 4 checks (≈3s de-dup guard).
  // Over a 15s window (SPLASH_MAX_CHECKS=20), at most 4 re-sends are issued on
  // top of the initial send (at check 3, 7, 11, 15 → 5 total sends).
  it("uses time-bounded confirm-on-delivery when opencode splash persists", async () => {
    readPaneScreen.mockResolvedValue("Ask anything…");

    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane },
      pane,
      "do the thing",
      "$ opencode",
      { splashMarker: "Ask anything…" },
    );

    // Floor (1500) + 2 stability polls (1500) + 20 confirm checks (15000) = 18000ms
    await vi.advanceTimersByTimeAsync(18500);
    await promise;

    // 1 initial send + 4 re-sends at checks 3, 7, 11, 15 = 5 total
    expect(sendToPane).toHaveBeenCalledTimes(5);
    expect(sendToPane).toHaveBeenCalledWith(pane, "do the thing");
  }, 15000);

  it("exits early on acceptance instead of exhausting the confirm window", async () => {
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
      { splashMarker: "Ask anything…" },
    );

    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    // 1 send only: acceptance detected on first confirm check
    expect(sendToPane).toHaveBeenCalledTimes(1);
  });

  // #235: slow boot — opencode accepts after 6s (8 checks × 750ms). The
  // confirm-on-delivery loop must keep trying until splash clears, not give up
  // after a fixed count as the old retryLimit:3 path did.
  it("confirms delivery after slow boot (splash clears after 6s of checks)", async () => {
    let checkCount = 0;
    readPaneScreen.mockImplementation(async () => {
      checkCount++;
      // stability reads 1-2: both "Ask anything…" → stable detected
      if (checkCount <= 2) return "Ask anything…";
      if (checkCount === 3) return "Ask anything…";  // preSend snapshot
      // 8 post-send checks (8 × 750ms = 6s) with splash still showing
      if (checkCount <= 11) return "Ask anything…";
      return "> processing your task";               // accepted!
    });

    const promise = sendFirstTurnWhenReady(
      { readPaneScreen, sendToPane },
      pane,
      "do the thing",
      "$ opencode",
      { splashMarker: "Ask anything…" },
    );

    // Floor(1500) + 2 polls(1500) + 9 checks(6750) = ~9750ms
    await vi.advanceTimersByTimeAsync(12000);
    await promise;

    // Initial send + 2 re-sends (at checks 3 and 7), then accepted at check 8
    expect(sendToPane).toHaveBeenCalledTimes(3);
    expect(sendToPane).toHaveBeenCalledWith(pane, "do the thing");
  });
});
