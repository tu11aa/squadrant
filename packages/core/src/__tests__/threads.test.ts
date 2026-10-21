import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaneRef, RuntimeDriver } from "@squadrant/shared";
import {
  openThread, requestPark, parkThread, resumeThread, closeThread,
  listThreads, readThread, writeThread, threadIdFor, planResume, assertThreadCap,
  parseDecisionRecord, formatDecisionMessage, decisionHandoffLine, appendHandoffDecision,
  THREAD_RESUME_WINDOW_MS,
  type ThreadDeps, type ThreadLaunch, type ThreadRecord, type DecisionRecord,
} from "../threads.js";

let root: string;
let ws: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "threads-state-"));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "threads-ws-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

function fakeRuntime() {
  const sent: Array<{ pane: PaneRef; text: string }> = [];
  const closed: string[] = [];
  let n = 0;
  const runtime = {
    newPane: async (o: { workspaceId: string; title?: string }) => ({ workspaceId: o.workspaceId, surfaceId: `surface:${++n}`, title: o.title }),
    readPaneScreen: async () => "",
    sendToPane: async (pane: PaneRef, text: string) => { sent.push({ pane, text }); },
    closePane: async (pane: PaneRef) => { closed.push(pane.surfaceId); },
  } as unknown as RuntimeDriver;
  return { runtime, sent, closed };
}

function makeDeps(over: Partial<ThreadDeps> = {}) {
  const rt = fakeRuntime();
  const launches: ThreadLaunch[] = [];
  const firstTurns: string[] = [];
  let clock = Date.parse("2026-10-21T10:00:00Z");
  let sid = 0;
  const deps: ThreadDeps = {
    stateRoot: root,
    runtime: rt.runtime,
    workspaceId: "workspace:1",
    cwd: "/repo/app",
    agent: "claude",
    captainSessionId: "cap-1",
    maxThreads: 3,
    agentCommand: (l) => { launches.push(l); return "claude"; },
    // Long first turns are spilled to a temp file (#730); record what the agent would read.
    sendFirstTurn: async (_p, text) => {
      const spill = text.match(/^Full task is at (\S+) /)?.[1];
      firstTurns.push(spill ? fs.readFileSync(spill, "utf-8") : text);
      return { delivered: true };
    },
    ledger: async () => "- crew-a: working on app-core auth",
    newSessionId: () => `thr-${++sid}`,
    now: () => new Date(clock),
    ...over,
  };
  return { deps, rt, launches, firstTurns, advance: (ms: number) => { clock += ms; } };
}

const decision = (at: string, extra: Partial<DecisionRecord> = {}): DecisionRecord => ({
  question: "Cache auth tokens?",
  decision: "Yes, 10 min TTL",
  reasons: ["cuts p95"],
  rejected: ["no cache — too slow"],
  actions: [{ crew: "crew-a", action: "add TTL cache" }],
  at,
  ...extra,
});

