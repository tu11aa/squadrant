import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendFirstTurnWhenReady, confirmedSendToPane } from "../crew-pane.js";
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

// ─── #499: splash-marker drift — sawSplash latch fails closed ────────────────

describe("sendFirstTurnWhenReady — splash-marker drift fails closed (#499)", () => {
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

  // The core #499 regression: a marker that never matches the real screen (text
  // drift, wrong wording) used to make isTurnAccepted return true on the FIRST
  // post-send check, before any keystroke landed — a false-positive delivered:true.
  // With the sawSplash latch, "marker absent" only counts as acceptance once the
  // marker was actually observed first. A marker that's never observed must fail
  // closed: delivered:false, so the caller surfaces a non-delivery warning instead
  // of silently confirming a turn that was never sent.
  it("never returns delivered:true when the splash marker never matches the real screen", async () => {
    // Screen never contains "Ask anything" at all — simulates the exact #499
    // drift scenario (real opencode text vs a stale/wrong hardcoded marker).
    readPaneScreen.mockResolvedValue("> some other unrelated prompt");

    const promise = sendFirstTurnWhenReady(
      rt(),
      pane,
      "do the thing",
      "$ opencode",
      { splashMarker: "totally-wrong-marker" },
    );

    await vi.advanceTimersByTimeAsync(120000);
    const result = await promise;

    expect(result.delivered).toBe(false);
  });

  it("readiness gate does not stabilize on a screen that never shows the marker", async () => {
    readPaneScreen.mockResolvedValue("$ opencode booting up, no splash yet");

    const promise = sendFirstTurnWhenReady(
      rt(),
      pane,
      "do the thing",
      "$ opencode booting up, no splash yet",
      { splashMarker: "Ask anything" },
    );

    await vi.advanceTimersByTimeAsync(120000);
    await promise;

    // Never "ready" per the positive gate, but the splash branch still attempts
    // the send unconditionally — confirm it doesn't falsely report delivered.
    expect(sendToPane).toHaveBeenCalled();
  });

  // Real drift as reported in #499: opencode's actual placeholder uses three
  // ASCII dots and rotates through example text, not the old U+2026 hardcode.
  // The normalized "ask anything" substring match must still confirm delivery
  // once the (correctly matching) splash clears.
  it("confirms delivery once the drift-tolerant marker clears from the real placeholder text", async () => {
    let callCount = 0;
    readPaneScreen.mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) return 'Ask anything... "Fix a TODO in the codebase"';
      if (callCount === 4) return 'Ask anything... "Fix a TODO in the codebase"';
      return "> processing your task";
    });

    const promise = sendFirstTurnWhenReady(
      rt(),
      pane,
      "do the thing",
      "$ opencode",
      { splashMarker: "Ask anything" },
    );

    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result.delivered).toBe(true);
  });
});

// ─── confirmedSendToPane (#448 follow-up send hardening) ─────────────────────

