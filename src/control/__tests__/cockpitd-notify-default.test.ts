// src/control/__tests__/cockpitd-notify-default.test.ts
//
// Mailbox-injector: cover the default-notify path which now appends a JSON
// entry to the mailbox file. Replaces the prior subscribe-notify broadcast
// path (PR #112). The daemon's decision to notify is covered separately by
// cockpitd-push.test.ts; this file covers what defaultNotify writes once it
// fires.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";
import { runNotifyRelay } from "../../commands/notify-relay.js";
import type { TaskRecord } from "../types.js";

function seedRec(id: string): TaskRecord {
  return {
    id, project: "p", provider: "claude", mode: "interactive",
    state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
  };
}

describe("cockpitd defaultNotify writes to mailbox", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("appends a task.done event to <stateRoot>/inbox/<project>.log as JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-notify-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const handle = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    stop = handle.stop;

    await sendRequest(sock, { kind: "seed", record: seedRec("task-mbx-1") });
    await sendRequest(sock, {
      kind: "event",
      project: "p",
      event: { type: "task.done", id: "task-mbx-1", resultRef: "/tmp/result" },
    });
    // Allow the async append to flush.
    await new Promise((r) => setTimeout(r, 100));

    const inboxPath = join(stateRoot, "inbox", "p.log");
    expect(existsSync(inboxPath)).toBe(true);
    const lines = readFileSync(inboxPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    // Only the terminal event triggers a notify (firePush gate).
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("task.done");
    expect(lines[0].provider).toBe("claude");
    expect(lines[0].taskId).toBe("task-mbx-1");
    expect(lines[0].payload.resultRef).toBe("/tmp/result");
    expect(lines[0].seq).toBe(1);
    expect(typeof lines[0].ts).toBe("string");
  });

  it("#214: task.approval.requested → CREW BLOCKED message persisted AND delivered by the relay", async () => {
    // Regression for #214 (approval dropped) via the unified formatter. The
    // daemon reduces task.approval.requested → blocked and renders CREW BLOCKED;
    // defaultNotify must persist that message; the relay must deliver it
    // verbatim. The OLD relay re-derived from event.kind (no approval case) and
    // silently dropped it, leaving the captain blind to permission gates.
    dir = mkdtempSync(join(tmpdir(), "cp-notify-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const handle = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    stop = handle.stop;

    await sendRequest(sock, { kind: "seed", record: seedRec("task-appr-1") });
    await sendRequest(sock, {
      kind: "event",
      project: "p",
      event: {
        type: "task.approval.requested",
        id: "task-appr-1",
        requestId: 1,
        question: "Allow edit to src/foo.ts?",
        kind: "edit",
      },
    });
    await new Promise((r) => setTimeout(r, 100));

    // 1) The daemon-rendered CREW BLOCKED message is persisted on the entry.
    const inboxPath = join(stateRoot, "inbox", "p.log");
    const entry = JSON.parse(readFileSync(inboxPath, "utf-8").trim());
    expect(entry.kind).toBe("task.approval.requested");
    expect(entry.message).toMatch(/^CREW BLOCKED \[claude\//);
    expect(entry.message).toContain("Allow edit to src/foo.ts?");

    // 2) The relay delivers that message verbatim to the captain surface.
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      sendToSurface: sendSpy,
      status: vi.fn().mockResolvedValue({ id: "ws1", name: "captain", status: "running" }),
      listSurfaces: vi.fn().mockResolvedValue([{ workspaceId: "ws1", surfaceId: "s1", title: "captain" }]),
    };
    const stopRelay = await runNotifyRelay({
      project: "p",
      subscriber: "captain",
      stateRoot,
      runtime: runtime as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stopRelay();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1]).toBe(entry.message);
  });

  it("assigns monotonic seq across multiple notifies in the same project", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-notify-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const handle = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    stop = handle.stop;

    for (let i = 0; i < 3; i++) {
      const id = `task-mbx-multi-${i}`;
      await sendRequest(sock, { kind: "seed", record: seedRec(id) });
      await sendRequest(sock, {
        kind: "event",
        project: "p",
        event: { type: "task.done", id, resultRef: `/tmp/r${i}` },
      });
    }
    await new Promise((r) => setTimeout(r, 100));

    const inboxPath = join(stateRoot, "inbox", "p.log");
    const lines = readFileSync(inboxPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("rotates oversize mailbox files automatically via background timer", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-notify-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const handle = startCockpitd({
      stateRoot,
      sockPath: sock,
      sweepMs: 0,
      rotationIntervalMs: 50,
      mailboxConfig: { maxBytes: 100, maxAgeMs: 999_999_999, keepCount: 3 },
    });
    stop = handle.stop;

    for (let i = 0; i < 5; i++) {
      const id = `task-rot-${i}`;
      await sendRequest(sock, { kind: "seed", record: seedRec(id) });
      await sendRequest(sock, {
        kind: "event",
        project: "p",
        event: { type: "task.done", id, resultRef: `/tmp/r${i}` },
      });
    }
    await new Promise((r) => setTimeout(r, 250));
    expect(existsSync(join(stateRoot, "inbox", "p.log.1"))).toBe(true);
  });

  it("does not crash when no captain is reachable (no subprocess invoked)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-notify-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const handle = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });
    stop = handle.stop;

    await sendRequest(sock, { kind: "seed", record: seedRec("task-mbx-quiet") });
    const r: any = await sendRequest(sock, {
      kind: "event",
      project: "p",
      event: { type: "task.done", id: "task-mbx-quiet", resultRef: "/tmp/x" },
    });
    expect(r.state).toBe("done");
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(join(stateRoot, "inbox", "p.log"))).toBe(true);
  });
});
