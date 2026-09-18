import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sendRequestMock = vi.hoisted(() => vi.fn());

vi.mock("../protocol.js", () => ({
  sendRequest: sendRequestMock,
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", () => ({
  loadConfig,
  resolveHome: (p: string) => p,
  DAEMON_SOCK_PATH: "/tmp/mock.sock",
  CONFIG_DIR: "/tmp/squadrant",
}));

import { dispatchToSibling, isCaptainAlive, probeCaptainChannel } from "../group-dispatch.js";
import { writeCaptainAddress } from "../captain-record.js";

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

describe("dispatchToSibling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockReturnValue(makeConfig());
    sendRequestMock.mockResolvedValue([]);
  });

  // ── cross-project reach (#246 hard gate relaxed) ──────────────────────────

  it("allows dispatch to a project NOT in the same group when its captain is alive", async () => {
    sendRequestMock.mockImplementation((_sock: string, msg: any) => {
      if (msg?.kind === "health") {
        return [{ kind: "captain", project: "projC", state: "alive", lastSeenMs: Date.now() }];
      }
      if (msg?.kind === "dispatch") return msg.record;
      return undefined;
    });

    const result = await dispatchToSibling({
      fromProject: "projA",
      toProject: "projC",
      task: "do something",
    });

    expect((result as any).originProject).toBe("projA");
    expect((result as any).project).toBe("projC");
  });

  it("dispatches to a cross-group project when the captain row is stale but the channel is reachable (#799)", async () => {
    sendRequestMock.mockImplementation((_sock: string, msg: any) => {
      if (msg?.kind === "health") {
        return [{ kind: "captain", project: "projC", state: "stopped", lastSeenMs: Date.now() }];
      }
      if (msg?.kind === "dispatch") return msg.record;
      return undefined;
    });

    const result = await dispatchToSibling({
      fromProject: "projA",
      toProject: "projC",
      task: "transfer handoff",
      channelAlive: async () => true,
    });

    expect((result as any).originProject).toBe("projA");
    expect((result as any).project).toBe("projC");
  });

  it("rejects cross-group dispatch to a down captain WITHOUT booting it", async () => {
    const bootCaptain = vi.fn().mockResolvedValue(undefined);
    sendRequestMock.mockResolvedValue([]); // health: nobody alive

    await expect(
      dispatchToSibling({
        fromProject: "projA",
        toProject: "projC",
        task: "do something",
        bootCaptain,
      }),
    ).rejects.toThrow(/does not auto-boot|start it manually|ping/i);

    expect(bootCaptain).not.toHaveBeenCalled();
    expect(sendRequestMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "dispatch" }),
    );
  });

  it("rejects dispatch when toProject has acceptDelegations: false", async () => {
    loadConfig.mockReturnValue(makeConfig({ acceptDelegationsB: false }));

    await expect(
      dispatchToSibling({
        fromProject: "projA",
        toProject: "projB",
        task: "do something",
      }),
    ).rejects.toThrow(/acceptDelegations.*false/i);

    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  it("rejects cross-group dispatch when toProject has acceptDelegations: false, even if alive", async () => {
    loadConfig.mockReturnValue(makeConfig());
    (loadConfig() as any).projects.projC.acceptDelegations = false;
    sendRequestMock.mockResolvedValue([
      { kind: "captain", project: "projC", state: "alive", lastSeenMs: Date.now() },
    ]);

    await expect(
      dispatchToSibling({
        fromProject: "projA",
        toProject: "projC",
        task: "do something",
      }),
    ).rejects.toThrow(/acceptDelegations.*false/i);
  });

  // ── warmup / boot-if-down (same-group only) ───────────────────────────────

  it("fails clearly when warmup times out", async () => {
    // health returns empty → captain not alive; no bootCaptain provided → skip boot → warmup times out
    sendRequestMock.mockResolvedValue([]);

    await expect(
      dispatchToSibling({
        fromProject: "projA",
        toProject: "projB",
        task: "do something",
        warmupTimeoutMs: 100,
        warmupPollMs: 20,
      }),
    ).rejects.toThrow(/timed out waiting for captain warmup/i);
  });

  it("boots a down same-group captain via bootCaptain, then dispatches", async () => {
    const bootCaptain = vi.fn().mockImplementation(async () => {
      booted = true;
    });
    let booted = false;
    sendRequestMock.mockImplementation((_sock: string, msg: any) => {
      if (msg?.kind === "health") {
        return booted
          ? [{ kind: "captain", project: "projB", state: "alive", lastSeenMs: Date.now() }]
          : [];
      }
      if (msg?.kind === "dispatch") return msg.record;
      return undefined;
    });

    const result = await dispatchToSibling({
      fromProject: "projA",
      toProject: "projB",
      task: "do something",
      bootCaptain,
      warmupPollMs: 5,
    });

    expect(bootCaptain).toHaveBeenCalledWith("projB");
    expect((result as any).project).toBe("projB");
  });

  // ── task record shape ────────────────────────────────────────────────────

  it("records a task with originProject set when dispatch succeeds", async () => {
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

    const result = await dispatchToSibling({
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

// ── isCaptainAlive (#517: "stopped" was mistakenly treated as alive) ─────────
describe("isCaptainAlive", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns true only when the captain row reports state 'alive'", async () => {
    sendRequestMock.mockResolvedValue([
      { kind: "captain", project: "projA", state: "alive", lastSeenMs: Date.now() },
    ]);
    expect(await isCaptainAlive("projA")).toBe(true);
  });

  it("returns false when the captain workspace was closed (state 'stopped' = down)", async () => {
    sendRequestMock.mockResolvedValue([
      { kind: "captain", project: "projA", state: "stopped", lastSeenMs: Date.now() },
    ]);
    expect(await isCaptainAlive("projA")).toBe(false);
  });

  it("returns false when the captain state is unknown", async () => {
    sendRequestMock.mockResolvedValue([
      { kind: "captain", project: "projA", state: "unknown", lastSeenMs: null },
    ]);
    expect(await isCaptainAlive("projA")).toBe(false);
  });

  it("returns false when there is no captain row at all", async () => {
    sendRequestMock.mockResolvedValue([]);
    expect(await isCaptainAlive("projA")).toBe(false);
  });

  // ── #799: channel-aware fallback when the row is stale ────────────────────
  it("returns true when the row is stale 'stopped' but the control channel is reachable (#799)", async () => {
    sendRequestMock.mockResolvedValue([
      { kind: "captain", project: "projA", state: "stopped", lastSeenMs: Date.now() },
    ]);
    expect(await isCaptainAlive("projA", "/tmp/mock.sock", async () => true)).toBe(true);
  });

  it("returns false for a genuinely down captain with no reachable channel (#799)", async () => {
    sendRequestMock.mockResolvedValue([
      { kind: "captain", project: "projA", state: "stopped", lastSeenMs: Date.now() },
    ]);
    expect(await isCaptainAlive("projA", "/tmp/mock.sock", async () => false)).toBe(false);
  });
});

// ── probeCaptainChannel (#799) ───────────────────────────────────────────────
describe("probeCaptainChannel", () => {
  let dir: string;
  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(join(tmpdir(), "sq-probe-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports alive for a recorded opencode captain whose HTTP port answers", async () => {
    writeCaptainAddress(join(dir, "state"), "proj", {
      agent: "opencode", port: 1234, directory: "/p", launchedAt: "x",
    });
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    expect(await probeCaptainChannel("proj", { stateRoot: join(dir, "state"), fetchImpl })).toBe(true);
  });

  it("reports not-alive when the recorded opencode port does not answer", async () => {
    writeCaptainAddress(join(dir, "state"), "proj", {
      agent: "opencode", port: 1234, directory: "/p", launchedAt: "x",
    });
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect(await probeCaptainChannel("proj", { stateRoot: join(dir, "state"), fetchImpl })).toBe(false);
  });

  it("reports not-alive when there is no captain record (closed workspace / down)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as unknown as Response);
    expect(await probeCaptainChannel("proj", { stateRoot: join(dir, "state"), fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports alive for a claude captain whose peer socket accepts", async () => {
    writeCaptainAddress(join(dir, "state"), "proj", {
      agent: "claude", directory: "/p", launchedAt: "x",
    });
    const socketAccepts = vi.fn(async () => true);
    expect(await probeCaptainChannel("proj", { stateRoot: join(dir, "state"), socketAccepts })).toBe(true);
  });
});
