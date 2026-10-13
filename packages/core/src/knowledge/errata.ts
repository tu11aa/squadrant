// packages/core/src/knowledge/errata.ts — <kb>/errata.yaml: stale source passages that must never become rules
// (spec 2026-10-13 §4). Not a source; read by `apply`, `validate` and REPORT.md.
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { validateErratum, type KnowledgeErratum } from "@squadrant/shared";
import { convertedFile, readState } from "./ingest.js";
import { findQuote, normalizedViews, type Normalized } from "./verify.js";

export function loadErrata(kbRoot: string): { errata: KnowledgeErratum[]; errors: string[] } {
  const file = path.join(kbRoot, "errata.yaml");
  if (!fs.existsSync(file)) return { errata: [], errors: [] };
  // JSON_SCHEMA keeps `at: 2026-10-08` a string instead of a Date.
  let data: unknown;
  try {
    data = yaml.load(fs.readFileSync(file, "utf8"), { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    return { errata: [], errors: [`YAML parse error: ${(e as Error).message.split("\n")[0]}`] };
  }
  if (data == null) return { errata: [], errors: [] };
  if (!Array.isArray(data)) return { errata: [], errors: ["errata.yaml must be a YAML list of entries"] };
  const errata: KnowledgeErratum[] = [];
  const errors: string[] = [];
  data.forEach((entry, i) => {
    const problems = validateErratum(entry);
    if (problems.length) errors.push(...problems.map((p) => `entry ${i}: ${p}`));
    else errata.push(entry as KnowledgeErratum);
  });
  return { errata, errors };
}

/** Errata whose quote is no longer in the current converted text of their ref (refs not ingested are skipped). */
export function orphanedErrata(kbRoot: string, errata: KnowledgeErratum[], refs?: Iterable<string>): { id: string; ref: string }[] {
  const only = refs ? new Set(refs) : undefined;
  const hays = new Map<string, Normalized[] | null>();
  const out: { id: string; ref: string }[] = [];
  for (const e of errata) {
    if (only && !only.has(e.ref)) continue;
    if (!hays.has(e.ref)) {
      const conv = readState(kbRoot, e.ref) ? convertedFile(kbRoot, e.ref) : null;
      hays.set(e.ref, conv && fs.existsSync(conv) ? normalizedViews(fs.readFileSync(conv, "utf8")) : null);
    }
    const hay = hays.get(e.ref);
    if (hay && !findQuote(hay, e.quote)) out.push({ id: e.id, ref: e.ref });
  }
  return out;
}
