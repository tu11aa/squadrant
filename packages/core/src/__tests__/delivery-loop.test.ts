import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelivery } from "../daemon/delivery-loop.js";
import { createStore } from "../store.js";
import { LivenessRegistry } from "../daemon/liveness-registry.js";
import { appendCaptainMessage } from "../mailbox.js";
import { STALE_THRESHOLD_MS } from "../daemon/interactive-probe.js";

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
});
