import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { globToRegExp, touchedHigh, assessRisk, type RiskMap } from "../verify/risk-map.js";
import { parseJsonReport, checkAllSkipped, checkAssertionChanges } from "../verify/meta.js";
import { runVerify, checkEvidence } from "../verify/run.js";
import { installHook } from "../verify/hook.js";
import { readEvidence } from "../verify/evidence.js";

const map: RiskMap = { entries: [{ glob: "src/core/**", tier: "high", invariants: ["inv-1"] }, { glob: "docs/**", tier: "low" }] };

describe("risk-map", () => {
  it("globs", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/c.ts")).toBe(false);
  });
  it("touchedHigh lists invariants; low-only is empty", () => {
    expect(touchedHigh(map, ["src/core/x.ts", "docs/a.md"])).toEqual([{ file: "src/core/x.ts", invariants: ["inv-1"] }]);
    expect(touchedHigh(map, ["docs/a.md"])).toEqual([]);
  });
});

describe("assessRisk", () => {
  const m: RiskMap = { entries: [{ glob: "src/core/**", tier: "high", invariants: ["inv-1"], requiredSteps: ["db"] }, { glob: "src/app/**", tier: "med" }, { glob: "docs/**", tier: "low" }] };
  it("low-only diff → low", () => expect(assessRisk(m, ["docs/a.md", "other.txt"])).toEqual({ label: "low", touchedHigh: [], requiredSteps: [] }));
  it("empty diff → low", () => expect(assessRisk(m, []).label).toBe("low"));
  it("med beats low", () => expect(assessRisk(m, ["docs/a.md", "src/app/x.ts"]).label).toBe("med"));
  it("any high path → high + invariants + required steps", () => {
    expect(assessRisk(m, ["docs/a.md", "src/core/x.ts"])).toEqual({ label: "high", touchedHigh: [{ file: "src/core/x.ts", invariants: ["inv-1"] }], requiredSteps: ["db"] });
  });
});

describe("meta-checks", () => {
  const report = (files: { name: string; s: string[] }[]) => JSON.stringify({
    numTotalTests: 2, numPassedTests: 0, numFailedTests: 0, numPendingTests: 2,
    testResults: files.map((f) => ({ name: f.name, assertionResults: f.s.map((status) => ({ status })) })),
  });
  it("all-skipped db step fails; unit step does not", () => {
    const p = parseJsonReport(report([{ name: "a.spec.ts", s: ["pending", "pending"] }]));
    expect(checkAllSkipped({ name: "db", kind: "db" }, p).length).toBeGreaterThan(0);
    expect(checkAllSkipped({ name: "u", kind: "unit" }, p)).toEqual([]);
  });
  const diff = "+++ b/src/core/x.test.ts\n-  expect(a).toBe(1);\n+  expect(a).toBe(2);\n";
  it("removed assertion in high-tier spec fails without note, passes with", () => {
    expect(checkAssertionChanges(map, diff, false)).toHaveLength(1);
    expect(checkAssertionChanges(map, diff, true)).toEqual([]);
    expect(checkAssertionChanges(map, diff.replace("src/core", "docs"), false)).toEqual([]);
  });
});

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

