import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchToSibling = vi.hoisted(() => vi.fn());
const resolveCurrentProject = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/core", () => ({
  dispatchToSibling,
  resolveCurrentProject,
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", () => ({
  loadConfig,
}));

import { runDispatch, dispatchCommand } from "../dispatch.js";

describe("runDispatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockReturnValue({ projects: {} });
    resolveCurrentProject.mockReturnValue("projA");
  });

  it("dispatches to any registered project via the existing dispatchToSibling machinery", async () => {
    dispatchToSibling.mockResolvedValue({ id: "abcdef12", originProject: "projA", project: "projB" });

    const result = await runDispatch("projB", "do the thing", {});

    expect(dispatchToSibling).toHaveBeenCalledWith(
      expect.objectContaining({ fromProject: "projA", toProject: "projB", task: "do the thing" }),
    );
    expect(result.id).toBe("abcdef12");
  });

  it("throws when the current project cannot be resolved from cwd", async () => {
    resolveCurrentProject.mockReturnValue(null);
    await expect(runDispatch("projB", "task", {})).rejects.toThrow(/could not determine current project/i);
    expect(dispatchToSibling).not.toHaveBeenCalled();
  });

  it("propagates dispatchToSibling errors (e.g. cross-group down-captain no-boot)", async () => {
    dispatchToSibling.mockRejectedValue(
      new Error("cannot dispatch to 'projB': captain is not running and cross-group dispatch does not auto-boot it"),
    );
    await expect(runDispatch("projB", "task", {})).rejects.toThrow(/does not auto-boot/i);
  });
});

describe("dispatchCommand", () => {
  it("registers project/task arguments", () => {
    expect(dispatchCommand.name()).toBe("dispatch");
    expect(dispatchCommand.registeredArguments.map((a) => a.name())).toEqual(["project", "task"]);
  });
});
