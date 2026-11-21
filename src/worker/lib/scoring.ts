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
 * - popularity, ranked by how much it says: the user's own log (history bonus, in matcher.ts) far
 *   outweighs how often Americans eat a survey food (NHANES WWEIA), which outweighs FatSecret's own
 *   result order. "Ham" (eaten on 153 survey days) beats "Ham stroganoff" (0).
 */
import { WWEIA_DAYS } from '../data/wweia-popularity';
import { normName } from './foods';

export interface Candidate {
  name: string;
  brand?: string | null;
  dataType?: string | null;
  kcal100?: number | null;
  /** Position in the source's own result list (0 = first), where the source orders by popularity. */
  sourceRank?: number | null;
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
  // Preparations and products that aren't the plain food ("Egg, deviled" for "egg", "Bacon bits" for "bacon").
  'creamed', 'deviled', 'omelet', 'souffle', 'salad', 'bits', 'sticks', 'jerky', 'spread', 'dip',
  'meatless', 'vegetarian', 'vegan', 'meatfree',
  // FNDDS "for use on a sandwich" / "for use with vegetables": an ingredient in a recipe, not the food.
  'use',
];

/** Descriptors that say which version of the plain food it is; they don't count as extra words. */
const NEUTRAL = new Set(['whole', 'large', 'medium', 'small', 'grade', 'fresh', 'raw', 'cooked', 'ns', 'as', 'type', 'unprepared', 'prepared']);

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
  // FatSecret's generic entries are user-curated averages: below USDA's lab data, above branded.
  FatSecret: 0,
  'FatSecret Brand': -0.25,
};

/** Median person-days among survey foods anyone ate: the zero point of the popularity bonus. */
const WWEIA_MEDIAN_DAYS = 8;

/**
 * How commonly a candidate is eaten, as a score adjustment: -0.15..+0.2 for survey (FNDDS) foods from
 * how many NHANES recall days included them, up to +0.06 for FatSecret's top results, 0 otherwise.
 */
export function popularity(c: Candidate): { bonus: number; reason: string | null } {
  if (c.dataType === 'Survey (FNDDS)') {
    const days = WWEIA_DAYS[normName(c.name)];
    if (days === undefined) return { bonus: 0, reason: null };
    const bonus = Math.max(-0.15, Math.min(0.2, 0.08 * (Math.log10(days + 1) - Math.log10(WWEIA_MEDIAN_DAYS + 1))));
    return { bonus, reason: days ? `eaten on ${days} survey days` : 'rarely eaten' };
  }
  if ((c.dataType === 'FatSecret' || c.dataType === 'FatSecret Brand') && c.sourceRank != null && c.sourceRank < 10)
    return { bonus: 0.06 * (1 - c.sourceRank / 10), reason: c.sourceRank < 3 ? `FatSecret #${c.sourceRank + 1}` : null };
  return { bonus: 0, reason: null };
}

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
  const extras = nameTokens.filter((t) => !has(qset, t) && !NEUTRAL.has(t)).length;
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

  // How commonly it's eaten.
  const pop = popularity(c);
  score += pop.bonus;
  if (pop.reason) reasons.push(pop.reason);

  // Plausibility against the model's estimate.
  if (estimateKcal100 != null && estimateKcal100 > 0 && c.kcal100 != null) {
    const ratio = (c.kcal100 + 10) / (estimateKcal100 + 10);
    const off = Math.abs(Math.log(ratio));
    // Full credit for a close match, tapering to none at 1.6x: a cliff at one ratio let a rare dish that
    // happened to fit the estimate beat the common food just outside it ("Ham stroganoff" over "Ham").
    if (off <= Math.log(1.6)) score += 0.3 * (1 - off / Math.log(1.6));
    else if (off > Math.log(2.5)) {
      score -= 1.0;
      reasons.push(`kcal ${Math.round(c.kcal100)} vs ~${Math.round(estimateKcal100)} expected`);
    } else score -= 0.25;
  }

  return { candidate: c, score: Math.round(score * 100) / 100, reasons };
}

export function rankCandidates<T extends Candidate>(query: string, cs: T[], estimateKcal100?: number | null): ScoredCandidate<T>[] {
  return cs.map((c) => scoreCandidate(query, c, estimateKcal100)).sort((a, b) => b.score - a.score);
}

/** Bumped when ranking changes, so the change log can compare how often each version's picks were fixed. */
export const MATCHER_VERSION = 'match-v3';

/** Minimum score to accept a candidate automatically; below it we fall back to the estimate. */
export const ACCEPT_SCORE = 0.6;
/** Below this the match is shaky: lower item confidence so the UI flags it. */
export const CONFIDENT_SCORE = 1.2;
