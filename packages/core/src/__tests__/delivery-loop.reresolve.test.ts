// #713: a 'probe-failed' defer (#714) means the cmux invocation itself failed —
// most likely a stale surface ref after a captain restart. The resolved captain
// surface was never re-resolved, so a dead ref deferred forever (the ~4h
// 2026-08-22 jam; a daemon bounce drained instantly). On probe-failed the loop
// must re-resolve via the existing discovery path and retry against the new
// surface — exactly once per attempt, never on no-box/modal/draft (those mean
// the surface is alive), and without looping when re-resolution finds nothing
// or the SAME dead surface.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
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

import { createDelivery } from "../daemon/delivery-loop.js";
import { createStore } from "../store.js";
import { LivenessRegistry } from "../daemon/liveness-registry.js";
import { appendToMailbox, readCursor } from "../mailbox.js";
import { DeferDelivery } from "../delivery/defer-delivery.js";
import type { PaneRef } from "@squadrant/shared";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "deliv-reresolve-"));
}

async function seedMailbox(stateRoot: string, project: string): Promise<void> {
  const store = createStore(stateRoot);
  store.put({
    id: "t1", project, provider: "claude", mode: "interactive",
    state: "done", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
  });
  await appendToMailbox({
    stateRoot, project, taskRecord: store.list(project)[0],
    event: { type: "task.done", id: "t1" } as any,
    message: "CREW DONE t1",
  });
}

function liveRegistry(stateRoot: string, project: string): LivenessRegistry {
  const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
  livenessRegistry.apply({
    project, role: "captain", pid: 123, sessionId: "s1",
    startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
    pidAlive: true, source: "runtime",
  });
  return livenessRegistry;
}