function inbox(project: string): Array<{ kind: string; message: string }> {
  const f = path.join(root, "inbox", `${project}.log`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("thread registry I/O", () => {
  it("writes <stateRoot>/<project>/threads/<id>.json and reads it back", () => {
    const rec: ThreadRecord = {
      id: "auth-cache", project: "app", topic: "Auth cache", crews: [], state: "open", agent: "claude",
      mode: "fork", forkedAt: "2026-10-21T10:00:00Z", lastActiveAt: "2026-10-21T10:00:00Z", decisions: [],
    };
    writeThread(root, rec);
    expect(fs.existsSync(path.join(root, "app", "threads", "auth-cache.json"))).toBe(true);
    expect(readThread(root, "app", "auth-cache")).toEqual(rec);
    expect(listThreads(root, "app").map((t) => t.id)).toEqual(["auth-cache"]);
    expect(listThreads(root, "other")).toEqual([]);
  });

  it("rejects unsafe ids and projects", () => {
    expect(() => readThread(root, "app", "../x")).toThrow(/invalid thread id/);
    expect(() => listThreads(root, "..")).toThrow(/invalid project/);
  });

  it("slugs topics into unique ids", () => {
    expect(threadIdFor("Auth: cache tokens?", [])).toBe("auth-cache-tokens");
    expect(threadIdFor("Auth: cache tokens?", ["auth-cache-tokens"])).toBe("auth-cache-tokens-2");
    expect(threadIdFor("!!!", [])).toBe("thread");
  });
});

describe("resume rule", () => {
  const base = { mode: "fork", sessionId: "s", lastActiveAt: "2026-10-21T10:00:00Z" } as ThreadRecord;
  const t0 = Date.parse(base.lastActiveAt);
  it("same session within the window, fresh after it", () => {
    expect(planResume(base, t0 + 30 * 60_000)).toBe("same");
    expect(planResume(base, t0 + THREAD_RESUME_WINDOW_MS)).toBe("same");
    expect(planResume(base, t0 + THREAD_RESUME_WINDOW_MS + 1)).toBe("fresh");
  });
  it("seeded threads (no fork) always start fresh", () => {
    expect(planResume({ ...base, mode: "seed" }, t0 + 1000)).toBe("fresh");
  });
});

describe("decision record", () => {
  it("parses and defaults optional lists", () => {
    const d = parseDecisionRecord('{"question":"Q?","decision":"D"}', "t");
    expect(d).toEqual({ question: "Q?", decision: "D", reasons: [], rejected: [], actions: [], at: "t" });
  });
  it("rejects missing fields and bad shapes", () => {
    expect(() => parseDecisionRecord("nope", "t")).toThrow(/valid JSON/);
    expect(() => parseDecisionRecord('{"question":"Q"}', "t")).toThrow(/'decision' is required/);
    expect(() => parseDecisionRecord('{"question":"Q","decision":"D","actions":[{"crew":1}]}', "t")).toThrow(/actions/);
    expect(() => parseDecisionRecord('{"question":"Q","decision":"D","reasons":"x"}', "t")).toThrow(/reasons/);
  });
  it("formats the short captain message and a one-line handoff summary", () => {
    const rec = { id: "auth-cache", project: "app", topic: "Auth cache" } as ThreadRecord;
    const msg = formatDecisionMessage(rec, decision("t"));
    expect(msg).toContain("💬 Thread decision — Auth cache (thread auth-cache)");
    expect(msg).toContain("Actions: crew-a → add TTL cache");
    expect(msg).toContain("squadrant thread show app auth-cache");
    expect(decisionHandoffLine(rec, decision("t"))).toBe("[thread auth-cache] Auth cache: Yes, 10 min TTL");
  });
});

describe("appendHandoffDecision", () => {
  const now = new Date("2026-10-21T11:00:00Z");
  it("appends to the live handoff's session.decisions, keeping other fields", () => {
    fs.writeFileSync(path.join(ws, "handoff.json"), JSON.stringify({ written_at: "x", session: { nextSteps: ["a"], decisions: ["old"] } }));
    appendHandoffDecision(ws, "new", now);
    const h = JSON.parse(fs.readFileSync(path.join(ws, "handoff.json"), "utf-8"));
    expect(h.session).toEqual({ nextSteps: ["a"], decisions: ["old", "new"] });
  });
  it("seeds from the newest archived handoff when no live one exists", () => {
    fs.mkdirSync(path.join(ws, "handoffs"));
    fs.writeFileSync(path.join(ws, "handoffs", "2026-10-20.json"), JSON.stringify({ written_at: "y", session: { currentState: "s" } }));
    appendHandoffDecision(ws, "new", now);
    const h = JSON.parse(fs.readFileSync(path.join(ws, "handoff.json"), "utf-8"));
    expect(h.session).toEqual({ currentState: "s", decisions: ["new"] });
  });
  it("refuses to overwrite a corrupt live handoff", () => {
    fs.writeFileSync(path.join(ws, "handoff.json"), "{broken");
    expect(() => appendHandoffDecision(ws, "new", now)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(path.join(ws, "handoff.json"), "utf-8")).toBe("{broken");
  });
  it("creates a minimal handoff when nothing exists", () => {
    appendHandoffDecision(ws, "new", now);
    expect(JSON.parse(fs.readFileSync(path.join(ws, "handoff.json"), "utf-8")).session).toEqual({ decisions: ["new"] });
  });
});

describe("open/park/resume/close state machine", () => {
  it("open forks the captain session into a titled tab with the thread prompt", async () => {
    const { deps, launches, firstTurns, rt } = makeDeps();
    const { thread, note } = await openThread({ project: "app", topic: "Auth cache", crews: ["crew-a"] }, deps);
    expect(note).toBeUndefined();
    expect(launches).toEqual([{ kind: "fork", fromSessionId: "cap-1", sessionId: "thr-1" }]);
    expect(thread).toMatchObject({ id: "auth-cache", state: "open", mode: "fork", sessionId: "thr-1", surfaceId: "surface:1", crews: ["crew-a"] });
    expect(rt.sent[0].text).toContain("SQUADRANT_ROLE=thread SQUADRANT_THREAD_ID=auth-cache");
    expect(rt.sent[0].text).toMatch(/^cd '\/repo\/app' && /);
    expect(firstTurns[0]).toContain("You are a discussion thread for: Auth cache");
    expect(firstTurns[0]).toContain("Do not spawn crews");
    expect(firstTurns[0]).toContain("squadrant thread park app auth-cache --decision-file -");
    expect(readThread(root, "app", "auth-cache")?.state).toBe("open");
  });

  it("enforces the open-thread cap; parked threads do not count", async () => {
    const { deps } = makeDeps({ maxThreads: 1 });
    await openThread({ project: "app", topic: "one", crews: [] }, deps);
    await expect(openThread({ project: "app", topic: "two", crews: [] }, deps)).rejects.toThrow(/Thread cap reached: 1\/1/);
    await parkThread("app", "one", decision("2026-10-21T10:05:00Z"), { ...deps, workspaceDir: ws });
    await expect(openThread({ project: "app", topic: "two", crews: [] }, deps)).resolves.toBeTruthy();
    expect(() => assertThreadCap([], 0)).toThrow(/cap/);
  });

  it("park without a record asks the thread to write it; state unchanged", async () => {
    const { deps, rt } = makeDeps();
    await openThread({ project: "app", topic: "Auth cache", crews: [] }, deps);
    await requestPark("app", "auth-cache", deps);
    expect(rt.sent.at(-1)!.pane.surfaceId).toBe("surface:1");
    expect(rt.sent.at(-1)!.text).toContain("squadrant thread park app auth-cache --decision-file -");
    expect(readThread(root, "app", "auth-cache")?.state).toBe("open");
  });

  it("park delivers exactly one captain.message, one handoff line, closes the tab, keeps the session id", async () => {
    const { deps, rt } = makeDeps();
    await openThread({ project: "app", topic: "Auth cache", crews: [] }, deps);
    const { thread } = await parkThread("app", "auth-cache", decision("2026-10-21T10:05:00Z"), { ...deps, workspaceDir: ws });
    const entries = inbox("app");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("captain.message");
    expect(entries[0].message).toContain("Decision: Yes, 10 min TTL");
    const h = JSON.parse(fs.readFileSync(path.join(ws, "handoff.json"), "utf-8"));
    expect(h.session.decisions).toEqual(["[thread auth-cache] Auth cache: Yes, 10 min TTL"]);
    expect(rt.closed).toEqual(["surface:1"]);
    expect(thread).toMatchObject({ state: "parked", sessionId: "thr-1" });
    expect(thread.surfaceId).toBeUndefined();
    await expect(parkThread("app", "auth-cache", decision("t"), { ...deps, workspaceDir: ws })).rejects.toThrow(/parked; cannot move to parked/);
  });

  it("a failed handoff write leaves the thread open, with no captain message, so park can be retried", async () => {
    const { deps } = makeDeps();
    await openThread({ project: "app", topic: "Auth cache", crews: [] }, deps);
    fs.writeFileSync(path.join(ws, "handoff.json"), "{broken");
    await expect(parkThread("app", "auth-cache", decision("t"), { ...deps, workspaceDir: ws })).rejects.toThrow(/not valid JSON/);
    expect(readThread(root, "app", "auth-cache")?.state).toBe("open");
    expect(inbox("app")).toHaveLength(0);
  });

  it("resume within the window: same session + delta (ledger + newer decisions from other threads)", async () => {
    const { deps, launches, firstTurns, advance } = makeDeps();
    await openThread({ project: "app", topic: "Auth cache", crews: [] }, deps);
    await parkThread("app", "auth-cache", decision("2026-10-21T10:00:00.000Z"), { ...deps, workspaceDir: ws });
    advance(5 * 60_000);
    await openThread({ project: "app", topic: "Deploy order", crews: [] }, deps);
    await parkThread("app", "deploy-order", decision("2026-10-21T10:06:00.000Z", { decision: "app-core first" }), { ...deps, workspaceDir: ws });
    advance(10 * 60_000);
    const { thread, note } = await resumeThread("app", "auth-cache", deps);
    expect(launches.at(-1)).toEqual({ kind: "resume", sessionId: "thr-1" });
    expect(note).toMatch(/same session/);
    const turn = firstTurns.at(-1)!;
    expect(turn).toContain("Thread auth-cache resumed");
    expect(turn).toContain("crew-a: working on app-core auth");
    expect(turn).toContain("Decision: app-core first");
    expect(turn).not.toContain("You are a discussion thread");
    expect(thread).toMatchObject({ state: "open", sessionId: "thr-1", surfaceId: "surface:3" });
  });

  it("resume after the window: fresh fork from the current captain with this topic's prior decisions", async () => {
    const { deps, launches, firstTurns, advance } = makeDeps();
    await openThread({ project: "app", topic: "Auth cache", crews: [] }, deps);
    await parkThread("app", "auth-cache", decision("2026-10-21T10:00:00.000Z"), { ...deps, workspaceDir: ws });
    advance(THREAD_RESUME_WINDOW_MS + 60_000);
    const { thread } = await resumeThread("app", "auth-cache", { ...deps, captainSessionId: "cap-2" });
    expect(launches.at(-1)).toEqual({ kind: "fork", fromSessionId: "cap-2", sessionId: "thr-2" });
    expect(thread.sessionId).toBe("thr-2");
    expect(firstTurns.at(-1)).toContain("You are a discussion thread for: Auth cache");
    expect(firstTurns.at(-1)).toContain("Earlier decisions on this topic");
    expect(firstTurns.at(-1)).toContain("Decision: Yes, 10 min TTL");
  });

  it("resume refuses an open thread and respects the cap", async () => {
    const { deps } = makeDeps({ maxThreads: 1 });
    await openThread({ project: "app", topic: "one", crews: [] }, deps);
    await expect(resumeThread("app", "one", deps)).rejects.toThrow(/open; cannot move to open/);
    await parkThread("app", "one", decision("t"), { ...deps, workspaceDir: ws });
    await openThread({ project: "app", topic: "two", crews: [] }, deps);
    await expect(resumeThread("app", "one", deps)).rejects.toThrow(/Thread cap reached/);
  });

  it("close marks closed, closes a live tab, and is terminal", async () => {
    const { deps, rt } = makeDeps();
    await openThread({ project: "app", topic: "Auth cache", crews: [] }, deps);
    const rec = await closeThread("app", "auth-cache", deps);
    expect(rec.state).toBe("closed");
    expect(rt.closed).toEqual(["surface:1"]);
    await expect(resumeThread("app", "auth-cache", deps)).rejects.toThrow(/closed; cannot move to open/);
  });
});

describe("non-fork fallback (codex/opencode)", () => {
  it("seeds a fresh session from the ledger + decision records, with a note instead of an error", async () => {
    const { deps, launches, firstTurns } = makeDeps({ agent: "opencode", captainSessionId: null });
    const { thread, note } = await openThread({ project: "app", topic: "Auth cache", crews: [] }, deps);
    expect(launches).toEqual([{ kind: "seed" }]);
    expect(thread).toMatchObject({ mode: "seed", agent: "opencode" });
    expect(thread.sessionId).toBeUndefined();
    expect(note).toMatch(/Agent 'opencode' cannot fork/);
    expect(firstTurns[0]).toContain("seeded from the captain's written state");
    expect(firstTurns[0]).toContain("crew-a: working on app-core auth");
  });

  it("a seeded thread re-seeds on resume with its prior decisions", async () => {
    const { deps, launches, firstTurns } = makeDeps({ agent: "codex", captainSessionId: null });
    await openThread({ project: "app", topic: "Auth cache", crews: [] }, deps);
    await parkThread("app", "auth-cache", decision("2026-10-21T10:00:00.000Z"), { ...deps, workspaceDir: ws });
    const { note } = await resumeThread("app", "auth-cache", deps);
    expect(launches.at(-1)).toEqual({ kind: "seed" });
    expect(note).toMatch(/cannot fork/);
    expect(firstTurns.at(-1)).toContain("Earlier decisions on this topic");
  });

  it("a claude captain with no known session also seeds, with its own note", async () => {
    const { deps } = makeDeps({ captainSessionId: null });
    const { note } = await openThread({ project: "app", topic: "x", crews: [] }, deps);
    expect(note).toMatch(/No captain claude session found/);
  });
});
