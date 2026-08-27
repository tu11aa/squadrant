import { describe, it, expect } from "vitest";
import { createInteractiveProbe, PROBE_QUIET_MS } from "../daemon/interactive-probe.js";
import type { TaskRecord, ControlEvent } from "@squadrant/shared";

function makeRec(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    name: "rm-gitnexus",
    project: "demo",
    provider: "opencode",
    mode: "interactive",
    state: "working",
    task: "t",
    createdAt: 0,
    lastHeartbeat: 0,
    lastEvent: "",
    heartbeatBudgetMs: 1000,
    attempts: [],
    ...overrides,
  };
}

function setup(opts: {
  tail: string;
  checkAlive?: (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown">;
  withNotify?: boolean;
}) {
  const rec = makeRec();
  const sent: ControlEvent[] = [];
  const logs: string[] = [];
  const notified: { project: string; message: string; record: TaskRecord; event: ControlEvent }[] = [];
  const probe = createInteractiveProbe({
    project: "_all_",
    listTasks: async () => [rec],
    readPaneTail: async () => opts.tail,
    sendEvent: async (event) => { sent.push(event); },
    now: () => PROBE_QUIET_MS + 1,
    log: (m) => logs.push(m),
    checkAlive: opts.checkAlive,
    notify: opts.withNotify ? async (args) => { notified.push(args); } : undefined,
  });
  return { probe, sent, logs, notified };
}

describe("interactive-probe #704", () => {
  it("does not fail a crew whose pane shows AGENTS.md's own bug-report bullet (quoted line)", async () => {
    const tail = [
      "● Reading AGENTS.md before filing a report.",
      "- transient model-infra: `API Error: 529`, `Overloaded`, `429`, `retrying 7/10`, `retries exhausted`",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    const { probe, sent } = setup({ tail, checkAlive: async () => "gone" });
    await probe.tick();
    expect(sent).toEqual([]);
  });

  it("downgrades to a warning instead of failing when the crew's pane is still alive", async () => {
    const tail = [
      "● Calling the API...",
      "API Error: 529 Overloaded",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    const { probe, sent, logs } = setup({ tail, checkAlive: async () => "alive" });
    await probe.tick();
    expect(sent).toEqual([]);
    expect(logs.some((l) => l.includes("CREW WARN"))).toBe(true);
  });

  it("pushes a non-terminal task.warn to the captain pane (via notify) instead of staying silent", async () => {
    const tail = [
      "● Calling the API...",
      "API Error: 529 Overloaded",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    const { probe, sent, notified } = setup({ tail, checkAlive: async () => "alive", withNotify: true });
    await probe.tick();
    expect(sent).toEqual([]); // never goes through sendEvent/reduce — task.warn is a direct notify push
    expect(notified).toHaveLength(1);
    expect(notified[0].project).toBe("demo");
    expect(notified[0].record.id).toBe("t1");
    expect(notified[0].event).toMatchObject({ type: "task.warn", id: "t1" });
    expect(notified[0].message).toContain("CREW WARN");
    expect(notified[0].message).toContain("not terminalized");
  });

  it("still fails a crew with a genuine error whose pane is confirmed gone", async () => {
    const tail = [
      "● Calling the API...",
      "API Error: 529 Overloaded",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    const { probe, sent } = setup({ tail, checkAlive: async () => "gone" });
    await probe.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "task.failed", id: "t1" });
  });

  it("downgrades instead of failing when checkAlive is not wired (unknown defaults safe)", async () => {
    const tail = [
      "● Calling the API...",
      "API Error: 529 Overloaded",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
    ].join("\n");
    const { probe, sent } = setup({ tail });
    await probe.tick();
    expect(sent).toEqual([]);
  });
});
