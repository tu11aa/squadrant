// #1051: crew compact types /compact only into an idle crew pane, holds `crew send` meanwhile, and refuses what it cannot compact.
import { describe, it, expect, vi } from "vitest";
import type { TaskRecord } from "@squadrant/shared";
import { createCrewCompact } from "../crew-compact.js";
import { DeferDelivery } from "../../delivery/defer-delivery.js";
import type { DaemonSurfaceDriver } from "../../interfaces.js";

const SURFACE = { workspaceId: "w", surfaceId: "s", title: "🔧 demo:crew-1" };
const BUSY = "✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)\n╭──╮\n│ > │\n╰──╯";
const IDLE = "╭──╮\n│ > │\n╰──╯\n  ⏵⏵ accept edits on";

const rec = (o: Partial<TaskRecord> = {}): TaskRecord =>
  ({ id: "t1", project: "demo", name: "crew-1", provider: "claude", state: "awaiting-input", createdAt: 1, ...o }) as TaskRecord;

function harness(o: { task?: Partial<TaskRecord>; screens?: string[]; send?: () => Promise<void>; holdMs?: number; surface?: boolean } = {}) {
  let t = 1000;
  const logs: string[] = [];
  const task = rec(o.task);
  const screens = [...(o.screens ?? [IDLE])];
  const send = vi.fn(async () => { await (o.send ?? (async () => {}))(); });
  const cmux = {
    findWorkspaceId: async () => null,
    listSurfaces: async () => [],
    readPaneScreen: async () => (screens.length > 1 ? screens.shift()! : screens[0]),
    send,
  } as unknown as DaemonSurfaceDriver;
  const c = createCrewCompact({
    cmux, log: (l) => logs.push(l), now: () => t, holdMs: o.holdMs,
    tasks: () => [task], captainTitle: () => "demo-captain",
    injectedSurfaces: o.surface === false ? {} : { "demo:crew-1": SURFACE },
  });
  return { c, send, logs, task, advance: (ms: number) => { t += ms; } };
}

describe("crew compact", () => {
  it("queues, waits while the crew is mid-turn, types once idle, then holds until SessionStart(compact)", async () => {
    const h = harness({ screens: [BUSY, IDLE] });
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
    await expect(h.c.request("demo", "crew-1", "  keep PR 7 ")).resolves.toEqual({ queued: true, agent: "claude" });
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true); // queued ⇒ sends already wait
    await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    await h.c.tick(); // idle poll 1
    await h.c.tick(); // idle poll 2 → send
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact keep PR 7", { agent: "claude" });
    expect(h.c.pendingCount()).toBe(0);
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true); // typed, compact still running
    h.c.compactDone("t1");
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false); // sends resume, after the compact
  });

  it("types /compact exactly once when the next interval tick fires while the send is still in flight", async () => {
    const releases: Array<() => void> = [];
    const h = harness({ send: () => new Promise<void>((r) => { releases.push(r); }) });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); // idle poll 1
    const first = h.c.tick(); // idle poll 2 → send starts, still awaiting
    await new Promise((r) => setTimeout(r, 0));
    const second = h.c.tick(); // next interval fires mid-send
    await new Promise((r) => setTimeout(r, 0));
    releases.forEach((r) => r());
    await Promise.all([first, second]);
    await h.c.tick();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.logs.filter((l) => l.endsWith("/compact sent"))).toHaveLength(1);
  });

  it("does not type while the task is working, even with an idle-looking pane", async () => {
    const h = harness({ task: { state: "working" } });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick(); await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    h.task.state = "awaiting-input";
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact", { agent: "claude" });
  });

  it("compacts an already-idle crew whose task is done and carries a stale pendingTool", async () => {
    const h = harness({ task: { state: "done", pendingTool: { name: "mcp__squadrant__crew_signal_done", since: 1 } } });
    await h.c.request("demo", "crew-1", "smoke");
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact smoke", { agent: "claude" });
  });

  it("still waits on a live task's open tool, and says why", async () => {
    const h = harness({ task: { state: "awaiting-input", pendingTool: { name: "Bash", since: 1 } } });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logs.some((l) => l.includes("still waiting (tool-open)"))).toBe(true);
  });

  it("waits through an open tool call and a send-guard deferral, then types", async () => {
    let calls = 0;
    const h = harness({ send: async () => { if (++calls === 1) throw new DeferDelivery(null, "draft"); } });
    h.task.pendingTool = { name: "Bash", since: 1 };
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    h.task.pendingTool = undefined;
    await h.c.tick(); await h.c.tick(); // deferred
    expect(h.c.pendingCount()).toBe(1);
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.c.pendingCount()).toBe(0);
  });

  it("opencode crews are typed with the opencode grammar and judged by task state, not the Claude spinner", async () => {
    const h = harness({ task: { provider: "opencode" }, screens: [BUSY] });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact", { agent: "opencode" });
  });

  it("the hold lapses on its own if no SessionStart(compact) arrives", async () => {
    const h = harness({ holdMs: 5000 });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick();
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true);
    h.advance(6000);
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
    expect(h.logs.some((l) => l.includes("hold lapsed"))).toBe(true);
  });

  it("refuses a crew under operator takeover, at request time", async () => {
    const h = harness({ task: { operatorHold: { since: 1 } } });
    await expect(h.c.request("demo", "crew-1")).rejects.toThrow(/operator takeover/);
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
  });

  it("drops a queued compact when the operator takes over before it runs", async () => {
    const h = harness({ task: { state: "working" } });
    await h.c.request("demo", "crew-1");
    h.task.operatorHold = { since: 2 };
    await h.c.tick();
    expect(h.c.pendingCount()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("refuses gemini and codex crews, unknown crews, ended crews and crews without a pane", async () => {
    await expect(harness({ task: { provider: "gemini" } }).c.request("demo", "crew-1")).rejects.toThrow(/gemini.*fresh crew/);
    await expect(harness({ task: { provider: "codex" } }).c.request("demo", "crew-1")).rejects.toThrow(/codex.*fresh crew/);
    await expect(harness().c.request("demo", "nope")).rejects.toThrow(/not found/);
    await expect(harness({ task: { state: "cancelled" } }).c.request("demo", "crew-1")).rejects.toThrow(/ended/);
    await expect(harness({ surface: false }).c.request("demo", "crew-1")).rejects.toThrow(/no live pane/);
  });

  it("times out cleanly when the crew never goes idle, releasing the hold", async () => {
    const h = harness({ task: { state: "working" } });
    await h.c.request("demo", "crew-1");
    h.advance(11 * 60_000);
    await h.c.tick();
    expect(h.c.pendingCount()).toBe(0);
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
    expect(h.logs.some((l) => l.includes("timed out"))).toBe(true);
  });
});
