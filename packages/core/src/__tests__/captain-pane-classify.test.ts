import { describe, it, expect, vi } from "vitest";
import { classifyCaptainPane, createCaptainPaneReader, hasModalOptionList } from "../crew-pane-reader.js";
import type { DirectCmuxReader } from "../interfaces.js";
import type { PaneRef } from "@squadrant/shared";

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
