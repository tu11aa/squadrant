import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scripts/write-handoff.sh");

describe("write-handoff.sh thread-decision safety net", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-wh-"));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  const run = (content: object) =>
    spawnSync("bash", [SCRIPT, "proj", JSON.stringify(content)], { env: { ...process.env, SQUADRANT_WORKSPACE_DIR: ws }, encoding: "utf-8" });
  const handoff = () => JSON.parse(fs.readFileSync(path.join(ws, "proj", "handoff.json"), "utf-8"));

  it("warns on stderr about a dropped [thread] decision but still writes", () => {
    run({ decisions: ['[thread t1] keep "this" one', "plain"] });
    const r = run({ decisions: ["plain"] });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[thread t1] keep "this" one');
    expect(handoff().session.decisions).toEqual(["plain"]);
  });

  it("is silent when every [thread] decision is carried over", () => {
    run({ decisions: ["[thread t1] a"] });
    const r = run({ decisions: ["x", "[thread t1] a"] });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("is silent on the first write", () => {
    expect(run({ decisions: ["[thread t1] a"] }).stderr).toBe("");
  });
});
