import { describe, it, expect } from "vitest";
import { createInteractiveProbe, PROBE_QUIET_MS, classifyProbeError } from "../daemon/interactive-probe.js";
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

describe("interactive-probe #1112 retry noise + class dedup", () => {
  const DNS = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
  const SLEEP = "API Error: Your computer went to sleep mid-response. The response above may be incomplete.";
  const RETRY = "✻ API error · Retrying in 0s · attempt 1/10";
  const box = ["╭────────────╮", "│ >          │", "╰────────────╯"];
  const tailOf = (...lines: string[]) => [...lines, ...box].join("\n");

  it("classifies the real incident strings", () => {
    expect(classifyProbeError(DNS)).toBe("network");
    expect(classifyProbeError(SLEEP)).toBe("sleep");
    expect(classifyProbeError(RETRY)).toBe("retrying");
    expect(classifyProbeError("API Error: Your computer went offline")).toBe("network");
    expect(classifyProbeError("API Error: 529 Overloaded")).toBe("other");
  });

  it("never alerts on a Retrying line", async () => {
    const { probe, notified, sent } = setup({ tail: tailOf(RETRY), checkAlive: async () => "alive", withNotify: true });
    await probe.tick();
    expect(notified).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("a Retrying line under a real error does not replace the error line", async () => {
    const { probe, notified } = setup({ tail: tailOf(DNS, RETRY), checkAlive: async () => "alive", withNotify: true });
    await probe.tick();
    expect(notified).toHaveLength(1);
    expect(notified[0].message).toContain("ENOTFOUND");
  });

  it("warns once per (task, class) while the pane tail keeps changing; a new class warns again", async () => {
    const rec = makeRec();
    let tail = tailOf(DNS);
    const notified: string[] = [];
    const probe = createInteractiveProbe({
      project: "_all_", listTasks: async () => [rec], readPaneTail: async () => tail,
      sendEvent: async () => {}, now: () => PROBE_QUIET_MS + 1, log: () => {},
      checkAlive: async () => "alive", notify: async (a) => { notified.push(a.message); },
    });
    await probe.tick();
    tail = tailOf(DNS, RETRY, "✻ Thinking… (4s)"); // tail changed, same class
    await probe.tick();
    tail = tailOf(DNS, "✻ Thinking… (9s)");
    await probe.tick();
    expect(notified).toHaveLength(1);
    tail = tailOf(SLEEP); // different class
    await probe.tick();
    expect(notified).toHaveLength(2);
  });

  it("resets the dedup when the crew heartbeats again", async () => {
    const rec = makeRec();
    let tail = tailOf(DNS);
    const notified: string[] = [];
    const probe = createInteractiveProbe({
      project: "_all_", listTasks: async () => [rec], readPaneTail: async () => tail,
      sendEvent: async () => {}, now: () => 10 * PROBE_QUIET_MS, log: () => {},
      checkAlive: async () => "alive", notify: async (a) => { notified.push(a.message); },
    });
    await probe.tick();
    rec.lastHeartbeat = 5; // crew recovered, then failed again
    tail = tailOf(DNS, "✻ again");
    await probe.tick();
    expect(notified).toHaveLength(2);
  });
});