describe("verify end to end (temp repo)", () => {
  let dir: string, remote: string;
  const quiet = () => {};
  const commit = (msg: string) => { sh(dir, "add", "-A"); sh(dir, "commit", "-qm", msg); };
  const write = (rel: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), c); };
  const setGate = (steps: object[]) => write(".squadrant/verify.json", JSON.stringify({ base: "main", steps }));

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-repo-")));
    remote = fs.mkdtempSync(path.join(os.tmpdir(), "verify-remote-"));
    sh(remote, "init", "-q", "--bare");
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "t@t"); sh(dir, "config", "user.name", "t");
    sh(dir, "remote", "add", "origin", remote);
    write("README.md", "x");
    write(".squadrant/risk-map.json", JSON.stringify(map));
    setGate([{ name: "ok", command: "true" }]);
    write("src/core/a.test.ts", "expect(1).toBe(1);\n");
    commit("init");
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(remote, { recursive: true, force: true }); });

  it("writes evidence + summary; evidence is gitignored and never committed", () => {
    const { evidence, file } = runVerify({ repo: dir, log: quiet });
    expect(evidence.green).toBe(true);
    expect(fs.existsSync(file.replace(/\.json$/, ".md"))).toBe(true);
    expect(sh(dir, "check-ignore", file)).toBeTruthy();
    sh(dir, "add", "-A");
    expect(sh(dir, "ls-files", ".squadrant/evidence")).toBe("");
  });

  it("failing step → red evidence", () => {
    setGate([{ name: "bad", command: "false" }]);
    expect(runVerify({ repo: dir, log: quiet }).evidence.green).toBe(false);
  });

  it("all-skipped db spec fails verification", () => {
    write("rep.json", JSON.stringify({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 0, numPendingTests: 1, testResults: [{ name: "db.spec.ts", assertionResults: [{ status: "skipped" }] }] }));
    setGate([{ name: "db", kind: "db", parse: "json", command: "cp rep.json \"$SQUADRANT_VERIFY_JSON\"" }]);
    const { evidence } = runVerify({ repo: dir, log: quiet });
    expect(evidence.green).toBe(false);
    expect(evidence.metaFailures[0]?.check).toBe("all-skipped");
  });

  it("removed assertion in a high-tier spec fails unless a test-change: note exists", () => {
    sh(dir, "checkout", "-qb", "feat");
    write("src/core/a.test.ts", "expect(1).toBe(2);\n");
    commit("tweak");
    expect(runVerify({ repo: dir, log: quiet }).evidence.green).toBe(false);
    sh(dir, "commit", "-q", "--allow-empty", "-m", "note\n\ntest-change: spec was wrong");
    const { evidence } = runVerify({ repo: dir, log: quiet });
    expect(evidence.green).toBe(true);
    expect(evidence.touchedHigh[0]?.file).toBe("src/core/a.test.ts");
  });

  it("evidence carries the risk label; a risk-map required step that is missing fails verify", () => {
    sh(dir, "checkout", "-qb", "feat");
    write("src/core/b.ts", "x\n");
    write(".squadrant/risk-map.json", JSON.stringify({ entries: [{ glob: "src/core/**", tier: "high", invariants: ["inv-1"], requiredSteps: ["db"] }] }));
    commit("core change");
    const red = runVerify({ repo: dir, log: quiet }).evidence;
    expect(red.riskLabel).toBe("high");
    expect(red.green).toBe(false);
    expect(red.metaFailures[0]?.check).toBe("required-step");
    setGate([{ name: "ok", command: "true" }, { name: "db", command: "true", kind: "db" }]);
    commit("add db step");
    expect(runVerify({ repo: dir, log: quiet }).evidence.green).toBe(true);
  });

  describe("pre-push hook", () => {
    it("replays git's stdin to the chained hook even when verify steps consume stdin", () => {
      const hp = path.join(dir, ".git/hooks/pre-push");
      const seen = path.join(dir, "seen.txt");
      fs.writeFileSync(hp, `#!/bin/sh\ncat > "${seen}"\n`, { mode: 0o755 });
      installHook(dir, "run");
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "verify-bin-"));
      // Stub verify that tries to read stdin (must get /dev/null) and succeeds.
      fs.writeFileSync(path.join(bin, "squadrant"), "#!/bin/sh\ncat >/dev/null\n", { mode: 0o755 });
      const r = spawnSync(hp, ["origin", "url"], { cwd: dir, input: "refs/heads/main abc refs/heads/main def\n", encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(seen, "utf8")).toBe("refs/heads/main abc refs/heads/main def\n");
      fs.rmSync(bin, { recursive: true, force: true });
    });

    it("chains an existing hook, refuses to clobber a second foreign hook", () => {
      const hp = path.join(dir, ".git/hooks/pre-push");
      fs.writeFileSync(hp, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(installHook(dir, "check").chained).toBe(`${hp}.pre-squadrant`);
      installHook(dir, "run"); // reinstall over our own hook is fine
      fs.writeFileSync(hp, "#!/bin/sh\nexit 0\n");
      expect(() => installHook(dir, "run")).toThrow(/refusing to clobber/);
    });

    it("check mode: blocks without/with red evidence, passes when green", () => {
      expect(checkEvidence(dir).ok).toBe(false);
      setGate([{ name: "bad", command: "false" }]);
      commit("gate");
      runVerify({ repo: dir, log: quiet });
      expect(checkEvidence(dir).message).toMatch(/RED/);
      setGate([{ name: "ok", command: "true" }]);
      commit("gate2");
      runVerify({ repo: dir, log: quiet });
      expect(checkEvidence(dir).ok).toBe(true);
      expect(readEvidence(dir, sh(dir, "rev-parse", "HEAD"))?.green).toBe(true);
    });

    it("installed hook blocks a real push when the gate command fails, allows when it passes", () => {
      // Stub `squadrant` on PATH: exits 0 only when .allow exists.
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "verify-bin-"));
      fs.writeFileSync(path.join(bin, "squadrant"), `#!/bin/sh\n[ -f "${dir}/.allow" ]\n`, { mode: 0o755 });
      const push = () => spawnSync("git", ["push", "-q", "origin", "main"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      installHook(dir, "run");
      expect(push().status).not.toBe(0);
      fs.writeFileSync(path.join(dir, ".allow"), "");
      expect(push().status).toBe(0);
      fs.rmSync(bin, { recursive: true, force: true });
    });
  });
});
