// src/control/__tests__/cockpitd-smoke.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";

describe("cockpitd smoke", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("starts, accepts an event for a pre-seeded task, persists state", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cd-"));
    const sock = join(dir, "c.sock");
    const handle = startCockpitd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0 });
    stop = handle.stop;
    await sendRequest(sock, { kind: "seed", record: {
      id: "t1", project: "p", provider: "claude", mode: "interactive",
      state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000 } });
    const r: any = await sendRequest(sock, { kind: "event", project: "p", event: { type: "task.started", id: "t1" } });
    expect(r.state).toBe("working");
  });
});
