import { describe, it, expect } from "vitest";

import { groupCommand } from "../group.js";

describe("groupCommand dispatch description", () => {
  it("registers a dispatch subcommand", () => {
    const dispatch = groupCommand.commands.find((c) => c.name() === "dispatch");
    expect(dispatch).toBeDefined();
    // [experimental] marker dropped once #288 boot-if-down path was fixed
    expect(dispatch!.description()).toMatch(/dispatch a task/i);
  });
});
