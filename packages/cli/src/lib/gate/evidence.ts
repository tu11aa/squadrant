// evidence.ts — #1136: SHA-keyed evidence file + Markdown summary.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { HighTouch } from "./risk-map.js";

export interface Counts { ran: number; skipped: number; failed: number }
export interface StepResult {
  name: string;
  command: string;
  kind?: string;
  required: boolean;
  exitCode: number;
  durationMs: number;
  /** null when the runner output is not parseable (exit code only). */
  counts: Counts | null;
}
export interface MetaFailure { check: string; message: string }
export interface Evidence {
  sha: string;
  dirty: boolean;
  startedAt: string;
  green: boolean;
  steps: StepResult[];
  metaFailures: MetaFailure[];
  touchedHigh: HighTouch[];
  riskLabel?: string;
}

export function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export const EVIDENCE_DIR = ".squadrant/evidence";

export function evidencePath(repo: string, sha: string): string {
  return path.join(repo, EVIDENCE_DIR, `${sha}.json`);
}

/** Add `.squadrant/evidence/` to the repo's .gitignore if it is not already ignored. */
export function ensureEvidenceIgnored(repo: string): void {
  try {
    git(repo, ["check-ignore", "-q", `${EVIDENCE_DIR}/x.json`]);
    return;
  } catch { /* not ignored yet */ }
  const gi = path.join(repo, ".gitignore");
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  fs.writeFileSync(gi, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${EVIDENCE_DIR}/\n`);
}

export function renderSummary(e: Evidence): string {
  const lines = [`# Gate ${e.green ? "GREEN" : "RED"} — ${e.sha.slice(0, 12)}${e.dirty ? " (dirty tree)" : ""}`, ""];
  if (e.riskLabel) lines.push(`Risk: **${e.riskLabel}**`, "");
  lines.push("| step | exit | time | ran/skipped/failed |", "|---|---|---|---|");
  for (const s of e.steps) {
    const c = s.counts ? `${s.counts.ran}/${s.counts.skipped}/${s.counts.failed}` : "n/a";
    lines.push(`| ${s.name}${s.required ? "" : " (optional)"} | ${s.exitCode} | ${(s.durationMs / 1000).toFixed(1)}s | ${c} |`);
  }
  if (e.metaFailures.length) {
    lines.push("", "## Meta-check failures", ...e.metaFailures.map((m) => `- **${m.check}**: ${m.message}`));
  }
  if (e.touchedHigh.length) {
    lines.push("", "## High-tier files touched");
    for (const t of e.touchedHigh) lines.push(`- \`${t.file}\`${t.invariants.length ? ` — ${t.invariants.join("; ")}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

export function writeEvidence(repo: string, e: Evidence): string {
  const file = evidencePath(repo, e.sha);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(e, null, 2) + "\n");
  fs.writeFileSync(file.replace(/\.json$/, ".md"), renderSummary(e));
  return file;
}

export function readEvidence(repo: string, sha: string): Evidence | null {
  const file = evidencePath(repo, sha);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Evidence) : null;
}
