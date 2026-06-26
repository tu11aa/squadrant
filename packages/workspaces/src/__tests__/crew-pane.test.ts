import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendFirstTurnWhenReady } from "../crew-pane.js";
import type { PaneRef } from "@squadrant/shared";

// Realistic Claude-Code-style screen: the live input box is the region between the
// last two horizontal rules. parseDraftFromScreen reads exactly that region, so the
// #339 fix can use box-empty (submitted) vs box-holds-draft (stranded) as its
// confirmation signal instead of the fragile "screen changed" heuristic.
const HR = "─".repeat(60);
const box = (content: string) =>
  `…transcript…\n${HR}\n❯ ${content}\n${HR}\n   Model: Sonnet 4.6  Ctx Used: 0.0%`;
const EMPTY_BOX = box("");                 // parseDraftFromScreen → "" (submitted)
const DRAFT_BOX = box("[Pasted text #1]"); // parseDraftFromScreen → draft  (stranded)

describe("sendFirstTurnWhenReady — claude/codex first-turn (#339)", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let sendToPane: ReturnType<typeof vi.fn>;
  let pasteToPane: ReturnType<typeof vi.fn>;
  let sendKeyToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };
  const rt = () => ({ readPaneScreen, sendToPane, pasteToPane, sendKeyToPane });

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    sendToPane = vi.fn();
    pasteToPane = vi.fn();
    sendKeyToPane = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // #339: the submit CR must be a SEPARATE keystroke issued after the paste settles —
  // never bundled into the paste send (which is how the CR gets absorbed as a newline
  // inside the [Pasted text] placeholder). The whole task is pasted exactly once.
  it("pastes the task once, then submits with a separate Enter — never via send+Enter", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 3) return EMPTY_BOX;  // readiness polls + preSend snapshot
      if (n <= 5) return DRAFT_BOX;  // settle: paste rendered, box holds the draft
      return EMPTY_BOX;              // post-Enter: box empty → submitted
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "do the big thing", "$ launch");
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    expect(pasteToPane).toHaveBeenCalledTimes(1);
    expect(pasteToPane).toHaveBeenCalledWith(pane, "do the big thing");
    expect(sendKeyToPane).toHaveBeenCalledWith(pane, "Enter");
    expect(sendToPane).not.toHaveBeenCalled();
  });

  // #339 core regression: when the first Enter is absorbed as a newline (box still
  // holds the paste), the retry re-issues ONLY the Enter — it must NOT re-paste the
  // task (re-pasting is what stacks [Pasted text #1][#2][#3] and never submits).
  it("re-issues ONLY Enter when the first submit is stranded — never re-pastes", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 3) return EMPTY_BOX;  // readiness + preSend
      if (n <= 5) return DRAFT_BOX;  // settle after paste
      if (n === 6) return DRAFT_BOX; // post-Enter#1: STILL holds draft → stranded
      if (n <= 8) return DRAFT_BOX;  // re-settle before Enter#2
      return EMPTY_BOX;              // post-Enter#2: submitted
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "do the big thing", "$ launch");
    await vi.advanceTimersByTimeAsync(8000);
    await promise;

    expect(pasteToPane).toHaveBeenCalledTimes(1); // paste exactly ONCE, ever
    expect(sendKeyToPane).toHaveBeenCalledTimes(2); // Enter, then re-Enter
    expect(sendKeyToPane).toHaveBeenCalledWith(pane, "Enter");
    expect(sendToPane).not.toHaveBeenCalled();
  });

  // Submission is confirmed by the input box going empty, NOT by "screen changed" —
  // the paste itself changes the screen, so screen-changed would falsely report a
  // stranded paste as submitted.
  it("does not treat the paste landing in the box as a successful submit", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 3) return EMPTY_BOX;  // readiness + preSend
      return DRAFT_BOX;              // paste landed but box NEVER empties → never submits
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "do the big thing", "$ launch");
    await vi.advanceTimersByTimeAsync(20000);
    await promise;

    // Box never empties, so the retry loop keeps re-issuing Enter (≥2) and still
    // never re-pastes. The point: it did not early-return on the paste-changed screen.
    expect(pasteToPane).toHaveBeenCalledTimes(1);
    expect(sendKeyToPane.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendToPane).not.toHaveBeenCalled();
  });
});

describe("sendFirstTurnWhenReady — post-send acceptance retry", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let sendToPane: ReturnType<typeof vi.fn>;
  let pasteToPane: ReturnType<typeof vi.fn>;
  let sendKeyToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };
  const rt = () => ({ readPaneScreen, sendToPane, pasteToPane, sendKeyToPane });

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    sendToPane = vi.fn();
    pasteToPane = vi.fn();
    sendKeyToPane = vi.fn();
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
      rt(),
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
      rt(),
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
      rt(),
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