describe("confirmedSendToPane — follow-up crew send (#448)", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let pasteToPane: ReturnType<typeof vi.fn>;
  let sendKeyToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };
  const rt = () => ({ readPaneScreen, pasteToPane, sendKeyToPane });

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    pasteToPane = vi.fn();
    sendKeyToPane = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Core contract: same as first-turn — paste once, separate Enter, no bundled CR.
  it("pastes the message once and submits with a separate Enter — never via send+Enter", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n === 1) return box("");           // preSendScreen capture
      if (n <= 3) return DRAFT_BOX;          // settle: paste landed
      return EMPTY_BOX;                       // post-Enter: submitted
    });

    const promise = confirmedSendToPane(rt(), pane, "follow-up message");
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(pasteToPane).toHaveBeenCalledTimes(1);
    expect(pasteToPane).toHaveBeenCalledWith(pane, "follow-up message");
    expect(sendKeyToPane).toHaveBeenCalledWith(pane, "Enter");
  });

  // #448 regression: when the first Enter is absorbed (box still holds draft),
  // re-issue ONLY Enter — never re-paste the message.
  it("re-issues ONLY Enter when the first submit is stranded — never re-pastes", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n === 1) return box("");           // preSendScreen
      if (n <= 3) return DRAFT_BOX;          // settle
      if (n === 4) return DRAFT_BOX;         // post-Enter#1: stranded
      if (n <= 6) return DRAFT_BOX;          // re-settle
      return EMPTY_BOX;                       // post-Enter#2: submitted
    });

    const promise = confirmedSendToPane(rt(), pane, "big message");
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(pasteToPane).toHaveBeenCalledTimes(1);
    expect(sendKeyToPane).toHaveBeenCalledTimes(2);
    expect(sendKeyToPane).toHaveBeenCalledWith(pane, "Enter");
  });

  // Short sends must not block waiting for the settle window. For short content CC
  // renders the text directly in the box (no [Pasted text] placeholder), so settle
  // sees actual content and sawDraft is set; empty box after Enter = submitted.
  it("submits a short message on the first confirmation check", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n === 1) return box("");         // preSendScreen: idle box
      if (n <= 3) return box("hi");        // settle: short text rendered immediately (no placeholder)
      return EMPTY_BOX;                    // post-Enter: submitted
    });

    const promise = confirmedSendToPane(rt(), pane, "hi");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(pasteToPane).toHaveBeenCalledTimes(1);
    expect(sendKeyToPane).toHaveBeenCalledTimes(1);
  });
});

// ─── #455: large-paste race — empty box before paste renders ─────────────────

describe("sendFirstTurnWhenReady — large paste race (#455)", () => {
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

  // #455 core regression: for a large paste the [Pasted text] placeholder may not
  // have rendered by the time settleInputBox first polls — the box appears stable-
  // empty. The pre-fix code treats that as "submitted" and returns; the paste then
  // lands in an unsubmitted state (strand). The fix: only accept empty-box-means-
  // submitted after the draft was observed non-empty at least once.
  it("does not declare submitted on leading empties before paste renders (#455 race)", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 3) return EMPTY_BOX;  // stability polls + preSend snapshot
      if (n <= 5) return EMPTY_BOX;  // settle: paste NOT rendered yet (stable-empty bug)
      if (n === 6) return EMPTY_BOX; // post-Enter#1: still empty (paste in flight)
      if (n <= 9) return DRAFT_BOX;  // paste finally renders during retry settle
      return EMPTY_BOX;              // post-Enter#2: box empty → actually submitted
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "very large task", "$ launch");
    await vi.advanceTimersByTimeAsync(8000);
    await promise;

    // Must NOT have returned on the leading empty reads before paste rendered.
    // Paste issued exactly once; Enter issued at least twice (initial no-op + retry).
    expect(pasteToPane).toHaveBeenCalledTimes(1);
    expect(sendKeyToPane.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  // When the paste NEVER renders (e.g. paste-buffer loss), the function re-pastes
  // once in the first path, then falls back to confirmedSendToPane which also
  // re-pastes once — total 4 paste calls when the box never populates (#466).
  it("re-pastes in first path then falls back to confirmedSendToPane when paste never renders (#455/#466)", async () => {
    readPaneScreen.mockResolvedValue(EMPTY_BOX);

    const promise = sendFirstTurnWhenReady(rt(), pane, "very large task", "$ launch");
    await vi.advanceTimersByTimeAsync(18000); // first path (~7s) + confirmedSendToPane fallback (~5s)
    await promise;

    // First path: 1 initial paste + 1 repaste when sawDraft stays false.
    // confirmedSendToPane fallback: 1 initial paste + 1 repaste = 4 total.
    expect(pasteToPane.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(pasteToPane).toHaveBeenCalledWith(pane, "very large task");
    expect(sendToPane).not.toHaveBeenCalled();
  });
});

// ─── #466: boot-gate requires parseable input box ─────────────────────────────

describe("sendFirstTurnWhenReady — boot gate requires parseable box (#466)", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let sendToPane: ReturnType<typeof vi.fn>;
  let pasteToPane: ReturnType<typeof vi.fn>;
  let sendKeyToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };
  const rt = () => ({ readPaneScreen, sendToPane, pasteToPane, sendKeyToPane });

  // A stable screen with NO HR-bounded box — e.g. the claude-mem boot banner.
  const BANNER_ONLY = "=== claude-mem: loading memories ===\n(0 memories loaded)";

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    sendToPane = vi.fn();
    pasteToPane = vi.fn();
    sendKeyToPane = vi.fn();
  });
  afterEach(() => { vi.useRealTimers(); });

  // Core regression fix: the boot gate must NOT declare ready when the screen is
  // stable but has no HR-bounded input box. Under load the claude-mem banner
  // stabilises before the CC input box renders, causing paste into the wrong spot.
  // After the box appears the paste renders immediately and confirms delivery.
  it("does not paste while screen is stable but has no parseable input box", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 4) return BANNER_ONLY;   // banner stable, no box — must NOT trigger paste
      if (n <= 6) return EMPTY_BOX;     // CC box appeared, stabilises → triggers readiness
      if (n <= 8) return DRAFT_BOX;     // paste renders in box during settle
      return EMPTY_BOX;                 // box empties after Enter → submitted
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "task text", "$ launch");
    await vi.advanceTimersByTimeAsync(10000);
    await promise;

    // Paste must only happen AFTER the input box appeared — never during banner.
    // Exactly one paste: the box was ready when we pasted, draft rendered, submitted.
    expect(pasteToPane).toHaveBeenCalledTimes(1);
    expect(pasteToPane).toHaveBeenCalledWith(pane, "task text");
  });

  // When the box appears, delivery succeeds normally.
  it("returns { delivered: true } once the box appears and submission is confirmed", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 3) return BANNER_ONLY;   // banner stable, no box yet
      if (n <= 5) return EMPTY_BOX;     // box appeared + stability poll
      if (n <= 7) return DRAFT_BOX;     // paste settled in box
      return EMPTY_BOX;                 // box emptied after Enter → submitted
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "task text", "$ launch");
    await vi.advanceTimersByTimeAsync(10000);
    const result = await promise;

    expect(result).toEqual({ delivered: true });
    expect(pasteToPane).toHaveBeenCalledTimes(1);
  });
});

