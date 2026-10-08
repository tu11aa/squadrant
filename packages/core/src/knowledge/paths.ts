// packages/core/src/knowledge/paths.ts
import path from "node:path";

export const PROPOSED_DIR = "_proposed";
export function kbDir(hubVault: string, kb: string): string {
  return path.join(hubVault, "knowledge", kb);
}
export function kbRulesDir(hubVault: string, kb: string): string {
  return path.join(kbDir(hubVault, kb), "rules");
}
export function projectRulesDir(spokeVault: string): string {
  return path.join(spokeVault, "knowledge", "rules");
}
