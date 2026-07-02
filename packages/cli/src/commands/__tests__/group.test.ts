import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchAction = vi.hoisted(() => vi.fn());
vi.mock("../dispatch.js", () => ({ dispatchAction }));

import { groupCommand } from "../group.js";

describe("groupCommand dispatch description", () => {
  it("registers a dispatch subcommand", () => {
    const dispatch = groupCommand.commands.find((c) => c.name() === "dispatch");
    expect(dispatch).toBeDefined();
    // [experimental] marker dropped once #288 boot-if-down path was fixed
    expect(dispatch!.description()).toMatch(/dispatch a task/i);
  });

  it("marks the subcommand as deprecated, pointing at 'squadrant dispatch'", () => {
    const dispatch = groupCommand.commands.find((c) => c.name() === "dispatch");
    expect(dispatch!.description()).toMatch(/deprecated/i);
    expect(dispatch!.description()).toMatch(/squadrant dispatch/);
  });
});

describe("groupCommand dispatch (deprecated alias)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("prints a one-line deprecation note and delegates to the shared dispatchAction", async () => {
    const dispatch = groupCommand.commands.find((c) => c.name() === "dispatch")!;
    await dispatch.parseAsync(["projB", "do something"], { from: "user" });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/deprecated.*squadrant dispatch/i));
    expect(dispatchAction).toHaveBeenCalledWith("projB", "do something", expect.any(Object));
  });
});