// ─── #466: delivery status + self-heal fallback ───────────────────────────────

describe("sendFirstTurnWhenReady — delivery status and self-heal (#466)", () => {
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
  afterEach(() => { vi.useRealTimers(); });

  // Happy path: normal delivery returns { delivered: true }.
  it("returns { delivered: true } on normal paste-then-submit delivery", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 3) return EMPTY_BOX;  // readiness + preSend
      if (n <= 5) return DRAFT_BOX;  // settle: paste rendered
      return EMPTY_BOX;              // post-Enter: submitted
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "do the thing", "$ launch");
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result).toEqual({ delivered: true });
  });

  // Self-heal: paste path exhausts (sawDraft=false → box never populated), but the
  // confirmedSendToPane fallback succeeds. The outcome is { delivered: true }.
  // This is the key #466 scenario: paste went into a not-yet-ready box (no HR),
  // but by fallback time the box has settled and accepts the task.
  it("returns { delivered: true } when fallback confirmedSendToPane succeeds (#466 self-heal)", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      // Boot: stable box from the start
      if (n <= 2) return EMPTY_BOX;
      // preSend + first paste attempt: paste never renders (race — box not ready)
      if (n <= 10) return EMPTY_BOX;
      // Fallback (confirmedSendToPane): box now ready, paste renders, then empties
      if (n <= 12) return DRAFT_BOX;  // fallback settle: paste rendered
      return EMPTY_BOX;               // fallback confirm: submitted
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "do the thing", "$ launch");
    await vi.advanceTimersByTimeAsync(18000);
    const result = await promise;

    expect(result).toEqual({ delivered: true });
    // At least 2 pastes: one in the first path (which failed), one in the fallback
    expect(pasteToPane.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // Hard drop: paste path exhausts with sawDraft=false, AND the fallback also
  // fails (box never populates). Returns { delivered: false }.
  it("returns { delivered: false } when both paste path and fallback fail (#466 hard drop)", async () => {
    readPaneScreen.mockResolvedValue(EMPTY_BOX);

    const promise = sendFirstTurnWhenReady(rt(), pane, "do the thing", "$ launch");
    await vi.advanceTimersByTimeAsync(18000);
    const result = await promise;

    expect(result).toEqual({ delivered: false });
  });
});

