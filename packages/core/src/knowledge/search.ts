import type { Rule, RuleStatus } from "@squadrant/shared";

export interface SearchHit { rule: Rule; score: number }
export const DEFAULT_SEARCH_STATUSES: RuleStatus[] = ["active", "stale"];

const lower = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());

export function searchRules(rules: Rule[], query: string, opts: { statuses?: RuleStatus[] } = {}): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const statuses = opts.statuses ?? DEFAULT_SEARCH_STATUSES;
  const hits: SearchHit[] = [];
  for (const rule of rules) {
    if (!statuses.includes(rule.status)) continue;
    const keywords = lower(rule.triggers?.keywords);
    const expanded = lower(rule.triggers?.expanded);
    const when = (rule.triggers?.when ?? "").toLowerCase();
    const statement = rule.statement.toLowerCase();
    const id = rule.id.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (id.includes(t)) score += 3;
      if (keywords.includes(t)) score += 3;
      if (expanded.includes(t)) score += 2;
      if (when.includes(t)) score += 2;
      if (statement.includes(t)) score += 1;
    }
    if (score > 0) hits.push({ rule, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));
}
