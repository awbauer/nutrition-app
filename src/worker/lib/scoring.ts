/**
 * Ranks food-database candidates for a described food.
 *
 * USDA search order is a text-relevance ranking that happily puts "Fish oil, salmon" first
 * for "salmon sashimi". We re-rank with signals that matter for nutrition:
 * - how many of the query's words the candidate covers, and whether its main (first)
 *   segment is about the query at all
 * - penalties for extra qualifiers and for product types the user didn't mention
 *   (baby food, oils, powders, infant formula ...)
 * - a prior for database type (generic whole foods over branded products)
 * - plausibility: kcal per 100 g compared with the model's own rough estimate.
 *   A 5x mismatch is almost always the wrong food.
 */
import { normName } from './foods';

export interface Candidate {
  name: string;
  brand?: string | null;
  dataType?: string | null;
  kcal100?: number | null;
}

export interface ScoredCandidate<T extends Candidate> {
  candidate: T;
  score: number;
  reasons: string[];
}

const STOP = new Set(['and', 'with', 'the', 'of', 'a', 'an', 'in', 'on', 'or', 'for', 'to', 'style', 'plain', 'regular']);

/** Words that change what the food *is*; penalised unless the query asks for them. */
const DISTINCT = [
  'babyfood', 'baby', 'infant', 'formula', 'toddler',
  'oil', 'powder', 'powdered', 'dry', 'dried', 'dehydrated', 'concentrate', 'mix', 'flour',
  'shake', 'shakes', 'syrup', 'candy', 'candies', 'pie', 'filling', 'sauce', 'soup', 'juice',
  'canned', 'frozen', 'imitation', 'substitute', 'flavored', 'flavor', 'supplement', 'bar',
];

export const stem = (t: string) => t.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');

export function tokens(s: string): string[] {
  return normName(s)
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export const has = (set: Set<string>, t: string) => set.has(t) || set.has(stem(t)) || [...set].some((x) => stem(x) === stem(t));

const DATA_TYPE_PRIOR: Record<string, number> = {
  Foundation: 0.15,
  'SR Legacy': 0.15,
  'Survey (FNDDS)': 0.15,
  Branded: -0.25,
  'Open Food Facts': 0,
};

export function scoreCandidate<T extends Candidate>(query: string, c: T, estimateKcal100?: number | null): ScoredCandidate<T> {
  const reasons: string[] = [];
  const q = tokens(query);
  const qset = new Set(q);
  const nameTokens = tokens(c.name);
  const nset = new Set(nameTokens);
  const head = new Set(tokens(c.name.split(',')[0] ?? c.name));

  // Coverage of the query's words.
  const covered = q.filter((t) => has(nset, t)).length;
  const coverage = q.length ? covered / q.length : 0;
  let score = coverage * 1.0;
  reasons.push(`${covered}/${q.length} words`);

  // The main segment must be about the query ("Fish oil, salmon" is oil, not salmon).
  const headHits = [...head].filter((t) => has(qset, t)).length;
  if (headHits) score += 0.3;
  else {
    score -= 0.4;
    reasons.push('main word differs');
  }

  // Extra qualifiers dilute the match a little.
  const extras = nameTokens.filter((t) => !has(qset, t)).length;
  score -= Math.min(extras, 8) * 0.03;

  // Product types the user didn't ask for.
  const wrongKind = DISTINCT.filter((w) => nset.has(w) && !has(qset, w));
  if (wrongKind.length) {
    score -= 0.5;
    reasons.push(`unrequested: ${wrongKind.join(', ')}`);
  }

  // Branded products only when a brand was mentioned.
  const brandMentioned = !!c.brand && tokens(c.brand).some((t) => qset.has(t));
  score += brandMentioned ? 0.3 : (DATA_TYPE_PRIOR[c.dataType ?? ''] ?? 0);

  // Plausibility against the model's estimate.
  if (estimateKcal100 != null && estimateKcal100 > 0 && c.kcal100 != null) {
    const ratio = (c.kcal100 + 10) / (estimateKcal100 + 10);
    const off = Math.abs(Math.log(ratio));
    if (off < Math.log(1.35)) score += 0.3;
    else if (off > Math.log(2.5)) {
      score -= 1.0;
      reasons.push(`kcal ${Math.round(c.kcal100)} vs ~${Math.round(estimateKcal100)} expected`);
    } else if (off > Math.log(1.6)) score -= 0.25;
  }

  return { candidate: c, score: Math.round(score * 100) / 100, reasons };
}

export function rankCandidates<T extends Candidate>(query: string, cs: T[], estimateKcal100?: number | null): ScoredCandidate<T>[] {
  return cs.map((c) => scoreCandidate(query, c, estimateKcal100)).sort((a, b) => b.score - a.score);
}

/** Minimum score to accept a candidate automatically; below it we fall back to the estimate. */
export const ACCEPT_SCORE = 0.6;
/** Below this the match is shaky: lower item confidence so the UI flags it. */
export const CONFIDENT_SCORE = 1.2;
