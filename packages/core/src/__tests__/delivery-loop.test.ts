import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelivery } from "../daemon/delivery-loop.js";
import { createStore } from "../store.js";
import { LivenessRegistry } from "../daemon/liveness-registry.js";
import { appendCaptainMessage, appendToMailbox, readCursor } from "../mailbox.js";
import { STALE_THRESHOLD_MS } from "../daemon/interactive-probe.js";
import { DeferDelivery } from "../delivery/defer-delivery.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "deliv-"));
}

describe("delivery-loop", () => {
  it("exempts non-daemon captain.message from stale-skip (#531)", async () => {
    const stateRoot = freshState();
    const store = createStore(stateRoot);
    store.put({
      id: "t1", project: "demo", provider: "claude", mode: "interactive",
      state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, attempts: []
    });
    const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    
    // Simulate liveness
    livenessRegistry.apply({
      project: "demo",
      role: "captain",
      pid: 123,
      sessionId: "s1",
      startedAt: Date.now(),
      lastState: "start",
      lastSeenAt: Date.now(),
      pidAlive: true,
      source: "runtime"
    });
    
    // Create an old telegram message (stale)
    await appendCaptainMessage({
      stateRoot, project: "demo", text: "telegram message", source: "telegram"
    });
    
    // Create an old daemon message (stale)
    await appendCaptainMessage({
      stateRoot, project: "demo", text: "daemon message", source: "daemon"
    });
    
    // Shift the clock so these messages are very old
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + STALE_THRESHOLD_MS + 1000);
    
    const logs: string[] = [];
    const cmux = {
      listSurfaces: async () => [{ id: "s1", title: "demo-captain", command: "bash" }],
      findWorkspaceId: async () => "w1",
      readScreen: async () => "demo-captain> ",
      send: async (surface: any, text: string) => {
        logs.push(`sent: ${text}`);
      }
    };
    
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: (m: string) => {}, isPidAlive: () => true, opts: {}
    } as any, cmux as any);
    
    await deliv.deliveryTick!();
    
    // Wait for async background things if necessary
    // Then check what was sent
    expect(logs).toContain("sent: telegram message");
    expect(logs).not.toContain("sent: daemon message");
    
    vi.useRealTimers();
  });

  it("drains and delivers entries under cfg.commandName", async () => {
    const stateRoot = freshState();
    const store = createStore(stateRoot);
    const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    
    // Command workspace has no project config, it relies on cfg.commandName
    const { loadConfig } = await import("@squadrant/shared");
    const cfg = loadConfig();
    const commandName = cfg.commandName; // Usually "🏛️ command"
    
    livenessRegistry.apply({
      project: commandName,
      role: "captain",
      pid: 123,
      sessionId: "s1",
      startedAt: Date.now(),
      lastState: "start",
      lastSeenAt: Date.now(),
      pidAlive: true,
      source: "runtime"
    });
    
    await appendCaptainMessage({
      stateRoot, project: commandName, text: "hello command", source: "cli"
    });
    
    const logs: string[] = [];
    const cmux = {
      listSurfaces: async () => [{ id: "s1", title: commandName, command: "bash" }],
      findWorkspaceId: async () => "w1",
      readScreen: async () => `${commandName}> `,
      send: async (surface: any, text: string) => {
        logs.push(`sent: ${text}`);
      }
    };
    
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {}
    } as any, cmux as any);
    
    await deliv.deliveryTick!();

    expect(logs).toContain("sent: hello command");
  });

  // #535: repro sketch — a dispatch report-back lands in the mailbox, the
  // daemon restarts before the captain pane accepts it, and a fresh daemon
  // instance resumes over the same on-disk mailbox + cursor. It must deliver
  // the report-back exactly once: never dropped, never duplicated.
  it("delivers a report-back exactly once across a simulated daemon restart (#535)", async () => {
    const stateRoot = freshState();
    const project = "alpha";
    const store = createStore(stateRoot);
    store.put({
      id: "disp1", project, provider: "claude", mode: "interactive",
      state: "done", task: "dispatch B->A report-back", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
    });
    await appendToMailbox({
      stateRoot, project,
      taskRecord: store.list(project)[0],
      event: { type: "task.done", id: "disp1" } as any,
      message: "dispatch report-back",
    });

    const captainName = `${project}-captain`;
    function newRegistry() {
      const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
      registry.apply({
        project, role: "captain", pid: 123, sessionId: "s1",
        startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
        pidAlive: true, source: "runtime",
      });
      return registry;
    }

    // ── "Session 1": daemon boots, attempts delivery, captain pane is busy
    // (deferred) — restart happens before the report-back settles. ──
    const sent: string[] = [];
    const busyCmux = {
      listSurfaces: async () => [{ id: "s1", title: captainName, command: "bash" }],
      findWorkspaceId: async () => "w1",
      readScreen: async () => `${captainName}> `,
      send: async () => { throw new DeferDelivery("captain is composing"); },
    };
    const session1 = createDelivery({
      stateRoot, store, livenessRegistry: newRegistry(), log: () => {}, isPidAlive: () => true, opts: {},
    } as any, busyCmux as any);
    await session1.deliveryTick!();
    expect(sent).toHaveLength(0);
    const cursorAfterSession1 = await readCursor({ stateRoot, project, subscriber: "captain" });
    expect(cursorAfterSession1?.lastAckedSeq ?? 0).toBe(0); // not acked — never sent

    // ── "Session 2": fresh daemon process (new in-memory delivery state,
    // fresh liveness registry) resumes from the same on-disk mailbox+cursor.
    // The pane is now free — delivery succeeds. ──
    const readyCmux = {
      listSurfaces: async () => [{ id: "s1", title: captainName, command: "bash" }],
      findWorkspaceId: async () => "w1",
      readScreen: async () => `${captainName}> `,
      send: async (_surface: any, text: string) => { sent.push(text); },
    };
    const session2 = createDelivery({
      stateRoot, store, livenessRegistry: newRegistry(), log: () => {}, isPidAlive: () => true, opts: {},
    } as any, readyCmux as any);
    await session2.deliveryTick!();
    expect(sent).toEqual(["dispatch report-back"]);
    const cursorAfterSession2 = await readCursor({ stateRoot, project, subscriber: "captain" });
    expect(cursorAfterSession2?.lastAckedSeq).toBe(1);

    // A further tick (still session 2, or a hypothetical session 3) must not
    // redeliver — the cursor already acked seq 1.
    await session2.deliveryTick!();
    expect(sent).toEqual(["dispatch report-back"]);
  });

  // #535 question 2: is the #531 stale-skip exemption for human/CLI-originated
  // captain.message data-driven (persisted per-entry), or does it depend on
  // in-memory state that a restart would lose? Model two daemon sessions: the
  // message ages past STALE_THRESHOLD_MS while no session is running (as if
  // the daemon was down), then a *fresh* session (new sessionStartMs, matching
  // a real restart) resumes and must still deliver it.
  it("the #531 stale-skip exemption survives a restart — it is computed from the persisted entry, not session state", async () => {
    const stateRoot = freshState();
    const project = "beta";
    const captainName = `${project}-captain`;
    const store = createStore(stateRoot);
    // The delivery loop only visits projects it knows about (config, injected
    // surfaces, or the task store) — seed a task so "beta" is in scope.
    store.put({
      id: "t1", project, provider: "claude", mode: "interactive",
      state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
    });
    const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    livenessRegistry.apply({
      project, role: "captain", pid: 123, sessionId: "s1",
      startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
      pidAlive: true, source: "runtime",
    });

    await appendCaptainMessage({ stateRoot, project, text: "human/cli message", source: "cli" });
    await appendCaptainMessage({ stateRoot, project, text: "daemon message", source: "daemon" });

    // Simulate the daemon being down for longer than the stale threshold —
    // the messages sat on disk, unprocessed, across the gap.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + STALE_THRESHOLD_MS + 1000);

    // "Restart": createDelivery() is called only now, so its sessionStartMs
    // captures the post-restart clock — a fresh daemon lifetime, not the one
    // that existed when the messages were enqueued.
    const sent: string[] = [];
    const cmux = {
      listSurfaces: async () => [{ id: "s1", title: captainName, command: "bash" }],
      findWorkspaceId: async () => "w1",
      readScreen: async () => `${captainName}> `,
      send: async (_surface: any, text: string) => { sent.push(text); },
    };
    const postRestart = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);
    await postRestart.deliveryTick!();

    expect(sent).toContain("human/cli message");
    expect(sent).not.toContain("daemon message");

    vi.useRealTimers();
  });
});
