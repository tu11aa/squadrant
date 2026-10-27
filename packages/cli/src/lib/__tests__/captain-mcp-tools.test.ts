import { describe, it, expect, vi } from "vitest";
import { mcpRole, mcpToolList, callMcpTool, createCaptainTools, realDeps, type CaptainDeps } from "../captain-mcp-tools.js";

const CAPTAIN = { SQUADRANT_ROLE: "captain" } as NodeJS.ProcessEnv;
const CREW = { SQUADRANT_CREW_TASK_ID: "t1", SQUADRANT_CREW_PROJECT: "p" } as NodeJS.ProcessEnv;
const signalDeps = { call: vi.fn() };

const EXPECTED = [
  "crew_spawn", "crew_send", "crew_list", "crew_tasks", "crew_read", "crew_msg", "crew_compact", "crew_close",
  "thread_open", "thread_park", "thread_resume", "thread_list", "side_spawn", "side_send",
  "ping", "dispatch", "captain_compact", "status", "rules_search", "check_inbox",
];

/** A deps object whose every function is a spy; `over` fills in return values. */
function fakes(over: Partial<Record<keyof CaptainDeps, unknown>> = {}) {
  const d: Record<string, unknown> = {};
  for (const k of Object.keys(realDeps)) d[k] = vi.fn();
  Object.assign(d, { currentProject: () => "own", ...over });
  return d as unknown as { [K in keyof CaptainDeps]: ReturnType<typeof vi.fn> } & CaptainDeps;
}
const call = (name: string, args: Record<string, unknown>, d: CaptainDeps, env = CAPTAIN) => callMcpTool(name, args, signalDeps, env, d);

describe("role scoping", () => {
  it("captain session lists the captain batch, each tool alwaysLoad, and no crew_signal_*", () => {
    const tools = mcpToolList(CAPTAIN);
    expect(tools.map((t) => t.name)).toEqual(EXPECTED);
    for (const t of tools) expect((t as { _meta?: unknown })._meta).toEqual({ "anthropic/alwaysLoad": true });
  });

  it("crew session lists only crew_signal_*", () => {
    const names = mcpToolList(CREW).map((t) => t.name);
    expect(names).toEqual(["crew_signal_done", "crew_signal_blocked", "crew_signal_failed", "crew_signal_review"]);
  });

  it("crew id wins over captain role", () => {
    expect(mcpRole({ ...CAPTAIN, ...CREW })).toBe("crew");
    expect(mcpToolList({ ...CAPTAIN, ...CREW }).map((t) => t.name)).not.toContain("crew_spawn");
  });

  it("any other session gets no captain tools", () => {
    for (const env of [{}, { SQUADRANT_ROLE: "thread" }, { SQUADRANT_ROLE: "side" }, { SQUADRANT_ROLE: "Captain" }] as NodeJS.ProcessEnv[]) {
      const names = mcpToolList(env).map((t) => t.name);
      expect(names.every((n) => n.startsWith("crew_signal_"))).toBe(true);
    }
  });

  it("a hidden tool cannot be called outside a captain session", async () => {
    const d = fakes();
    for (const env of [CREW, {} as NodeJS.ProcessEnv]) {
      const r = await call("crew_spawn", { task: "x" }, d, env);
      expect(r.isError).toBe(true);
      expect(d.runCrewSpawn).not.toHaveBeenCalled();
    }
  });

  it("a captain cannot call crew_signal_*", async () => {
    const r = await call("crew_signal_done", { message: "x" }, fakes());
    expect(r).toEqual({ text: "unknown tool 'crew_signal_done'", isError: true });
    expect(signalDeps.call).not.toHaveBeenCalled();
  });

  it("never exposes approve, answer, force-close, merge or config/profile edits", () => {
    const names = createCaptainTools().map((t) => t.name);
    for (const banned of ["crew_approve", "approve", "crew_answer", "answer", "crew_close_force", "merge", "config", "profile", "crew_takeover", "crew_handback", "crew_purge"]) {
      expect(names).not.toContain(banned);
    }
    for (const t of createCaptainTools()) expect(Object.keys(t.fields)).not.toContain("force");
  });
});

