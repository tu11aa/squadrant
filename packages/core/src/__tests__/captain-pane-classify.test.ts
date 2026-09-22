import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyCaptainPane,
  createCaptainPaneReader,
  hasModalOptionList,
  screenHash,
  PANE_IDLE_AFTER_MS,
} from "../crew-pane-reader.js";
import type { DirectCmuxReader } from "../interfaces.js";
import type { PaneRef } from "@squadrant/shared";
import { notePaneScreen, setPending, clearPending } from "../telegram/state.js";

const HR = "─".repeat(40);

/** An AskUserQuestion-shaped pane: two HRs with `N. Label` rows between. */
const LOCKED_PANE = [
  "some transcript above",
  HR,
  "❯ 1. Yes, proceed",
  "  2. No, stop",
  HR,
  "footer",
].join("\n");

const MID_TURN_PANE = ["✻ Working… (1m 20s · ↓ 3.2k tokens)", "esc to interrupt"].join("\n");

const IDLE_PANE = ["some transcript", "> ", "? for shortcuts"].join("\n");

describe("hasModalOptionList (#839 lock detection)", () => {
  it("detects the HR-bounded N. Label option list", () => {
    expect(hasModalOptionList(LOCKED_PANE)).toBe(true);
  });

  it("is false for a plain working/idle pane", () => {
    expect(hasModalOptionList(MID_TURN_PANE)).toBe(false);
    expect(hasModalOptionList(IDLE_PANE)).toBe(false);
    expect(hasModalOptionList("")).toBe(false);
  });
});

describe("classifyCaptainPane (#839)", () => {
  it("calls an open option modal LOCKED — a human must answer", () => {
    expect(classifyCaptainPane(LOCKED_PANE)).toEqual({ status: "locked" });
  });

  it("calls a visible turn MID-TURN — slow, not stuck", () => {
    expect(classifyCaptainPane(MID_TURN_PANE)).toEqual({ status: "mid-turn" });
  });

  it("never calls a live-but-quiet pane dead", () => {
    // No modal, no turn, but we have no staleness evidence → not "gone".
    expect(classifyCaptainPane(IDLE_PANE)).toEqual({ status: "mid-turn" });
  });

  it("reports no-session only with staleness evidence past the threshold", () => {
    expect(classifyCaptainPane(IDLE_PANE, { outputAgoMs: 30 * 60_000, idleAfterMs: 10 * 60_000 }))
      .toEqual({ status: "no-session" });
    expect(classifyCaptainPane(IDLE_PANE, { outputAgoMs: 1000, idleAfterMs: 10 * 60_000 }))
      .toEqual({ status: "mid-turn" });
  });

  it("reports unreadable — never 'dead' — when there is no screen (#834)", () => {
    expect(classifyCaptainPane(null)).toEqual({ status: "unreadable" });
    expect(classifyCaptainPane("   ")).toEqual({ status: "unreadable" });
  });

  it("prefers LOCKED over mid-turn when a modal is up during a working frame", () => {
    expect(classifyCaptainPane(`${MID_TURN_PANE}\n${LOCKED_PANE}`)).toEqual({ status: "locked" });
  });
});

describe("createCaptainPaneReader (#839)", () => {
  const pane: PaneRef = { workspaceId: "workspace:1", surfaceId: "surface:9", title: "demo-captain" };

  function reader(screen: string | null, over: Partial<DirectCmuxReader> = {}) {
    const cmux: DirectCmuxReader = {
      findWorkspaceId: vi.fn(async () => "workspace:1"),
      listSurfaces: vi.fn(async () => [pane]),
      readPaneScreen: vi.fn(async () => screen),
      ...over,
    };
    return { r: createCaptainPaneReader(cmux, (p) => `${p}-captain`), cmux };
  }

  it("classifies the captain's own pane", async () => {
    const { r, cmux } = reader(LOCKED_PANE);
    expect(await r("demo")).toEqual({ status: "locked" });
    expect(cmux.findWorkspaceId).toHaveBeenCalledWith("demo-captain");
  });

  it("treats a missing workspace as no-session", async () => {
    const { r } = reader(LOCKED_PANE, { findWorkspaceId: async () => null });
    expect(await r("demo")).toEqual({ status: "no-session" });
  });

  it("treats no surfaces as no-session", async () => {
    const { r } = reader(LOCKED_PANE, { listSurfaces: async () => [] });
    expect(await r("demo")).toEqual({ status: "no-session" });
  });

  it("degrades a cmux throw to unreadable, not dead (#834)", async () => {
    const log = vi.fn();
    const cmux: DirectCmuxReader = {
      findWorkspaceId: async () => { throw new Error("cmux socket down"); },
      listSurfaces: async () => [],
      readPaneScreen: async () => null,
    };
    const r = createCaptainPaneReader(cmux, (p) => `${p}-captain`, { log });
    expect(await r("demo")).toEqual({ status: "unreadable" });
    expect(log).toHaveBeenCalled();
  });

  it("returns unreadable when the screen read comes back null", async () => {
    const { r } = reader(null);
    expect(await r("demo")).toEqual({ status: "unreadable" });
  });
});

