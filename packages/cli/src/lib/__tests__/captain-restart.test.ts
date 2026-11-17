import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireRestartLock, releaseRestartLock, readRestartLock, restartPaths, captainIdleVerdict, readCmuxHookStore,
  surfaceHookState, surfaceUuidFromTree, runRestartHelper, startCaptainRestart, helperEnv, RESTART_IDLE_POLLS,
  type RestartHelperDeps,
} from "../captain-restart.js";

const HR = "─".repeat(40);
const IDLE = `⏺ Handoff written.\n\n${HR}\n❯ \n${HR}\n  ⏵⏵ auto mode on`;
const BUSY = `✻ Thinking… (3s · esc to interrupt)\n${IDLE}`;
const MODAL = `${HR}\n Do you want to proceed?\n❯ 1. Yes\n  2. No\n${HR}`;
const DRAFT = `${HR}\n❯ half-typed message\n${HR}\n  ⏵⏵ auto mode on`;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("restart lock", () => {
  it("dedupes while the holder is alive, replaces a stale one, releases only for its owner", () => {
    const lock = path.join(dir, "p", "captain-restart.lock");
    const a = { pid: 111, startedAt: "t1", log: "l" };
    expect(acquireRestartLock(lock, a, () => true)).toEqual({ ok: true });
    expect(acquireRestartLock(lock, { ...a, pid: 222 }, () => true)).toEqual({ ok: false, holder: a });
    // holder died without cleaning up → stale, replaced
    expect(acquireRestartLock(lock, { ...a, pid: 222 }, () => false)).toEqual({ ok: true });
    releaseRestartLock(lock, 111);
    expect(readRestartLock(lock)?.pid).toBe(222);
    releaseRestartLock(lock, 222);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("paths live under the project's state dir", () => {
    expect(restartPaths("/s", "p")).toEqual({ lock: "/s/p/captain-restart.lock", log: "/s/p/captain-restart.log" });
  });
});

describe("captainIdleVerdict", () => {
  it("idle only when the hook says the turn is over and the pane is clear", () => {
    expect(captainIdleVerdict({ lifecycle: "idle", screen: IDLE })).toEqual({ idle: true });
    expect(captainIdleVerdict({ lifecycle: "backgroundWorkPending", screen: IDLE, inputState: "empty" })).toEqual({ idle: true });
    expect(captainIdleVerdict({ screen: IDLE })).toEqual({ idle: true }); // no hook record → pane only
  });

  it.each([
    [{ lifecycle: "running", screen: IDLE }, "hook:running"],
    [{ lifecycle: "needsInput", screen: IDLE }, "hook:needsInput"],
    [{ lifecycle: "idle", screen: null }, "unreadable"],
    [{ lifecycle: "idle", screen: BUSY }, "turn-in-flight"],
    [{ lifecycle: "idle", screen: MODAL }, "prompt-open"],
    [{ lifecycle: "idle", screen: IDLE, inputState: "dialog" }, "prompt-open"],
    [{ lifecycle: "idle", screen: IDLE, inputState: "draft" }, "draft"],
    [{ lifecycle: "idle", screen: DRAFT }, "draft"],
    [{ lifecycle: "idle", screen: "$ " }, "no-box"],
  ])("not idle: %o → %s", (input, reason) => {
    expect(captainIdleVerdict(input)).toEqual({ idle: false, reason });
  });
});

describe("cmux hook store", () => {
  it("maps the captain's surface to its active session and that session's lifecycle", () => {
    fs.writeFileSync(path.join(dir, "claude-hook-sessions.json"), JSON.stringify({
      activeSessionsBySurface: { "UUID-1": { sessionId: "s1" }, "UUID-2": { sessionId: "gone" } },
      sessions: { s1: { agentLifecycle: "running" } },
    }));
    const store = readCmuxHookStore(dir);
    expect(surfaceHookState(store, "UUID-1")).toEqual({ sessionId: "s1", lifecycle: "running" });
    expect(surfaceHookState(store, "UUID-2")).toEqual({ sessionId: "gone" });
    expect(surfaceHookState(store, "UUID-3")).toBeUndefined();
    expect(readCmuxHookStore(path.join(dir, "missing"))).toBeNull();
    expect(surfaceHookState(null, "UUID-1")).toBeUndefined();
  });

  it("resolves a surface ref to its UUID from cmux tree output", () => {
    const tree = JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ ref: "surface:5", id: "UUID-5" }] }] }] }] });
    expect(surfaceUuidFromTree(tree, "surface:5")).toBe("UUID-5");
    expect(surfaceUuidFromTree(tree, "surface:6")).toBeUndefined();
    expect(surfaceUuidFromTree("not json", "surface:5")).toBeUndefined();
  });
});

