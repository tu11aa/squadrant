// Unit tests for launchOneWorkspace's --keep semantics (#534).
// Uses real fs on a temp dir (mirrors session-freshness.test.ts) plus a
// minimal RuntimeDriver mock — no real processes or cmux.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import type { RuntimeDriver } from "@squadrant/shared";
import { bootWorkspace, launchOneWorkspace } from "../launch-workspace.js";
import { saveSessions, computeTemplateHash } from "../session-freshness.js";

let tmpDir: string;
let sessionsPath: string;
let templatesDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-lw-test-"));
  sessionsPath = path.join(tmpDir, "sessions.json");
  templatesDir = path.join(tmpDir, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRuntime(): RuntimeDriver {
  return {
    name: "mock",
    probe: vi.fn(),
    list: vi.fn(),
    status: vi.fn().mockResolvedValue(null),
    spawn: vi.fn().mockResolvedValue({ id: "workspace:1", name: "ws", status: "running" }),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(),
    stop: vi.fn(),
    newPane: vi.fn(),
    closePane: vi.fn(),
    sendToPane: vi.fn(),
    pasteToPane: vi.fn(),
    sendKeyToPane: vi.fn(),
    readPaneScreen: vi.fn(),
    listSurfaces: vi.fn(),
    spawnInjector: vi.fn(),
  } as unknown as RuntimeDriver;
}

describe("launchOneWorkspace --keep (#534)", () => {
  it("resumes (no forceFresh) when keepOverride overrides a 'new day' reason", async () => {
    const hash = computeTemplateHash("captain", templatesDir);
    saveSessions(sessionsPath, { workspaces: { "ws-1": { lastLaunched: "2000-01-01", templateHash: hash } } });

    const agentCmdFactory = vi.fn().mockReturnValue("claude-cli");
    const onFreshReason = vi.fn();

    await launchOneWorkspace({
      workspaceName: "ws-1",
      role: "captain",
      cwd: tmpDir,
      keepOverride: true,
      sessionsPath,
      templatesDir,
      agentCmdFactory,
      runtime: makeRuntime(),
      onFreshReason,
    });

    expect(agentCmdFactory).toHaveBeenCalledWith(false);
    expect(onFreshReason).toHaveBeenCalledWith(
      expect.stringContaining("keeping previous session (--keep)"),
    );
  });

  it("still starts fresh on a genuine first launch even with keepOverride (nothing to resume)", async () => {
    const agentCmdFactory = vi.fn().mockReturnValue("claude-cli");
    const onFreshReason = vi.fn();

    await launchOneWorkspace({
      workspaceName: "ws-new",
      role: "captain",
      cwd: tmpDir,
      keepOverride: true,
      sessionsPath,
      templatesDir,
      agentCmdFactory,
      runtime: makeRuntime(),
      onFreshReason,
    });

    expect(agentCmdFactory).toHaveBeenCalledWith(true);
    expect(onFreshReason).toHaveBeenCalledWith("first launch");
  });
});

describe("launchOneWorkspace — captain marker (#636)", () => {
  // ensureDaemon's fail-closed captain gate (launchd.ts) only mutates the
  // shared daemon's registration when SQUADRANT_ROLE=captain is present in
  // the inherited env. This is the ONLY place that marker is set, so it must
  // land on the captain role and must NOT leak onto any other role.
  it("prefixes the spawned command with SQUADRANT_ROLE=captain for role='captain'", async () => {
    const runtime = makeRuntime();
    await launchOneWorkspace({
      workspaceName: "ws-captain",
      role: "captain",
      cwd: tmpDir,
      sessionsPath,
      templatesDir,
      agentCmdFactory: () => "claude --permission-mode auto",
      runtime,
    });

    expect(runtime.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: "SQUADRANT_ROLE=captain claude --permission-mode auto" }),
    );
  });

  it("does not add a role marker for role='command'", async () => {
    const runtime = makeRuntime();
    await launchOneWorkspace({
      workspaceName: "ws-command",
      role: "command",
      cwd: tmpDir,
      sessionsPath,
      templatesDir,
      agentCmdFactory: () => "claude --permission-mode auto",
      runtime,
    });

    expect(runtime.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude --permission-mode auto" }),
    );
  });
});

describe("bootWorkspace stale-workspace stop (B3)", () => {
  it("warns when stopping the stale workspace fails, and still spawns", async () => {
    const runtime = {
      ...makeRuntime(),
      status: vi.fn().mockResolvedValue({ id: "workspace:9", name: "cap", status: "running" }),
      stop: vi.fn().mockRejectedValue(new Error("confirmation_required")),
      spawn: vi.fn().mockResolvedValue({ id: "workspace:10", name: "cap", status: "running" }),
    } as unknown as RuntimeDriver;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await bootWorkspace({ runtime, workspaceName: "cap", agentCmd: "claude", forceFresh: true });
      expect(stderrSpy.mock.calls.map((c) => c[0]).join("")).toMatch(/close failed: confirmation_required/);
      expect(runtime.spawn).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("bootWorkspace waits for the stale agent's messaging socket (#1104)", () => {
  function staleRuntime(): RuntimeDriver {
    return {
      ...makeRuntime(),
      status: vi.fn().mockResolvedValue({ id: "workspace:9", name: "cap", status: "running" }),
      stop: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue({ id: "workspace:10", name: "cap", status: "running" }),
    } as unknown as RuntimeDriver;
  }

  function listen(sockPath: string): Promise<net.Server> {
    return new Promise((resolve) => {
      const server = net.createServer((c) => c.destroy());
      server.listen(sockPath, () => resolve(server));
    });
  }

  it("spawns only after the old listener is gone", async () => {
    const sock = path.join(tmpDir, "cap.sock");
    const server = await listen(sock);
    let closedAt = 0;
    setTimeout(() => server.close(() => { closedAt = Date.now(); }), 300);
    const runtime = staleRuntime();
    let spawnedAt = 0;
    (runtime.spawn as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      spawnedAt = Date.now();
      return { id: "workspace:10", name: "cap", status: "running" };
    });

    await bootWorkspace({ runtime, workspaceName: "cap", agentCmd: "claude", forceFresh: true, messagingSocketPath: sock });

    expect(closedAt).toBeGreaterThan(0);
    expect(spawnedAt).toBeGreaterThanOrEqual(closedAt);
  });

  it("fails loudly and does not spawn when the socket stays live", async () => {
    const sock = path.join(tmpDir, "cap.sock");
    const server = await listen(sock);
    const runtime = staleRuntime();
    try {
      await expect(bootWorkspace({
        runtime, workspaceName: "cap", agentCmd: "claude", forceFresh: true,
        messagingSocketPath: sock, staleExitTimeoutMs: 300,
      })).rejects.toThrow(/still listening/);
      expect(runtime.spawn).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("spawns at once when nothing listens (stale file or no file)", async () => {
    const runtime = staleRuntime();
    await bootWorkspace({
      runtime, workspaceName: "cap", agentCmd: "claude", forceFresh: true,
      messagingSocketPath: path.join(tmpDir, "missing.sock"), staleExitTimeoutMs: 300,
    });
    expect(runtime.spawn).toHaveBeenCalled();
  });
});
