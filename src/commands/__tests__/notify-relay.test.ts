// src/commands/__tests__/notify-relay.test.ts
//
// Mailbox-injector refactor: notify-relay is now a file tailer that reads
// from the per-project mailbox using a per-subscriber cursor, then forwards
// each delivered event to the captain's surface via the runtime driver.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { appendToMailbox, writeCursor, readCursor } from "../../control/mailbox.js";
import { runNotifyRelay, DEFAULT_STATE_ROOT, STALE_THRESHOLD_MS } from "../notify-relay.js";
import type { TaskRecord, ControlEvent } from "../../control/types.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "nr-"));
}

const rec: TaskRecord = {
  id: "deadbeefcafebabe1234567890abcdef",
  project: "demo",
  provider: "claude",
  mode: "interactive",
  state: "done",
  task: "task body",
  cwd: "/",
  createdAt: 1,
  lastHeartbeat: 1,
  lastEvent: "task.done",
  heartbeatBudgetMs: 60000,
  attempts: [],
};
const doneEvent: ControlEvent = { type: "task.done", id: rec.id, resultRef: "/r" };

function fakeRuntime(sendSpy: ReturnType<typeof vi.fn>): unknown {
  return {
    sendToSurface: sendSpy,
    status: vi.fn().mockResolvedValue({ id: "ws1", name: "captain", status: "running" }),
    listSurfaces: vi.fn().mockResolvedValue([
      { workspaceId: "ws1", surfaceId: "s1", title: "captain" },
    ]),
  };
}

describe("notify-relay default stateRoot", () => {
  it("matches the daemon's default stateRoot so writer/reader agree", () => {
    // Daemon writes mailbox to <homedir>/.config/cockpit/state/inbox/<project>.log
    // (see src/control/cockpitd.ts startCockpitd). The relay's default MUST
    // resolve to the same root, otherwise no events are ever delivered.
    const daemonDefault = join(homedir(), ".config", "cockpit", "state");
    expect(DEFAULT_STATE_ROOT).toBe(daemonDefault);
  });
});

describe("notify-relay file-tailer", () => {
  it("starts from seq 1 when cursor missing — delivers first event", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1] as string).toContain("CREW DONE");
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
  });

  it("starts from seq+1 when cursor exists — delivers only newer events", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 1 });
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    // Only seq 2 should be delivered.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(2);
  });

  it("does NOT advance cursor when sendToSurface throws", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
    const sendSpy = vi.fn().mockRejectedValue(new Error("send failed"));
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor).toBeNull(); // never written
    expect(sendSpy.mock.calls.length).toBeGreaterThan(0); // attempted
  });

  it("formats task.done/blocked/failed with provider + short id + payload", async () => {
    const stateRoot = freshState();
    const blockedEvent: ControlEvent = {
      type: "task.blocked",
      id: rec.id,
      question: "what now?",
    } as ControlEvent;
    const failedEvent: ControlEvent = {
      type: "task.failed",
      id: rec.id,
      error: "boom",
    } as ControlEvent;
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: blockedEvent });
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: failedEvent });
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(sendSpy).toHaveBeenCalledTimes(3);
    const msgs = sendSpy.mock.calls.map((c) => c[1] as string);
    expect(msgs[0]).toMatch(/^CREW DONE \[claude\/deadbeef\]:/);
    expect(msgs[1]).toMatch(/^CREW BLOCKED \[claude\/deadbeef\]: what now\?/);
    expect(msgs[2]).toMatch(/^CREW FAILED \[claude\/deadbeef\]: boom/);
  });

  it("silently acks entries older than STALE_THRESHOLD_MS without forwarding to captain", async () => {
    const stateRoot = freshState();
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneEvent });
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    // Pretend relay is booting far in the future — makes the just-written entry stale.
    const futureNow = () => Date.now() + STALE_THRESHOLD_MS + 60_000;
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
      now: futureNow,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    // Cursor must advance (so we don't replay on next start) but no notification.
    expect(sendSpy).not.toHaveBeenCalled();
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
  });

  it("task.done with payload.message prefers message over resultRef in display", async () => {
    const stateRoot = freshState();
    const doneWithMessage: ControlEvent = {
      type: "task.done",
      id: rec.id,
      resultRef: "/some/result/file.txt",
      message: "hello world",
    };
    await appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event: doneWithMessage });
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const out = sendSpy.mock.calls[0][1] as string;
    expect(out).toBe("CREW DONE [claude/deadbeef]: hello world");
    expect(out).not.toContain("/some/result/file.txt");
  });
});
