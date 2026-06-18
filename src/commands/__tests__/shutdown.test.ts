// src/commands/__tests__/shutdown.test.ts
// #225 root-fix Fix A: shutdown terminalization of non-terminal crew tasks.
import { describe, it, expect, vi, beforeEach } from "vitest";

const cockpitdCall = vi.hoisted(() => vi.fn());
vi.mock("../crew-control.js", () => ({ cockpitdCall }));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@cockpit/shared", async () => {
  const actual = await vi.importActual<typeof import("@cockpit/shared")>("@cockpit/shared");
  return { ...actual, loadConfig, resolveHome: (p: string) => p };
});

const stopMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const listMock = vi.hoisted(() => vi.fn());
vi.mock("@cockpit/workspaces", () => ({
  createCmuxDriver: () => ({}),
  RuntimeRegistry: class {
    forProject() { return { list: listMock, stop: stopMock }; }
    global() { return { list: listMock, stop: stopMock }; }
  },
}));

import { shutdownCommand } from "../shutdown.js";

describe("shutdown: crew task terminalization on captain close (#225 Fix A)", () => {
  beforeEach(() => {
    cockpitdCall.mockReset();
    listMock.mockReset();
    stopMock.mockReset();
    stopMock.mockResolvedValue(undefined);
  });

  it("sends task.cancelled for each non-terminal crew task, skips already-terminal", async () => {
    loadConfig.mockReturnValue({
      projects: {
        brove: { captainName: "⚓ brove", path: "/p/brove" },
      },
      commandName: "command",
    });
    // Captain workspace exists
    listMock.mockResolvedValue([{ id: "ws1", name: "⚓ brove" }]);
    // Daemon returns one working + one already-cancelled task
    cockpitdCall
      .mockResolvedValueOnce([
        { id: "t1", state: "working" },
        { id: "t2", state: "cancelled" },
      ])
      .mockResolvedValue({});

    await shutdownCommand.parseAsync(["node", "shutdown", "brove"]);

    expect(cockpitdCall).toHaveBeenCalledWith({ kind: "list", project: "brove" });
    expect(cockpitdCall).toHaveBeenCalledWith({
      kind: "event", project: "brove",
      event: { type: "task.cancelled", id: "t1", reason: "captain shutdown" },
    });
    // t2 is already cancelled — must NOT send a second task.cancelled
    const cancelEvents = cockpitdCall.mock.calls.filter(
      (args) => args[0]?.kind === "event" && args[0]?.event?.type === "task.cancelled",
    );
    expect(cancelEvents).toHaveLength(1);
  });

  it("daemon errors during terminalization do not prevent workspace close (try/catch)", async () => {
    loadConfig.mockReturnValue({
      projects: {
        brove: { captainName: "⚓ brove", path: "/p/brove" },
      },
      commandName: "command",
    });
    listMock.mockResolvedValue([{ id: "ws1", name: "⚓ brove" }]);
    // Daemon is unreachable
    cockpitdCall.mockRejectedValue(new Error("daemon down"));

    // Must not throw — cmux close still proceeds
    await expect(
      shutdownCommand.parseAsync(["node", "shutdown", "brove"]),
    ).resolves.not.toThrow();
    // Workspace was still closed despite daemon error
    expect(stopMock).toHaveBeenCalledWith("ws1");
  });
});
