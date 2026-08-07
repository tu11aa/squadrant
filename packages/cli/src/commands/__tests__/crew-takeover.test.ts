import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCrewTakeover } from "../crew-control.js";
import type { TaskRecord, ControlEvent } from "@squadrant/shared";

describe("crew takeover", () => {
  let envSnapshot: NodeJS.ProcessEnv;
  beforeEach(() => {
    envSnapshot = { ...process.env };
    delete process.env.SQUADRANT_CREW_TASK_ID;
    delete process.env.SQUADRANT_CREW_PROJECT;
  });
  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  const fakeTask: TaskRecord = {
    id: "t1", project: "p", provider: "claude", mode: "interactive",
    name: "c1",
    state: "working", task: "do something", createdAt: 1000,
    lastHeartbeat: 1000, lastEvent: "task.started", heartbeatBudgetMs: 300000,
    attempts: [],
  };

  it("emits takeover.started by project and name", async () => {
    let emitted: ControlEvent | undefined;
    let printed = "";
    let sent = false;
    
    await runCrewTakeover("start", { project: "p", crew: "c1", note: "manual fix" }, {
      listTasks: async () => [fakeTask],
      emitEvent: async (_p, ev) => { emitted = ev; },
      runtimeSend: async () => { sent = true; },
      printError: () => {},
      printSuccess: (msg) => { printed = msg; }
    });

    expect(emitted).toEqual({ type: "crew.takeover.started", id: "t1", note: "manual fix" });
    expect(printed).toMatch(/CREW TAKEOVER/);
    expect(sent).toBe(true);
  });

  it("emits takeover.started by --task-id", async () => {
    let emitted: ControlEvent | undefined;
    let printed = "";
    let sent = false;

    process.env.SQUADRANT_CREW_PROJECT = "p";

    await runCrewTakeover("start", { taskId: "t1" }, {
      listTasks: async () => [fakeTask],
      emitEvent: async (_p, ev) => { emitted = ev; },
      runtimeSend: async () => { sent = true; },
      printError: () => {},
      printSuccess: (msg) => { printed = msg; }
    });

    expect(emitted).toEqual({ type: "crew.takeover.started", id: "t1" });
    expect(printed).toMatch(/CREW TAKEOVER/);
    expect(sent).toBe(true);
  });

  it("emits takeover.ended for handback", async () => {
    let emitted: ControlEvent | undefined;
    let printed = "";
    let sent = false;

    process.env.SQUADRANT_CREW_PROJECT = "p";

    await runCrewTakeover("end", { taskId: "t1" }, {
      listTasks: async () => [fakeTask],
      emitEvent: async (_p, ev) => { emitted = ev; },
      runtimeSend: async () => { sent = true; },
      printError: () => {},
      printSuccess: (msg) => { printed = msg; }
    });

    expect(emitted).toEqual({ type: "crew.takeover.ended", id: "t1" });
    expect(printed).toMatch(/CREW HANDBACK/);
    expect(sent).toBe(true);
  });

  it("rejects unknown crew name", async () => {
    await expect(
      runCrewTakeover("start", { project: "p", crew: "unknown" }, {
        listTasks: async () => [],
        emitEvent: async () => {},
        runtimeSend: async () => {},
        printError: () => {},
        printSuccess: () => {}
      })
    ).rejects.toThrow(/not found.*squadrant crew list/);
  });
});
