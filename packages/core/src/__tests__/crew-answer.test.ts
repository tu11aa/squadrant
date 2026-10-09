// Unit tests for crew-answer.ts (#592) — deliberately answering a crew's open
// AskUserQuestion/permission SELECTION MODAL. Uses mock deps: no daemon, no
// workspaces, no real cmux keystrokes.

import { describe, it, expect, vi } from "vitest";
import { runCrewAnswer } from "../crew-answer.js";
import type { RuntimeDriver, PaneRef, ModalOption } from "@squadrant/shared";

const PROJECT = "myproj";
// cmux 0.65 (B2): crew answer deliberately types into an open dialog, so every
// keystroke and paste must bypass cmux's dialog guard.
const FORCE = { force: true };

function makePaneRef(suffix = "5"): PaneRef {
  return { workspaceId: "workspace:1", surfaceId: `surface:${suffix}` };
}

function makeRuntime(existingSurfaces: PaneRef[] = []): RuntimeDriver {
  return {
    name: "mock",
    probe: vi.fn(),
    list: vi.fn(),
    status: vi.fn(),
    spawn: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(),
    stop: vi.fn(),
    newPane: vi.fn(),
    closePane: vi.fn(),
    sendToPane: vi.fn(),
    pasteToPane: vi.fn().mockResolvedValue(undefined),
    sendKeyToPane: vi.fn().mockResolvedValue(undefined),
    readPaneScreen: vi.fn().mockResolvedValue(""),
    listSurfaces: vi.fn().mockResolvedValue(existingSurfaces),
    spawnInjector: vi.fn(),
    sendToSurface: vi.fn(),
  } as unknown as RuntimeDriver;
}

const THREE_OPTIONS: ModalOption[] = [
  { index: 1, label: "Red", highlighted: true },
  { index: 2, label: "Blue", highlighted: false },
  { index: 3, label: "Green", highlighted: false },
];

// #856: readModalOptions now returns the options plus the arrow axis that moves
// the selection — claude's ❯ list is vertical (Up/Down), opencode's ⇆ bar is
// horizontal (Left/Right). The claude mocks keep their option set and add the axis.
const VERTICAL_MODAL = { options: THREE_OPTIONS, axis: "vertical" as const };