// The reviewer's must-fix: the staleness branch used to be unreachable in the
// REAL path (createCaptainPaneReader called classifyCaptainPane with no opts),
// so a rendered-but-dead captain read "mid-turn (working)" forever. These tests
// drive reader → persisted store → classifier end to end.
describe("real-path staleness: a rendered-but-dead pane becomes no-session (#839)", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-cap-pane-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const pane: PaneRef = { workspaceId: "workspace:1", surfaceId: "surface:9", title: "demo-captain" };
  const STATIC = ["some transcript", "> ", "? for shortcuts"].join("\n"); // no modal, no turn

  /** A reader wired exactly as squadrantd wires it, over a controllable clock. */
  function realReader(screen: () => string | null, now: () => number) {
    const cmux: DirectCmuxReader = {
      findWorkspaceId: async () => "workspace:1",
      listSurfaces: async () => [pane],
      readPaneScreen: async () => screen(),
    };
    return createCaptainPaneReader(cmux, (p) => `${p}-captain`, {
      noteScreen: (project, hash) => notePaneScreen(root, project, hash, now()),
    });
  }

  it("does not call the first quiet sighting dead — nothing to age against yet", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 0 });
    const r = realReader(() => STATIC, () => 0);
    expect(await r("demo")).toEqual({ status: "mid-turn" });
  });

  it("reports no-session once the SAME unchanged screen outlives the idle window", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 0 });
    let now = 0;
    const r = realReader(() => STATIC, () => now);

    // First poll records the screen; then the captain goes silent.
    expect(await r("demo")).toEqual({ status: "mid-turn" });
    now = PANE_IDLE_AFTER_MS - 1;
    expect(await r("demo")).toEqual({ status: "mid-turn" });
    now = PANE_IDLE_AFTER_MS;
    expect(await r("demo")).toEqual({ status: "no-session" });
  });

  it("keeps reporting mid-turn while the screen is still changing", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 0 });
    let now = 0;
    let n = 0;
    const r = realReader(() => `${STATIC}\nline ${n++}`, () => now);

    for (let i = 0; i < 5; i++) {
      expect(await r("demo")).toEqual({ status: "mid-turn" });
      now += PANE_IDLE_AFTER_MS * 2; // far past the window, but output keeps moving
    }
  });

  it("survives a restart: the staleness clock is the persisted one, not a fresh one", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 0 });
    let now = 0;
    const first = realReader(() => STATIC, () => now);
    await first("demo"); // records hash + changedAt=0

    // Daemon restarts → a brand-new reader. The old clock must still count.
    now = PANE_IDLE_AFTER_MS + 5_000;
    const afterRestart = realReader(() => STATIC, () => now);
    expect(await afterRestart("demo")).toEqual({ status: "no-session" });
  });

  it("a LOCKED pane is never aged into no-session", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 0 });
    let now = 0;
    const r = realReader(() => LOCKED_PANE, () => now);
    expect(await r("demo")).toEqual({ status: "locked" });
    now = PANE_IDLE_AFTER_MS * 10;
    expect(await r("demo")).toEqual({ status: "locked" });
  });

  it("a WORKING pane is never aged into no-session", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 0 });
    let now = 0;
    const r = realReader(() => MID_TURN_PANE, () => now);
    expect(await r("demo")).toEqual({ status: "mid-turn" });
    now = PANE_IDLE_AFTER_MS * 10;
    expect(await r("demo")).toEqual({ status: "mid-turn" });
  });

  it("does nothing when no delivery is pending (no pending entry to age)", async () => {
    clearPending(root, "demo");
    const r = realReader(() => STATIC, () => 0);
    // noteScreen returns undefined with no pending entry → not stale.
    expect(await r("demo")).toEqual({ status: "mid-turn" });
  });

  it("uses a real screen hash, not object identity", () => {
    expect(screenHash(STATIC)).toBe(screenHash(`${STATIC}`));
    expect(screenHash(STATIC)).not.toBe(screenHash(`${STATIC}\n`));
  });
});
