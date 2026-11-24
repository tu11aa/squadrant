import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { evidenceVerdict, decideEvidenceGate, type EvidenceVerdict } from "../evidence-gate.js";
import { resolveVerifyGate } from "@squadrant/shared";

let repo: string;
let sha: string;
const sh = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const writeCfg = (steps: unknown) => {
  fs.mkdirSync(path.join(repo, ".squadrant"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".squadrant", "verify.json"), JSON.stringify({ steps }));
};
const writeEv = (name: string, body: object) => {
  const d = path.join(repo, ".squadrant", "evidence");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${name}.json`), JSON.stringify(body));
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "sq-evgate-"));
  sh("init", "-q");
  sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  sha = sh("rev-parse", "HEAD");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("evidenceVerdict (#1136)", () => {
  it("skips a repo with no verify config", () => expect(evidenceVerdict(repo).kind).toBe("skipped"));
  it("skips a repo whose verify config declares no steps", () => {
    writeCfg([]);
    expect(evidenceVerdict(repo).kind).toBe("skipped");
  });
  it("skips a non-git directory", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sq-nogit-"));
    try { expect(evidenceVerdict(d).kind).toBe("skipped"); } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  it("MISSING when steps are declared but no evidence exists", () => {
    writeCfg([{ name: "t", command: "true" }]);
    expect(evidenceVerdict(repo).kind).toBe("missing");
  });
  it("STALE when evidence exists only for another SHA", () => {
    writeCfg([{ name: "t", command: "true" }]);
    writeEv("0".repeat(40), { green: true, metaFailures: [] });
    expect(evidenceVerdict(repo).kind).toBe("stale");
  });
  it("RED on green:false", () => {
    writeCfg([{ name: "t", command: "true" }]);
    writeEv(sha, { green: false, metaFailures: [] });
    expect(evidenceVerdict(repo).kind).toBe("red");
  });
  it("RED on metaFailures even when green:true", () => {
    writeCfg([{ name: "t", command: "true" }]);
    writeEv(sha, { green: true, metaFailures: [{ check: "x", message: "y" }] });
    expect(evidenceVerdict(repo).kind).toBe("red");
  });
  it("RED on a dirty-tree evidence file", () => {
    writeCfg([{ name: "t", command: "true" }]);
    writeEv(sha, { green: true, dirty: true, metaFailures: [] });
    expect(evidenceVerdict(repo).kind).toBe("red");
  });
  it("GREEN for HEAD", () => {
    writeCfg([{ name: "t", command: "true" }]);
    writeEv(sha, { green: true, dirty: false, metaFailures: [] });
    expect(evidenceVerdict(repo)).toEqual({ kind: "green", sha });
  });
});

describe("decideEvidenceGate: verdict × policy", () => {
  const verdicts: EvidenceVerdict[] = [
    { kind: "missing", sha: "a".repeat(40), detail: "no evidence" },
    { kind: "stale", sha: "a".repeat(40), detail: "other commit" },
    { kind: "red", sha: "a".repeat(40), detail: "is RED" },
  ];
  for (const v of verdicts) {
    it(`${v.kind}: off → nothing`, () => expect(decideEvidenceGate(v, "off")).toEqual({}));
    it(`${v.kind}: warn → warning naming the verify command, no refusal`, () => {
      const r = decideEvidenceGate(v, "warn");
      expect(r.refuse).toBeUndefined();
      expect(r.warn).toContain("squadrant verify");
      expect(r.warn).toContain(v.kind.toUpperCase());
    });
    it(`${v.kind}: refuse → refusal naming the verify command`, () => {
      const r = decideEvidenceGate(v, "refuse");
      expect(r.warn).toBeUndefined();
      expect(r.refuse).toContain("squadrant verify");
      expect(r.refuse).toContain(v.kind.toUpperCase());
    });
  }
  for (const p of ["off", "warn", "refuse"] as const) {
    it(`green: ${p} → nothing`, () => expect(decideEvidenceGate({ kind: "green", sha: "a" }, p)).toEqual({}));
    it(`skipped: ${p} → nothing`, () => expect(decideEvidenceGate({ kind: "skipped" }, p)).toEqual({}));
  }
});

describe("resolveVerifyGate layering", () => {
  it("defaults to warn", () => expect(resolveVerifyGate(undefined, {})).toBe("warn"));
  it("global overrides built-in", () => expect(resolveVerifyGate("refuse", {})).toBe("refuse"));
  it("project overrides global", () => expect(resolveVerifyGate("refuse", { verifyGate: "off" })).toBe("off"));
  it("invalid values fall back instead of disabling", () => expect(resolveVerifyGate("bogus", { verifyGate: "nope" as never })).toBe("warn"));
});
