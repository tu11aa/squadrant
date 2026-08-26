// Unit tests for crew-answer.ts (#592) — deliberately answering a crew's open
// AskUserQuestion/permission SELECTION MODAL. Uses mock deps: no daemon, no
// workspaces, no real cmux keystrokes.

import { describe, it, expect, vi } from "vitest";
import { runCrewAnswer } from "../crew-answer.js";
import type { RuntimeDriver, PaneRef, ModalOption } from "@squadrant/shared";

const PROJECT = "myproj";

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
    const readModalOptions = vi.fn().mockResolvedValueOnce(THREE_OPTIONS).mockResolvedValueOnce(null);
    const result = await runCrewAnswer(PROJECT, "crew-1", "3", runtime, "workspace:1", { readModalOptions });
    // highlighted is index 1, target is index 3 → two Down presses, then Enter.
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(1, expect.anything(), "Down");
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(2, expect.anything(), "Down");
    expect(runtime.sendKeyToPane).toHaveBeenNthCalledWith(3, expect.anything(), "Enter");
    expect(runtime.sendKeyToPane).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ selected: { index: 3, label: "Green", highlighted: false }, closed: true });
  });

  it("resolves an option by exact text match, case-insensitive", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(THREE_OPTIONS).mockResolvedValueOnce(null);
    const result = await runCrewAnswer(PROJECT, "crew-1", "blue", runtime, "workspace:1", { readModalOptions });
    expect(result.selected).toEqual({ index: 2, label: "Blue", highlighted: false });
  });

  it("resolves an option by unambiguous text prefix", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(THREE_OPTIONS).mockResolvedValueOnce(null);
    const result = await runCrewAnswer(PROJECT, "crew-1", "Gr", runtime, "workspace:1", { readModalOptions });
    expect(result.selected).toEqual({ index: 3, label: "Green", highlighted: false });
  });

  it("throws when the index has no matching option", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValue(THREE_OPTIONS);
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "9", runtime, "workspace:1", { readModalOptions }),
    ).rejects.toThrow(/No option 9/);
    expect(runtime.sendKeyToPane).not.toHaveBeenCalled();
  });

  it("throws when the text has no matching option", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValue(THREE_OPTIONS);
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "Purple", runtime, "workspace:1", { readModalOptions }),
    ).rejects.toThrow(/No option matches "Purple"/);
  });

  // #592: option order is model-generated and can shift between renders —
  // --expect refuses rather than silently confirming the wrong option.
  it("--expect refuses when the resolved option's label doesn't contain the expected text", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValue(THREE_OPTIONS);
    await expect(
      runCrewAnswer(PROJECT, "crew-1", "2", runtime, "workspace:1", { readModalOptions }, { expect: "Green" }),
    ).rejects.toThrow(/Refusing.*does not contain expected text "Green"/s);
    expect(runtime.sendKeyToPane).not.toHaveBeenCalled();
  });

  it("--expect passes when the resolved option's label contains the expected text", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(THREE_OPTIONS).mockResolvedValueOnce(null);
    const result = await runCrewAnswer(
      PROJECT, "crew-1", "2", runtime, "workspace:1", { readModalOptions }, { expect: "blue" },
    );
    expect(result.selected).toEqual({ index: 2, label: "Blue", highlighted: false });
  });

  it("reports closed:false when the modal is still visible after driving the selection", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValue(THREE_OPTIONS); // still open on re-read
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
    const readModalOptions = vi.fn().mockResolvedValueOnce(options).mockResolvedValueOnce(null);
    await runCrewAnswer(
      PROJECT, "crew-1", "2", runtime, "workspace:1", { readModalOptions }, { text: "Use branch main" },
    );
    expect(runtime.pasteToPane).toHaveBeenCalledWith(expect.anything(), "Use branch main");
    // Down (to option 2), Enter (select), then a second Enter to submit the typed text.
    expect(runtime.sendKeyToPane).toHaveBeenCalledTimes(3);
    expect(runtime.sendKeyToPane).toHaveBeenLastCalledWith(expect.anything(), "Enter");
  });

  it("logs which option it is about to select before driving it", async () => {
    const existing = { ...makePaneRef(), title: "🔧 myproj:crew-1" };
    const runtime = makeRuntime([existing]);
    const readModalOptions = vi.fn().mockResolvedValueOnce(THREE_OPTIONS).mockResolvedValueOnce(null);
    const log = vi.fn();
    await runCrewAnswer(PROJECT, "crew-1", "1", runtime, "workspace:1", { readModalOptions, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('selecting 1. "Red"'));
  });
});
