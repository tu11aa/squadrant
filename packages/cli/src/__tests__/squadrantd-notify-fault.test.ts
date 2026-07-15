// #579/#484 Gap 1: squadrantd.ts wires opts.notifyFault (or, in production, a
// real cmux-notifier-backed default) onto ctx.notifyFault, which delivery-loop
// calls on the DELIVERY STUCK edge — the out-of-band channel that works even
// when Telegram is unconfigured. This proves the wiring end to end through a
// real startSquadrantd() boot, not just the unit-level createDelivery() call.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@squadrant/shared")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

import { startSquadrantd } from "../squadrantd.js";
import { DeferDelivery } from "@squadrant/core";
import type { DaemonCmux } from "@squadrant/workspaces";
import type { PaneRef } from "@squadrant/shared";

function mockConfig(project: string, captainName: string) {
  loadConfigMock.mockReturnValue({
    projects: { [project]: { captainName } },
    commandName: "🏛️ command",
    delivery: { maxDeferDeliveries: 2, stableProbePolls: 999 },
    defaults: {},
  });
}

describe("squadrantd notifyFault wiring (#579/#484 Gap 1)", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("calls opts.notifyFault on the DELIVERY STUCK edge, with no telegramBridge injected at all", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-notify-fault-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");

    const project = "p";
    const captainName = "p-captain";
    mockConfig(project, captainName);

    let n = 0;
    const cmux: DaemonCmux = {
      send: async () => { throw new DeferDelivery(`typing-${n++}`); },
      listSurfaces: async () => [],
      readScreen: async () => null,
      isAvailable: async () => true,
      findWorkspaceId: async () => "ws:1",
    } as unknown as DaemonCmux;

    const notifyFault = vi.fn();
    const handle = startSquadrantd({
      stateRoot,
      sockPath: sock,
      sweepMs: 0,
      daemonCmux: cmux,
      notifyFault,
      captainSurfaces: { [project]: { workspaceId: "ws:1", surfaceId: "s1", title: captainName } as PaneRef },
    });
    stop = handle.stop;

    // Seed one queued message so there's something to defer against.
    const { appendToMailbox, writeCursor } = await import("@squadrant/core");
    await appendToMailbox({
      stateRoot, project,
      taskRecord: {
        id: "t1", project, provider: "claude", mode: "interactive",
        state: "done", task: "t", createdAt: 1, lastHeartbeat: 1,
        lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
      },
      event: { type: "task.done", id: "t1" } as any,
      message: "CREW DONE t1",
    });
    await writeCursor({ stateRoot, project, subscriber: "captain", lastAckedSeq: 0 });

    // maxDeferDeliveries=2 — a handful of ticks with ever-changing content
    // (never stable) crosses the stuck threshold.
    for (let i = 0; i < 6; i++) {
      if (handle.tickDelivery) await handle.tickDelivery();
    }

    expect(notifyFault).toHaveBeenCalledTimes(1);
    expect(notifyFault).toHaveBeenCalledWith(project, expect.stringContaining("DELIVERY STUCK"));
  });
});
