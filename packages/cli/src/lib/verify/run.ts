// run.ts — #1136: run the configured steps, apply meta-checks, write evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadVerifyConfig } from "./config.js";
import { loadRiskMap, touchedHigh } from "./risk-map.js";
import { checkAllSkipped, checkAssertionChanges, parseJsonReport } from "./meta.js";
import { ensureEvidenceIgnored, git, readEvidence, writeEvidence, type Evidence, type MetaFailure, type StepResult } from "./evidence.js";

export interface RunOptions {
  repo: string;
  base?: string;
  /** Explicit `test-change:` justification (flag/env), in addition to commit messages. */
  testChange?: string;
  log?: (s: string) => void;
}

function mergeBase(repo: string, base: string): string | null {
  for (const ref of [`origin/${base}`, base]) {
    try { return git(repo, ["merge-base", ref, "HEAD"]); } catch { /* try next */ }
  }
  return null;
}

export function runVerify(opts: RunOptions): { evidence: Evidence; file: string } {
  const { repo } = opts;
  const log = opts.log ?? ((s: string) => console.log(s));
  const config = loadVerifyConfig(repo);
  const map = loadRiskMap(repo);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  const dirty = git(repo, ["status", "--porcelain"]).length > 0;
  ensureEvidenceIgnored(repo);

  const steps: StepResult[] = [];
  const metaFailures: MetaFailure[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-verify-"));
  try {
    config.steps.forEach((step, i) => {
      log(`▶ ${step.name}: ${step.command}`);
      const reportFile = path.join(tmp, `report-${i}.json`);
      const t0 = Date.now();
      const r = spawnSync(step.command, { cwd: repo, shell: true, stdio: "inherit", env: { ...process.env, SQUADRANT_VERIFY_JSON: reportFile } });
      const parsed = step.parse === "json" && fs.existsSync(reportFile) ? parseJsonReport(fs.readFileSync(reportFile, "utf8")) : null;
      const required = step.required !== false;
      steps.push({ name: step.name, command: step.command, kind: step.kind, required, exitCode: r.status ?? 1, durationMs: Date.now() - t0, counts: parsed?.counts ?? null });
      metaFailures.push(...checkAllSkipped(step, parsed));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const mb = mergeBase(repo, opts.base ?? config.base ?? "develop");
  const files = mb ? git(repo, ["diff", "--name-only", mb, "HEAD"]).split("\n").filter(Boolean) : [];
  const high = touchedHigh(map, files);
  if (mb) {
    const messages = git(repo, ["log", `${mb}..HEAD`, "--format=%B"]);
    const hasNote = /^test-change:/im.test(messages) || !!(opts.testChange ?? process.env.SQUADRANT_TEST_CHANGE);
    metaFailures.push(...checkAssertionChanges(map, git(repo, ["diff", "-U0", mb, "HEAD"]), hasNote));
  }

  const green = steps.every((s) => !s.required || s.exitCode === 0) && metaFailures.length === 0;
  const evidence: Evidence = { sha, dirty, startedAt: new Date().toISOString(), green, steps, metaFailures, touchedHigh: high };
  return { evidence, file: writeEvidence(repo, evidence) };
}

/** Fast path for the pre-push `check` mode: green, clean-tree evidence for HEAD must exist. */
export function checkEvidence(repo: string): { ok: boolean; message: string } {
  const sha = git(repo, ["rev-parse", "HEAD"]);
  const e = readEvidence(repo, sha);
  if (!e) return { ok: false, message: `no verify evidence for HEAD ${sha.slice(0, 12)} — run \`squadrant verify\`` };
  if (!e.green) return { ok: false, message: `verify evidence for HEAD ${sha.slice(0, 12)} is RED — fix and re-run \`squadrant verify\`` };
  if (e.dirty) return { ok: false, message: `verify evidence for HEAD ${sha.slice(0, 12)} was produced on a dirty tree — commit, then re-run \`squadrant verify\`` };
  return { ok: true, message: `verify evidence green for ${sha.slice(0, 12)}` };
}
