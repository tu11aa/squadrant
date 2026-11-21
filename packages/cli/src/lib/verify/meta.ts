// meta.ts — #1136: meta-checks that fail the gate even when step exit codes are 0.
import type { Counts, MetaFailure } from "./evidence.js";
import { isHighTier, type RiskMap } from "./risk-map.js";

/** Parsed vitest/jest JSON report (both share this shape). */
export interface JsonReport {
  testResults?: { name: string; assertionResults?: { status: string }[] }[];
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
}

export interface ParsedReport {
  counts: Counts;
  /** Spec files in which every test was skipped. */
  allSkippedFiles: string[];
}

export function parseJsonReport(raw: string): ParsedReport | null {
  let r: JsonReport;
  try { r = JSON.parse(raw) as JsonReport; } catch { return null; }
  if (typeof r.numTotalTests !== "number") return null;
  const skipped = (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0);
  const allSkippedFiles = (r.testResults ?? [])
    .filter((f) => (f.assertionResults?.length ?? 0) > 0 && f.assertionResults!.every((a) => a.status === "pending" || a.status === "skipped" || a.status === "todo"))
    .map((f) => f.name);
  return {
    counts: { ran: (r.numPassedTests ?? 0) + (r.numFailedTests ?? 0), skipped, failed: r.numFailedTests ?? 0 },
    allSkippedFiles,
  };
}

/** Meta-check 1: a db/integration step or spec file whose tests are all skipped. */
export function checkAllSkipped(step: { name: string; kind?: string }, parsed: ParsedReport | null): MetaFailure[] {
  if (!parsed || (step.kind !== "db" && step.kind !== "integration")) return [];
  const out: MetaFailure[] = [];
  if (parsed.counts.ran === 0 && parsed.counts.skipped > 0) {
    out.push({ check: "all-skipped", message: `step "${step.name}" ran 0 tests (${parsed.counts.skipped} skipped)` });
  }
  for (const f of parsed.allSkippedFiles) out.push({ check: "all-skipped", message: `spec "${f}" in step "${step.name}" has every test skipped` });
  return out;
}

const ASSERTION = /\b(expect|assert)\w*\s*[.(]|\.should\b|\bt\.(is|equal|deepEqual|true|false)\b/;
const SPEC = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Files with removed/modified assertion lines, from a `git diff -U0` text. */
export function removedAssertions(diff: string): Record<string, number> {
  const out: Record<string, number> = {};
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) { file = m[1]!; continue; }
    if (line.startsWith("--- ") || !file) continue;
    if (line.startsWith("-") && ASSERTION.test(line)) out[file] = (out[file] ?? 0) + 1;
  }
  return out;
}

/** Meta-check 2: assertion removed/modified in a high-tier spec without a `test-change:` note. */
export function checkAssertionChanges(map: RiskMap | null, diff: string, hasNote: boolean): MetaFailure[] {
  if (hasNote) return [];
  return Object.entries(removedAssertions(diff))
    .filter(([file]) => SPEC.test(file) && isHighTier(map, file))
    .map(([file, n]) => ({ check: "assertion-changed", message: `${n} assertion line(s) removed/modified in high-tier spec ${file} without a "test-change:" note` }));
}
