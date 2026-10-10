// packages/core/src/knowledge/paths.ts — KB layout per docs/specs/2026-10-10-knowledge-base-architecture-design.md §4.
import path from "node:path";
import { kbPath, type SquadrantConfig } from "@squadrant/shared";

export const PROPOSED_DIR = "_proposed";
/** Root of a KB repo (default ~/squadrant/kb/<kb>). */
export function kbDir(cfg: SquadrantConfig, kb: string): string {
  return kbPath(cfg, kb);
}
/** Rules that apply to every project in the KB: `<kb>/shared/rules`. */
export function kbRulesDir(cfg: SquadrantConfig, kb: string): string {
  return path.join(kbDir(cfg, kb), "shared", "rules");
}
/** Pre-#936 location, `<hubVault>/knowledge/<kb>`; only the one-shot move reads it. */
export function legacyKbDir(hubVault: string, kb: string): string {
  return path.join(hubVault, "knowledge", kb);
}
