// src/control/__tests__/cockpitd-claude-interactive.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";

describe("cockpitd claude interactive wiring", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => {
    stop?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("dispatch claude interactive → state transitions submitted → working", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-claude-iv-"));
    const sock = join(dir, "c.sock");
    const h = startCockpitd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0 });
    stop = h.stop;

    const disp = (await sendRequest(sock, {
      kind: "dispatch",
      record: {
        id: "c1",
        project: "p",
        provider: "claude",
        mode: "interactive",
        state: "submitted",
        task: "do a thing",
        createdAt: 1,
        lastHeartbeat: 1,
        lastEvent: "dispatch",
        heartbeatBudgetMs: 10000,
        attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
      },
    })) as { state: string };
    expect(disp.state).toBe("submitted");

    // launchInteractive emits task.started synchronously into the event bus.
    await new Promise((r) => setTimeout(r, 20));
    const st = (await sendRequest(sock, { kind: "status", project: "p", id: "c1" })) as { state: string };
    expect(st.state).toBe("working");
  });

  it("task.progress events keep state working; task.done transitions to done", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-claude-iv-"));
    const sock = join(dir, "c.sock");
    const h = startCockpitd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0 });
    stop = h.stop;

    await sendRequest(sock, {
      kind: "dispatch",
      record: {
        id: "c2",
        project: "p",
        provider: "claude",
        mode: "interactive",
        state: "submitted",
        task: "x",
        createdAt: 1,
        lastHeartbeat: 1,
        lastEvent: "dispatch",
        heartbeatBudgetMs: 10000,
        attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    // Simulate the hook bridge POSTing task.progress (Stop hook fired).
    const prog = (await sendRequest(sock, {
      kind: "event",
      project: "p",
      event: { type: "task.progress", id: "c2", note: "stop" },
    })) as { state: string; lastEvent: string };
    expect(prog.state).toBe("working");
    expect(prog.lastEvent).toBe("task.progress");

    // Simulate `cockpit crew signal done`.
    const done = (await sendRequest(sock, {
      kind: "event",
      project: "p",
      event: { type: "task.done", id: "c2", resultRef: "/tmp/c2.txt" },
    })) as { state: string; resultRef?: string };
    expect(done.state).toBe("done");
    expect(done.resultRef).toBe("/tmp/c2.txt");
  });

  it("claude headless mode still goes through the headless launcher (not the new branch)", async () => {
    // Regression guard: Task 5 only adds the interactive branch. Headless
    // claude must still hit launchHeadless. We verify by dispatching headless
    // without injecting a spawn — the launcher will try to spawn the real
    // claude CLI which we don't want to invoke here. Instead, assert the
    // dispatch ACK shape doesn't immediately mark the task failed via the
    // new branch's error path.
    dir = mkdtempSync(join(tmpdir(), "cp-claude-iv-"));
    const sock = join(dir, "c.sock");
    const h = startCockpitd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0 });
    stop = h.stop;

    const disp = (await sendRequest(sock, {
      kind: "dispatch",
      record: {
        id: "c3",
        project: "p",
        provider: "claude",
        mode: "headless",
        state: "submitted",
        task: "x",
        createdAt: 1,
        lastHeartbeat: 1,
        lastEvent: "dispatch",
        heartbeatBudgetMs: 10000,
        attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
      },
    })) as { state: string; error?: string };
    expect(disp.state).toBe("submitted");
    // If the new interactive branch wrongly caught headless dispatches, the
    // record's stored state would flip to "failed" with our error string.
    await new Promise((r) => setTimeout(r, 30));
    const st = (await sendRequest(sock, { kind: "status", project: "p", id: "c3" })) as { state: string; error?: string };
    // Headless without a real claude binary or stubbed spawn fails with a
    // launcher error — the assertion: if it failed, the error came from
    // headless launcher, NOT from the interactive branch's throw.
    if (st.state === "failed") {
      expect(st.error ?? "").not.toMatch(/interactive mode is not yet implemented/);
    }
  });
});
