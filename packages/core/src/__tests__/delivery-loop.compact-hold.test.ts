// #1015: while a captain compact is armed/running, the delivery loop types nothing, the
import { unframe } from "./unframe.js";
// cursor never advances for a held entry, and the backlog delivers in order afterwards.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@squadrant/shared")>();
  return { ...actual, loadConfig: loadConfigMock };
});

import { createDelivery } from "../daemon/delivery-loop.js";
import { createStore } from "../store.js";
import { LivenessRegistry } from "../daemon/liveness-registry.js";
import { appendToMailbox, readCursor, readUndelivered } from "../mailbox.js";

describe("delivery-loop compact hold (#1015)", () => {
  it("holds entries with the cursor unmoved, then delivers them in order once released", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "deliv-hold-"));
    loadConfigMock.mockReturnValue({ projects: { p: { captainName: "p-captain" } }, commandName: "cmd", delivery: { maxDeferDeliveries: 300, stableProbePolls: 999 } });
    const store = createStore(stateRoot);
    const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    store.put({
      id: "t1", project: "p", provider: "claude", mode: "interactive", state: "done", task: "t",
      createdAt: 1, lastHeartbeat: 1, lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
    });
    for (const message of ["first", "second"]) {
      await appendToMailbox({ stateRoot, project: "p", taskRecord: store.list("p")[0], event: { type: "task.done", id: "t1" } as any, message });
    }
    registry.apply({ project: "p", role: "captain", pid: 1, sessionId: "s", startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(), pidAlive: true, source: "runtime" });

    const sent: string[] = [];
    const cmux = {
      listSurfaces: async (ws: string) => [{ id: "s1", title: ws, command: "bash" }],
      findWorkspaceId: async (t: string) => t,
      readScreen: async () => "",
      send: async (_s: any, text: string) => { sent.push(unframe(text)); },
    };
    let held = true;
    const ctx: any = { stateRoot, store, livenessRegistry: registry, log: () => {}, isPidAlive: () => true, opts: {}, captainCompactHolds: () => held };
    const deliv = createDelivery(ctx, cmux as any);

    await deliv.deliveryTick!();
    expect(sent).toEqual([]);
    expect((await readCursor({ stateRoot, project: "p", subscriber: "captain" }))?.lastAckedSeq ?? 0).toBe(0);
    expect(await readUndelivered(stateRoot, "p")).toHaveLength(2);

    held = false;
    await deliv.deliveryTick!();
    expect(sent).toEqual(["first", "second"]);
    expect(await readUndelivered(stateRoot, "p")).toHaveLength(0);
  });
});
