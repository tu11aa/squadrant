import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { appendToMailbox, writeCursor } from "../mailbox.js";
import type { DaemonCmux } from "../cmux/daemon-cmux.js";
import type { PaneRef } from "../../runtimes/types.js";
import type { TaskRecord, ControlEvent } from "../types.js";

const TASK: TaskRecord = {
  id: "t1", project: "p", provider: "claude", mode: "interactive",
  state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
  lastEvent: "", heartbeatBudgetMs: 1000,
  name: "test-crew",
  attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
};

const EVENT: ControlEvent = { type: "task.done", id: "t1", resultRef: "/tmp/x" };

function fakeCmux(): DaemonCmux & { sent: Array<{ text: string }> } {
  const sent: Array<{ text: string }> = [];
  return {
    sent,
    send: async (_surface: PaneRef, text: string) => { sent.push({ text }); },
    listSurfaces: async () => [],
    readScreen: async () => null,
    isAvailable: async () => true,
  } as unknown as DaemonCmux & { sent: Array<{ text: string }> };
}

describe("cockpitd daemon-direct (#332)", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("flag ON: daemon delivers queued captain messages via DaemonCmux + CaptainDelivery", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    // Seed the mailbox directly.
    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE [claude/t1] — build the widget" });
    // Write cursor for the "captain" subscriber starting at seq 0.
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });

    const cmux = fakeCmux();
    const handle = startCockpitd({
      stateRoot,
      sockPath: sock,
      sweepMs: 0,
      daemonCmux: cmux,
      daemonDirectCmux: true,
      captainSurfaces: { p: { workspaceId: "ws:1", surfaceId: "surface:1", title: "captain" } },
    });
    stop = handle.stop;

    if (handle.tickDelivery) await handle.tickDelivery();

    expect(cmux.sent.length).toBe(1);
    expect(cmux.sent[0].text).toMatch(/CREW DONE/);
  });

  it("flag OFF: daemon does NOT run the delivery loop (relay path owns it)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-off-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE [claude/t1]" });
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });

    const cmux = fakeCmux();
    const handle = startCockpitd({
      stateRoot,
      sockPath: sock,
      sweepMs: 0,
      daemonCmux: cmux,
      daemonDirectCmux: false,
      captainSurfaces: { p: { workspaceId: "ws:1", surfaceId: "surface:1", title: "captain" } },
    });
    stop = handle.stop;

    expect((handle as any).tickDelivery).toBeUndefined();
    expect(cmux.sent).toEqual([]);
  });
});