function helperDeps(screens: Array<string | null>, over: Partial<RestartHelperDeps> = {}) {
  let t = 0;
  let i = 0;
  const calls: string[] = [];
  const deps: RestartHelperDeps = {
    project: "p",
    captainName: "p-captain",
    runtime: {
      status: vi.fn(async () => ({ id: "workspace:7", name: "p-captain", status: "running" as const })),
      listSurfaces: vi.fn(async () => [{ workspaceId: "workspace:7", surfaceId: "surface:1", title: "p-captain" }]),
      readPaneScreen: vi.fn(async () => (screens[Math.min(i++, screens.length - 1)] ?? "") as string),
    },
    hookState: async () => ({ sessionId: "s1", lifecycle: "idle" }),
    launchFresh: vi.fn(async () => { calls.push("launch"); return 0; }),
    notify: vi.fn(async (text: string) => { calls.push(`notify:${text}`); }),
    log: () => {},
    now: () => t,
    sleep: async (ms) => { t += ms; },
    pollMs: 1000,
    timeoutMs: 10_000,
    ...over,
  };
  return { deps, calls };
}

describe("runRestartHelper", () => {
  it("waits out a busy captain, then relaunches fresh once idle for consecutive polls", async () => {
    const { deps, calls } = helperDeps([BUSY, BUSY, IDLE, BUSY, IDLE, IDLE, IDLE]);
    expect(await runRestartHelper(deps)).toBe("restarted");
    expect(calls).toEqual(["launch"]);
    expect(deps.runtime.readPaneScreen).toHaveBeenCalledTimes(4 + RESTART_IDLE_POLLS);
  });

  it("does not launch while the hook store says the turn is running", async () => {
    const { deps, calls } = helperDeps([IDLE], { hookState: async () => ({ sessionId: "s1", lifecycle: "running" }) });
    expect(await runRestartHelper(deps)).toBe("gave-up");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^notify:captain restart p: gave up after 10s .*last: hook:running/);
  });

  it("keeps waiting when a poll throws", async () => {
    const { deps, calls } = helperDeps([IDLE], { hookState: async () => { throw new Error("cmux down"); } });
    expect(await runRestartHelper(deps)).toBe("gave-up");
    expect(calls[0]).toMatch(/last: error: cmux down/);
  });

  it("never treats a missing workspace as gone (no launch beside the old captain)", async () => {
    const { deps, calls } = helperDeps([IDLE]);
    deps.runtime.status = vi.fn(async () => null);
    expect(await runRestartHelper(deps)).toBe("gave-up");
    expect(calls.some((c) => c === "launch")).toBe(false);
  });

  it("notifies when the fresh launch fails", async () => {
    const { deps, calls } = helperDeps([IDLE], { launchFresh: async () => 1 });
    expect(await runRestartHelper(deps)).toBe("launch-failed");
    expect(calls[0]).toMatch(/exited 1/);
  });

  it("focuses the new workspace when asked", async () => {
    const focus = vi.fn();
    const { deps } = helperDeps([IDLE], { focus });
    await runRestartHelper(deps);
    expect(focus).toHaveBeenCalledWith("workspace:7");
  });
});

describe("startCaptainRestart", () => {
  it("spawns a detached helper with the pane env stripped, records its pid, and dedupes a second request", () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ pid: 4242, unref })) as unknown as typeof import("node:child_process").spawn;
    const env = { PATH: "/bin", CMUX_WORKSPACE_ID: "ws", CMUX_SURFACE_ID: "sf", CLAUDE_CODE_SESSION_ID: "s", CMUX_SOCKET_PATH: "/sock" };
    const r = startCaptainRestart({ project: "p", stateRoot: dir, cliPath: "/cli.js", focus: true, timeoutMs: 5000, env, spawn, alive: () => true });
    expect(r).toEqual({ status: "started", pid: 4242, log: path.join(dir, "p", "captain-restart.log") });
    const [, args, opts] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).toEqual(["/cli.js", "captain", "restart-run", "p", "--focus", "--timeout-ms", "5000"]);
    expect(opts.detached).toBe(true);
    expect(opts.env).toEqual({ PATH: "/bin", CMUX_SOCKET_PATH: "/sock" });
    expect(unref).toHaveBeenCalled();
    expect(readRestartLock(path.join(dir, "p", "captain-restart.lock"))?.pid).toBe(4242);

    const again = startCaptainRestart({ project: "p", stateRoot: dir, cliPath: "/cli.js", env, spawn, alive: () => true });
    expect(again).toMatchObject({ status: "pending", holder: { pid: 4242 } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when the helper cannot start", () => {
    const spawn = vi.fn(() => ({ pid: undefined, unref: () => {} })) as unknown as typeof import("node:child_process").spawn;
    expect(() => startCaptainRestart({ project: "p", stateRoot: dir, cliPath: "/cli.js", spawn })).toThrow(/did not start/);
    expect(fs.existsSync(path.join(dir, "p", "captain-restart.lock"))).toBe(false);
  });

  it("helperEnv keeps everything but the captain pane/session identity", () => {
    expect(helperEnv({ A: "1", CMUX_TAB_ID: "x", CLAUDECODE: "1" })).toEqual({ A: "1" });
  });
});