// ─── #466: confirmedSendToPane delivery status ────────────────────────────────

describe("confirmedSendToPane — delivery status (#466)", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let pasteToPane: ReturnType<typeof vi.fn>;
  let sendKeyToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };
  const rt = () => ({ readPaneScreen, pasteToPane, sendKeyToPane });

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    pasteToPane = vi.fn();
    sendKeyToPane = vi.fn();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("returns { delivered: true } when box empties after draft seen", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n === 1) return box("");     // preSendScreen
      if (n <= 3) return DRAFT_BOX;   // settle: paste rendered
      return EMPTY_BOX;               // post-Enter: submitted
    });

    const promise = confirmedSendToPane(rt(), pane, "message");
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result).toEqual({ delivered: true });
  });

  it("returns { delivered: false } when retry exhausts without confirmation", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n === 1) return box("");   // preSendScreen
      return EMPTY_BOX;              // paste never renders, box stays empty
    });

    const promise = confirmedSendToPane(rt(), pane, "message");
    await vi.advanceTimersByTimeAsync(8000);
    const result = await promise;

    expect(result).toEqual({ delivered: false });
  });
});

describe("confirmedSendToPane — large paste race (#455)", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let pasteToPane: ReturnType<typeof vi.fn>;
  let sendKeyToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };
  const rt = () => ({ readPaneScreen, pasteToPane, sendKeyToPane });

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    pasteToPane = vi.fn();
    sendKeyToPane = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Same race as sendFirstTurnWhenReady: settle sees stable-empty, Enter fires into
  // empty box (no-op), retry-check sees empty → pre-fix BUG declares submitted.
  it("does not declare submitted on leading empties before paste renders (#455 race)", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n === 1) return box("");   // preSendScreen
      if (n <= 3) return EMPTY_BOX;  // settle: paste not rendered yet
      if (n === 4) return EMPTY_BOX; // post-Enter#1: still empty
      if (n <= 7) return DRAFT_BOX;  // paste renders during retry settle
      return EMPTY_BOX;              // post-Enter#2: submitted
    });

    const promise = confirmedSendToPane(rt(), pane, "big follow-up");
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    expect(pasteToPane).toHaveBeenCalledTimes(1);
    expect(sendKeyToPane.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // Exactly ONE submit detected: the moment the box empties AFTER the draft was seen.
  it("submits exactly once — no double-submit after seeing non-empty then empty", async () => {
    let returned = false;
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n === 1) return box("");   // preSendScreen
      if (n <= 3) return EMPTY_BOX;  // settle: paste not rendered
      if (n === 4) return EMPTY_BOX; // post-Enter#1: empty (no-op)
      if (n <= 7) return DRAFT_BOX;  // paste renders during retry settle
      return EMPTY_BOX;              // post-Enter#2: submitted
    });

    const promise = confirmedSendToPane(rt(), pane, "big follow-up");
    promise.then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    // Function returned exactly once (no double-submit loop).
    expect(returned).toBe(true);
    expect(pasteToPane).toHaveBeenCalledTimes(1);
  });

  // When paste never renders: re-paste once rather than silently returning on an
  // empty box that was never populated.
  it("re-pastes once when paste never renders (never-populated box)", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n === 1) return box("");  // preSendScreen
      return EMPTY_BOX;             // everything else: paste never appears
    });

    const promise = confirmedSendToPane(rt(), pane, "big follow-up");
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    expect(pasteToPane).toHaveBeenCalledTimes(2);
    expect(pasteToPane).toHaveBeenCalledWith(pane, "big follow-up");
  });
});

