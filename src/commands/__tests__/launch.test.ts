// src/commands/__tests__/launch.test.ts
//
// #121 Issue B: a raw "Error: not_found: Pane not found" line leaked to the
// captain's terminal on `cockpit launch <project> --fresh`. Root cause: the
// select-workspace / current-workspace calls in launch.ts used the default
// execSync/execFileSync stdio, which forwards the child's stderr straight to
// the parent terminal. The fix routes them through cmuxLocal, which pipes
// (captures) fd 2 instead of inheriting it. These tests pin that contract.

import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  // launch.ts imports both; only execFileSync is exercised by cmuxLocal.
  execFileSync: execFileMock,
  execSync: vi.fn(),
}));

vi.mock("../../lib/cmux-bin.js", () => ({
  resolveCmuxBin: () => "/Applications/cmux.app/Contents/Resources/bin/cmux",
  resetCmuxBinCache: vi.fn(),
}));

import { cmuxLocal } from "../launch.js";

describe("cmuxLocal (launch.ts direct-cmux helper)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("invokes cmux via execFileSync with the argv array (no shell)", () => {
    execFileMock.mockReturnValue("");
    cmuxLocal(["select-workspace", "--workspace", "workspace:3"]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execFileMock.mock.calls[0];
    expect(bin).toContain("cmux");
    expect(args).toEqual(["select-workspace", "--workspace", "workspace:3"]);
  });

  it("pipes the child's stderr instead of inheriting it (the #121 leak fix)", () => {
    execFileMock.mockReturnValue("");
    cmuxLocal(["current-workspace"]);
    const opts = execFileMock.mock.calls[0][2] as { stdio?: unknown };
    expect(Array.isArray(opts.stdio)).toBe(true);
    const stdio = opts.stdio as unknown[];
    // fd 2 (stderr) must be captured, never forwarded to the parent terminal.
    expect(stdio[2]).toBe("pipe");
    expect(stdio[2]).not.toBe("inherit");
    expect(stdio).not.toContain("inherit");
  });

  it("returns trimmed stdout for callers that need the output", () => {
    execFileMock.mockReturnValue("  workspace:7 cockpit-captain  \n");
    expect(cmuxLocal(["current-workspace"])).toBe("workspace:7 cockpit-captain");
  });
});
