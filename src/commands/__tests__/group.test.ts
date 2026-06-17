import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendRequestMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("../../control/protocol.js", () => ({
  sendRequest: sendRequestMock,
}));

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@cockpit/shared", () => ({
  loadConfig,
  resolveHome: (p: string) => p,
}));

import { runGroupDispatch, groupCommand } from "../group.js";

const makeConfig = (overrides: Record<string, any> = {}) => {
  const projects: Record<string, any> = {
    projA: {
      path: "/projects/a",
      captainName: "⚓ A-captain",
      spokeVault: "/spokes/a",
      host: "local",
      group: "mygroup",
      groupRole: "primary",
      ...(overrides.acceptDelegationsA !== undefined ? { acceptDelegations: overrides.acceptDelegationsA } : {}),
    },
    projB: {
      path: "/projects/b",
      captainName: "⚓ B-captain",
      spokeVault: "/spokes/b",
      host: "local",
      group: "mygroup",
      groupRole: "fork",
      ...(overrides.acceptDelegationsB !== undefined ? { acceptDelegations: overrides.acceptDelegationsB } : {}),
    },
    projC: {
      path: "/projects/c",
      captainName: "⚓ C-captain",
      spokeVault: "/spokes/c",
      host: "local",
      group: "othergroup",
      groupRole: "primary",
    },
  };
  return {
    commandName: "command",
    hubVault: "~/hub",
    projects,
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: { command: "auto", captain: "auto", crew: "auto" },
    },
    metrics: { enabled: false, path: "/tmp/metrics.json" },
  };
};

describe("groupCommand dispatch description", () => {
  it("registers a dispatch subcommand", () => {
    const dispatch = groupCommand.commands.find((c) => c.name() === "dispatch");
    expect(dispatch).toBeDefined();
    // [experimental] marker dropped once #288 boot-if-down path was fixed
    expect(dispatch!.description()).toMatch(/dispatch a task/i);
  });
});

describe("runGroupDispatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockReturnValue(makeConfig());
    sendRequestMock.mockResolvedValue([]);
    execSyncMock.mockReturnValue("");
  });

  // ── same-group gate ──────────────────────────────────────────────────────

  it("rejects dispatch to a project NOT in the same group", async () => {
    await expect(
      runGroupDispatch({
        fromProject: "projA",
        toProject: "projC",
        task: "do something",
      }),
    ).rejects.toThrow(/not in the same group/i);

    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("rejects dispatch when toProject has acceptDelegations: false", async () => {
    loadConfig.mockReturnValue(makeConfig({ acceptDelegationsB: false }));

    await expect(
      runGroupDispatch({
        fromProject: "projA",
        toProject: "projB",
        task: "do something",
      }),
    ).rejects.toThrow(/acceptDelegations.*false/i);

    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  // ── warmup timeout ───────────────────────────────────────────────────────

  it("fails clearly when warmup times out", async () => {
    // sendRequest for health returns empty → captain not alive → launch + poll
    sendRequestMock.mockResolvedValue([]);

    loadConfig.mockReturnValue(makeConfig({}));

    await expect(
      runGroupDispatch({
        fromProject: "projA",
        toProject: "projB",
        task: "do something",
        warmupTimeoutMs: 100,
        warmupPollMs: 20,
      }),
    ).rejects.toThrow(/timed out waiting for captain warmup/i);
  });

  // ── task record shape ────────────────────────────────────────────────────

  it("records a task with originProject set when dispatch succeeds", async () => {
    // sendRequest signature is (sockPath, msg, timeoutMs). The second arg is the msg.
    sendRequestMock.mockImplementation((_sock: string, msg: any, _timeout?: number) => {
      if (msg?.kind === "health") {
        return [
          { kind: "captain", project: "projB", state: "alive", lastSeenMs: Date.now() },
        ];
      }
      if (msg?.kind === "dispatch") {
        return msg.record;
      }
      return undefined;
    });

    loadConfig.mockReturnValue(makeConfig({}));

    const result = await runGroupDispatch({
      fromProject: "projA",
      toProject: "projB",
      task: "update the docs",
    });

    expect(result).toBeDefined();
    expect((result as any).originProject).toBe("projA");
    expect((result as any).project).toBe("projB");
    expect((result as any).state).toBe("submitted");
    expect((result as any).task).toBe("update the docs");
  });
});
