// packages/core/src/knowledge/reconcile.ts — close a reconcile pass: checks, REPORT.md, schedule, one-line captain message (#898).
import { resolveKbConfig } from "@squadrant/shared";
import { runFullChecks, type FullPassFindings } from "./fullpass.js";
import { kbDir } from "./paths.js";
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
  const report = writeReport(d.cfg, kb, { pass, now, full });
  const needsYou = needsYouCount(kbDir(d.cfg, kb));
  const home = resolveKbConfig(d.cfg, kb).homeProject;
  if (home) await d.enqueue(home, finishMessage(kb, needsYou));
  return { pass, report, needsYou };
}
