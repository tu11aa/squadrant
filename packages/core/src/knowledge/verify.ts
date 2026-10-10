// packages/core/src/knowledge/verify.ts — mechanical quote verification (rules spec §4 step 4, #897).
// No LLM: a candidate rule is grounded only if its quote is found in the converted source.

const LIGATURES: Record<string, string> = { "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
const QUOTES: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"' };
const DASHES = new Set(["‐", "‑", "‒", "–", "—", "―", "−"]);

export interface Normalized { text: string; /** map[i] = index in the original string of normalized char i. */ map: number[] }

/**
 * Collapse whitespace, rejoin line-break hyphenation, fold smart quotes and dashes, expand ligatures.
 * Keeps an index map so a match can be reported as a span of the *original* converted text.
 */
export function normalizeWithMap(src: string, keepBreakHyphen = false): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  const push = (s: string, at: number) => { for (const ch of s) { out.push(ch); map.push(at); } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "-" && /^-[ \t]*\r?\n[ \t]*[a-z]/.test(src.slice(i, i + 40)) && i > 0 && /[A-Za-z]/.test(src[i - 1])) {
      // "hyphen-\nation" → "hyphenation": drop the hyphen and the break (or keep the hyphen: a real "half-\nup")
      if (keepBreakHyphen) push("-", i);
      i++;
      while (/\s/.test(src[i])) i++;
      continue;
    }
    if (/\s/.test(ch)) {
      const start = i;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (out.length && out[out.length - 1] !== " ") push(" ", start);
      continue;
    }
    if (LIGATURES[ch]) push(LIGATURES[ch], i);
    else if (QUOTES[ch]) push(QUOTES[ch], i);
    else if (DASHES.has(ch)) push("-", i);
    else push(ch, i);
    i++;
  }
  while (out.length && out[out.length - 1] === " ") { out.pop(); map.pop(); }
  return { text: out.join(""), map };
}

/** Normalised text of `s` only (no map); used for quote needles and statement comparison. */
export const normalizeText = (s: string): string => normalizeWithMap(s).text;

/** Find `quote` in `source`; returns the [start, end) char span in the original `source`, or null. */
export const normalizedViews = (src: string): Normalized[] => [normalizeWithMap(src), normalizeWithMap(src, true)];
export function findQuote(source: string | Normalized[], quote: string): [number, number] | null {
  const needle = normalizeText(quote);
  if (!needle) return null;
  // A line-break hyphen is either hyphenation (rejoin) or a real compound hyphen (keep); accept either reading.
  const views = typeof source === "string" ? normalizedViews(source) : source;
  for (const hay of views) {
    const at = hay.text.indexOf(needle);
    if (at >= 0) return [hay.map[at], hay.map[at + needle.length - 1] + 1];
  }
  return null;
}

/** Spec §4: more than 20% of a source's candidates dropped → conversion likely poor. */
export const DOCLING_DROP_THRESHOLD = 0.2;
export const needsDocling = (dropped: number, total: number): boolean => total > 0 && dropped / total > DOCLING_DROP_THRESHOLD;

export const spansOverlap = (a: [number, number], b: [number, number]): boolean => a[0] < b[1] && b[0] < a[1];
