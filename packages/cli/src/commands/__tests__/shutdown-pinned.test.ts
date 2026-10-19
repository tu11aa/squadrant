// src/commands/__tests__/shutdown-pinned.test.ts
// #999: `shutdown <p>` vs a PINNED captain workspace, driven through the REAL
// cmux driver against a fake cmux CLI that behaves like 0.65: it lists the
// workspace (pinned: true) and refuses `workspace close` while it is pinned.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const squadrantdCall = vi.hoisted(() => vi.fn());
vi.mock("../crew-control.js", () => ({ squadrantdCall }));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/shared")>("@squadrant/shared");
  return { ...actual, loadConfig, resolveCmuxBin: () => "/fake/cmux" };
});

// Fake cmux: one pinned captain workspace. Argv in, stdout/err out.
const cmux = vi.hoisted(() => {
  const state = { open: true, pinned: true, closeError: undefined as string | undefined };
  const calls: string[][] = [];
  function run(args: string[]): string {
    calls.push(args);
    const a = args.join(" ");
    if (a.startsWith("workspace list")) {
      return JSON.stringify({
        window_ref: "window:1",
        workspaces: state.open
          ? [{ ref: "workspace:1000030010", custom_title: "⚓ flooros-core-captain", has_custom_title: true, pinned: state.pinned }]
          : [],
      });
    }
    if (a.includes("--action unpin")) { state.pinned = false; return "OK"; }
    if (a.startsWith("workspace close")) {
      if (state.closeError) throw new Error(state.closeError);
      if (state.pinned) throw new Error("Error: protected: Pinned workspaces can't be closed while pinned. Unpin the workspace first.");
      state.open = false;
      return "OK";
    }
    return "";
  }
  return { state, calls, run };
});
vi.mock("node:child_process", () => ({
  execFile: (_bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    try { cb(null, cmux.run(args)); } catch (e) { cb(e as Error, ""); }
    return {};
  },
  execFileSync: vi.fn(),
}));

import { shutdownCommand } from "../shutdown.js";

describe("shutdown: pinned captain workspace (#999)", () => {
  let log: ReturnType<typeof vi.spyOn>;
  const output = () => log.mock.calls.map((c) => String(c[0])).join("\n");

  beforeEach(() => {
    Object.assign(cmux.state, { open: true, pinned: true, closeError: undefined });
    cmux.calls.length = 0;
    squadrantdCall.mockReset().mockResolvedValue([]);
    loadConfig.mockReturnValue({
      projects: { "flooros-core": { captainName: "⚓ flooros-core-captain", path: "/p/core" } },
      commandName: "command",
    });
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    log.mockRestore();
  });

  it("matches the pinned captain workspace, unpins it, and closes it", async () => {
    await shutdownCommand.parseAsync(["node", "shutdown", "flooros-core"]);

    expect(cmux.state.open).toBe(false);
    const cmds = cmux.calls.map((c) => c.join(" "));
    const unpin = cmds.findIndex((c) => c.includes("workspace:1000030010") && c.includes("--action unpin"));
    const close = cmds.findIndex((c) => c.startsWith("workspace close workspace:1000030010"));
    expect(unpin).toBeGreaterThanOrEqual(0);
    expect(unpin).toBeLessThan(close);
    expect(output()).toMatch(/Closed: ⚓ flooros-core-captain/);
    expect(output()).not.toMatch(/not found/);
  });

  it("prints the exact reason when the close is refused", async () => {
    cmux.state.closeError = "Error: confirmation_required: workspace has running processes";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await shutdownCommand.parseAsync(["node", "shutdown", "flooros-core"]);
    } finally {
      exit.mockRestore();
    }

    expect(output()).toMatch(/Failed to close: ⚓ flooros-core-captain — .*confirmation_required: workspace has running processes/);
  });
});
