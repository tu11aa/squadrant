// src/control/__tests__/cockpitd-notify-default.test.ts
//
// #111: cover the default-notify path (broadcast push frame + append inbox
// file). Existing cockpitd-push.test.ts covers the daemon's decision to
// notify; this file covers what `defaultNotify` actually does once it fires.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest, encodeMsg, createDecoder } from "../protocol.js";
import type { AttachFrame } from "../protocol.js";
import type { TaskRecord } from "../types.js";

function awaitFrame(sockPath: string, project: string): Promise<AttachFrame> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(sockPath);
    const dec = createDecoder();
    const t = setTimeout(() => { conn.destroy(); reject(new Error("timeout waiting for push")); }, 2000);
    conn.setEncoding("utf-8");
    conn.on("connect", () => conn.write(encodeMsg({ op: "subscribe-notify", project })));
    conn.on("data", (chunk: string) => {
      for (const raw of dec.push(chunk)) {
        const f = raw as AttachFrame;
        if ((f as any).type === "push") {
          clearTimeout(t);
          conn.destroy();
          resolve(f);
          return;
        }
      }
    });
    conn.on("error", (e: Error) => { clearTimeout(t); reject(e); });
  });
}

function seedRec(id: string): TaskRecord {
  return {
    id, project: "p", provider: "claude", mode: "interactive",
    state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
  };
}

describe("cockpitd defaultNotify (#111)", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("broadcasts a push frame to a subscribe-notify client when a task transitions to done", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-notify-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const handle = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    stop = handle.stop;

    // Seed a working task.
    await sendRequest(sock, { kind: "seed", record: seedRec("task-push-1") });

    // Subscribe FIRST (before the event), then fire the event.
    const framePromise = awaitFrame(sock, "p");
    // Tiny delay to let subscribe-claim register before we fire the event.
    await new Promise((r) => setTimeout(r, 50));
    await sendRequest(sock, {
      kind: "event",
      project: "p",
      event: { type: "task.done", id: "task-push-1", resultRef: "/tmp/x" },
    });

    const frame = (await framePromise) as { type: "push"; project: string; message: string; ts: number };
    expect(frame.type).toBe("push");
    expect(frame.project).toBe("p");
    expect(frame.message).toMatch(/^CREW DONE \[claude\/task-pus/);
    expect(typeof frame.ts).toBe("number");
  });

  it("appends the notification to an inbox log file", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-notify-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const handle = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    stop = handle.stop;

    await sendRequest(sock, { kind: "seed", record: seedRec("task-inbox-1") });
    await sendRequest(sock, {
      kind: "event",
      project: "p",
      event: { type: "task.done", id: "task-inbox-1", resultRef: "/tmp/x" },
    });

    // Inbox lives next to stateRoot in <root>/inbox/<project>.log.
    const inboxPath = join(stateRoot, "..", "inbox", "p.log");
    expect(existsSync(inboxPath)).toBe(true);
    const contents = readFileSync(inboxPath, "utf-8");
    expect(contents).toMatch(/CREW DONE \[claude\/task-inb/);
  });

  it("does not throw when no subscriber is connected (drop on the broadcast, persist in inbox)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-notify-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const handle = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    stop = handle.stop;

    await sendRequest(sock, { kind: "seed", record: seedRec("task-no-sub-1") });
    // No subscriber. Daemon must still apply the event and write inbox.
    const r: any = await sendRequest(sock, {
      kind: "event",
      project: "p",
      event: { type: "task.done", id: "task-no-sub-1", resultRef: "/tmp/x" },
    });
    expect(r.state).toBe("done");

    const inboxPath = join(stateRoot, "..", "inbox", "p.log");
    expect(existsSync(inboxPath)).toBe(true);
  });
});