describe("runCrewAnswer", () => {
  it("throws when crew pane not found", async () => {
    const runtime = makeRuntime([]);
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "1", runtime, "workspace:1", {
        readModalOptions: vi.fn(),
      }),
    ).rejects.toThrow("Crew 'crew-1' not found");
  });

  it("refuses when no option list is visible (nothing to answer)", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "1", runtime, "workspace:1", {
        readModalOptions: vi.fn().mockResolvedValue(null),
      }),
    ).rejects.toThrow(/no interactive option prompt visible/i);
    expect(runtime.sendKeyToPane).not.toHaveBeenCalled();
  });

  it("resolves an option by 1-based index and drives Down/Enter from the highlighted row", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(VERTICAL_MODAL).mockResolvedValueOnce(null);
    const result = await runCrewAnswer(PROJECT, "crew-1", "3", runtime, "workspace:1", { readModalOptions });
    // highlighted is index 1, target is index 3 → two Down presses, then Enter.
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(1, expect.anything(), "Down", FORCE);
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(2, expect.anything(), "Down", FORCE);
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(3, expect.anything(), "Enter", FORCE);
    expect(runtime.sendKeyToPane).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ selected: { index: 3, label: "Green", highlighted: false }, closed: true });
  });

  it("resolves an option by exact text match, case-insensitive", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(VERTICAL_MODAL).mockResolvedValueOnce(null);
    const result = await runCrewAnswer(PROJECT, "crew-1", "blue", runtime, "workspace:1", { readModalOptions });
    expect(result.selected).toEqual({ index: 2, label: "Blue", highlighted: false });
  });

  it("resolves an option by unambiguous text prefix", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(VERTICAL_MODAL).mockResolvedValueOnce(null);
    const result = await runCrewAnswer(PROJECT, "crew-1", "Gr", runtime, "workspace:1", { readModalOptions });
    expect(result.selected).toEqual({ index: 3, label: "Green", highlighted: false });
  });

  it("throws when the index has no matching option", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValue(VERTICAL_MODAL);
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "9", runtime, "workspace:1", { readModalOptions }),
    ).rejects.toThrow(/No option 9/);
    expect(runtime.sendKeyToPane).not.toHaveBeenCalled();
  });

  it("throws when the text has no matching option", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValue(VERTICAL_MODAL);
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "Purple", runtime, "workspace:1", { readModalOptions }),
    ).rejects.toThrow(/No option matches "Purple"/);
  });

  // #592: option order is model-generated and can shift between renders —
  // --expect refuses rather than silently confirming the wrong option.
  it("--expect refuses when the resolved option's label doesn't contain the expected text", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValue(VERTICAL_MODAL);
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "2", runtime, "workspace:1", { readModalOptions }, { expect: "Green" }),
    ).rejects.toThrow(/Refusing.*does not contain expected text "Green"/s);
    expect(runtime.sendKeyToPane).not.toHaveBeenCalled();
  });

  it("--expect passes when the resolved option's label contains the expected text", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(VERTICAL_MODAL).mockResolvedValueOnce(null);
    const result = await runCrewAnswer(
      PROJECT, "crew-1", "2", runtime, "workspace:1", { readModalOptions }, { expect: "blue" },
    );
    expect(result.selected).toEqual({ index: 2, label: "Blue", highlighted: false });
  });

  it("forces every keystroke and paste (cmux 0.65 dialog guard, B2)", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const options: ModalOption[] = [
      { index: 1, label: "Red", highlighted: true },
      { index: 2, label: "Type something.", highlighted: false },
    ];
    const readModalOptions = vi.fn().mockResolvedValueOnce({ options, axis: "vertical" }).mockResolvedValueOnce(null);
    await runCrewAnswer(PROJECT, "crew-1", "2", runtime, "workspace:1", { readModalOptions }, { text: "x" });
    const calls = [...vi.mocked(runtime.sendKeyToPane).mock.calls, ...vi.mocked(runtime.pasteToPane).mock.calls];
    expect(calls.length).toBe(4);
    for (const c of calls) expect(c[2]).toEqual(FORCE);
  });

  it("reports closed:false when the modal is still visible after driving the selection", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValue(VERTICAL_MODAL); // still open on re-read
    const result = await runCrewAnswer(PROJECT, "crew-1", "1", runtime, "workspace:1", { readModalOptions });
    expect(result.closed).toBe(false);
  });

  it("--text types a free-text answer after selecting the option", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const options: ModalOption[] = [
      { index: 1, label: "Red", highlighted: true },
      { index: 2, label: "Type something.", highlighted: false },
    ];
    const readModalOptions = vi.fn().mockResolvedValueOnce({ options, axis: "vertical" }).mockResolvedValueOnce(null);
    await runCrewAnswer(
      PROJECT, "crew-1", "2", runtime, "workspace:1", { readModalOptions }, { text: "Use branch main" },
    );
    expect(runtime.pasteToPane).toHaveBeenCalledWith(expect.anything(), "Use branch main", FORCE);
    // Down (to option 2), Enter (select), then a second Enter to submit the typed text.
    expect(runtime.sendKeyToPane).toHaveBeenCalledTimes(3);
    expect(runtime.sendKeyToPane).toHaveBeenLastCalledWith(expect.anything(), "Enter", FORCE);
  });

  it("logs which option it is about to select before driving it", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(VERTICAL_MODAL).mockResolvedValueOnce(null);
    const log = vi.fn();
    await runCrewAnswer(PROJECT, "crew-1", "1", runtime, "workspace:1", { readModalOptions, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('selecting 1. "Red"'));
  });

  // #856: an opencode permission dialog lays its options out in a ⇆ bar, so the
  // selection moves with Left/Right (NOT claude's Up/Down) and confirms with Enter.
  const OPENCODE_MODAL = {
    options: [
      { index: 1, label: "Allow once", highlighted: true },
      { index: 2, label: "Allow always", highlighted: false },
      { index: 3, label: "Reject", highlighted: false },
    ] as ModalOption[],
    axis: "horizontal" as const,
  };

  it("drives Right then Enter for an opencode permission dialog (horizontal axis)", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(OPENCODE_MODAL).mockResolvedValueOnce(null);
    const result = await runCrewAnswer(PROJECT, "crew-1", "Allow always", runtime, "workspace:1", { readModalOptions });
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(1, expect.anything(), "Right", FORCE);
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(2, expect.anything(), "Enter", FORCE);
    expect(runtime.sendKeyToPane).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ selected: { index: 2, label: "Allow always", highlighted: false }, closed: true });
  });

  it("sends only Enter when the opencode dialog's first option is already selected", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(OPENCODE_MODAL).mockResolvedValueOnce(null);
    await runCrewAnswer(PROJECT, "crew-1", "Allow once", runtime, "workspace:1", { readModalOptions });
    expect(runtime.sendKeyToPane).toHaveBeenCalledTimes(1);
    expect(runtime.sendKeyToPane).toHaveBeenCalledWith(expect.anything(), "Enter", FORCE);
  });

  it("drives two Rights to reach the opencode Reject option", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(OPENCODE_MODAL).mockResolvedValueOnce(null);
    await runCrewAnswer(PROJECT, "crew-1", "Reject", runtime, "workspace:1", { readModalOptions });
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(1, expect.anything(), "Right", FORCE);
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(2, expect.anything(), "Right", FORCE);
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(3, expect.anything(), "Enter", FORCE);
  });

  it("opencode --expect refuses on mismatch and lists the visible options", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValue(OPENCODE_MODAL);
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "Allow always", runtime, "workspace:1", { readModalOptions }, { expect: "Reject" }),
    ).rejects.toThrow(/Refusing.*does not contain expected text "Reject"/s);
    expect(runtime.sendKeyToPane).not.toHaveBeenCalled();
  });
});