describe("tools call the shared function", () => {
  it("crew_spawn builds the spawn input from the flags and runs it", async () => {
    const d = fakes({ runCrewSpawn: vi.fn().mockResolvedValue({ title: "crew-1", surfaceId: "s1" }), buildCrewSpawnInput: vi.fn().mockResolvedValue({ built: true }) });
    const r = await call("crew_spawn", { project: "p", task: "do it", name: "a", agent: "codex", shared: true }, d);
    expect(d.buildCrewSpawnInput).toHaveBeenCalledWith("p", "do it", { name: "a", agent: "codex", model: undefined, thinking: undefined, backend: undefined, shared: true, approval: false }, true);
    expect(d.runCrewSpawn).toHaveBeenCalledWith({ built: true });
    expect(r).toEqual({ text: "✔ Crew 'crew-1' spawned (s1)", isError: false });
  });

  it("crew_spawn without an agent leaves agentExplicit false", async () => {
    const d = fakes({ runCrewSpawn: vi.fn().mockResolvedValue({ title: "t", surfaceId: "s" }) });
    await call("crew_spawn", { task: "x" }, d);
    expect(d.buildCrewSpawnInput.mock.calls[0][0]).toBe("own");
    expect(d.buildCrewSpawnInput.mock.calls[0][3]).toBe(false);
  });

  it("crew_send sends without force and reports hint and reopen", async () => {
    const d = fakes({ crewSendHint: vi.fn().mockResolvedValue("ctx high"), runCrewSend: vi.fn().mockResolvedValue({ reopened: true }) });
    const r = await call("crew_send", { project: "p", name: "crew-1", message: "hi" }, d);
    expect(d.runCrewSend).toHaveBeenCalledWith("p", "crew-1", "hi");
    expect(r.text).toBe("⚠ ctx high\n↻ Task was terminal — reopened to working\n✔ Sent to p:crew-1");
  });

  it("crew_send is an error when the task state could not be updated (#1069)", async () => {
    const d = fakes({ runCrewSend: vi.fn().mockResolvedValue({ reopened: false, stateWarning: "task state not updated (daemon down)" }) });
    const r = await call("crew_send", { project: "p", name: "crew-1", message: "hi" }, d);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("task state not updated");
  });

  it("crew_list renders lines or the empty message", async () => {
    const d = fakes({ crewListLines: vi.fn().mockResolvedValueOnce(["active (1):", "  crew-1 working"]).mockResolvedValueOnce([]) });
    expect((await call("crew_list", {}, d)).text).toBe("active (1):\n  crew-1 working");
    expect(d.crewListLines).toHaveBeenCalledWith("own");
    expect((await call("crew_list", { project: "q" }, d)).text).toBe("No live crew sessions for q.");
  });

  it("crew_tasks passes its filters", async () => {
    const d = fakes({ renderCrewTasks: vi.fn().mockResolvedValue("tasks") });
    expect((await call("crew_tasks", { project: "p", id: "ab", state: "working" }, d)).text).toBe("tasks");
    expect(d.renderCrewTasks).toHaveBeenCalledWith("p", { id: "ab", state: "working", json: false });
  });

  it("crew_read tails to the requested lines", async () => {
    const d = fakes({ runCrewRead: vi.fn().mockResolvedValue("a\nb\nc\nd") });
    expect((await call("crew_read", { project: "p", name: "crew-1", lines: 2 }, d)).text).toBe("c\nd");
    expect(d.runCrewRead).toHaveBeenCalledWith("p", "crew-1");
    expect((await call("crew_read", { project: "p", name: "crew-1", full: true }, d)).text).toBe("a\nb\nc\nd");
  });

  it("crew_msg reads the mailbox seq", async () => {
    const d = fakes({ readCrewMsg: vi.fn().mockResolvedValue({ agentNote: "# note", text: "body" }) });
    expect((await call("crew_msg", { project: "p", seq: 7 }, d)).text).toBe("# note\nbody");
    expect(d.readCrewMsg).toHaveBeenCalledWith("p", 7);
  });

  it("crew_compact queues the compact", async () => {
    const d = fakes({ requestCrewCompact: vi.fn().mockResolvedValue({ agent: "claude" }) });
    const r = await call("crew_compact", { project: "p", name: "crew-1", keep: "the plan" }, d);
    expect(d.requestCrewCompact.mock.calls[0].slice(0, 3)).toEqual(["p", "crew-1", "the plan"]);
    expect(r.text).toContain("Compact queued for p:crew-1 (claude)");
  });

  it("crew_close closes without force", async () => {
    const d = fakes();
    expect((await call("crew_close", { project: "p", name: "crew-1" }, d)).text).toBe("✔ Closed p:crew-1");
    expect(d.runCrewClose).toHaveBeenCalledWith("p", "crew-1");
  });

  it("thread_open / resume / park / list", async () => {
    const thread = { id: "th-1", mode: "fork", agent: "claude" };
    const d = fakes({
      runThreadOpen: vi.fn().mockResolvedValue({ thread, note: "n" }),
      runThreadResume: vi.fn().mockResolvedValue({ thread }),
      runThreadPark: vi.fn().mockResolvedValue("✔ parked"),
      threadListLines: vi.fn().mockReturnValue([]),
    });
    const open = await call("thread_open", { project: "p", topic: "t", crews: ["crew-1", 5] }, d);
    expect(d.runThreadOpen).toHaveBeenCalledWith("p", "t", ["crew-1"]);
    expect(open.text).toContain("Thread 'th-1' open");
    expect(open.text).toContain("note: n");
    await call("thread_resume", { project: "p", id: "th-1" }, d);
    expect(d.runThreadResume).toHaveBeenCalledWith("p", "th-1");
    await call("thread_park", { project: "p", id: "th-1", decision: "{}" }, d);
    expect(d.runThreadPark).toHaveBeenCalledWith("p", "th-1", "{}");
    await call("thread_park", { project: "p", id: "th-1" }, d);
    expect(d.runThreadPark).toHaveBeenLastCalledWith("p", "th-1", undefined);
    expect((await call("thread_list", { project: "p", all: true }, d)).text).toBe("No threads for p.");
    expect(d.threadListLines).toHaveBeenCalledWith("p", true);
  });

  it("side_spawn and side_send", async () => {
    const d = fakes({ runSideSpawn: vi.fn().mockResolvedValue({ title: "side-1", surfaceId: "s2" }) });
    expect((await call("side_spawn", { project: "p", topic: "t", role: "research" }, d)).text).toBe("✔ Side session 'side-1' spawned (s2)");
    expect(d.runSideSpawn).toHaveBeenCalledWith({ project: "p", topic: "t", role: "research", name: undefined, direction: "tab", agent: "claude" });
    expect((await call("side_send", { project: "p", name: "side-1", message: "m" }, d)).text).toBe("✔ Sent to p:side-1 (pasted into its pane; receipt not confirmed)");
    expect(d.runSideSend).toHaveBeenCalledWith("p", "side-1", "m");
  });

  it("ping targets the given project, never the default", async () => {
    const d = fakes({ runPing: vi.fn().mockResolvedValue(undefined) });
    expect((await call("ping", { project: "other", message: "hi" }, d)).text).toBe("✔ Queued for 'other' (mailbox — not yet delivered)");
    expect(d.runPing).toHaveBeenCalledWith("other", "hi");
    const r = await call("ping", { message: "hi" }, d);
    expect(r.isError).toBe(true);
    expect(d.runPing).toHaveBeenCalledTimes(1);
  });

  it("dispatch applies the CLI defaults", async () => {
    const d = fakes({ runDispatch: vi.fn().mockResolvedValue({ id: "abcdef123456", originProject: "own" }) });
    const r = await call("dispatch", { project: "other", task: "t" }, d);
    expect(d.runDispatch).toHaveBeenCalledWith("other", "t", { provider: "claude", mode: "headless" });
    expect(r.text).toContain("Dispatched to 'other' (task abcdef12)");
    expect(r.text).toContain("originProject: own");
  });

  it("captain_compact queues a compact", async () => {
    const d = fakes();
    expect((await call("captain_compact", { focus: "f" }, d)).text).toContain("Compact queued for 'own'");
    expect(d.runCaptainCompact).toHaveBeenCalledWith("own", "f");
  });

  it("status lists project rows and needs no project", async () => {
    const d = fakes({ statusRows: vi.fn().mockResolvedValue(["  a  captain ●"]), currentProject: () => null });
    expect((await call("status", {}, d)).text).toBe("  a  captain ●");
  });

  it("rules_search runs the brief search for the project", async () => {
    const hits = [{ score: 3, rule: { modality: "must", id: "r.1", statement: "do x" } }];
    const d = fakes({ runRulesSearch: vi.fn().mockReturnValue(hits) });
    const r = await call("rules_search", { project: "p", query: "x y", limit: 3 }, d);
    expect(d.runRulesSearch).toHaveBeenCalledWith("x y", { project: "p", brief: true, limit: 3 });
    expect(r.text).toBe("[3] MUST r.1: do x");
  });

  it("check_inbox summarises undelivered entries", async () => {
    const d = fakes({ readUndelivered: vi.fn().mockResolvedValue([{ seq: 4, kind: "task.done", name: "crew-1", message: "\nCREW DONE\nmore" }]) });
    const r = await call("check_inbox", {}, d);
    expect(r.text).toBe("1 undelivered for own:\nseq 4 · task.done · crew-1 — CREW DONE\nRead one in full with crew_msg <seq>.");
    d.readUndelivered.mockResolvedValue([]);
    expect((await call("check_inbox", {}, d)).text).toBe("Inbox empty for own.");
  });
});

describe("results and errors", () => {
  it("strips ANSI colour codes", async () => {
    const d = fakes({ crewListLines: vi.fn().mockResolvedValue(["\u001b[32mgreen\u001b[39m"]) });
    expect((await call("crew_list", {}, d)).text).toBe("green");
  });

  it("an unresolvable project is an error, not a guess", async () => {
    const d = fakes({ currentProject: () => null });
    const r = await call("crew_list", {}, d);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("pass 'project'");
  });

  it("a missing required argument and a thrown error come back as isError", async () => {
    const d = fakes({ runCrewClose: vi.fn().mockRejectedValue(new Error("boom")) });
    expect((await call("crew_close", {}, d)).isError).toBe(true);
    expect(await call("crew_close", { name: "c" }, d)).toEqual({ text: "boom", isError: true });
  });
});
