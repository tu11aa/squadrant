import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchToSibling = vi.hoisted(() => vi.fn());
const resolveCurrentProject = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/core", () => ({
  dispatchToSibling,
  resolveCurrentProject,
  GROUP_DISPATCH_WARMUP_TIMEOUT_MS: 120_000,
}));

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

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

// #999: bootCaptain used to run `squadrant launch` with a 15s execSync timeout
// and map EVERY error — the timeout included — to "is squadrant installed?".
describe("runDispatch bootCaptain (#999)", () => {
  type ExecCb = (err: (Error & Record<string, unknown>) | null, stdout: string, stderr: string) => void;

  async function bootCaptainFrom(opts: { warmupTimeout?: number } = {}): Promise<(p: string) => Promise<void>> {
    dispatchToSibling.mockResolvedValue({ id: "abcdef12" });
    await runDispatch("projB", "task", opts);
    return dispatchToSibling.mock.calls.at(-1)![0].bootCaptain;
  }

  function execFails(err: Record<string, unknown>, stderr = ""): void {
    execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: ExecCb) => {
      cb(Object.assign(new Error("Command failed"), err), "", stderr);
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockReturnValue({ projects: {} });
    resolveCurrentProject.mockReturnValue("projA");
  });

  it("runs launch without a shell, bounded by the warmup budget instead of 15s", async () => {
    execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: ExecCb) => cb(null, "", ""));
    const boot = await bootCaptainFrom({ warmupTimeout: 240_000 });
    await boot("projB");
    expect(execFile).toHaveBeenCalledWith(
      "squadrant", ["launch", "projB"], expect.objectContaining({ timeout: 240_000 }), expect.any(Function),
    );

    execFile.mockClear();
    const bootDefault = await bootCaptainFrom();
    await bootDefault("projB");
    expect(execFile.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: 120_000 }));
  });

  it("surfaces launch's exit code and stderr when launch fails", async () => {
    execFails({ code: 1 }, "  ✘ Failed: cmux spawn did not return a workspace id\n");
    const boot = await bootCaptainFrom();
    const err = await boot("projB").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exit 1/);
    expect((err as Error).message).toMatch(/cmux spawn did not return a workspace id/);
    expect((err as Error).message).not.toMatch(/installed/);
  });

  it("reports a launch timeout as a timeout, not as a missing install", async () => {
    execFails({ killed: true, signal: "SIGTERM", code: null });
    const boot = await bootCaptainFrom();
    const err = await boot("projB").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/did not finish within 120s/);
    expect((err as Error).message).not.toMatch(/installed/);
  });

  it("still says 'not installed' when the squadrant binary is missing (ENOENT)", async () => {
    execFails({ code: "ENOENT" });
    const boot = await bootCaptainFrom();
    await expect(boot("projB")).rejects.toThrow(/is squadrant installed/);
  });
});

describe("dispatchCommand", () => {
  it("registers project/task arguments", () => {
    expect(dispatchCommand.name()).toBe("dispatch");
    expect(dispatchCommand.registeredArguments.map((a) => a.name())).toEqual(["project", "task"]);
  });
});
