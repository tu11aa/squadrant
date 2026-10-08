import type { Rule, RuleStatus } from "@squadrant/shared";

export interface SearchHit { rule: Rule; score: number; matched: number; curated: boolean }
export const DEFAULT_SEARCH_STATUSES: RuleStatus[] = ["active", "stale"];

const lower = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());

/** Rationale = body minus its first paragraph (the statement). */
const rationaleOf = (rule: Rule) => rule.body.slice(rule.statement.length).toLowerCase();

/**
 * Rank rules for a query. Hits in id / keywords / expanded / statement outweigh body (rationale) hits.
 * With 2+ query terms a rule must match at least 2 distinct terms (or hit a curated keyword);
 * other single-term hits are only returned when no rule passes that bar.
 */
export function searchRules(rules: Rule[], query: string, opts: { statuses?: RuleStatus[] } = {}): SearchHit[] {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (terms.length === 0) return [];
  const statuses = opts.statuses ?? DEFAULT_SEARCH_STATUSES;
  const hits: SearchHit[] = [];
  for (const rule of rules) {
    if (!statuses.includes(rule.status)) continue;
    const keywords = lower(rule.triggers?.keywords);
    const expanded = lower(rule.triggers?.expanded);
    const when = (rule.triggers?.when ?? "").toLowerCase();
    const statement = rule.statement.toLowerCase();
    const rationale = rationaleOf(rule);
    const id = rule.id.toLowerCase();
    let score = 0;
    let matched = 0;
    let curated = false;
    for (const t of terms) {
      let s = 0;
      if (id.includes(t)) s += 3;
      if (keywords.includes(t) || expanded.includes(t)) curated = true;
      if (keywords.includes(t)) s += 3;
      if (expanded.includes(t)) s += 3;
      if (when.includes(t)) s += 2;
      if (statement.includes(t)) s += 2;
      if (rationale.includes(t)) s += 1;
      if (s > 0) { matched++; score += s; }
    }
    if (score > 0) hits.push({ rule, score, matched, curated });
  }
  // A single matched term still counts when it hit a curated keyword/expanded trigger: the rule's
  // author named that word, so it is not substring noise.
  const strong = terms.length >= 2 ? hits.filter((h) => h.matched >= 2 || h.curated) : hits;
  const out = strong.length ? strong : hits;
  return out.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));
}
