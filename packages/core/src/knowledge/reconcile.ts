// packages/core/src/knowledge/reconcile.ts — close a reconcile pass: checks, REPORT.md, schedule, one-line captain message (#898).
import fs from "node:fs";
import path from "node:path";
import { resolveKbConfig } from "@squadrant/shared";
import { compactAudit, knownItems, scoreKb, writeScores, type Scores } from "./scores.js";
import { auditNormalizer } from "./audit.js";
import { loadKbItems } from "./items.js";
import { runFullChecks, type FullPassFindings } from "./fullpass.js";
import { ensureKbRuntimeIgnores } from "./migrate.js";
import { kbDir } from "./paths.js";
import { gitRun } from "./profile.js";
import { writeReport } from "./report.js";
import { needsYouCount } from "./review.js";
import { completePass, type PassKind, type RequestDeps } from "./schedule.js";

export function finishMessage(kb: string, needsYou: number): string {
  return needsYou ? `${kb} KB: ${needsYou} item${needsYou === 1 ? "" : "s"} need you (squadrant knowledge review ${kb})` : `${kb} KB: reconcile finished, nothing needs you`;
}

export async function finishReconcile(kb: string, d: RequestDeps & { pass?: PassKind; auditDir?: string }): Promise<{ pass: PassKind; report: string; needsYou: number }> {
  const now = d.now?.() ?? new Date();
  const pass = completePass(kb, { ...d, now: () => now });
  let full: FullPassFindings | undefined;
  if (pass === "full") full = runFullChecks(d.cfg, kb, { now, auditDir: d.auditDir });
  const normalize = auditNormalizer(d.cfg);
  if (pass === "full") compactAudit({ now, dir: d.auditDir, normalize });
  const scores: Scores = scoreKb({ kb, now, auditDir: d.auditDir, kbRoot: kbDir(d.cfg, kb), known: knownItems(loadKbItems(d.cfg, kb).items), normalize });
  writeScores(kbDir(d.cfg, kb), scores);
  const report = writeReport(d.cfg, kb, { pass, now, full, scores });
  commitPassOutput(kbDir(d.cfg, kb), pass, d.log);
  const needsYou = needsYouCount(kbDir(d.cfg, kb));
  const home = resolveKbConfig(d.cfg, kb).homeProject;
  if (home) await d.enqueue(home, finishMessage(kb, needsYou));
  return { pass, report, needsYou };
}

const PASS_OUTPUT = [".gitignore", "REPORT.md"];

/**
 * Leave the KB repo clean after a pass (#1002): scores.json/escalations.json are ignored (appended to an
 * existing .gitignore if missing), REPORT.md is committed. Skips a KB that is not its own repo. Never throws.
 */
function commitPassOutput(root: string, pass: PassKind, log: (m: string) => void = console.error): void {
  if (!fs.existsSync(path.join(root, ".git"))) return;
  ensureKbRuntimeIgnores(root);
  try {
    if (!gitRun(root, ["status", "--porcelain", "--", ...PASS_OUTPUT]).trim()) return;
    gitRun(root, ["add", "--", ...PASS_OUTPUT]);
    gitRun(root, ["commit", "-q", "--only", "-m", `knowledge: ${pass} reconcile report`, "--", ...PASS_OUTPUT]);
  } catch (err) {
    log(`knowledge reconcile: committing REPORT.md failed (${String((err as { stderr?: string }).stderr || err).trim().split("\n")[0]}); the file is kept`);
  }
}
