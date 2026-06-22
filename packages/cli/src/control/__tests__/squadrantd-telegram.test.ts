// src/control/__tests__/squadrantd-telegram.test.ts
//
// Task 7: the daemon wires the Telegram bridge additively and opt-in.
// - With NO bridge injected (config.telegram absent under vitest), notify behaves
//   exactly as before — the base notify is called unchanged (regression guard).
// - With an injected fake bridge, it starts on boot, stops on shutdown, and its
//   pushLifecycle is composed onto the notify fan-out (a captain notification also
//   pushes to Telegram). The fake keeps this off the real network.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSquadrantd } from "../squadrantd.js";
import { sendRequest } from "@squadrant/core";
import type { TaskRecord } from "@squadrant/shared";

function seedRec(id: string): TaskRecord {
  return {
    id, project: "p", provider: "claude", mode: "interactive",
    state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
  };
}

describe("squadrantd telegram bridge wiring", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("regression: with no bridge, notify routes to the base function unchanged", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-tg-none-"));
    const notify = vi.fn();
    const handle = startSquadrantd({
      stateRoot: join(dir, "state"),
      sockPath: join(dir, "c.sock"),
      sweepMs: 0,
      notify,
      // no telegramBridge injected
    });
    stop = handle.stop;

    await sendRequest(join(dir, "c.sock"), { kind: "seed", record: seedRec("t1") });
    await sendRequest(join(dir, "c.sock"), {
      kind: "event", project: "p",
      event: { type: "task.done", id: "t1", resultRef: "/tmp/r" },
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      project: "p",
      event: { type: "task.done", id: "t1" },
    });
  });

  it("starts/stops the injected bridge and composes pushLifecycle onto notify", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-tg-wired-"));
    const notify = vi.fn();
    const bridge = { start: vi.fn(), stop: vi.fn(), pushLifecycle: vi.fn() };
    const handle = startSquadrantd({
      stateRoot: join(dir, "state"),
      sockPath: join(dir, "c.sock"),
      sweepMs: 0,
      notify,
      telegramBridge: bridge,
    });
    stop = handle.stop;

    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.start).toHaveBeenCalledTimes(1);

    await sendRequest(join(dir, "c.sock"), { kind: "seed", record: seedRec("t2") });
    await sendRequest(join(dir, "c.sock"), {
      kind: "event", project: "p",
      event: { type: "task.done", id: "t2", resultRef: "/tmp/r" },
    });
    await new Promise((r) => setTimeout(r, 100));

    // Base notify still runs (delivery to the captain is unaffected) …
    expect(notify).toHaveBeenCalledTimes(1);
    // … and the same notification also pushes to Telegram.
    expect(bridge.pushLifecycle).toHaveBeenCalledTimes(1);
    expect(bridge.pushLifecycle).toHaveBeenCalledWith(
      "p",
      expect.objectContaining({ type: "task.done", id: "t2" }),
    );

    await handle.stop();
    stop = undefined;
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });
});