// #918: structured answer through the runtime's optional findDialog/answerDialog.
describe("runCrewAnswer — runtime structured answer (#918)", () => {
  const dialog = { id: "question:r1", options: [{ index: 1, label: "Red" }, { index: 2, label: "Green" }] };
  const crew = () => makePaneRef("5");
  const setup = (over: Partial<RuntimeDriver> = {}) => {
    const runtime = makeRuntime([{ ...crew(), title: "🔧 myproj:crew-1" }]);
    Object.assign(runtime, { findDialog: vi.fn().mockResolvedValue(dialog), answerDialog: vi.fn().mockResolvedValue(true) }, over);
    const deps = { readModalOptions: vi.fn().mockResolvedValue(null), dialogMatch: vi.fn().mockResolvedValue({ agentSessionId: "s1" }) };
    return { runtime, deps };
  };

  it("answers by label with no keystrokes and never reads the screen", async () => {
    const { runtime, deps } = setup();
    const r = await runCrewAnswer(PROJECT, "crew-1", "2", runtime, "workspace:1", deps);
    expect(runtime.answerDialog).toHaveBeenCalledWith(dialog, { label: "Green" });
    expect(runtime.sendKeyToPane).not.toHaveBeenCalled();
    expect(deps.readModalOptions).not.toHaveBeenCalled();
    expect(r).toMatchObject({ selected: { index: 2, label: "Green" }, closed: true });
  });

  it("passes --text through as free text", async () => {
    const { runtime, deps } = setup();
    await runCrewAnswer(PROJECT, "crew-1", "2", runtime, "workspace:1", deps, { text: "teal" });
    expect(runtime.answerDialog).toHaveBeenCalledWith(dialog, { text: "teal" });
  });

  it("honours --expect before answering", async () => {
    const { runtime, deps } = setup();
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "1", runtime, "workspace:1", deps, { expect: "green" }),
    ).rejects.toThrow("Refusing");
    expect(runtime.answerDialog).not.toHaveBeenCalled();
  });

  it.each([
    ["no capability", { findDialog: undefined, answerDialog: undefined }, true],
    ["no match (non-claude agent)", {}, false],
    ["no pending dialog", { findDialog: vi.fn().mockResolvedValue(undefined) }, true],
    ["reply refused", { answerDialog: vi.fn().mockResolvedValue(false) }, true],
    ["reply throws", { answerDialog: vi.fn().mockRejectedValue(new Error("x")) }, true],
  ])("falls back to keystrokes: %s", async (_n, over, withMatch) => {
    const { runtime, deps } = setup(over as Partial<RuntimeDriver>);
    if (!withMatch) deps.dialogMatch.mockResolvedValue(undefined);
    deps.readModalOptions.mockResolvedValueOnce(VERTICAL_MODAL).mockResolvedValue(null);
    const r = await runCrewAnswer(PROJECT, "crew-1", "2", runtime, "workspace:1", deps);
    expect(runtime.sendKeyToPane).toHaveBeenCalledWith(expect.anything(), "Enter", FORCE);
    expect(r.closed).toBe(true);
  });
});

