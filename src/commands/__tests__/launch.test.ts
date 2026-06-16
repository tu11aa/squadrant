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

import { cmuxLocal, buildRelaySupervisorCommand, deliverStartupPrompt } from "../launch.js";

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

// #186: the relay can die (e.g. a boot race during a daemon restart throws
// "captain workspace not running" → process.exit(1)) and, with no supervisor,
// stays dead — silently blinding the captain to all crew notifications. The
// relay tab therefore runs a self-restarting shell loop so any exit respawns.
describe("buildRelaySupervisorCommand (#186 self-healing relay)", () => {
  it("wraps the relay in an infinite restart loop, not a bare invocation", () => {
    const cmd = buildRelaySupervisorCommand("cockpit");
    // A bare `cockpit notify-relay ...` would die-and-stay-dead. The loop must
    // re-run it after every exit.
    expect(cmd).toMatch(/while .*; do .*; done/);
    expect(cmd).toContain("cockpit notify-relay cockpit --as captain");
  });

  it("sleeps between restarts so a crash-loop doesn't spin hot", () => {
    const cmd = buildRelaySupervisorCommand("cockpit");
    expect(cmd).toMatch(/sleep \d+/);
  });

  it("re-runs the relay (relay invocation appears inside the loop body)", () => {
    const cmd = buildRelaySupervisorCommand("brove");
    const body = cmd.replace(/^while .*?; do /, "").replace(/; done$/, "");
    expect(body).toContain("cockpit notify-relay brove --as captain");
  });
});

// #292: the captain startup prompt was delivered on a fixed 8s setTimeout. CC
// cold-init takes 5–15s, so on a slow boot the prompt landed on the splash screen
// and was silently dropped (#235), so the captain never ran startup and the relay
// never booted. deliverStartupPrompt replaces the magic delay with a deterministic
// poll-send-confirm loop: wait for input-readiness, send, and bounded re-send if
// the keystrokes were dropped — without ever re-sending a prompt that landed.
describe("deliverStartupPrompt (#292 deterministic startup delivery)", () => {
  // Real CC layouts the classifier keys on (see cmux.ts / 258 fixture).
  const HR = "─".repeat(110);
  const SPLASH = " ✻ Welcome to Claude Code\n   Loading…";
  const IDLE = [HR, "❯ ", HR, "   Model: Opus 4.8  Ctx Used: 52.0%", "  ⏵⏵ auto mode on"].join("\n");
  const WORKING = ["✢ Cerebrating… (4s · ↓ 1.2k tokens)", HR, "❯ ", HR, "  ⏵⏵ auto mode on"].join("\n");

  const FAST = { readyTimeoutMs: 100, settleMs: 1, pollMs: 1, maxAttempts: 3 };

  // A fake runtime whose read-screen returns scripted screens by call index
  // (clamped to the last), recording every send for assertions.
  function fakeRuntime(screens: string[]) {
    let i = 0;
    const sends: string[] = [];
    return {
      sends,
      readScreen: vi.fn(async () => screens[Math.min(i++, screens.length - 1)]),
      send: vi.fn(async (_ref: string, msg: string) => { sends.push(msg); }),
    };
  }

  it("waits out the splash and sends only once the surface is input-ready", async () => {
    // loading (initial) → idle (ready) → working (confirm: landed)
    const rt = fakeRuntime([SPLASH, IDLE, WORKING]);
    await deliverStartupPrompt(rt, "workspace:1", "GO", FAST);
    expect(rt.sends).toEqual(["GO"]);
    // It must NOT have sent while the screen was still the splash.
    expect(rt.send).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-send when the first prompt landed (guards duplicate runs)", async () => {
    // idle (ready) → working (confirm: landed) — exactly one send.
    const rt = fakeRuntime([IDLE, WORKING]);
    await deliverStartupPrompt(rt, "workspace:1", "GO", FAST);
    expect(rt.sends).toEqual(["GO"]);
  });

  it("re-sends (bounded) when the first keystrokes were dropped", async () => {
    // idle → (send) → still idle after settle (dropped) → idle → (send) → working.
    const rt = fakeRuntime([IDLE, IDLE, IDLE, WORKING]);
    await deliverStartupPrompt(rt, "workspace:1", "GO", FAST);
    expect(rt.sends).toEqual(["GO", "GO"]);
  });

  it("never re-sends into an already-working session", async () => {
    const rt = fakeRuntime([WORKING]);
    await deliverStartupPrompt(rt, "workspace:1", "GO", FAST);
    expect(rt.sends).toEqual([]);
  });

  it("falls back to a single best-effort send if readiness never appears (no hang)", async () => {
    // Unrecognized chrome forever (e.g. a non-Claude agent): time out, send once.
    const rt = fakeRuntime([SPLASH]);
    await deliverStartupPrompt(rt, "workspace:1", "GO", FAST);
    expect(rt.sends).toEqual(["GO"]);
  });

  it("stops re-sending after maxAttempts even if it never lands", async () => {
    // Stuck idle forever (every keystroke dropped): bounded to maxAttempts sends.
    const rt = fakeRuntime([IDLE]);
    await deliverStartupPrompt(rt, "workspace:1", "GO", { ...FAST, maxAttempts: 3 });
    expect(rt.sends).toEqual(["GO", "GO", "GO"]);
  });

  // DEBUG-REPRO (#292 follow-up): the captain startup checklist runs shell
  // commands from its FIRST step (read-handoff.sh, wiki-query.sh, relay
  // supervise). While a shell command is in flight, CC's spinner reads
  // "✻ Crunched for 27s · 1 shell still running" — a WORKING screen that carries
  // NO "↓ X.Xk tokens" counter (tokens only stream during generation, not tool
  // waits) and no "esc to interrupt" (absent from this CC version's footer; 0
  // hits in docs/reports/258-parse-bug-fixture.txt). CC_WORKING_RE therefore
  // misses it and classifyStartupSurface returns "idle". The confirm/poll loop
  // reads that working captain as "idle" on every settle sample, concludes the
  // keystrokes were dropped, and re-sends — 3 duplicate startup runs.
  // Source of truth: 258 fixture line 4 (working, no token counter).
  it("does NOT re-send when the captain is working on a shell command (no token counter)", async () => {
    const SHELL_WAITING = [
      "✻ Crunched for 27s · 1 shell still running",
      HR, "❯ ", HR,
      "   Model: Opus 4.8  Ctx Used: 52.0%",
      "  ⏵⏵ auto mode on · 1 shell",
    ].join("\n");
    // idle (ready) → send → captain is now WORKING on a shell cmd for the whole
    // turn. Every confirm/poll sample returns SHELL_WAITING.
    const rt = fakeRuntime([IDLE, SHELL_WAITING]);
    await deliverStartupPrompt(rt, "workspace:1", "GO", FAST);
    // Correct behavior: send exactly once — the prompt landed and the captain
    // is working. Pre-fix this is ["GO","GO","GO"].
    expect(rt.sends).toEqual(["GO"]);
  });

  it("never throws even if readScreen rejects", async () => {
    const rt = {
      sends: [] as string[],
      readScreen: vi.fn(async () => { throw new Error("surface gone"); }),
      send: vi.fn(async () => {}),
    };
    await expect(deliverStartupPrompt(rt, "workspace:1", "GO", FAST)).resolves.toBeUndefined();
  });
});