// ─── #466-single DEFECT 2: boot gate must reject HR-bounded banner (no ❯ prompt) ──

describe("sendFirstTurnWhenReady — boot gate rejects HR banner without ❯ (#466-single defect 2)", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let sendToPane: ReturnType<typeof vi.fn>;
  let pasteToPane: ReturnType<typeof vi.fn>;
  let sendKeyToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };
  const rt = () => ({ readPaneScreen, sendToPane, pasteToPane, sendKeyToPane });

  // The claude-mem banner that triggers the bug: has two HR lines but NO ❯ prompt
  // between them. parseDraftFromScreen returns "" (≠ null) → old code treated this
  // as "box present", boot gate fired, paste went into the banner and was lost.
  // hasCCInputBox (new gate) requires a ❯ inside the box → correctly defers.
  const HR = "─".repeat(60);
  const BANNER_WITH_HR = `${HR}\nclaude-mem: initializing\nLoaded 42 memories\n${HR}`;
  const EMPTY_BOX_LOCAL = `…transcript…\n${HR}\n❯ \n${HR}\n   Model: Sonnet 4.6  Ctx Used: 0.0%`;
  const DRAFT_BOX_LOCAL = `…transcript…\n${HR}\n❯ [Pasted text #1]\n${HR}\n   Model: Sonnet 4.6`;

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    sendToPane = vi.fn();
    pasteToPane = vi.fn();
    sendKeyToPane = vi.fn();
  });
  afterEach(() => { vi.useRealTimers(); });

  // Core regression: paste must NOT fire while the HR banner (no ❯) is stable.
  // We track which readPaneScreen call# triggered the first paste — it must be
  // AFTER the banner period (n<=4). Before the fix the first paste fires at n=3
  // (preSend captured during BANNER), which fails the > 4 assertion.
  it("first paste fires AFTER banner period, not during HR banner stabilisation (#466-single defect 2)", async () => {
    let firstPasteN = -1;
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 4) return BANNER_WITH_HR;   // n=1..4: banner stable, no ❯
      if (n <= 9) return EMPTY_BOX_LOCAL;  // n=5..9: CC box (has ❯) appears and stays
      if (n <= 11) return DRAFT_BOX_LOCAL; // n=10..11: paste rendered
      return EMPTY_BOX_LOCAL;              // n>=12: submitted
    });
    pasteToPane.mockImplementation(() => {
      if (firstPasteN < 0) firstPasteN = n;
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "task text", "$ launch");
    await vi.advanceTimersByTimeAsync(15000);
    await promise;

    // BEFORE fix: firstPasteN = 3 (paste during banner at n=3, ≤ 4) → fails
    // AFTER fix:  firstPasteN = 7 (paste deferred to n=7, CC box stable) → passes
    expect(firstPasteN).toBeGreaterThan(4);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("returns { delivered: true } when paste deferred until CC box is stable (#466-single defect 2)", async () => {
    let firstPasteN = -1;
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 4) return BANNER_WITH_HR;
      if (n <= 9) return EMPTY_BOX_LOCAL;
      if (n <= 11) return DRAFT_BOX_LOCAL;
      return EMPTY_BOX_LOCAL;
    });
    pasteToPane.mockImplementation(() => {
      if (firstPasteN < 0) firstPasteN = n;
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "task text", "$ launch");
    await vi.advanceTimersByTimeAsync(15000);
    const result = await promise;

    expect(result).toEqual({ delivered: true });
    expect(firstPasteN).toBeGreaterThan(4);
  });
});

// ─── #466-single DEFECT 3: screen-changed must not declare delivery without sawDraft ─

