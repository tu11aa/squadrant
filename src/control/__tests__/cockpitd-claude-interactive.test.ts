// src/control/__tests__/cockpitd-claude-interactive.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";

describe("cockpitd claude interactive wiring", () => {
  let stop: (() => Promise<void>) | undefined;
  let dir: string;
  afterEach(async () => {
    await stop?.();
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
    // claude must still route to launchHeadless. We inject a fake launcher
    // (the #260 seam) so the test never shells out to the real claude CLI —
    // a real spawn here orphans a `claude -p` past teardown (the RAM-flood
    // class fixed in #264) and its close handler writes into the deleted
    // temp dir, surfacing as an unhandled ENOENT.
    dir = mkdtempSync(join(tmpdir(), "cp-claude-iv-"));
    const sock = join(dir, "c.sock");
    const launched: string[] = [];
    const h = startCockpitd({
      stateRoot: join(dir, "state"),
      sockPath: sock,
      sweepMs: 0,
      launchHeadless: async (rec) => { launched.push(rec.id); },
    });
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
    await new Promise((r) => setTimeout(r, 30));
    const st = (await sendRequest(sock, { kind: "status", project: "p", id: "c3" })) as { state: string; error?: string };
    // Headless dispatch routed to the headless launcher...
    expect(launched).toContain("c3");
    // ...and NOT into the interactive branch's throw.
    expect(st.error ?? "").not.toMatch(/interactive mode is not yet implemented/);
  });
});
