// src/control/__tests__/daemon-relay-health.test.ts
//
// #207: the daemon REGISTERS each project's relay, HEALTH-CHECKS it on the sweep,
// and best-effort HEALs a dark one. The non-negotiable core is detection +
// surface (getRelayHealth) so the captain is never SILENTLY blind; heal is
// secondary (mostly inert under launchd — cmux lineage).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../daemon.js";
import { createStore } from "../store.js";
import { RELAY_GONE_MS } from "../liveness.js";

describe("daemon relay health (#207)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-rh-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("registerRelay → getRelayHealth records pid + lastSeen=now", () => {
    const store = createStore(dir);
    const d = createDaemon({ store, now: () => 1000 });
    d.registerRelay({ project: "p", pid: 42, startedAt: 900 });
    const [rh] = d.getRelayHealth();
    expect(rh).toMatchObject({ project: "p", pid: 42, startedAt: 900, lastSeenMs: 1000 });
  });

  it("relayHeartbeat advances lastSeen", () => {
    let t = 1000;
    const store = createStore(dir);
    const d = createDaemon({ store, now: () => t });
    d.registerRelay({ project: "p", pid: 42, startedAt: 900 });
    t = 5000;
    d.relayHeartbeat({ project: "p", pid: 42 });
    expect(d.getRelayHealth()[0].lastSeenMs).toBe(5000);
  });

  it("sweep heals a relay gone silent past the gone window — exactly once (debounced)", async () => {
    let t = 1000;
    const healed: string[] = [];
    const store = createStore(dir);
    const d = createDaemon({ store, now: () => t, healRelay: (p) => { healed.push(p); } });
    d.registerRelay({ project: "p", pid: 42, startedAt: 900 });

    // Fresh: no heal.
    t = 1000 + RELAY_GONE_MS; // boundary = still stale, not gone
    await d.sweep();
    expect(healed).toEqual([]);

    // Gone: heal fires once.
    t = 1000 + RELAY_GONE_MS + 1;
    await d.sweep();
    expect(healed).toEqual(["p"]);

    // Still gone on the very next sweep: debounced, no repeat hammering.
    t += 1000;
    await d.sweep();
    expect(healed).toEqual(["p"]);
  });

  it("a relay that comes back (fresh heartbeat) re-arms heal for a future death", async () => {
    let t = 1000;
    const healed: string[] = [];
    const store = createStore(dir);
    const d = createDaemon({ store, now: () => t, healRelay: (p) => { healed.push(p); } });
    d.registerRelay({ project: "p", pid: 42, startedAt: 900 });

    t = 1000 + RELAY_GONE_MS + 1;
    await d.sweep();
    expect(healed).toEqual(["p"]);

    // Relay recovers and beats again.
    t += 1000;
    d.relayHeartbeat({ project: "p", pid: 42 });

    // Dies again later → heals again (debounce was re-armed by the heartbeat).
    t += RELAY_GONE_MS + 1;
    await d.sweep();
    expect(healed).toEqual(["p", "p"]);
  });

  it("a healthy relay is never healed", async () => {
    let t = 1000;
    const healed: string[] = [];
    const store = createStore(dir);
    const d = createDaemon({ store, now: () => t, healRelay: (p) => { healed.push(p); } });
    d.registerRelay({ project: "p", pid: 42, startedAt: 900 });
    for (let i = 0; i < 5; i++) {
      t += 10_000;
      d.relayHeartbeat({ project: "p", pid: 42 });
      await d.sweep();
    }
    expect(healed).toEqual([]);
  });

  it("a throwing healRelay never breaks the sweep", async () => {
    let t = 1000;
    const store = createStore(dir);
    const d = createDaemon({ store, now: () => t, healRelay: () => { throw new Error("cmux refused (lineage)"); } });
    d.registerRelay({ project: "p", pid: 42, startedAt: 900 });
    t = 1000 + RELAY_GONE_MS + 1;
    await expect(d.sweep()).resolves.toBeUndefined();
  });
});
