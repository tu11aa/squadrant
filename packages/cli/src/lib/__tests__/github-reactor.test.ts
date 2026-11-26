import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig } from "@squadrant/shared";
import { diffProject, runGithubReactorTick, readProjectState, type GhApi, type PrSnapshot } from "../github-reactor.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-reactor-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({ number: 7, title: "t", url: "u7", mergeable: "MERGEABLE", comments: {}, ...over });
const cm = (author: string, body = "hi") => ({ author, kind: "comment" as const, body, url: "c" });

function setup(enabled: boolean) {
  const config = getDefaultConfig();
  config.projects = { p1: { path: "/x", captainName: "cap1", spokeVault: "", host: "" } };
  if (enabled) config.githubReactor = { enabled: true };
  const sent: string[] = [];
  let open: PrSnapshot[] = [];
  let fin: Awaited<ReturnType<GhApi["final"]>>;
  const api: GhApi = { viewer: async () => "me", listOpen: async () => open, final: async () => fin };
  const run = () => runGithubReactorTick({ stateRoot: dir, config, api, isOpen: async () => true, appendCaptainMessage: async (_p, t) => { sent.push(t); } });
  return { sent, run, setOpen: (o: PrSnapshot[]) => { open = o; }, setFinal: (f: typeof fin) => { fin = f; } };
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
  it("reports merged and drops the PR; keeps tracking when state is unknown", () => {
    const r = diffProject(prev, [], { "7": { state: "MERGED", by: "tu", base: "develop" } });
    expect(r.lines[0]).toMatch(/MERGED into develop by tu/);
    expect(r.next.prs["7"]).toBeUndefined();
    expect(diffProject(prev, [], {}).next.prs["7"]).toBeDefined();
  });
});

describe("runGithubReactorTick", () => {
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
    const config = getDefaultConfig(); config.projects = { p1: { path: "/x", captainName: "c", spokeVault: "", host: "" } }; config.githubReactor = { enabled: true };
    await runGithubReactorTick({ stateRoot: dir, config, api: { viewer: async () => "me", listOpen: async () => [pr({ comments: { z: cm("bob") } })], final: async () => undefined }, isOpen: async () => true, appendCaptainMessage: async () => { throw new Error("down"); } });
    expect(readProjectState(dir, "p1")!.prs["7"].seenComments).toEqual([]);
    await t.run();
    expect(t.sent).toHaveLength(1);
  });
});
