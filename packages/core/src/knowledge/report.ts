// packages/core/src/knowledge/report.ts — REPORT.md per KB, written at the end of every pass (rules spec §7, #898).
import fs from "node:fs";
import path from "node:path";
import type { SquadrantConfig } from "@squadrant/shared";
import type { FullPassFindings } from "./fullpass.js";
import { loadKbRules } from "./layers.js";
import { kbDir } from "./paths.js";
import { readEscalations } from "./review.js";
import { renderScoresSection, type Scores } from "./scores.js";
import type { PassKind } from "./schedule.js";

export function renderReport(cfg: SquadrantConfig, kb: string, o: { pass: PassKind; now: Date; full?: FullPassFindings; scores?: Scores }): string {
  const { rules } = loadKbRules(cfg, kb, { includeProposed: true });
  const count = (s: string) => rules.filter((r) => r.status === s).length;
  const esc = readEscalations(kbDir(cfg, kb));
  const need = esc.filter((e) => e.needsYou);
  const L: string[] = [
    `# ${kb} knowledge base: reconcile report`,
    "",
    `${o.pass} pass, ${o.now.toISOString()}`,
    "",
    `Rules: ${count("active")} active, ${count("proposed")} proposed, ${count("stale")} stale, ${count("retired")} retired.`,
    "",
    `## Needs you (${need.length})`,
    "",
    ...(need.length ? need.map((e) => `- **${e.key}** [${e.kind}] ${e.reasons.join(", ")}: ${e.explanation}`) : ["Nothing."]),
    "",
    "Answer with `squadrant knowledge review " + kb + "`.",
  ];
  const info = esc.filter((e) => !e.needsYou);
  if (info.length) L.push("", `## For information (${info.length})`, "", ...info.map((e) => `- **${e.key}**: ${e.explanation}`));
  if (o.full) {
    const { usage, caps } = o.full;
    L.push("", "## Usage (30 days)", "",
      `- Surfaced: ${Object.values(usage.surfaced).reduce((a, b) => a + b, 0)} times across ${Object.keys(usage.surfaced).length} rules.`,
      `- Never surfaced (re-check triggers): ${usage.neverSurfaced.join(", ") || "none"}`,
      `- Noisy (narrow triggers): ${usage.noisy.join(", ") || "none"}`,
      `- Violation feedback (reword): ${usage.violated.join(", ") || "none"}`,
      `- Domains over cap: ${caps.map((c) => `${c.domain} (${c.count}/${c.cap})`).join(", ") || "none"}`);
  }
  if (o.scores) L.push(...renderScoresSection(o.scores));
  return L.join("\n") + "\n";
}

export function writeReport(cfg: SquadrantConfig, kb: string, o: Parameters<typeof renderReport>[2]): string {
  const file = path.join(kbDir(cfg, kb), "REPORT.md");
  fs.writeFileSync(file, renderReport(cfg, kb, o));
  return file;
}
