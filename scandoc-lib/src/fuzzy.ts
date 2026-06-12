/**
 * Tiny, dependency-free fuzzy string matching for domain-constrained field
 * extraction. A noisy OCR read of a name is snapped to the closest entry in a
 * known vocabulary; the similarity score becomes the extraction confidence.
 * Pure and deterministic — no DB, no models, no LLM.
 */

/** Classic Levenshtein edit distance (insert/delete/substitute = 1). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two-row rolling buffer — O(min) memory.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Edit-distance similarity in 0..1 (1 = identical). Empty/empty is treated as 1. */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

export interface RankedMatch<T> {
  item: T;
  /** Best alias similarity in 0..1. */
  score: number;
  /** The alias string that produced the best score. */
  via: string;
}

/**
 * Rank `items` against a query by the best similarity across each item's aliases
 * (a comparator-key function returns one-or-more normalized alias strings).
 * Returns matches sorted high→low score, optionally filtered to `minScore` and
 * truncated to `limit` (the disambiguation top-N).
 */
export function rankMatches<T>(
  query: string,
  items: T[],
  aliasesOf: (item: T) => string[],
  opts: { minScore?: number; limit?: number } = {},
): RankedMatch<T>[] {
  const { minScore = 0, limit } = opts;
  const ranked: RankedMatch<T>[] = [];
  for (const item of items) {
    let best = -1;
    let via = "";
    for (const alias of aliasesOf(item)) {
      const s = similarity(query, alias);
      if (s > best) {
        best = s;
        via = alias;
      }
    }
    if (best >= minScore) ranked.push({ item, score: best, via });
  }
  ranked.sort((a, b) => b.score - a.score || a.via.localeCompare(b.via));
  return limit != null ? ranked.slice(0, limit) : ranked;
}
