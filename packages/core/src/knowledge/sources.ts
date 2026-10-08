import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { validateSourceEntry, type KnowledgeSourceEntry } from "@squadrant/shared";
import { kbDir } from "./paths.js";

export const SOURCES_TEMPLATE = `# Trusted sources for this knowledge base (spec §3). Only these can produce rules.
# priority: company > project > agent (decides conflicts).
# sensitivity: local-only  → never sent to a hosted model (D12).
#
# - path: raw/finance/**
#   priority: company
# - path: ~/work/flooros/docs/handbook/**
#   priority: project
#   domain: coding
[]
`;

export function loadSources(hubVault: string, kb: string): { sources: KnowledgeSourceEntry[]; errors: string[] } {
  const file = path.join(kbDir(hubVault, kb), "sources.yaml");
  if (!fs.existsSync(file)) return { sources: [], errors: [] };
  let data: unknown;
  try {
    data = yaml.load(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { sources: [], errors: [`YAML parse error: ${(e as Error).message.split("\n")[0]}`] };
  }
  if (data == null) return { sources: [], errors: [] };
  if (!Array.isArray(data)) return { sources: [], errors: ["sources.yaml must be a YAML list of entries"] };
  const sources: KnowledgeSourceEntry[] = [];
  const errors: string[] = [];
  data.forEach((entry, i) => {
    const problems = validateSourceEntry(entry);
    if (problems.length) errors.push(...problems.map((p) => `entry ${i}: ${p}`));
    else sources.push(entry as KnowledgeSourceEntry);
  });
  return { sources, errors };
}
