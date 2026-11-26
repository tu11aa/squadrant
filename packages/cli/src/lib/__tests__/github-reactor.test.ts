import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig } from "@squadrant/shared";
import { diffProject, runGithubReactorTick, readProjectState, type GhApi, type PrSnapshot } from "../github-reactor.js";

let dir: string;
beforeEach(() => { logs.length = 0; dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-reactor-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({ number: 7, title: "t", url: "u7", mergeable: "MERGEABLE", comments: {}, ...over });
const cm = (author: string, body = "hi") => ({ author, kind: "comment" as const, body, url: "c" });

const logs: string[] = [];
function setup(enabled: boolean) {
  const config = getDefaultConfig();
  config.projects = { p1: { path: dir, captainName: "cap1", spokeVault: "", host: "" } };
  if (enabled) config.githubReactor = { enabled: true };
  const sent: string[] = [];
  let open: PrSnapshot[] = [];
  let fin: Awaited<ReturnType<GhApi["final"]>>;
  const api: GhApi = { viewer: async () => "me", listOpen: async () => open, final: async () => fin };
  let delivered = true;
  const run = () => runGithubReactorTick({ stateRoot: dir, config, api, isOpen: async () => true, appendCaptainMessage: async (_p, t) => { sent.push(t); return sent.length; }, isDelivered: async (_p, seq) => delivered && seq <= sent.length, log: (m) => logs.push(m) });
  return { sent, logs, run, setDelivered: (d: boolean) => { delivered = d; }, setOpen: (o: PrSnapshot[]) => { open = o; }, setFinal: (f: typeof fin) => { fin = f; } };
}

describe("diffProject", () => {
  const prev = { initializedAt: "x", prs: { "7": { title: "t", url: "u7", mergeable: "MERGEABLE", seenComments: ["a"] } } };
  it("reports only comments not in the baseline, skipping my own", () => {
    const { lines, next } = diffProject(prev, [pr({ comments: { a: cm("bob"), b: cm("bob", "fix this"), c: cm("me") } })], {}, "me");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/#7.*@bob.*fix this/);
    expect(next.prs["7"].seenComments.sort()).toEqual(["a", "b", "c"]);
  });
  it("reports a conflict once, ignores UNKNOWN", () => {
    expect(diffProject(prev, [pr({ mergeable: "UNKNOWN" })], {}).lines).toHaveLength(0);
    const r = diffProject(prev, [pr({ mergeable: "CONFLICTING" })], {});
    expect(r.lines[0]).toMatch(/CONFLICTS/);
    expect(diffProject(r.next, [pr({ mergeable: "CONFLICTING" })], {}).lines).toHaveLength(0);
  });
  it("reports a conflict only on a known MERGEABLE -> CONFLICTING transition", () => {
    const unknown = { initializedAt: "x", prs: { "7": { title: "t", url: "u7", mergeable: "UNKNOWN", seenComments: [] as string[] } } };
    const a = diffProject(unknown, [pr({ mergeable: "CONFLICTING" })], {});
    expect(a.lines).toHaveLength(0);                       // baseline/adopted UNKNOWN, first known value is silent
    expect(a.next.prs["7"].mergeable).toBe("CONFLICTING");
    expect(diffProject(prev, [pr({ mergeable: "CONFLICTING" })], {}).lines).toHaveLength(1);
    const adopted = diffProject({ initializedAt: "x", prs: {} }, [pr({ mergeable: "UNKNOWN" })], {});
    expect(adopted.next.prs["7"].mergeable).toBe("UNKNOWN");
    expect(diffProject(adopted.next, [pr({ mergeable: "CONFLICTING" })], {}).lines).toHaveLength(0);
  });
  it("reports merged and drops the PR; keeps tracking when state is unknown", () => {
    const r = diffProject(prev, [], { "7": { state: "MERGED", by: "tu", base: "develop" } });
    expect(r.lines[0]).toMatch(/MERGED into develop by tu/);
    expect(r.next.prs["7"]).toBeUndefined();
    expect(diffProject(prev, [], {}).next.prs["7"]).toBeDefined();
  });
});

describe("diffProject review lines", () => {
  const prev = { initializedAt: "x", prs: { "7": { title: "t", url: "u7", mergeable: "MERGEABLE", seenComments: [] as string[] } } };
  const review = (state: string, body = "") => ({ author: "bob", kind: "review" as const, body, url: "r", state });
  const inline = { author: "bob", kind: "inline" as const, body: "rename this", url: "i" };
  it("drops the empty COMMENTED review when the PR has inline comments", () => {
    const r = diffProject(prev, [pr({ comments: { r1: review("COMMENTED"), "inline:1": inline } })], {});
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/inline review comment/);
    expect(r.next.prs["7"].seenComments.sort()).toEqual(["inline:1", "r1"]);
  });
  it("keeps APPROVED, CHANGES_REQUESTED, bodied reviews, and a bare COMMENTED review without inline comments", () => {
    const r = diffProject(prev, [pr({ comments: { a: review("APPROVED"), b: review("CHANGES_REQUESTED"), c: review("COMMENTED", "see notes"), "inline:1": inline } })], {});
    expect(r.lines).toHaveLength(4);
    expect(diffProject(prev, [pr({ comments: { d: review("COMMENTED") } })], {}).lines).toHaveLength(1);
  });
});

describe("runGithubReactorTick", () => {
  it("logs a missing project path instead of spawning gh", async () => {
    const t = setup(true);
    fs.rmSync(dir, { recursive: true, force: true });
    await t.run();
    expect(t.logs.join("\n")).toMatch(/project path not found: /);
    expect(t.logs.join("\n")).not.toMatch(/ENOENT/);
  });
  it("sends nothing and keeps state while the previous message is undelivered, then one combined message", async () => {
    const t = setup(true);
    t.setOpen([pr()]); await t.run();                                   // baseline
    t.setOpen([pr({ comments: { a: cm("bob", "first") } })]); await t.run();
    expect(t.sent).toHaveLength(1);
    expect(readProjectState(dir, "p1")!.pendingSeq).toBe(1);
    t.setDelivered(false);
    t.setOpen([pr({ comments: { a: cm("bob", "first"), b: cm("amy", "second") } })]); await t.run();
    t.setOpen([pr({ comments: { a: cm("bob", "first"), b: cm("amy", "second"), c: cm("amy", "third") } })]); await t.run();
    expect(t.sent).toHaveLength(1);                                     // nothing new enqueued
    expect(readProjectState(dir, "p1")!.prs["7"].seenComments).toEqual(["a"]); // state not advanced
    t.setDelivered(true); await t.run();
    expect(t.sent).toHaveLength(2);                                     // ONE message with everything since
    expect(t.sent[1]).toMatch(/second/);
    expect(t.sent[1]).toMatch(/third/);
    expect(t.sent[1]).not.toMatch(/first/);
    expect(readProjectState(dir, "p1")!.pendingSeq).toBe(2);
  });
  it("clears the pending marker once delivered and nothing changed", async () => {
    const t = setup(true);
    t.setOpen([pr()]); await t.run();
    t.setOpen([pr({ comments: { a: cm("bob") } })]); await t.run();
    await t.run();
    expect(readProjectState(dir, "p1")!.pendingSeq).toBeUndefined();
  });
  it("does nothing when disabled (default)", async () => {
    const { run, sent } = setup(false);
    await run();
    expect(sent).toHaveLength(0);
    expect(readProjectState(dir, "p1")).toBeUndefined();
  });
  it("first tick records a baseline silently, later ticks report changes", async () => {
    const t = setup(true);
    t.setOpen([pr({ mergeable: "CONFLICTING", comments: { a: cm("bob") } })]);
    await t.run();
    expect(t.sent).toHaveLength(0);                       // pre-existing conflict + comment: baseline only
    expect(readProjectState(dir, "p1")!.prs["7"].seenComments).toEqual(["a"]);
    t.setOpen([pr({ mergeable: "CONFLICTING", comments: { a: cm("bob"), b: cm("amy", "new one") } })]);
    await t.run();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatch(/new one/);
    await t.run();
    expect(t.sent).toHaveLength(1);                       // no repeat
    t.setOpen([]); t.setFinal({ state: "MERGED", by: "tu" });
    await t.run();
    expect(t.sent[1]).toMatch(/MERGED/);
  });
  it("does not advance state when the captain message fails", async () => {
    const t = setup(true);
    t.setOpen([pr()]); await t.run();
    t.setOpen([pr({ comments: { z: cm("bob") } })]);
    const config = getDefaultConfig(); config.projects = { p1: { path: dir, captainName: "c", spokeVault: "", host: "" } }; config.githubReactor = { enabled: true };
    await runGithubReactorTick({ stateRoot: dir, config, api: { viewer: async () => "me", listOpen: async () => [pr({ comments: { z: cm("bob") } })], final: async () => undefined }, isOpen: async () => true, isDelivered: async () => true, appendCaptainMessage: async () => { throw new Error("down"); } });
    expect(readProjectState(dir, "p1")!.prs["7"].seenComments).toEqual([]);
    await t.run();
    expect(t.sent).toHaveLength(1);
  });
});
