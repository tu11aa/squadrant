import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUndelivered } from "../mailbox.js";
import { CREW_SIGNAL_TOOLS, callCrewSignalTool, crewSignalToolList } from "../crew-signal-tools.js";

let root: string;
const saved = { ...process.env };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-mcp-"));
  process.env.SQUADRANT_STATE_DIR = root;
  process.env.SQUADRANT_CREW_TASK_ID = "11111111-aaaa";
  process.env.SQUADRANT_CREW_PROJECT = "proj";
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(root, { recursive: true, force: true });
});

const daemon = (state: string | null) =>
  vi.fn(async (req: any) => (req.kind === "status" ? (state ? { id: "11111111-aaaa", state } : null) : undefined));

describe("crew signal MCP tools (#1029)", () => {
  it("lists done/blocked/failed/review", () => {
    expect(CREW_SIGNAL_TOOLS.map((t) => t.name)).toEqual(["crew_signal_done", "crew_signal_blocked", "crew_signal_failed", "crew_signal_review"]);
  });

  it("done: emits task.done with a _results file, ids from env", async () => {
    const call = daemon("working");
    const r = await callCrewSignalTool("crew_signal_done", { message: "all good" }, { call });
    expect(r).toEqual({ text: "✔ signalled done for proj (task 11111111)", isError: false });
    const ev = call.mock.calls.map((c) => c[0] as any).find((q) => q.kind === "event");
    expect(ev.project).toBe("proj");
    expect(ev.event).toMatchObject({ type: "task.done", id: "11111111-aaaa", message: "all good" });
    expect(fs.readFileSync(ev.event.resultRef, "utf8")).toBe("all good");
  });

  it("blocked / failed / review emit their events", async () => {
    for (const [tool, args, expected] of [
      ["crew_signal_blocked", { question: "which?" }, { type: "task.blocked", question: "which?" }],
      ["crew_signal_failed", { error: "boom" }, { type: "task.failed", error: "boom" }],
      ["crew_signal_review", { message: "look" }, { type: "task.review", message: "look" }],
    ] as const) {
      const call = daemon("working");
      const r = await callCrewSignalTool(tool, args, { call });
      expect(r.isError).toBe(false);
      expect((call.mock.calls.map((c) => c[0] as any).find((q) => q.kind === "event")).event).toMatchObject(expected);
    }
  });

  it("explicit task_id/project override env", async () => {
    const call = daemon("working");
    await callCrewSignalTool("crew_signal_blocked", { question: "q", task_id: "t2", project: "p2" }, { call });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ kind: "event", project: "p2" }));
  });

  it("already terminal is a tool error", async () => {
    const call = daemon("done");
    const r = await callCrewSignalTool("crew_signal_done", { message: "x" }, { call });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already terminal \(state=done\)/);
    expect(call.mock.calls.some((c) => (c[0] as any).kind === "event")).toBe(false);
  });

  it("missing crew env is a tool error", async () => {
    delete process.env.SQUADRANT_CREW_TASK_ID;
    const r = await callCrewSignalTool("crew_signal_done", {}, { call: daemon("working") });
    expect(r).toEqual({ text: "not running under a crew (SQUADRANT_CREW_TASK_ID unset)", isError: true });
  });

  it("daemon failure is a tool error", async () => {
    const r = await callCrewSignalTool("crew_signal_done", {}, { call: vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }) });
    expect(r).toEqual({ text: "connect ECONNREFUSED", isError: true });
  });

  it("unknown tool is a tool error", async () => {
    expect((await callCrewSignalTool("nope", {}, { call: daemon(null) })).isError).toBe(true);
  });
});

describe("crewSignalToolList (MCP tools/list payload)", () => {
  it("under a crew, lists all four crew_signal_* tools marked alwaysLoad so Claude skips the ToolSearch step", () => {
    const list = crewSignalToolList({ SQUADRANT_CREW_TASK_ID: "t1" });
    expect(list.map((x) => x.name)).toEqual(["crew_signal_done", "crew_signal_blocked", "crew_signal_failed", "crew_signal_review"]);
    for (const tool of list) {
      expect(tool._meta).toEqual({ "anthropic/alwaysLoad": true });
      expect(tool.inputSchema.type).toBe("object");
      expect(Object.keys(tool.inputSchema.properties)).toEqual(expect.arrayContaining(["task_id", "project"]));
    }
  });
  it("outside a crew (captain / operator session) the tools stay deferred: no _meta", () => {
    for (const tool of crewSignalToolList({})) expect(tool).not.toHaveProperty("_meta");
  });
});

describe("done while in review is not a success (#1069)", () => {
  const entries = async () => (await readUndelivered(root, "proj")).filter((e) => e.kind === "captain.message");

  it("is an error with guidance, emits no event, and tells the captain once across repeats", async () => {
    const call = daemon("review");
    for (let i = 0; i < 2; i++) {
      const r = await callCrewSignalTool("crew_signal_done", { message: "x" }, { call });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("in review (held for captain approval) — done not applied");
    }
    expect(call.mock.calls.some((c) => (c[0] as any).kind === "event")).toBe(false);
    const msgs = await entries();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.message).toContain("signalled done while in review");
  });

  it("a fresh review signal re-arms the captain notice", async () => {
    await callCrewSignalTool("crew_signal_done", {}, { call: daemon("review") });
    await callCrewSignalTool("crew_signal_review", { message: "again" }, { call: daemon("working") });
    await callCrewSignalTool("crew_signal_done", {}, { call: daemon("review") });
    expect(await entries()).toHaveLength(2);
  });

  it("done from working still succeeds with the ✔ line and no captain notice", async () => {
    const r = await callCrewSignalTool("crew_signal_done", {}, { call: daemon("working") });
    expect(r).toEqual({ text: "✔ signalled done for proj (task 11111111)", isError: false });
    expect(await entries()).toHaveLength(0);
  });
});