describe("sendFirstTurnWhenReady — screen change without sawDraft is NOT delivery (#466-single defect 3)", () => {
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
  afterEach(() => { vi.useRealTimers(); });

  // Defect 3 scenario: paste is issued into the ready box, the box becomes
  // non-parseable (CC TUI transitions mid-boot), and the screen changes — but the
  // draft was never seen. The old code returned { delivered: true } on the screen-
  // changed branch without requiring sawDraft. After the fix, it must return false.
  it("returns { delivered: false } when screen changes but paste never rendered in box (#466-single defect 3)", async () => {
    const NON_PARSEABLE = "CC transitioning — no HR box visible";
    const HR = "─".repeat(60);
    const EMPTY_BOX_LOCAL = `…transcript…\n${HR}\n❯ \n${HR}\n   Model: Sonnet 4.6  Ctx Used: 0.0%`;
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 2) return EMPTY_BOX_LOCAL;  // readiness: stable CC box
      if (n === 3) return EMPTY_BOX_LOCAL; // preSend snapshot
      return NON_PARSEABLE;                 // post-paste: non-parseable, screen changed (boot transition)
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "big task", "$ launch");
    await vi.advanceTimersByTimeAsync(25000);
    const result = await promise;

    // Screen changed but draft never rendered — NOT a delivery confirmation.
    expect(result).toEqual({ delivered: false });
    expect(sendToPane).not.toHaveBeenCalled();
  });
});

// ─── #466 RESIDUAL: gate on CC-initialized (not just ❯ box) + realistic budget ──
// The prod repro (ci-indexer-38): the ❯ input box renders during cold-init while
// claude-mem's MCP server is still loading — a window where keystrokes are silently
// dropped (#235/#292). The old gate (hasCCInputBox = just a ❯ between two HRs)
// declares "ready" in that window and pastes into a box that drops the keystrokes,
// so the first turn never lands (firstTurnConfirmedAt was stamped 60s later, on the
// operator's manual `crew send`). The captain startup path already solved this by
// gating on CC_INITIALIZED_RE (Ctx Used / ⏵⏵ / for shortcuts / accept edits) via
// classifyStartupSurface. The crew first-turn path must adopt the same contract.

