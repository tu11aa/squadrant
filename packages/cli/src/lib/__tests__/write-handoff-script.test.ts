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

  it("falls back to the newest readable archive when handoff.json is absent", () => {
    const dir = path.join(ws, "proj", "handoffs");
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, "2026-01-01.json");
    const newer = path.join(dir, "2026-01-02.json");
    const corrupt = path.join(dir, "2026-01-03.json");
    fs.writeFileSync(old, JSON.stringify({ session: { decisions: ["[thread old] x"] } }));
    fs.writeFileSync(newer, JSON.stringify({ session: { decisions: ["[thread t9] from archive"] } }));
    fs.writeFileSync(corrupt, "{not json");
    fs.utimesSync(old, 1000, 1000);
    fs.utimesSync(newer, 2000, 2000);
    fs.utimesSync(corrupt, 3000, 3000);

    const r = run({ decisions: ["plain"] });

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("[thread t9] from archive");
    expect(r.stderr).not.toContain("[thread old]");
  });
});
