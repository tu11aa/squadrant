import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { runCmuxAutoconfig } from "../cmux.js";
import type { AutoConfigResult } from "@squadrant/shared";

function sink() {
  let buf = "";
  const s = new Writable({
    write(c, _e, cb) {
      buf += c.toString();
      cb();
    },
  });
  return { s, text: () => buf };
}

function result(over: Partial<AutoConfigResult>): AutoConfigResult {
  return {
    configPath: "/tmp/cmux.json",
    configChanged: false,
    configAlreadySet: true,
    verdict: "reachable",
    needsRestart: false,
    promptedThisRun: false,
    ...over,
  };
}

describe("runCmuxAutoconfig", () => {
  it("reachable → exit 0 with a success line", async () => {
    const out = sink();
    const err = sink();
    const code = await runCmuxAutoconfig({
      json: false,
      stdout: out.s,
      stderr: err.s,
      run: async () => result({ verdict: "reachable" }),
    });
    expect(code).toBe(0);
    expect(out.text().toLowerCase()).toContain("reachable");
  });

  it("denied → exit 2 and tells the user to restart cmux", async () => {
    const out = sink();
    const err = sink();
    const code = await runCmuxAutoconfig({
      json: false,
      stdout: out.s,
      stderr: err.s,
      run: async () => result({ configChanged: true, configAlreadySet: false, verdict: "denied", needsRestart: true }),
    });
    expect(code).toBe(2);
    expect(out.text().toLowerCase()).toContain("restart cmux");
  });

  it("unknown → exit 1 (fail-soft, stay on relay)", async () => {
    const out = sink();
    const err = sink();
    const code = await runCmuxAutoconfig({
      json: false,
      stdout: out.s,
      stderr: err.s,
      run: async () => result({ verdict: "unknown" }),
    });
    expect(code).toBe(1);
    expect((out.text() + err.text()).toLowerCase()).toContain("relay");
  });

  it("--json emits the machine-readable result", async () => {
    const out = sink();
    const err = sink();
    const code = await runCmuxAutoconfig({
      json: true,
      stdout: out.s,
      stderr: err.s,
      run: async () => result({ verdict: "denied", needsRestart: true }),
    });
    expect(code).toBe(2);
    const parsed = JSON.parse(out.text());
    expect(parsed.verdict).toBe("denied");
    expect(parsed.needsRestart).toBe(true);
  });
});