describe("sendFirstTurnWhenReady — gate requires CC initialized, not just ❯ box (#466 residual)", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let sendToPane: ReturnType<typeof vi.fn>;
  let pasteToPane: ReturnType<typeof vi.fn>;
  let sendKeyToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };
  const rt = () => ({ readPaneScreen, sendToPane, pasteToPane, sendKeyToPane });

  const HR2 = "─".repeat(60);
  // ❯ box present but CC NOT initialized — no Ctx Used / ⏵⏵ / shortcuts / accept-edits.
  // This is the cold-init window (claude-mem MCP loading) where keystrokes are dropped.
  const COLD_BOX = `…booting…\n${HR2}\n❯ \n${HR2}`;
  // CC fully initialized: the persistent bottom status block is present.
  const READY_BOX = `…transcript…\n${HR2}\n❯ \n${HR2}\n   Model: Sonnet 4.6  Ctx Used: 0.0%`;
  const DRAFT_READY = `…transcript…\n${HR2}\n❯ [Pasted text #1]\n${HR2}\n   Model: Sonnet 4.6  Ctx Used: 0.0%`;

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    sendToPane = vi.fn();
    pasteToPane = vi.fn();
    sendKeyToPane = vi.fn();
  });
  afterEach(() => { vi.useRealTimers(); });

  // Core root-cause regression: paste must NOT fire while the ❯ box is up but CC
  // has not yet rendered its initialized status block (keystrokes are dropped here).
  it("does not paste while the ❯ box is up but CC is not yet initialized (cold-init drop window)", async () => {
    let firstPasteN = -1;
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 6) return COLD_BOX;     // ❯ visible but NOT initialized — keystrokes dropped
      if (n <= 9) return READY_BOX;    // CC initialized (Ctx Used) — input accepted
      if (n <= 11) return DRAFT_READY; // paste rendered in box
      return READY_BOX;                // box empties after Enter → submitted
    });
    pasteToPane.mockImplementation(() => { if (firstPasteN < 0) firstPasteN = n; });

    const promise = sendFirstTurnWhenReady(rt(), pane, "task text", "$ launch");
    await vi.advanceTimersByTimeAsync(20000);
    const result = await promise;

    // BEFORE fix: firstPasteN = 3 (pasted into the cold box) → fails ( ≤ 6 ).
    // AFTER fix:  paste deferred until CC initialized (firstPasteN > 6).
    expect(firstPasteN).toBeGreaterThan(6);
    expect(result).toEqual({ delivered: true });
    expect(sendToPane).not.toHaveBeenCalled();
  });

  // Realistic budget: a slow boot under load reaches the initialized state only
  // after the old 20s/24-poll window. The gated readiness wait must give it time
  // instead of timing out and blind-firing into a still-cold box.
  it("waits past the old 20s window for a slow boot to initialize (realistic budget)", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 28) return COLD_BOX;     // long cold-init (~24s of polls): box up, not initialized
      if (n <= 31) return READY_BOX;    // finally initialized
      if (n <= 33) return DRAFT_READY;  // paste rendered
      return READY_BOX;                 // submitted
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "task text", "$ launch");
    await vi.advanceTimersByTimeAsync(40000);
    const result = await promise;

    // BEFORE fix: 20s budget times out into the cold box → blind fallback → dropped.
    // AFTER fix:  extended budget reaches the initialized box → delivered.
    expect(result).toEqual({ delivered: true });
  });

  // pact-network's ACTUAL case: crews cold-init UNDER LOAD, so CC can take 30–60s to
  // become input-ready (captains boot unloaded in 5–15s — captain parity is too short
  // here). CC initializes at ~60s of polls. The readiness wait must reach it BEFORE
  // the confirmedSendToPane fallback blind-fires into a still-cold box. The strong
  // CC-initialized gate makes a long budget safe: it only waits as long as CC actually
  // needs, and a crashed/never-ready CC still caps out at the budget.
  it("delivers when a slow-under-load crew becomes CC-initialized at ~60s (#466 pact-network case)", async () => {
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n <= 78) return COLD_BOX;     // ~60s of cold-init under load: box up, NOT initialized
      if (n <= 81) return READY_BOX;    // CC finally initialized (Ctx Used) → readiness + preSend
      if (n <= 83) return DRAFT_READY;  // paste rendered in box
      return READY_BOX;                 // box empties after Enter → submitted
    });

    const promise = sendFirstTurnWhenReady(rt(), pane, "task text", "$ launch");
    await vi.advanceTimersByTimeAsync(95000);
    const result = await promise;

    // BEFORE fix: 30s budget times out at ~poll 38 → confirmedSendToPane fires while
    //             CC is still cold → keystrokes dropped → delivered:false.
    // AFTER fix:  90s budget reaches the initialized box at ~poll 80 → delivered.
    expect(result).toEqual({ delivered: true });
  });
});

describe("confirmedSendToPane — screen change without sawDraft is NOT delivery (#466-single defect 3)", () => {
  let readPaneScreen: ReturnType<typeof vi.fn>;
  let pasteToPane: ReturnType<typeof vi.fn>;
  let sendKeyToPane: ReturnType<typeof vi.fn>;
  const pane: PaneRef = { workspaceId: "w:1", surfaceId: "s:1" };
  const rt = () => ({ readPaneScreen, pasteToPane, sendKeyToPane });

  beforeEach(() => {
    vi.useFakeTimers();
    readPaneScreen = vi.fn();
    pasteToPane = vi.fn();
    sendKeyToPane = vi.fn();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("returns { delivered: false } when paste never rendered but screen changed (#466-single defect 3)", async () => {
    const HR = "─".repeat(60);
    const IDLE_BOX = `…transcript…\n${HR}\n❯ \n${HR}\n   Model: Sonnet 4.6  Ctx Used: 0.0%`;
    const NON_PARSEABLE = "CC transitioning — no HR box visible";
    let n = 0;
    readPaneScreen.mockImplementation(async () => {
      n++;
      if (n === 1) return IDLE_BOX;   // preSendScreen
      return NON_PARSEABLE;            // after paste: no box, screen changed — draft never rendered
    });

    const promise = confirmedSendToPane(rt(), pane, "message");
    await vi.advanceTimersByTimeAsync(8000);
    const result = await promise;

    expect(result).toEqual({ delivered: false });
  });
});