describe("delivery-loop probe-failed surface re-resolution (#713)", () => {
  it("a probe-failed defer triggers exactly one re-resolution and retries against the NEW surface", async () => {
    const stateRoot = freshState();
    const project = "alpha";
    const captainName = `${project}-captain`;
    loadConfigMock.mockReturnValue({ projects: { [project]: { captainName } }, commandName: "cmd" });
    await seedMailbox(stateRoot, project);
    const livenessRegistry = liveRegistry(stateRoot, project);

    const oldSurface: PaneRef = { workspaceId: "w1", surfaceId: "surface:1", title: captainName };
    const newSurface: PaneRef = { workspaceId: "w1", surfaceId: "surface:6", title: captainName };

    let listCalls = 0;
    const sendsTo: PaneRef[] = [];
    const cmux = {
      // call 1 = tick-start discovery (old surface still listed); call 2 =
      // the post-failure re-resolution (old pane gone, new one up).
      listSurfaces: async () => (++listCalls === 1 ? [oldSurface] : [newSurface]),
      findWorkspaceId: async (name: string) => (name === captainName ? "w1" : null),
      send: async (surface: PaneRef) => {
        sendsTo.push(surface);
        if (surface.surfaceId === "surface:1") throw new DeferDelivery(null, "probe-failed");
        // new surface delivers
      },
    };
    const deliv = createDelivery({
      stateRoot, store: createStore(stateRoot), livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    await deliv.deliveryTick!();

    // Exactly ONE re-resolution: initial discovery + one retry, nothing more.
    expect(listCalls).toBe(2);
    expect(sendsTo).toHaveLength(2);
    expect(sendsTo[0].surfaceId).toBe("surface:1");
    expect(sendsTo[1].surfaceId).toBe("surface:6");
    // Delivered on the retried surface — cursor advanced.
    const cursor = await readCursor({ stateRoot, project, subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
  });

  it.each(["no-box", "modal", "draft"] as const)(
    "a %s defer triggers NO re-resolution (the surface is alive, the pane is just busy)",
    async (reason) => {
      const stateRoot = freshState();
      const project = `no-reresolve-${reason}`;
      const captainName = `${project}-captain`;
      loadConfigMock.mockReturnValue({ projects: { [project]: { captainName } }, commandName: "cmd" });
      await seedMailbox(stateRoot, project);
      const livenessRegistry = liveRegistry(stateRoot, project);

      const surface: PaneRef = { workspaceId: "w1", surfaceId: "surface:1", title: captainName };
      let listCalls = 0;
      let sendCalls = 0;
      const cmux = {
        listSurfaces: async () => { listCalls++; return [surface]; },
        findWorkspaceId: async (name: string) => (name === captainName ? "w1" : null),
        send: async () => { sendCalls++; throw new DeferDelivery(null, reason); },
      };
      const deliv = createDelivery({
        stateRoot, store: createStore(stateRoot), livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
      } as any, cmux as any);

      await deliv.deliveryTick!();

      // Initial discovery only — no re-resolution, no retry.
      expect(listCalls).toBe(1);
      expect(sendCalls).toBe(1);
      const cursor = await readCursor({ stateRoot, project, subscriber: "captain" });
      expect(cursor?.lastAckedSeq ?? 0).toBe(0); // still deferred
    },
  );

  it("re-resolution finding NO surface defers without looping or retrying", async () => {
    const stateRoot = freshState();
    const project = "gone";
    const captainName = `${project}-captain`;
    loadConfigMock.mockReturnValue({ projects: { [project]: { captainName } }, commandName: "cmd" });
    await seedMailbox(stateRoot, project);
    const livenessRegistry = liveRegistry(stateRoot, project);

    const surface: PaneRef = { workspaceId: "w1", surfaceId: "surface:1", title: captainName };
    let listCalls = 0;
    let sendCalls = 0;
    const cmux = {
      // Discovery sees it once; after the failure the captain surface is gone.
      listSurfaces: async () => { listCalls++; return listCalls === 1 ? [surface] : []; },
      findWorkspaceId: async (name: string) => (name === captainName ? "w1" : null),
      send: async () => { sendCalls++; throw new DeferDelivery(null, "probe-failed"); },
    };
    const deliv = createDelivery({
      stateRoot, store: createStore(stateRoot), livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    await deliv.deliveryTick!();

    expect(sendCalls).toBe(1); // no retry
    expect(listCalls).toBe(2); // exactly one re-resolution, no loop
    const cursor = await readCursor({ stateRoot, project, subscriber: "captain" });
    expect(cursor?.lastAckedSeq ?? 0).toBe(0);
  });

  it("re-resolution finding the SAME dead surface defers without looping or retrying", async () => {
    const stateRoot = freshState();
    const project = "same";
    const captainName = `${project}-captain`;
    loadConfigMock.mockReturnValue({ projects: { [project]: { captainName } }, commandName: "cmd" });
    await seedMailbox(stateRoot, project);
    const livenessRegistry = liveRegistry(stateRoot, project);

    const surface: PaneRef = { workspaceId: "w1", surfaceId: "surface:1", title: captainName };
    let listCalls = 0;
    let sendCalls = 0;
    const logs: string[] = [];
    const cmux = {
      listSurfaces: async () => { listCalls++; return [surface]; },
      findWorkspaceId: async (name: string) => (name === captainName ? "w1" : null),
      send: async () => { sendCalls++; throw new DeferDelivery(null, "probe-failed"); },
    };
    const deliv = createDelivery({
      stateRoot, store: createStore(stateRoot), livenessRegistry,
      log: (m: string) => logs.push(m), isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    await deliv.deliveryTick!();

    expect(sendCalls).toBe(1); // no retry against the same dead ref
    expect(listCalls).toBe(2); // exactly one re-resolution, no unbounded loop
    expect(logs.some((l) => l.includes("same dead surface"))).toBe(true);
    const cursor = await readCursor({ stateRoot, project, subscriber: "captain" });
    expect(cursor?.lastAckedSeq ?? 0).toBe(0);
  });
});
