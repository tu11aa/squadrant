import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #983 6b: the handoff scripts keep their argv shape but write to
// workspace/<basename(arg)>/; the learnings/wiki scripts stay on the spoke
// until phase 4b and must cope with a project that has no spoke dir yet.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = (name: string) => path.resolve(__dirname, "../../../../../scripts", name);

describe("workspace-backed scripts (#983)", () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  const sh = (name: string, ...args: string[]) =>
    execFileSync("bash", [script(name), ...args], { encoding: "utf8", env, cwd: tmp });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-ws-scripts-"));
    env = { ...process.env, HOME: path.join(tmp, "home"), SQUADRANT_WORKSPACE_DIR: path.join(tmp, "ws") };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it.each([
    ["an old spoke path", () => path.join(tmp, "hub", "spokes", "p")],
    ["a workspace path", () => path.join(tmp, "ws", "p")],
    ["a bare project name", () => "p"],
  ])("write-handoff.sh given %s writes workspace/p/handoff.json", (_label, arg) => {
    sh("write-handoff.sh", arg(), '{"a": 1}');
    const written = JSON.parse(fs.readFileSync(path.join(tmp, "ws", "p", "handoff.json"), "utf8"));
    expect(written.session).toEqual({ a: 1 });
    expect(fs.existsSync(path.join(tmp, "hub"))).toBe(false);
  });

  it("write then read lands the archived copy in workspace/p/handoffs/", () => {
    const spoke = path.join(tmp, "hub", "spokes", "p");
    sh("write-handoff.sh", spoke, '{"a": 1}');
    sh("read-handoff.sh", spoke);
    const archived = fs.readdirSync(path.join(tmp, "ws", "p", "handoffs"));
    expect(archived).toHaveLength(1);
    expect(fs.existsSync(path.join(tmp, "ws", "p", "handoff.json"))).toBe(false);
  });

  it("record-side-handoff.sh writes workspace/p/side-handoffs/<slug>.md", () => {
    sh("record-side-handoff.sh", path.join(tmp, "hub", "spokes", "p"), "KB Paths", "research", "summary");
    expect(fs.readFileSync(path.join(tmp, "ws", "p", "side-handoffs", "kb-paths.md"), "utf8")).toContain("summary");
    expect(fs.existsSync(path.join(tmp, "hub"))).toBe(false);
  });

  it("record-learning.sh creates a missing spoke dir instead of crashing (spoke-bound until 4b)", () => {
    const spoke = path.join(tmp, "hub", "spokes", "new-project");
    sh("record-learning.sh", spoke, "pattern", "a learning", "x");
    expect(fs.readdirSync(path.join(spoke, "learnings"))).toHaveLength(1);
  });

  it("wiki-query.sh / wiki-log.sh are a graceful no-op on a missing spoke", () => {
    const spoke = path.join(tmp, "hub", "spokes", "new-project");
    expect(sh("wiki-query.sh", spoke, "kw")).toContain("No wiki found");
    expect(sh("wiki-log.sh", spoke)).toContain("No wiki log found");
  });
});
